import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { BadRequestException, ConflictException } = require('@nestjs/common');
const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');
const { AdminSearchController } = require('../src/modules/search/search.controller.ts');
const { MeiliSearchService } = require('../src/modules/search/meili-search.service.ts');
const { SearchService } = require('../src/modules/search/search.service.ts');

describe('admin search maintenance contracts', () => {
  it('exposes maintenance and confirmed rebuild routes for the admin UI', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminSearchController.prototype.maintenance), 'maintenance');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminSearchController.prototype.maintenance), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminSearchController.prototype.rebuild), 'rebuild');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminSearchController.prototype.rebuild), RequestMethod.POST);
  });

  it('requires explicit confirmation, stores a rebuild record, locks exclusively and audits the admin actor', async () => {
    const env = serviceEnv();

    await assert.rejects(() => env.service.adminRebuild(adminActor(), {}), BadRequestException);
    const result = await env.service.adminRebuild(adminActor(), { confirmed: true });

    assert.equal(result.queue, 'search');
    assert.equal(env.jobs.enqueued[0].name, 'rebuild');
    assert.match(env.jobs.enqueued[0].options.jobId, /^search-rebuild:/);
    assert.equal(env.rebuilds.records.size, 1);
    assert.equal(env.locks.record.jobId, result.id);
    assert.deepEqual(env.audit.events.map((event) => event.action), ['search.rebuild.enqueue']);
  });

  it('does not unlock a rebuild after enqueue when a post-enqueue side effect fails', async () => {
    const env = serviceEnv();
    const update = env.rebuilds.updateOne.bind(env.rebuilds);
    env.rebuilds.updateOne = async (filter, patch) => { if (patch.$set?.jobId === 'job-1') throw new Error('receipt update down'); return update(filter, patch); };

    const result = await env.service.adminRebuild(adminActor(), { confirmed: true });

    assert.equal(result.id, 'job-1');
    assert.equal(env.jobs.enqueued.length, 1);
    assert.ok(env.locks.record);
    assert.equal(env.rebuilds.records.values().next().value.status, 'Queued');
  });

  it('does not enqueue unaudited maintenance when audit storage is unavailable', async () => {
    const env = serviceEnv();
    env.audit.record = async () => { throw new Error('audit unavailable'); };
    await assert.rejects(() => env.service.adminRebuild(adminActor(), { confirmed: true }), /audit unavailable/);
    assert.equal(env.jobs.enqueued.length, 0);
    assert.equal(env.locks.record, null);
  });

  it('reads the current document after a writer has waited for publication', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    const begin = env.service.beginSearchWriter.bind(env.service);
    env.service.beginSearchWriter = async () => {
      env.models.opportunities.rows[0] = { ...env.models.opportunities.rows[0], title: 'Current after publication' };
      return begin();
    };
    await env.service.indexOpportunity('opp-1');
    assert.equal(env.meili.liveUpserts[0].documents[0].title, 'Current after publication');
    assert.equal(env.writers.records.length, 0);
  });

  it('rejects a second rebuild while a durable active lock is still valid', async () => {
    const env = serviceEnv();
    env.locks.record = {
      _id: 'search-rebuild',
      jobId: 'job-active',
      rebuildId: 'active-rebuild',
      stagingPrefix: 'active_stage',
      lockedUntil: new Date(Date.now() + 60_000),
    };

    await assert.rejects(() => env.service.adminRebuild(adminActor(), { confirmed: true }), ConflictException);
    assert.equal(env.jobs.enqueued.length, 0);
  });

  it('uses an atomic durable lock so simultaneous rebuild requests cannot both enqueue', async () => {
    const env = serviceEnv();

    const settled = await Promise.allSettled([
      env.service.adminRebuild(adminActor(), { confirmed: true }),
      env.service.adminRebuild(adminActor(), { confirmed: true }),
    ]);

    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((item) => item.status === 'rejected' && item.reason instanceof ConflictException).length, 1);
    assert.equal(env.jobs.enqueued.length, 1);
  });

  it('returns a stable maintenance snapshot without changing the existing indexes response contract', async () => {
    const env = serviceEnv();
    await env.service.adminRebuild(adminActor(), { confirmed: true });
    const maintenance = await env.service.adminMaintenance();
    const indexes = await env.service.adminIndexes();

    assert.equal(maintenance.status, 'configured');
    assert.equal(maintenance.active.queue, 'search');
    assert.equal(maintenance.active.id, 'job-1');
    assert.match(maintenance.active.rebuildId, /^[0-9a-f-]{36}$/);
    assert.equal(maintenance.active.state, 'queued');
    assert.equal(maintenance.backlog, 1);
    assert.deepEqual(indexes, {
      items: [
        { name: 'opportunities', available: true, raw: { numberOfDocuments: 1 } },
        { name: 'knowledge_chunks', available: false },
        { name: 'tasks', available: false },
        { name: 'profiles', available: false },
        { name: 'watchlists', available: false },
      ],
      nextCursor: null,
    });
  });
});

