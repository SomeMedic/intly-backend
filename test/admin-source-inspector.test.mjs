import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { AdminSourceInspectorService } = require('../src/modules/sources/admin-source-inspector.service.ts');
const { SourceInspectorToolsService } = require('../src/modules/sources/source-inspector-tools.service.ts');
const { OpportunitiesRepository } = require('../src/modules/opportunities/opportunities.repository.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');
const { sourceOccurrenceRevision } = require('../src/modules/opportunities/source-occurrence-revision.ts');
const { PublicApiFeedConnector } = require('../src/modules/sources/connectors/public-api-feed.connector.ts');
const { B2bCenterConnector } = require('../src/modules/sources/connectors/b2b-center.connector.ts');

const actor = { id: 'admin-1', email: 'admin@example.test', role: 'Admin' };

const hhSource = {
  _id: 'hh',
  name: 'HeadHunter',
  group: 'jobs',
  connectorFamily: 'hh',
  healthState: 'Healthy',
  runtimeState: 'Enabled',
  enabled: true,
};

const b2bCenterSource = {
  _id: 'b2b_center',
  name: 'B2B-Center',
  group: 'tenders',
  connectorFamily: 'TenderPlatform',
  healthState: 'Healthy',
  runtimeState: 'Enabled',
  enabled: true,
};

const fabrikantSource = {
  _id: 'fabrikant',
  name: 'Фабрикант',
  group: 'tenders',
  connectorFamily: 'TenderPlatform',
  healthState: 'Healthy',
  runtimeState: 'Enabled',
  enabled: true,
};

const hhSample = {
  _id: 'opp-1',
  type: 'vacancy',
  title: 'Python engineer',
  companyOrClient: 'Acme',
  summary: 'Remote role',
  description: 'Build integrations',
  sourceStatus: 'Active',
  firstSeenAt: new Date('2026-10-01T10:00:00.000Z'),
  lastSeenAt: new Date('2026-10-05T10:00:00.000Z'),
  publishedAt: new Date('2026-10-01T09:00:00.000Z'),
  skills: ['Python'],
  technologies: ['Django'],
  money: {},
  canonicalTags: ['backend'],
  sourceOccurrence: {
    sourceId: 'hh',
    externalId: 'vac-1',
    url: 'https://example.test/vac-1?token=secret-token',
    primary: true,
    firstSeenAt: new Date('2026-10-01T10:00:00.000Z'),
    lastSeenAt: new Date('2026-10-05T10:00:00.000Z'),
    publishedAt: new Date('2026-10-01T09:00:00.000Z'),
    status: 'Active',
    rawPayload: { title: 'Python engineer', apiKey: 'secret-key', nested: { password: 'pw', keep: 'ok' } },
    sourceMetadata: { sourceRunId: 'run-1', sessionToken: 'secret-session', page: 1 },
  },
};

const fabrikantCard = {
  id: '679731858',
  url: 'https://44.fabrikant.ru/44/procedure/ea21/0348600004326000047',
  procedureNumber: '0348600004326000047',
  lotNumber: '1',
  title: 'Оказание услуг по ремонту оборудования',
  text: 'Каталоговая карточка',
  nativeStatus: 'Прием заявок',
  section: 'Услуги',
  organizer: 'ГБУ Заказчик',
  publishedText: '06.10.2026 17:06',
  deadlineText: '13.10.2026 00:00',
  priceText: '22 230,52 RUB',
  participationText: 'Платит победитель',
};

const fabrikantSample = {
  _id: 'fab-opp-1',
  type: 'tender',
  title: 'STALE CANONICAL TITLE',
  companyOrClient: 'STALE COMPANY',
  summary: 'Old summary',
  description: 'STALE DESCRIPTION',
  sourceStatus: 'Unknown',
  firstSeenAt: new Date('2026-10-01T10:00:00.000Z'),
  lastSeenAt: new Date('2026-10-05T10:00:00.000Z'),
  publishedAt: new Date('2026-10-06T14:06:00.000Z'),
  skills: [],
  technologies: [],
  money: { originalText: 'stale' },
  canonicalTags: ['old'],
  adminCorrections: [{ field: 'title', value: 'Pinned title', pinned: true }],
  personalStates: [{ userId: 'user-1', state: 'saved' }],
  sourceOccurrence: {
    sourceId: 'fabrikant',
    externalId: fabrikantCard.id,
    url: fabrikantCard.url,
    primary: true,
    firstSeenAt: new Date('2026-10-01T10:00:00.000Z'),
    lastSeenAt: new Date('2026-10-05T10:00:00.000Z'),
    publishedAt: new Date('2026-10-06T14:06:00.000Z'),
    checksum: 'original-checksum',
    status: 'Unknown',
    rawPayload: { nativeCatalogCard: structuredClone(fabrikantCard), nativeDetailText: 'Детальное описание' },
    sourceMetadata: { sourceRunId: 'run-1', sourceRunEffectMode: 'historical', extraction: 'http-native-public-html' },
    normalizedSnapshot: { money: { originalText: 'stale' }, sourceStatus: 'Unknown' },
  },
};

const fabrikantSampleWithoutRaw = {
  ...fabrikantSample,
  _id: 'fab-no-raw',
  sourceOccurrence: { ...fabrikantSample.sourceOccurrence, rawPayload: {} },
};

const fabrikantNullableCardSample = {
  ...fabrikantSample,
  _id: 'fab-null-card',
  sourceOccurrence: {
    ...fabrikantSample.sourceOccurrence,
    rawPayload: {
      ...fabrikantSample.sourceOccurrence.rawPayload,
      nativeCatalogCard: {
        ...structuredClone(fabrikantCard),
        lotNumber: null,
        deadlineText: null,
        priceText: null,
        participationText: null,
      },
    },
  },
};

