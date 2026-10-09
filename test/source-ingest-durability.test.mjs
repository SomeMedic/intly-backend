import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { ServiceUnavailableException } = require('@nestjs/common');
const { SourcesService } = require('../src/modules/sources/sources.service.ts');
const { OpportunitiesIngestAdapter } = require('../src/modules/sources/ingestion/opportunities-ingest.adapter.ts');

class InMemorySourceRepository {
  constructor(source) {
    this.source = { ...source };
    this.runs = new Map();
    this.dlq = [];
    this.health = [];
  }

  async get(id) {
    assert.equal(id, this.source._id);
    return structuredClone(this.source);
  }

  async update(id, patch) {
    assert.equal(id, this.source._id);
    this.source = { ...this.source, ...patch };
    return structuredClone(this.source);
  }

  async createRun(input) {
    const run = { _id: input._id ?? crypto.randomUUID(), stats: {}, checkpointAfter: {}, requestMetadata: {}, ...input };
    this.runs.set(run._id, run);
    return structuredClone(run);
  }

  async getRun(id) {
    return structuredClone(this.runs.get(id));
  }

  async startRun(id) {
    const run = this.runs.get(id);
    if (!run || !['Queued', 'Failed'].includes(run.status) || run.requestedStopAt) return null;
    Object.assign(run, { status: 'Running', startedAt: new Date(), error: undefined, finishedAt: undefined });
    return structuredClone(run);
  }

  async updateRun(id, patch) {
    const run = this.runs.get(id);
    Object.assign(run, patch);
    return structuredClone(run);
  }

  async finishRunIfNotStopped(id, patch) {
    const run = this.runs.get(id);
    if (run.status === 'Running' && !run.requestedStopAt) Object.assign(run, patch);
    return structuredClone(run);
  }

  async requestStop(id) {
    return this.updateRun(id, { requestedStopAt: new Date(), status: 'Cancelled' });
  }

  async updateCheckpoint(id, checkpoint) {
    assert.equal(id, this.source._id);
    this.source = { ...this.source, checkpoint };
  }

  async updateHealth(_id, patch) {
    this.health.push(patch);
  }

  async createDlq(input) {
    this.dlq.push({ status: 'Open', ...input });
    return input;
  }

  async recoverRunDlq(runId) {
    const run = this.runs.get(runId);
    assert.equal(run.status, 'Succeeded');
    assert.equal(run.requestMetadata.pendingIngest, undefined);
    let recovered = 0;
    for (const entry of this.dlq) if (entry.runId === runId && entry.sourceId === run.sourceId && entry.status === 'Open') {
      entry.status = 'Recovered';
      entry.recoveredAt = new Date();
      recovered += 1;
    }
    return recovered;
  }
}

function source(overrides = {}) {
  return {
    _id: 'source-1',
    enabled: true,
    runtimeState: 'Enabled',
    checkpoint: {},
    connectorFamily: 'OfficialRestApi',
    endpoint: {},
    config: {},
    limits: { perPage: 50, maxPages: 5 },
    timeoutMs: 30_000,
    ...overrides,
  };
}

function normalizedRecord(id, overrides = {}) {
  const now = new Date('2026-10-04T12:00:00.000Z');
  return {
    type: 'vacancy',
    title: `Record ${id}`,
    companyOrClient: 'Acme',
    description: `Description ${id}`,
    skills: [],
    technologies: [],
    money: {},
    sourceStatus: 'Active',
    sourceOccurrences: [{
      sourceId: 'source-1',
      externalId: id,
      url: `https://example.test/${id}`,
      primary: true,
      firstSeenAt: now,
      lastSeenAt: now,
      status: 'Active',
      rawPayload: { id },
      sourceMetadata: {},
    }],
    canonicalTags: [],
    vacancyData: {},
    freelanceData: {},
    tenderData: {},
    fingerprint: id,
    ...overrides,
  };
}

