import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { SourcesService } = require('../src/modules/sources/sources.service.ts');
const { ConnectorRateLimitError } = require('../src/modules/sources/connectors/connector.types.ts');
const { WebExtractionHttpError } = require('../src/modules/sources/extraction/web-extraction.service.ts');

function source(overrides = {}) {
  return {
    _id: 'workspace',
    name: 'Workspace',
    enabled: true,
    runtimeState: 'Enabled',
    intervalSeconds: 900,
    checkpoint: { page: 9 },
    connectorFamily: 'PublicHtml',
    endpoint: {},
    config: {},
    limits: { maxPages: 1 },
    timeoutMs: 30_000,
    ...overrides,
  };
}

function occurrence(id, overrides = {}) {
  return {
    sourceId: 'workspace',
    externalId: id,
    url: `https://workspace.ru/tenders/${id}/`,
    primary: true,
    firstSeenAt: new Date('2026-10-01T00:00:00.000Z'),
    lastSeenAt: new Date('2026-10-01T00:00:00.000Z'),
    status: 'Active',
    rawPayload: { id },
    sourceMetadata: {},
    ...overrides,
  };
}

function rawRecord(id, overrides = {}) {
  return {
    externalId: id,
    url: `https://workspace.ru/tenders/${id}/`,
    type: 'tender',
    title: `Tender ${id}`,
    companyOrClient: 'Customer',
    description: 'Fresh detail',
    publishedAt: new Date('2026-10-01T00:00:00.000Z'),
    sourceStatus: 'Active',
    rawPayload: { id, detail: true },
    sourceMetadata: {},
    ...overrides,
  };
}

class InMemorySourceRepository {
  constructor(row = source()) {
    this.source = structuredClone(row);
    this.runs = new Map();
    this.dlq = [];
    this.health = [];
  }

  async get(id) {
    assert.equal(id, this.source._id);
    return structuredClone(this.source);
  }

  async createRun(input) {
    const run = { _id: input._id ?? crypto.randomUUID(), stats: {}, checkpointAfter: {}, requestMetadata: {}, ...input };
    this.runs.set(run._id, run);
    return structuredClone(run);
  }

  async findActiveRun(id) {
    return structuredClone([...this.runs.values()].find((run) => run.sourceId === id && ['Queued', 'Running'].includes(run.status)) ?? null);
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
    Object.assign(this.runs.get(id), patch);
    return structuredClone(this.runs.get(id));
  }

  async finishRunIfNotStopped(id, patch) {
    const run = this.runs.get(id);
    if (run.status === 'Running' && !run.requestedStopAt) Object.assign(run, patch);
    return structuredClone(run);
  }

  async requestStop(id) {
    return this.updateRun(id, { requestedStopAt: new Date(), status: 'Cancelled' });
  }

  async updateHealth(id, patch) {
    assert.equal(id, this.source._id);
    this.health.push(patch);
  }

  async updateCheckpoint(id, checkpoint) {
    assert.equal(id, this.source._id);
    this.source.checkpoint = structuredClone(checkpoint);
  }

  async createDlq(input) {
    this.dlq.push(input);
    return input;
  }
}

