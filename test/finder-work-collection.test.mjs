import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { FinderWorkConnector } = require('../src/modules/sources/connectors/finder-work.connector.ts');

function source(overrides = {}) {
  return {
    _id: 'finder-work',
    name: 'Finder.work',
    enabled: true,
    runtimeState: 'Enabled',
    checkpoint: {},
    connectorFamily: 'PublicHtml',
    endpoint: { baseUrl: 'https://finder.work/vacancies' },
    config: {},
    limits: { perPage: 25 },
    timeoutMs: 30_000,
    opportunityTypes: ['vacancy'],
    ...overrides,
  };
}

function ctx(overrides = {}) {
  const { source: sourceOverrides, ...rest } = overrides;
  return {
    source: source(sourceOverrides),
    requestId: 'finder-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T10:55:00.123Z',
    ...rest,
  };
}

function regionsHtml(slugs = ['moskva', 'sankt-peterburg']) {
  const links = slugs.map((slug, index) => `<li><a href="/vacancies/regions/${slug}">${slug}</a><span>${1000 - index}</span></li>`).join('\n');
  return `<!doctype html><html><body><h1>Обзор вакансий по регионам</h1><ul>${links}</ul></body></html>`;
}

function regionOverviewHtml(slug = 'moskva', listPath = `/vacancies/${slug}`) {
  return `<!doctype html><html><body><h1>Обзор вакансий в ${slug}</h1><a href="${listPath}">Все вакансии</a><a href="/vacancies/remote/${slug}">Работа на дому</a></body></html>`;
}

function listHtml({ ids = [36242603, 36397123], next = '/vacancies/moskva?page=2', category = true } = {}) {
  const elements = ids.map((id, index) => `{"@type":"ListItem","position":${index + 1},"url":"https://finder.work/vacancies/${id}","name":"Vacancy ${id}","description":"Preview ${id}"}`).join(',');
  const anchors = ids.map((id) => `<a href="/vacancies/${id}">Vacancy ${id}</a>`).join('\n');
  return `<!doctype html><html><head><title>Работа: Finder</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[${elements}]}</script></head><body>${category ? '<a href="/vacancies/it_internet_svyaz_telekom">IT category</a>' : ''}${anchors}${next ? `<a href="${next}"> Показать еще </a>` : ''}</body></html>`;
}

function detailDoc(id, overrides = {}) {
  return {
    finalUrl: `https://finder.work/vacancies/${id}`,
    html: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Detail ${id}"}</script>`,
    metadata: { firecrawl: false },
    ...overrides,
  };
}

class MockExtraction {
  constructor({ regions = regionsHtml(), regionOverviews = {}, lists = {}, listFinalUrls = {}, details = {}, failDetailIds = new Set() } = {}) {
    this.calls = [];
    this.options = [];
    this.regions = regions;
    this.regionOverviews = regionOverviews;
    this.lists = lists;
    this.listFinalUrls = listFinalUrls;
    this.details = details;
    this.failDetailIds = failDetailIds;
  }

  async extractUrl(url, options = {}) {
    this.calls.push(url);
    this.options.push(options);
    const parsed = new URL(url);
    if (parsed.pathname === '/vacancies/regions') return { finalUrl: url, html: this.regions, metadata: { firecrawl: false } };
    const regionSlug = parsed.pathname.match(/^\/vacancies\/regions\/([a-z0-9-]+)$/)?.[1];
    if (regionSlug) return { finalUrl: url, html: this.regionOverviews[regionSlug] ?? regionOverviewHtml(regionSlug), metadata: { firecrawl: false } };
    if (/^\/vacancies(?:\/[a-z0-9-]+)?$/.test(parsed.pathname) && !/^\/vacancies\/\d+$/.test(parsed.pathname)) {
      const html = this.lists[url] ?? this.lists[parsed.pathname + parsed.search] ?? listHtml({ next: null });
      return { finalUrl: this.listFinalUrls[url] ?? url, html, metadata: { firecrawl: false } };
    }
    const id = parsed.pathname.match(/^\/vacancies\/(\d+)$/)?.[1];
    if (id && this.failDetailIds.has(id)) throw new Error(`detail ${id} failed`);
    if (id) return this.details[id] ?? detailDoc(id);
    return { finalUrl: url, html: '<html></html>', metadata: {} };
  }

