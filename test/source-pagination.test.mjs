import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { SourcesService } = require('../src/modules/sources/sources.service.ts');
const { ConnectorRateLimitError } = require('../src/modules/sources/connectors/connector.types.ts');
const { HhConnector } = require('../src/modules/sources/connectors/hh.connector.ts');
const { AtsPublicBoardConnector } = require('../src/modules/sources/connectors/ats-public-board.connector.ts');

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
    this.dlq.push(input);
    return input;
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
    limits: { perPage: 1, maxPages: 2 },
    timeoutMs: 30_000,
    ...overrides,
  };
}

function record(id, overrides = {}) {
  return {
    externalId: id,
    url: `https://example.test/${id}`,
    type: 'vacancy',
    title: `Record ${id}`,
    sourceStatus: 'Active',
    rawPayload: { id },
    sourceMetadata: {},
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
      enqueue: async (queue, name, data, options) => enqueued.push({ queue, name, data, options }),
      queue: () => ({ add: async () => undefined }),
    },
    { publish: () => undefined },
    ingestOverride ?? {
      ingestFromSource: async ({ records }) => ({
        seen: records.length,
        normalized: records.length,
        upserted: records.length,
        created: records.length,
        updated: 0,
        duplicates: 0,
        failed: 0,
      }),
    },
  );
  return { service, enqueued };
}

test('incomplete terminal source collection retains imported records and fails visibly instead of claiming success', async () => {
  const repository = new InMemorySourceRepository(source());
  const checkpoint = { incomplete: true, remainingHint: 34, limitation: 'Anonymous load-more contract is not implemented' };
  const connector = {
    id: 'partial-public-catalogue',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => ({ records: [record('initial-card')], hasMore: false, checkpoint, stats: { seen: 1 } }),
    checkpoint: (page) => page.checkpoint,
  };
  const { service, enqueued } = makeService(repository, connector);
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'backfill', status: 'Queued', checkpointBefore: {} });
  await assert.rejects(service.executeRun(run._id, 30), /Incomplete source collection: Anonymous load-more/);
  const failed = await repository.getRun(run._id);
  assert.equal(failed.status, 'Failed');
  assert.equal(failed.stats.upserted, 1);
  assert.equal(failed.stats.failed, 1);
  assert.deepEqual(failed.checkpointAfter, checkpoint);
  assert.equal(repository.source.lastSuccessAt, undefined);
  assert.equal(repository.health.some((patch) => patch.healthState === 'Healthy'), false);
  assert.equal(repository.dlq.length, 1);
  assert.equal(enqueued.length, 0);
});

test('terminal source collection with unresolved checkpoint continuation fails instead of claiming success', async () => {
  const repository = new InMemorySourceRepository(source({ limits: { perPage: 10, maxPages: 1 } }));
  const checkpoint = { cursor: 'next-page', hasMore: true };
  const connector = {
    id: 'contradictory-terminal',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => ({ records: [record('initial-card')], hasMore: false, checkpoint, stats: { seen: 1 } }),
    checkpoint: (page) => page.checkpoint,
  };
  const { service, enqueued } = makeService(repository, connector);
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  await assert.rejects(service.executeRun(run._id, 30), /unresolved checkpoint continuation/);

  const failed = await repository.getRun(run._id);
  assert.equal(failed.status, 'Failed');
  assert.deepEqual(failed.checkpointAfter, checkpoint);
  assert.equal(repository.source.lastSuccessAt, undefined);
  assert.equal(repository.health.some((patch) => patch.healthState === 'Healthy'), false);
  assert.equal(repository.health.at(-1).healthState, 'Failed');
  assert.equal(repository.dlq.length, 1);
  assert.equal(enqueued.length, 0);
});

