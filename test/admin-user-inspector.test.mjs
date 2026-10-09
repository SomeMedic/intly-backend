import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { NotFoundException, BadRequestException } = require('@nestjs/common');
const { AdminUserInspectorRepository } = require('../src/modules/users/admin-user-inspector.repository.ts');
const { AdminUserInspectorService } = require('../src/modules/users/admin-user-inspector.service.ts');
const { parseInspectorLimit, parseInspectorSection, parseInspectorCursor, parseInspectorUserIds } = require('../src/modules/users/dto/admin-user-inspector.dto.ts');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ASSIGNED = '44444444-4444-4444-8444-444444444444';
const TASK_REPORTED = '55555555-5555-4555-8555-555555555555';
const TASK_OTHER = '66666666-6666-4666-8666-666666666666';
const RESPONSE_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_RESPONSE_ID = '88888888-8888-4888-8888-888888888888';

function actor() {
  return { id: ADMIN_ID, role: 'Admin', email: 'admin@example.com' };
}

test('inspector overview validates target user and reuses monthly AI usage summary', async () => {
  const calls = [];
  const service = new AdminUserInspectorService(
    {
      getUser: async (id) => ({ _id: id, status: 'Deleted' }),
      overviewCounts: async () => ({
        counts: { profiles: 2, resumes: 1, adaptations: 0, knowledge: 3, watchlists: 1, watchlistHits: 4, opportunityStates: 5, responses: 6, tasks: 3, tasksAssigned: 1, tasksReported: 2, boards: 1, aiRuns: 7 },
        breakdowns: { knowledgeByStatus: { Indexed: 3 }, opportunitiesByPipelineStatus: { New: 5 } },
      }),
    },
    { usageSummary: async (filters) => { calls.push(filters); return { summary: { runs: 7 }, items: [] }; } },
    { record: async () => {} },
  );

  const overview = await service.overview(actor(), USER_ID);

  assert.equal(overview.userId, USER_ID);
  assert.equal(overview.counts.profiles, 2);
  assert.equal(overview.counts.tasks, 3);
  assert.equal(overview.currentMonthAiUsage.summary.runs, 7);
  assert.equal(calls[0].userId, USER_ID);
  assert.match(calls[0].dateFrom, /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  assert.match(calls[0].dateTo, /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
});

test('inspector batch overview validates up to 50 current-page ids', async () => {
  const seen = [];
  const validatedUsers = [];
  const service = new AdminUserInspectorService(
    {
      getUser: async (id) => { validatedUsers.push(id); return { _id: id }; },
      overviewCounts: async (userId) => { seen.push(userId); return { counts: { profiles: 0, resumes: 0, adaptations: 0, knowledge: 0, watchlists: 0, watchlistHits: 0, opportunityStates: 0, responses: 0, tasks: 0, tasksAssigned: 0, tasksReported: 0, boards: 0, aiRuns: 0 }, breakdowns: { knowledgeByStatus: {}, opportunitiesByPipelineStatus: {} } }; },
    },
    { usageSummary: async () => ({ summary: { runs: 0, estimatedCost: null } }) },
    { record: async () => {} },
  );

  const result = await service.overviewBatch(actor(), [USER_ID, OTHER_ID]);

  assert.deepEqual(result.items.map((item) => item.userId), [USER_ID, OTHER_ID]);
  assert.equal(result.nextCursor, null);
  assert.deepEqual(seen, [USER_ID, OTHER_ID]);
  assert.deepEqual(validatedUsers, [USER_ID, OTHER_ID]);
});

test('inspector overview counts tasks once when assigned and reported overlap', async () => {
  const repository = new AdminUserInspectorRepository(fakeConnection({
    tasks: [
      { _id: TASK_ASSIGNED, title: 'Both', assigneeId: USER_ID, reporterId: USER_ID, deletedAt: undefined },
      { _id: TASK_REPORTED, title: 'Reported', assigneeId: OTHER_ID, reporterId: USER_ID, deletedAt: undefined },
      { _id: TASK_OTHER, title: 'Other', assigneeId: OTHER_ID, reporterId: OTHER_ID, deletedAt: undefined },
    ],
  }));

  const overview = await repository.overviewCounts(USER_ID);

  assert.equal(overview.counts.tasks, 2);
  assert.equal(overview.counts.tasksAssigned, 1);
  assert.equal(overview.counts.tasksReported, 2);
});

test('inspector repository lists only tasks assigned or reported by target user', async () => {
  const repository = new AdminUserInspectorRepository(fakeConnection({
    users: [{ _id: USER_ID, email: 'user@example.com' }],
    tasks: [
      { _id: TASK_ASSIGNED, title: 'Assigned', assigneeId: USER_ID, reporterId: OTHER_ID, deletedAt: undefined },
      { _id: TASK_REPORTED, title: 'Reported', assigneeId: OTHER_ID, reporterId: USER_ID, deletedAt: undefined },
      { _id: TASK_OTHER, title: 'Other', assigneeId: OTHER_ID, reporterId: OTHER_ID, deletedAt: undefined },
    ],
  }));

  const page = await repository.list({ section: 'tasks', userId: USER_ID, limit: 1 });
  const nextPage = await repository.list({ section: 'tasks', userId: USER_ID, limit: 10, cursor: page.nextCursor });

  assert.deepEqual(page.items.map((item) => item.id), [TASK_ASSIGNED]);
  assert.equal(page.nextCursor, TASK_ASSIGNED);
  assert.deepEqual(nextPage.items.map((item) => item.id), [TASK_REPORTED]);
  assert.deepEqual(nextPage.items.map((item) => item.title), ['Reported']);
  assert.equal(nextPage.nextCursor, null);
});

test('inspector content enforces owner filter and audits safe metadata', async () => {
  const audit = [];
  const repository = new AdminUserInspectorRepository(fakeConnection({
    users: [{ _id: USER_ID, email: 'user@example.com' }],
    responses: [
      { _id: RESPONSE_ID, userId: USER_ID, profileId: 'p1', opportunityId: 'o1', format: 'cover_letter', documentJson: { type: 'doc' }, deletedAt: undefined },
      { _id: OTHER_RESPONSE_ID, userId: OTHER_ID, profileId: 'p2', opportunityId: 'o2', format: 'cover_letter', documentJson: { type: 'doc' }, deletedAt: undefined },
    ],
  }));
  const service = new AdminUserInspectorService(repository, { usageSummary: async () => ({}) }, { record: async (...args) => audit.push(args) });

  const result = await service.content(actor(), USER_ID, 'responses', RESPONSE_ID);

  assert.equal(result.item.id, RESPONSE_ID);
  assert.deepEqual(audit[0], [actor(), 'user.inspect_content', 'User', USER_ID, [`section:responses`, `entityId:${RESPONSE_ID}`]]);
  await assert.rejects(() => service.content(actor(), USER_ID, 'responses', OTHER_RESPONSE_ID), NotFoundException);
});

test('inspector content uses allowlisted projections and redacts AI secrets without losing usage', async () => {
  const startedAt = new Date('2026-10-06T00:00:00.000Z');
  const repository = new AdminUserInspectorRepository(fakeConnection({
    ai_analyses: [{
      _id: RESPONSE_ID, userId: USER_ID, profileId: 'p1', opportunityId: 'o1', taskType: 'response_generation', status: 'completed',
      prompt: { text: 'do not expose' }, metadata: { apiKey: 'secret' }, provider: 'openai', modelId: 'gpt-test', usage: { inputTokens: 10, outputTokens: 20, estimatedCost: null },
      attempts: [{ number: 1, provider: 'openai', modelId: 'gpt-test', status: 'completed', usage: { totalTokens: 30, apiKey: 'secret' }, accessToken: 'secret' }],
      structuredOutput: { text: 'legitimate user-facing output' }, startedAt, deletedAt: undefined,
    }],
  }));

  const item = await repository.content('aiRuns', USER_ID, RESPONSE_ID);

  assert.equal(item.id, RESPONSE_ID);
  assert.equal(item.provider, 'openai');
  assert.deepEqual(item.usage, { inputTokens: 10, outputTokens: 20, estimatedCost: null });
  assert.deepEqual(item.structuredOutput, { text: 'legitimate user-facing output' });
  assert.equal('prompt' in item, false);
  assert.equal('metadata' in item, false);
  assert.equal(item.startedAt, startedAt);
  assert.equal(item.attempts[0].usage.totalTokens, 30);
  assert.equal(item.attempts[0].usage.apiKey, '[redacted]');
  assert.equal(item.attempts[0].accessToken, '[redacted]');
});

test('inspector DTO helpers validate section limit and cursor UUID', () => {
  assert.equal(parseInspectorSection('profiles'), 'profiles');
  assert.equal(parseInspectorLimit('50'), 50);
  assert.equal(parseInspectorCursor(RESPONSE_ID), RESPONSE_ID);
  assert.throws(() => parseInspectorSection('secrets'), BadRequestException);
  assert.throws(() => parseInspectorLimit('51'), BadRequestException);
  assert.throws(() => parseInspectorCursor('not-a-uuid'), BadRequestException);
  assert.deepEqual(parseInspectorUserIds([USER_ID, OTHER_ID]), [USER_ID, OTHER_ID]);
  assert.throws(() => parseInspectorUserIds([]), BadRequestException);
  assert.throws(() => parseInspectorUserIds(Array.from({ length: 51 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`)), BadRequestException);
});

function fakeConnection(data) {
  return {
    collection(name) {
      return fakeCollection(data[name] ?? []);
    },
  };
}

function fakeCollection(seed) {
  const rows = seed.map((row) => ({ ...row }));
  return {
    async findOne(filter, options = {}) {
      const row = rows.find((item) => matches(item, filter));
      return row ? project(row, options.projection) : null;
    },
    async countDocuments(filter) {
      return rows.filter((item) => matches(item, filter)).length;
    },
    find(filter, options = {}) {
      let sortSpec = { _id: 1 };
      let limitValue = rows.length;
      return {
        sort(spec) { sortSpec = spec; return this; },
        limit(value) { limitValue = value; return this; },
        async toArray() {
          return rows
            .filter((item) => matches(item, filter))
            .sort((left, right) => compare(left, right, sortSpec))
            .slice(0, limitValue)
            .map((item) => project(item, options.projection));
        },
      };
    },
    aggregate(pipeline) {
      return {
        async toArray() {
          const matchStage = pipeline.find((stage) => stage.$match)?.$match ?? {};
          const groupStage = pipeline.find((stage) => stage.$group)?.$group;
          const matched = rows.filter((item) => matches(item, matchStage));
          if (!groupStage) return matched;
          const field = String(groupStage._id).replace(/^\$/, '');
          const counts = new Map();
          for (const item of matched) counts.set(item[field], (counts.get(item[field]) ?? 0) + 1);
          return [...counts.entries()].map(([_id, count]) => ({ _id, count }));
        },
      };
    },
  };
}

function matches(row, filter) {
  for (const [key, expected] of Object.entries(filter ?? {})) {
    if (key === '$or') {
      if (!expected.some((entry) => matches(row, entry))) return false;
    } else if (expected && typeof expected === 'object' && '$exists' in expected) {
      if ((row[key] !== undefined) !== expected.$exists) return false;
    } else if (expected && typeof expected === 'object' && '$gt' in expected) {
      if (!(row[key] > expected.$gt)) return false;
    } else if (Array.isArray(row[key])) {
      if (!row[key].includes(expected)) return false;
    } else if (row[key] !== expected) {
      return false;
    }
  }
  return true;
}

function project(row, projection = {}) {
  const entries = Object.entries(projection);
  if (!entries.length) return { ...row };
  const includes = entries.filter(([, value]) => value === 1).map(([key]) => key);
  if (includes.length) return Object.fromEntries(includes.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
  const copy = { ...row };
  for (const [key, value] of entries) if (value === 0) delete copy[key];
  return copy;
}

function compare(left, right, sortSpec) {
  for (const [field, direction] of Object.entries(sortSpec)) {
    if (left[field] < right[field]) return -direction;
    if (left[field] > right[field]) return direction;
  }
  return 0;
}
