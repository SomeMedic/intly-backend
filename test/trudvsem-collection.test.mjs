import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const liveFixture = require('./fixtures/trudvsem/vacancies-native.json');
const emptyNativeFixture = require('./fixtures/trudvsem/empty-native-page.json');
// Keep native field mapping independent from the live broad-window count.
const mappingFixture = { ...liveFixture, meta: { ...liveFixture.meta, total: 4 } };
const { PublicApiFeedConnector } = require('../src/modules/sources/connectors/public-api-feed.connector.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

function source(overrides = {}) {
  return {
    _id: 'trudvsem',
    name: 'Trudvsem',
    enabled: true,
    runtimeState: 'Enabled',
    checkpoint: {},
    connectorFamily: 'OfficialRestApi',
    endpoint: {},
    config: {},
    limits: { perPage: 4 },
    timeoutMs: 30_000,
    group: 'jobs',
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    source: source(overrides.source),
    requestId: 'trudvsem-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

function patchGetJson(connector, handler) {
  connector.getJson = handler;
}

test('trudvsem maps native live vacancy fields without dropping payload or inventing facts', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('offset'), '0');
    assert.equal(parsed.searchParams.get('limit'), '4');
    assert.equal(parsed.searchParams.get('modifiedFrom'), '2026-09-04T00:00:00Z');
    return mappingFixture;
  });

  const page = await connector.fetchPage(ctx({ checkpoint: { page: 7, hasMore: false } }));
  const native = liveFixture.results.vacancies[0].vacancy;
  const record = page.records[0];

  assert.equal(page.hasMore, false);
  assert.equal(page.nextPage, undefined);
  assert.equal(page.checkpoint.page, 0);
  assert.equal(page.checkpoint.providerTotal, 4);
  assert.equal(page.checkpoint.providerLimit, 4);
  assert.equal(page.checkpoint.observedScope, 'trudvsem-modified-window');
  assert.deepEqual(record.rawPayload, native);
  assert.equal(record.externalId, native.id);
  assert.equal(record.url, native.vac_url);
  assert.equal(record.title, native['job-name']);
  assert.equal(record.companyOrClient, native.company.name);
  assert.equal(record.publishedAt.toISOString(), '2026-05-12T00:00:00.000Z');
  assert.equal(record.updatedAt.toISOString(), '2026-10-03T10:40:01.000Z');
  assert.match(record.description, /Выполнение сварки/);
  assert.match(record.description, /Опыт работы с электроинструментом/);
  assert.match(record.description, /среднее профессиональное/);
  assert.match(record.description, /Добровольное медицинское страхование/);
  assert.deepEqual(record.sourceMetadata.salary, { min: 70000, max: 80000, currency: 'RUB', originalText: 'от 70000' });
  assert.equal(record.sourceMetadata.nativeCurrencyText, '«руб.»');
  assert.equal(record.sourceMetadata.employment, 'Полная занятость');
  assert.equal(record.sourceMetadata.nativeSchedule, 'Полный рабочий день');
  assert.equal(record.sourceMetadata.schedule, undefined);
  assert.equal(record.sourceMetadata.area, 'Саратовская область, г Энгельс, Фридриха Энгельса проспект, 139');
  assert.equal(record.sourceMetadata.location, 'Саратовская область, г Энгельс, Фридриха Энгельса проспект, 139');
  assert.equal(record.sourceMetadata.regionName, 'Саратовская область');
  assert.equal(record.sourceMetadata.regionCode, '6400000000000');
  assert.deepEqual(record.sourceMetadata.locations, [
    {
      label: 'Саратовская область, г Энгельс, Фридриха Энгельса проспект, 139',
      location: 'Саратовская область, г Энгельс, Фридриха Энгельса проспект, 139',
      lng: '46.112392',
      lat: '51.46462',
    },
  ]);
  assert.deepEqual(record.sourceMetadata.skills, [
    'Чтение схем/чертежей',
    'Сварочные работы',
    'Навыки сварки во всех пространственных положениях',
    'Контактная/стыковая сварка',
    'Сварка в среде защитного газа',
  ]);
  assert.deepEqual(record.sourceMetadata.vacancyData, {
    schedule: 'Полный рабочий день',
    employment: 'Полная занятость',
    qualification: 'среднее профессиональное',
    requirements: native.requirements,
    education: 'Среднее профессиональное образование',
    experience: 1,
    companyCode: '1136449002546',
    regionCode: '6400000000000',
    category: 'Производство',
    typicalPosition: 'Сварщик',
    workPlaces: 1,
  });
});

test('trudvsem metadata propagates through existing canonical normalizer fields', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async () => mappingFixture);

  const page = await connector.fetchPage(ctx());
  const normalized = new SourceNormalizerService().normalize(source(), page.records[0]);

  assert.deepEqual(normalized.money, { originalText: 'от 70000', min: 70000, max: 80000, currency: 'RUB' });
  assert.equal(normalized.location, 'Саратовская область, г Энгельс, Фридриха Энгельса проспект, 139');
  assert.equal(normalized.employmentType, 'Полная занятость');
  assert.equal(normalized.remoteType, undefined);
  assert.deepEqual(normalized.skills, [
    'Чтение схем/чертежей',
    'Сварочные работы',
    'Навыки сварки во всех пространственных положениях',
    'Контактная/стыковая сварка',
    'Сварка в среде защитного газа',
  ]);
  assert.deepEqual(normalized.sourceOccurrences[0].sourceMetadata.vacancyData, page.records[0].sourceMetadata.vacancyData);
  assert.deepEqual(normalized.vacancyData, { ...page.records[0].sourceMetadata.vacancyData, sourceName: 'Trudvsem' });
});

