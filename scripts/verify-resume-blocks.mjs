#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { parse } from 'dotenv';

const env = parse(await readFile(new URL('../.env', import.meta.url)));
assert.notEqual(env.NODE_ENV, 'production', 'Refusing to run resume verification against production');
assert.notEqual(process.env.NODE_ENV, 'production', 'Refusing to run resume verification against production');

const apiBase = process.env.VERIFY_API_URL ?? `http://127.0.0.1:${env.PORT ?? 3001}/api/v1`;
assertLoopbackUrl(apiBase);
const mongoUri = process.env.MONGODB_URI ?? env.MONGODB_URI;
assert.ok(mongoUri, 'MONGODB_URI is required for exact fixture cleanup');
assertLoopbackMongoUri(mongoUri);

const origin = env.FRONTEND_URL ?? 'http://localhost:3000';
const runId = `resume-blocks-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const password = `ResumeQA-${randomUUID()}-intly-2026!`;
const checks = [];
const tempResumeIds = [];
const warnings = [];

class ApiClient {
  constructor() {
    this.token = null;
    this.cookie = null;
  }

  setSession(login) {
    this.token = login.data.accessToken;
    this.cookie = login.cookie;
  }

  async request(method, path, body, expected = 200) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text();
    const statuses = Array.isArray(expected) ? expected : [expected];
    assert.ok(statuses.includes(response.status), `${method} ${path}: expected ${statuses.join('/')}, received ${response.status} ${JSON.stringify(data)}`);
    checks.push({ method, path: path.replace(/\?.*/, ''), status: response.status });
    return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  get(path, expected) { return this.request('GET', path, undefined, expected); }
  post(path, body, expected = 201) { return this.request('POST', path, body, expected); }
  patch(path, body, expected = 200) { return this.request('PATCH', path, body, expected); }
}

function documentJson(label) {
  return {
    headline: `${label} backend developer`,
    summary: `Runtime resume verification fixture ${runId}.`,
    skills: [{ id: randomUUID(), text: 'Python' }, { id: randomUUID(), text: 'FastAPI' }, { id: randomUUID(), text: 'PostgreSQL' }],
    experience: [{ id: randomUUID(), text: 'Built backend services and integrations.' }],
    projects: [],
    education: [],
    languages: [{ id: randomUUID(), text: 'English B2' }],
    links: [],
  };
}

function ids(items) {
  return new Set(items.map((item) => item.id));
}

async function main() {
  const admin = new ApiClient();
  const owner = new ApiClient();
  const other = new ApiClient();

  const ready = await owner.get('/health/ready');
  assert.equal(ready.data.status, 'ok');

  const manualUser = JSON.parse(await readFile(new URL('../../.local/manual-user.json', import.meta.url), 'utf8'));
  const ownerLogin = await owner.post('/auth/login', { email: manualUser.email, password: manualUser.password });
  owner.setSession(ownerLogin);
  assert.ok(manualUser.profileId, 'manual-user profileId is required');

  const adminLogin = await admin.post('/auth/login', { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD });
  admin.setSession(adminLogin);
  const invite = await admin.post('/admin/users', { email: `intly-resume-${runId}@intly.local`, name: 'Resume Blocks QA', role: 'User', locale: 'ru' });
  const otherLogin = await other.post('/auth/activate', { token: invite.data.activationToken, password, name: 'Resume Blocks QA' });
  other.setSession(otherLogin);

  const unbound = (await owner.post('/resumes', {
    title: `QA Resume unbound ${runId}`,
    documentJson: documentJson('Unbound'),
    markdownCache: `QA Resume unbound ${runId}`,
  })).data;
  tempResumeIds.push(unbound.id);
  assert.equal(unbound.profileId, undefined);

  const bound = (await owner.post('/resumes', {
    title: `QA Resume bound ${runId}`,
    profileId: manualUser.profileId,
    documentJson: documentJson('Bound'),
    markdownCache: `QA Resume bound ${runId}`,
  })).data;
  tempResumeIds.push(bound.id);
  assert.equal(bound.profileId, manualUser.profileId);

  await step('resumes.all-includes-bound-and-unbound', async () => {
    const all = (await owner.get('/resumes?kind=base')).data.items;
    const allIds = ids(all);
    assert.ok(allIds.has(unbound.id), 'All resumes must include unbound base resume');
    assert.ok(allIds.has(bound.id), 'All resumes must include profile-bound base resume');
    return { count: all.length, unbound: unbound.id, bound: bound.id };
  });

  await step('resumes.profile-filter-only-bound', async () => {
    const filtered = (await owner.get(`/resumes?kind=base&profileId=${manualUser.profileId}`)).data.items;
    const filteredIds = ids(filtered);
    assert.equal(filteredIds.has(unbound.id), false, 'Explicit profile filter must not include unbound resume');
    assert.ok(filteredIds.has(bound.id), 'Explicit profile filter must include matching bound resume');
    return { count: filtered.length };
  });

  const rebound = await step('resumes.patch-profileId-binds-unbound-resume', async () => {
    const updated = (await owner.patch(`/resumes/${unbound.id}`, { revision: unbound.revision, profileId: manualUser.profileId })).data;
    assert.equal(updated.profileId, manualUser.profileId);
    const filtered = (await owner.get(`/resumes?kind=base&profileId=${manualUser.profileId}`)).data.items;
    assert.ok(ids(filtered).has(unbound.id), 'Patched resume must appear in explicit profile filter');
    return { id: updated.id, revision: updated.revision };
  });

  await step('resumes.patch-profileId-null-unbinds-resume', async () => {
    const updated = (await owner.patch(`/resumes/${unbound.id}`, { revision: rebound.revision, profileId: null })).data;
    assert.equal(updated.profileId, undefined);
    const filtered = (await owner.get(`/resumes?kind=base&profileId=${manualUser.profileId}`)).data.items;
    assert.equal(ids(filtered).has(unbound.id), false, 'Unbound resume must leave explicit profile filter');
    const all = (await owner.get('/resumes?kind=base')).data.items;
    assert.ok(ids(all).has(unbound.id), 'Unbound resume must still appear in All profiles');
    return { id: updated.id, revision: updated.revision };
  });

  await step('resumes.ownership-isolation', async () => {
    const otherList = (await other.get('/resumes?kind=base')).data.items;
    assert.equal(ids(otherList).has(bound.id), false, 'Other user must not see owner resume in list');
    await other.get(`/resumes/${bound.id}`, 404);
    return { otherCount: otherList.length };
  });

  const visualTitle = 'QA · Python backend visual';
  const existing = (await owner.get('/resumes?kind=base')).data.items.find((item) => item.title === visualTitle);
  let visualResume = existing;
  if (!visualResume) {
    visualResume = (await owner.post('/resumes', {
      title: visualTitle,
      profileId: manualUser.profileId,
      documentJson: {
        headline: 'Python backend developer',
        summary: 'Проверочное резюме для локального сценария адаптации и экспорта.',
        skills: [{ id: randomUUID(), text: 'Python' }, { id: randomUUID(), text: 'FastAPI' }, { id: randomUUID(), text: 'PostgreSQL' }],
        experience: [{ id: randomUUID(), text: 'Backend API, integrations and data pipelines.' }],
        projects: [{ id: randomUUID(), text: 'INTLY local acceptance workspace.' }],
        education: [],
        languages: [{ id: randomUUID(), text: 'English B2' }],
        links: [],
      },
      markdownCache: 'Python backend developer\nPython, FastAPI, PostgreSQL',
    })).data;
  }

  await cleanupTempResumes();
  await writeReport({ visualResumeId: visualResume.id, manualProfileId: manualUser.profileId });
  console.log(JSON.stringify({ passed: true, checks: checks.length, visualResumeId: visualResume.id, tempCleaned: tempResumeIds.length, reportPath: '.local/reports/resume-blocks.json' }));
}

async function step(name, fn) {
  const result = await fn();
  checks.push({ name, result: 'pass', details: result });
  return result;
}

async function cleanupTempResumes() {
  if (!tempResumeIds.length) return;
  await mongoose.connect(mongoUri);
  try {
    await mongoose.connection.collection('resumes').deleteMany({ _id: { $in: tempResumeIds } });
  } finally {
    await mongoose.disconnect();
  }
}

async function writeReport(extra) {
  const report = { ok: !extra.failed, runId, checkedAt: new Date().toISOString(), apiBase, checks, warnings, fixtures: { tempResumeIds, ...extra } };
  await mkdir(new URL('../../.local/reports/', import.meta.url), { recursive: true });
  await writeFile(new URL('../../.local/reports/resume-blocks.json', import.meta.url), JSON.stringify(report, null, 2));
}

function assertLoopbackUrl(value) {
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname), 'API base URL must be loopback');
}

function assertLoopbackMongoUri(value) {
  assert.ok(value.startsWith('mongodb://'), 'Only direct local MongoDB connections are allowed');
  const authority = value.slice('mongodb://'.length).split('/')[0].split('@').at(-1);
  const hosts = authority.split(',').map((host) => new URL(`http://${host}`).hostname.replace(/^\[/, '').replace(/\]$/, ''));
  assert.ok(hosts.every((host) => ['127.0.0.1', 'localhost', '::1'].includes(host)), 'MONGODB_URI must point to loopback hosts');
}

main().catch(async (error) => {
  warnings.push(error.message);
  await cleanupTempResumes().catch(() => undefined);
  await writeReport({ failed: true }).catch(() => undefined);
  console.error(error);
  process.exit(1);
});
