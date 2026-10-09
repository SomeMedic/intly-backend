import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('reflect-metadata');

const { SOURCE_CATALOG } = require('../src/modules/sources/catalog/source-catalog.ts');
const { SourcesRepository } = require('../src/modules/sources/sources.repository.ts');
const { SOURCE_RUN_ACTIVE_COLLECTION_INDEX_KEY, SOURCE_RUN_ACTIVE_COLLECTION_INDEX_OPTIONS } = require('../src/modules/sources/schemas/source-run.schema.ts');
const { ConnectorRegistryService } = require('../src/modules/sources/connectors/connector-registry.service.ts');
const { GdeRabotaConnector } = require('../src/modules/sources/connectors/gderabota.connector.ts');
const { WeWorkRemotelyConnector } = require('../src/modules/sources/connectors/weworkremotely.connector.ts');
const { BuiltinConnector } = require('../src/modules/sources/connectors/builtin.connector.ts');
const { BuduConnector } = require('../src/modules/sources/connectors/budu.connector.ts');
const { ArcConnector } = require('../src/modules/sources/connectors/arc.connector.ts');
const { B2bCenterConnector } = require('../src/modules/sources/connectors/b2b-center.connector.ts');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class InMemorySourceModel {
  constructor(seed = []) {
    this.docs = new Map(seed.map((item) => [item._id, clone(item)]));
    this.updates = [];
    this.events = [];
  }

  async updateOne(filter, update, options) {
    assert.equal(options?.upsert, true);
    const setKeys = new Set(Object.keys(update.$set ?? {}));
    for (const key of Object.keys(update.$setOnInsert ?? {})) {
      assert.equal(setKeys.has(key), false, `update must not set and setOnInsert the same path: ${key}`);
    }
    this.events.push('catalog-update');
    this.updates.push(clone({ filter, update, options }));
    const id = filter._id;
    let doc = this.docs.get(id);
    if (!doc) {
      doc = { _id: id };
      this.applySet(doc, update.$setOnInsert ?? {});
      this.docs.set(id, doc);
    }
    this.applySet(doc, update.$set ?? {});
    this.applyUnset(doc, update.$unset ?? {});
    return { acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: 1, upsertedCount: 0 };
  }

  applySet(doc, values) {
    for (const [key, value] of Object.entries(values)) doc[key] = clone(value);
  }

  applyUnset(doc, values) {
    for (const key of Object.keys(values)) delete doc[key];
  }
}

class InMemorySourceRunModel {
  constructor({ failCreateIndex } = {}) {
    this.createIndexCalls = [];
    this.failCreateIndex = failCreateIndex;
    this.collection = {
      createIndex: async (key, options) => {
        this.createIndexCalls.push(clone({ key, options }));
        if (this.failCreateIndex) throw this.failCreateIndex;
        return options.name;
      },
    };
  }
}

function repositoryWith(model, runModel = new InMemorySourceRunModel()) {
  return new SourcesRepository(model, runModel, {});
}