function makeService({ repository = new InMemorySourceRepository(), connector, candidates = [occurrence('18970')], ingest, jobs } = {}) {
  const enqueued = [];
  const refreshCalls = [];
  const candidateQueries = [];
  const defaultConnector = connector ?? {
    id: 'workspace',
    capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
    validateConfig: async () => ({ ok: true }),
    refresh: async (candidate) => {
      refreshCalls.push(structuredClone(candidate));
      return { record: rawRecord(candidate.externalId) };
    },
  };
  const service = new SourcesService(
    repository,
    { get: () => defaultConnector },
    { normalize: (_source, item) => ({ ...item, sourceOccurrences: [{ sourceId: 'workspace', externalId: item.externalId, url: item.url, primary: true, firstSeenAt: new Date(), lastSeenAt: new Date(), status: item.sourceStatus, rawPayload: item.rawPayload, sourceMetadata: item.sourceMetadata }] }) },
    { collapseBatch: (records) => ({ records, duplicates: 0 }) },
    { encrypt: JSON.stringify, decrypt: JSON.parse },
    { record: async () => undefined },
    jobs ?? {
      registerHandler: () => undefined,
      enqueue: async (queue, name, data, options) => {
        enqueued.push({ queue, name, data, options });
        return { id: crypto.randomUUID(), queue };
      },
      queue: () => ({ getJobSchedulers: async () => [], removeJobScheduler: async () => true, upsertJobScheduler: async () => undefined }),
    },
    { publish: () => undefined },
    ingest ?? {
      ingestFromSource: async ({ records }) => ({
        seen: records.length,
        normalized: records.length,
        upserted: records.length,
        created: 0,
        updated: records.length,
        duplicates: 0,
        failed: 0,
        opportunityIds: records.map((record) => `opp-${record.externalId}`),
        failures: [],
      }),
    },
    {
      listSourceRefreshCandidates: async (input) => {
        assert.equal(input.sourceId, 'workspace');
        candidateQueries.push(input);
        return candidates.map((item, index) => ({ opportunityId: `opp-${index + 1}`, occurrence: item }));
      },
      getSourceRefreshOccurrence: async (input) => {
        const item = candidates.find((candidate, index) =>
          input.opportunityId === `opp-${index + 1}` &&
          candidate.sourceId === input.sourceId &&
          candidate.externalId === input.externalId &&
          candidate.url === input.url &&
          candidate.status !== 'Removed',
        );
        return item ? structuredClone(item) : null;
      },
    },
  );
  return { service, repository, enqueued, refreshCalls, candidateQueries };
}

test('manual source refresh queues a bounded refresh run without touching collection checkpoint', async () => {
  const fixture = makeService();
  const run = await fixture.service.refresh({ id: 'admin' }, 'workspace', { opportunityIds: ['opp-1'], limit: 1 });

  assert.equal(run.runType, 'manual');
  assert.equal(run.status, 'Queued');
  assert.equal(run.requestMetadata.mode, 'refresh');
  assert.deepEqual(run.requestMetadata.refresh.requestedOpportunityIds, ['opp-1']);
  assert.deepEqual(fixture.repository.source.checkpoint, { page: 9 });
  assert.equal(fixture.enqueued[0].name, 'source.refreshActive');
  assert.equal(fixture.enqueued[0].data.mode, 'refresh');
});

test('refresh run persists candidate list, records completed keys, and preserves source checkpoint', async () => {
  const fixture = makeService({ candidates: [occurrence('18970'), occurrence('18971')] });
  const run = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 2, completedKeys: [] } },
  });

  const finished = await fixture.service.executeRefreshRun(run._id, 2);

  assert.equal(finished.status, 'Succeeded');
  assert.equal(finished.stats.seen, 2);
  assert.equal(finished.stats.updated, 2);
  assert.deepEqual(fixture.repository.source.checkpoint, { page: 9 });
  assert.deepEqual(finished.requestMetadata.refresh.candidates.map((item) => item.externalId), ['18970', '18971']);
  assert.equal(finished.requestMetadata.refresh.candidates.some((item) => item.occurrence || item.rawPayload), false);
  assert.deepEqual(finished.requestMetadata.refresh.completedKeys, ['opp-1:18970', 'opp-2:18971']);
  assert.equal(fixture.repository.health.at(-1).healthState, 'Healthy');
  assert.equal(fixture.repository.health.at(-1).lastSuccessAt.toISOString(), finished.finishedAt.toISOString());
  assert.equal(fixture.repository.health.at(-1).healthMessage, undefined);
  assert.equal(fixture.repository.health.at(-1).lastError, undefined);
});