test('source run paginates through bounded durable continuation and aggregates stats', async () => {
  const repository = new InMemorySourceRepository(source());
  const fetched = [];
  const connector = {
    id: 'paged',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async (ctx) => {
      const page = ctx.page ?? Number(ctx.checkpoint.page ?? 0);
      fetched.push({ page, checkpoint: ctx.checkpoint });
      return {
        records: [record(`p${page}`)],
        checkpoint: { page: page < 2 ? page + 1 : 0, hasMore: page < 2 },
        hasMore: page < 2,
        nextPage: page < 2 ? page + 1 : undefined,
        stats: { seen: 1 },
      };
    },
    checkpoint: (page) => page.checkpoint,
  };
  const { service, enqueued } = makeService(repository, connector);
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  const continued = await service.executeRun(run._id, 30);
  assert.equal(continued.status, 'Queued');
  assert.deepEqual(repository.source.checkpoint, { page: 2, hasMore: true });
  assert.equal(repository.source.lastSuccessAt, undefined);
  assert.equal(repository.health.length, 0);
  assert.equal(repository.runs.get(run._id).stats.seen, 2);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].data.backfillDays, 30);

  const finished = await service.executeRun(run._id, 30);
  assert.equal(finished.status, 'Succeeded');
  assert.deepEqual(finished.checkpointAfter, { page: 0, hasMore: false });
  assert.equal(repository.health.length, 1);
  assert.equal(repository.health[0].healthState, 'Healthy');
  assert.equal(repository.health[0].lastSuccessAt.toISOString(), finished.finishedAt.toISOString());
  assert.equal(repository.health[0].healthMessage, undefined);
  assert.equal(repository.health[0].lastError, undefined);
  assert.deepEqual(fetched.map((item) => item.page), [0, 1, 2]);
  assert.equal(finished.stats.seen, 3);
  assert.equal(finished.stats.created, 3);

  await service.executeRun(run._id, 30);
  assert.deepEqual(fetched.map((item) => item.page), [0, 1, 2]);
});

test('source run marks queued before continuation enqueue so immediate worker cannot be overwritten', async () => {
  const repository = new InMemorySourceRepository(source({ limits: { perPage: 1, maxPages: 1 } }));
  const fetched = [];
  const connector = {
    id: 'immediate-continuation',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async (ctx) => {
      const page = ctx.page ?? Number(ctx.checkpoint.page ?? 0);
      fetched.push(page);
      return {
        records: [record(`p${page}`)],
        checkpoint: { page: page < 1 ? page + 1 : 0, hasMore: page < 1 },
        hasMore: page < 1,
        nextPage: page < 1 ? page + 1 : undefined,
        stats: { seen: 1 },
      };
    },
    checkpoint: (page) => page.checkpoint,
  };
  let service;
  const jobs = {
    registerHandler: () => undefined,
    enqueue: async () => {
      await service.executeRun(run._id, 30);
      return { id: 'immediate', queue: 'ingestion' };
    },
    queue: () => ({ add: async () => undefined }),
  };
  ({ service } = makeService(repository, connector, undefined, jobs));
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  await service.executeRun(run._id, 30);

  assert.deepEqual(fetched, [0, 1]);
  assert.equal(repository.runs.get(run._id).status, 'Succeeded');
  assert.deepEqual(repository.runs.get(run._id).checkpointAfter, { page: 0, hasMore: false });
});

test('duplicate concurrent executeRun cannot fetch a run already claimed as running', async () => {
  const repository = new InMemorySourceRepository(source({ limits: { perPage: 1, maxPages: 1 } }));
  let releaseFetch;
  let fetchStarted;
  const fetchStartedPromise = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const releaseFetchPromise = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  let fetches = 0;
  const connector = {
    id: 'slow',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => {
      fetches += 1;
      fetchStarted();
      await releaseFetchPromise;
      return { records: [record('one')], checkpoint: { page: 0, hasMore: false }, hasMore: false, stats: { seen: 1 } };
    },
    checkpoint: (page) => page.checkpoint,
  };
  const { service } = makeService(repository, connector);
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  const first = service.executeRun(run._id, 30);
  await fetchStartedPromise;
  const duplicate = await service.executeRun(run._id, 30);
  releaseFetch();
  const finished = await first;

  assert.equal(duplicate.status, 'Running');
  assert.equal(finished.status, 'Succeeded');
  assert.equal(fetches, 1);
});