const fabrikantLegacyExternalLotCard = {
  id: '679731171',
  procedureNumber: '5583332',
  lotNumber: '132616441359',
  title: 'Текущий ремонт АФУ ДПРМ с Мкп-016 Курганского Центра ОВД и участие в специальной лётной проверке',
  text: 'Запрос котировок в электронной форме, участниками которого могут являться только субъекты малого и среднего предпринимательства№ 5583332-132616441359МСППрием заявокЗакупки по 223-ФЗТекущий ремонт АФУ ДПРМ с Мкп-016 Курганского Центра ОВД и участие в специальной лётной проверкеОрганизаторФГУП "ГОСКОРПОРАЦИЯ ПО ОРВД"Дата публикации06.10.2026 16:15Дата окончания приёма заявок13.10.2026 08:00Осталось 6 дней, 13 часов',
  url: 'https://www.fabrikant.ru/v2/trades/procedure/view/Qj7EWgqnwFCeCvVydFS36A',
  nativeBadges: ['МСП', 'Прием заявок', 'Закупки по 223-ФЗ'],
  nativeStatus: 'Прием заявок',
  section: 'Закупки по 223-ФЗ',
  organizer: 'ФГУП "ГОСКОРПОРАЦИЯ ПО ОРВД"',
  publishedText: '06.10.2026 16:15',
  deadlineText: '13.10.2026 08:00',
  priceText: null,
  participationText: null,
};

const fabrikantLegacyExternalLotDetailText = 'Лот №1. Текущий ремонт АФУ ДПРМ с Мкп-016 Курганского Центра ОВД и участие в специальной лётной проверке - Прием заявок Номер закупки в ЕИС 32616441359 Предмет договора Текущий ремонт АФУ ДПРМ с Мкп-016 Курганского Центра ОВД и участие в специальной лётной проверке';

const fabrikantLegacyExternalLotSample = {
  ...fabrikantSample,
  _id: 'fab-external-lot',
  sourceOccurrence: {
    ...fabrikantSample.sourceOccurrence,
    externalId: fabrikantLegacyExternalLotCard.id,
    url: fabrikantLegacyExternalLotCard.url,
    rawPayload: { nativeCatalogCard: structuredClone(fabrikantLegacyExternalLotCard), nativeDetailText: fabrikantLegacyExternalLotDetailText },
    sourceMetadata: { sourceRunId: 'run-legacy', sourceRunEffectMode: 'historical', extraction: 'http-native-public-html' },
  },
};


function makeOpportunityModel(record) {
  return {
    record,
    filters: [],
    findById(id) {
      return { lean: async () => id === this.record._id ? structuredClone(this.record) : null };
    },
    findOneAndUpdate(filter, update) {
      this.filters.push(filter);
      if (filter._id !== this.record._id || this.record.mergedIntoOpportunityId) return { lean: async () => null };
      Object.assign(this.record, update.$set);
      for (const field of Object.keys(update.$unset ?? {})) delete this.record[field];
      return { lean: async () => structuredClone(this.record) };
    },
  };
}

function makeRaceOpportunityModel(record) {
  const model = makeOpportunityModel(record);
  model.updateAttempts = 0;
  const update = model.findOneAndUpdate;
  model.findOneAndUpdate = function(filter, patch) {
    this.updateAttempts += 1;
    if (this.updateAttempts === 1) {
      this.record.sourceOccurrences[0].rawPayload.nativeCatalogCard.title = 'Changed during CAS race';
      return { lean: async () => null };
    }
    return update.call(this, filter, patch);
  };
  return model;
}

