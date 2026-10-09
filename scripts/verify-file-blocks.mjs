#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const projectRoot = resolve(rootDir, '..');
const reportPath = resolve(projectRoot, '.local/reports/file-blocks.json');
const runId = `file-blocks-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const cyrillicText = 'INTLY проверка кириллицы: Привет, мир. Резюме и отклик готовы.';

const report = {
  ok: false,
  runId,
  startedAt: new Date().toISOString(),
  apiBaseUrl: null,
  adminCredentialSource: null,
  checks: [],
  warnings: [],
};

async function main() {
  const env = await loadEnvFile(resolve(rootDir, '.env'));
  const apiBaseUrl = apiBase(env);
  report.apiBaseUrl = apiBaseUrl.replace(/\/api\/v1$/, '/api/v1');
  const adminCredentials = await loadAdminCredentials(env);
  report.adminCredentialSource = adminCredentials.source;

  const admin = new ApiClient(apiBaseUrl);
  await step('bootstrap-admin.login', async () => {
    const login = await admin.post('/auth/login', { email: adminCredentials.email, password: adminCredentials.password });
    admin.setAccessToken(requiredString(login, 'accessToken'));
    assert(login.user?.role === 'Admin', 'bootstrap credentials must belong to an Admin user');
    return { userId: login.user.id, role: login.user.role, email: login.user.email };
  });

  const qaEmail = `qa-${Date.now()}-${randomUUID().slice(0, 8)}@intly.local`;
  const qaPassword = `Qa-${randomUUID()}-intly-2026!`;
  const qa = new ApiClient(apiBaseUrl);
  await step('qa-user.invite-and-activate', async () => {
    const invited = await admin.post('/admin/users', { email: qaEmail, name: 'QA File Blocks', role: 'User' });
    const activationToken = requiredString(invited, 'activationToken');
    const activated = await qa.post('/auth/activate', { token: activationToken, password: qaPassword, name: 'QA File Blocks' });
    qa.setAccessToken(requiredString(activated, 'accessToken'));
    return { invitedUserId: invited.user?.id, activatedUserId: activated.user?.id, role: activated.user?.role, email: qaEmail };
  });

  const csvUpload = await step('files.multipart.csv-json-metadata', async () => {
    const csv = makeImportCsv();
    const uploaded = await admin.multipart('/files/multipart', {
      file: { name: `${runId}-opportunities.csv`, type: 'text/csv', bytes: Buffer.from(csv, 'utf8') },
      fields: { metadata: JSON.stringify({ kind: 'qa_import_csv', runId, content: 'csv+json-metadata' }) },
    });
    assertUuid(uploaded.id, 'uploaded csv file id');
    assert(uploaded.metadata?.runId === runId, 'metadata.runId should round-trip');
    assert(uploaded.mimeType === 'text/csv', 'uploaded mimeType should be text/csv');
    return { fileId: uploaded.id, metadata: uploaded.metadata, size: uploaded.size };
  });

  await step('files.multipart.malformed-metadata-rejected', async () => {
    const response = await admin.multipartRaw('/files/multipart', {
      file: { name: `${runId}-bad-metadata.txt`, type: 'text/plain', bytes: Buffer.from('bad metadata', 'utf8') },
      fields: { metadata: 'null' },
      expectedStatus: 400,
    });
    assert(response.error?.code === 'VALIDATION_ERROR', 'malformed metadata must fail validation');
    return { status: 400, code: response.error.code };
  });

  await step('files.cross-user-acl', async () => {
    const denied = await qa.get(`/files/${csvUpload.fileId}/content`, { expectedStatus: 403, binary: true });
    assert(denied.json?.error?.code === 'FORBIDDEN', 'cross-user content read should be forbidden');
    const deniedMeta = await qa.get(`/files/${csvUpload.fileId}`, { expectedStatus: 403 });
    assert(deniedMeta.error?.code === 'FORBIDDEN', 'cross-user metadata read should be forbidden');
    return { contentStatus: 403, metadataStatus: 403 };
  });


  const imported = await step('opportunities.import-commit-mixed-rows', async () => {
    const result = await admin.post('/opportunities/import-file', { fileId: csvUpload.fileId, limit: 10 });
    assert(result.imported >= 2, 'expected at least two imported rows');
    assert(result.skipped >= 1, 'expected invalid row to be skipped');
    assert(Array.isArray(result.errors) && result.errors.length >= 1, 'expected row errors');
    assert(Array.isArray(result.opportunityIds) && result.opportunityIds.length >= 2, 'expected opportunity ids');
    return { imported: result.imported, created: result.created, updated: result.updated, skipped: result.skipped, opportunityIds: result.opportunityIds, errors: result.errors };
  });

  await step('dashboard.after-import-without-profile', async () => {
    const adminDashboard = await admin.get('/dashboard');
    const userDashboard = await qa.get('/dashboard');
    assert(Array.isArray(adminDashboard.recentlyAdded), 'admin dashboard must render imported records');
    assert(Array.isArray(userDashboard.recentlyAdded), 'dashboard without profile must render safely');
    return { adminItems: adminDashboard.recentlyAdded.length, userItems: userDashboard.recentlyAdded.length };
  });

  await step('opportunities.export.csv-xlsx-json-file-bytes', async () => {
    const formats = ['csv', 'xlsx', 'json'];
    const outputs = [];
    for (const format of formats) {
      const exported = await admin.post('/opportunities/export', {
        format,
        scope: 'selected',
        ids: imported.opportunityIds,
        includePersonalData: false,
        limit: imported.opportunityIds.length,
      });
      assertUuid(exported.fileId, `${format} export fileId`);
      assert(exported.count >= imported.opportunityIds.length, `${format} export should include selected rows`);
      const decoded = Buffer.from(requiredString(exported, 'contentBase64'), 'base64');
      const downloaded = await admin.get(`/files/${exported.fileId}/content`, { binary: true });
      const bytes = downloaded.buffer;
      assert(bytes.length > 20, `${format} downloaded bytes should be non-empty`);
      assert(decoded.length === bytes.length, `${format} contentBase64 length should match stored file bytes`);
      if (format === 'csv') assert(bytes.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && bytes.toString('utf8').includes('title'), 'csv export should include BOM and title header');
      if (format === 'json') assert(bytes.toString('utf8').includes('items') && bytes.toString('utf8').includes('QA Valid'), 'json export should include items and imported title');
      if (format === 'xlsx') assert(bytes.slice(0, 2).toString('utf8') === 'PK' && bytes.includes(Buffer.from('xl/worksheets/sheet1.xml')), 'xlsx export should be a real zip workbook');
      outputs.push({ format, fileId: exported.fileId, filename: exported.filename, mimeType: exported.mimeType, bytes: bytes.length });
    }
    return { exports: outputs };
  });

  const profile = await step('profiles.ensure-for-response-export', async () => {
    const list = await admin.get('/profiles');
    const existing = Array.isArray(list.items) ? list.items.find((item) => item.isActive) ?? list.items[0] : null;
    if (existing?.id) return { profileId: existing.id, created: false };
    const created = await admin.post('/profiles', {
      name: `QA Profile ${runId}`,
      kind: 'mixed',
      isActive: true,
      targetRoles: ['Backend Engineer'],
      technologies: ['TypeScript', 'NestJS'],
      structuredExperienceSummary: 'Профиль для проверки PDF и DOCX экспорта.',
    });
    return { profileId: created.id, created: true };
  });

  const responseDraft = await step('responses.create-ready-draft-four-checks', async () => {
    const created = await admin.post('/responses', {
      opportunityId: imported.opportunityIds[0],
      profileId: profile.profileId,
      format: 'full_response',
      documentJson: tiptapDoc(cyrillicText),
      markdownCache: cyrillicText,
    });
    const patched = await admin.patch(`/responses/${created.id}`, {
      revision: created.revision,
      checklist: {
        factsChecked: true,
        requirementsCovered: true,
        noUnresolvedPlaceholders: true,
        userReviewed: true,
      },
    });
    const ready = await admin.post(`/responses/${created.id}/status`, { revision: patched.revision, status: 'ready' });
    assert(ready.status === 'ready', 'response draft should become ready');
    return { responseId: created.id, revision: ready.revision, status: ready.status, checklistChecks: ['factsChecked', 'requirementsCovered', 'noUnresolvedPlaceholders', 'userReviewed'] };
  });

  await step('responses.export-pdf-docx-cyrillic-bytes', async () => {
    const outputs = [];
    for (const format of ['pdf', 'docx']) {
      const exported = await admin.post(`/responses/${responseDraft.responseId}/export`, { format });
      assertUuid(exported.fileId, `${format} response export fileId`);
      const downloaded = await admin.get(`/files/${exported.fileId}/content`, { binary: true });
      const bytes = downloaded.buffer;
      assert(bytes.length > 100, `${format} export should be non-empty`);
      assert(downloaded.headers.get('content-disposition')?.includes('filename'), `${format} should have download filename`);
      if (format === 'pdf') {
        assert(bytes.slice(0, 5).toString('utf8') === '%PDF-', 'pdf magic bytes should be present');
        assert(containsUtf16BeHex(bytes, 'Привет'), 'pdf should contain Cyrillic text as UTF-16BE hex');
        assert(downloaded.headers.get('content-type')?.includes('application/pdf'), 'pdf content type should be application/pdf');
      } else {
        assert(bytes.slice(0, 2).toString('utf8') === 'PK', 'docx magic bytes should be present');
        assert(bytes.includes(Buffer.from('word/document.xml')), 'docx should include document.xml entry');
        assert(bytes.toString('utf8').includes('Привет'), 'docx should contain Cyrillic UTF-8 XML text');
        assert(downloaded.headers.get('content-type')?.includes('wordprocessingml.document'), 'docx content type should be wordprocessingml');
      }
      outputs.push({ format, fileId: exported.fileId, filename: exported.filename, mimeType: exported.mimeType, bytes: bytes.length });
    }
    return { exports: outputs, textProbe: 'Привет' };
  });

  report.ok = true;
}

async function step(name, fn) {
  const item = { name, ok: false, startedAt: new Date().toISOString() };
  report.checks.push(item);
  try {
    item.result = await fn();
    item.ok = true;
  } catch (error) {
    item.error = sanitizeError(error);
    throw error;
  } finally {
    item.finishedAt = new Date().toISOString();
  }
  return item.result;
}

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.accessToken = null;
    this.cookies = new Map();
  }
  setAccessToken(token) { this.accessToken = token; }
  async get(path, options = {}) { return this.request('GET', path, undefined, options); }
  async post(path, body, options = {}) { return this.request('POST', path, body, options); }
  async patch(path, body, options = {}) { return this.request('PATCH', path, body, options); }
  async request(method, path, body, options = {}) {
    const headers = new Headers(options.headers ?? {});
    if (this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.INTLY_VERIFY_TIMEOUT_MS ?? 20_000)),
    });
    this.captureCookies(response);
    return this.parseResponse(response, options);
  }
  async multipart(path, input) { return this.multipartRaw(path, input); }
  async multipartRaw(path, input) {
    const form = new FormData();
    for (const [key, value] of Object.entries(input.fields ?? {})) form.append(key, value);
    form.append('file', new Blob([input.file.bytes], { type: input.file.type }), input.file.name);
    const headers = new Headers();
    if (this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(Number(process.env.INTLY_VERIFY_TIMEOUT_MS ?? 20_000)),
    });
    this.captureCookies(response);
    return this.parseResponse(response, { expectedStatus: input.expectedStatus });
  }
  async parseResponse(response, options = {}) {
    const expected = options.expectedStatus ?? (response.status >= 200 && response.status < 300 ? response.status : 200);
    const contentType = response.headers.get('content-type') ?? '';
    if (options.binary) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const json = contentType.includes('application/json') ? tryParseJson(buffer.toString('utf8')) : null;
      if (response.status !== expected) throw new HttpError(response.status, json ?? buffer.toString('utf8').slice(0, 500));
      return { status: response.status, headers: response.headers, buffer, json };
    }
    const text = await response.text();
    const json = text ? tryParseJson(text) : null;
    if (response.status !== expected) throw new HttpError(response.status, json ?? text.slice(0, 500));
    return json;
  }
  captureCookies(response) {
    const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : splitSetCookie(response.headers.get('set-cookie'));
    for (const cookie of setCookie) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function makeImportCsv() {
  const suffix = runId;
  return [
    'title,type,url,description,skills,technologies,companyOrClient,sourceId,externalId',
    csvRow([`QA Valid Кириллица ${suffix}`, 'vacancy', `https://example.com/${suffix}/vacancy`, 'Описание вакансии для проверки импорта', 'TypeScript;NestJS', 'MongoDB;Node.js', 'INTLY QA', 'qa-file-blocks', `${suffix}-valid-1`]),
    csvRow(['', 'invalid-type', '', 'This row must be skipped', 'Go', 'PostgreSQL', 'INTLY QA', 'qa-file-blocks', `${suffix}-invalid`]),
    csvRow([`QA Freelance ${suffix}`, 'freelance', `https://example.com/${suffix}/freelance`, 'Freelance row', 'Parsing;API', 'NestJS', 'INTLY Client', 'qa-file-blocks', `${suffix}-valid-2`]),
  ].join('\n');
}