test('source run preserves partial checkpoint and stats when rate limited', async () => {
  const repository = new InMemorySourceRepository(source({ limits: { perPage: 1, maxPages: 5 } }));
  let calls = 0;
  const connector = {
    id: 'rate-limited',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async (ctx) => {
      calls += 1;
      if (calls === 2) throw new ConnectorRateLimitError('slow down', 7);
      const page = ctx.page ?? Number(ctx.checkpoint.page ?? 0);
      return {
        records: [record(`p${page}`)],
        checkpoint: { page: page + 1, hasMore: true },
        hasMore: true,
        nextPage: page + 1,
        stats: { seen: 1 },
      };
    },
    checkpoint: (page) => page.checkpoint,
  };
  const { service, enqueued } = makeService(repository, connector);
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'scheduled', status: 'Queued', checkpointBefore: {} });

  const queued = await service.executeRun(run._id, 17);

  assert.equal(queued.status, 'Queued');
  assert.deepEqual(repository.source.checkpoint, { page: 1, hasMore: true });
  assert.equal(repository.source.lastSuccessAt, undefined);
  assert.equal(repository.health.at(-1).healthState, 'Degraded');
  assert.equal(repository.health.at(-1).lastSuccessAt, undefined);
  assert.equal(repository.runs.get(run._id).stats.seen, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].data.backfillDays, 17);
  assert.equal(enqueued[0].options.delay, 7000);
});

test('rate limit marks queued before retry enqueue so immediate retry can finish without queued overwrite', async () => {
  const repository = new InMemorySourceRepository(source({ limits: { perPage: 1, maxPages: 5 } }));
  let calls = 0;
  const connector = {
    id: 'rate-limit-race',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async (ctx) => {
      calls += 1;
      if (calls === 1) throw new ConnectorRateLimitError('slow down', 1);
      const page = ctx.page ?? Number(ctx.checkpoint.page ?? 0);
      return { records: [record(`p${page}`)], checkpoint: { page: 0, hasMore: false }, hasMore: false, stats: { seen: 1 } };
    },
    checkpoint: (page) => page.checkpoint,
  };
  let service;
  const jobs = {
    registerHandler: () => undefined,
    enqueue: async () => {
      await service.executeRun(run._id, 30);
      return { id: 'retry', queue: 'ingestion' };
    },
    queue: () => ({ add: async () => undefined }),
  };
  ({ service } = makeService(repository, connector, undefined, jobs));
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  await service.executeRun(run._id, 30);

  assert.equal(repository.runs.get(run._id).status, 'Succeeded');
  assert.equal(repository.runs.get(run._id).stats.seen, 1);
});

test('failed run retry resumes from run checkpointAfter instead of shared source checkpoint', async () => {
  const repository = new InMemorySourceRepository(source({ limits: { perPage: 1, maxPages: 5 } }));
  let firstAttempt = true;
  const fetched = [];
  const connector = {
    id: 'failed-retry',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async (ctx) => {
      const page = ctx.page ?? Number(ctx.checkpoint.page ?? 0);
      fetched.push({ page, checkpoint: ctx.checkpoint });
      if (firstAttempt && page === 1) {
        firstAttempt = false;
        throw new Error('transient upstream failure');
      }
      return {
        records: [record(`p${page}`)],
        checkpoint: { page: page < 1 ? page + 1 : 0, hasMore: page < 1 },
        hasMore: page < 1,
        nextPage: page < 1 ? page + 1 : undefined,
        stats: { seen: 1 },
      };
    },
    checkpoint: (page) => page.checkpoint,
  };
  const { service } = makeService(repository, connector);
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  await assert.rejects(() => service.executeRun(run._id, 30), /transient upstream failure/);
  assert.equal(repository.runs.get(run._id).status, 'Failed');
  assert.deepEqual(repository.runs.get(run._id).checkpointAfter, { page: 1, hasMore: true });
  repository.source = { ...repository.source, checkpoint: { page: 99, hasMore: true } };

  const finished = await service.executeRun(run._id, 30);

  assert.equal(finished.status, 'Succeeded');
  assert.deepEqual(fetched.map((item) => item.page), [0, 1, 1]);
  assert.deepEqual(fetched[2].checkpoint, { page: 1, hasMore: true });
  assert.equal(finished.stats.seen, 2);
  assert.equal(finished.stats.failed, 1);
});

