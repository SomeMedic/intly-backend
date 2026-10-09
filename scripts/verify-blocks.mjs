import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parse } from 'dotenv';

const env = parse(await readFile(new URL('../.env', import.meta.url)));
assert.notEqual(env.NODE_ENV, 'production', 'This check creates development-only records');
const base = process.env.VERIFY_API_URL ?? `http://127.0.0.1:${env.PORT ?? 3001}/api/v1`;
const origin = env.FRONTEND_URL ?? 'http://localhost:3000';
const checks = [];
const stamp = Date.now();
const password = 'Intly-local-check-2026!';

async function request(method, path, body, actor, expected = 200, overrides = {}) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(actor?.token ? { Authorization: `Bearer ${actor.token}` } : {}), ...overrides },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => null);
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status), `${method} ${path}: expected ${statuses}, received ${response.status} (${data?.error?.code ?? data?.code ?? 'unknown'}: ${data?.error?.message ?? ''})`);
  checks.push({ method, path: path.replace(/\?.*/, ''), status: response.status });
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

const health = await request('GET', '/health/ready');
assert.equal(health.data.status, 'ok');
await request('GET', '/profiles', undefined, undefined, 401);
const adminLogin = await request('POST', '/auth/login', { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD }, undefined, 201);
const admin = { token: adminLogin.data.accessToken, id: adminLogin.data.user.id };
assert.equal(adminLogin.data.user.role, 'Admin');
await request('POST', '/auth/refresh', undefined, undefined, 403, { Origin: 'https://untrusted.invalid', Cookie: adminLogin.cookie });