describe('admin source inspector', () => {
  it('returns source-scoped operational logs with run level time and query filters', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'intly-source-logs-'));
    writeFileSync(join(directory, '2026-10-06.ndjson'), [
      JSON.stringify({ time: '2026-10-06T10:00:00.000Z', level: 30, sourceId: 'hh', data: { runId: 'run-1', apiKey: 'secret-key' }, msg: 'Fetched page token=secret-token' }),
      JSON.stringify({ time: '2026-10-06T10:01:00.000Z', level: 30, sourceId: 'other', data: { runId: 'run-1' }, msg: 'Fetched page' }),
      JSON.stringify({ time: '2026-10-06T10:02:00.000Z', level: 40, sourceId: 'hh', data: { runId: 'run-2' }, msg: 'Different run' }),
      '',
    ].join('\n'));
    const { service } = serviceWith({ directory });

    const result = await service.logs('hh', { runId: 'run-1', level: 'info', from: '2026-10-06T09:00:00.000Z', to: '2026-10-06T11:00:00.000Z', query: 'Fetched', limit: 10 });

    assert.equal(result.source.id, 'hh');
    assert.equal(result.logs.status, 'available');
    assert.equal(result.logs.items.length, 1);
    assert.equal(result.logs.items[0].sourceId, 'hh');
    assert.equal(result.logs.items[0].runId, 'run-1');
    assert.equal(result.logs.items[0].message.includes('secret-token'), false);
    assert.equal(result.logs.items[0].fields.data.apiKey, '[redacted]');
  });

  it('returns bounded samples without raw payload by default and audits redacted raw reads', async () => {
    const audit = new InMemoryAuditService();
    const { service } = serviceWith({ audit });

    const safe = await service.samples(actor, 'hh', { limit: 10 });
    assert.equal(safe.items.length, 1);
    assert.equal(safe.items[0].occurrence.sourceId, 'hh');
    assert.equal(safe.items[0].occurrence.hasRawPayload, true);
    assert.equal(safe.items[0].occurrence.url.includes('secret-token'), false);
    assert.equal(safe.items[0].occurrence.firstSeenAt instanceof Date, true);
    assert.equal(safe.items[0].occurrence.lastSeenAt instanceof Date, true);
    assert.equal('rawPayload' in safe.items[0].occurrence, false);

    const raw = await service.samples(actor, 'hh', { includeRaw: 'true' });
    assert.equal(raw.items[0].occurrence.url.includes('secret-token'), false);
    assert.equal(raw.items[0].occurrence.firstSeenAt instanceof Date, true);
    assert.equal(raw.items[0].occurrence.lastSeenAt instanceof Date, true);
    assert.equal(raw.items[0].occurrence.rawPayload.apiKey, '[redacted]');
    assert.equal(raw.items[0].occurrence.rawPayload.nested.password, '[redacted]');
    assert.equal(raw.items[0].occurrence.rawPayload.nested.keep, 'ok');
    assert.equal(raw.items[0].occurrence.sourceMetadata.sessionToken, '[redacted]');
    assert.deepEqual(audit.events.map((event) => event.action), ['source.sample.raw.read']);
  });

  it('queues every explicit single-opportunity search reindex and rejects foreign-source samples without enqueue', async () => {
    const jobs = new InMemoryJobsService();
    const audit = new InMemoryAuditService();
    const { service } = serviceWith({ jobs, audit });

    const first = await service.reindex(actor, 'hh', { opportunityId: 'opp-1' });
    const second = await service.reindex(actor, 'hh', { opportunityId: 'opp-1' });

    assert.equal(first.status, 'queued');
    assert.equal(first.action, 'reindex');
    assert.equal(second.status, 'queued');
    assert.equal(jobs.enqueued.length, 2);
    assert.equal(jobs.enqueued[0].queue, 'search');
    assert.equal(jobs.enqueued[0].name, 'index-opportunity');
    assert.equal(jobs.enqueued[0].data.opportunityId, 'opp-1');
    assert.equal(jobs.enqueued[0].data.sourceId, 'hh');
    assert.equal(typeof jobs.enqueued[0].data.requestId, 'string');
    assert.equal(jobs.enqueued[0].data.requestedByUserId, 'admin-1');
    assert.match(jobs.enqueued[0].options.jobId, /^source-inspector:hh:reindex:opp-1:/);
    assert.match(jobs.enqueued[1].options.jobId, /^source-inspector:hh:reindex:opp-1:/);
    assert.notEqual(jobs.enqueued[0].options.jobId, jobs.enqueued[1].options.jobId);
    assert.notEqual(first.job.id, second.job.id);
    assert.equal(first.supportedActions.includes('reprocess'), false);
    assert.equal(first.capabilities.reprocess.reasonCode, 'unsupported_source_mapper');

    await assert.rejects(() => service.reindex(actor, 'hh', { opportunityId: 'foreign-opp' }), /Opportunity sample not found/);
    assert.equal(jobs.enqueued.length, 2);
    assert.deepEqual(audit.events.map((event) => event.action), ['source.sample.reindex', 'source.sample.reindex']);
  });

  it('reports technical tool capabilities with reason codes and no fake dedup/raw support', async () => {
    const jobs = new InMemoryJobsService();
    const opportunities = new InMemoryOpportunitiesRepository({ 'fab-no-raw': fabrikantSampleWithoutRaw });
    const { service, tools } = serviceWith({ jobs, opportunities });

    const sourceOnly = await service.capabilities('fabrikant');
    assert.deepEqual(sourceOnly.capabilities.supportedActions, ['reindex']);
    assert.equal(sourceOnly.capabilities.actions.reprocess.reasonCode, 'select_opportunity');
    assert.equal(sourceOnly.capabilities.actions.deduplicate.reasonCode, 'select_opportunity');

    const scoped = await service.capabilities('fabrikant', 'fab-opp-1');
    assert.deepEqual(scoped.capabilities.supportedActions, ['reindex', 'reprocess', 'normalize', 'deduplicate']);

    const nullableRepo = new InMemoryOpportunitiesRepository({ 'fab-null-card': fabrikantNullableCardSample });
    const { service: nullableService } = serviceWith({ opportunities: nullableRepo });
    const nullable = await nullableService.capabilities('fabrikant', 'fab-null-card');
    assert.deepEqual(nullable.capabilities.supportedActions, ['reindex', 'reprocess', 'normalize', 'deduplicate']);
    assert.equal(scoped.capabilities.actions.deduplicate.supported, true);

    const unsupported = await service.reprocess(actor, 'fabrikant', { opportunityId: 'fab-no-raw' });
    assert.equal(unsupported.status, 'unsupported');
    assert.equal(unsupported.action, 'reprocess');
    assert.equal(unsupported.reasonCode, 'missing_retained_raw');
    assert.equal(jobs.enqueued.length, 0);

    const removed = structuredClone(fabrikantSample);
    removed._id = 'fab-removed';
    removed.sourceOccurrence.status = 'Removed';
    const removedRepo = new InMemoryOpportunitiesRepository({ 'fab-removed': removed });
    const { service: removedService } = serviceWith({ jobs: new InMemoryJobsService(), opportunities: removedRepo });
    const removedUnsupported = await removedService.normalize(actor, 'fabrikant', { opportunityId: 'fab-removed' });
    assert.equal(removedUnsupported.status, 'unsupported');
    assert.equal(removedUnsupported.reasonCode, 'removed_source_occurrence');

    const unsupportedDedup = await service.deduplicate(actor, 'fabrikant', { opportunityId: 'fab-opp-1' });
    assert.equal(unsupportedDedup.status, 'queued');
    assert.equal(jobs.enqueued.length, 1);
    const completed = await tools.handleRetainedRawJob('deduplicate', jobs.enqueued[0].data);
    assert.equal(completed.result.opportunityId, 'fab-opp-1');
  });

  it('queues supported Fabrikant retained-raw actions with fresh receipts and source-owned validation', async () => {
    const jobs = new InMemoryJobsService();
    const audit = new InMemoryAuditService();
    const { service } = serviceWith({ jobs, audit });

    const reprocess = await service.reprocess(actor, 'fabrikant', { opportunityId: 'fab-opp-1' });
    const normalize = await service.normalize(actor, 'fabrikant', { opportunityId: 'fab-opp-1' });

    assert.deepEqual(jobs.enqueued.map((job) => [job.queue, job.name]), [
      ['ingestion', 'source-inspector.reprocess'],
      ['ingestion', 'source-inspector.normalize'],
    ]);
    assert.deepEqual(jobs.enqueued.map((job) => job.data.action), ['reprocess', 'normalize']);
    assert.deepEqual(jobs.enqueued.map((job) => job.data.requestedByUserId), ['admin-1', 'admin-1']);
    assert.equal(typeof jobs.enqueued[0].data.expectedOccurrenceRevision, 'string');
    assert.notEqual(reprocess.requestId, normalize.requestId);
    assert.notEqual(jobs.enqueued[0].options.jobId, jobs.enqueued[1].options.jobId);

    await assert.rejects(() => service.normalize(actor, 'fabrikant', { opportunityId: 'foreign-opp' }), /Opportunity sample not found/);
    assert.equal(jobs.enqueued.length, 2);
    assert.deepEqual(audit.events.map((event) => event.action), [
      'source.sample.reprocess',
      'source.sample.rerun-normalization',
    ]);
  });

  it('repairs Fabrikant retained mapper facts without fresh ingest or source occurrence mutation', async () => {
    const jobs = new InMemoryJobsService();
    const opportunitiesService = new InMemoryOpportunitiesService();
    const { service, tools } = serviceWith({ jobs, opportunitiesService, normalizer: new SourceNormalizerService() });
    const before = snapshotSourceControls(fabrikantSample);
    const queued = await service.reprocess(actor, 'fabrikant', { opportunityId: 'fab-opp-1' });

    const result = await tools.handleRetainedRawJob('reprocess', jobs.enqueued[0].data);

    assert.equal(queued.status, 'queued');
    assert.equal(result.status, 'completed');
    assert.equal(opportunitiesService.repairs.length, 1);
    const repair = opportunitiesService.repairs[0];
    assert.equal(repair.sourceRunId, 'run-1');
    assert.equal(repair.normalized.title, fabrikantCard.title);
    assert.equal(repair.normalized.companyOrClient, fabrikantCard.organizer);
    assert.match(repair.normalized.description, /Детальное описание/);
    assert.equal(repair.normalized.money.amount, 22230.52);
    assert.equal(repair.normalized.money.currency, 'RUB');
    assert.equal(repair.normalized.deadline.toISOString(), '2026-10-12T21:00:00.000Z');
    assert.equal(repair.normalized.tenderData.procedureNumber, fabrikantCard.procedureNumber);
    assert.equal(repair.normalized.sourceOccurrences[0].externalId, fabrikantCard.id);
    assert.equal(repair.normalized.sourceOccurrences[0].url, fabrikantCard.url);
    assert.deepEqual(snapshotSourceControls(fabrikantSample), before);
  });

  it('accepts persisted Fabrikant optional nulls through the shared stored-card mapper without mutating raw', async () => {
    const jobs = new InMemoryJobsService();
    const opportunities = new InMemoryOpportunitiesRepository({ 'fab-null-card': fabrikantNullableCardSample });
    const opportunitiesService = new InMemoryOpportunitiesService();
    const { service, tools } = serviceWith({ jobs, opportunities, opportunitiesService, normalizer: new SourceNormalizerService() });
    const beforeRaw = structuredClone(fabrikantNullableCardSample.sourceOccurrence.rawPayload.nativeCatalogCard);
    const queued = await service.normalize(actor, 'fabrikant', { opportunityId: 'fab-null-card' });

    const result = await tools.handleRetainedRawJob('normalize', jobs.enqueued[0].data);

    assert.equal(queued.status, 'queued');
    assert.equal(result.status, 'completed');
    assert.equal(opportunitiesService.repairs.length, 1);
    const repair = opportunitiesService.repairs[0];
    assert.equal(repair.normalized.sourceOccurrences[0].externalId, fabrikantCard.id);
    assert.equal(repair.normalized.tenderData.lotNumber, undefined);
    assert.equal(repair.normalized.sourceOccurrences[0].sourceMetadata.lotNumber, undefined);
    assert.deepEqual(fabrikantNullableCardSample.sourceOccurrence.rawPayload.nativeCatalogCard, beforeRaw);
    assert.equal(fabrikantNullableCardSample.sourceOccurrence.rawPayload.nativeCatalogCard.lotNumber, null);
  });

  it('preserves evidence-resolved Fabrikant lot metadata during retained replay', async () => {
    const jobs = new InMemoryJobsService();
    const opportunities = new InMemoryOpportunitiesRepository({ 'fab-external-lot': fabrikantLegacyExternalLotSample });
    const opportunitiesService = new InMemoryOpportunitiesService();
    const { service, tools } = serviceWith({ jobs, opportunities, opportunitiesService, normalizer: new SourceNormalizerService() });
    const beforeRaw = structuredClone(fabrikantLegacyExternalLotSample.sourceOccurrence.rawPayload.nativeCatalogCard);
    await service.normalize(actor, 'fabrikant', { opportunityId: 'fab-external-lot' });

    const result = await tools.handleRetainedRawJob('normalize', jobs.enqueued[0].data);

    assert.equal(result.status, 'completed');
    assert.equal(opportunitiesService.repairs.length, 1);
    const repair = opportunitiesService.repairs[0];
    assert.equal(repair.sourceRunId, 'run-legacy');
    assert.equal(repair.normalized.tenderData.procedureNumber, '5583332');
    assert.equal(repair.normalized.tenderData.lotNumber, '1');
    assert.equal(repair.normalized.tenderData.catalogLotNumber, '132616441359');
    assert.equal(repair.normalized.tenderData.lotNumberEvidence, 'native-lot-heading-and-eis-number');
    assert.equal(repair.normalized.sourceOccurrences[0].sourceMetadata.procedureNumber, '5583332');
    assert.equal(repair.normalized.sourceOccurrences[0].sourceMetadata.lotNumber, '1');
    assert.equal(repair.normalized.sourceOccurrences[0].sourceMetadata.tenderData.catalogLotNumber, '132616441359');
    assert.equal(repair.normalized.sourceOccurrences[0].externalId, '679731171');
    assert.equal(repair.normalized.sourceOccurrences[0].url, fabrikantLegacyExternalLotCard.url);
    assert.deepEqual(fabrikantLegacyExternalLotSample.sourceOccurrence.rawPayload.nativeCatalogCard, beforeRaw);
    assert.equal(fabrikantLegacyExternalLotSample.sourceOccurrence.rawPayload.nativeCatalogCard.lotNumber, '132616441359');
  });


  it('repairs B2B-Center retained native mapper facts without fresh HTTP and without mutating retained evidence', async () => {
    const sample = b2bSample();
    const jobs = new InMemoryJobsService();
    const opportunitiesService = new InMemoryOpportunitiesService();
    const { service, tools } = serviceWith({
      sources: new InMemorySourcesRepository({ b2b_center: b2bCenterSource }),
      opportunities: new InMemoryOpportunitiesRepository({ [sample._id]: sample }),
      jobs,
      opportunitiesService,
      normalizer: new SourceNormalizerService(),
    });
    const before = snapshotSourceControls(sample);

    const capabilities = await tools.capabilities('b2b_center', sample._id);
    assert.deepEqual(capabilities.capabilities.supportedActions, ['reindex', 'reprocess', 'normalize', 'deduplicate']);
    const receipt = await service.normalize(actor, 'b2b_center', { opportunityId: sample._id });
    const result = await tools.handleRetainedRawJob('normalize', jobs.enqueued[0].data);

    assert.equal(receipt.status, 'queued');
    assert.equal(result.status, 'completed');
    assert.equal(opportunitiesService.repairs.length, 1);
    const repair = opportunitiesService.repairs[0];
    assert.equal(repair.sourceRunId, 'original-b2b-run');
    assert.equal(repair.normalized.title, 'Поставка пакетов для хлеба ТС «Перекресток».');
    assert.equal(repair.normalized.title.includes('Зарегистрируйтесь'), false);
    assert.equal(repair.normalized.description.includes('Retained public detail description'), true);
    assert.equal(repair.normalized.companyOrClient, 'ПАО "КОРПОРАТИВНЫЙ ЦЕНТР ИКС 5"');
    assert.equal(repair.normalized.sourceStatus, 'Closed');
    assert.equal(repair.normalized.money.kind, 'unpublished-lot-price');
    assert.equal(repair.normalized.tenderData.macroTradeType, 'buy');
    assert.equal(repair.normalized.sourceOccurrences[0].externalId, '4630191:4630191458');
    assert.equal(repair.normalized.sourceOccurrences[0].url, sample.sourceOccurrence.url);
    assert.equal(repair.normalized.sourceOccurrences[0].sourceMetadata.windowSince, '2026-09-06T20:08:23.981Z');
    assert.deepEqual(repair.normalized.sourceOccurrences[0].rawPayload, sample.sourceOccurrence.rawPayload);
    assert.deepEqual(snapshotSourceControls(sample), before);
  });

  it('rejects malformed, removed and mismatched B2B-Center retained raw targets before queueing', async () => {
    for (const [change, reasonCode] of [
      [(sample) => { sample.sourceOccurrence.rawPayload = { native: {} }; }, 'missing_retained_native_payload'],
      [(sample) => { sample.sourceOccurrence.externalId = 'other'; }, 'identity_mismatch'],
      [(sample) => { sample.sourceOccurrence.url = 'https://www.b2b-center.ru/app/market-next/other/tender-4630192/'; }, 'identity_mismatch'],
      [(sample) => { sample.sourceOccurrence.rawPayload.native.url = 'https://evil.example/site/api/v1/market-search/'; }, 'missing_retained_native_payload'],
      [(sample) => { sample.sourceOccurrence.status = 'Removed'; }, 'removed_source_occurrence'],
    ]) {
      const sample = b2bSample();
      change(sample);
      const jobs = new InMemoryJobsService();
      const { service } = serviceWith({
        sources: new InMemorySourcesRepository({ b2b_center: b2bCenterSource }),
        opportunities: new InMemoryOpportunitiesRepository({ [sample._id]: sample }),
        jobs,
      });
      const receipt = await service.reprocess(actor, 'b2b_center', { opportunityId: sample._id });
      assert.equal(receipt.status, 'unsupported');
      assert.equal(receipt.reasonCode, reasonCode);
      assert.equal(jobs.enqueued.length, 0);
    }
  });

  it('runs retained public API mappers without canonical replay or resurrecting a closed occurrence', async () => {
    const fixture = (path) => JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8'));
    const payloads = {
      remoteok: fixture('remote-public-feeds/remoteok.json')[1],
      remotive: fixture('remote-public-feeds/remotive.json').jobs[0],
      trudvsem: fixture('trudvsem/vacancies-native.json').results.vacancies[0].vacancy,
    };
    for (const [sourceId, rawPayload] of Object.entries(payloads)) {
      const mapped = new PublicApiFeedConnector(sourceId).mapRetainedPayload(rawPayload);
      const sample = publicSample(sourceId, mapped);
      sample.sourceOccurrence.sourceMetadata.skills = ['STALE SKILL'];
      sample.sourceOccurrence.sourceMetadata.remoteType = 'STALE REMOTE';
      sample.sourceOccurrence.sourceMetadata.salary = { min: 999999, currency: 'STALE' };
      sample.sourceOccurrence.status = 'Closed';
      const jobs = new InMemoryJobsService();
      const opportunitiesService = new InMemoryOpportunitiesService();
      const { service, tools } = serviceWith({
        sources: new InMemorySourcesRepository({ [sourceId]: publicSource(sourceId) }),
        opportunities: new InMemoryOpportunitiesRepository({ [sample._id]: sample }),
        jobs, opportunitiesService,
      });
      const before = snapshotSourceControls(sample);
      const capabilities = await tools.capabilities(sourceId, sample._id);
      assert.equal(capabilities.capabilities.actions.reprocess.supported, true);
      assert.equal(capabilities.capabilities.actions.normalize.supported, true);
      assert.equal(capabilities.capabilities.actions.deduplicate.supported, true);
      const receipt = await service.normalize(actor, sourceId, { opportunityId: sample._id });
      assert.equal(receipt.status, 'queued');
      const result = await tools.handleRetainedRawJob('normalize', jobs.enqueued[0].data);
      assert.equal(result.status, 'completed');
      const repair = opportunitiesService.repairs[0];
      assert.equal(repair.normalized.title, mapped.title);
      assert.equal(repair.normalized.description, mapped.description);
      assert.equal(repair.normalized.companyOrClient, mapped.companyOrClient ?? '');
      assert.equal(repair.normalized.skills.includes('STALE SKILL'), false);
      assert.equal(repair.normalized.remoteType === 'STALE REMOTE', false);
      assert.equal(repair.normalized.money.currency === 'STALE', false);
      assert.equal(repair.normalized.sourceStatus, 'Closed');
      assert.equal(repair.sourceRunId, 'original-public-run');
      assert.deepEqual(repair.normalized.sourceOccurrences[0].rawPayload, rawPayload);
      assert.equal(repair.normalized.sourceOccurrences[0].publishedAt.toISOString(), sample.sourceOccurrence.publishedAt.toISOString());
      assert.deepEqual(snapshotSourceControls(sample), before);
    }
  });

  it('rejects malformed, removed and mismatched public raw targets before queueing', async () => {
    const mapped = new PublicApiFeedConnector('remoteok').mapRetainedPayload({ id: 77, position: 'Native title', description: 'Native description', url: 'https://remoteok.com/remote-jobs/77' });
    for (const [change, reasonCode] of [
      [(sample) => { sample.sourceOccurrence.rawPayload = { id: 77 }; }, 'missing_retained_native_payload'],
      [(sample) => { sample.sourceOccurrence.externalId = 'other'; }, 'identity_mismatch'],
      [(sample) => { sample.sourceOccurrence.url = 'https://remoteok.com/remote-jobs/other'; }, 'identity_mismatch'],
      [(sample) => { sample.sourceOccurrence.rawPayload.url = 'javascript:alert(1)'; }, 'invalid_native_url'],
      [(sample) => { sample.sourceOccurrence.status = 'Removed'; }, 'removed_source_occurrence'],
    ]) {
      const sample = publicSample('remoteok', structuredClone(mapped));
      change(sample);
      const jobs = new InMemoryJobsService();
      const { service } = serviceWith({
        sources: new InMemorySourcesRepository({ remoteok: publicSource('remoteok') }),
        opportunities: new InMemoryOpportunitiesRepository({ [sample._id]: sample }), jobs,
      });
      const receipt = await service.reprocess(actor, 'remoteok', { opportunityId: sample._id });
      assert.equal(receipt.status, 'unsupported');
      assert.equal(receipt.reasonCode, reasonCode);
      assert.equal(jobs.enqueued.length, 0);
    }
  });

  it('fails queued retained repairs when the source occurrence revision changed', async () => {
    const jobs = new InMemoryJobsService();
    const mutableSample = structuredClone(fabrikantSample);
    const opportunities = new InMemoryOpportunitiesRepository({ 'fab-opp-1': mutableSample });
    const opportunitiesService = new InMemoryOpportunitiesService();
    const { service, tools } = serviceWith({ jobs, opportunities, opportunitiesService, normalizer: new SourceNormalizerService() });
    await service.normalize(actor, 'fabrikant', { opportunityId: 'fab-opp-1' });
    mutableSample.sourceOccurrence.rawPayload.nativeCatalogCard.title = 'Changed after queue';

    await assert.rejects(() => tools.handleRetainedRawJob('normalize', jobs.enqueued[0].data), /changed after tool request/);
    assert.equal(opportunitiesService.repairs.length, 0);
  });



  it('uses the same source occurrence revision from tool queue payload through repository CAS', async () => {
    const jobs = new InMemoryJobsService();
    const opportunities = new InMemoryOpportunitiesRepository();
    const { service } = serviceWith({ jobs, opportunities });
    const queued = await service.normalize(actor, 'fabrikant', { opportunityId: 'fab-opp-1' });
    const liveSample = await opportunities.getSourceSample('fabrikant', 'fab-opp-1');

    assert.equal(queued.status, 'queued');
    assert.equal(jobs.enqueued[0].data.expectedOccurrenceRevision, sourceOccurrenceRevision(liveSample._id, liveSample.sourceOccurrence));
  });

  it('repairs retained source occurrence by CAS while preserving pinned corrections and source history', async () => {
    const stored = structuredClone({
      ...fabrikantSample,
      title: 'Pinned title',
      companyOrClient: 'Old company',
      sourceOccurrences: [structuredClone(fabrikantSample.sourceOccurrence)],
      adminCorrections: [{ field: 'title', value: 'Pinned title', reason: 'manual', correctedBy: 'admin-1', correctedAt: new Date('2026-10-05T00:00:00.000Z'), pinned: true }],
    });
    const beforeOccurrence = JSON.stringify(stored.sourceOccurrences[0]);
    const beforeLastSeenAt = stored.lastSeenAt.toISOString();
    const model = makeOpportunityModel(stored);
    const repository = new OpportunitiesRepository(model, {});

    const updated = await repository.repairRetainedSourceOccurrenceExact({
      opportunityId: stored._id,
      sourceId: 'fabrikant',
      externalId: fabrikantCard.id,
      url: fabrikantCard.url,
      expectedOccurrenceRevision: sourceOccurrenceRevision(stored._id, stored.sourceOccurrences[0]),
      occurrencePatch: {
        publishedAt: new Date('2026-10-06T14:06:00.000Z'),
        status: 'Active',
        normalizedSnapshot: { money: { amount: 22230.52, currency: 'RUB' }, deadline: new Date('2026-10-12T21:00:00.000Z'), sourceStatus: 'Active' },
      },
      canonicalPatch: {
        title: 'Mapper title must not override pinned title',
        companyOrClient: 'ГБУ Заказчик',
        money: { amount: 22230.52, currency: 'RUB' },
        deadline: new Date('2026-10-12T21:00:00.000Z'),
        sourceStatus: 'Active',
        tenderData: { procedureNumber: fabrikantCard.procedureNumber },
      },
    });

    assert.equal(updated.title, 'Pinned title');
    assert.equal(updated.companyOrClient, 'ГБУ Заказчик');
    assert.equal(updated.lastSeenAt.toISOString(), beforeLastSeenAt);
    assert.equal(updated.sourceOccurrences[0].firstSeenAt.toISOString(), fabrikantSample.sourceOccurrence.firstSeenAt.toISOString());
    assert.equal(updated.sourceOccurrences[0].lastSeenAt.toISOString(), fabrikantSample.sourceOccurrence.lastSeenAt.toISOString());
    assert.equal(updated.sourceOccurrences[0].checksum, 'original-checksum');
    assert.deepEqual(updated.sourceOccurrences[0].rawPayload, fabrikantSample.sourceOccurrence.rawPayload);
    assert.deepEqual(updated.sourceOccurrences[0].sourceMetadata, fabrikantSample.sourceOccurrence.sourceMetadata);
    assert.equal(updated.sourceOccurrences[0].status, 'Active');
    assert.equal(updated.sourceOccurrences[0].normalizedSnapshot.deadline.toISOString(), '2026-10-12T21:00:00.000Z');
    assert.equal(model.filters[0].adminCorrections.length, 1);
    assert.notEqual(JSON.stringify(updated.sourceOccurrences[0]), beforeOccurrence);
  });


  it('clears stale absent native fields only for primary unpinned canonical facts', async () => {
    for (const primary of [true, false]) {
      const stored = structuredClone({ ...fabrikantSample, remoteType: 'Полный рабочий день', seniority: 'Stale seniority', employmentType: 'Pinned employment',
        sourceOccurrences: [{ ...fabrikantSample.sourceOccurrence, primary }],
        adminCorrections: [{ field: 'employmentType', value: 'Pinned employment', pinned: true }],
      });
      const model = makeOpportunityModel(stored);
      const repository = new OpportunitiesRepository(model, {});
      const updated = await repository.repairRetainedSourceOccurrenceExact({
        opportunityId: stored._id, sourceId: 'fabrikant', externalId: fabrikantCard.id, url: fabrikantCard.url,
        expectedOccurrenceRevision: sourceOccurrenceRevision(stored._id, stored.sourceOccurrences[0]),
        occurrencePatch: { publishedAt: stored.sourceOccurrences[0].publishedAt, status: 'Unknown', normalizedSnapshot: { money: {}, sourceStatus: 'Unknown' } },
        canonicalPatch: { remoteType: undefined, seniority: undefined, employmentType: undefined },
      });
      assert.equal(updated.employmentType, 'Pinned employment');
      assert.equal(Object.hasOwn(updated, 'remoteType'), !primary);
      assert.equal(Object.hasOwn(updated, 'seniority'), !primary);
    }
  });

  it('keeps an absent publication date absent during retained repair', async () => {
    const stored = structuredClone({ ...fabrikantSample, sourceOccurrences: [fabrikantSample.sourceOccurrence], adminCorrections: [] });
    delete stored.sourceOccurrences[0].publishedAt;
    const model = makeOpportunityModel(stored);
    const repository = new OpportunitiesRepository(model, {});
    const updated = await repository.repairRetainedSourceOccurrenceExact({
      opportunityId: stored._id, sourceId: 'fabrikant', externalId: fabrikantCard.id, url: fabrikantCard.url,
      expectedOccurrenceRevision: sourceOccurrenceRevision(stored._id, stored.sourceOccurrences[0]),
      occurrencePatch: { publishedAt: undefined, status: 'Unknown', normalizedSnapshot: { money: {}, sourceStatus: 'Unknown' } },
      canonicalPatch: { companyOrClient: 'Native company' },
    });
    assert.equal(Object.hasOwn(updated.sourceOccurrences[0], 'publishedAt'), false);
    assert.deepEqual(updated.sourceOccurrences[0].rawPayload, fabrikantSample.sourceOccurrence.rawPayload);
  });

  it('rejects retained repair when source occurrence changes between CAS reads', async () => {
    const stored = structuredClone({
      ...fabrikantSample,
      sourceOccurrences: [structuredClone(fabrikantSample.sourceOccurrence)],
      adminCorrections: [],
    });
    const revision = sourceOccurrenceRevision(stored._id, stored.sourceOccurrences[0]);
    const model = makeRaceOpportunityModel(stored);
    const repository = new OpportunitiesRepository(model, {});

    const result = await repository.repairRetainedSourceOccurrenceExact({
      opportunityId: stored._id,
      sourceId: 'fabrikant',
      externalId: fabrikantCard.id,
      url: fabrikantCard.url,
      expectedOccurrenceRevision: revision,
      occurrencePatch: {
        publishedAt: new Date('2026-10-06T14:06:00.000Z'),
        status: 'Active',
        normalizedSnapshot: { money: { amount: 22230.52, currency: 'RUB' }, sourceStatus: 'Active' },
      },
      canonicalPatch: { companyOrClient: 'ГБУ Заказчик' },
    });

    assert.equal(result, false);
    assert.equal(model.updateAttempts, 1);
    assert.equal(model.record.sourceOccurrences[0].rawPayload.nativeCatalogCard.title, 'Changed during CAS race');
    assert.equal(model.record.companyOrClient, fabrikantSample.companyOrClient);
  });

  it('propagates repair failures instead of reporting completed jobs', async () => {
    const jobs = new InMemoryJobsService();
    const opportunitiesService = new InMemoryOpportunitiesService({ fail: true });
    const { service, tools } = serviceWith({ jobs, opportunitiesService, normalizer: new SourceNormalizerService() });
    await service.reprocess(actor, 'fabrikant', { opportunityId: 'fab-opp-1' });

    await assert.rejects(() => tools.handleRetainedRawJob('reprocess', jobs.enqueued[0].data), /repair failed/);
    assert.equal(opportunitiesService.repairs.length, 1);
  });
});