function csvRow(values) {
  return values.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',');
}

function tiptapDoc(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function containsUtf16BeHex(buffer, text) {
  const little = Buffer.from(text, 'utf16le');
  for (let index = 0; index < little.length; index += 2) {
    const next = little[index];
    little[index] = little[index + 1];
    little[index + 1] = next;
  }
  return buffer.toString('latin1').toUpperCase().includes(little.toString('hex').toUpperCase());
}

async function loadAdminCredentials(env) {
  const email = process.env.INTLY_VERIFY_ADMIN_EMAIL ?? process.env.BOOTSTRAP_ADMIN_EMAIL ?? env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.INTLY_VERIFY_ADMIN_PASSWORD ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? env.BOOTSTRAP_ADMIN_PASSWORD;
  if (email && password) return { email, password, source: process.env.INTLY_VERIFY_ADMIN_EMAIL || process.env.INTLY_VERIFY_ADMIN_PASSWORD ? 'env-override' : 'backend-env-bootstrap' };
  throw new Error('Admin credentials not found. Set INTLY_VERIFY_ADMIN_EMAIL/INTLY_VERIFY_ADMIN_PASSWORD or backend BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD.');
}

async function loadEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  const text = await readFile(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    env[key] = rest.join('=').replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function apiBase(env) {
  const direct = process.env.INTLY_API_BASE_URL ?? process.env.API_BASE_URL;
  if (direct) return direct.replace(/\/$/, '').endsWith('/api/v1') ? direct.replace(/\/$/, '') : `${direct.replace(/\/$/, '')}/api/v1`;
  const port = process.env.PORT ?? env.PORT ?? '3001';
  const host = process.env.HOST ?? env.HOST ?? '127.0.0.1';
  return `http://${host}:${port}/api/v1`;
}

function requiredString(object, key) {
  const value = object?.[key];
  assert(typeof value === 'string' && value.length > 0, `${key} is required`);
  return value;
}

function assertUuid(value, label) {
  assert(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), `${label} should be UUID`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;=]+=[^;]+)/g);
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function sanitizeError(error) {
  if (error instanceof HttpError) return { message: error.message, status: error.status, body: error.body };
  return { message: error instanceof Error ? error.message : String(error) };
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(projectRoot, '.local/reports'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  report.ok = false;
  report.failure = sanitizeError(error);
  process.exitCode = 1;
} finally {
  await writeReport();
  console.log(JSON.stringify({ ok: report.ok, runId: report.runId, reportPath, checks: report.checks.map(({ name, ok }) => ({ name, ok })), warnings: report.warnings }, null, 2));
}
