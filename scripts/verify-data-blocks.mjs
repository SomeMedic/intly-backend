#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const projectRoot = resolve(rootDir, '..');
const reportPath = resolve(projectRoot, '.local/reports/data-blocks.json');
const runId = `data-blocks-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
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
  assert(env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'production', 'Refusing to run data acceptance against production');
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

  const owner = await createActivatedUser(admin, apiBaseUrl, 'owner');
  const other = await createActivatedUser(admin, apiBaseUrl, 'other');

  const ownerProfile = await step('owner.profile.create', async () => {
    const created = await owner.client.post('/profiles', {
      name: `Data QA ${runId}`,
      kind: 'mixed',
      isActive: true,
      targetRoles: ['Backend Engineer'],
      seniority: ['Senior'],
      technologies: ['TypeScript', 'NestJS', 'MongoDB', 'Node.js'],
      locations: ['Remote'],
      remotePreferences: ['remote'],
      employmentTypes: ['full-time', 'contract'],
      structuredExperienceSummary: 'QA profile for match, AI score, export, and tender document acceptance.',
    });
    assertUuid(created.id, 'owner profile id');
    return { profileId: created.id };
  });

  const otherProfile = await step('other.profile.create', async () => {
    const created = await other.client.post('/profiles', {
      name: `Other Data QA ${runId}`,
      kind: 'mixed',
      isActive: true,
      targetRoles: ['Analyst'],
      technologies: ['Excel'],
      structuredExperienceSummary: 'Second user profile for ACL checks.',
    });
    assertUuid(created.id, 'other profile id');
    return { profileId: created.id };
  });

  const imported = await step('opportunities.import-file.fresh-match-fixture', async () => {
    const uploaded = await owner.client.multipart('/files/multipart', {
      file: { name: `${runId}-opportunities.csv`, type: 'text/csv', bytes: Buffer.from(makeImportCsv(), 'utf8') },
      fields: { metadata: JSON.stringify({ kind: 'data_acceptance_import', runId }) },
    });
    assertUuid(uploaded.id, 'import file id');
    const result = await owner.client.post('/opportunities/import-file', { fileId: uploaded.id, limit: 10 });
    assert(result.imported === 3, 'expected exactly three imported opportunities');
    assert(Array.isArray(result.opportunityIds) && result.opportunityIds.length === 3, 'expected three imported opportunity ids');
    return { fileId: uploaded.id, opportunityIds: result.opportunityIds };
  });

  const matchEvidence = await step('opportunities.list-match-sort-minmatch', async () => {
    const query = `profileId=${ownerProfile.profileId}&sourceIds=${encodeURIComponent(`qa-data-${runId}`)}&sort=matchScore&limit=10`;
    const list = await owner.client.get(`/opportunities?${query}`);
    assert(Array.isArray(list.items) && list.items.length === 3, 'match list should return imported fixture rows');
    const scores = list.items.map((item) => item.matchScore);
    assert(scores.every((score) => typeof score === 'number'), 'computed match scores should be present for every item');
    assert(isNonIncreasing(scores), 'matchScore sort should be descending');
    const high = scores[0];
    const low = scores[scores.length - 1];
    assert(high > low, 'fixture should produce at least two distinct match scores');
    const threshold = Math.max(1, Math.min(100, Math.floor((high + low) / 2)));
    const filtered = await owner.client.get(`/opportunities?${query}&minMatch=${threshold}`);
    assert(filtered.items.length >= 1 && filtered.items.length < list.items.length, 'minMatch should filter out lower match rows');
    assert(filtered.items.every((item) => item.matchScore >= threshold), 'minMatch response should only include rows above threshold');
    return {
      orderedIds: list.items.map((item) => item.id),
      scores,
      minMatch: threshold,
      filteredIds: filtered.items.map((item) => item.id),
      filteredScores: filtered.items.map((item) => item.matchScore),
    };
  });

  await step('opportunities.export-json.matches-list-filter-order-scores', async () => {
    const exported = await owner.client.post('/opportunities/export', {
      format: 'json',
      scope: 'filtered',
      includePersonalData: true,
      query: {
        profileId: ownerProfile.profileId,
        sourceIds: [`qa-data-${runId}`],
        sort: 'matchScore',
        minMatch: matchEvidence.minMatch,
      },
      fields: ['id', 'title', 'matchScore'],
      limit: 10,
    });
    assert(exported.count === matchEvidence.filteredIds.length, 'export count should match filtered list count');
    const payload = JSON.parse(Buffer.from(requiredString(exported, 'contentBase64'), 'base64').toString('utf8'));
    const rows = payload.items;
    assert(Array.isArray(rows), 'json export should contain items array');
    assert(deepEqual(rows.map((row) => row.id), matchEvidence.filteredIds), 'export ids should match filtered list order');
    assert(deepEqual(rows.map((row) => row.matchScore), matchEvidence.filteredScores), 'export match scores should match filtered list scores');
    return { count: exported.count, ids: rows.map((row) => row.id), scores: rows.map((row) => row.matchScore) };
  });

  await step('opportunities.export-selected-preserves-id-order', async () => {
    const selectedIds = matchEvidence.orderedIds.slice().reverse();
    const exported = await owner.client.post('/opportunities/export', {
      format: 'json',
      scope: 'selected',
      ids: selectedIds,
      includePersonalData: true,
      query: { profileId: ownerProfile.profileId, sourceIds: [`qa-data-${runId}`], sort: 'matchScore' },
      fields: ['id', 'matchScore'],
      limit: selectedIds.length,
    });
    const rows = JSON.parse(Buffer.from(requiredString(exported, 'contentBase64'), 'base64').toString('utf8')).items;
    assert(deepEqual(rows.map((row) => row.id), selectedIds), 'selected export should preserve requested id order');
    return { requestedIds: selectedIds, exportedIds: rows.map((row) => row.id) };
  });

  await step('opportunities.profile-acl.other-user-denied', async () => {
    const deniedList = await other.client.get(`/opportunities?profileId=${ownerProfile.profileId}&sourceIds=${encodeURIComponent(`qa-data-${runId}`)}`, { expectedStatuses: [403, 404] });
    const deniedExport = await other.client.post('/opportunities/export', {
      format: 'json',
      scope: 'filtered',
      includePersonalData: true,
      query: { profileId: ownerProfile.profileId, sourceIds: [`qa-data-${runId}`] },
      limit: 10,
    }, { expectedStatuses: [403, 404] });
    return { listStatus: deniedList.__status, exportStatus: deniedExport.__status };
  });

  const aiFixture = await step('ai.latest-completed-fixtures.insert', async () => {
    const mongoose = await import('mongoose');
    const uri = process.env.MONGODB_URI ?? env.MONGODB_URI;
    assert(uri, 'MONGODB_URI is required for AI fixture verification');
    const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
    try {
      const now = Date.now();
      const opportunityId = matchEvidence.orderedIds[0];
      const olderHighId = randomUUID();
      const latestLowId = randomUUID();
      const otherHighId = randomUUID();
      await connection.db.collection('ai_analyses').insertMany([
        aiFixtureDoc({ id: olderHighId, userId: owner.userId, profileId: ownerProfile.profileId, opportunityId, score: 93, completedAt: new Date(now - 60_000) }),
        aiFixtureDoc({ id: latestLowId, userId: owner.userId, profileId: ownerProfile.profileId, opportunityId, score: 41, completedAt: new Date(now) }),
        aiFixtureDoc({ id: otherHighId, userId: other.userId, profileId: otherProfile.profileId, opportunityId, score: 99, completedAt: new Date(now + 60_000) }),
      ]);
      return { opportunityId, olderHighId, latestLowId, otherHighId, olderHighScore: 93, latestLowScore: 41, otherHighScore: 99 };
    } finally {
      await connection.close();
    }
  });

  await step('ai.latest-score-and-min-filter-after-grouping', async () => {
    const list = await owner.client.get(`/opportunities?profileId=${ownerProfile.profileId}&sourceIds=${encodeURIComponent(`qa-data-${runId}`)}&sort=highestAI&limit=10`);
    const target = list.items.find((item) => item.id === aiFixture.opportunityId);
    assert(target, 'target opportunity should be visible to owner');
    assert(target.aiScore === aiFixture.latestLowScore, 'latest lower AI score should win over older higher score');
    assert(target.latestAiAnalysis?.id === aiFixture.latestLowId, 'latest run id should be exposed, not older run id');
    const filtered = await owner.client.get(`/opportunities?profileId=${ownerProfile.profileId}&sourceIds=${encodeURIComponent(`qa-data-${runId}`)}&minAiScore=80&limit=10`);
    assert(!filtered.items.some((item) => item.id === aiFixture.opportunityId), 'minAiScore should apply after latest-run grouping and exclude latest lower score');
    assert(!list.items.some((item) => item.latestAiAnalysis?.id === aiFixture.otherHighId || item.aiScore === aiFixture.otherHighScore), 'other user private AI score should not leak');
    return { latestRunId: target.latestAiAnalysis.id, latestAiScore: target.aiScore, minAiScore80ContainsTarget: false };
  });

  const tender = await step('tender.opportunity.create-and-reject-vacancy-scope', async () => {
    const tenderOpportunity = await owner.client.post('/opportunities/manual', {
      type: 'tender',
      title: `QA Tender ${runId}`,
      companyOrClient: 'INTLY QA Tender Buyer',
      description: 'Tender fixture for private document upload and ACL checks.',
      technologies: ['TypeScript'],
      sourceId: `qa-tender-${runId}`,
      externalId: `${runId}-tender`,
      url: `https://example.com/${runId}/tender`,
    });
    const vacancy = await owner.client.post('/opportunities/manual', {
      type: 'vacancy',
      title: `QA Vacancy reject ${runId}`,
      description: 'Vacancy should reject tender document upload.',
      sourceId: `qa-tender-${runId}`,
      externalId: `${runId}-vacancy`,
      url: `https://example.com/${runId}/vacancy`,
    });
    const rejected = await owner.client.multipart(`/opportunities/${vacancy.opportunity.id}/tender-documents/multipart`, {
      file: { name: `${runId}-wrong.txt`, type: 'text/plain', bytes: Buffer.from('wrong type', 'utf8') },
      fields: { profileId: ownerProfile.profileId, title: 'Wrong type', documentType: 'notice' },
      expectedStatus: 400,
    });
    return { tenderId: tenderOpportunity.opportunity.id, vacancyId: vacancy.opportunity.id, rejectedStatus: rejected.__status };
  });

  const tenderDocument = await step('tender.documents.upload-list-index-file-acl', async () => {
    const body = [
      `INTLY tender private document ${runId}`,
      'Technical specification: TypeScript, NestJS, MongoDB, and secure private file handling.',
      'Commercial requirement: response must cite the uploaded tender notice.',
    ].join('\n');
    const uploaded = await owner.client.multipart(`/opportunities/${tender.tenderId}/tender-documents/multipart`, {
      file: { name: `${runId}-notice.txt`, type: 'text/plain', bytes: Buffer.from(body, 'utf8') },
      fields: { profileId: ownerProfile.profileId, title: `Tender Notice ${runId}`, documentType: 'notice' },
    });
    assertUuid(uploaded.id, 'tender document link id');
    assertUuid(uploaded.fileId, 'tender document file id');
    const indexed = await waitForTenderDocument(owner.client, tender.tenderId, ownerProfile.profileId, uploaded.id);
    assert(indexed.processingStatus === 'Indexed', 'tender document should be Indexed');
    assert(indexed.summary?.includes('INTLY tender private document'), 'indexed summary should include uploaded text');
    const ownFile = await owner.client.get(`/files/${uploaded.fileId}/content`, { binary: true });
    assert(ownFile.buffer.toString('utf8').includes(runId), 'owner file download should contain uploaded text');
    const otherDenied = await other.client.get(`/files/${uploaded.fileId}/content`, { binary: true, expectedStatus: 403 });
    return { tenderDocumentId: uploaded.id, knowledgeDocumentId: uploaded.knowledgeDocumentId, fileId: uploaded.fileId, processingStatus: indexed.processingStatus, otherFileStatus: otherDenied.__status };
  });

  await step('tender.documents.reprocess-analyze-truthful-failure-remove', async () => {
    await owner.client.post(`/opportunities/${tender.tenderId}/tender-documents/${tenderDocument.tenderDocumentId}/reprocess`, {});
    const reindexed = await waitForTenderDocument(owner.client, tender.tenderId, ownerProfile.profileId, tenderDocument.tenderDocumentId);
    assert(reindexed.processingStatus === 'Indexed', 'reprocessed tender document should return to Indexed');
    const analyze = await owner.client.post(`/opportunities/${tender.tenderId}/tender-documents/analyze`, {
      profileId: ownerProfile.profileId,
      tenderDocumentIds: [tenderDocument.tenderDocumentId],
    });
    assert(['queued', 'running', 'failed'].includes(analyze.status), 'analysis should be queued/running/failed without claiming provider success');
    const foreignProfile = await owner.client.get(`/opportunities/${tender.tenderId}/tender-documents?profileId=${otherProfile.profileId}`, { expectedStatuses: [403, 404] });
    await owner.client.delete(`/opportunities/${tender.tenderId}/tender-documents/${tenderDocument.tenderDocumentId}`);
    const afterRemove = await owner.client.get(`/opportunities/${tender.tenderId}/tender-documents?profileId=${ownerProfile.profileId}`);
    assert(!afterRemove.items.some((item) => item.id === tenderDocument.tenderDocumentId), 'removed disposable tender document link should disappear from list');
    return { reprocessStatus: reindexed.processingStatus, analyzeStatus: analyze.status, analyzeRunId: analyze.id, foreignProfileStatus: foreignProfile.__status, removed: true };
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
  async delete(path, options = {}) { return this.request('DELETE', path, undefined, options); }
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
  async multipart(path, input) {
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
      signal: AbortSignal.timeout(Number(process.env.INTLY_VERIFY_TIMEOUT_MS ?? 45_000)),
    });
    this.captureCookies(response);
    return this.parseResponse(response, input);
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
  const email = `qa-data-${label}-${Date.now()}-${randomUUID().slice(0, 8)}@intly.local`;
  const password = `DataQA-${randomUUID()}-intly-2026!`;
  const client = new ApiClient(apiBaseUrl);
  const result = await step(`qa-${label}.invite-and-activate`, async () => {
    const invited = await admin.post('/admin/users', { email, name: `QA Data ${label}`, role: 'User' });
    const activationToken = requiredString(invited, 'activationToken');
    const activated = await client.post('/auth/activate', { token: activationToken, password, name: `QA Data ${label}` });
    client.setAccessToken(requiredString(activated, 'accessToken'));
    return { userId: activated.user?.id, role: activated.user?.role, email };
  });
  return { client, userId: result.userId, email };
}