describe('search full rebuild safety', () => {
  it('streams canonical rows in bounded batches, waits tasks, swaps atomically after all staging indexes are complete, then cleans old live indexes', async () => {
    const opportunities = Array.from({ length: 501 }, (_, index) => opportunity(`opp-${index}`));
    const env = serviceEnv({ opportunities, tasks: [task('task-1')], profiles: [profile('profile-1')], watchlists: [watchlist('watchlist-1')], knowledgeChunks: [chunk('chunk-1')] });
    const job = fakeJob();

    const result = await env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, job);

    assert.equal(result.status, 'completed');
    assert.deepEqual(env.meili.prepared, ['stage_1_opportunities', 'stage_1_tasks', 'stage_1_profiles', 'stage_1_watchlists', 'stage_1_knowledge_chunks']);
    assert.equal(Math.max(...env.meili.adds.map((call) => call.documents.length)), 500);
    assert.deepEqual(env.meili.adds.filter((call) => call.index === 'stage_1_opportunities').map((call) => call.documents.length), [500, 1]);
    assert.deepEqual(env.meili.swaps, [[
      { indexes: ['opportunities', 'stage_1_opportunities'] },
      { indexes: ['tasks', 'stage_1_tasks'] },
      { indexes: ['profiles', 'stage_1_profiles'] },
      { indexes: ['watchlists', 'stage_1_watchlists'] },
      { indexes: ['knowledge_chunks', 'stage_1_knowledge_chunks'] },
    ]]);
    assert.deepEqual(env.meili.cleaned, ['stage_1_opportunities', 'stage_1_tasks', 'stage_1_profiles', 'stage_1_watchlists', 'stage_1_knowledge_chunks']);
    assert.equal(env.locks.record, null);
    assert.equal(env.rebuilds.records.get('rebuild-1').status, 'Succeeded');
    assert.equal(job.progress.at(-1).stage, 'completed');
  });

  it('skips knowledge chunks whose parent document is disabled during a full rebuild', async () => {
    const env = serviceEnv({ documents: [{ _id: 'doc-1', title: 'Disabled doc', mode: 'disabled' }], knowledgeChunks: [chunk('chunk-1')] });

    await env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob());

    assert.equal(env.meili.adds.some((call) => call.index === 'stage_1_knowledge_chunks'), false);
  });

  it('replays concurrent update journal into staging before swap and blocks new updates during publish', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    env.locks.record = {
      _id: 'search-rebuild',
      jobId: 'job-1',
      rebuildId: 'rebuild-1',
      stagingPrefix: 'stage_1',
      lockedUntil: new Date(Date.now() + 60_000),
      phase: 'building',
    };

    await env.service.indexOpportunity('opp-1');
    await env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob());

    assert.equal(env.mutations.records.length, 1);
    assert.equal(env.meili.adds.some((call) => call.index === 'stage_1_opportunities' && call.documents[0].id === 'opp-1'), true);
  });

  it('waits through publishing without holding a writer record that would deadlock drain', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    env.locks.record = { _id: 'search-rebuild', jobId: 'job-1', rebuildId: 'rebuild-1', stagingPrefix: 'stage_1', lockedUntil: new Date(Date.now() - 60_000), phase: 'publishing' };
    env.service.delay = async () => { env.locks.record = null; };

    await env.service.indexOpportunity('opp-1');

    assert.equal(env.meili.liveUpserts.length, 1);
    assert.equal(env.writers.records.length, 0);
  });

  it('drains in-flight search writers before publishing and swapping', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    env.writers.records.push({ _id: 'writer-1', rebuildId: 'rebuild-1', lockedUntil: new Date(Date.now() + 60_000) });
    env.writers.releaseOnFirstCount = true;

    await env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob());

    assert.equal(env.meili.swaps.length, 1);
    assert.ok(env.writers.countCalls >= 2);
  });

  it('replays touched IDs from authoritative Mongo state instead of stale journal projections', async () => {
    const fresh = opportunity('opp-1');
    const env = serviceEnv({ opportunities: [fresh] });
    env.locks.record = { _id: 'search-rebuild', jobId: 'job-1', rebuildId: 'rebuild-1', stagingPrefix: 'stage_1', lockedUntil: new Date(Date.now() + 60_000), phase: 'building' };

    await env.service.indexOpportunity('opp-1');
    fresh.title = 'Fresh current title';
    await env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob());

    assert.equal(env.meili.adds.some((call) => call.index === 'stage_1_opportunities' && call.documents.some((doc) => doc.title === 'Fresh current title')), true);
  });

  it('journals a writer that started before a rebuild when a build appears before the live write completes', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    env.meili.onUpsert = async () => {
      env.locks.record = { _id: 'search-rebuild', jobId: 'job-1', rebuildId: 'rebuild-1', stagingPrefix: 'stage_1', lockedUntil: new Date(Date.now() + 60_000), phase: 'building' };
    };

    await env.service.indexOpportunity('opp-1');

    assert.equal(env.mutations.records.length, 1);
    assert.equal(env.mutations.records[0].rebuildId, 'rebuild-1');
    assert.equal(env.writers.records.length, 0);
  });

  it('stops before rebuilding when a prior swap submission is unresolved and has no task uid', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    await env.rebuilds.create({ _id: 'rebuild-1', status: 'Running', jobId: 'job-1', stagingPrefix: 'stage_1', stage: 'swap-submit-unknown' });
    env.locks.record = { _id: 'search-rebuild', jobId: 'job-1', rebuildId: 'rebuild-1', stagingPrefix: 'stage_1', lockedUntil: new Date(Date.now() - 60_000), phase: 'publishing' };

    await assert.rejects(() => env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob()), /unresolved/);

    assert.deepEqual(env.meili.prepared, []);
    assert.equal(env.meili.swaps.length, 0);
    assert.equal(env.locks.record.phase, 'publishing');
    assert.equal(env.rebuilds.records.get('rebuild-1').stage, 'swap-submit-unknown');
  });

  it('lets the same rebuild owner resume an expired publishing lock without resetting it to building', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    await env.rebuilds.create({ _id: 'rebuild-1', status: 'Running', jobId: 'job-1', stagingPrefix: 'stage_1', swapTaskUid: 99 });
    env.locks.record = { _id: 'search-rebuild', jobId: 'job-1', rebuildId: 'rebuild-1', stagingPrefix: 'stage_1', lockedUntil: new Date(Date.now() - 60_000), phase: 'publishing' };

    await env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob());

    assert.equal(env.meili.swaps.length, 0);
    assert.equal(env.rebuilds.records.get('rebuild-1').status, 'Succeeded');
  });

  it('keeps stale writers blocking publication without purging them or swapping', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    env.writers.records.push({ _id: 'stale-writer' });
    env.service.delay = async () => { throw new Error('Search rebuild could not drain 1 active search writer(s); live index retained'); };

    await assert.rejects(() => env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob()), /could not drain/);

    assert.equal(env.meili.swaps.length, 0);
    assert.equal(env.writers.records.length, 1);
    assert.equal(env.rebuilds.records.get('rebuild-1').status, 'Failed');
  });

  it('retains live indexes when journal persistence fails after a live update', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    env.locks.record = { _id: 'search-rebuild', jobId: 'job-1', rebuildId: 'rebuild-1', stagingPrefix: 'stage_1', lockedUntil: new Date(Date.now() + 60_000), phase: 'building' };
    env.mutations.failWrites = true;

    await assert.rejects(() => env.service.indexOpportunity('opp-1'), /journal unavailable/);
    await assert.rejects(() => env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob()), /journal failed/);
    assert.equal(env.meili.swaps.length, 0);
  });

  it('retains the publishing lock and staging indexes when swap submission is ambiguous', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    env.meili.failSwap = true;

    await assert.rejects(() => env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob()), /swap failed/);

    assert.equal(env.meili.swaps.length, 1);
    assert.deepEqual(env.meili.cleaned, []);
    assert.equal(env.rebuilds.records.get('rebuild-1').status, 'Running');
    assert.equal(env.rebuilds.records.get('rebuild-1').stage, 'swap-submit-unknown');
    assert.equal(env.locks.record.phase, 'publishing');
  });


  it('keeps a successful swapped rebuild successful when staging cleanup fails', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    env.meili.failCleanup = true;

    const result = await env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob());

    assert.equal(result.status, 'completed');
    assert.match(result.cleanupWarning, /cleanup stage_1_opportunities/);
    assert.equal(env.rebuilds.records.get('rebuild-1').status, 'Succeeded');
    assert.equal(env.locks.record, null);
  });


  it('resumes after a persisted successful swap by only cleaning staging indexes', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    await env.rebuilds.create({ _id: 'rebuild-1', status: 'Running', jobId: 'job-1', stagingPrefix: 'stage_1', swappedAt: new Date(), swapTaskUid: 99 });

    const result = await env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob());

    assert.equal(result.status, 'completed');
    assert.equal(env.meili.swaps.length, 0);
    assert.deepEqual(env.meili.cleaned, ['stage_1_opportunities', 'stage_1_tasks', 'stage_1_profiles', 'stage_1_watchlists', 'stage_1_knowledge_chunks']);
    assert.equal(env.rebuilds.records.get('rebuild-1').status, 'Succeeded');
  });


  it('resumes a recorded swap task without submitting a second swap', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    await env.rebuilds.create({ _id: 'rebuild-1', status: 'Running', jobId: 'job-1', stagingPrefix: 'stage_1', swapTaskUid: 99, taskUids: [1, 99] });

    const result = await env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob());

    assert.equal(result.status, 'completed');
    assert.equal(env.meili.swaps.length, 0);
    assert.deepEqual(env.meili.waitedTaskUids, [99]);
    assert.equal(env.rebuilds.records.get('rebuild-1').status, 'Succeeded');
  });


  it('retains publishing lock when a recorded swap task cannot be resolved', async () => {
    const env = serviceEnv({ opportunities: [opportunity('opp-1')] });
    env.meili.failWaitTaskUid = 99;
    await env.rebuilds.create({ _id: 'rebuild-1', status: 'Running', jobId: 'job-1', stagingPrefix: 'stage_1', swapTaskUid: 99, taskUids: [99] });

    await assert.rejects(() => env.service.rebuildAll({ rebuildId: 'rebuild-1', stagingPrefix: 'stage_1' }, fakeJob()), /recorded swap unresolved/);

    assert.equal(env.meili.swaps.length, 0);
    assert.equal(env.rebuilds.records.get('rebuild-1').stage, 'swap-resolution-failed');
    assert.equal(env.locks.record.phase, 'publishing');
  });
});