function b2bRetainedFixture() {
  const nativeTrade = JSON.parse(readFileSync(new URL('./fixtures/b2b-center-native/api-search-buy-all-page-1.json', import.meta.url), 'utf8')).trades[0];
  const listUrl = 'https://www.b2b-center.ru/site/api/v1/market-search/?date_start_dmy=06.09.2026&date_end_dmy=06.10.2026&macro_trade_type=buy&tab=all&sort=date_desc&page=1&page_size=20&is_seo=0';
  const detailUrl = 'https://www.b2b-center.ru/app/market-next/postavka-bumazhnykh-paketov-dlia-khleba-ts-perekrestok/tender-4630191/';
  return {
    rawPayload: {
      native: { url: listUrl, trade: nativeTrade, publishedText: nativeTrade.date_published, deadlineText: nativeTrade.date_actual, detailUrl },
      detail: {
        url: detailUrl,
        rows: {},
        title: 'Объявление о продаже № 4630191 Зарегистрируйтесь, чтобы сохранять процедуры в Избранное',
        description: 'Retained public detail description',
        documents: [],
        htmlHash: 'retained-html-hash',
        publicAccessGap: 'some detail fields are visible only to registered users',
      },
    },
    sourceMetadata: {
      sourceRunId: 'original-b2b-run',
      sourceRunEffectMode: 'historical',
      sourceUrl: listUrl,
      macroTradeType: 'buy',
      nativeKey: '4630191:4630191458',
      windowSince: '2026-09-06T20:08:23.981Z',
      windowUntil: '2026-10-06T20:08:23.981Z',
    },
  };
}