test('refresh retry skips completed candidates from persisted metadata', async () => {
  let calls = 0;
  const connector = {
    id: 'workspace',
    capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
    validateConfig: async () => ({ ok: true }),
    refresh: async (candidate) => {
      calls += 1;
      if (candidate.externalId === '18971' && calls === 2) throw new Error('detail failed');
      return { record: rawRecord(candidate.externalId) };
    },
  };
  const fixture = makeService({ connector, candidates: [occurrence('18970'), occurrence('18971')] });
  const run = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 2, completedKeys: [] } },
  });

  await assert.rejects(() => fixture.service.executeRefreshRun(run._id, 2), /detail failed/);
  assert.deepEqual(fixture.repository.runs.get(run._id).requestMetadata.refresh.completedKeys, ['opp-1:18970']);
  fixture.repository.runs.get(run._id).status = 'Queued';

  const finished = await fixture.service.executeRefreshRun(run._id, 2);

  assert.equal(finished.status, 'Succeeded');
  assert.equal(calls, 3);
  assert.deepEqual(finished.requestMetadata.refresh.completedKeys, ['opp-1:18970', 'opp-2:18971']);
});

test('refresh refuses records whose native identity differs from the retained occurrence', async () => {
  const fixture = makeService({
    connector: {
      id: 'workspace',
      capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
      validateConfig: async () => ({ ok: true }),
      refresh: async () => ({ record: rawRecord('different', { url: 'https://workspace.ru/tenders/different/' }) }),
    },
  });
  const run = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, completedKeys: [] } },
  });

  await assert.rejects(() => fixture.service.executeRefreshRun(run._id, 1), /identity mismatch/);
  assert.equal(fixture.repository.runs.get(run._id).status, 'Failed');
  assert.equal(fixture.repository.dlq.length, 1);
});

test('refresh refuses a same-URL record with a different native id', async () => {
  const fixture = makeService({
    connector: {
      id: 'workspace',
      capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
      validateConfig: async () => ({ ok: true }),
      refresh: async () => ({ record: rawRecord('different', { url: 'https://workspace.ru/tenders/18970/' }) }),
    },
  });
  const run = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, completedKeys: [] } },
  });

  await assert.rejects(() => fixture.service.executeRefreshRun(run._id, 1), /identity mismatch/);
  assert.equal(fixture.repository.runs.get(run._id).status, 'Failed');
});

test('refresh null result fails explicitly instead of marking the source healthy', async () => {
  const fixture = makeService({
    connector: {
      id: 'workspace',
      capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
      validateConfig: async () => ({ ok: true }),
      refresh: async () => ({ record: null }),
    },
  });
  const run = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, completedKeys: [] } },
  });

  await assert.rejects(() => fixture.service.executeRefreshRun(run._id, 1), /returned no record/);
  assert.equal(fixture.repository.runs.get(run._id).status, 'Failed');
  assert.equal(fixture.repository.dlq.length, 1);
  assert.equal(fixture.repository.health.at(-1).healthState, 'Degraded');
});

test('refresh rate limit keeps the run queued and schedules delayed retry', async () => {
  const fixture = makeService({
    connector: {
      id: 'workspace',
      capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
      validateConfig: async () => ({ ok: true }),
      refresh: async () => { throw new ConnectorRateLimitError('slow down', 12); },
    },
  });
  const run = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'scheduled',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, completedKeys: [] } },
  });

  const queued = await fixture.service.executeRefreshRun(run._id, 1);

  assert.equal(queued.status, 'Queued');
  assert.equal(fixture.enqueued[0].name, 'source.refreshActive');
  assert.equal(fixture.enqueued[0].options.delay, 12_000);
});

test('refresh converts typed web extraction 429 retry-after date to delayed retry', async () => {
  const retryAt = new Date(Date.now() + 45_000).toUTCString();
  const fixture = makeService({
    connector: {
      id: 'workspace',
      capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
      validateConfig: async () => ({ ok: true }),
      refresh: async () => { throw new WebExtractionHttpError(429, 'https://workspace.ru/tenders/18970/', { accessReason: 'rate_limited', retryAfter: retryAt }); },
    },
  });
  const run = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'scheduled',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, completedKeys: [] } },
  });

  const queued = await fixture.service.executeRefreshRun(run._id, 1);

  assert.equal(queued.status, 'Queued');
  assert.equal(fixture.repository.health.at(-1).healthState, 'Degraded');
  assert.ok(fixture.enqueued[0].options.delay >= 1_000);
  assert.ok(fixture.enqueued[0].options.delay <= 45_000);
});