describe('meili search rebuild helpers', () => {
  it('uses the task namespace exposed by the installed Meilisearch SDK', async () => {
    const service = new MeiliSearchService({ get: key => key === 'MEILI_URL' ? 'http://127.0.0.1:7700' : undefined });
    const client = await service.client();
    assert.equal(typeof client.tasks.waitForTask, 'function');
  });

  it('waits exact task uid with a long timeout and does not invent task IDs', async () => {
    const service = Object.create(MeiliSearchService.prototype);
    const client = fakeMeiliClient();
    service.client = async () => client;

    await service.addDocumentsAwaited('opportunities', [{ id: 'opp-1' }]);

    assert.deepEqual(client.waits, [{ taskUid: 7, options: { timeout: 1_800_000, interval: 250 } }]);
    client.nextTask = {};
    await assert.rejects(() => service.addDocumentsAwaited('opportunities', [{ id: 'opp-2' }]), /taskUid/);
  });

  it('awaits document delete tasks instead of only enqueueing deletes', async () => {
    const service = Object.create(MeiliSearchService.prototype);
    const client = fakeMeiliClient();
    service.client = async () => client;

    await service.delete('opportunities', 'opp-1');

    assert.equal(client.waits.some((wait) => wait.taskUid === 11), true);
  });

  it('only tolerates index_not_found while deleting staging indexes', async () => {
    const service = Object.create(MeiliSearchService.prototype);
    const client = fakeMeiliClient();
    service.client = async () => client;

    client.deleteError = { cause: { code: 'index_not_found' } };
    await service.prepareEmptyIndex('stage_missing', {});
    assert.deepEqual(client.created, ['stage_missing']);

    client.deleteError = new Error('network down');
    await assert.rejects(() => service.prepareEmptyIndex('stage_broken', {}), /network down/);
  });


  it('tolerates async index_not_found delete tasks but not get-index network failures', async () => {
    const service = Object.create(MeiliSearchService.prototype);
    const client = fakeMeiliClient();
    service.client = async () => client;

    client.failedTaskUids.add(8);
    await service.prepareEmptyIndex('stage_async_missing', {});
    assert.deepEqual(client.created, ['stage_async_missing']);

    const broken = fakeMeiliClient();
    service.client = async () => broken;
    broken.getIndexError = new Error('get index network down');
    await assert.rejects(() => service.ensureIndexReady('opportunities', {}), /get index network down/);
  });
});

