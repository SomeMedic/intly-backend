import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { AiRepository } = require('../src/modules/ai/ai.repository.ts');
const { IssueReportsRepository } = require('../src/modules/opportunities/issue-reports.repository.ts');

function canonicalConnection(revisions = []) {
  const opportunities = new Map([
    ['opp-alias', { _id: 'opp-alias', mergedIntoOpportunityId: 'opp-canonical' }],
    ['opp-canonical', { _id: 'opp-canonical' }],
    ['opp-other-alias', { _id: 'opp-other-alias', mergedIntoOpportunityId: 'opp-other-canonical' }],
    ['opp-other-canonical', { _id: 'opp-other-canonical' }],
  ]);
  return {
    db: {
      collection(name) {
        assert.equal(name, 'opportunities');
        return {
          findOne: async (filter) => opportunities.get(filter._id) ?? null,
          updateOne: async (filter, update) => { revisions.push({ filter, update }); return { matchedCount: opportunities.has(filter._id) ? 1 : 0 }; },
        };
      },
    },
    async startSession() {
      return {
        id: 'session-1',
        async withTransaction(callback) { return callback(); },
        async endSession() {},
      };
    },
  };
}

class FakeModel {
  constructor(rows = []) {
    this.rows = rows.map((row) => ({ ...row }));
    this.created = [];
    this.findFilters = [];
    this.findByIdAndUpdateCalls = [];
    this.countFilters = [];
    this.aggregatePipelines = [];
  }

  async create(input, options) {
    const rows = Array.isArray(input) ? input : [input];
    const docs = rows.map((row) => {
      const stored = { _id: row._id ?? `row-${this.rows.length + 1}`, ...row };
      this.rows.push(stored);
      this.created.push({ input: stored, options });
      return { toObject: () => ({ ...stored }) };
    });
    return Array.isArray(input) ? docs : docs[0];
  }

  find(filter) {
    this.findFilters.push(filter);
    return new FakeQuery(this.rows.filter((row) => matches(row, filter)).map((row) => ({ ...row })));
  }

  findByIdAndUpdate(id, update, options = {}) {
    this.findByIdAndUpdateCalls.push({ id, update, options });
    const row = this.rows.find((item) => item._id === id);
    if (!row) return new FakeQuery(null);
    Object.assign(row, update.$set ?? {});
    return new FakeQuery({ ...row });
  }

  async countDocuments(filter) {
    this.countFilters.push(filter);
    return this.rows.filter((row) => matches(row, filter)).length;
  }

  aggregate(pipeline) {
    this.aggregatePipelines.push(pipeline);
    const match = pipeline.find((stage) => stage.$match)?.$match ?? {};
    const counts = new Map();
    for (const row of this.rows.filter((item) => matches(item, match))) counts.set(row.opportunityId, (counts.get(row.opportunityId) ?? 0) + 1);
    return Promise.resolve([...counts.entries()].map(([id, count]) => ({ _id: id, count })));
  }
}

class FakeQuery {
  constructor(value) { this.value = value; }
  sort() { return this; }
  limit() { return this; }
  lean() { return Promise.resolve(this.value); }
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const value = getPath(row, key);
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.includes(value);
      if ('$lt' in expected) return value < expected.$lt;
      if ('$ne' in expected) return value !== expected.$ne;
      if ('$exists' in expected) return expected.$exists ? value !== undefined : value === undefined;
    }
    return value === expected;
  });
}

function getPath(row, path) {
  return path.split('.').reduce((value, key) => value?.[key], row);
}

function aiRepository(model, connection) {
  return new AiRepository(model, {}, {}, {}, connection);
}