async function newUser(suffix) {
  const email = `intly-qa-${stamp}-${suffix}@intly.local`;
  const invite = await request('POST', '/admin/users', { email, name: `Проверка ${suffix}`, role: 'User', locale: 'ru', timezone: 'Europe/Volgograd' }, admin, 201);
  assert.equal(typeof invite.data.activationToken, 'string', 'Development invite token required for this local check');
  const session = await request('POST', '/auth/activate', { token: invite.data.activationToken, password, name: suffix === 'a' ? 'Алексей · проверка INTLY' : 'Второй пользователь' }, undefined, 201);
  return { token: session.data.accessToken, id: session.data.user.id, email, cookie: session.cookie };
}
const a = await newUser('a');
const b = await newUser('b');
await request('GET', '/admin/sources', undefined, a, 403);
const catalog = await request('GET', '/sources', undefined, a);
const sources = Array.isArray(catalog.data) ? catalog.data : catalog.data.items;
assert.equal(sources.length, 103);
assert.equal(JSON.stringify(sources).includes('credentialsEncrypted'), false);
const profile = (await request('POST', '/profiles', {
  name: 'Python · удалённая работа', kind: 'career', technologies: ['Python', 'PostgreSQL', 'Docker'],
  targetRoles: ['Senior Python Engineer'], seniority: ['senior'], remotePreferences: ['remote'], sourceIds: [],
  compensationPreferences: { min: 250000, currency: 'RUB', period: 'month' }, structuredExperienceSummary: 'Разработка API и сервисов на Python, PostgreSQL и Docker.',
}, a, 201)).data;
assert.ok(profile.id);
await request('GET', `/profiles/${profile.id}`, undefined, b, [403, 404]);
await request('PATCH', '/me/onboarding', { minimumComplete: true, checklist: { profile: true } }, a);
const manual = (await request('POST', '/opportunities/manual', {
  type: 'vacancy', title: `Проверка INTLY — Senior Python Engineer ${stamp}`, companyOrClient: 'INTLY Development QA',
  description: 'Тестовая запись для проверки общего корпуса и личного рабочего процесса. Разработка API на Python, PostgreSQL, Docker. Удалённая работа.',
  skills: ['Python', 'PostgreSQL', 'Docker'], seniority: 'senior', remoteType: 'remote',
  money: { min: 250000, max: 350000, currency: 'RUB', period: 'month', originalText: '250 000 – 350 000 ₽ / месяц' },
}, a, 201)).data;
const opportunity = manual.opportunity;
assert.ok(opportunity.id);
const shared = (await request('GET', `/opportunities/${opportunity.id}`, undefined, b)).data;
assert.equal(shared.id, opportunity.id, 'Manual imports must be shared from creation');
assert.equal(JSON.stringify(shared).includes('rawPayload'), false);
await request('PATCH', `/opportunities/${opportunity.id}/personal`, { profileId: profile.id, favorite: true, pipelineStatus: 'Shortlisted', notes: [{ body: 'Личная заметка проверки', createdAt: new Date().toISOString() }] }, a);
const stateB = (await request('GET', `/opportunities/${opportunity.id}/personal`, undefined, b)).data;
assert.equal(stateB, null, 'Private state must not appear for another user without their own profile');
const comment = (await request('POST', `/opportunities/${opportunity.id}/comments`, { body: 'Общий комментарий проверки' }, a, 201)).data;
const comments = (await request('GET', `/opportunities/${opportunity.id}/comments`, undefined, b)).data;
assert.ok(comments.some(item => item.id === comment.id));
await request('DELETE', `/opportunities/${opportunity.id}/comments/${comment.id}`, undefined, b, 403);
const watchlist = (await request('POST', '/watchlists', { name: 'Python remote · проверка', profileId: profile.id, filters: { query: 'Python', remoteType: 'remote' }, autoAiRules: { enabled: false } }, a, 201)).data;
await request('GET', `/watchlists/${watchlist.id}`, undefined, b, [403, 404]);
await request('POST', `/watchlists/${watchlist.id}/pause`, undefined, a, 201);
await request('POST', `/watchlists/${watchlist.id}/resume`, undefined, a, 201);
const board = (await request('POST', '/boards', { name: 'Отклики · проверка', scope: 'personal' }, a, 201)).data;
const task = (await request('POST', '/tasks', { boardId: board.id, statusColumnId: board.columns[0].id, title: 'Проверить описание и подготовить вопросы', opportunityId: opportunity.id, profileId: profile.id, assigneeId: a.id, dueAt: new Date(Date.now() + 86_400_000).toISOString() }, a, 201)).data;
await request('GET', `/tasks/${task.id}`, undefined, b, [403, 404]);
await request('PATCH', `/boards/${board.id}`, { members: [b.id] }, a);
await request('GET', `/tasks/${task.id}`, undefined, b);
await request('PATCH', `/tasks/${task.id}`, { description: 'Участник общей доски может редактировать задачу' }, b);
const draft = (await request('POST', '/responses', { opportunityId: opportunity.id, profileId: profile.id, format: 'cover_letter' }, a, 201)).data;
await request('GET', `/responses/${draft.id}`, undefined, b, [403, 404]);
await request('POST', `/responses/${draft.id}/status`, { revision: draft.revision, status: 'ready' }, a, 400);
const documentJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Здравствуйте! Мой опыт Python и PostgreSQL соответствует задачам команды.' }] }] };
const saved = (await request('PATCH', `/responses/${draft.id}`, { revision: draft.revision, documentJson, checklist: { factsChecked: true, requirementsCovered: true, noUnresolvedPlaceholders: true, userReviewed: true } }, a)).data;
await request('PATCH', `/responses/${draft.id}`, { revision: draft.revision, documentJson }, a, 409);
await request('POST', `/responses/${draft.id}/status`, { revision: saved.revision, status: 'ready' }, a, 201);
const aiRun = (await request('POST', '/ai/analyses', { opportunityId: opportunity.id, profileId: profile.id }, a, 201)).data;
await request('GET', `/ai/runs/${aiRun.id}`, undefined, b, [403, 404]);
let result;
for (let attempt = 0; attempt < 20; attempt++) {
  result = (await request('GET', `/ai/runs/${aiRun.id}`, undefined, a)).data;
  if (['completed', 'failed', 'cancelled'].includes(result.status)) break;
  await new Promise(resolve => setTimeout(resolve, 300));
}
assert.equal(result.status, 'failed', 'Unconfigured provider must fail honestly, without fabricated analysis');
const dashboard = (await request('GET', `/dashboard?profileId=${profile.id}`, undefined, a)).data;
assert.equal(dashboard.activeProfile.id, profile.id);
assert.ok(dashboard.recommended.some(item => item.id === opportunity.id));
await request('GET', '/analytics/personal', undefined, a);
await request('GET', '/analytics/market', undefined, a);
const refreshed = await request('POST', '/auth/refresh', undefined, undefined, 201, { Cookie: b.cookie });
assert.ok(refreshed.cookie && refreshed.cookie !== b.cookie);
await request('POST', '/auth/refresh', undefined, undefined, 401, { Cookie: b.cookie });
await request('POST', '/auth/refresh', undefined, undefined, 401, { Cookie: refreshed.cookie });

await mkdir(new URL('../../.local/reports/', import.meta.url), { recursive: true });
await writeFile(new URL('../../.local/manual-user.json', import.meta.url), JSON.stringify({ email: a.email, password, profileId: profile.id, opportunityId: opportunity.id }, null, 2), { mode: 0o600 });
await writeFile(new URL('../../.local/reports/http-blocks.json', import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), passed: true, checks, fixture: { userId: a.id, profileId: profile.id, opportunityId: opportunity.id } }, null, 2));
console.log(JSON.stringify({ passed: true, checks: checks.length, manualEmail: a.email, profileId: profile.id, opportunityId: opportunity.id }));