function serviceEnv(rows = {}) {
  const rebuilds = new InMemoryRebuildModel();
  const locks = new InMemoryLockModel();
  const meili = new FakeMeili();
  const jobs = new FakeJobs();
  const mutations = new InMemoryMutationModel();
  const writers = new InMemoryWriterModel();
  const audit = { events: [], record: async (_actor, action, entityType, entityId, fields) => audit.events.push({ action, entityType, entityId, fields }) };
  const models = {
    opportunities: new FakeModel(rows.opportunities ?? []),
    tasks: new FakeModel(rows.tasks ?? []),
    profiles: new FakeModel(rows.profiles ?? []),
    watchlists: new FakeModel(rows.watchlists ?? []),
    documents: new FakeModel(rows.documents ?? []),
    knowledgeChunks: new FakeModel(rows.knowledgeChunks ?? []),
  };
  const service = new SearchService(
    { recordRecent: async () => undefined, listRecent: async () => [], clearRecent: async () => undefined },
    meili,
    jobs,
    { findByIds: async () => [] },
    {},
    {},
    {},
    {},
    models.opportunities,
    models.tasks,
    models.profiles,
    models.watchlists,
    models.documents,
    models.knowledgeChunks,
    rebuilds,
    locks,
    mutations,
    writers,
    audit,
  );
  return { service, meili, jobs, audit, rebuilds, locks, mutations, writers, models };
}

