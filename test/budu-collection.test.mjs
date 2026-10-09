import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
const testDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(testDir, '..');
process.env.TS_NODE_PROJECT = resolve(backendDir, 'tsconfig.json');

const require = createRequire(import.meta.url);
require('../node_modules/ts-node/register/transpile-only');

const { BuduConnector } = require('../src/modules/sources/connectors/budu.connector.ts');
const { WebExtractionHttpError } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

const fixtureHtml = readFileSync(resolve(backendDir, 'test/fixtures/budu/budu-list.html'), 'utf8');
const fixtureWithoutNative = fixtureHtml.replace(/window\.INITIAL_APP_STATE\s*=\s*'[A-Za-z0-9+/=]+';?/, '');
const searchWireGolden = JSON.parse(readFileSync(resolve(backendDir, 'test/fixtures/budu/search-page-2.transit.json'), 'utf8'));

const generatedIds = Array.from({ length: 34 }, (_, index) => `${String(index + 1).padStart(8, '0')}-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`);

function ctx(overrides = {}) {
  return {
    source: { _id: 'budu', name: 'Budu', timeoutMs: 1_000, endpoint: { baseUrl: 'https://budu.jobs/vacancies' } },
    requestId: 'budu-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

function response(body, { status = 200, contentType = 'text/html; charset=utf-8', setCookie } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) {
      const lower = name.toLowerCase();
      if (lower === 'content-type') return contentType;
      if (lower === 'set-cookie') return setCookie ?? null;
      return null;
    } },
    async text() { return body; },
  };
}

function nativeApiPage(page, ids, { totalPages = 5, totalResults = 44 } = {}) {
  return JSON.stringify(['^ ', '~$app.model.feed.vacancies/search!', ['^ ',
    '~:results', ids.map((id) => ['^ ',
      '~:vacancy/id', `~u${id}`,
      '~:>/vacancy', nativeVacancyCard(page, id),
    ]),
    '~:meta', ['^ ', '~:page', ['^ ', '~:size', 10, '~:current', page, '~:total_pages', totalPages, '~:total_results', totalResults]],
    '~:specializations-facet', [],
    '~:cities-facet', [],
  ]]);
}

function nativeCachedApiPage(page, ids, options = {}) {
  return JSON.stringify(cacheTransit(JSON.parse(nativeApiPage(page, ids, options))));
}

function nativeVacancyCard(page, id) {
  return ['^ ',
    '~:vacancy/id', `~u${id}`,
    '~:vacancy/title', `Generated vacancy ${id.slice(0, 4)}`,
    '~:vacancy/summary', `Native page ${page} full public summary for ${id}`,
    '~:company/name', `Company ${page}`,
    '~:vacancy/url', `https://budu.jobs/vacancy/${id}`,
    '~:vacancy/remote?', page % 2 === 0,
    '~:vacancy/geo', page % 2 === 0 ? 'Remote' : 'Москва',
    '~:>/specialization+skill-tags', ['^ ', '~:vacancy/id', `~u${id}`,
      '~:vacancy/skills', [`skill-${page}`],
      '~:vacancy/specializations*', [['^ ', '~:specialization/id', `~u80000000-0000-4000-8000-${String(page).padStart(12, '0')}`,
        '~:specialization/name', 'Engineering', '~:specialization/skills', [`skill-${page}`]]]],
    '~:vacancy/city', ['^ ', '~:city.algolia/id', 'moscow', '~:city.algolia/name', 'Москва', '~:city.algolia/country', 'Россия'],
    '~:vacancy/salary', [null, null],
    '~:company/id', `~u90000000-0000-4000-8000-${String(page).padStart(12, '0')}`,
    '~:company/logo-url', `https://ucarecdn.com/${id}/`,
  ];
}