function makeService(repository, connector, ingestOverride, jobsOverride) {
  const enqueued = [];
  const service = new SourcesService(
    repository,
    { get: () => connector },
    { normalize: (_source, item) => item },
    { collapseBatch: (items) => ({ records: items, duplicates: 0 }) },
    { encrypt: JSON.stringify, decrypt: JSON.parse },
    { record: async () => undefined },
    jobsOverride ?? {
      registerHandler: () => undefined,
      enqueue: async (queue, name, data, options) => {
        enqueued.push({ queue, name, data, options });
        return { id: `job-${enqueued.length}`, queue };
      },
      queue: () => ({ add: async () => undefined }),
    },
    { publish: () => undefined },
    ingestOverride,
  );
  return { service, enqueued };
}

function successResult(records, overrides = {}) {
  return {
    seen: records.length,
    normalized: records.length,
    upserted: records.length,
    created: records.length,
    updated: 0,
    duplicates: 0,
    failed: 0,
    opportunityIds: records.map((item) => `opp-${item.sourceOccurrences[0].externalId}`),
    failures: [],
    ...overrides,
  };
}

test('opportunities ingest adapter exposes indexed failures and classifies queue backpressure', async () => {
  const service = {
    calls: 0,
    async ingestOrUpsert(input) {
      this.calls += 1;
      if (input.externalId === 'backpressure') {
        throw new ServiceUnavailableException({ code: 'QUEUE_BACKPRESSURE', message: 'Queue is temporarily at capacity' });
      }
      if (input.externalId === 'invalid') throw new Error('invalid source record');
      return { opportunity: { _id: `opp-${input.externalId}` }, created: true };
    },
  };
  const adapter = new OpportunitiesIngestAdapter(service);

  const result = await adapter.ingestFromSource({
    sourceId: 'source-1',
    runId: 'run-1',
    records: [normalizedRecord('ok'), normalizedRecord('backpressure'), normalizedRecord('invalid')],
  });

  assert.equal(result.upserted, 1);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.opportunityIds, ['opp-ok']);
  assert.deepEqual(result.failures.map((failure) => failure.index), [1, 2]);
  assert.equal(result.failures[0].code, 'QUEUE_BACKPRESSURE');
  assert.equal(result.failures[0].transient, true);
  assert.equal(result.failures[1].reason, 'invalid source record');
  assert.equal(result.failures[1].transient, false);
});