test('source run stop during ingest keeps pending page without advancing checkpoint', async () => {
  const repository = new InMemorySourceRepository(source({ limits: { perPage: 1, maxPages: 5 } }));
  const connector = {
    id: 'stoppable',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => ({
      records: [record('one')],
      checkpoint: { page: 1, hasMore: true },
      hasMore: true,
      nextPage: 1,
      stats: { seen: 1 },
    }),
    checkpoint: (page) => page.checkpoint,
  };
  const { service } = makeService(repository, connector, {
    ingestFromSource: async ({ records, runId }) => {
      await repository.requestStop(runId);
      return { seen: records.length, normalized: records.length, upserted: records.length, created: records.length, updated: 0, duplicates: 0, failed: 0 };
    },
  });
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  const stopped = await service.executeRun(run._id, 30);

  assert.equal(stopped.status, 'Cancelled');
  assert.deepEqual(repository.source.checkpoint, {});
  assert.equal(repository.source.lastSuccessAt, undefined);
  assert.equal(repository.health.length, 0);
  assert.deepEqual(repository.runs.get(run._id).checkpointAfter, {});
  assert.deepEqual(repository.runs.get(run._id).stats, {});
  assert.deepEqual(repository.runs.get(run._id).requestMetadata.pendingIngest.records.map((item) => item.externalId), ['one']);
});

test('source run stopped during terminal finish does not mark collection healthy', async () => {
  const repository = new InMemorySourceRepository(source({ limits: { perPage: 1, maxPages: 1 } }));
  repository.finishRunIfNotStopped = async (id) => {
    await repository.requestStop(id);
    return repository.getRun(id);
  };
  const connector = {
    id: 'finish-race',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => ({ records: [record('one')], checkpoint: { hasMore: false }, hasMore: false, stats: { seen: 1 } }),
    checkpoint: (page) => page.checkpoint,
  };
  const { service } = makeService(repository, connector);
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'manual', status: 'Queued', checkpointBefore: {} });

  const stopped = await service.executeRun(run._id, 30);

  assert.equal(stopped.status, 'Cancelled');
  assert.equal(repository.health.length, 0);
  assert.equal(repository.source.lastSuccessAt, undefined);
});

test('healthy source probe records check fields without overwriting collection health or last success', async () => {
  for (const existing of [
    source({ healthState: 'Failed', healthMessage: 'collection failed', lastError: 'collection failed', lastFailureAt: new Date('2026-10-06T00:00:00.000Z') }),
    source({ healthState: 'Unknown' }),
  ]) {
    const repository = new InMemorySourceRepository(existing);
    const checkedAt = new Date('2026-10-07T10:00:00.000Z');
    const connector = {
      id: 'probe',
      capabilities: () => ({}),
      healthCheck: async () => ({ state: 'Healthy', message: 'probe ok', checkedAt }),
    };
    const { service } = makeService(repository, connector);

    const result = await service.check('source-1');

    assert.equal(result.health.state, 'Healthy');
    assert.equal(repository.health.length, 1);
    assert.deepEqual(repository.health[0], {
      lastHealthCheckAt: checkedAt,
      lastHealthCheckState: 'Healthy',
      lastHealthCheckMessage: 'probe ok',
    });
  }
});

test('unknown source probe records check fields without fabricating a collection failure', async () => {
  const repository = new InMemorySourceRepository(source({
    healthState: 'Failed',
    healthMessage: 'collection failed',
    lastError: 'collection failed',
    lastFailureAt: new Date('2026-10-06T00:00:00.000Z'),
  }));
  const checkedAt = new Date('2026-10-07T11:00:00.000Z');
  const connector = {
    id: 'probe-unknown',
    capabilities: () => ({}),
    healthCheck: async () => ({ state: 'Unknown', message: 'probe not conclusive', checkedAt }),
  };
  const { service } = makeService(repository, connector);

  const result = await service.check('source-1');

  assert.equal(result.health.state, 'Unknown');
  assert.equal(repository.health.length, 1);
  assert.deepEqual(repository.health[0], {
    lastHealthCheckAt: checkedAt,
    lastHealthCheckState: 'Unknown',
    lastHealthCheckMessage: 'probe not conclusive',
  });
});