test('refresh passes timeout abort signals and honors stop after fetch before ingest', async () => {
  let seenSignal;
  const repository = new InMemorySourceRepository(source({ timeoutMs: 1000 }));
  let run;
  const fixture = makeService({
    repository,
    connector: {
      id: 'workspace',
      capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
      validateConfig: async () => ({ ok: true }),
      refresh: async (_candidate, ctx) => {
        seenSignal = ctx.signal;
        await repository.requestStop(run._id);
        return { record: rawRecord('18970') };
      },
    },
    ingest: {
      ingestFromSource: async () => {
        throw new Error('ingest must not run after stop');
      },
    },
  });
  run = await repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, completedKeys: [] } },
  });

  const stopped = await fixture.service.executeRefreshRun(run._id, 1);

  assert.equal(stopped.status, 'Cancelled');
  assert.ok(seenSignal instanceof AbortSignal);
});

test('refresh keeps pending normalized record on ingest failure and retries without refetching changed native fields', async () => {
  let refreshes = 0;
  let firstIngest = true;
  const fixture = makeService({
    connector: {
      id: 'workspace',
      capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
      validateConfig: async () => ({ ok: true }),
      refresh: async () => {
        refreshes += 1;
        return { record: rawRecord('18970', { title: 'Original title' }) };
      },
    },
    ingest: {
      ingestFromSource: async ({ records }) => {
        assert.equal(records[0].title, 'Original title');
        if (firstIngest) {
          firstIngest = false;
          return { seen: records.length, normalized: records.length, upserted: 0, created: 0, updated: 0, duplicates: 0, failed: 1, opportunityIds: [], failures: [{ index: 0, reason: 'temporary write failure', transient: false }] };
        }
        return { seen: records.length, normalized: records.length, upserted: 1, created: 0, updated: 1, duplicates: 0, failed: 0, opportunityIds: ['opp-1'], failures: [] };
      },
    },
  });
  const run = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, completedKeys: [] } },
  });

  await assert.rejects(() => fixture.service.executeRefreshRun(run._id, 1), /temporary write failure/);
  assert.equal(fixture.repository.runs.get(run._id).requestMetadata.pendingRefreshIngest.records[0].title, 'Original title');
  fixture.repository.runs.get(run._id).status = 'Queued';
  fixture.repository.runs.get(run._id).requestMetadata.refresh.candidates[0].url = 'https://workspace.ru/tenders/changed/';

  const finished = await fixture.service.executeRefreshRun(run._id, 1);

  assert.equal(finished.status, 'Succeeded');
  assert.equal(refreshes, 1);
  assert.deepEqual(finished.requestMetadata.refresh.completedKeys, ['opp-1:18970']);
});

test('scheduled refresh candidate query uses source and reduced closed cadence while manual ids bypass cadence', async () => {
  const fixture = makeService();
  const scheduledRun = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'scheduled',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', scheduled: true, refresh: { version: 1, limit: 1, completedKeys: [] } },
  });
  await fixture.service.executeRefreshRun(scheduledRun._id, 1);
  assert.equal(fixture.candidateQueries[0].ignoreCadence, false);
  assert.ok(fixture.candidateQueries[0].activeCutoff instanceof Date);
  assert.ok(fixture.candidateQueries[0].inactiveCutoff instanceof Date);
  assert.ok(fixture.candidateQueries[0].activeCutoff.getTime() > fixture.candidateQueries[0].inactiveCutoff.getTime());

  const manualRun = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, requestedOpportunityIds: ['opp-1'], completedKeys: [] } },
  });
  await fixture.service.executeRefreshRun(manualRun._id, 1);
  assert.equal(fixture.candidateQueries[1].ignoreCadence, true);
  assert.deepEqual(fixture.candidateQueries[1].opportunityIds, ['opp-1']);
});

