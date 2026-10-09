import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { SourcesService } = require('../src/modules/sources/sources.service.ts');
const { SOURCE_RUN_ACTIVE_COLLECTION_INDEX } = require('../src/modules/sources/schemas/source-run.schema.ts');

function source(id, family = 'PublicHtml', overrides = {}) {
  return { _id: id, connectorFamily: family, enabled: true, runtimeState: 'Enabled', intervalSeconds: 900, checkpoint: {}, config: {}, endpoint: {}, limits: { maxPages: 1 }, ...overrides };
}

function harness(sources, options = {}) {
  const rows = new Map(sources.map(item => [item._id, structuredClone(item)]));
  const runs = new Map();
  const schedulers = new Map(options.schedulers ?? []);
  const handlers = new Map();
  const removed = [];
  const fetched = [];
  const ingested = [];
  const queue = {
    getJobSchedulers: async () => [...schedulers].map(([key]) => ({ key })),
    removeJobScheduler: async id => { removed.push(id); return schedulers.delete(id); },
    upsertJobScheduler: async (id, repeat, template) => { schedulers.set(id, { repeat, template }); return { id }; },
  };
  const repository = {
    ensureCatalog: async () => undefined,
    list: async ({ cursor, limit }) => {
      const ordered = [...rows.values()].sort((a, b) => a._id.localeCompare(b._id)).filter(item => !cursor || item._id > cursor);
      const items = ordered.slice(0, limit);
      return { items: structuredClone(items), nextCursor: ordered.length > limit ? items.at(-1)._id : null };
    },
    get: async id => structuredClone(rows.get(id)),
    update: async (id, patch) => { rows.set(id, { ...rows.get(id), ...patch }); return structuredClone(rows.get(id)); },
    createRun: async input => {
      if (options.createRunConflict) throw options.createRunConflict;
      const row = { _id: crypto.randomUUID(), stats: {}, checkpointAfter: {}, requestMetadata: {}, ...input };
      runs.set(row._id, row);
      return structuredClone(row);
    },
    findActiveRun: async id => structuredClone([...runs.values()].find(row => row.sourceId === id && ['Queued', 'Running'].includes(row.status)) ?? null),
    latestCollectionRun: async id => structuredClone([...runs.values()].filter(row => row.sourceId === id).at(-1) ?? null),
    startRun: async id => {
      const row = runs.get(id);
      if (!row || !['Queued', 'Failed'].includes(row.status) || row.requestedStopAt) return null;
      Object.assign(row, { status: 'Running', error: undefined, finishedAt: undefined });
      return structuredClone(row);
    },
    getRun: async id => structuredClone(runs.get(id)),
    updateRun: async (id, patch) => { Object.assign(runs.get(id), patch); return structuredClone(runs.get(id)); },
    finishRunIfNotStopped: async (id, patch) => {
      const row = runs.get(id);
      if (row.status === 'Running' && !row.requestedStopAt) Object.assign(row, patch);
      return structuredClone(row);
    },
    updateCheckpoint: async (id, checkpoint) => { rows.get(id).checkpoint = structuredClone(checkpoint); },
    updateHealth: async () => undefined,
    createDlq: async () => undefined,
  };
  const connector = {
    id: 'fixture-public',
    capabilities: () => ({ supportsBackfill: true, supportsIncremental: true, requiresCredentials: false }),
    validateConfig: async config => ({ ok: config.invalid !== true && (!config.needsCredentials || Boolean(config.credentials?.accessToken)) }),
    discover: async () => ({ ok: true, details: { tenants: options.discoveryTenants ?? ['observed-board'] } }),
    fetchPage: async ctx => {
      fetched.push(structuredClone(ctx));
      return { records: [{ externalId: 'public-1', publishedAt: new Date(), title: 'Observed fixture record' }], hasMore: false, checkpoint: { hasMore: false }, stats: { seen: 1 } };
    },
    checkpoint: page => page.checkpoint,
  };
  const service = new SourcesService(repository,
    { get: item => item.config.unsupported ? { ...connector, capabilities: () => ({ supportsBackfill: false, supportsIncremental: false }) } : connector },
    { normalize: (_item, record) => record }, { collapseBatch: records => ({ records, duplicates: 0 }) },
    { encrypt: value => value, decrypt: value => value }, { record: async () => undefined },
    { queue: () => queue, enqueue: async () => ({ id: crypto.randomUUID(), queue: 'ingestion' }), registerHandler: (family, name, handler) => handlers.set(family + '/' + name, handler) },
    { publish: () => undefined },
    { ingestFromSource: async input => { ingested.push(input); return { seen: input.records.length, normalized: input.records.length, upserted: input.records.length, created: input.records.length, updated: 0, duplicates: 0, failed: 0 }; } },
  );
  return { service, rows, runs, schedulers, removed, fetched, ingested, handlers, repository };
}

