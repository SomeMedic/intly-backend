import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const mongoose = require('mongoose');
const { SourcesRepository } = require('../src/modules/sources/sources.repository.ts');
const { SourceRun, SourceRunSchema } = require('../src/modules/sources/schemas/source-run.schema.ts');
const { SourcesService } = require('../src/modules/sources/sources.service.ts');

const NOW = Date.now();
const STALE = new Date(NOW - 10 * 60 * 1000);
const FRESH = new Date(NOW - 60 * 1000);

function responseCode(error) {
  const response = typeof error?.getResponse === 'function' ? error.getResponse() : undefined;
  return response && typeof response === 'object' ? response.code : undefined;
}

function source(overrides = {}) {
  return {
    _id: 'source-1',
    enabled: true,
    runtimeState: 'Enabled',
    connectorFamily: 'OfficialRestApi',
    checkpoint: { cursor: 'source-checkpoint' },
    endpoint: {},
    config: {},
    limits: { maxPages: 5 },
    timeoutMs: 30_000,
    intervalSeconds: 3600,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    _id: 'run-1',
    sourceId: 'source-1',
    runType: 'manual',
    status: 'Running',
    checkpointBefore: { cursor: 'before' },
    checkpointAfter: { cursor: 'after', hasMore: true },
    stats: { seen: 10, normalized: 9, upserted: 8, failed: 1 },
    requestMetadata: { backfillDays: 30, backfillSince: '2026-09-06T00:00:00.000Z', pendingIngest: { preserved: true } },
    error: 'previous error is retained',
    updatedAt: STALE,
    ...overrides,
  };
}

class InMemoryRecoveryRepository {
  constructor(currentSource, currentRun) {
    this.source = structuredClone(currentSource);
    this.runs = new Map([[currentRun._id, structuredClone(currentRun)]]);
    this.recoverCalls = 0;
  }

  async get(id) {
    assert.equal(id, this.source._id);
    return structuredClone(this.source);
  }

  async getRun(id) {
    return structuredClone(this.runs.get(id));
  }

  async recoverActiveRunToQueued(expected) {
    this.recoverCalls += 1;
    const current = this.runs.get(expected._id);
    if (!current) return null;
    if (
      current.sourceId !== expected.sourceId ||
      current.runType !== expected.runType ||
      current.status !== expected.status ||
      current.requestedStopAt ||
      current.updatedAt.getTime() !== expected.updatedAt.getTime()
    ) {
      return null;
    }
    current.status = 'Queued';
    current.updatedAt = new Date(NOW);
    return structuredClone(current);
  }
}

function jobs({ pending = [], queueThrows = false, enqueueThrows = false, noGetJobs = false } = {}) {
  const enqueued = [];
  const queue = {
    getJobSchedulers: async () => [],
    removeJobScheduler: async () => true,
    upsertJobScheduler: async () => undefined,
  };
  if (!noGetJobs) {
    queue.getJobs = async ([state], start, end) => {
      if (queueThrows) throw new Error('queue unavailable');
      return pending.filter((item) => item.state === state).slice(start, end + 1);
    };
  }
  const service = {
    registerHandler: () => undefined,
    enqueue: async (queue, name, data, options) => {
      if (enqueueThrows) throw new Error('redis unavailable');
      enqueued.push({ queue, name, data, options });
      return { id: `job-${enqueued.length}`, queue };
    },
    queue: () => queue,
  };
  return { service, enqueued };
}

function makeService({ currentSource = source(), currentRun = run(), jobOptions, audit = [] } = {}) {
  const repository = new InMemoryRecoveryRepository(currentSource, currentRun);
  const jobFixture = jobs(jobOptions);
  const service = new SourcesService(
    repository,
    { get: () => ({ capabilities: () => ({}), validateConfig: async () => ({ ok: true }) }) },
    { normalize: (_source, item) => item },
    { collapseBatch: (items) => ({ records: items, duplicates: 0 }) },
    { encrypt: JSON.stringify, decrypt: JSON.parse },
    { record: async (_actor, action, entityType, entityId, fields) => audit.push({ action, entityType, entityId, fields }) },
    jobFixture.service,
    { publish: () => undefined },
    { ingestFromSource: async () => ({ seen: 0, normalized: 0, upserted: 0, created: 0, updated: 0, duplicates: 0, failed: 0, opportunityIds: [], failures: [] }) },
  );
  return { service, repository, enqueued: jobFixture.enqueued, audit };
}

