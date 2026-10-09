import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { ConflictException } = require('@nestjs/common');
const { CalendarRepository } = require('../src/modules/calendar/calendar.repository.ts');
const { ResponsesRepository } = require('../src/modules/responses/responses.repository.ts');
const { TasksRepository } = require('../src/modules/tasks/tasks.repository.ts');

test('responses create/list resolve merged alias to canonical opportunity inside guarded transaction', async () => {
  const model = new FakeModel();
  const connection = fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical' });
  const repository = new ResponsesRepository(model, connection);

  const created = await repository.create({ userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-alias', format: 'cover_letter' });
  const listed = await repository.list('user-1', { opportunityId: 'opp-alias', profileId: 'profile-1' });

  assert.equal(created.opportunityId, 'opp-canonical');
  assert.equal(model.created[0].options.session.id, 'session-1');
  assert.equal(model.findFilters.at(-1).opportunityId, 'opp-canonical');
  assert.deepEqual(connection.privateReferenceIncrements, ['opp-canonical']);
  assert.equal(listed.length, 1);
});

test('responses update touches canonical transaction without synthesizing opportunity patch', async () => {
  const model = new FakeModel([{ _id: 'draft-1', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-alias', format: 'cover_letter', revision: 2 }]);
  const repository = new ResponsesRepository(model, fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical' }));

  const updated = await repository.updateWithRevision('draft-1', 'user-1', 2, { markdownCache: 'updated' });

  assert.equal(updated.opportunityId, 'opp-alias');
  assert.equal(updated.revision, 3);
  assert.equal(model.findOneAndUpdateCalls[0].options.session.id, 'session-1');
  assert.equal(model.findOneAndUpdateCalls[0].update.$set.opportunityId, undefined);
});


test('response generation writes also canonicalize old alias drafts', async () => {
  const model = new FakeModel([{ _id: 'draft-gen', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-alias', format: 'cover_letter', revision: 4, generation: { runId: 'run-1', status: 'running' } }]);
  const repository = new ResponsesRepository(model, fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical' }));

  const updated = await repository.applyGeneration({
    id: 'draft-gen',
    userId: 'user-1',
    runId: 'run-1',
    documentJson: { type: 'doc', content: [] },
    status: 'completed',
    baseRevision: 4,
  });

  assert.equal(updated.opportunityId, 'opp-alias');
  assert.equal(updated.revision, 5);
  assert.equal(model.findOneAndUpdateCalls[0].options.session.id, 'session-1');
  assert.equal(model.findOneAndUpdateCalls[0].update.$set.opportunityId, undefined);
});

test('tasks create/update/list canonicalize opportunity aliases without changing owner board filters', async () => {
  const taskModel = new FakeModel([{ _id: 'task-1', boardId: 'board-1', reporterId: 'user-1', opportunityId: 'opp-alias', title: 'Follow up' }]);
  const repository = new TasksRepository(new FakeModel(), taskModel, new FakeModel(), fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical' }));

  const created = await repository.createTask({ boardId: 'board-1', reporterId: 'user-1', opportunityId: 'opp-alias', title: 'New follow up' });
  const updated = await repository.updateTask('task-1', { title: 'Updated follow up' });
  await repository.listTasks({ boardIds: ['board-1'], opportunityId: 'opp-alias', assigneeId: 'user-1' });

  assert.equal(created.opportunityId, 'opp-canonical');
  assert.equal(updated.opportunityId, 'opp-alias');
  assert.equal(taskModel.created[0].options.session.id, 'session-1');
  assert.equal(taskModel.findOneAndUpdateCalls[0].options.session.id, 'session-1');
  assert.deepEqual(taskModel.findFilters.at(-1), {
    deletedAt: { $exists: false },
    boardId: { $in: ['board-1'] },
    assigneeId: 'user-1',
    opportunityId: 'opp-canonical',
  });
});


test('tasks update distinguishes omitted opportunity from explicit unlink and relink', async () => {
  const taskModel = new FakeModel([{ _id: 'task-link', boardId: 'board-1', reporterId: 'user-1', opportunityId: 'opp-alias', title: 'Linked' }]);
  const repository = new TasksRepository(new FakeModel(), taskModel, new FakeModel(), fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical', otherAlias: 'opp-other-alias', otherCanonical: 'opp-other-canonical' }));

  const canonicalized = await repository.updateTask('task-link', { title: 'Keep current link' });
  const unlinked = await repository.updateTask('task-link', { opportunityId: null, title: 'Unlinked' });
  const relinked = await repository.updateTask('task-link', { opportunityId: 'opp-other-alias', title: 'Relinked' });

  assert.equal(canonicalized.opportunityId, 'opp-alias');
  assert.equal(unlinked.opportunityId, null);
  assert.equal(relinked.opportunityId, 'opp-other-canonical');
  assert.deepEqual(taskModel.findOneAndUpdateCalls.map((call) => Object.prototype.hasOwnProperty.call(call.update.$set, 'opportunityId') ? call.update.$set.opportunityId : '<omitted>'), ['<omitted>', null, 'opp-other-canonical']);
  assert.equal(taskModel.findOneAndUpdateCalls[1].options.session, undefined);
});

test('calendar update distinguishes omitted opportunity from explicit unlink and relink', async () => {
  const model = new FakeModel([{ _id: 'event-link', userId: 'user-1', opportunityId: 'opp-alias', title: 'Linked', startAt: new Date('2026-10-02T10:00:00.000Z') }]);
  const repository = new CalendarRepository(model, fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical', otherAlias: 'opp-other-alias', otherCanonical: 'opp-other-canonical' }));

  const canonicalized = await repository.update('event-link', { title: 'Keep current link' });
  const unlinked = await repository.update('event-link', { opportunityId: '', title: 'Unlinked' });
  const relinked = await repository.update('event-link', { opportunityId: 'opp-other-alias', title: 'Relinked' });

  assert.equal(canonicalized.opportunityId, 'opp-alias');
  assert.equal(unlinked.opportunityId, '');
  assert.equal(relinked.opportunityId, 'opp-other-canonical');
  assert.deepEqual(model.findOneAndUpdateCalls.map((call) => Object.prototype.hasOwnProperty.call(call.update.$set, 'opportunityId') ? call.update.$set.opportunityId : '<omitted>'), ['<omitted>', '', 'opp-other-canonical']);
  assert.equal(model.findOneAndUpdateCalls[1].options.session, undefined);
});

test('calendar create/update canonicalize linked opportunity aliases in the same transaction', async () => {
  const model = new FakeModel([{ _id: 'event-1', userId: 'user-1', opportunityId: 'opp-alias', title: 'Call', startAt: new Date('2026-10-02T10:00:00.000Z') }]);
  const repository = new CalendarRepository(model, fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical' }));

  const created = await repository.create({ userId: 'user-1', opportunityId: 'opp-alias', title: 'New call', startAt: new Date('2026-10-03T10:00:00.000Z') });
  const updated = await repository.update('event-1', { title: 'Renamed call' });

  assert.equal(created.opportunityId, 'opp-canonical');
  assert.equal(updated.opportunityId, 'opp-alias');
  assert.equal(model.created[0].options.session.id, 'session-1');
  assert.equal(model.findOneAndUpdateCalls[0].options.session.id, 'session-1');
});

class FakeModel {
  constructor(rows = []) {
    this.rows = rows.map((row) => ({ ...row }));
    this.created = [];
    this.findFilters = [];
    this.findOneAndUpdateCalls = [];
    this.throwDuplicateOnCanonicalUpdate = false;
  }

  async create(input, options) {
    if (Array.isArray(input)) {
      return input.map((item) => this.insert(item, options));
    }
    return this.insert(input, options);
  }

  find(filter) {
    this.findFilters.push(filter);
    return new FakeQuery(this.rows.filter((row) => matches(row, filter)).map((row) => ({ ...row })));
  }

  findOne(filter) {
    return new FakeQuery(this.rows.find((row) => matches(row, filter)) ?? null);
  }

  findOneAndUpdate(filter, update, options = {}) {
    this.findOneAndUpdateCalls.push({ filter, update, options });
    if (this.throwDuplicateOnCanonicalUpdate && update?.$set?.opportunityId === 'opp-canonical') {
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    }
    const row = this.rows.find((item) => matches(item, filter));
    if (!row) return new FakeQuery(null);
    Object.assign(row, update.$set ?? {});
    if (update.$inc) {
      for (const [key, value] of Object.entries(update.$inc)) row[key] = (row[key] ?? 0) + value;
    }
    return new FakeQuery({ ...row });
  }

  updateOne(filter, update) {
    const row = this.rows.find((item) => matches(item, filter));
    if (row) Object.assign(row, update.$set ?? {});
    return { matchedCount: row ? 1 : 0 };
  }

  insert(input, options) {
    const row = { _id: input._id ?? `row-${this.rows.length + 1}`, ...input };
    this.rows.push(row);
    this.created.push({ input: row, options });
    return { toObject: () => ({ ...row }) };
  }
}

class FakeQuery {
  constructor(value) {
    this.value = value;
  }
  sort() { return this; }
  lean() { return Promise.resolve(this.value); }
}

function fakeConnection({ alias, canonical, otherAlias, otherCanonical }) {
  const opportunities = new Map([
    [alias, { _id: alias, mergedIntoOpportunityId: canonical }],
    [canonical, { _id: canonical }],
  ]);
  if (otherAlias && otherCanonical) {
    opportunities.set(otherAlias, { _id: otherAlias, mergedIntoOpportunityId: otherCanonical });
    opportunities.set(otherCanonical, { _id: otherCanonical });
  }
  const connection = {
    privateReferenceIncrements: [],
    db: {
      collection(name) {
        assert.equal(name, 'opportunities');
        return {
          findOne: async (filter) => opportunities.get(filter._id) ?? null,
          updateOne: async (filter, update) => {
            if (filter._id === canonical && update?.$inc?.privateReferenceRevision === 1) connection.privateReferenceIncrements.push(filter._id);
            return { matchedCount: opportunities.has(filter._id) ? 1 : 0 };
          },
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
  return connection;
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((item) => matches(row, item));
    const value = getPath(row, key);
    if (expected && typeof expected === 'object' && '$exists' in expected) return expected.$exists ? value !== undefined : value === undefined;
    if (expected && typeof expected === 'object' && '$in' in expected) return expected.$in.includes(value);
    return value === expected;
  });
}

function getPath(row, key) {
  return key.split('.').reduce((value, part) => value?.[part], row);
}