function b2bSample() {
  const retained = b2bRetainedFixture();
  const mapped = new B2bCenterConnector({}).mapRetainedPayload(structuredClone(retained.rawPayload), structuredClone(retained.sourceMetadata));
  return {
    ...structuredClone(fabrikantSample),
    _id: 'b2b-opp-1',
    title: 'STALE B2B TITLE',
    companyOrClient: 'STALE B2B COMPANY',
    description: 'STALE B2B DESCRIPTION',
    sourceStatus: 'Closed',
    publishedAt: new Date('2026-10-06T18:59:00.000Z'),
    sourceOccurrence: {
      ...structuredClone(fabrikantSample.sourceOccurrence),
      sourceId: 'b2b_center',
      externalId: mapped.externalId,
      url: mapped.url,
      publishedAt: new Date('2026-10-06T18:59:00.000Z'),
      status: 'Closed',
      rawPayload: retained.rawPayload,
      sourceMetadata: retained.sourceMetadata,
      normalizedSnapshot: { sourceStatus: 'Closed', money: { originalText: 'stale' } },
    },
  };
}

function publicSource(sourceId) {
  return { ...hhSource, _id: sourceId, name: sourceId, group: 'web', connectorFamily: 'OfficialRestApi' };
}

function publicSample(sourceId, mapped) {
  return {
    ...structuredClone(hhSample),
    _id: `public-${sourceId}`,
    title: 'STALE CANONICAL TITLE', description: 'STALE CANONICAL DESCRIPTION', companyOrClient: 'STALE CANONICAL COMPANY',
    sourceOccurrence: {
      ...structuredClone(hhSample.sourceOccurrence), sourceId, externalId: mapped.externalId, url: mapped.url,
      rawPayload: structuredClone(mapped.rawPayload),
      sourceMetadata: { sourceRunId: 'original-public-run', sourceRunEffectMode: 'historical' },
    },
  };
}