function adminActor() {
  return { id: 'admin-1', email: 'admin@example.test', role: 'Admin' };
}

function fakeJob() {
  return { id: 'job-1', progress: [], updateProgress: async function updateProgress(progress) { this.progress.push(progress); } };
}

class FakeJobs {
  enqueued = [];
  jobs = new Map();
  async enqueue(queue, name, data, options) {
    const id = `job-${this.enqueued.length + 1}`;
    this.enqueued.push({ queue, name, data, options, id });
    this.jobs.set(id, { id, progress: { stage: 'queued' }, getState: async () => 'queued' });
    return { id, queue };
  }
  queue() {
    return {
      getJobCounts: async () => ({ waiting: this.enqueued.length, active: 0, delayed: 0, failed: 0 }),
      getJob: async (id) => this.jobs.get(id) ?? null,
    };
  }
}

class FakeMeili {
  prepared = [];
  ensured = [];
  adds = [];
  swaps = [];
  cleaned = [];
  liveUpserts = [];
  liveDeletes = [];
  nextTask = 1;
  failSwap = false;
  failCleanup = false;
  available() { return true; }
  async indexStats() {
    return [
      { name: 'opportunities', available: true, raw: { numberOfDocuments: 1 } },
      { name: 'knowledge_chunks', available: false },
      { name: 'tasks', available: false },
      { name: 'profiles', available: false },
      { name: 'watchlists', available: false },
    ];
  }
  async ensureIndexReady(index) { this.ensured.push(index); return [this.nextTask++]; }
  async prepareEmptyIndex(index) { this.prepared.push(index); return [this.nextTask++, this.nextTask++]; }
  async addDocumentsAwaited(index, documents) {
    if (!documents.length) return undefined;
    this.adds.push({ index, documents: [...documents] });
    return this.nextTask++;
  }
  async submitSwapIndexes(swaps) {
    this.swaps.push(swaps);
    if (this.failSwap) throw new Error('swap failed');
    return this.nextTask++;
  }
  async waitForTaskUid(taskUid) {
    this.waitedTaskUids = [...(this.waitedTaskUids ?? []), taskUid];
    if (this.failWaitTaskUid === taskUid) throw new Error('recorded swap unresolved');
  }
  async swapIndexes(swaps) {
    const taskUid = await this.submitSwapIndexes(swaps);
    await this.waitForTaskUid(taskUid);
    return taskUid;
  }
  async deleteIndexIfExists(index) {
    this.cleaned.push(index);
    if (this.failCleanup) throw new Error('cleanup failed');
    return this.nextTask++;
  }
  async ensureIndex() {}
  async upsert(index, documents) {
    this.liveUpserts.push({ index, documents });
    if (this.onUpsert) await this.onUpsert(index, documents);
  }
  async delete(index, id) { this.liveDeletes.push({ index, id }); }
}

