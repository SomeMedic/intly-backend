import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const mongoose = require('mongoose');
const { SourcesRepository, isSourceActiveRunConflict } = require('../src/modules/sources/sources.repository.ts');
const { SourceRun, SourceRunSchema, SOURCE_RUN_ACTIVE_COLLECTION_INDEX, SOURCE_RUN_ACTIVE_COLLECTION_INDEX_KEY, SOURCE_RUN_ACTIVE_COLLECTION_INDEX_OPTIONS, SOURCE_RUN_COLLECTION_TYPES } = require('../src/modules/sources/schemas/source-run.schema.ts');

const ACTIVE_FILTER = { status: { $in: ['Queued', 'Running'] }, runType: { $in: SOURCE_RUN_COLLECTION_TYPES } };

class CountingSourceModel {
  constructor() {
    this.updateCount = 0;
  }

  async updateOne() {
    this.updateCount += 1;
    return { acknowledged: true };
  }
}

function runInput(sourceId, overrides = {}) {
  return {
    sourceId,
    runType: 'scheduled',
    status: 'Queued',
    checkpointBefore: {},
    ...overrides,
  };
}

function testMongoUri() {
  const base = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/intly';
  const url = new URL(base);
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol)) throw new Error(`source-run concurrency test refuses MongoDB protocol ${url.protocol}`);
  if (!loopback) throw new Error(`source-run concurrency test refuses non-loopback MongoDB host ${host}`);
  url.pathname = `/intly_source_run_concurrency_${process.pid}_${Date.now()}`;
  url.searchParams.set('serverSelectionTimeoutMS', '800');
  return url.toString();
}