function makeImportCsv() {
  const sourceId = `qa-data-${runId}`;
  return [
    'title,type,url,description,skills,technologies,companyOrClient,sourceId,externalId,seniority,employmentType,remoteType,moneyMax,currency',
    csvRow([`QA Match High ${runId}`, 'vacancy', `https://example.com/${runId}/match-high`, 'Senior backend platform role with TypeScript NestJS MongoDB Node.js', 'Backend;API', 'TypeScript;NestJS;MongoDB;Node.js', 'INTLY High', sourceId, `${runId}-match-high`, 'Senior', 'full-time', 'remote', '900000', 'RUB']),
    csvRow([`QA Match Mid ${runId}`, 'freelance', `https://example.com/${runId}/match-mid`, 'Backend integration contract with TypeScript and Node.js', 'API;Integration', 'TypeScript;Node.js', 'INTLY Mid', sourceId, `${runId}-match-mid`, 'Middle', 'contract', 'remote', '500000', 'RUB']),
    csvRow([`QA Match Low ${runId}`, 'vacancy', `https://example.com/${runId}/match-low`, 'Manual office sales coordination with spreadsheets', 'Sales;Reporting', 'Excel;CRM', 'INTLY Low', sourceId, `${runId}-match-low`, 'Junior', 'part-time', 'office', '100000', 'RUB']),
  ].join('\n');
}