class InMemoryRebuildModel {
  records = new Map();
  async create(record) {
    this.records.set(record._id, { ...record, createdAt: new Date(), updatedAt: new Date() });
    return this.records.get(record._id);
  }
  async updateOne(filter, update) {
    const id = filter._id;
    const current = this.records.get(id) ?? { ...(update.$setOnInsert ?? {}), _id: id, createdAt: new Date() };
    this.records.set(id, { ...current, ...(update.$set ?? update), updatedAt: new Date() });
    return { matchedCount: current ? 1 : 0 };
  }
  findOne(filter = {}) {
    const rows = [...this.records.values()].filter((row) => {
      if (filter._id && row._id !== filter._id) return false;
      if (filter.status?.$in && !filter.status.$in.includes(row.status)) return false;
      return true;
    });
    return new QueryOne(rows.at(-1) ?? null);
  }
}

class InMemoryLockModel {
  record = null;
  async create(record) {
    if (this.record) {
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    }
    this.record = { ...record };
    return this.record;
  }
  async updateOne(filter, update) {
    if (!this.matches(filter)) return { matchedCount: 0 };
    this.apply(update);
    return { matchedCount: 1 };
  }
  findOneAndUpdate(filter, update) {
    const matched = this.matches(filter);
    if (matched) this.apply(update);
    return new QueryOne(matched ? this.record : null);
  }
  async deleteOne(filter) {
    if (this.matches(filter)) this.record = null;
  }
  findOne(filter = {}) {
    return new QueryOne(this.matches(filter) ? this.record : null);
  }
  matches(filter = {}) {
    if (!this.record) return false;
    if (filter._id && this.record._id !== filter._id) return false;
    if (filter.rebuildId && this.record.rebuildId !== filter.rebuildId) return false;
    if (filter.jobId && this.record.jobId !== filter.jobId) return false;
    if (filter.phase && this.record.phase !== filter.phase) return false;
    if (filter.lockedUntil?.$gt && !(this.record.lockedUntil > filter.lockedUntil.$gt)) return false;
    if (filter.lockedUntil?.$lte && !(this.record.lockedUntil <= filter.lockedUntil.$lte)) return false;
    if (filter.$or && !filter.$or.some((entry) => this.matches({ ...entry, _id: filter._id }))) return false;
    return true;
  }
  apply(update) {
    this.record = { ...(this.record ?? {}), ...(update.$set ?? update), _id: 'search-rebuild' };
    if (update.$unset) {
      for (const key of Object.keys(update.$unset)) delete this.record[key];
    }
  }
}

class InMemoryMutationModel {
  records = [];
  failWrites = false;
  cursorCalls = 0;
  async insertMany(records) {
    if (this.failWrites) throw new Error('journal unavailable');
    const stamped = records.map((record) => ({ ...record, createdAt: new Date() }));
    this.records.push(...stamped);
    return stamped;
  }
  async create(record) {
    if (this.failWrites) throw new Error('journal unavailable');
    const stamped = { ...record, createdAt: new Date() };
    this.records.push(stamped);
    return stamped;
  }
  countDocuments(filter) {
    return Promise.resolve(this.records.filter((record) => record.rebuildId === filter.rebuildId).length);
  }
  find(filter) {
    this.cursorCalls += 1;
    return new QueryArray(this.records.filter((record) => record.rebuildId === filter.rebuildId));
  }
}