function autoIndexFalseRunModel(connection) {
  const schema = SourceRunSchema.clone();
  schema.set('autoIndex', false);
  schema.set('autoCreate', false);
  return connection.model(`${SourceRun.name}_AutoIndexFalse_${Date.now()}_${Math.random().toString(16).slice(2)}`, schema, `source_runs_autoindex_false_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function withRunRepository(t) {
  const uri = testMongoUri();
  let connection;
  try {
    connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 800 }).asPromise();
  } catch (error) {
    t.skip(`local Mongo unavailable for atomic race proof: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  t.after(async () => {
    await connection.dropDatabase().catch(() => undefined);
    await connection.close().catch(() => undefined);
  });
  const collectionName = `source_runs_concurrency_${Date.now()}`;
  const RunModel = connection.model(`${SourceRun.name}_${Date.now()}`, SourceRunSchema, collectionName);
  await RunModel.init();
  return {
    repository: new SourcesRepository({}, RunModel, {}),
    RunModel,
    collectionName,
    uri,
  };
}

test('SourceRun schema declares one named partial unique active collection run index per source', () => {
  const indexes = SourceRunSchema.indexes();
  const active = indexes.find(([, options]) => options?.name === SOURCE_RUN_ACTIVE_COLLECTION_INDEX);
  assert.ok(active, 'active partial unique index is declared');
  assert.deepEqual(active[0], { sourceId: 1 });
  assert.equal(active[1].unique, true);
  assert.deepEqual(active[1].partialFilterExpression, ACTIVE_FILTER);
});

test('isSourceActiveRunConflict accepts only the named sourceId duplicate-key index', () => {
  assert.equal(isSourceActiveRunConflict({ code: 11000, index: SOURCE_RUN_ACTIVE_COLLECTION_INDEX, keyPattern: { sourceId: 1 } }), true);
  assert.equal(isSourceActiveRunConflict({ code: 11000, errmsg: `E11000 duplicate key error collection: test index: ${SOURCE_RUN_ACTIVE_COLLECTION_INDEX} dup key`, keyPattern: { sourceId: 1 } }), true);
  assert.equal(isSourceActiveRunConflict({ code: 11000, index: SOURCE_RUN_ACTIVE_COLLECTION_INDEX, keyPattern: { sourceId: 1, status: 1 } }), true);
  assert.equal(isSourceActiveRunConflict({ code: 11000, index: 'other_index', keyPattern: { sourceId: 1 } }), false);
  assert.equal(isSourceActiveRunConflict({ code: 11000, index: SOURCE_RUN_ACTIVE_COLLECTION_INDEX, keyPattern: { status: 1 } }), false);
  assert.equal(isSourceActiveRunConflict({ code: 50, index: SOURCE_RUN_ACTIVE_COLLECTION_INDEX, keyPattern: { sourceId: 1 } }), false);
  assert.equal(isSourceActiveRunConflict(new Error('network')), false);
});

test('local Mongo enforces one active collection run per source and retains terminal history', async (t) => {
  const fixture = await withRunRepository(t);
  if (!fixture) return;
  const { repository } = fixture;

  const sameSourceCreates = await Promise.allSettled([
    repository.createRun(runInput('source-a')),
    repository.createRun(runInput('source-a', { runType: 'manual' })),
  ]);
  assert.equal(sameSourceCreates.filter((result) => result.status === 'fulfilled').length, 1);
  const rejectedCreate = sameSourceCreates.find((result) => result.status === 'rejected');
  assert.ok(rejectedCreate && isSourceActiveRunConflict(rejectedCreate.reason));

  await repository.createRun(runInput('source-a', { runType: 'health' }));
  await repository.createRun(runInput('source-b'));
  await repository.createRun(runInput('source-c'));

  const active = await repository.findActiveRun('source-a');
  assert.equal(active.sourceId, 'source-a');
  assert.notEqual(active.runType, 'health');

  await repository.updateRun(active._id, { status: 'Succeeded', finishedAt: new Date() });
  await repository.createRun(runInput('source-a', { status: 'Failed', error: 'old failed run' }));
  await repository.createRun(runInput('source-a', { status: 'Cancelled', requestedStopAt: new Date() }));
  await repository.createRun(runInput('source-a', { status: 'Succeeded', finishedAt: new Date() }));

  const activeAfterTerminal = await repository.findActiveRun('source-a');
  assert.equal(activeAfterTerminal, null);
  const latest = await repository.latestCollectionRun('source-a');
  assert.equal(latest.sourceId, 'source-a');
  assert.notEqual(latest.runType, 'health');
});

test('local Mongo startRun returns null when another active run wins the source slot', async (t) => {
  const fixture = await withRunRepository(t);
  if (!fixture) return;
  const { repository, RunModel } = fixture;
  const oldFailed = await repository.createRun(runInput('source-race', { status: 'Failed', error: 'retry me', createdAt: new Date('2026-10-04T00:00:00.000Z') }));
  await repository.createRun(runInput('source-race', { status: 'Queued' }));

  const started = await repository.startRun(oldFailed._id);
  assert.equal(started, null);
  const failedStillFailed = await RunModel.findById(oldFailed._id).lean();
  assert.equal(failedStillFailed.status, 'Failed');
});


test('local Mongo concurrent failed-run claims cannot both become active', async (t) => {
  const fixture = await withRunRepository(t);
  if (!fixture) return;
  const { repository, RunModel } = fixture;
  const first = await repository.createRun(runInput('source-claim', { status: 'Failed', error: 'retry one' }));
  const second = await repository.createRun(runInput('source-claim', { status: 'Failed', error: 'retry two' }));

  const claims = await Promise.all([repository.startRun(first._id), repository.startRun(second._id)]);
  assert.equal(claims.filter(Boolean).length, 1);

  const activeCount = await RunModel.countDocuments({ sourceId: 'source-claim', status: 'Running', runType: { $in: SOURCE_RUN_COLLECTION_TYPES } });
  assert.equal(activeCount, 1);
});


test('local Mongo ensureCatalog installs the active-run index with autoIndex false and keeps other indexes', async (t) => {
  const uri = testMongoUri();
  let connection;
  try {
    connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 800 }).asPromise();
  } catch (error) {
    t.skip(`local Mongo unavailable for explicit index proof: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  t.after(async () => {
    await connection.dropDatabase().catch(() => undefined);
    await connection.close().catch(() => undefined);
  });
  const RunModel = autoIndexFalseRunModel(connection);
  await RunModel.collection.createIndex({ runType: 1 }, { name: 'non_owned_run_type_index' });
  let indexes = await RunModel.collection.indexes();
  assert.equal(indexes.some((index) => index.name === SOURCE_RUN_ACTIVE_COLLECTION_INDEX), false);

  const sourceModel = new CountingSourceModel();
  const repository = new SourcesRepository(sourceModel, RunModel, {});
  await repository.ensureCatalog();
  await repository.ensureCatalog();

  indexes = await RunModel.collection.indexes();
  const active = indexes.find((index) => index.name === SOURCE_RUN_ACTIVE_COLLECTION_INDEX);
  assert.ok(active, 'active-run index must be explicitly installed by ensureCatalog');
  assert.deepEqual(active.key, SOURCE_RUN_ACTIVE_COLLECTION_INDEX_KEY);
  assert.equal(active.unique, true);
  assert.deepEqual(active.partialFilterExpression, SOURCE_RUN_ACTIVE_COLLECTION_INDEX_OPTIONS.partialFilterExpression);
  assert.ok(indexes.some((index) => index.name === 'non_owned_run_type_index'), 'non-owned index is retained');
  assert.equal(sourceModel.updateCount, 206);
});

test('local Mongo ensureCatalog fails before catalog updates when existing active duplicates block the index', async (t) => {
  const uri = testMongoUri();
  let connection;
  try {
    connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 800 }).asPromise();
  } catch (error) {
    t.skip(`local Mongo unavailable for duplicate preflight proof: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  t.after(async () => {
    await connection.dropDatabase().catch(() => undefined);
    await connection.close().catch(() => undefined);
  });
  const RunModel = autoIndexFalseRunModel(connection);
  await RunModel.collection.insertMany([
    runInput('dupe-source', { _id: 'dupe-1', status: 'Queued', runType: 'scheduled' }),
    runInput('dupe-source', { _id: 'dupe-2', status: 'Running', runType: 'backfill' }),
  ]);
  const sourceModel = new CountingSourceModel();
  const repository = new SourcesRepository(sourceModel, RunModel, {});

  await assert.rejects(() => repository.ensureCatalog(), (error) => error?.code === 11000 || /duplicate key/i.test(String(error?.message ?? error)));
  assert.equal(sourceModel.updateCount, 0);
});
