import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { FilesRepository } = require('../src/modules/files/files.repository.ts');
const { NotificationsRepository } = require('../src/modules/notifications/notifications.repository.ts');

test('file creates canonicalize metadata opportunity aliases and retain owner metadata', async () => {
  const model = new FakeModel();
  const connection = fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical' });
  const repository = new FilesRepository(model, connection);

  const file = await repository.create({ ownerUserId: 'user-1', originalName: 'spec.pdf', metadata: { opportunityId: 'opp-alias', purpose: 'tender' } });

  assert.equal(file.ownerUserId, 'user-1');
  assert.deepEqual(file.metadata, { opportunityId: 'opp-canonical', purpose: 'tender' });
  assert.equal(model.created[0].options.session.id, 'session-1');
  assert.deepEqual(connection.privateReferenceIncrements, ['opp-canonical']);
});

test('file updates only canonicalize explicit metadata opportunity links', async () => {
  const model = new FakeModel([{ _id: 'file-1', ownerUserId: 'user-1', originalName: 'old.pdf', metadata: { opportunityId: 'opp-alias', purpose: 'existing' } }]);
  const connection = fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical', otherAlias: 'opp-other-alias', otherCanonical: 'opp-other-canonical' });
  const repository = new FilesRepository(model, connection);

  const renamed = await repository.update('file-1', { originalName: 'renamed.pdf' });
  const relinked = await repository.update('file-1', { metadata: { opportunityId: 'opp-other-alias', purpose: 'updated' } });

  assert.equal(renamed.metadata.opportunityId, 'opp-alias');
  assert.deepEqual(model.findOneAndUpdateCalls[0].update.$set, { originalName: 'renamed.pdf' });
  assert.equal(model.findOneAndUpdateCalls[0].options.session, undefined);
  assert.deepEqual(relinked.metadata, { opportunityId: 'opp-other-canonical', purpose: 'updated' });
  assert.equal(model.findOneAndUpdateCalls[1].options.session.id, 'session-1');
  assert.deepEqual(connection.privateReferenceIncrements, ['opp-other-canonical']);
});

test('notification creates canonicalize data opportunity aliases and retain user payload', async () => {
  const model = new FakeModel();
  const connection = fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical' });
  const repository = new NotificationsRepository(model, connection);

  const notification = await repository.create({ userId: 'user-1', title: 'New match', type: 'watchlist.match', category: 'opportunity', data: { opportunityId: 'opp-alias', hitId: 'hit-1' } });

  assert.equal(notification.userId, 'user-1');
  assert.equal(notification.category, 'opportunity');
  assert.deepEqual(notification.data, { opportunityId: 'opp-canonical', hitId: 'hit-1' });
  assert.equal(model.created[0].options.session.id, 'session-1');
  assert.deepEqual(connection.privateReferenceIncrements, ['opp-canonical']);
});

test('notification idempotent duplicate lookup happens after failed canonical create without changing idempotency semantics', async () => {
  const existing = { _id: 'notification-existing', userId: 'user-1', idempotencyKey: 'idem-1', title: 'Existing', type: 'watchlist.match', category: 'opportunity', data: { opportunityId: 'opp-canonical', hitId: 'hit-1' } };
  const model = new FakeModel([existing], { throwDuplicateOnFirstCreate: true });
  const repository = new NotificationsRepository(model, fakeConnection({ alias: 'opp-alias', canonical: 'opp-canonical' }));

  const result = await repository.createIdempotent({ userId: 'user-1', idempotencyKey: 'idem-1', title: 'New match', type: 'watchlist.match', category: 'opportunity', data: { opportunityId: 'opp-alias', hitId: 'hit-1' } });

  assert.equal(result.created, false);
  assert.equal(result.notification._id, 'notification-existing');
  assert.equal(model.createAttempts, 1);
  assert.deepEqual(model.findOneCalls[0], { userId: 'user-1', idempotencyKey: 'idem-1', deletedAt: { $exists: false } });
});

class FakeModel {
  constructor(rows = [], options = {}) {
    this.rows = rows.map((row) => ({ ...row }));
    this.options = options;
    this.created = [];
    this.createAttempts = 0;
    this.findOneCalls = [];
    this.findOneAndUpdateCalls = [];
  }

  async create(input, options) {
    this.createAttempts += 1;
    if (this.options.throwDuplicateOnFirstCreate && this.createAttempts === 1) {
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    }
    const rows = Array.isArray(input) ? input : [input];
    const documents = rows.map((row) => this.insert(row, options));
    return Array.isArray(input) ? documents : documents[0];
  }

  findOne(filter) {
    this.findOneCalls.push(filter);
    return new FakeQuery(this.rows.find((row) => matches(row, filter)) ?? null);
  }

  findOneAndUpdate(filter, update, options = {}) {
    this.findOneAndUpdateCalls.push({ filter, update, options });
    const row = this.rows.find((item) => matches(item, filter));
    if (!row) return new FakeQuery(null);
    Object.assign(row, update.$set ?? {});
    return new FakeQuery({ ...row });
  }

  insert(input, options) {
    const row = { _id: input._id ?? `row-${this.rows.length + 1}`, ...input };
    this.rows.push(row);
    this.created.push({ input: row, options });
    return { toObject: () => ({ ...row }) };
  }
}

class FakeQuery {
  constructor(value) { this.value = value; }
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
            if (update?.$inc?.privateReferenceRevision === 1) connection.privateReferenceIncrements.push(filter._id);
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
    const value = getPath(row, key);
    if (expected && typeof expected === 'object' && '$exists' in expected) return expected.$exists ? value !== undefined : value === undefined;
    return value === expected;
  });
}

function getPath(row, key) {
  return key.split('.').reduce((value, part) => value?.[part], row);
}