test('partial backpressure keeps failed records pending across repeated same-run retries', async () => {
  const repository = new InMemorySourceRepository(source());
  let fetches = 0;
  const connector = {
    id: 'durable-feed',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => {
      fetches += 1;
      return {
        records: [normalizedRecord('a'), normalizedRecord('b'), normalizedRecord('c')],
        checkpoint: { cursor: 'next' },
        hasMore: false,
      };
    },
    checkpoint: (page) => page.checkpoint,
  };
  const delivered = [];
  let ingestCalls = 0;
  const { service, enqueued } = makeService(repository, connector, {
    ingestFromSource: async ({ records }) => {
      ingestCalls += 1;
      delivered.push(records.map((item) => item.sourceOccurrences[0].externalId));
      if (ingestCalls === 1) {
        return successResult(records, {
          upserted: 1,
          created: 1,
          failed: 2,
          opportunityIds: ['opp-a'],
          failures: [
            { index: 1, externalId: 'b', url: 'https://example.test/b', title: 'Record b', code: 'QUEUE_BACKPRESSURE', reason: 'Queue is temporarily at capacity', transient: true },
            { index: 2, externalId: 'c', url: 'https://example.test/c', title: 'Record c', code: 'QUEUE_BACKPRESSURE', reason: 'Queue is temporarily at capacity', transient: true },
          ],
        });
      }
      if (ingestCalls === 2) {
        return successResult(records, {
          upserted: 0,
          created: 0,
          failed: 2,
          opportunityIds: [],
          failures: [
            { index: 0, externalId: 'b', url: 'https://example.test/b', title: 'Record b', code: 'QUEUE_BACKPRESSURE', reason: 'Queue is temporarily at capacity', transient: true },
            { index: 1, externalId: 'c', url: 'https://example.test/c', title: 'Record c', code: 'QUEUE_BACKPRESSURE', reason: 'Queue is temporarily at capacity', transient: true },
          ],
        });
      }
      return successResult(records, { seen: records.length, normalized: records.length, upserted: records.length, created: 0, updated: records.length });
    },
  });
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  const queued = await service.executeRun(run._id, 30);

  assert.equal(queued.status, 'Queued');
  assert.equal(fetches, 1);
  assert.deepEqual(repository.source.checkpoint, {});
  assert.deepEqual(repository.runs.get(run._id).checkpointAfter, {});
  assert.equal(repository.runs.get(run._id).stats.seen, 3);
  assert.equal(repository.runs.get(run._id).stats.upserted, 1);
  assert.equal(repository.runs.get(run._id).stats.failed, 2);
  assert.deepEqual(repository.runs.get(run._id).requestMetadata.pendingIngest.records.map((item) => item.sourceOccurrences[0].externalId), ['b', 'c']);
  assert.equal(repository.runs.get(run._id).requestMetadata.pendingIngest.pageStatsCounted, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].options.delay, 5000);

  const stillQueued = await service.executeRun(run._id, 30);

  assert.equal(stillQueued.status, 'Queued');
  assert.equal(fetches, 1);
  assert.deepEqual(repository.runs.get(run._id).requestMetadata.pendingIngest.records.map((item) => item.sourceOccurrences[0].externalId), ['b', 'c']);
  assert.equal(repository.runs.get(run._id).stats.seen, 3);
  assert.equal(repository.runs.get(run._id).stats.upserted, 1);
  assert.equal(repository.runs.get(run._id).stats.failed, 4);
  assert.equal(enqueued.length, 2);

  const finished = await service.executeRun(run._id, 30);

  assert.equal(finished.status, 'Succeeded');
  assert.equal(fetches, 1);
  assert.deepEqual(delivered, [['a', 'b', 'c'], ['b', 'c'], ['b', 'c']]);
  assert.deepEqual(repository.source.checkpoint, { cursor: 'next' });
  assert.equal(finished.stats.seen, 3);
  assert.equal(finished.stats.upserted, 3);
  assert.equal(finished.stats.failed, 4);
  assert.equal(finished.requestMetadata.pendingIngest, undefined);
});

test('non-transient record failure fails visibly with pending payload retained', async () => {
  const repository = new InMemorySourceRepository(source());
  const connector = {
    id: 'durable-feed',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => ({
      records: [normalizedRecord('bad')],
      checkpoint: { cursor: 'next' },
      hasMore: false,
    }),
    checkpoint: (page) => page.checkpoint,
  };
  const { service, enqueued } = makeService(repository, connector, {
    ingestFromSource: async ({ records }) => successResult(records, {
      upserted: 0,
      created: 0,
      failed: 1,
      opportunityIds: [],
      failures: [{ index: 0, externalId: 'bad', url: 'https://example.test/bad', title: 'Record bad', reason: 'invalid source record', transient: false }],
    }),
  });
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  await assert.rejects(() => service.executeRun(run._id, 30), /invalid source record/);

  const failed = repository.runs.get(run._id);
  assert.equal(failed.status, 'Failed');
  assert.equal(failed.stats.seen, 1);
  assert.equal(failed.stats.failed, 1);
  assert.deepEqual(repository.source.checkpoint, {});
  assert.deepEqual(failed.checkpointAfter, {});
  assert.deepEqual(failed.requestMetadata.pendingIngest.records.map((item) => item.sourceOccurrences[0].externalId), ['bad']);
  assert.equal(repository.dlq.length, 1);
  assert.equal(repository.dlq[0].status, 'Open');
  assert.equal(enqueued.length, 0);
});

