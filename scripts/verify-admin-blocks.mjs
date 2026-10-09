import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const env = parse(await readFile(new URL('../.env', import.meta.url)));
assert.notEqual(env.NODE_ENV, 'production', 'admin verification refuses production');
assert.ok((env.MONGODB_URI ?? '').includes('127.0.0.1') || (env.MONGODB_URI ?? '').includes('localhost'), 'admin verification requires local MongoDB');
assert.ok((env.REDIS_URL ?? '').includes('127.0.0.1') || (env.REDIS_URL ?? '').includes('localhost'), 'admin verification requires local Redis');

const base = process.env.VERIFY_API_URL ?? `http://127.0.0.1:${env.PORT ?? 3001}/api/v1`;
const origin = env.FRONTEND_URL ?? 'http://localhost:3000';
const stamp = Date.now();
const password = 'Intly-local-check-2026!';
const checks = [];
const report = {
  checkedAt: new Date().toISOString(),
  passed: false,
  checks,
  fixtures: {},
};

async function request(method, path, body, actor, expected = 200, overrides = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(actor?.token ? { Authorization: `Bearer ${actor.token}` } : {}),
      ...overrides,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => null);
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status), `${method} ${path}: expected ${statuses}, got ${response.status} (${data?.error?.code ?? data?.code ?? 'unknown'}: ${JSON.stringify(data)?.slice(0, 500) ?? ''})`);
  checks.push({ name: `${method} ${path.replace(/[?].*/, '')}`, status: response.status });
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function main() {
  const health = await request('GET', '/health/ready');
  assert.equal(health.data.status, 'ok');

  const adminLogin = await request('POST', '/auth/login', {
    email: env.BOOTSTRAP_ADMIN_EMAIL,
    password: env.BOOTSTRAP_ADMIN_PASSWORD,
  }, undefined, 201);
  const admin = { token: adminLogin.data.accessToken, id: adminLogin.data.user.id, email: adminLogin.data.user.email, name: adminLogin.data.user.name };
  assert.equal(adminLogin.data.user.role, 'Admin');

  const invited = await inviteAndActivate(admin);
  await assertUserForbidden(invited.user);
  await verifyJobs(admin, invited.user);
  await verifyReports(admin, invited.user);

  report.passed = true;
  await mkdir(new URL('../../.local/reports/', import.meta.url), { recursive: true });
  await writeFile(new URL('../../.local/reports/admin-blocks.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, report: '.local/reports/admin-blocks.json' }));
}

async function inviteAndActivate(admin) {
  const email = `intly-admin-qa-${stamp}@intly.local`;
  const inviteDefaults = { starterProfile: false, defaultPrompts: false, notifications: false };
  const invite = await request('POST', '/admin/users', {
    email,
    name: 'Admin Acceptance QA',
    role: 'User',
    locale: 'en',
    timezone: 'Europe/Volgograd',
    inviteDefaults,
  }, admin, 201);
  assert.equal(invite.data.user.role, 'User');
  assert.equal(invite.data.user.locale, 'en');
  assert.equal(invite.data.user.timezone, 'Europe/Volgograd');
  assert.deepEqual(invite.data.user.inviteDefaults, inviteDefaults);
  assert.equal(invite.data.user.notificationSettings.inApp, false);
  assert.equal(invite.data.user.aiPreferences.language, 'en');
  assert.equal(Boolean(invite.data.user.aiPreferences.userPrompt), false);
  assert.equal(invite.data.user.onboarding.checklist.starterProfilePreset, false);
  assert.equal(invite.data.user.onboarding.checklist.defaultPromptsPreset, false);
  assert.equal(invite.data.user.onboarding.checklist.notificationDefaults, false);
  assert.equal(typeof invite.data.activationToken, 'string');

  const activation = await request('POST', '/auth/activate', {
    token: invite.data.activationToken,
    password,
    name: 'Activated Admin Acceptance QA',
  }, undefined, 201);
  assert.equal(activation.data.user.status, 'Active');
  assert.equal(activation.data.user.locale, 'en');
  assert.equal(activation.data.user.timezone, 'Europe/Volgograd');
  assert.deepEqual(activation.data.user.inviteDefaults, inviteDefaults);
  assert.equal(activation.data.user.notificationSettings.inApp, false);
  assert.equal(activation.data.user.aiPreferences.language, 'en');
  assert.equal(Boolean(activation.data.user.aiPreferences.userPrompt), false);

  report.fixtures.user = { id: activation.data.user.id, email, inviteDefaults };
  return { user: { token: activation.data.accessToken, id: activation.data.user.id, email } };
}

async function assertUserForbidden(user) {
  await request('GET', '/admin/jobs', undefined, user, 403);
  await request('GET', '/admin/reports', undefined, user, 403);
}

async function verifyJobs(admin, user) {
  const scheduled = await request('GET', '/admin/jobs/scheduled', undefined, admin);
  assert.ok(Array.isArray(scheduled.data.items), 'scheduled response must be a list');

  const queue = await createDelayedQaJob(user.id);
  try {
    const list = await request('GET', '/admin/jobs/maintenance?state=delayed', undefined, admin);
    assert.ok(list.data.items.some((item) => String(item.id) === queue.jobId && item.canCancel === true), 'QA delayed job must be visible and cancellable');

    const detail = await request('GET', `/admin/jobs/maintenance/${encodeURIComponent(queue.jobId)}`, undefined, admin);
    assert.equal(detail.data.state, 'delayed');
    assert.equal(detail.data.canCancel, true);
    assert.equal(detail.data.data.apiKey, '[redacted]');
    assert.equal(detail.data.data.nested.token, '[redacted]');
    assert.equal(detail.data.data.password, '[redacted]');
    assert.equal(detail.data.entity.userId, user.id);

    await request('POST', `/admin/jobs/maintenance/${encodeURIComponent(queue.jobId)}/cancel`, undefined, admin, 201);
    await request('GET', `/admin/jobs/maintenance/${encodeURIComponent(queue.jobId)}`, undefined, admin, 404);
    report.fixtures.cancelledJob = { queue: 'maintenance', id: queue.jobId };
  } finally {
    await queue.close();
  }
}

async function createDelayedQaJob(userId) {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  const queue = new Queue('maintenance', { connection });
  const jobId = `qa-admin-acceptance-${stamp}`;
  await queue.add('qa.admin.acceptance', {
    requestId: `admin-acceptance-${stamp}`,
    userId,
    apiKey: 'local-secret-not-reported',
    password: 'local-password-not-reported',
    nested: { token: 'local-token-not-reported' },
  }, {
    jobId,
    delay: 60 * 60 * 1000,
    attempts: 1,
    removeOnComplete: { count: 1 },
    removeOnFail: { count: 1 },
  });
  return { queue, jobId, close: async () => { await queue.close(); await connection.quit(); } };
}

async function verifyReports(admin, user) {
  const opportunity = await createQaOpportunity(user);
  const categories = ['duplicate', 'closed', 'money', 'remote_location', 'broken_link', 'technology_category', 'wrong_data', 'spam', 'other'];
  const createdReports = [];
  for (const type of categories) {
    const created = await request('POST', `/opportunities/${opportunity.id}/report`, {
      type,
      comment: `admin acceptance ${stamp} category ${type}`,
    }, user, 201);
    assert.equal(created.data.type, type);
    createdReports.push(created.data);
  }

  await request('PATCH', `/admin/reports/${createdReports[0].id}`, {
    assignedAdminId: admin.id,
    priority: 'high',
    adminComment: 'Assigned during admin acceptance',
  }, admin);

  const list = await request('GET', `/admin/reports?opportunityId=${encodeURIComponent(opportunity.id)}`, undefined, admin);
  const reportTypes = new Set(list.data.items.map((item) => item.type));
  for (const type of categories) assert.ok(reportTypes.has(type), `missing report category ${type}`);
  const assigned = list.data.items.find((item) => item.id === createdReports[0].id);
  assert.equal(assigned.reporter.email, user.email);
  assert.equal(assigned.reporter.name, 'Activated Admin Acceptance QA');
  assert.equal(assigned.assignee.email, admin.email);
  assert.equal(assigned.assignee.name, admin.name);

  const detail = await request('GET', `/admin/reports/${createdReports[0].id}`, undefined, admin);
  assert.equal(detail.data.reporter.email, user.email);
  assert.equal(detail.data.assignee.email, admin.email);
  assert.ok(Array.isArray(detail.data.sourceOccurrences), 'detail must include safe source occurrences');
  assert.equal(JSON.stringify(detail.data.sourceOccurrences).includes('rawPayload'), false);

  const bulk = await request('POST', '/admin/reports/bulk', {
    ids: [createdReports[1].id, createdReports[2].id],
    action: 'dismiss',
    reason: `admin acceptance bulk ${stamp}`,
  }, admin, 201);
  assert.deepEqual(bulk.data.items.map((item) => [item.id, item.success, item.status]), [
    [createdReports[1].id, true, 'Dismissed'],
    [createdReports[2].id, true, 'Dismissed'],
  ]);

  report.fixtures.opportunity = { id: opportunity.id };
  report.fixtures.reports = { categories: categories.length, assignedReportId: createdReports[0].id, bulkIds: [createdReports[1].id, createdReports[2].id] };
}

async function createQaOpportunity(user) {
  const result = await request('POST', '/opportunities/manual', {
    type: 'vacancy',
    title: `Admin acceptance QA opportunity ${stamp}`,
    companyOrClient: 'INTLY QA',
    description: 'Local admin acceptance record for issue report verification.',
    skills: ['TypeScript', 'NestJS'],
    technologies: ['MongoDB'],
    remoteType: 'remote',
    money: { min: 100000, max: 150000, currency: 'RUB', period: 'month' },
  }, user, 201);
  assert.ok(result.data.opportunity.id);
  return result.data.opportunity;
}

main().catch(async (error) => {
  report.passed = false;
  report.error = error instanceof Error ? error.message : 'admin acceptance failed';
  await mkdir(new URL('../../.local/reports/', import.meta.url), { recursive: true }).catch(() => undefined);
  await writeFile(new URL('../../.local/reports/admin-blocks.json', import.meta.url), JSON.stringify(report, null, 2)).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
});