function connector({ html = fixtureHtml, apiPages = defaultApiPages(), extraction } = {}) {
  const calls = [];
  const fetcher = async (url, _ctx, request = {}) => {
    calls.push({ url, request });
    if (url === 'https://budu.jobs/vacancies') return response(html, { setCookie: 'budu_session=abc123; Path=/; HttpOnly, visitor_id=xyz789; Path=/' });
    const page = requestedPage(request.body);
    const body = apiPages.get(page);
    if (!body) return response('missing page', { status: 404, contentType: 'text/plain' });
    return response(body, { contentType: 'application/transit+json' });
  };
  const instance = new BuduConnector(fetcher, extraction);
  return { instance, calls };
}

function defaultApiPages() {
  return new Map([
    [2, nativeApiPage(2, generatedIds.slice(0, 10))],
    [3, nativeCachedApiPage(3, generatedIds.slice(10, 20))],
    [4, nativeApiPage(4, generatedIds.slice(20, 30))],
    [5, nativeApiPage(5, generatedIds.slice(30, 34))],
  ]);
}

function expectedSearchBody(page) {
  const golden = structuredClone(searchWireGolden);
  const params = golden[0][1][0][1][1];
  params[params.indexOf('~:page') + 1] = page;
  return golden;
}

function requestedPage(body) {
  const parsed = JSON.parse(body);
  const params = parsed?.[0]?.[1]?.[0]?.[1]?.[1];
  const pageIndex = Array.isArray(params) ? params.indexOf('~:page') : -1;
  return pageIndex >= 0 ? params[pageIndex + 1] : NaN;
}

function cacheTransit(value) {
  const cache = new Map();
  let next = 0;
  const marker = (value) => value === '^ ' || value === '^@';
  const codeFor = (index) => index < 44
    ? `^${String.fromCharCode(48 + index)}`
    : `^${String.fromCharCode(48 + Math.floor(index / 44))}${String.fromCharCode(48 + (index % 44))}`;
  const cacheable = (value, mapKey) => typeof value === 'string' && value.length > 3 && !marker(value) && (mapKey || value.startsWith('~:') || value.startsWith('~$') || value.startsWith('~#'));
  const visit = (node, mapKey = false) => {
    if (typeof node === 'string') {
      if (!cacheable(node, mapKey)) return node;
      const cached = cache.get(node);
      if (cached !== undefined) return codeFor(cached);
      if (next >= 44 * 44) {
        cache.clear();
        next = 0;
      }
      cache.set(node, next);
      next += 1;
      return node;
    }
    if (!Array.isArray(node)) return node;
    if (node[0] === '^ ') {
      const out = ['^ '];
      for (let index = 1; index < node.length; index += 2) {
        out.push(visit(node[index], true), visit(node[index + 1], false));
      }
      return out;
    }
    return node.map((item) => visit(item, false));
  };
  return visit(value);
}

function nativeDetailExtraction({ outOfWindowIds = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    extraction: {
      async extractOpportunityFromUrl(url, options) {
        calls.push({ url, options });
        const id = url.split('/').pop();
        return {
          externalId: `detail-${id}`,
          url,
          type: 'vacancy',
          title: `Detail title ${id}`,
          companyOrClient: `Detail company ${id.slice(0, 4)}`,
          description: `Full native Budu detail body for ${id}`,
          publishedAt: outOfWindowIds.has(id) ? new Date('2026-08-01T00:00:00.000Z') : new Date('2026-09-20T00:00:00.000Z'),
          sourceStatus: 'Active',
          rawPayload: { url, fullJobPosting: { id } },
          sourceMetadata: { extraction: 'http-html', skills: ['detail-skill'] },
        };
      },
    },
  };
}

async function collectAll(instance, context = ctx()) {
  const records = [];
  let seen = 0;
  let page;
  for (let batch = 0; batch < 20; batch++) {
    page = await instance.fetchPage(context);
    records.push(...page.records);
    seen += page.stats.seen;
    if (!page.hasMore) return { ...page, records, stats: { seen } };
    context = { ...context, checkpoint: JSON.parse(JSON.stringify(page.checkpoint)), page: page.nextPage };
  }
  throw new Error('Budu collection did not terminate');
}