function csvRow(values) {
  return values.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',');
}

function aiFixtureDoc({ id, userId, profileId, opportunityId, score, completedAt }) {
  return {
    _id: id,
    userId,
    profileId,
    opportunityId,
    taskType: 'opportunity_analysis',
    status: 'completed',
    provider: 'local',
    modelId: 'qa-fixture',
    fallbackUsed: false,
    structuredOutput: { summary: `QA fixture ${runId}`, aiScore: score },
    aiScore: score,
    usage: {},
    prompt: { kind: 'qa-fixture', runId },
    metadata: { fixture: true, runId, label: 'local completed analysis fixture; not a provider response' },
    startedAt: new Date(completedAt.getTime() - 1000),
    completedAt,
    createdAt: completedAt,
    updatedAt: completedAt,
  };
}

async function waitForTenderDocument(client, opportunityId, profileId, tenderDocumentId) {
  const deadline = Date.now() + 45_000;
  let last;
  while (Date.now() < deadline) {
    const page = await client.get(`/opportunities/${opportunityId}/tender-documents?profileId=${profileId}`);
    last = page.items?.find((item) => item.id === tenderDocumentId);
    if (last?.processingStatus === 'Indexed') return last;
    if (last?.processingStatus === 'Failed') throw new Error(`Tender document failed: ${last.lastError ?? 'unknown error'}`);
    await delay(1000);
  }
  throw new Error(`Tender document did not index within 45s; last status ${last?.processingStatus ?? 'missing'}`);
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

function isNonIncreasing(values) {
  return values.every((value, index) => index === 0 || values[index - 1] >= value);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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