async function withScheduler(value, callback) {
  const previous = process.env.SOURCE_SCHEDULER_ENABLED;
  process.env.SOURCE_SCHEDULER_ENABLED = value;
  try { await callback(); } finally {
    if (previous === undefined) delete process.env.SOURCE_SCHEDULER_ENABLED;
    else process.env.SOURCE_SCHEDULER_ENABLED = previous;
  }
}

test('startup schedules every configured supported family and excludes unavailable configurations', async () => withScheduler('true', async () => {
  const fixture = harness([
    source('public'), source('feed', 'OfficialFeed'), source('api', 'OfficialRestApi'),
    source('tender', 'TenderPlatform'), source('conditional', 'PublicHtml', { runtimeState: 'Conditional' }),
    source('ats', 'AtsPublicBoard', { config: { discoveryUrls: ['https://careers.example.test'] } }),
    source('telegram', 'TelegramMtproto'), source('vk', 'VkWall'),
    source('authenticated', 'AuthenticatedMarketplace', { config: { needsCredentials: true }, credentialsEncrypted: JSON.stringify({ accessToken: 'fixture-only' }) }),
    source('disabled', 'PublicHtml', { enabled: false }), source('maintenance', 'PublicHtml', { runtimeState: 'Maintenance' }),
    source('unsupported', 'PublicHtml', { config: { unsupported: true } }),
    source('invalid', 'PublicHtml', { config: { invalid: true } }),
    source('missing-key', 'AuthenticatedMarketplace', { config: { needsCredentials: true } }),
    source('ats-no-seeds', 'AtsPublicBoard'), source('zero-interval', 'PublicHtml', { intervalSeconds: 0 }),
  ]);
  await fixture.service.onModuleInit();
  assert.deepEqual([...fixture.schedulers.keys()].sort(), [
    'source:api:source.fetchPage', 'source:ats:ats.poll', 'source:authenticated:source.fetchPage',
    'source:conditional:source.fetchPage', 'source:feed:source.fetchPage', 'source:public:source.fetchPage',
    'source:telegram:telegram.poll', 'source:tender:source.fetchPage', 'source:vk:vk.poll',
  ].sort());
  const scheduled = fixture.schedulers.get('source:public:source.fetchPage');
  assert.equal(scheduled.repeat.every, 900_000);
  assert.deepEqual(scheduled.template.data, { sourceId: 'public', scheduled: true, backfillDays: 30 });
  assert.equal(scheduled.template.opts.attempts, 5);
  assert.equal(scheduled.template.opts.jobId, undefined);
}));

test('configured ATS schedules require valid boards while unconfigured discovery seeds remain eligible', async () => withScheduler('true', async () => {
  const fixture = harness([
    source('ats-valid', 'AtsPublicBoard', { config: { tenants: ['observed-board'] } }),
    source('ats-invalid', 'AtsPublicBoard', { config: { tenants: ['unsafe-board'], invalid: true } }),
    source('ats-discoverable', 'AtsPublicBoard', { config: { discoveryUrls: ['https://careers.example.test'] } }),
  ]);
  await fixture.service.onModuleInit();
  assert.deepEqual([...fixture.schedulers.keys()].sort(), ['source:ats-discoverable:ats.poll', 'source:ats-valid:ats.poll']);
}));

test('automatic and explicit Workday discovery preserve case-sensitive board URL paths', async () => withScheduler('false', async () => {
  const board = 'https://workday.wd5.myworkdayjobs.com/en-US/Workday';
  const fixture = harness([source('workday', 'AtsPublicBoard', { config: { discoveryUrls: [board] } })], { discoveryTenants: [board] });
  const initial = await fixture.repository.get('workday');
  const prepared = await fixture.service.prepareSourceForPolling(initial, { discover: async () => ({ ok: true, details: { tenants: [board] } }) }, 'qa-case-sensitive', undefined);
  assert.deepEqual(prepared.config.tenants, [board]);
  const result = await fixture.service.discover({ id: 'admin' }, 'workday');
  assert.deepEqual(result.source.config.tenants, [board]);
}));