test('budu connector collects the native public Fulcro feed across all page metadata, not only 10 SSR cards', async () => {
  const details = nativeDetailExtraction();
  const { instance, calls } = connector({ extraction: details.extraction });

  const page = await collectAll(instance);

  assert.deepEqual(calls.map((call) => call.url), [
    'https://budu.jobs/vacancies',
    'https://budu.jobs/api',
    'https://budu.jobs/api',
    'https://budu.jobs/api',
    'https://budu.jobs/api',
  ]);
  assert.equal(page.records.length, 44);
  assert.equal(new Set(page.records.map((record) => record.externalId)).size, 44);
  assert.equal(page.records[0].externalId, '4df08619-f09f-4a17-b36d-8a293ae01d2d');
  assert.equal(page.records[0].url, 'https://budu.jobs/vacancy/4df08619-f09f-4a17-b36d-8a293ae01d2d');
  assert.equal(page.records[0].companyOrClient, 'ВИНОУ');
  assert.equal(page.records[0].title, 'Продюсер SMM-проектов');
  assert.equal(page.records[0].description, 'Full native Budu detail body for 4df08619-f09f-4a17-b36d-8a293ae01d2d');
  assert.equal(page.records[0].sourceMetadata.coverage, 'native-public-search-detail-enriched');
  assert.equal(page.records[0].sourceMetadata.descriptionCoverage, 'detail-full');
  assert.equal(page.records[0].sourceMetadata.extraction, 'budu-native-fulcro-transit');
  assert.equal(page.records[0].sourceMetadata.salary.from, 50000);
  assert.equal(page.records[0].sourceMetadata.nativeSalary[0], 50000);
  assert.equal(page.records[0].sourceMetadata.locationText, '— или удалёнка');
  assert.equal(page.records[10].title, 'Generated vacancy 0000');
  assert.equal(page.records[10].description, 'Full native Budu detail body for 00000001-aaaa-4aaa-8aaa-000000000001');
  assert.equal(page.records[10].sourceMetadata.remote, true);
  assert.deepEqual(page.records[10].sourceMetadata.skills, ['skill-2', 'detail-skill']);
  assert.equal(page.records[10].sourceMetadata.city['city.algolia/name'], 'Москва');
  assert.equal(page.records[10].sourceMetadata.specializations[0]['specialization/name'], 'Engineering');
  assert.equal(page.records[10].sourceMetadata.specializations[0]['specialization/id'], '80000000-0000-4000-8000-000000000002');
  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.mode, 'native_fulcro_transit_detail_batches');
  assert.equal(page.checkpoint.mutation, 'app.model.feed.vacancies/search!');
  assert.equal(page.checkpoint.nativeReturnQuery.component, 'app.ui.feed.vacancies/SearchResultsQuery');
  assert.deepEqual(page.checkpoint.nativeReturnQuery.query, [
    { results: [
      'vacancy/id',
      { '>/vacancy': [
        'vacancy/id',
        'vacancy/title',
        'vacancy/summary',
        { '>/specialization+skill-tags': ['vacancy/id', 'vacancy.wip/id',
          { 'vacancy/specializations*': ['specialization/id', 'specialization/name', 'specialization/skills'] }, 'vacancy/skills'] },
        'vacancy/salary',
        { 'vacancy/city': ['city.algolia/id', 'city.algolia/name', 'city.algolia/country'] },
        'vacancy/remote?',
        'vacancy/geo',
        'vacancy/url',
        'company/id',
        'company/logo-url',
        'company/name',
      ] },
    ] },
    'meta',
    'specializations-facet',
    'cities-facet',
  ]);
  assert.equal(page.checkpoint.nativeReturnQuery.vacancyCardComponent, 'app.ui.hr.vacancy-card/VacancyCard');
  assert.equal(page.checkpoint.currentPage, 5);
  assert.equal(page.checkpoint.totalPages, 5);
  assert.equal(page.checkpoint.totalResults, 44);
  assert.equal(page.checkpoint.seen, 44);
  assert.equal(page.checkpoint.retained, 44);
  assert.equal(page.checkpoint.terminalReason, 'page_metadata_exhausted');
  assert.equal(page.stats.seen, 44);
  assert.equal(details.calls.length, 44);
  assert.deepEqual(details.calls[0].options.allowedHosts, ['budu.jobs']);
  assert.equal(details.calls[0].options.requireOpportunitySignal, true);
  assert.deepEqual(JSON.parse(calls[1].request.body), expectedSearchBody(2));
  for (const call of calls.slice(1)) {
    assert.equal(call.request.method, 'POST');
    assert.equal(call.request.headers['Content-Type'], 'application/transit+json');
    assert.equal(call.request.headers['X-CSRF-Token'].length > 20, true);
    assert.equal(call.request.headers.Cookie, 'budu_session=abc123; visitor_id=xyz789');
    assert.match(call.request.body, /app\.model\.feed\.vacancies\/search!/);
    assert.doesNotMatch(call.request.body, /app\.ui\./);
    assert.match(call.request.body, /~:results/);
    assert.match(call.request.body, /~:meta/);
    assert.match(call.request.body, /~:specializations-facet/);
    assert.match(call.request.body, /~:cities-facet/);
    assert.match(call.request.body, /~:>\/vacancy/);
    assert.match(call.request.body, /~:ui\/query/);
    assert.match(call.request.body, /~:ui\/startups-only\?/);
    assert.match(call.request.body, /~:ui\/remote\?/);
    assert.match(call.request.body, /~:ui\/cities/);
    assert.match(call.request.body, /~:ui\/specializations/);
    assert.doesNotMatch(call.request.body, /~:ui\/results/);
  }
});