  documentToRecord(document) {
    const id = new URL(document.finalUrl).pathname.match(/\d+$/)?.[0] ?? 'unknown';
    const publishedAt = document.publishedAt === null ? undefined : new Date(document.publishedAt ?? '2026-10-04T08:16:38.160Z');
    return {
      externalId: `hash-${id}`,
      url: document.finalUrl,
      type: 'vacancy',
      title: `Detail ${id}`,
      companyOrClient: `Company ${id}`,
      description: `Full public detail ${id}`,
      publishedAt,
      sourceStatus: 'Unknown',
      rawPayload: { url: document.finalUrl },
      sourceMetadata: { extraction: 'http-html', salary: { originalText: '100000 RUB' } },
    };
  }
}

test('finder.work discovers public region catalogue and collects first verified region list from real fixture', async () => {
  const fixture = readFileSync(new URL('./fixtures/finder-work/finder-list.html', import.meta.url), 'utf8');
  const extraction = new MockExtraction({
    regions: regionsHtml(['moskva', 'sankt-peterburg']),
    regionOverviews: { moskva: regionOverviewHtml('moskva', '/vacancies/moskva') },
    lists: { 'https://finder.work/vacancies/moskva': fixture },
  });
  const connector = new FinderWorkConnector(extraction);

  const page = await connector.fetchPage(ctx());

  assert.deepEqual(extraction.calls.slice(0, 3), ['https://finder.work/vacancies/regions', 'https://finder.work/vacancies/regions/moskva', 'https://finder.work/vacancies/moskva']);
  assert.equal(page.records[0].externalId, '36242603');
  assert.equal(page.records.length, 25);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextPage, 1);
  assert.equal(page.checkpoint.currentListUrl, 'https://finder.work/vacancies?page=2');
  assert.deepEqual(page.checkpoint.regionUrls, ['https://finder.work/vacancies/regions/moskva', 'https://finder.work/vacancies/regions/sankt-peterburg']);
  assert.equal(page.records[0].sourceMetadata.observedScope, 'public-region-rotation');
  assert.match(page.records[0].sourceMetadata.scopeLimitation, /regions/);
  assert.equal(extraction.calls.filter((url) => /^https:\/\/finder\.work\/vacancies\/\d+$/.test(url)).length, 25);
});

test('finder.work ignores category links, fetches numeric details, and advances by observed region next url', async () => {
  const extraction = new MockExtraction({ lists: { 'https://finder.work/vacancies/moskva': listHtml({ ids: [11, 22], next: '/vacancies/moskva?page=2' }) } });
  const connector = new FinderWorkConnector(extraction);

  const page = await connector.fetchPage(ctx());

  assert.deepEqual(page.records.map((record) => record.externalId), ['11', '22']);
  assert.equal(extraction.calls.includes('https://finder.work/vacancies/it_internet_svyaz_telekom'), false);
  assert.equal(page.checkpoint.currentListUrl, 'https://finder.work/vacancies/moskva?page=2');
  assert.deepEqual(page.checkpoint.seenListIds, ['11', '22']);
});