test('trudvsem keeps shift schedules separate from explicitly remote work', () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  const native = liveFixture.results.vacancies[0].vacancy;
  const normalizer = new SourceNormalizerService();
  for (const schedule of ['Полный рабочий день', 'Вахтовый метод', 'Гибкий график']) {
    const record = connector.trudvsemRecord({ ...native, schedule });
    const normalized = normalizer.normalize(source(), record);
    assert.equal(normalized.remoteType, undefined);
    assert.equal(normalized.vacancyData.schedule, schedule);
    assert.equal(record.sourceMetadata.nativeSchedule, schedule);
  }
  const remote = normalizer.normalize(source(), connector.trudvsemRecord({ ...native, schedule: 'Удаленная работа' }));
  assert.equal(remote.remoteType, 'Remote');
  assert.equal(remote.vacancyData.schedule, 'Удаленная работа');
});

test('trudvsem applies local modified upper bound after provider discovery', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('modifiedTo'), '2026-10-04T12:00:00Z');
    return {
      status: '200',
      meta: { total: 2, limit: 2 },
      results: {
        vacancies: [
          { vacancy: { id: 'inside', 'job-name': 'Inside', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/inside', date_modify: '2026-10-04T12:00:00.000Z' } },
          { vacancy: { id: 'outside', 'job-name': 'Outside', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/outside', date_modify: '2026-10-04T12:00:00.001Z' } },
        ],
      },
    };
  });

  const page = await connector.fetchPage(ctx({ source: { limits: { perPage: 2 } }, checkpoint: { modifiedTo: '2026-10-04T12:00:00.000Z', hasMore: true } }));

  assert.deepEqual(page.records.map((record) => record.externalId), ['inside']);
  assert.equal(page.checkpoint.modifiedTo, '2026-10-04T12:00:00.000Z');
});

test('trudvsem validates URL fallback and rejects missing required identity fields', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async () => ({
    status: '200',
    meta: { total: 1, limit: 1 },
    results: {
      vacancies: [
        {
          vacancy: {
            id: 'fallback-id',
            'job-name': 'Fallback URL',
            company: { companycode: '1025500970516' },
          },
        },
      ],
    },
  }));

  const page = await connector.fetchPage(ctx({ source: { limits: { perPage: 1 } } }));
  assert.equal(page.records[0].url, 'https://trudvsem.ru/vacancy/card/1025500970516/fallback-id');

  patchGetJson(connector, async () => ({
    status: '200',
    meta: { total: 1, limit: 1 },
    results: { vacancies: [{ vacancy: { id: 'missing-title', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/missing-title' } }] },
  }));
  await assert.rejects(() => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } } })), /missing required title/);

  patchGetJson(connector, async () => ({
    status: '200',
    meta: { total: 1, limit: 1 },
    results: { vacancies: [{ vacancy: { id: 'real-id', 'job-name': 'Wrong URL id', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/other-id' } }] },
  }));
  await assert.rejects(() => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } } })), /missing valid vac_url and companycode/);

  patchGetJson(connector, async () => ({
    status: '200',
    meta: { total: 1, limit: 1 },
    results: { vacancies: [{ vacancy: { id: '../unsafe', 'job-name': 'Unsafe fallback', company: { companycode: '1025500970516' } } }] },
  }));
  await assert.rejects(() => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } } })), /missing valid vac_url and companycode/);
});