test('budu Transit decodes independently specified base44 references, skips short keys and wraps the cache', () => {
  const instance = new BuduConnector();
  const id = generatedIds[0];
  for (const [paddingCount, titleReference] of [[43, '^10'], [1935, '^0']]) {
    // "padding" occupies index 0; short keys never enter the cache. The title is
    // therefore index 44 (base44 ^10), or index 0 after the 1936-entry wrap.
    const wire = ['^ ', 'padding', [
      ['^ ', 'a', 0, '~:a', 1, 'bb', 2],
      ...Array.from({ length: paddingCount }, (_, index) => `~:padding/${index}`),
      '~:vacancy/title',
    ], '~$app.model.feed.vacancies/search!', ['^ ',
      '~:results', [['^ ', '~:vacancy/id', `~u${id}`, '~:>/vacancy', ['^ ',
        titleReference, 'Cached title', '~:vacancy/url', `https://budu.jobs/vacancy/${id}`,
      ]]],
      '~:meta', ['^ ', '~:page', ['^ ', '~:size', 10, '~:current', 2, '~:total_pages', 2, '~:total_results', 11]],
    ]];
    const result = instance.nativeFromTransit(JSON.stringify(wire), 2);
    assert.equal(result.records[0].id, id);
    assert.equal(result.records[0].title, 'Cached title');
    assert.equal(result.meta.current, 2);
  }
});

test('budu API requires the search mutation root and preserves escaped Transit strings', () => {
  const instance = new BuduConnector();
  const wire = JSON.parse(nativeApiPage(2, [generatedIds[0]], { totalPages: 2, totalResults: 11 }));
  assert.equal(instance.nativeFromTransit(JSON.stringify(wire[2]), 2), null);
  const foreignRoot = structuredClone(wire);
  foreignRoot[1] = '~$foreign/search!';
  assert.equal(instance.nativeFromTransit(JSON.stringify(foreignRoot), 2), null);
  const card = wire[2][2][0][4];
  card[card.indexOf('~:vacancy/title') + 1] = '~~:literal title';
  const result = instance.nativeFromTransit(JSON.stringify(wire), 2);
  assert.equal(result.records[0].title, '~:literal title');
});

