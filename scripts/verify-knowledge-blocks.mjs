#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const projectRoot = resolve(rootDir, '..');
const reportPath = resolve(projectRoot, '.local/reports/knowledge-blocks.json');
const runId = `knowledge-blocks-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const uniqueTerm = `quartz-${randomUUID().slice(0, 8)}-rag`;
const textBody = [
  `INTLY Knowledge runtime smoke ${runId}`,
  `Unique retrieval token ${uniqueTerm}.`,
  'Relevant evidence: TypeScript NestJS MongoDB parsing, RAG citations, and private knowledge ACL must work.',
  'Русский текст для OCR/RAG контекста: Привет, знания доступны только владельцу.',
].join('\n');

const report = {
  ok: false,
  runId,
  uniqueTerm,
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

  const owner = await createActivatedUser(admin, apiBaseUrl, 'owner');
  const other = await createActivatedUser(admin, apiBaseUrl, 'other');

  const ownerProfile = await step('owner.profile.create', async () => {
    const created = await owner.client.post('/profiles', {
      name: `Knowledge QA ${runId}`,
      kind: 'mixed',
      isActive: true,
      targetRoles: ['Knowledge Engineer'],
      technologies: ['TypeScript', 'RAG', 'MongoDB'],
      structuredExperienceSummary: 'Runtime QA profile for private knowledge retrieval.',
    });
    assertUuid(created.id, 'owner profile id');
    return { profileId: created.id };
  });

  const documents = await step('knowledge.upload-txt-docx', async () => {
    const txt = await owner.client.multipart('/knowledge/documents/multipart', {
      file: { name: `${runId}.txt`, type: 'text/plain', bytes: Buffer.from(textBody, 'utf8') },
      fields: { title: `Runtime TXT ${runId}`, type: 'note', mode: 'rag_only', profileIds: JSON.stringify([ownerProfile.profileId]) },
    });
    const docx = await owner.client.multipart('/knowledge/documents/multipart', {
      file: { name: `${runId}.docx`, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: makeDocx(textBody) },
      fields: { title: `Runtime DOCX ${runId}`, type: 'work_sample', mode: 'rag_only', profileIds: JSON.stringify([ownerProfile.profileId]) },
    });
    assertUuid(txt.id, 'txt document id');
    assertUuid(docx.id, 'docx document id');
    return { txtId: txt.id, docxId: docx.id };
  });

  await step('knowledge.processing-indexed', async () => {
    const txt = await waitForDocument(owner.client, documents.txtId);
    const docx = await waitForDocument(owner.client, documents.docxId);
    assert(txt.status === 'Indexed', 'txt document should be Indexed');
    assert(docx.status === 'Indexed', 'docx document should be Indexed');
    assert(txt.chunkCount >= 1, 'txt should have chunks');
    assert(docx.chunkCount >= 1, 'docx should have chunks');
    return { txt: pickDocument(txt), docx: pickDocument(docx) };
  });

  const chunkEvidence = await step('knowledge.mongo-chunks-embeddings', async () => {
    const mongoose = await import('mongoose');
    const uri = process.env.MONGODB_URI ?? env.MONGODB_URI;
    assert(uri, 'MONGODB_URI is required for raw chunk verification');
    const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
    try {
      const chunks = await connection.db.collection('knowledgechunks').find({
        documentId: { $in: [documents.txtId, documents.docxId] },
        active: true,
        deletedAt: { $exists: false },
      }).project({ _id: 1, documentId: 1, text: 1, embedding: 1, embeddingMetadata: 1 }).toArray();
      assert(chunks.length >= 2, 'expected chunks for txt and docx');
      for (const chunk of chunks) {
        assert(Array.isArray(chunk.embedding), 'chunk embedding should be stored');
        assert(chunk.embedding.length === 384, 'chunk embedding dimension should be 384');
        assert(chunk.embedding.every(Number.isFinite), 'chunk embedding values should be finite');
        assert(chunk.embeddingMetadata?.dimension === 384, 'chunk embedding metadata dimension should be 384');
        const expectedHash = createHash('sha256').update(`passage: ${String(chunk.text).trim()}`.slice(0, 8000)).digest('hex');
        assert(chunk.embeddingMetadata?.inputHash === expectedHash, 'passage prefix inputHash should match E5 passage prefix');
      }
      return { count: chunks.length, dimensions: [...new Set(chunks.map((chunk) => chunk.embedding.length))], documents: [...new Set(chunks.map((chunk) => chunk.documentId))] };
    } finally {
      await connection.close();
    }
  });

  await step('knowledge.rag-retrieval-citations', async () => {
    const result = await owner.client.post('/knowledge/search', { query: uniqueTerm, profileId: ownerProfile.profileId, topK: 5 });
    assert(Array.isArray(result.items) && result.items.length >= 1, 'knowledge search should return evidence');
    const matching = result.items.filter((item) => [documents.txtId, documents.docxId].includes(item.documentId));
    assert(matching.length >= 1, 'retrieval should cite uploaded document');
    assert(matching.some((item) => item.excerpt?.includes(uniqueTerm)), 'retrieval excerpt should include unique query token');
    assert(matching.every((item) => item.chunkId && item.documentTitle && typeof item.score === 'number'), 'evidence should include citations and scores');
    return { evidenceCount: result.items.length, citedDocumentIds: [...new Set(matching.map((item) => item.documentId))], topScore: result.items[0]?.score };
  });

  await step('search.meili-index-live', async () => {
    const meiliModule = await import('meilisearch');
    const Client = meiliModule.MeiliSearch ?? meiliModule.Meilisearch ?? meiliModule.default;
    assert(typeof Client === 'function', 'MeiliSearch client constructor should be available');
    const host = process.env.MEILI_URL ?? env.MEILI_URL;
    assert(host, 'MEILI_URL is required for Meili verification');
    const client = new Client({ host, apiKey: process.env.MEILI_MASTER_KEY ?? env.MEILI_MASTER_KEY });
    const deadline = Date.now() + 30_000;
    let hits = [];
    while (Date.now() < deadline) {
      const response = await client.index('knowledge_chunks').search(uniqueTerm, { limit: 10 });
      hits = response.hits ?? [];
      if (hits.some((hit) => [documents.txtId, documents.docxId].includes(hit.documentId))) break;
      await delay(1000);
    }
    const ownHits = hits.filter((hit) => [documents.txtId, documents.docxId].includes(hit.documentId));
    assert(ownHits.length >= 1, 'Meili knowledge_chunks should contain uploaded private knowledge');
    assert(ownHits.every((hit) => hit.userId === owner.userId), 'Meili projections should retain owner userId for filtering');
    return { hitCount: ownHits.length, index: 'knowledge_chunks', documentIds: [...new Set(ownHits.map((hit) => hit.documentId))] };
  });

  await step('knowledge.search-private-acl', async () => {
    const ownerKnowledge = await owner.client.post('/knowledge/search', { query: uniqueTerm, profileId: ownerProfile.profileId, topK: 5 });
    const otherKnowledge = await other.client.post('/knowledge/search', { query: uniqueTerm, topK: 5 });
    const ownerUnified = await owner.client.post('/search', { query: uniqueTerm, scope: 'knowledge', profileId: ownerProfile.profileId, limit: 5 });
    const otherUnified = await other.client.post('/search', { query: uniqueTerm, scope: 'knowledge', limit: 5 });
    assert(ownerKnowledge.items?.length >= 1, 'owner knowledge search should see private docs');
    assert(flattenSearchItems(ownerUnified).length >= 1, 'owner unified search should see private docs');
    assert(!otherKnowledge.items?.some((item) => [documents.txtId, documents.docxId].includes(item.documentId)), 'second user knowledge search should not see private docs');
    const otherItems = flattenSearchItems(otherUnified);
    assert(!otherItems.some((item) => item.payload?.documentId && [documents.txtId, documents.docxId].includes(item.payload.documentId)), 'second user unified search should not see private docs');
    return {
      ownerKnowledge: ownerKnowledge.items.length,
      otherKnowledge: otherKnowledge.items.length,
      ownerUnified: flattenSearchItems(ownerUnified).length,
      otherUnified: otherItems.length,
    };
  });

  report.ok = true;
}

async function createActivatedUser(admin, apiBaseUrl, label) {
  const email = `qa-knowledge-${label}-${Date.now()}-${randomUUID().slice(0, 8)}@intly.local`;
  const password = `KQA-${randomUUID()}-intly-2026!`;
  const client = new ApiClient(apiBaseUrl);
  const result = await step(`qa-${label}.invite-and-activate`, async () => {
    const invited = await admin.post('/admin/users', { email, name: `QA Knowledge ${label}`, role: 'User' });
    const activationToken = requiredString(invited, 'activationToken');
    const activated = await client.post('/auth/activate', { token: activationToken, password, name: `QA Knowledge ${label}` });
    client.setAccessToken(requiredString(activated, 'accessToken'));
    return { userId: activated.user?.id, role: activated.user?.role, email };
  });
  return { client, userId: result.userId, email };
}

async function waitForDocument(client, id) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    last = await client.get(`/knowledge/documents/${id}`);
    if (last.status === 'Indexed') return last;
    if (last.status === 'Failed') throw new Error(`Document ${id} failed: ${last.lastError ?? 'unknown error'}`);
    await delay(1000);
  }
  throw new Error(`Document ${id} did not index within 30s; last status ${last?.status ?? 'unknown'}`);
}

function pickDocument(document) {
  return { id: document.id, status: document.status, chunkCount: document.chunkCount, title: document.title, processedAt: document.processedAt };
}

function flattenSearchItems(response) {
  if (Array.isArray(response.items)) return response.items;
  if (Array.isArray(response.groups)) return response.groups.flatMap((group) => group.items ?? []);
  if (response.groups && typeof response.groups === 'object') return Object.values(response.groups).flatMap((group) => group?.items ?? []);
  return [];
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
      signal: AbortSignal.timeout(Number(process.env.INTLY_VERIFY_TIMEOUT_MS ?? 30_000)),
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
      signal: AbortSignal.timeout(Number(process.env.INTLY_VERIFY_TIMEOUT_MS ?? 30_000)),
    });
    this.captureCookies(response);
    return this.parseResponse(response, input);
  }
  async parseResponse(response, options = {}) {
    const expected = options.expectedStatus ?? (response.status >= 200 && response.status < 300 ? response.status : 200);
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

function makeDocx(text) {
  const files = new Map([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8')],
    ['_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8')],
    ['word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split(/\r?\n/).map((line) => `<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`, 'utf8')],
  ]);
  return zipStore(files);
}

function zipStore(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    locals.push(localHeader, nameBuffer, content);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + content.length;
  }
  const centralOffset = offset;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]);
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
    env[key] = rest.join('=').replace(/^[ '\"]|[ '\"]$/g, '');
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