test('AI run create and list resolve opportunity aliases while preserving user and profile filters', async () => {
  const revisions = [];
  const model = new FakeModel([
    { _id: 'run-canonical', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-canonical', taskType: 'opportunity_analysis', createdAt: new Date('2026-10-01T00:00:00Z') },
    { _id: 'run-other-user', userId: 'user-2', profileId: 'profile-1', opportunityId: 'opp-canonical', taskType: 'opportunity_analysis', createdAt: new Date('2026-10-01T00:00:00Z') },
  ]);
  const repository = aiRepository(model, canonicalConnection(revisions));

  const created = await repository.createRun({ userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-alias', taskType: 'opportunity_analysis', status: 'queued' });
  const listed = await repository.listRuns({ userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-alias', taskType: 'opportunity_analysis' });

  assert.equal(created.opportunityId, 'opp-canonical');
  assert.equal(model.created[0].options.session.id, 'session-1');
  assert.deepEqual(revisions.map((item) => item.filter._id), ['opp-canonical']);
  assert.deepEqual(model.findFilters.at(-1), { userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-canonical', taskType: 'opportunity_analysis' });
  assert.deepEqual(listed.map((item) => item.userId), ['user-1', 'user-1']);
});

test('AI run updates canonicalize only explicit opportunity patches and leave ordinary updates unlinked', async () => {
  const model = new FakeModel([{ _id: 'run-1', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-alias', taskType: 'opportunity_analysis', status: 'queued' }]);
  const repository = aiRepository(model, canonicalConnection());

  const ordinary = await repository.updateRun('run-1', { status: 'running' });
  const relinked = await repository.updateRun('run-1', { opportunityId: 'opp-other-alias', status: 'completed' });

  assert.equal(ordinary.opportunityId, 'opp-alias');
  assert.equal(relinked.opportunityId, 'opp-other-canonical');
  assert.equal(Object.hasOwn(model.findByIdAndUpdateCalls[0].update.$set, 'opportunityId'), false);
  assert.equal(model.findByIdAndUpdateCalls[0].options.session, undefined);
  assert.equal(model.findByIdAndUpdateCalls[1].options.session.id, 'session-1');
});

test('issue report create/list/related/grouped counts resolve aliases without losing admin filters', async () => {
  const revisions = [];
  const model = new FakeModel([
    { _id: 'report-canonical', userId: 'user-1', assignedAdminId: 'admin-1', opportunityId: 'opp-canonical', type: 'money', status: 'Open', comment: 'canonical' },
    { _id: 'report-other-admin', userId: 'user-1', assignedAdminId: 'admin-2', opportunityId: 'opp-canonical', type: 'money', status: 'Open', comment: 'other admin' },
  ]);
  const repository = new IssueReportsRepository(model, canonicalConnection(revisions));

  const created = await repository.create({ userId: 'user-1', assignedAdminId: 'admin-1', opportunityId: 'opp-alias', type: 'money', status: 'Open' });
  const page = await repository.list({ status: 'Open', assignedAdminId: 'admin-1', opportunityId: 'opp-alias', limit: 10 });
  const related = await repository.related('opp-alias', created._id);
  const counts = await repository.groupedCounts(['opp-alias', 'opp-canonical']);

  assert.equal(created.opportunityId, 'opp-canonical');
  assert.equal(model.created[0].options.session.id, 'session-1');
  assert.deepEqual(revisions.map((item) => item.filter._id), ['opp-canonical']);
  assert.deepEqual(model.findFilters[0], { status: 'Open', opportunityId: 'opp-canonical', assignedAdminId: 'admin-1' });
  assert.deepEqual(model.countFilters[0], { status: 'Open', opportunityId: 'opp-canonical', assignedAdminId: 'admin-1' });
  assert.deepEqual(page.items.map((item) => item.assignedAdminId), ['admin-1', 'admin-1']);
  assert.ok(related.every((item) => item.opportunityId === 'opp-canonical' && item._id !== created._id));
  assert.deepEqual(model.aggregatePipelines.at(-1)[0], { $match: { opportunityId: { $in: ['opp-canonical'] } } });
  assert.deepEqual(counts, { 'opp-canonical': 3 });
});

test('issue report updates do not synthesize stale opportunity patches unless opportunityId is explicit', async () => {
  const model = new FakeModel([{ _id: 'report-1', userId: 'user-1', opportunityId: 'opp-alias', type: 'money', status: 'Open' }]);
  const repository = new IssueReportsRepository(model, canonicalConnection());

  const ordinary = await repository.update('report-1', { status: 'In review' });
  const relinked = await repository.update('report-1', { opportunityId: 'opp-other-alias', status: 'Resolved' });

  assert.equal(ordinary.opportunityId, 'opp-alias');
  assert.equal(relinked.opportunityId, 'opp-other-canonical');
  assert.equal(Object.hasOwn(model.findByIdAndUpdateCalls[0].update.$set, 'opportunityId'), false);
  assert.equal(model.findByIdAndUpdateCalls[0].options.session, undefined);
  assert.equal(model.findByIdAndUpdateCalls[1].options.session.id, 'session-1');
});