test('trudvsem rejects malformed envelopes, incorrect response counts, and unsafe continuation cursors', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');

  patchGetJson(connector, async () => ({ status: '200', meta: { total: 1, limit: 1 }, results: {} }));
  await assert.rejects(() => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } } })), /results\.vacancies/);

  patchGetJson(connector, async () => ({ status: '200', meta: { total: 3, limit: 2 }, results: { vacancies: [{ vacancy: { id: 'one', 'job-name': 'One', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/one' } }] } }));
  await assert.rejects(() => connector.fetchPage(ctx({ source: { limits: { perPage: 2 } } })), /short page/);

  patchGetJson(connector, async () => ({ status: '200', meta: { total: 1, limit: 1 }, results: { vacancies: [
    { vacancy: { id: 'too-many-1', 'job-name': 'Too many one', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/too-many-1' } },
    { vacancy: { id: 'too-many-2', 'job-name': 'Too many two', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/too-many-2' } },
  ] } }));
  await assert.rejects(() => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } } })), /oversize page/);

  patchGetJson(connector, async () => ({ status: '200', meta: { total: 2, limit: 1 }, results: { vacancies: [] } }));
  await assert.rejects(() => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } }, checkpoint: activeCheckpoint({ page: 1, providerTotal: 2, limit: 1, ids: ['previous'] }) })), /unsafe pagination/);

  patchGetJson(connector, async () => ({ status: '200', meta: { total: 0, limit: 1 }, results: { vacancies: [] } }));
  const empty = await connector.fetchPage(ctx({ source: { limits: { perPage: 1 } } }));
  assert.equal(empty.hasMore, false);
  assert.deepEqual(empty.records, []);

  patchGetJson(connector, async () => ({ status: '200', meta: { total: 4, limit: 2 }, results: { vacancies: [
    { vacancy: { id: 'same-1', 'job-name': 'Same one', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/same-1' } },
    { vacancy: { id: 'same-2', 'job-name': 'Same two', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/same-2' } },
  ] } }));
  await assert.rejects(() => connector.fetchPage(ctx({
    source: { limits: { perPage: 2 } },
    checkpoint: activeCheckpoint({ page: 1, providerTotal: 4, limit: 2, ids: ['same-1', 'same-2'] }),
  })), /unsafe pagination/);

  patchGetJson(connector, async () => ({ status: '200', meta: { total: 5, limit: 2 }, results: { vacancies: [
    { vacancy: { id: 'drift-1', 'job-name': 'Drift one', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/drift-1' } },
    { vacancy: { id: 'drift-2', 'job-name': 'Drift two', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/drift-2' } },
  ] } }));
  await assert.rejects(() => connector.fetchPage(ctx({
    source: { limits: { perPage: 2 } },
    checkpoint: activeCheckpoint({ page: 1, providerTotal: 4, limit: 2, ids: ['previous-1', 'previous-2'] }),
  })), /unsafe pagination/);
});

test('trudvsem validates cursor and preserves checkpoint lower bound before requests', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async () => {
    throw new Error('request should not be sent');
  });

  await assert.rejects(() => connector.fetchPage(ctx({ page: -1 })), /page cursor/);
  await assert.rejects(() => connector.fetchPage(ctx({ source: { limits: { perPage: 0 } } })), /perPage/);

  patchGetJson(connector, async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('modifiedFrom'), '2026-10-04T10:35:50Z');
    assert.equal(parsed.searchParams.get('modifiedTo'), '2026-10-04T10:36:30Z');
    return {
      status: '200',
      meta: { total: 1, limit: 1 },
      results: { vacancies: [{ vacancy: { id: 'retry', 'job-name': 'Retry', vac_url: 'https://trudvsem.ru/vacancy/card/1025500970516/retry', date_modify: '2026-10-04T10:36:00Z' } }] },
    };
  });

  const page = await connector.fetchPage(ctx({
    source: { limits: { perPage: 1 } },
    checkpoint: {
      hasMore: true,
      page: 0,
      modifiedFrom: '2026-10-04T10:35:50.000Z',
      modifiedTo: '2026-10-04T10:36:30.000Z',
    },
  }));
  assert.deepEqual(page.records.map((record) => record.externalId), ['retry']);
  assert.equal(page.checkpoint.modifiedFrom, '2026-10-04T10:35:50.000Z');
  assert.equal(page.checkpoint.modifiedTo, '2026-10-04T10:36:30.000Z');
});


function vacancy(id, date = '2026-10-04T10:00:05Z') {
  return { id, 'job-name': `Vacancy ${id}`, vac_url: `https://trudvsem.ru/vacancy/card/1025500970516/${id}`, date_modify: date };
}

function envelope(items, total = items.length, limit = 2) {
  return { status: '200', meta: { total, limit }, results: { vacancies: items.map((item) => ({ vacancy: item })) } };
}

function activeCheckpoint({ page = 0, providerTotal, limit = 2, ids = [], from = '2026-10-04T10:00:00.123Z', to = '2026-10-04T10:00:12.456Z' } = {}) {
  const apiFrom = from.replace(/\.\d{3}Z$/, 'Z');
  const apiTo = to.replace(/\.\d{3}Z$/, 'Z');
  return {
    version: 4,
    coverageMethod: 'single-response-date-partitions',
    hasMore: true,
    page,
    modifiedFrom: from,
    modifiedTo: to,
    providerLimit: limit,
    currentPartition: { modifiedFrom: apiFrom, modifiedTo: apiTo, page, ...(providerTotal === undefined ? {} : { providerTotal }), seenExternalIds: ids, lastPageExternalIds: ids.slice(-limit) },
    pendingPartitions: [],
    completedThrough: apiFrom,
    completedPartitionCount: 0,
    completedProviderRecords: 0,
    splitCount: 0,
  };
}

function partitionContext(checkpoint, perPage = 2, overrides = {}) {
  return ctx({ source: source({ limits: { perPage } }), checkpoint, backfillSince: '2026-10-04T10:00:00.123Z', ...overrides });
}

async function exhaust(connector, checkpoint, { perPage = 2, page = 999 } = {}) {
  const pages = [];
  for (let calls = 0; calls < 200; calls += 1) {
    const result = await connector.fetchPage(partitionContext(checkpoint, perPage, { page }));
    pages.push(result);
    checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
    if (!result.hasMore) return pages;
  }
  throw new Error('test partition walk failed to reach explicit terminal');
}

test('trudvsem recursively splits over-cap windows and resumes until every branch is exhausted', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  const calls = [];
  const dataset = [1, 4, 8, 11].map((second) => vacancy(`at-${second}`, `2026-10-04T10:00:${String(second).padStart(2, '0')}Z`));
  patchGetJson(connector, async (url) => {
    const params = new URL(url).searchParams;
    const from = Date.parse(params.get('modifiedFrom'));
    const to = Date.parse(params.get('modifiedTo'));
    const page = Number(params.get('offset'));
    const limit = Number(params.get('limit'));
    assert.ok(page * limit < 10_000);
    calls.push({ from: params.get('modifiedFrom'), to: params.get('modifiedTo'), page });
    const matching = dataset.filter((item) => Date.parse(item.date_modify) >= from && Date.parse(item.date_modify) <= to);
    const total = to - from > 6_000 ? 10_001 : matching.length;
    assert.ok(total <= 10_000 || page === 0, 'an oversized partition must only be probed at page zero');
    return envelope(matching.slice(page * limit, (page + 1) * limit), total, limit);
  });
  const pages = await exhaust(connector, activeCheckpoint());
  const terminal = pages.at(-1);
  const observations = pages.flatMap((result) => result.records);
  const canonicalByNativeId = new Map(observations.map((record) => [record.externalId, record]));
  assert.deepEqual([...canonicalByNativeId.keys()].sort(), dataset.map((item) => item.id).sort());
  assert.ok(observations.length > canonicalByNativeId.size, 'overlap reaches native identity upserts as updates');
  assert.deepEqual(calls.filter((call) => call.page === 0).map(({ from, to }) => [from, to]), [
    ['2026-10-04T10:00:00Z', '2026-10-04T10:00:12Z'],
    ['2026-10-04T10:00:00Z', '2026-10-04T10:00:07Z'],
    ['2026-10-04T10:00:00Z', '2026-10-04T10:00:04Z'],
    ['2026-10-04T10:00:03Z', '2026-10-04T10:00:07Z'],
    ['2026-10-04T10:00:06Z', '2026-10-04T10:00:12Z'],
  ]);
  for (const result of pages) {
    assert.equal(result.checkpoint.version, 4);
    assert.equal(result.checkpoint.modifiedFrom, '2026-10-04T10:00:00.123Z');
    assert.equal(result.checkpoint.modifiedTo, '2026-10-04T10:00:12.456Z');
    assert.equal(result.checkpoint.seenExternalIds, undefined);
    if (result.hasMore) assert.ok(result.checkpoint.currentPartition.seenExternalIds.length <= 10_000);
  }
  assert.equal(terminal.hasMore, false);
  assert.equal(terminal.nextPage, undefined);
  assert.equal(terminal.checkpoint.currentPartition, null);
  assert.deepEqual(terminal.checkpoint.pendingPartitions, []);
  assert.equal(terminal.checkpoint.completedThrough, '2026-10-04T10:00:12Z');
  assert.equal(terminal.checkpoint.completedPartitionCount, 3);
  assert.equal(terminal.checkpoint.completedProviderRecords, 5, 'provider observations include overlapping records');
  assert.equal(terminal.checkpoint.splitCount, 2);
  assert.equal(terminal.checkpoint.terminalReason, 'all-date-partitions-exhausted');
});

test('trudvsem full-second overlap keeps interior boundary vacancies when provider bounds are exclusive', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  const dataset = Array.from({ length: 11 }, (_, index) => vacancy(`exclusive-${index + 1}`, `2026-10-04T10:00:${String(index + 1).padStart(2, '0')}Z`));
  patchGetJson(connector, async (url) => {
    const params = new URL(url).searchParams;
    const from = Date.parse(params.get('modifiedFrom'));
    const to = Date.parse(params.get('modifiedTo'));
    const page = Number(params.get('offset'));
    const matching = dataset.filter((item) => Date.parse(item.date_modify) > from && Date.parse(item.date_modify) < to);
    return envelope(matching.slice(page * 2, (page + 1) * 2), to - from > 6_000 ? 10_001 : matching.length);
  });
  const pages = await exhaust(connector, activeCheckpoint());
  assert.deepEqual([...new Set(pages.flatMap((result) => result.records.map((record) => record.externalId)))].sort(), dataset.map((item) => item.id).sort());
});

test('trudvsem empty leaf partitions advance to pending work and terminal means all leaves exhausted', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async (url) => {
    const params = new URL(url).searchParams;
    if (params.get('modifiedTo') === '2026-10-04T10:00:06Z' && params.get('modifiedFrom') === '2026-10-04T10:00:00Z') return envelope([vacancy('probe-1'), vacancy('probe-2')], 10_001);
    if (params.get('modifiedTo') === '2026-10-04T10:00:04Z') return { ...envelope([], 0), results: {} };
    return envelope([vacancy('last')], 1);
  });
  const pages = await exhaust(connector, activeCheckpoint({ to: '2026-10-04T10:00:06.456Z' }));
  assert.equal(pages.length, 3);
  assert.deepEqual(pages[0].records, []);
  assert.deepEqual(pages[1].records, []);
  assert.equal(pages[1].hasMore, true);
  assert.equal(pages[1].checkpoint.completedPartitionCount, 1);
  assert.deepEqual(pages[2].records.map((record) => record.externalId), ['last']);
  assert.equal(pages[2].hasMore, false);
  assert.equal(pages[2].checkpoint.completedPartitionCount, 2);
});

