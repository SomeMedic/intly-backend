#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const projectRoot = resolve(rootDir, '..');
const reportPath = resolve(projectRoot, '.local/reports/export-blocks.json');
const runId = `export-blocks-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const sourceId = `qa-export-${runId}`;
const report = {
  ok: false,
  runId,
  sourceId,
  startedAt: new Date().toISOString(),
  apiBaseUrl: null,
  adminCredentialSource: null,
  checks: [],
  warnings: [],
};

async function main() {
  const env = await loadEnvFile(resolve(rootDir, '.env'));
  assert(env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'production', 'Refusing to run export acceptance against production');
  const apiBaseUrl = apiBase(env);
  assertLoopbackUrl(apiBaseUrl, 'API base URL');
  report.apiBaseUrl = apiBaseUrl.replace(/\/api\/v1$/, '/api/v1');
  const mongoUri = process.env.MONGODB_URI ?? env.MONGODB_URI;
  assert(mongoUri, 'MONGODB_URI is required for export verification');
  assertLoopbackMongoUri(mongoUri);
  const adminCredentials = await loadAdminCredentials(env);
  report.adminCredentialSource = adminCredentials.source;

  try {
    const admin = new ApiClient(apiBaseUrl);
    await step('bootstrap-admin.login', async () => {
      const login = await admin.post('/auth/login', { email: adminCredentials.email, password: adminCredentials.password });
      admin.setAccessToken(requiredString(login, 'accessToken'));
      assert(login.user?.role === 'Admin', 'bootstrap credentials must belong to an Admin user');
      return { userId: login.user.id, role: login.user.role, email: login.user.email };
    });

    const owner = await createActivatedUser(admin, apiBaseUrl, 'owner');
    const other = await createActivatedUser(admin, apiBaseUrl, 'other');

    await step('mongo.seed-1005-opportunities', () => seedOpportunities(mongoUri));

    const queued = await step('opportunities.export.large-queues', async () => {
      const result = await owner.client.post('/opportunities/export', {
        format: 'json',
        scope: 'filtered',
        query: { sourceIds: [sourceId], sort: 'highest-pay' },
      });
      assert(result.status === 'queued', 'large default export should queue');
      assertUuid(result.exportId, 'export id');
      assert(!('contentBase64' in result), 'queued response must not include base64 content');
      return { exportId: result.exportId, jobId: result.jobId, progress: result.progress };
    });

    await step('opportunities.export-status.owner-isolation', async () => {
      const ownerStatus = await owner.client.get(`/opportunities/exports/${queued.exportId}`);
      const otherStatus = await other.client.get(`/opportunities/exports/${queued.exportId}`, { expectedStatus: 403 });
      const adminStatus = await admin.get(`/opportunities/exports/${queued.exportId}`);
      return { ownerStatus: ownerStatus.status, otherStatus: otherStatus.__status, adminStatus: adminStatus.status };
    });

    const completed = await step('opportunities.export.worker-completes-file', async () => {
      const status = await waitForExport(owner.client, queued.exportId);
      assert(status.status === 'completed', `export should complete, got ${status.status}`);
      assert(status.count === 1005, 'completed export should include all 1005 matching rows');
      assertUuid(status.fileId, 'completed export file id');
      assert(!('contentBase64' in status), 'completed status must not include base64 content');
      return { fileId: status.fileId, filename: status.filename, mimeType: status.mimeType, count: status.count };
    });

    await step('files.export-content-private-and-ordered', async () => {
      const ownFile = await owner.client.get(`/files/${completed.fileId}/content`, { binary: true });
      const payload = JSON.parse(ownFile.buffer.toString('utf8'));
      assert(Array.isArray(payload.items), 'export file should be JSON items payload');
      assert(payload.items.length === 1005, 'export file should contain 1005 rows');
      assert(payload.items[0].moneyMax === 999999, 'highest-pay sort should put max money first, including row beyond old 1000 cap');
      assert(payload.items[0].title.includes('1004'), 'row beyond old 1000 cap should be first by money sort');
      const otherFile = await other.client.get(`/files/${completed.fileId}/content`, { binary: true, expectedStatus: 403 });
      return { bytes: ownFile.buffer.length, rows: payload.items.length, firstTitle: payload.items[0].title, otherFileStatus: otherFile.__status };
    });

    report.ok = true;
  } finally {
    await step('mongo.cleanup-run-opportunities', () => cleanupOpportunities(mongoUri));
  }
}

async function seedOpportunities(mongoUri) {
  const mongoose = await import('mongoose');
  const connection = await mongoose.createConnection(mongoUri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const now = new Date();
    const docs = Array.from({ length: 1005 }, (_, index) => {
      const id = randomUUID();
      const firstSeenAt = new Date(Date.UTC(2026, 9, 3, 0, 0, 0) - index * 60_000);
      const moneyMax = index === 1004 ? 999_999 : 100_000 + index;
      return {
        _id: id,
        type: 'vacancy',
        title: `QA Export ${index} ${runId}`,
        companyOrClient: '',
        description: `QA export fixture ${runId} row ${index}`,
        summary: '',
        language: '',
        skills: ['Backend'],
        technologies: ['TypeScript', 'NestJS'],
        seniority: '',
        employmentType: '',
        location: '',
        remoteType: '',
        relocation: false,
        countriesAllowed: [],
        sourceStatus: 'Active',
        money: { min: null, max: moneyMax, currency: 'RUB', originalText: '' },
        deadline: null,
        publishedAt: firstSeenAt,
        firstSeenAt,
        lastSeenAt: now,
        vacancyData: {},
        freelanceData: {},
        tenderData: {},
        canonicalTags: [],
        adminCorrections: [],
        importedByUserId: null,
        sourceOccurrences: [{
          sourceId,
          externalId: `${runId}-${index}`,
          url: `https://example.test/${runId}/${index}`,
          checksum: '',
          primary: true,
          status: 'Active',
          firstSeenAt,
          lastSeenAt: now,
          rawPayload: { fixture: true, runId, index },
          sourceMetadata: { fixture: true, runId },
          normalizedSnapshot: {},
        }],
        createdAt: now,
        updatedAt: now,
      };
    });
    await connection.db.collection('opportunities').insertMany(docs, { ordered: false });
    return { inserted: docs.length, firstId: docs[0]._id, lastId: docs.at(-1)._id, lastMoneyMax: docs.at(-1).money.max };
  } finally {
    await connection.close();
  }
}