test('same-run retry recovers a transport failure only after complete delivery, retaining failure history', async () => {
  const repository = new InMemorySourceRepository(source());
  let fetches = 0;
  const connector = {
    id: 'durable-feed',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => {
      if (++fetches === 1) throw new Error('network unavailable');
      return { records: [normalizedRecord('retried')], checkpoint: { hasMore: false }, hasMore: false };
    },
    checkpoint: page => page.checkpoint,
  };
  const { service } = makeService(repository, connector, { ingestFromSource: async ({ records }) => successResult(records) });
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'backfill', status: 'Queued', checkpointBefore: {} });
  await assert.rejects(() => service.executeRun(run._id, 30), /network unavailable/);
  assert.equal(repository.dlq[0].status, 'Open');
  const fixedWindow = repository.runs.get(run._id).requestMetadata.backfillSince;
  const finished = await service.executeRun(run._id, 30);
  assert.equal(finished.status, 'Succeeded');
  assert.equal(finished.stats.failed, 1);
  assert.equal(finished.stats.upserted, 1);
  assert.equal(finished.requestMetadata.backfillSince, fixedWindow);
  assert.equal(repository.dlq[0].status, 'Recovered');
  assert.equal(repository.dlq[0].error, 'network unavailable');
  assert.ok(repository.dlq[0].recoveredAt instanceof Date);
});

test('retry-history reconciliation failure cannot invalidate completed ingestion', async () => {
  const repository = new InMemorySourceRepository(source());
  repository.recoverRunDlq = async () => { throw new Error('history database unavailable'); };
  const connector = {
    id: 'durable-feed', validateConfig: async () => ({ ok: true }),
    fetchPage: async () => ({ records: [normalizedRecord('ok')], checkpoint: { hasMore: false }, hasMore: false }),
    checkpoint: page => page.checkpoint,
  };
  const { service } = makeService(repository, connector, { ingestFromSource: async ({ records }) => successResult(records) });
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'backfill', status: 'Failed', checkpointBefore: {}, stats: { failed: 1 } });
  const finished = await service.executeRun(run._id, 30);
  assert.equal(finished.status, 'Succeeded');
  assert.equal((await repository.getRun(run._id)).status, 'Succeeded');
  assert.equal(finished.stats.failed, 1);
  assert.equal(repository.dlq.length, 0);
});

test('corrupt or foreign pending ingest metadata fails visibly instead of refetching', async () => {
  const repository = new InMemorySourceRepository(source());
  const connector = {
    id: 'durable-feed',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => {
      throw new Error('must not refetch when pending metadata is present');
    },
    checkpoint: (page) => page.checkpoint,
  };
  const { service } = makeService(repository, connector, {
    ingestFromSource: async () => {
      throw new Error('must not ingest corrupt pending metadata');
    },
  });
  const run = await repository.createRun({
    sourceId: 'source-1',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: {},
    requestMetadata: {
      pendingIngest: {
        version: 1,
        sourceId: 'other-source',
        runId: 'other-run',
        connectorId: 'durable-feed',
        checkpointBefore: {},
        checkpointAfter: { cursor: 'next' },
        hasMore: false,
        records: [normalizedRecord('a')],
        duplicateCount: 0,
        pageStatsCounted: false,
      },
    },
  });

  await assert.rejects(() => service.executeRun(run._id, 30), /belongs to a different source run/);

  const failed = repository.runs.get(run._id);
  assert.equal(failed.status, 'Failed');
  assert.equal(repository.dlq.length, 1);
  assert.deepEqual(repository.source.checkpoint, {});
});