test('startup reconciles stale source schedulers without removing unrelated schedules', async () => withScheduler('true', async () => {
  const fixture = harness([source('public')], { schedulers: [['source:old:ats.poll', {}], ['source:public:ats.poll', {}], ['other:retained', {}]] });
  await fixture.service.onModuleInit();
  assert.deepEqual(fixture.removed.sort(), ['source:old:ats.poll', 'source:public:ats.poll']);
  assert.deepEqual([...fixture.schedulers.keys()].sort(), ['other:retained', 'source:public:source.fetchPage']);
}));

test('global scheduler off removes owned future schedules and stale ticks create no runs', async () => withScheduler('false', async () => {
  const fixture = harness([source('public')], { schedulers: [['source:public:source.fetchPage', {}], ['other:retained', {}]] });
  await fixture.service.onModuleInit();
  const result = await fixture.handlers.get('ingestion/source.fetchPage')({ sourceId: 'public', scheduled: true });
  assert.equal(result.skipped, true);
  assert.equal(fixture.runs.size, 0);
  assert.equal(fixture.fetched.length, 0);
  assert.deepEqual([...fixture.schedulers.keys()], ['other:retained']);
}));

test('interval and enabled settings reconcile one stable schedule immediately', async () => withScheduler('true', async () => {
  const fixture = harness([source('public')]);
  await fixture.service.onModuleInit();
  await fixture.service.update({ id: 'admin' }, 'public', { intervalSeconds: 1800 });
  assert.equal(fixture.schedulers.size, 1);
  assert.equal(fixture.schedulers.get('source:public:source.fetchPage').repeat.every, 1_800_000);
  await fixture.service.update({ id: 'admin' }, 'public', { enabled: false });
  assert.equal(fixture.schedulers.size, 0);
  const result = await fixture.handlers.get('ingestion/source.fetchPage')({ sourceId: 'public', scheduled: true });
  assert.equal(result.skipped, true);
  assert.equal(fixture.runs.size, 0);
  await fixture.service.update({ id: 'admin' }, 'public', { enabled: true });
  assert.equal(fixture.schedulers.size, 1);
}));

test('adding credentials or discovered ATS boards starts the previously unavailable schedule', async () => withScheduler('true', async () => {
  const fixture = harness([source('private', 'AuthenticatedMarketplace', { config: { needsCredentials: true } }), source('ats', 'AtsPublicBoard')]);
  await fixture.service.onModuleInit();
  assert.equal(fixture.schedulers.size, 0);
  await fixture.service.update({ id: 'admin' }, 'private', { credentials: { accessToken: 'fixture-only' } });
  await fixture.service.discover({ id: 'admin' }, 'ats');
  assert.deepEqual([...fixture.schedulers.keys()].sort(), ['source:ats:ats.poll', 'source:private:source.fetchPage']);
}));

test('scheduler registration includes sources after the first 200-row registry page', async () => withScheduler('true', async () => {
  const fixture = harness(Array.from({ length: 205 }, (_, index) => source('public-' + index.toString().padStart(3, '0'))));
  await fixture.service.onModuleInit();
  assert.equal(fixture.schedulers.size, 205);
  assert.ok(fixture.schedulers.has('source:public-204:source.fetchPage'));
}));

test('scheduled ticks leave an existing manual or backfill run and its frozen checkpoint untouched', async () => withScheduler('true', async () => {
  const fixture = harness([source('public')]);
  await fixture.service.onModuleInit();
  const existing = await fixture.repository.createRun({ sourceId: 'public', runType: 'backfill', status: 'Queued', checkpointAfter: { hasMore: true, nextPage: 39, backfillSince: '2026-09-04T00:00:00Z' } });
  const result = await fixture.handlers.get('ingestion/source.fetchPage')({ sourceId: 'public', scheduled: true });
  assert.equal(result.skipped, true);
  assert.equal(result.existingRunId, existing._id);
  assert.equal(fixture.runs.size, 1);
  assert.deepEqual((await fixture.repository.getRun(existing._id)).checkpointAfter, existing.checkpointAfter);
  assert.equal(fixture.fetched.length, 0);
}));