function snapshotSourceControls(item) {
  return JSON.stringify({
    firstSeenAt: item.sourceOccurrence.firstSeenAt,
    lastSeenAt: item.sourceOccurrence.lastSeenAt,
    checksum: item.sourceOccurrence.checksum,
    rawPayload: item.sourceOccurrence.rawPayload,
    sourceMetadata: item.sourceOccurrence.sourceMetadata,
    adminCorrections: item.adminCorrections,
    personalStates: item.personalStates,
  });
}

function serviceWith(overrides = {}) {
  const sources = overrides.sources ?? new InMemorySourcesRepository();
  const opportunities = overrides.opportunities ?? new InMemoryOpportunitiesRepository();
  const jobs = overrides.jobs ?? new InMemoryJobsService();
  const audit = overrides.audit ?? new InMemoryAuditService();
  const normalizer = overrides.normalizer ?? new SourceNormalizerService();
  const opportunitiesService = overrides.opportunitiesService ?? new InMemoryOpportunitiesService();
  const tools = overrides.tools ?? new SourceInspectorToolsService(sources, opportunities, jobs, audit, normalizer, opportunitiesService, { deduplicate: async (opportunityId) => ({ status: 'completed', opportunityId, merged: [], review: [], candidateSearchComplete: true }) });
  const service = new AdminSourceInspectorService(
    sources,
    opportunities,
    audit,
    new InMemoryConfigService(overrides.directory),
    tools,
  );
  return { service, tools, sources, opportunities, jobs, audit, normalizer, opportunitiesService };
}