test('trudvsem accepts the observed native empty-results envelope only for a verified zero total', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async () => emptyNativeFixture);
  const page = await connector.fetchPage(partitionContext({}, 50));
  assert.deepEqual(page.records, []); assert.equal(page.stats.seen, 0);
  assert.equal(page.hasMore, false); assert.equal(page.checkpoint.completedPartitionCount, 1);
  assert.equal(page.checkpoint.completedProviderRecords, 0);
  assert.equal(page.checkpoint.completedThrough, page.checkpoint.modifiedTo.slice(0, 19) + 'Z');
  for (const payload of [
    { ...emptyNativeFixture, meta: { total: 1, limit: 50 } },
    { ...emptyNativeFixture, results: undefined },
    { ...emptyNativeFixture, results: { vacancies: null } },
    { ...emptyNativeFixture, results: { error: 'upstream unavailable' } },
    { ...emptyNativeFixture, status: '500' },
    { ...emptyNativeFixture, meta: { limit: 50 } },
  ]) {
    patchGetJson(connector, async () => payload);
    await assert.rejects(() => connector.fetchPage(partitionContext({}, 50)), /trudvsem API/);
  }
});

test('trudvsem v2 page 200 replays the exact original window under v4 single-response partitions', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  const original = { version: 2, hasMore: true, page: 200, modifiedFrom: '2026-09-05T00:24:47.984Z', modifiedTo: '2026-10-05T00:24:47.986Z', providerLimit: 50, providerTotal: 468631 };
  const request = partitionContext(original, 50, { page: 200, requestId: 'original-run-8cd906ff', backfillSince: original.modifiedFrom });
  patchGetJson(connector, async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('offset'), '0');
    assert.equal(params.get('limit'), '50');
    assert.equal(params.get('modifiedFrom'), '2026-09-05T00:24:47Z');
    assert.equal(params.get('modifiedTo'), '2026-10-05T00:24:47Z');
    return envelope(Array.from({ length: 50 }, (_, index) => vacancy(`legacy-${index}`)), 468631, 50);
  });
  const result = await connector.fetchPage(request);
  assert.equal(result.checkpoint.version, 4);
  assert.equal(result.checkpoint.modifiedFrom, original.modifiedFrom);
  assert.equal(result.checkpoint.modifiedTo, original.modifiedTo);
  assert.equal(result.checkpoint.currentPartition.page, 0);
  assert.equal(result.checkpoint.pendingPartitions.length, 1);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.records, []);
  assert.deepEqual(request.checkpoint, original);
  assert.equal(request.requestId, 'original-run-8cd906ff');
  assert.equal(request.backfillSince, original.modifiedFrom);
});