test('finder.work continuation keeps fixed window, filters dated records, and retains unknown dates', async () => {
  const regionUrls = ['https://finder.work/vacancies/regions/moskva'];
  const extraction = new MockExtraction({
    lists: { 'https://finder.work/vacancies/moskva?page=2': listHtml({ ids: [33, 44, 55], next: null }) },
    details: {
      33: detailDoc(33, { publishedAt: '2026-09-03T10:00:00.000Z' }),
      44: detailDoc(44, { publishedAt: null }),
      55: detailDoc(55, { publishedAt: '2026-10-04T09:00:00.000Z' }),
    },
  });
  const connector = new FinderWorkConnector(extraction);

  const page = await connector.fetchPage(ctx({
    checkpoint: { hasMore: true, currentListUrl: 'https://finder.work/vacancies/moskva?page=2', nextPage: 1, regionIndex: 0, regionUrls, visitedListUrls: ['https://finder.work/vacancies/moskva'], seenListIds: ['11'], backfillSince: '2026-09-04T10:55:00.123Z', windowTo: '2026-10-04T08:00:00.000Z' },
    backfillSince: '2026-10-01T00:00:00.000Z',
    page: 1,
  }));

  assert.deepEqual(page.records.map((record) => record.externalId), ['44']);
  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.hasMore, false);
});

test('finder.work advances to next region after terminal page instead of stopping at Moscow', async () => {
  const regionUrls = ['https://finder.work/vacancies/regions/moskva', 'https://finder.work/vacancies/regions/sankt-peterburg'];
  const extraction = new MockExtraction({ lists: { 'https://finder.work/vacancies/moskva': listHtml({ ids: [66], next: null }) } });
  const connector = new FinderWorkConnector(extraction);

  const page = await connector.fetchPage(ctx({ checkpoint: { hasMore: true, regionIndex: 0, regionUrls, nextPage: 4, backfillSince: '2026-09-04T10:55:00.123Z', windowTo: '2026-10-04T09:00:00.000Z' } }));

  assert.deepEqual(page.records.map((record) => record.externalId), ['66']);
  assert.equal(page.hasMore, true);
  assert.equal(page.checkpoint.regionIndex, 1);
  assert.equal(page.checkpoint.currentListUrl, undefined);
  assert.deepEqual(page.checkpoint.visitedListUrls, []);
  assert.deepEqual(page.checkpoint.seenListIds, []);
});

test('finder.work rejects missing regions/list cards and detail extraction failures', async () => {
  const noRegions = new FinderWorkConnector(new MockExtraction({ regions: '<html></html>' }));
  await assert.rejects(() => noRegions.fetchPage(ctx()), /regions catalogue contains no public region links/);

  const empty = new FinderWorkConnector(new MockExtraction({ lists: { 'https://finder.work/vacancies/moskva': '<html><a href="/vacancies/it_internet_svyaz_telekom">IT</a></html>' } }));
  await assert.rejects(() => empty.fetchPage(ctx()), /no concrete numeric vacancy cards/);

  const failing = new FinderWorkConnector(new MockExtraction({ lists: { 'https://finder.work/vacancies/moskva': listHtml({ ids: [77], next: null }) }, failDetailIds: new Set(['77']) }));
  await assert.rejects(() => failing.fetchPage(ctx()), /detail 77 failed/);
});

test('finder.work passes ctx.signal to catalogue, overview, list, and detail fetches', async () => {
  const signal = AbortSignal.timeout(30_000);
  const extraction = new MockExtraction({ lists: { 'https://finder.work/vacancies/moskva': listHtml({ ids: [71], next: null }) } });
  const connector = new FinderWorkConnector(extraction);

  await connector.fetchPage(ctx({ signal }));

  assert.deepEqual(extraction.calls.slice(0, 4), [
    'https://finder.work/vacancies/regions',
    'https://finder.work/vacancies/regions/moskva',
    'https://finder.work/vacancies/moskva',
    'https://finder.work/vacancies/71',
  ]);
  assert.equal(extraction.options.slice(0, 4).every((options) => options.signal === signal), true);
});