test('stop during partial delivery preserves pending page and does not enqueue or advance checkpoint', async () => {
  const repository = new InMemorySourceRepository(source());
  const connector = {
    id: 'durable-feed',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => ({
      records: [normalizedRecord('a'), normalizedRecord('b')],
      checkpoint: { cursor: 'next' },
      hasMore: false,
    }),
    checkpoint: (page) => page.checkpoint,
  };
  const { service, enqueued } = makeService(repository, connector, {
    ingestFromSource: async ({ runId, records }) => {
      await repository.requestStop(runId);
      return successResult(records, {
        upserted: 1,
        created: 1,
        failed: 1,
        opportunityIds: ['opp-a'],
        failures: [{ index: 1, externalId: 'b', url: 'https://example.test/b', title: 'Record b', code: 'QUEUE_BACKPRESSURE', reason: 'Queue is temporarily at capacity', transient: true }],
      });
    },
  });
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  const stopped = await service.executeRun(run._id, 30);

  assert.equal(stopped.status, 'Cancelled');
  assert.ok(stopped.requestedStopAt);
  assert.deepEqual(repository.source.checkpoint, {});
  assert.equal(enqueued.length, 0);
  assert.deepEqual(repository.runs.get(run._id).checkpointAfter, {});
  assert.deepEqual(repository.runs.get(run._id).stats, {});
  assert.deepEqual(repository.runs.get(run._id).requestMetadata.pendingIngest.records.map((item) => item.sourceOccurrences[0].externalId), ['a', 'b']);
});

test('serialized pending ingest resumes on a new service instance and hydrates date strings', async () => {
  const repository = new InMemorySourceRepository(source());
  const connector = {
    id: 'durable-feed',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => {
      throw new Error('must not refetch serialized pending metadata');
    },
    checkpoint: (page) => page.checkpoint,
  };
  const pending = JSON.parse(JSON.stringify({
    version: 1,
    sourceId: 'source-1',
    runId: 'run-serialized',
    connectorId: 'durable-feed',
    checkpointBefore: { cursor: 'same' },
    checkpointAfter: { cursor: 'next' },
    hasMore: false,
    records: [normalizedRecord('dated', { publishedAt: new Date('2026-10-01T00:00:00.000Z') })],
    duplicateCount: 0,
    pageStatsCounted: true,
  }));
  const run = await repository.createRun({
    _id: 'run-serialized',
    sourceId: 'source-1',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: {},
    checkpointAfter: { cursor: 'same' },
    stats: { seen: 1, normalized: 1, upserted: 0, created: 0, updated: 0, duplicates: 0, failed: 1 },
    requestMetadata: { pendingIngest: pending, backfillDays: 30, backfillSince: '2026-09-04T00:00:00.000Z' },
  });
  let receivedPublishedAt;
  const { service } = makeService(repository, connector, {
    ingestFromSource: async ({ records }) => {
      receivedPublishedAt = records[0].publishedAt;
      return successResult(records, { seen: 1, normalized: 1, upserted: 1, created: 0, updated: 1 });
    },
  });

  const finished = await service.executeRun(run._id, 30);

  assert.equal(finished.status, 'Succeeded');
  assert.ok(receivedPublishedAt instanceof Date);
  assert.equal(receivedPublishedAt.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.deepEqual(repository.source.checkpoint, { cursor: 'next' });
  assert.equal(finished.stats.seen, 1);
  assert.equal(finished.stats.upserted, 1);
  assert.equal(finished.stats.failed, 1);
  assert.equal(finished.requestMetadata.pendingIngest, undefined);
});

test('inconsistent failed indexes retain all pending records for retry', async () => {
  const repository = new InMemorySourceRepository(source());
  const connector = {
    id: 'durable-feed',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => ({
      records: [normalizedRecord('a'), normalizedRecord('b'), normalizedRecord('c')],
      checkpoint: { cursor: 'next' },
      hasMore: false,
    }),
    checkpoint: (page) => page.checkpoint,
  };
  const { service } = makeService(repository, connector, {
    ingestFromSource: async ({ records }) => successResult(records, {
      upserted: 1,
      created: 1,
      failed: 2,
      opportunityIds: ['opp-a'],
      failures: [{ index: 2, externalId: 'c', url: 'https://example.test/c', title: 'Record c', code: 'QUEUE_BACKPRESSURE', reason: 'Queue is temporarily at capacity', transient: true }],
    }),
  });
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  const queued = await service.executeRun(run._id, 30);

  assert.equal(queued.status, 'Queued');
  assert.deepEqual(repository.runs.get(run._id).requestMetadata.pendingIngest.records.map((item) => item.sourceOccurrences[0].externalId), ['a', 'b', 'c']);
  assert.deepEqual(repository.source.checkpoint, {});
});