test('source run filters known records outside the fixed backfill window while preserving unknown dates', async () => {
  const backfillSince = new Date('2026-09-04T00:00:00.000Z');
  const repository = new InMemorySourceRepository(source({ limits: { perPage: 10, maxPages: 1 } }));
  const ingested = [];
  const connector = {
    id: 'windowed',
    validateConfig: async () => ({ ok: true }),
    fetchPage: async (ctx) => {
      assert.equal(ctx.backfillSince, backfillSince.toISOString());
      return {
        records: [
          record('old', { publishedAt: new Date('2026-09-03T23:59:59.000Z') }),
          record('inside', { publishedAt: new Date('2026-09-04T00:00:00.000Z') }),
          record('unknown', { publishedAt: undefined }),
        ],
        checkpoint: { page: 0, hasMore: false },
        hasMore: false,
        stats: { seen: 3 },
      };
    },
    checkpoint: (page) => page.checkpoint,
  };
  const { service } = makeService(repository, connector, {
    ingestFromSource: async ({ records }) => {
      ingested.push(...records.map((item) => item.title));
      return { seen: records.length, normalized: records.length, upserted: records.length, created: records.length, updated: 0, duplicates: 0, failed: 0 };
    },
  });
  const run = await repository.createRun({
    sourceId: 'source-1',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: {},
    requestMetadata: { backfillDays: 30, backfillSince: backfillSince.toISOString() },
  });

  const finished = await service.executeRun(run._id, 30);

  assert.equal(finished.status, 'Succeeded');
  assert.deepEqual(ingested, ['Record inside', 'Record unknown']);
  assert.equal(finished.stats.seen, 2);
});

test('HH connector resets terminal checkpoint so the next run starts at page zero', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ items: [], page: 0, pages: 1, per_page: 50, found: 0 }),
      headers: { get: () => null },
    };
  };
  try {
    const connector = new HhConnector();
    const result = await connector.fetchPage({
      source: source({ _id: 'hh', checkpoint: { page: 99, hasMore: false } }),
      requestId: 'hh-test',
      checkpoint: { page: 99, hasMore: false },
      backfillDays: 30,
      backfillSince: '2026-09-04T00:00:00.000Z',
    });

    assert.equal(new URL(urls[0]).searchParams.get('page'), '0');
    assert.equal(new URL(urls[0]).searchParams.get('date_from'), '2026-09-04T00:00:00+0000');
    assert.deepEqual(result.checkpoint.page, 0);
    assert.equal(result.checkpoint.hasMore, false);
    assert.equal(result.hasMore, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ATS public board connector completes a finite rotated tenant cycle', async () => {
  const connector = new AtsPublicBoardConnector('greenhouse');
  connector.fetchTenant = async (tenant) => [record(tenant)];
  const first = await connector.fetchPage({
    source: source({ _id: 'greenhouse', connectorFamily: 'AtsPublicBoard', config: { tenants: ['a', 'b', 'c'] }, limits: { maxTenantsPerRun: 2 } }),
    requestId: 'ats-test',
    checkpoint: { tenantCursor: 1, hasMore: false },
    backfillDays: 30,
  });
  assert.deepEqual(first.checkpoint.tenants, ['b', 'c']);
  assert.equal(first.hasMore, true);
  assert.equal(first.checkpoint.tenantCursor, 0);
  assert.equal(first.checkpoint.tenantCycleProcessed, 2);

  const second = await connector.fetchPage({
    source: source({ _id: 'greenhouse', connectorFamily: 'AtsPublicBoard', config: { tenants: ['a', 'b', 'c'] }, limits: { maxTenantsPerRun: 2 } }),
    requestId: 'ats-test',
    checkpoint: first.checkpoint,
    backfillDays: 30,
    page: first.nextPage,
  });
  assert.deepEqual(second.checkpoint.tenants, ['a']);
  assert.equal(second.hasMore, false);
  assert.equal(second.checkpoint.tenantCursor, 1);
  assert.equal(second.checkpoint.tenantCycleProcessed, undefined);
});