test('budu native collection refuses missing metadata, changed totals, skipped pages and incomplete unique counts', async () => {
  const cases = [
    [(pages) => { pages.set(2, nativeApiPage(3, generatedIds.slice(0, 10))); }, /did not advance to page 2/],
    [(pages) => { pages.set(2, nativeApiPage(2, generatedIds.slice(0, 10), { totalResults: 43 })); }, /metadata changed/],
    [(pages) => {
      const wire = JSON.parse(pages.get(2));
      const pageMeta = wire[2][4][2];
      pageMeta.splice(pageMeta.indexOf('~:total_pages'), 2);
      pages.set(2, JSON.stringify(wire));
    }, /incomplete or inconsistent pagination metadata/],
    [(pages) => { pages.set(5, nativeApiPage(5, generatedIds.slice(30, 33))); }, /43 unique vacancies instead of 44/],
  ];
  for (const [change, expectedError] of cases) {
    const pages = defaultApiPages();
    change(pages);
    const { instance } = connector({ apiPages: pages });
    await assert.rejects(() => instance.fetchPage(ctx()), expectedError);
  }
});

test('budu native result refuses a card or URL belonging to a different vacancy', async () => {
  const pages = defaultApiPages();
  const wire = JSON.parse(pages.get(2));
  const card = wire[2][2][0][4];
  card[card.indexOf('~:vacancy/url') + 1] = `https://budu.jobs/vacancy/${generatedIds[1]}`;
  pages.set(2, JSON.stringify(wire));
  const { instance } = connector({ apiPages: pages });
  await assert.rejects(() => instance.fetchPage(ctx()), /identity does not match/);
});

test('budu connector keeps a fixed collection window for the same lower bound and resets it for a new lower bound', async () => {
  const { instance } = connector();

  const first = await instance.fetchPage(ctx());
  const sameWindow = await instance.fetchPage(ctx({ checkpoint: first.checkpoint }));
  assert.equal(sameWindow.checkpoint.backfillSince, first.checkpoint.backfillSince);
  assert.equal(sameWindow.checkpoint.windowUntil, first.checkpoint.windowUntil);

  const newWindow = await instance.fetchPage(ctx({ backfillSince: '2026-09-20T00:00:00.000Z', checkpoint: first.checkpoint }));
  assert.equal(newWindow.checkpoint.backfillSince, '2026-09-20T00:00:00.000Z');
  assert.notEqual(newWindow.checkpoint.windowUntil, first.checkpoint.windowUntil);
});


test('budu native detail enrichment filters known out-of-window published dates', async () => {
  const firstId = '4df08619-f09f-4a17-b36d-8a293ae01d2d';
  const details = nativeDetailExtraction({ outOfWindowIds: new Set([firstId]) });
  const { instance } = connector({ extraction: details.extraction });

  const page = await collectAll(instance, ctx({ backfillSince: '2026-09-04T00:00:00.000Z' }));

  assert.equal(details.calls.length, 44);
  assert.equal(page.records.length, 43);
  assert.equal(page.records.some((record) => record.externalId === firstId), false);
  assert.equal(page.checkpoint.seen, 44);
  assert.equal(page.checkpoint.retained, 43);
  assert.equal(page.hasMore, false);
});

test('budu connector keeps SSR fallback incomplete when native contract is unavailable', async () => {
  const { instance, calls } = connector({ html: fixtureWithoutNative, apiPages: new Map() });

  const page = await collectAll(instance);

  assert.deepEqual(calls.map((call) => call.url), ['https://budu.jobs/vacancies']);
  assert.equal(page.records.length, 10);
  assert.equal(page.records[0].sourceMetadata.extraction, 'budu-ssr-card');
  assert.equal(page.records[0].companyOrClient, 'ВИНОУ');
  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.mode, 'ssr_initial_page_fallback');
  assert.equal(page.checkpoint.incomplete, true);
  assert.equal(page.checkpoint.terminalReason, 'native_contract_unavailable');
  assert.equal(page.checkpoint.remainingHint, 34);
});