test('recoverRun refuses when the same source or run still has a pending ingestion job', async () => {
  for (const pending of [
    [{ id: 'active-source', name: 'source.fetchPage', state: 'active', data: { sourceId: 'source-1' } }],
    [{ id: 'waiting-source', name: 'source.fetchPage', state: 'waiting', data: { sourceId: 'source-1' } }],
    [{ id: 'delayed-run', name: 'source.fetchPage', state: 'delayed', data: { runId: 'run-1', sourceId: 'other-source' } }],
  ]) {
    const { service, repository } = makeService({ jobOptions: { pending } });
    await assert.rejects(() => service.recoverRun({ id: 'admin', role: 'Admin' }, 'run-1'), (error) => responseCode(error) === 'SOURCE_RUN_RECOVERY_BUSY');
    assert.equal(repository.recoverCalls, 0);
  }
});

test('recoverRun validates staleness, timestamp, stop, terminal, refresh, source state, and queue inspection', async () => {
  const cases = [
    { patch: { updatedAt: FRESH }, code: 'SOURCE_RUN_RECOVERY_FRESH' },
    { patch: { updatedAt: 'not-a-date' }, code: 'SOURCE_RUN_RECOVERY_INELIGIBLE' },
    { patch: { requestedStopAt: STALE }, code: 'SOURCE_RUN_RECOVERY_INELIGIBLE' },
    { patch: { status: 'Succeeded' }, code: 'SOURCE_RUN_RECOVERY_INELIGIBLE' },
    { patch: { runType: 'health' }, code: 'SOURCE_RUN_RECOVERY_INELIGIBLE' },
    { patch: { requestMetadata: { mode: 'refresh' } }, code: 'SOURCE_RUN_RECOVERY_INELIGIBLE' },
    { sourcePatch: { enabled: false }, code: 'SOURCE_RUN_RECOVERY_SOURCE_DISABLED' },
    { sourcePatch: { runtimeState: 'Disabled' }, code: 'SOURCE_RUN_RECOVERY_SOURCE_DISABLED' },
    { sourcePatch: { runtimeState: 'Maintenance' }, code: 'SOURCE_RUN_RECOVERY_SOURCE_DISABLED' },
    { jobOptions: { queueThrows: true }, code: 'SOURCE_RUN_RECOVERY_QUEUE_UNAVAILABLE' },
    { jobOptions: { noGetJobs: true }, code: 'SOURCE_RUN_RECOVERY_QUEUE_UNAVAILABLE' },
  ];
  for (const item of cases) {
    const { service, repository } = makeService({
      currentSource: source(item.sourcePatch),
      currentRun: run(item.patch),
      jobOptions: item.jobOptions,
    });
    await assert.rejects(() => service.recoverRun({ id: 'admin', role: 'Admin' }, 'run-1'), (error) => responseCode(error) === item.code);
    assert.equal(repository.recoverCalls, item.code === 'SOURCE_RUN_RECOVERY_QUEUE_UNAVAILABLE' ? 0 : 0);
  }
});

test('recoverRun paginates queue inspection before declaring an orphan', async () => {
  const pending = Array.from({ length: 100 }, (_, index) => ({ id: `other-${index}`, name: 'source.fetchPage', state: 'waiting', data: { sourceId: `other-${index}` } }));
  pending.push({ id: 'target-after-first-page', name: 'source.fetchPage', state: 'waiting', data: { sourceId: 'source-1' } });
  const { service, repository } = makeService({ jobOptions: { pending } });

  await assert.rejects(() => service.recoverRun({ id: 'admin', role: 'Admin' }, 'run-1'), (error) => responseCode(error) === 'SOURCE_RUN_RECOVERY_BUSY');

  assert.equal(repository.recoverCalls, 0);
});