test('refresh converts typed 404 into durable removed completion without ingestion or checkpoint changes', async () => {
  const removals = [];
  const fixture = makeService({
    connector: {
      id: 'workspace',
      capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
      validateConfig: async () => ({ ok: true }),
      refresh: async () => { throw new WebExtractionHttpError(404, 'https://workspace.ru/tenders/18970/'); },
    },
    ingest: {
      ingestFromSource: async () => { throw new Error('ingest must not run for confirmed removal'); },
      markSourceOccurrenceRemoved: async (input) => {
        removals.push(input);
        return { opportunityId: input.opportunityId, sourceStatus: 'Removed' };
      },
    },
  });
  const run = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, completedKeys: [] } },
  });

  const finished = await fixture.service.executeRefreshRun(run._id, 1);

  assert.equal(finished.status, 'Succeeded');
  assert.deepEqual(fixture.repository.source.checkpoint, { page: 9 });
  assert.equal(finished.stats.seen, 1);
  assert.equal(finished.stats.upserted, 1);
  assert.equal(finished.stats.updated, 1);
  assert.deepEqual(finished.requestMetadata.refresh.completedKeys, ['opp-1:18970']);
  assert.deepEqual(finished.requestMetadata.refresh.removedKeys, ['opp-1:18970']);
  assert.equal(removals.length, 1);
  assert.deepEqual(
    { opportunityId: removals[0].opportunityId, sourceId: removals[0].sourceId, externalId: removals[0].externalId, url: removals[0].url, reason: removals[0].reason, runId: removals[0].runId },
    { opportunityId: 'opp-1', sourceId: 'workspace', externalId: '18970', url: 'https://workspace.ru/tenders/18970/', reason: 'HTTP 404', runId: run._id },
  );
});

test('refresh converts typed 410 once and skips durable removed candidate on retry', async () => {
  let refreshes = 0;
  let removals = 0;
  const fixture = makeService({
    connector: {
      id: 'workspace',
      capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
      validateConfig: async () => ({ ok: true }),
      refresh: async () => {
        refreshes += 1;
        throw new WebExtractionHttpError(410, 'https://workspace.ru/tenders/18970/');
      },
    },
    ingest: {
      ingestFromSource: async () => { throw new Error('ingest must not run for confirmed removal'); },
      markSourceOccurrenceRemoved: async (input) => {
        removals += 1;
        return { opportunityId: input.opportunityId, sourceStatus: 'Removed' };
      },
    },
  });
  const run = await fixture.repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, completedKeys: [] } },
  });

  const first = await fixture.service.executeRefreshRun(run._id, 1);
  fixture.repository.runs.get(run._id).status = 'Queued';
  const second = await fixture.service.executeRefreshRun(run._id, 1);

  assert.equal(first.status, 'Succeeded');
  assert.equal(second.status, 'Succeeded');
  assert.equal(refreshes, 1);
  assert.equal(removals, 1);
  assert.equal(second.stats.seen, 1);
  assert.deepEqual(second.requestMetadata.refresh.completedKeys, ['opp-1:18970']);
  assert.deepEqual(second.requestMetadata.refresh.removedKeys, ['opp-1:18970']);
});

test('refresh honors stop after confirmed removal before final success', async () => {
  let run;
  const repository = new InMemorySourceRepository();
  const fixture = makeService({
    repository,
    connector: {
      id: 'workspace',
      capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }),
      validateConfig: async () => ({ ok: true }),
      refresh: async () => { throw new WebExtractionHttpError(404, 'https://workspace.ru/tenders/18970/'); },
    },
    ingest: {
      ingestFromSource: async () => { throw new Error('ingest must not run for confirmed removal'); },
      markSourceOccurrenceRemoved: async (input) => {
        await repository.requestStop(run._id);
        return { opportunityId: input.opportunityId, sourceStatus: 'Removed' };
      },
    },
  });
  run = await repository.createRun({
    sourceId: 'workspace',
    runType: 'manual',
    status: 'Queued',
    checkpointBefore: { page: 9 },
    requestMetadata: { mode: 'refresh', refresh: { version: 1, limit: 1, completedKeys: [] } },
  });

  const stopped = await fixture.service.executeRefreshRun(run._id, 1);

  assert.equal(stopped.status, 'Cancelled');
  assert.equal(stopped.stats.seen, 1);
  assert.deepEqual(stopped.requestMetadata.refresh.completedKeys, ['opp-1:18970']);
  assert.deepEqual(stopped.requestMetadata.refresh.removedKeys, ['opp-1:18970']);
  assert.equal(fixture.repository.health.length, 0);
});