test('budu connector rejects unsafe config and invalid public responses instead of silently succeeding', async () => {
  const { instance } = connector({ html: '<html>no jobs here</html>' });

  assert.equal((await instance.validateConfig({ baseUrl: 'https://budu.jobs/vacancies' })).ok, true);
  assert.equal((await instance.validateConfig({ baseUrl: 'https://budu.jobs/' })).ok, false);
  assert.equal((await instance.validateConfig({ baseUrl: 'https://evil.example/vacancies' })).ok, false);

  await assert.rejects(
    () => instance.fetchPage(ctx({ source: { _id: 'budu', name: 'Budu', endpoint: { baseUrl: 'https://budu.jobs/?admin=true' }, timeoutMs: 1_000 } })),
    /only supports https:\/\/budu\.jobs\/vacancies/,
  );

  await assert.rejects(
    () => instance.fetchPage(ctx()),
    /did not contain vacancy HTML/,
  );
});

test('budu native pagination reports cycles and duplicate-only non-terminal pages truthfully', async () => {
  const duplicateOnly = defaultApiPages();
  duplicateOnly.set(3, nativeApiPage(3, generatedIds.slice(0, 10)));
  const { instance } = connector({ apiPages: duplicateOnly });

  await assert.rejects(
    () => instance.fetchPage(ctx()),
    /page 3 returned only duplicate vacancies before terminal page/,
  );

  const duplicatePageNumber = defaultApiPages();
  duplicatePageNumber.set(2, nativeApiPage(1, generatedIds.slice(0, 10)));
  const duplicatePage = connector({ apiPages: duplicatePageNumber });
  await assert.rejects(
    () => duplicatePage.instance.fetchPage(ctx()),
    /did not advance to page 2/,
  );
});

test('budu SSR fallback retains full detail enrichment', async () => {
  const detailCalls = [];
  const extraction = {
    async extractOpportunityFromUrl(url, options) {
      detailCalls.push({ url, options });
      return {
        externalId: 'detail-hash',
        url,
        type: 'vacancy',
        title: `Detail ${url.slice(-4)}`,
        companyOrClient: 'Verified Budu Company',
        description: 'Full verified Budu vacancy detail body.',
        publishedAt: new Date('2026-10-01T00:00:00.000Z'),
        sourceStatus: 'Active',
        rawPayload: { url, fullJobPosting: { title: 'Detail' } },
        sourceMetadata: { extraction: 'http-html', skills: ['marketing'] },
      };
    },
  };
  const { instance } = connector({ html: fixtureWithoutNative, extraction, apiPages: new Map() });

  const page = await collectAll(instance);

  assert.equal(detailCalls.length, 10);
  assert.equal(detailCalls[0].url, 'https://budu.jobs/vacancy/4df08619-f09f-4a17-b36d-8a293ae01d2d');
  assert.deepEqual(detailCalls[0].options.allowedHosts, ['budu.jobs']);
  assert.equal(detailCalls[0].options.requireOpportunitySignal, true);
  assert.equal(page.records[0].externalId, '4df08619-f09f-4a17-b36d-8a293ae01d2d');
  assert.equal(page.records[0].companyOrClient, 'Verified Budu Company');
  assert.equal(page.records[0].description, 'Full verified Budu vacancy detail body.');
  assert.equal(page.records[0].sourceMetadata.coverage, 'ssr-initial-page-detail-enriched');
});

test('budu fallback enrichment filters known out-of-window detail dates while retaining unknown dates', async () => {
  const firstId = '4df08619-f09f-4a17-b36d-8a293ae01d2d';
  const extraction = {
    async extractOpportunityFromUrl(url) {
      const id = url.split('/').pop();
      return {
        externalId: `detail-${id}`,
        url,
        type: 'vacancy',
        title: `Detail ${id}`,
        companyOrClient: 'Budu Detail',
        description: 'Full detail body',
        publishedAt: id === firstId ? new Date('2026-08-01T00:00:00.000Z') : undefined,
        sourceStatus: 'Active',
        rawPayload: { url },
        sourceMetadata: { extraction: 'http-html' },
      };
    },
  };
  const { instance } = connector({ html: fixtureWithoutNative, extraction, apiPages: new Map() });

  const page = await collectAll(instance, ctx({ backfillSince: '2026-09-04T00:00:00.000Z' }));

  assert.equal(page.records.some((record) => record.externalId === firstId), false);
  assert.equal(page.records.length, 9);
  assert.equal(page.records.every((record) => record.sourceMetadata.dateKnown === false), true);
});