test('trudvsem refuses malformed or tampered v4 bounds, coverage, limits, and partition cursors before fetching', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  let calls = 0;
  patchGetJson(connector, async () => { calls += 1; throw new Error('must not request'); });
  const mutations = [
    (checkpoint) => { checkpoint.version = 5; },
    (checkpoint) => { checkpoint.modifiedFrom = 'invalid'; },
    (checkpoint) => { checkpoint.modifiedTo = '2026-09-01T00:00:00.000Z'; },
    (checkpoint) => { checkpoint.providerLimit = 50; },
    (checkpoint) => { checkpoint.currentPartition.page = -1; },
    (checkpoint) => { checkpoint.currentPartition.page = null; },
    (checkpoint) => { checkpoint.currentPartition.page = ''; },
    (checkpoint) => { delete checkpoint.hasMore; },
    (checkpoint) => { checkpoint.currentPartition.page = 1; },
    (checkpoint) => { checkpoint.page = 1; },
    (checkpoint) => { checkpoint.currentPartition.modifiedFrom = '2026-10-04T09:59:59Z'; },
    (checkpoint) => { checkpoint.currentPartition.modifiedTo = '2026-10-04T10:00:11Z'; },
    (checkpoint) => { checkpoint.currentPartition.modifiedFrom = '2026-10-04T10:00:00.123Z'; },
    (checkpoint) => { checkpoint.currentPartition.seenExternalIds = ['tampered']; },
    (checkpoint) => { checkpoint.pendingPartitions = [{ modifiedFrom: '2026-10-04T10:00:13Z', modifiedTo: '2026-10-04T10:00:14Z' }]; },
    (checkpoint) => {
      checkpoint.currentPartition.modifiedTo = '2026-10-04T10:00:07Z';
      checkpoint.pendingPartitions = [{ modifiedFrom: '2026-10-04T10:00:08Z', modifiedTo: '2026-10-04T10:00:12Z' }];
      checkpoint.splitCount = 1;
    },
    (checkpoint) => {
      checkpoint.currentPartition.modifiedTo = '2026-10-04T10:00:07Z';
      checkpoint.pendingPartitions = [{ modifiedFrom: '2026-10-04T10:00:05Z', modifiedTo: '2026-10-04T10:00:12Z' }];
      checkpoint.splitCount = 1;
    },
    (checkpoint) => { checkpoint.completedThrough = '2026-10-04T10:00:02Z'; },
    (checkpoint) => { checkpoint.splitCount = 1; },
    (checkpoint) => { checkpoint.completedPartitionCount = '1'; },
    (checkpoint) => { checkpoint.completedProviderRecords = 1; },
  ];
  for (const mutate of mutations) {
    const checkpoint = activeCheckpoint();
    mutate(checkpoint);
    await assert.rejects(() => connector.fetchPage(partitionContext(checkpoint)), /trudvsem/);
  }
  await assert.rejects(() => connector.fetchPage(partitionContext(activeCheckpoint(), 2, { page: -1 })), /page cursor/);
  await assert.rejects(() => connector.fetchPage(partitionContext({ version: 2, hasMore: true, page: 200 })), /frozen/);
  await assert.rejects(() => connector.fetchPage(ctx({ backfillSince: 'not-a-date' })), /backfillSince/);
  await assert.rejects(() => connector.fetchPage(partitionContext(activeCheckpoint({ page: 5_000, providerTotal: 10_001, ids: [] }))), /accessible depth/);
  assert.equal(calls, 0);
});

test('trudvsem fails explicitly for over-cap one-second density instead of truncating', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  let calls = 0;
  patchGetJson(connector, async (url) => {
    calls += 1;
    assert.equal(new URL(url).searchParams.get('offset'), '0');
    return envelope([vacancy('dense-1'), vacancy('dense-2')], 10_001);
  });
  await assert.rejects(() => connector.fetchPage(partitionContext(activeCheckpoint({ to: '2026-10-04T10:00:01.456Z' }))), /unsplittable whole-second interval.*10001.*single-response limit 2/);
  assert.equal(calls, 1);
});