class InMemoryWriterModel {
  records = [];
  countCalls = 0;
  releaseOnFirstCount = false;
  async create(record) {
    this.records.push({ ...record });
    return record;
  }
  async deleteOne(filter) {
    this.records = this.records.filter((record) => record._id !== filter._id);
  }
  async updateOne(filter, update) {
    const record = this.records.find((item) => item._id === filter._id);
    if (!record) return { matchedCount: 0 };
    Object.assign(record, update.$set ?? update);
    return { matchedCount: 1 };
  }
  async deleteMany(filter) {
    this.records = this.records.filter((record) => record.rebuildId !== filter.rebuildId);
  }
  countDocuments(filter = {}) {
    this.countCalls += 1;
    const count = this.records.filter((record) => {
      if (filter.rebuildId && record.rebuildId !== filter.rebuildId) return false;
      return true;
    }).length;
    if (this.releaseOnFirstCount && this.countCalls === 1) this.records = [];
    return Promise.resolve(count);
  }
}

class QueryOne {
  constructor(value) { this.value = value; }
  sort() { return this; }
  lean() { return Promise.resolve(this.value); }
}

class FakeModel {
  constructor(rows) { this.rows = rows; }
  countDocuments() { return Promise.resolve(this.rows.length); }
  find() { return new QueryMany(this.rows); }
  findById(id) { return new QueryOne(this.rows.find((row) => row._id === id) ?? null); }
  findOne(filter) { return new QueryOne(this.rows.find((row) => row._id === filter._id) ?? null); }
}

class QueryMany {
  constructor(rows) { this.rows = rows; }
  select() { return this; }
  sort() { return this; }
  skip(count) { this.rows = this.rows.slice(count); return this; }
  limit(count) { this.rows = this.rows.slice(0, count); return this; }
  lean() { return this; }
  cursor(options) {
    this.batchSize = options.batchSize;
    const rows = this.rows;
    return (async function* iterate() {
      for (const row of rows) yield row;
    })();
  }
}

class QueryArray {
  constructor(rows) { this.rows = rows; }
  sort() { return this; }
  skip(count) { this.rows = this.rows.slice(count); return this; }
  limit(count) { this.rows = this.rows.slice(0, count); return this; }
  lean() { return this; }
  cursor(options) {
    this.batchSize = options.batchSize;
    const rows = this.rows;
    return (async function* iterate() {
      for (const row of rows) yield row;
    })();
  }
}


function fakeMeiliClient() {
  const client = {
    waits: [],
    created: [],
    nextTask: { taskUid: 7 },
    deleteError: undefined,
    getIndexError: undefined,
    failedTaskUids: new Set(),
    index: () => {
      return {
        addDocuments: async () => client.nextTask,
        deleteDocument: async () => ({ taskUid: 11 }),
        updateSettings: async () => ({ taskUid: 9 }),
      };
    },
    tasks: { waitForTask: async (taskUid, options) => {
      client.waits.push({ taskUid, options });
      if (client.failedTaskUids.has(taskUid)) return { taskUid, status: 'failed', error: { code: 'index_not_found' } };
      return { taskUid, status: 'succeeded' };
    } },
    deleteIndex: async () => {
      if (client.deleteError) throw client.deleteError;
      return { taskUid: 8 };
    },
    getIndex: async () => {
      if (client.getIndexError) throw client.getIndexError;
      return {};
    },
    createIndex: async (index) => {
      client.created.push(index);
      return { taskUid: 10 };
    },
  };
  return client;
}

function opportunity(id) {
  return {
    _id: id,
    type: 'vacancy',
    title: `Opportunity ${id}`,
    companyOrClient: 'Intly',
    description: 'Build search',
    skills: [],
    technologies: [],
    sourceOccurrences: [],
    canonicalTags: [],
  };
}

function task(id) {
  return { _id: id, reporterId: 'user-1', title: `Task ${id}`, description: '', labels: [] };
}

function profile(id) {
  return { _id: id, userId: 'user-1', name: `Profile ${id}`, kind: 'Main', targetRoles: [], seniority: [], technologies: [], locations: [] };
}

function watchlist(id) {
  return { _id: id, userId: 'user-1', profileId: 'profile-1', name: `Watchlist ${id}`, filters: {}, active: true, totalHits: 0 };
}

function chunk(id) {
  return { _id: id, documentId: 'doc-1', userId: 'user-1', profileIds: [], section: 'main', type: 'text', chunkIndex: 0, text: 'knowledge', inputHash: 'hash' };
}