test('the next scheduled tick resumes the same failed run with its original window', async () => withScheduler('true', async () => {
  const fixture = harness([source('public')]);
  await fixture.service.onModuleInit();
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const existing = await fixture.repository.createRun({ sourceId: 'public', runType: 'scheduled', status: 'Failed', checkpointAfter: { hasMore: true, nextPage: 17 }, requestMetadata: { backfillDays: 30, backfillSince: since }, stats: { seen: 40, upserted: 40 } });
  const result = await fixture.handlers.get('ingestion/source.fetchPage')({ sourceId: 'public', scheduled: true, backfillDays: 30 });
  assert.equal(result._id, existing._id);
  assert.equal(result.status, 'Succeeded');
  assert.equal(fixture.runs.size, 1);
  assert.equal(fixture.fetched[0].backfillSince, since);
  assert.equal(fixture.fetched[0].checkpoint.nextPage, 17);
  assert.equal(result.stats.upserted, 41);
}));

test('a completed scheduled collection permits a fresh following scan', async () => withScheduler('true', async () => {
  const fixture = harness([source('public')]);
  await fixture.service.onModuleInit();
  const tick = fixture.handlers.get('ingestion/source.fetchPage');
  const first = await tick({ sourceId: 'public', scheduled: true, backfillDays: 30 });
  const second = await tick({ sourceId: 'public', scheduled: true, backfillDays: 30 });
  assert.notEqual(first._id, second._id);
  assert.equal(first.status, 'Succeeded');
  assert.equal(second.status, 'Succeeded');
  assert.equal(fixture.ingested.length, 2);
}));

test('a simultaneous collection claim produces a skipped scheduled tick or explicit manual conflict', async () => withScheduler('true', async () => {
  const conflict = { code: 11000, index: SOURCE_RUN_ACTIVE_COLLECTION_INDEX, keyPattern: { sourceId: 1 } };
  const fixture = harness([source('public')], { createRunConflict: conflict });
  await fixture.service.onModuleInit();
  const result = await fixture.handlers.get('ingestion/source.fetchPage')({ sourceId: 'public', scheduled: true });
  assert.equal(result.skipped, true);
  await assert.rejects(fixture.service.run({ id: 'admin' }, 'public', { runType: 'backfill' }), error => error.getStatus() === 409 && error.getResponse().code === 'SOURCE_RUN_ACTIVE');
  assert.equal(fixture.fetched.length, 0);
}));

test('all queued collection and refresh handlers store compact receipts while Mongo keeps resumable checkpoints', async () => withScheduler('false', async () => {
  const fixture = harness([source('public')]);
  await fixture.service.onModuleInit();
  const seenIds = Array.from({ length: 30_000 }, (_, index) => `native-${index}`);
  const checkpoint = { seenExternalIds: seenIds, nextPage: 230, windowSince: '2026-09-05T00:00:00Z', hasMore: true };
  const run = await fixture.repository.createRun({
    sourceId: 'public', runType: 'backfill', status: 'Queued', checkpointBefore: checkpoint,
    checkpointAfter: checkpoint, stats: { seen: 30_000, upserted: 29_999 },
    requestMetadata: { pendingIngest: { records: [{ description: 'full native detail' }] }, backfillDays: 30 },
  });
  fixture.service.executeRun = async () => fixture.repository.getRun(run._id);
  fixture.service.executeRefreshRun = async () => fixture.repository.getRun(run._id);
  for (const name of ['source.fetchPage', 'source.backfill', 'source.refreshActive', 'telegram.poll', 'vk.poll', 'ats.poll']) {
    const result = await fixture.handlers.get(`ingestion/${name}`)({ runId: run._id, sourceId: 'public', mode: name === 'source.refreshActive' ? 'refresh' : undefined });
    assert.equal(result._id, run._id);
    assert.equal(result.sourceId, 'public');
    assert.equal(result.status, 'Queued');
    assert.equal(result.stats.upserted, 29_999);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024, 'queue receipt stays bounded independently of accumulated checkpoint');
    assert.equal(result.checkpointBefore, undefined);
    assert.equal(result.checkpointAfter, undefined);
    assert.equal(result.requestMetadata, undefined);
    const persisted = await fixture.repository.getRun(run._id);
    assert.deepEqual(persisted.checkpointAfter, checkpoint);
    assert.equal(persisted.requestMetadata.pendingIngest.records[0].description, 'full native detail');
  }
}));

test('unrelated database errors do not become a skipped scheduled collection', async () => withScheduler('true', async () => {
  const failure = new Error('unrelated storage failure');
  const fixture = harness([source('public')], { createRunConflict: failure });
  await fixture.service.onModuleInit();
  await assert.rejects(fixture.handlers.get('ingestion/source.fetchPage')({ sourceId: 'public', scheduled: true }), /unrelated storage failure/);
}));