test('trudvsem v4 never uses offsets to retrieve a 10,000-result interval', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  const offsets = [];
  patchGetJson(connector, async (url) => {
    const params = new URL(url).searchParams;
    offsets.push(Number(params.get('offset')));
    assert.equal(params.get('offset'), '0');
    return envelope(Array.from({ length: 100 }, (_, index) => vacancy(`cap-${index}`)), 10_000, 100);
  });
  await assert.rejects(() => exhaust(connector, activeCheckpoint({ limit: 100 }), { perPage: 100 }), /unsplittable.*single-response limit 100.*incomplete/);
  assert.ok(offsets.length > 1);
  assert.ok(offsets.every((offset) => offset === 0));
});

test('trudvsem forwards the caller abort signal to partition probes and continuation requests', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  const controller = new AbortController();
  patchGetJson(connector, async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort(new Error('test cancellation'));
    options.signal.throwIfAborted();
  });
  await assert.rejects(() => connector.fetchPage(partitionContext(activeCheckpoint(), 2, { signal: controller.signal })), /test cancellation/);
});

test('trudvsem validates native identity and malformed metadata even on oversized partition probes', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  for (const malformed of [
    { total: -1, limit: 2 },
    { total: 10_001.5, limit: 2 },
    { total: 10_001, limit: 0 },
    { total: 10_001, limit: 1 },
  ]) {
    patchGetJson(connector, async () => ({ ...envelope([vacancy('probe-1'), vacancy('probe-2')]), meta: malformed }));
    await assert.rejects(() => connector.fetchPage(partitionContext(activeCheckpoint())), /meta/);
  }
  patchGetJson(connector, async () => envelope([{ 'job-name': 'Missing native id' }, vacancy('valid')], 10_001));
  await assert.rejects(() => connector.fetchPage(partitionContext(activeCheckpoint())), /vacancy id/);
});


test('trudvsem v4 refuses a continuation cursor before treating partial or repeated pages as coverage', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  let requests = 0;
  patchGetJson(connector, async () => { requests += 1; return envelope([vacancy('first-again'), vacancy('new-last')], 6); });
  const checkpoint = activeCheckpoint({ page: 2, providerTotal: 6, ids: ['first-again', 'first-other', 'previous-1', 'previous-2'] });
  await assert.rejects(() => connector.fetchPage(partitionContext(checkpoint)), /unsafe pagination/);
  assert.equal(requests, 0);
  assert.equal(checkpoint.hasMore, true);
  assert.equal(checkpoint.completedPartitionCount, 0);
});

test('trudvsem caps configured page size at the official maximum of 100', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async (url) => {
    assert.equal(new URL(url).searchParams.get('limit'), '100');
    return envelope([], 0, 100);
  });
  const result = await connector.fetchPage(partitionContext({}, 500));
  assert.equal(result.hasMore, false);
  assert.equal(result.checkpoint.providerLimit, 100);
});

test('trudvsem rejects a tampered completed v4 checkpoint before opening a new window', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async () => envelope([], 0));
  const result = await connector.fetchPage(partitionContext(activeCheckpoint()));
  result.checkpoint.completedThrough = '2026-10-04T10:00:11Z';
  let requests = 0;
  patchGetJson(connector, async () => { requests += 1; throw new Error('must not request'); });
  await assert.rejects(() => connector.fetchPage(partitionContext(result.checkpoint)), /terminal checkpoint/);
  assert.equal(requests, 0);
});