test('GdeRabota catalog dispatches to its public Inertia collector', () => {
  const entry = SOURCE_CATALOG.find((item) => item.id === 'gderabota');
  assert.equal(entry.endpoint.baseUrl, 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8?autocompleteCity=-1&filterInSevenDays=&filterInThirtyDays=1&page=1');
  assert.equal(entry.parserVersion, 'gderabota-inertia-ssr-v1');
  const connector = new ConnectorRegistryService({}).get({ ...entry, _id: entry.id });
  assert.ok(connector instanceof GdeRabotaConnector);
});

test('WWR catalog uses its native category collector instead of the generic HTML extractor', () => {
  const entry = SOURCE_CATALOG.find((item) => item.id === 'weworkremotely');
  assert.equal(entry.connectorFamily, 'PublicHtml');
  assert.equal(entry.parserVersion, 'wwr-native-html-catalog-v1');
  const connector = new ConnectorRegistryService({}).get({ ...entry, _id: entry.id });
  assert.ok(connector instanceof WeWorkRemotelyConnector);
  assert.equal(connector.capabilities().supportsRefresh, true);
});

test('Built In dispatches to its native resumable public collector', () => {
  const entry = SOURCE_CATALOG.find(item => item.id === 'builtin');
  assert.equal(entry.endpoint.baseUrl, 'https://builtin.com/jobs');
  assert.equal(entry.parserVersion, 'builtin-native-html-v1');
  const connector = new ConnectorRegistryService({}).get({ ...entry, _id: entry.id });
  assert.ok(connector instanceof BuiltinConnector);
  assert.equal(connector.capabilities().requiresCredentials, false);
});

test('Arc, B2B-Center and Budu use native public collectors without account credentials', () => {
  const registry = new ConnectorRegistryService({});
  for (const [id, type, version, baseUrl] of [
    ['arc', ArcConnector, 'arc-native-public-v1', 'https://arc.dev/remote-jobs'],
    ['budu', BuduConnector, 'budu-native-fulcro-detail-v3', 'https://budu.jobs/vacancies'],
    ['b2b_center', B2bCenterConnector, 'b2b-center-native-public-v1', 'https://www.b2b-center.ru/app/next/market-search/'],
  ]) {
    const entry = SOURCE_CATALOG.find(item => item.id === id);
    assert.equal(entry.parserVersion, version);
    assert.equal(entry.endpoint.baseUrl, baseUrl);
    assert.equal(entry.authCredentialRef, undefined);
    const connector = registry.get({ ...entry, _id: id });
    assert.ok(connector instanceof type);
    assert.equal(connector.capabilities().requiresCredentials, false);
    assert.equal(connector.capabilities().maxBackfillDays, 30);
  }
});

test('ensureCatalog refreshes catalog-owned fields while preserving runtime user state', async () => {
  const oldCheckpoint = { cursor: 'keep-me' };
  const oldConfig = { userSearch: 'python' };
  const oldLimits = { perPage: 7 };
  const staleGeekJob = {
    _id: 'geekjob',
    name: 'Old GeekJob Name',
    group: 'web',
    category: 'old category',
    opportunityTypes: ['freelance'],
    connectorFamily: 'PublicHtml',
    endpoint: { baseUrl: 'https://geekjob.ru' },
    parserVersion: 'old-parser',
    normalizationProfile: 'old-normalizer',
    refreshPolicy: 'old-refresh',
    checkpointStrategy: 'old-checkpoint',
    authCredentialRef: 'stale-system-credential',
    dedupPriority: 1,
    sourceRole: 'stale role',
    policy: { stale: true },
    unavailableReason: 'stale reason',
    enabled: false,
    runtimeState: 'Disabled',
    intervalSeconds: 999,
    timeoutMs: 1234,
    config: oldConfig,
    limits: oldLimits,
    credentialsEncrypted: 'encrypted-user-secret',
    credentialsPreview: 'preview-secret',
    proxyPoolEnabled: true,
    checkpoint: oldCheckpoint,
    healthState: 'Failed',
    healthMessage: 'keep health message',
    lastError: 'keep error',
    lastSuccessAt: '2026-10-01T00:00:00.000Z',
    lastFailureAt: '2026-10-02T00:00:00.000Z',
    updatedByUserId: 'admin-user',
  };
  const model = new InMemorySourceModel([staleGeekJob]);
  const runModel = new InMemorySourceRunModel();

  await repositoryWith(model, runModel).ensureCatalog();

  assert.deepEqual(runModel.createIndexCalls, [{ key: SOURCE_RUN_ACTIVE_COLLECTION_INDEX_KEY, options: SOURCE_RUN_ACTIVE_COLLECTION_INDEX_OPTIONS }]);
  assert.equal(model.events[0], 'catalog-update');

  assert.equal(model.docs.size, SOURCE_CATALOG.length);
  assert.equal(SOURCE_CATALOG.length, 103);
  const geekjob = model.docs.get('geekjob');
  const catalogGeekJob = SOURCE_CATALOG.find((entry) => entry.id === 'geekjob');
  assert.deepEqual(geekjob.endpoint, { baseUrl: 'https://geekjob.ru/vacancies' });
  assert.equal(geekjob.name, catalogGeekJob.name);
  assert.equal(geekjob.category, catalogGeekJob.category);
  assert.deepEqual(geekjob.opportunityTypes, catalogGeekJob.opportunityTypes);
  assert.equal(geekjob.parserVersion, catalogGeekJob.parserVersion);
  assert.equal(geekjob.normalizationProfile, catalogGeekJob.normalizationProfile);
  assert.equal(geekjob.refreshPolicy, catalogGeekJob.refreshPolicy);
  assert.equal(geekjob.checkpointStrategy, catalogGeekJob.checkpointStrategy);
  assert.equal(geekjob.dedupPriority, catalogGeekJob.dedupPriority);
  assert.deepEqual(geekjob.policy, catalogGeekJob.policy);
  assert.equal('authCredentialRef' in geekjob, false);
  assert.equal('sourceRole' in geekjob, false);

  assert.equal(geekjob.enabled, false);
  assert.equal(geekjob.runtimeState, 'Disabled');
  assert.equal(geekjob.intervalSeconds, 999);
  assert.equal(geekjob.timeoutMs, 1234);
  assert.deepEqual(geekjob.config, oldConfig);
  assert.deepEqual(geekjob.limits, oldLimits);
  assert.equal(geekjob.credentialsEncrypted, 'encrypted-user-secret');
  assert.equal(geekjob.credentialsPreview, 'preview-secret');
  assert.equal(geekjob.proxyPoolEnabled, true);
  assert.deepEqual(geekjob.checkpoint, oldCheckpoint);
  assert.equal(geekjob.healthState, 'Failed');
  assert.equal(geekjob.healthMessage, 'keep health message');
  assert.equal(geekjob.lastError, 'keep error');
  assert.equal(geekjob.updatedByUserId, 'admin-user');
});

test('ensureCatalog inserts new catalog sources with defaults and system fields without update path conflicts', async () => {
  const model = new InMemorySourceModel();
  const runModel = new InMemorySourceRunModel();

  await repositoryWith(model, runModel).ensureCatalog();

  assert.deepEqual(runModel.createIndexCalls, [{ key: SOURCE_RUN_ACTIVE_COLLECTION_INDEX_KEY, options: SOURCE_RUN_ACTIVE_COLLECTION_INDEX_OPTIONS }]);

  assert.equal(model.docs.size, 103);
  assert.equal(model.updates.length, 103);
  const workingNomads = model.docs.get('workingnomads');
  assert.equal(workingNomads.name, 'Working Nomads');
  assert.equal(workingNomads.group, 'web');
  assert.equal(workingNomads.connectorFamily, 'PublicHtml');
  assert.deepEqual(workingNomads.endpoint, { baseUrl: 'https://www.workingnomads.com/jobs', apiUrl: 'https://www.workingnomads.com/jobsapi/_search', evidenceUrl: 'https://www.workingnomads.com/jobs' });
  assert.equal(workingNomads.parserVersion, 'workingnomads-public-search-v3');
  assert.equal(workingNomads.runtimeState, 'Enabled');
  assert.equal(workingNomads.enabled, true);
  assert.equal(workingNomads.intervalSeconds, 1800);
  assert.equal(workingNomads.timeoutMs, 30_000);
  assert.deepEqual(workingNomads.config, {});
  assert.deepEqual(workingNomads.limits, { perPage: 50 });
  assert.deepEqual(workingNomads.checkpoint, {});
  assert.equal(workingNomads.healthState, 'Unknown');
  assert.equal(model.docs.get('remotive').intervalSeconds, 21600);

  for (const { update } of model.updates) {
    const setKeys = new Set(Object.keys(update.$set ?? {}));
    for (const key of Object.keys(update.$setOnInsert ?? {})) {
      assert.equal(setKeys.has(key), false, `conflicting update path ${key}`);
    }
  }
});


test('ensureCatalog fails before catalog refresh when the active-run index cannot be created', async () => {
  const model = new InMemorySourceModel();
  const runModel = new InMemorySourceRunModel({ failCreateIndex: new Error('duplicate active runs') });

  await assert.rejects(() => repositoryWith(model, runModel).ensureCatalog(), /duplicate active runs/);

  assert.deepEqual(runModel.createIndexCalls, [{ key: SOURCE_RUN_ACTIVE_COLLECTION_INDEX_KEY, options: SOURCE_RUN_ACTIVE_COLLECTION_INDEX_OPTIONS }]);
  assert.equal(model.updates.length, 0);
  assert.equal(model.docs.size, 0);
});