test('budu fallback enrichment rejects redirects, honors aborts and reports safe network causes', async () => {
  const mismatch = connector({
    html: fixtureWithoutNative,
    extraction: {
      async extractOpportunityFromUrl(url) {
        return {
          externalId: 'detail-mismatch',
          url: url.replace('4df08619-f09f-4a17-b36d-8a293ae01d2d', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'),
          type: 'vacancy',
          title: 'Wrong detail',
          description: 'Wrong detail body',
          sourceStatus: 'Active',
          rawPayload: {},
          sourceMetadata: {},
        };
      },
    },
  });
  await assert.rejects(
    () => mismatch.instance.fetchPage(ctx()),
    /does not match feed vacancy 4df08619-f09f-4a17-b36d-8a293ae01d2d/,
  );

  const controller = new AbortController();
  controller.abort(new Error('caller aborted'));
  let calls = 0;
  const aborted = connector({
    html: fixtureWithoutNative,
    extraction: {
      async extractOpportunityFromUrl() {
        calls += 1;
        throw new Error('should not call extraction');
      },
    },
  });
  await assert.rejects(
    () => aborted.instance.fetchPage(ctx({ signal: controller.signal })),
    /caller aborted/,
  );
  assert.equal(calls, 0);

  const failure = new TypeError('fetch failed');
  failure.cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND budu.jobs' };
  const network = new BuduConnector(async () => { throw failure; });
  await assert.rejects(
    () => network.fetchPage(ctx()),
    /Budu public page fetch failed: TypeError \| fetch failed \| cause=ENOTFOUND \| getaddrinfo ENOTFOUND budu\.jobs/,
  );
});

test('budu records exact unavailable detail IDs and continues the finite native catalog', async () => {
  const missing = '4df08619-f09f-4a17-b36d-8a293ae01d2d';
  const details = nativeDetailExtraction();
  const original = details.extraction.extractOpportunityFromUrl;
  details.extraction.extractOpportunityFromUrl = async (url, options) => {
    if (url.endsWith(missing)) throw new WebExtractionHttpError(404, url);
    return original(url, options);
  };
  const { instance } = connector({ extraction: details.extraction });
  const page = await collectAll(instance);
  assert.equal(page.records.length, 43);
  assert.equal(page.records.some(record => record.externalId === missing), false);
  assert.deepEqual(page.checkpoint.unavailableDetailIds, [missing]);
  assert.equal(page.checkpoint.unavailableDetailStatus, 404);
  assert.equal(page.stats.seen, 44);
  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.terminalReason, 'page_metadata_exhausted');
});

test('budu missing details never disguise access failures or a different failed URL', async () => {
  const instance = new BuduConnector();
  const url = `https://budu.jobs/vacancy/${generatedIds[0]}`;
  for (const error of [
    new WebExtractionHttpError(403, url, { accessReason: 'bot_challenge' }),
    new WebExtractionHttpError(429, url),
    new WebExtractionHttpError(500, url),
    new WebExtractionHttpError(404, `https://budu.jobs/vacancy/${generatedIds[1]}`),
    new Error('HTTP 404'),
  ]) {
    instance.webExtraction = { async extractOpportunityFromUrl() { throw error; } };
    await assert.rejects(() => instance.fetchDetail(url, ctx()), actual => actual === error);
  }
});

test('budu unavailable SSR detail remains explicit and the fallback stays incomplete', async () => {
  const details = nativeDetailExtraction();
  const original = details.extraction.extractOpportunityFromUrl;
  const missing = '4df08619-f09f-4a17-b36d-8a293ae01d2d';
  details.extraction.extractOpportunityFromUrl = async (url, options) => {
    if (url.endsWith(missing)) throw new WebExtractionHttpError(404, url);
    return original(url, options);
  };
  const { instance } = connector({ html: fixtureWithoutNative, extraction: details.extraction });
  const page = await collectAll(instance);
  assert.equal(page.records.length, 9);
  assert.equal(page.checkpoint.incomplete, true);
  assert.deepEqual(page.checkpoint.unavailableDetailIds, [missing]);
});