class InMemorySourcesRepository {
  constructor(extraSources = {}) {
    this.sources = { hh: hhSource, fabrikant: fabrikantSource, b2b_center: b2bCenterSource, ...extraSources };
  }
  async get(id) {
    const item = this.sources[id];
    if (!item) throw new Error('Source not found');
    return item;
  }
}

class InMemoryOpportunitiesRepository {
  constructor(extraSamples = {}) {
    this.samples = { hh: { 'opp-1': hhSample }, fabrikant: { 'fab-opp-1': fabrikantSample } };
    const extra = groupSamples(extraSamples);
    for (const [sourceId, items] of Object.entries(extra)) this.samples[sourceId] = { ...(this.samples[sourceId] ?? {}), ...items };
  }

  async listSourceSamples(input) {
    assert.equal(input.sourceId, 'hh');
    assert(input.limit <= 50);
    return { items: [hhSample], nextCursor: null };
  }

  async getSourceSample(sourceId, opportunityId) {
    return this.samples[sourceId]?.[opportunityId] ?? null;
  }
}

function groupSamples(samples) {
  const grouped = {};
  for (const [id, item] of Object.entries(samples)) {
    const sourceId = item.sourceOccurrence.sourceId;
    grouped[sourceId] = { ...(grouped[sourceId] ?? {}), [id]: item };
  }
  return grouped;
}

class InMemoryJobsService {
  enqueued = [];
  handlers = new Map();

  registerHandler(queue, name, handler) {
    this.handlers.set(`${queue}:${name}`, handler);
  }

  async enqueue(queue, name, data, options) {
    this.enqueued.push({ queue, name, data, options });
    return { id: `job-${this.enqueued.length}`, queue };
  }
}

class InMemoryAuditService {
  events = [];
  async record(actorArg, action, entityType, entityId, fields) {
    this.events.push({ actor: actorArg, action, entityType, entityId, fields });
  }
}

class InMemoryConfigService {
  constructor(directory) {
    this.directory = directory;
  }
  get(key) {
    if (key === 'LOG_DIRECTORY') return this.directory;
    return undefined;
  }
}

class InMemoryOpportunitiesService {
  constructor(options = {}) {
    this.options = options;
    this.repairs = [];
  }

  async repairRetainedSourceOccurrence(input) {
    this.repairs.push(input);
    if (this.options.fail) throw new Error('repair failed');
    return { opportunity: { _id: input.opportunityId }, repaired: true };
  }
}