test('recoverRun preserves same run data and enqueues a same-run continuation', async () => {
  const audit = [];
  const { service, repository, enqueued } = makeService({ audit });

  const result = await service.recoverRun({ id: 'admin', role: 'Admin' }, 'run-1');

  assert.equal(result.recovered, true);
  assert.equal(result.run._id, 'run-1');
  assert.equal(result.run.status, 'Queued');
  assert.deepEqual(result.run.checkpointAfter, { cursor: 'after', hasMore: true });
  assert.deepEqual(result.run.stats, { seen: 10, normalized: 9, upserted: 8, failed: 1 });
  assert.deepEqual(result.run.requestMetadata, { backfillDays: 30, backfillSince: '2026-09-06T00:00:00.000Z', pendingIngest: { preserved: true } });
  assert.equal(result.run.error, 'previous error is retained');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].queue, 'ingestion');
  assert.equal(enqueued[0].name, 'source.fetchPage');
  assert.deepEqual(enqueued[0].data, { runId: 'run-1', sourceId: 'source-1', backfillDays: 30 });
  assert.match(enqueued[0].options.jobId, /^source:source-1:run:run-1:continue:/);
  assert.deepEqual(audit, [{ action: 'source.run.recover', entityType: 'source', entityId: 'source-1', fields: ['runId'] }]);
  assert.equal(repository.runs.get('run-1').status, 'Queued');
});

test('recoverRun reports enqueue failure while leaving the run queued for a later retry', async () => {
  const { service, repository, enqueued } = makeService({ jobOptions: { enqueueThrows: true } });

  await assert.rejects(() => service.recoverRun({ id: 'admin', role: 'Admin' }, 'run-1'), (error) => responseCode(error) === 'SOURCE_RUN_RECOVERY_ENQUEUE_FAILED');

  assert.equal(enqueued.length, 0);
  assert.equal(repository.runs.get('run-1').status, 'Queued');
  assert.deepEqual(repository.runs.get('run-1').checkpointAfter, { cursor: 'after', hasMore: true });
});

test('recoverRun returns changed when another caller already claimed the exact run timestamp', async () => {
  const { service, repository } = makeService();
  const original = await repository.getRun('run-1');
  repository.recoverActiveRunToQueued = async (expected) => {
    const current = repository.runs.get(expected._id);
    current.updatedAt = new Date(NOW - 1000);
    if (expected.updatedAt.getTime() !== current.updatedAt.getTime()) return null;
    return structuredClone(current);
  };
  assert.equal(original.updatedAt.getTime(), STALE.getTime());

  await assert.rejects(() => service.recoverRun({ id: 'admin', role: 'Admin' }, 'run-1'), (error) => responseCode(error) === 'SOURCE_RUN_RECOVERY_CHANGED');
});

function testMongoUri() {
  const base = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/intly';
  const url = new URL(base);
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol)) throw new Error(`source orphan recovery test refuses MongoDB protocol ${url.protocol}`);
  if (!loopback) throw new Error(`source orphan recovery test refuses non-loopback MongoDB host ${host}`);
  url.pathname = `/intly_source_orphan_recovery_${process.pid}_${Date.now()}`;
  url.searchParams.set('serverSelectionTimeoutMS', '800');
  return url.toString();
}

test('local Mongo recoverActiveRunToQueued lets exactly one racing caller win', async (t) => {
  let connection;
  try {
    connection = await mongoose.createConnection(testMongoUri(), { serverSelectionTimeoutMS: 800 }).asPromise();
  } catch (error) {
    t.skip(`local Mongo unavailable for recovery CAS proof: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  t.after(async () => {
    await connection.dropDatabase().catch(() => undefined);
    await connection.close().catch(() => undefined);
  });
  const RunModel = connection.model(`${SourceRun.name}_${Date.now()}`, SourceRunSchema, `source_runs_orphan_recovery_${Date.now()}`);
  await RunModel.init();
  const repository = new SourcesRepository({}, RunModel, {});
  const created = await repository.createRun({
    sourceId: 'source-race',
    runType: 'manual',
    status: 'Running',
    checkpointBefore: { cursor: 'before' },
    checkpointAfter: { cursor: 'after', hasMore: true },
    requestMetadata: { backfillDays: 30 },
    stats: { seen: 3 },
  });
  await RunModel.updateOne({ _id: created._id }, { $set: { updatedAt: STALE } }, { timestamps: false });
  const stale = await repository.getRun(created._id);

  const results = await Promise.all([
    repository.recoverActiveRunToQueued(stale),
    repository.recoverActiveRunToQueued(stale),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  const stored = await repository.getRun(created._id);
  assert.equal(stored.status, 'Queued');
  assert.deepEqual(stored.checkpointAfter, { cursor: 'after', hasMore: true });
  assert.deepEqual(stored.requestMetadata, { backfillDays: 30 });
  assert.deepEqual(stored.stats, { seen: 3 });
});