// Recorded native page-12 IDs from four bounded GET diagnostics on 2026-10-05.
// Raw bodies and the full retained checkpoint remain in the diagnostic reports.
const recordedPage12Ids = [
  "d7e87115-15d8-11f1-973f-37d17022a317",
  "799f6718-6396-11f1-8685-7325a21cb113",
  "a7fc7e38-6397-11f1-8685-7325a21cb113",
  "57a51318-15eb-11f1-973f-37d17022a317",
  "cc5a54e8-15d7-11f1-8bc0-37ef9cb662f7",
  "b6237ec0-3145-11f1-9b21-e9a401f18d9b",
  "97ed2548-08b5-11f1-93cf-9fd44cff2ded",
  "898f5528-15d7-11f1-973f-37d17022a317",
  "c28c42c8-15d7-11f1-973f-37d17022a317",
  "af7ff5e0-15ec-11f1-8bc0-37ef9cb662f7",
  "f15a60a8-15d7-11f1-929d-45f09e15ba18",
  "b46d1b78-15d6-11f1-929d-45f09e15ba18",
  "cf3187d8-6396-11f1-875d-37533a592c34",
  "bc379360-15ec-11f1-929d-45f09e15ba18",
  "90dbb8e8-15ec-11f1-8bc0-37ef9cb662f7",
  "20156688-15ea-11f1-973f-37d17022a317",
  "dc813388-39fd-11f1-90d7-0b2fe3ee63c8",
  "76cfbe20-15eb-11f1-8bc0-37ef9cb662f7",
  "c1661208-66ae-11f0-a744-cb26dff57dd7",
  "ff73bdb8-5fe9-11f1-ae65-05b28ac604d6",
  "d0d9a7a8-7e73-11f1-baa9-e58b42ebc806",
  "eb6547c8-f0dc-11f0-ac31-6d1879456f92",
  "c98c8048-7333-11f0-b34a-e7d0d2cf29b1",
  "f392ce8c-6a18-11f1-b6d4-95f7685a9292",
  "b0063ea8-66ad-11f0-840a-e7d0d2cf29b1",
  "0437d810-f1a2-11f0-a027-0dd543315e5a",
  "eebcc448-f0e9-11f0-ac31-6d1879456f92",
  "cc0a66f8-267c-11f1-bf4d-d51024d60109",
  "b5c33930-2677-11f1-ba68-e7fd5bf5650b",
  "423250f8-267c-11f1-ba68-e7fd5bf5650b",
  "907966a8-9098-11f1-b18b-c5df91bc45ab",
  "ccb3f838-0892-11f1-b61c-b780d0024235",
  "b662d9c8-f591-11f0-a027-0dd543315e5a",
  "7a01c3b8-b09f-11f0-b9e7-1da292080fc3",
  "09d5eb28-121a-11f1-a342-f956761ba410",
  "34311c08-5f1d-11f1-aaeb-750452cc88fa",
  "5cbeb0c8-5f1c-11f1-9171-c73cd5942599",
  "0774a018-5f1d-11f1-aaeb-750452cc88fa",
  "fec14f88-a8d8-11f1-8d85-6f9b8d7d49f7",
  "bfa46f58-a746-11f1-8d85-6f9b8d7d49f7",
  "84cfb358-a8d9-11f1-b4b9-312b1e80675a",
  "3ba14df8-f593-11f0-ba7d-9959eb3311ba",
  "f0902c20-6070-11f1-ae65-05b28ac604d6",
  "c032a538-120f-11f1-b595-a13c6f34b652",
  "f1565008-1208-11f1-b595-a13c6f34b652",
  "0812f9c8-f660-11f0-8628-a3cca5294b78",
  "dfaa83b0-1200-11f1-9f68-13ae6991ef0a",
  "11b5ed18-fc1a-11f0-b450-b9238fb6e585",
  "788bc990-fd76-11ef-8ade-e7d0d2cf29b1",
  "0f8a32c8-5edb-11f1-b27b-17d0e3ce57d4"
];

function recordedPage12(repeatedTie = false) {
  return envelope(recordedPage12Ids.map((id, index) => vacancy(index === 0 && repeatedTie ? 'bc1f5418-6396-11f1-b1a3-adad5cc6cbe1' : id, index === 0 ? '2026-09-07T04:31:23+0300' : '2026-09-07T04:31:22+0300')), 1330, 50);
}

function retainedV3Checkpoint() {
  // Preserve the recorded window/cursor/counts; generated historical IDs keep
  // this permanent regression independent of local diagnostic-file paths.
  const ids = Array.from({ length: 600 }, (_, index) => `historical-${index}`);
  ids[590] = 'bc1f5418-6396-11f1-b1a3-adad5cc6cbe1';
  return {
    version: 3, page: 12, hasMore: true,
    modifiedFrom: '2026-09-05T00:24:47.984Z',
    modifiedTo: '2026-10-05T00:24:47.986Z',
    providerLimit: 50, providerTotal: 1330,
    currentPartition: {
      modifiedFrom: '2026-09-06T21:24:47Z',
      modifiedTo: '2026-09-07T03:02:18Z',
      page: 12, providerTotal: 1330,
      seenExternalIds: ids, lastPageExternalIds: ids.slice(-50),
    },
    pendingPartitions: [
  {
    "modifiedFrom": "2026-09-07T03:02:17Z",
    "modifiedTo": "2026-09-07T08:39:48Z"
  },
  {
    "modifiedFrom": "2026-09-07T08:39:47Z",
    "modifiedTo": "2026-09-07T19:54:48Z"
  },
  {
    "modifiedFrom": "2026-09-07T19:54:47Z",
    "modifiedTo": "2026-09-08T18:24:48Z"
  },
  {
    "modifiedFrom": "2026-09-08T18:24:47Z",
    "modifiedTo": "2026-09-12T12:24:48Z"
  },
  {
    "modifiedFrom": "2026-09-12T12:24:47Z",
    "modifiedTo": "2026-09-20T00:24:48Z"
  },
  {
    "modifiedFrom": "2026-09-20T00:24:47Z",
    "modifiedTo": "2026-10-05T00:24:47Z"
  }
],
    completedThrough: '2026-09-06T21:24:48Z',
    completedPartitionCount: 1,
    completedProviderRecords: 1510,
    splitCount: 7,
  };
}