test('budu native money, city, remote and both skill sets reach common fields', async () => {
  const { instance } = connector({ extraction: nativeDetailExtraction().extraction });
  const page = await collectAll(instance);
  const source = { _id: 'budu', name: 'Budu', connectorFamily: 'PublicHtml', group: 'web' };
  const normalizer = new SourceNormalizerService();
  const first = normalizer.normalize(source, page.records[0]);
  assert.equal(first.money.min, 50000);
  assert.equal(first.money.currency, 'RUB');
  assert.equal(first.money.period, undefined);
  const remote = normalizer.normalize(source, page.records[10]);
  assert.equal(remote.location, 'Москва');
  assert.equal(remote.remoteType, 'Remote');
  assert.deepEqual(remote.skills, ['skill-2', 'detail-skill']);
  assert.equal(instance.nativeSalary([-1, null]), undefined);
  assert.equal(instance.nativeSalary([80000, 50000]), undefined);
  assert.deepEqual(instance.nativeSalary([null, 50000]), { to: 50000, currency: 'RUB' });
});


test('budu persists native cards and resumes detail batches without rereading a changing catalog', async () => {
  const details = nativeDetailExtraction();
  const { instance, calls } = connector({ extraction: details.extraction });
  const first = await instance.fetchPage(ctx());
  assert.equal(first.records.length, 10);
  assert.equal(first.checkpoint.detailCursor, 10);
  assert.equal(first.stats.seen, 10);
  assert.equal(first.hasMore, true);
  assert.equal(calls.length, 5);
  const saved = JSON.parse(JSON.stringify(first.checkpoint));
  const second = await instance.fetchPage(ctx({ checkpoint: saved }));
  assert.equal(second.records.length, 10);
  assert.equal(second.checkpoint.detailCursor, 20);
  assert.equal(second.checkpoint.retained, 20);
  assert.equal(second.checkpoint.windowUntil, saved.windowUntil);
  assert.equal(calls.length, 5);
  const mismatched = structuredClone(saved);
  mismatched.nativeCatalog[10].raw['vacancy/url'] = mismatched.nativeCatalog[11].raw['vacancy/url'];
  await assert.rejects(() => instance.fetchPage(ctx({ checkpoint: mismatched })), /identity does not match/);
  await assert.rejects(() => instance.fetchPage(ctx({ checkpoint: { ...saved, detailCursor: -1 } })), /inconsistent detail progress/);
  await assert.rejects(() => instance.fetchPage(ctx({ checkpoint: saved, backfillSince: '2026-09-20T00:00:00.000Z' })), /frozen publication window/);
});

test('budu retries only an interrupted detail batch and preserves prior progress', async () => {
  const details = nativeDetailExtraction();
  const { instance } = connector({ extraction: details.extraction });
  const first = await instance.fetchPage(ctx());
  const saved = structuredClone(first.checkpoint);
  const extract = details.extraction.extractOpportunityFromUrl;
  details.extraction.extractOpportunityFromUrl = async () => { throw new Error('detail connection timeout'); };
  await assert.rejects(() => instance.fetchPage(ctx({ checkpoint: saved })), /connection timeout/);
  assert.deepEqual(saved, first.checkpoint);
  details.extraction.extractOpportunityFromUrl = extract;
  const remaining = await collectAll(instance, ctx({ checkpoint: saved }));
  assert.equal(remaining.records.length, 34);
  assert.equal(remaining.stats.seen, 34);
  assert.equal(remaining.checkpoint.seen, 44);
  assert.equal(remaining.checkpoint.retained, 44);
});


test('budu delayed first execution preserves the original30-day publication window', () => {
  const instance = new BuduConnector();
  const since = new Date(Date.now() - 31 * 86400000).toISOString();
  const bounds = instance.windowBounds(ctx({ backfillSince: since }));
  assert.equal(bounds.backfillSince, since);
  assert.equal(Date.parse(bounds.windowUntil) - Date.parse(since), 30 * 86400000);
});