async function cleanupOpportunities(mongoUri) {
  const mongoose = await import('mongoose');
  const connection = await mongoose.createConnection(mongoUri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const result = await connection.db.collection('opportunities').deleteMany({ 'sourceOccurrences.sourceId': sourceId });
    return { deletedCount: result.deletedCount, sourceId };
  } finally {
    await connection.close();
  }
}

async function waitForExport(client, exportId) {
  const deadline = Date.now() + Number(process.env.INTLY_VERIFY_EXPORT_TIMEOUT_MS ?? 120_000);
  let last;
  while (Date.now() < deadline) {
    last = await client.get(`/opportunities/exports/${exportId}`);
    if (last.status === 'completed') return last;
    if (last.status === 'failed') throw new Error(`Export failed: ${last.error ?? 'unknown error'}`);
    await delay(1000);
  }
  throw new Error(`Export did not complete in time; last status ${last?.status ?? 'missing'}`);
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
  async request(method, path, body, options = {}) {
    const headers = new Headers(options.headers ?? {});
    if (this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.INTLY_VERIFY_TIMEOUT_MS ?? 45_000)),
    });
    this.captureCookies(response);
    return this.parseResponse(response, options);
  }
  async parseResponse(response, options = {}) {
    const expectedStatuses = options.expectedStatuses ?? (options.expectedStatus ? [options.expectedStatus] : null);
    const contentType = response.headers.get('content-type') ?? '';
    if (options.binary) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const json = contentType.includes('application/json') ? tryParseJson(buffer.toString('utf8')) : null;
      this.assertExpected(response, expectedStatuses, json ?? buffer.toString('utf8').slice(0, 500));
      return { __status: response.status, headers: response.headers, buffer, json };
    }
    const text = await response.text();
    const json = text ? tryParseJson(text) : null;
    this.assertExpected(response, expectedStatuses, json ?? text.slice(0, 500));
    return { ...(json ?? {}), __status: response.status };
  }
  assertExpected(response, expectedStatuses, body) {
    if (expectedStatuses) {
      if (!expectedStatuses.includes(response.status)) throw new HttpError(response.status, body);
      return;
    }
    if (response.status < 200 || response.status >= 300) throw new HttpError(response.status, body);
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

async function createActivatedUser(admin, apiBaseUrl, label) {
  const email = `qa-export-${label}-${Date.now()}-${randomUUID().slice(0, 8)}@intly.local`;
  const password = `ExportQA-${randomUUID()}-intly-2026!`;
  const client = new ApiClient(apiBaseUrl);
  const result = await step(`qa-${label}.invite-and-activate`, async () => {
    const invited = await admin.post('/admin/users', { email, name: `QA Export ${label}`, role: 'User' });
    const activationToken = requiredString(invited, 'activationToken');
    const activated = await client.post('/auth/activate', { token: activationToken, password, name: `QA Export ${label}` });
    client.setAccessToken(requiredString(activated, 'accessToken'));
    return { userId: activated.user?.id, role: activated.user?.role, email };
  });
  return { client, userId: result.userId, email };
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
    env[key] = rest.join('=').replace(/^["']|["']$/g, '');
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

function assertLoopbackUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  assert(isLoopbackHost(parsed.hostname), `${label} must be loopback/local, got ${parsed.hostname}`);
}

function assertLoopbackMongoUri(value) {
  assert(value.startsWith('mongodb://'), 'MONGODB_URI must use mongodb:// for local export verification; mongodb+srv is refused');
  const authority = value.slice('mongodb://'.length).split('/')[0];
  const hosts = authority.split('@').at(-1).split(',').map((item) => item.trim()).filter(Boolean);
  assert(hosts.length > 0, 'MONGODB_URI must include a host');
  for (const hostPort of hosts) {
    const host = hostPort.startsWith('[')
      ? hostPort.slice(1, hostPort.indexOf(']'))
      : hostPort.split(':')[0];
    assert(isLoopbackHost(host), `MONGODB_URI must be loopback/local, got ${host}`);
  }
}

function isLoopbackHost(host) {
  const normalized = String(host ?? '').toLowerCase();
  return normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
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