test('trudvsem v3 retained page 12 migrates all original intervals, preserving unverified history', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  const checkpoint = retainedV3Checkpoint();
  const original = structuredClone(checkpoint);
  const page12Repeat = recordedPage12(true);
  patchGetJson(connector, async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('offset'), '0');
    assert.equal(params.get('modifiedFrom'), '2026-09-05T00:24:47Z');
    assert.equal(params.get('modifiedTo'), '2026-10-05T00:24:47Z');
    assert.equal(params.get('limit'), '50');
    return { ...page12Repeat, meta: { total: 468631, limit: 50 } };
  });
  const request = partitionContext(checkpoint, 50, { page: 12, backfillSince: checkpoint.modifiedFrom, requestId: '8cd906ff-d99d-443c-b472-c3793611c45c' });
  const result = await connector.fetchPage(request);
  assert.equal(result.checkpoint.version, 4);
  assert.equal(result.checkpoint.coverageMethod, 'single-response-date-partitions');
  assert.equal(result.checkpoint.modifiedFrom, checkpoint.modifiedFrom);
  assert.equal(result.checkpoint.modifiedTo, checkpoint.modifiedTo);
  assert.equal(result.checkpoint.completedThrough, '2026-09-05T00:24:47Z');
  assert.equal(result.checkpoint.completedPartitionCount, 0);
  assert.equal(result.checkpoint.completedProviderRecords, 0);
  assert.equal(result.checkpoint.previousCoverage.coverageProof, 'unverified-multi-page-observations');
  assert.equal(result.checkpoint.previousCoverage.completedPartitionCount, 1);
  assert.equal(result.checkpoint.previousCoverage.completedProviderRecords, 1510);
  assert.equal(result.checkpoint.previousCoverage.completedThrough, '2026-09-06T21:24:48Z');
  assert.deepEqual(result.checkpoint.previousCoverage.seenExternalIds, checkpoint.currentPartition.seenExternalIds);
  assert.deepEqual(result.checkpoint.previousCoverage.lastPageExternalIds, checkpoint.currentPartition.lastPageExternalIds);
  assert.equal(result.checkpoint.previousCoverage.page, 12);
  assert.equal(result.checkpoint.currentPartition.page, 0);
  assert.equal(result.checkpoint.currentPartition.seenExternalIds.length, 0);
  assert.equal(result.checkpoint.pendingPartitions.length, 1);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.records, []);
  assert.deepEqual(checkpoint, original);
  assert.equal(request.requestId, '8cd906ff-d99d-443c-b472-c3793611c45c');
  assert.equal(request.backfillSince, original.modifiedFrom);
});

test('trudvsem completed v3 historical coverage is replayed from its exact original outer lower bound', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  const checkpoint = { ...activeCheckpoint(), version: 3, hasMore: false, currentPartition: null, completedThrough: '2026-10-04T10:00:12Z', completedPartitionCount: 1, completedProviderRecords: 1000, terminalReason: 'all-date-partitions-exhausted' };
  patchGetJson(connector, async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('modifiedFrom'), '2026-10-04T10:00:00Z');
    assert.equal(params.get('modifiedTo'), '2026-10-04T10:00:12Z');
    assert.equal(params.get('offset'), '0');
    return envelope([vacancy('replay-1'), vacancy('replay-2')], 3);
  });
  const result = await connector.fetchPage(partitionContext(checkpoint));
  assert.equal(result.checkpoint.version, 4);
  assert.equal(result.checkpoint.completedPartitionCount, 0);
  assert.equal(result.checkpoint.previousCoverage.completedProviderRecords, 1000);
  assert.equal(result.checkpoint.modifiedFrom, checkpoint.modifiedFrom);
  assert.equal(result.checkpoint.modifiedTo, checkpoint.modifiedTo);
});

test('trudvsem v4 rejects duplicate IDs inside one response instead of declaring the leaf complete', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async () => envelope([vacancy('same'), vacancy('same')], 2));
  await assert.rejects(() => connector.fetchPage(partitionContext(activeCheckpoint())), /repeated vacancy ids within single response.*incomplete/);
});

test('trudvsem recorded native page IDs distinguish partial overlap from a whole repeated page', () => {
  const checkpoint = retainedV3Checkpoint();
  const first = recordedPage12();
  const repeat = recordedPage12(true);
  const ids = (payload) => payload.results.vacancies.map((item) => item.vacancy.id);
  const seen = new Set(checkpoint.currentPartition.seenExternalIds);
  assert.equal(first.meta.total, 1330);
  assert.equal(repeat.meta.total, 1330);
  assert.equal(ids(first).filter((id) => seen.has(id)).length, 0);
  assert.equal(ids(repeat).filter((id) => seen.has(id)).length, 1);
  assert.equal(ids(repeat).filter((id) => !seen.has(id)).length, 49);
  assert.notDeepEqual(ids(first), ids(repeat));
  assert.equal(first.results.vacancies[0].vacancy.date_modify, repeat.results.vacancies[0].vacancy.date_modify);
  assert.equal(first.results.vacancies[0].vacancy.date_modify, '2026-09-07T04:31:23+0300');
});


test('trudvsem v4 rejects completion counters or historical native IDs that exceed their bounds', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  let requests = 0;
  patchGetJson(connector, async () => { requests += 1; throw new Error('must not request'); });
  const oversizedLeaf = activeCheckpoint();
  oversizedLeaf.currentPartition.modifiedFrom = '2026-10-04T10:00:03Z';
  oversizedLeaf.completedThrough = '2026-10-04T10:00:04Z';
  oversizedLeaf.completedPartitionCount = 1;
  oversizedLeaf.completedProviderRecords = 3;
  oversizedLeaf.splitCount = 1;
  await assert.rejects(() => connector.fetchPage(partitionContext(oversizedLeaf)), /single-response coverage/);
  const oversizedHistory = activeCheckpoint();
  oversizedHistory.previousCoverage = {
    version: 3, coverageProof: 'unverified-multi-page-observations',
    modifiedFrom: oversizedHistory.modifiedFrom, modifiedTo: oversizedHistory.modifiedTo, page: 0,
    seenExternalIds: Array.from({ length: 10_001 }, (_, index) => `old-${index}`), lastPageExternalIds: [],
  };
  await assert.rejects(() => connector.fetchPage(partitionContext(oversizedHistory)), /historical seenExternalIds.*malformed/);
  assert.equal(requests, 0);
});