test('finder.work blocks unsafe pagination/detail/list redirects and throws on anti-repeat contradiction', async () => {
  const badNext = new FinderWorkConnector(new MockExtraction({ lists: { 'https://finder.work/vacancies/moskva': listHtml({ ids: [88], next: 'https://evil.example/vacancies?page=2' }) } }));
  const first = await badNext.fetchPage(ctx());
  assert.equal(first.hasMore, true);
  assert.equal(first.checkpoint.currentListUrl, undefined);
  assert.equal(first.checkpoint.regionIndex, 1);

  const badDetail = new FinderWorkConnector(new MockExtraction({
    lists: { 'https://finder.work/vacancies/moskva': listHtml({ ids: [99], next: null }) },
    details: { 99: detailDoc(99, { finalUrl: 'https://finder.work:444/vacancies/99' }) },
  }));
  await assert.rejects(() => badDetail.fetchPage(ctx()), /redirected outside its public detail page/);

  const badList = new FinderWorkConnector(new MockExtraction({ regionOverviews: { moskva: regionOverviewHtml('moskva', 'https://finder.work:444/vacancies/moskva') } }));
  await assert.rejects(() => badList.fetchPage(ctx()), /no verified "Все вакансии" list link/);

  const nextCycle = new FinderWorkConnector(new MockExtraction({ lists: { 'https://finder.work/vacancies/moskva?page=2': listHtml({ ids: [100], next: '/vacancies/moskva' }) } }));
  await assert.rejects(() => nextCycle.fetchPage(ctx({ checkpoint: { hasMore: true, currentListUrl: 'https://finder.work/vacancies/moskva?page=2', nextPage: 1, regionIndex: 0, regionUrls: ['https://finder.work/vacancies/regions/moskva'], visitedListUrls: ['https://finder.work/vacancies/moskva'], seenListIds: [], backfillSince: '2026-09-04T10:55:00.123Z', windowTo: '2026-10-04T09:00:00.000Z' }, page: 1 })), /next URL was already visited/);

  const redirectCycle = new FinderWorkConnector(new MockExtraction({
    lists: { 'https://finder.work/vacancies/moskva?page=2': listHtml({ ids: [101], next: null }) },
    listFinalUrls: { 'https://finder.work/vacancies/moskva?page=2': 'https://finder.work/vacancies/moskva' },
  }));
  await assert.rejects(() => redirectCycle.fetchPage(ctx({ checkpoint: { hasMore: true, currentListUrl: 'https://finder.work/vacancies/moskva?page=2', nextPage: 1, regionIndex: 0, regionUrls: ['https://finder.work/vacancies/regions/moskva'], visitedListUrls: ['https://finder.work/vacancies/moskva'], seenListIds: [], backfillSince: '2026-09-04T10:55:00.123Z', windowTo: '2026-10-04T09:00:00.000Z' }, page: 1 })), /redirected to an already visited page/);

  const repeated = new FinderWorkConnector(new MockExtraction({ lists: { 'https://finder.work/vacancies/moskva?page=2': listHtml({ ids: [102], next: '/vacancies/moskva?page=3' }) } }));
  await assert.rejects(() => repeated.fetchPage(ctx({ checkpoint: { hasMore: true, currentListUrl: 'https://finder.work/vacancies/moskva?page=2', nextPage: 1, regionIndex: 0, regionUrls: ['https://finder.work/vacancies/regions/moskva'], visitedListUrls: ['https://finder.work/vacancies/moskva'], seenListIds: ['102'], backfillSince: '2026-09-04T10:55:00.123Z', windowTo: '2026-10-04T09:00:00.000Z' }, page: 1 })), /repeated only previously seen vacancy ids/);
});

test('finder.work validation and health expose region-rotation parser metadata without fake all-region endpoint claim', async () => {
  const connector = new FinderWorkConnector(new MockExtraction({ lists: { 'https://finder.work/vacancies/moskva': listHtml({ ids: [101], next: null }) } }));

  const validation = await connector.validateConfig({});
  const health = await connector.healthCheck(ctx({ source: { limits: { perPage: 25 } } }));

  assert.equal(validation.ok, true);
  assert.equal(validation.details.parser, 'finder-work-public-html-v1');
  assert.equal(validation.details.regionsUrl, 'https://finder.work/vacancies/regions');
  assert.equal(validation.details.observedScope, 'public-region-rotation');
  assert.match(validation.details.scopeLimitation, /No verified anonymous all-region single endpoint/);
  assert.equal(health.state, 'Healthy', health.message);
});
