import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { RabotaRuConnector } = require('../src/modules/sources/connectors/rabota-ru.connector.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

const base = 'https://www.rabota.ru/vacancy/?sort=date';
const spb = 'https://spb.rabota.ru/vacancy/?sort=date';

function ctx(overrides = {}) {
  return {
    source: {
      _id: 'rabota_ru',
      name: 'Rabota.ru',
      connectorFamily: 'PublicHtml',
      endpoint: { baseUrls: [base, spb] },
      config: {},
      limits: { maxPages: 1 },
      timeoutMs: 30_000,
      ...overrides.source,
    },
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
    requestId: 'rabota-fixture',
    ...overrides,
  };
}

class FakeExtraction {
  constructor(pages) {
    this.pages = pages;
    this.calls = [];
    this.options = [];
  }

  async extractUrl(url, options = {}) {
    this.calls.push(url);
    this.options.push(options);
    const entry = this.pages[url];
    if (entry instanceof Error) throw entry;
    if (!entry) throw new Error(`Unexpected Rabota.ru URL ${url}`);
    if (typeof entry === 'object' && 'html' in entry) return { finalUrl: entry.finalUrl ?? url, html: entry.html, metadata: { firecrawl: false } };
    return { finalUrl: url, html: entry, metadata: { firecrawl: false } };
  }
}

describe('Rabota.ru public SSR vacancy collection', () => {
  it('collects all JobPosting records from SSR JSON-LD with full bodies and canonical metadata', async () => {
    const jobs = Array.from({ length: 12 }, (_, index) => job(index + 1));
    const structuredBody = '<p>Full published body 1</p><div>Обязанности:</div><ul><li>Ship services from detail</li><li>Keep APIs healthy</li></ul><p>Условия:<br>Remote</p><script>window.evil=1</script><style>.hidden{display:none}</style>';
    const html = listHtml({ jobs, next: '/vacancy/?sort=date&page=2' });
    const web = new FakeExtraction({ [base]: html, ...detailPages(jobs), [urlFor(1)]: detailHtml(jobs[0], { description: structuredBody }) });
    const result = await new RabotaRuConnector(web).fetchPage(ctx());

    assert.equal(result.records.length, 12);
    assert.equal(result.records[0].externalId, '1');
    assert.equal(result.records[0].url, 'https://www.rabota.ru/vacancy/1/');
    assert.equal(result.records[0].title, 'Backend engineer 1');
    assert.equal(result.records[0].companyOrClient, 'Company 1');
    assert.match(result.records[0].description, /Full published body 1/);
    assert.match(result.records[0].description, /Ship services from detail/);
    assert.match(result.records[0].description, /Обязанности:\nShip services from detail\nKeep APIs healthy\nУсловия:\nRemote/);
    assert.doesNotMatch(result.records[0].description, /<li>|<script|window\.evil|hidden\{display/);
    assert.equal(result.records[0].publishedAt.toISOString(), '2026-10-04T08:01:00.000Z');
    assert.deepEqual(result.records[0].sourceMetadata.salary, { min: 100000, max: 150000, currency: 'RUB', period: 'MONTH', originalText: '100000 – 150000 RUB MONTH' });
    assert.equal(result.records[0].sourceMetadata.area, 'Москва, Тверская, Россия');
    assert.equal(result.records[0].sourceMetadata.employment, 'FULL_TIME, REMOTE');
    assert.equal(result.records[0].sourceMetadata.schedule, 'удаленная работа');
    assert.equal(result.records[0].sourceMetadata.seniority, 'от 1 года');
    assert.deepEqual(result.records[0].sourceMetadata.skills, ['Node.js', 'Postgres']);
    assert.equal(result.hasMore, true);
    assert.equal(result.checkpoint.nextUrl, 'https://www.rabota.ru/vacancy/?sort=date&page=2');
    assert.equal(web.options[0].signal, undefined);
    assert.deepEqual(web.options[0].allowedHosts, ['rabota.ru']);
    assert.equal(web.calls.length, 13);
  });






  it('refreshes the public region catalog on a fresh default cycle and walks every observed region without returning to the first one', async () => {
    const catalog = JSON.parse(readFileSync(fixture('region-contract-sample-response.json'), 'utf8'));
    const restoreFetch = mockFetch([{ status: 200, body: catalog }]);
    try {
      const urls = {
        www: 'https://www.rabota.ru/vacancy/?sort=date',
        spb: 'https://spb.rabota.ru/vacancy/?sort=date',
        volgograd: 'https://volgograd.rabota.ru/vacancy/?sort=date',
        kazan: 'https://kazan.rabota.ru/vacancy/?sort=date',
      };
      const jobs = {
        www: job(1001, { url: urlFor(1001) }),
        spb: job(1002, { url: urlFor(1002), jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Санкт-Петербург', addressCountry: 'Россия' } } }),
        volgograd: job(1003, { url: urlFor(1003), jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Волгоград', addressCountry: 'Россия' } } }),
        kazan: job(1004, { url: urlFor(1004), jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Казань', addressCountry: 'Россия' } } }),
      };
      const web = new FakeExtraction({
        [urls.www]: listHtml({ jobs: [jobs.www], next: null }),
        [urlFor(1001)]: detailHtml(jobs.www),
        [urls.spb]: listHtml({ jobs: [jobs.spb], next: null }),
        [urlFor(1002)]: detailHtml(jobs.spb),
        [urls.volgograd]: listHtml({ jobs: [jobs.volgograd], next: null }),
        [urlFor(1003)]: detailHtml(jobs.volgograd),
        [urls.kazan]: listHtml({ jobs: [jobs.kazan], next: null }),
        [urlFor(1004)]: detailHtml(jobs.kazan),
      });
      const connector = new RabotaRuConnector(web);
      const first = await connector.fetchPage(defaultCatalogCtx());
      const second = await connector.fetchPage(defaultCatalogCtx({ checkpoint: first.checkpoint }));
      const third = await connector.fetchPage(defaultCatalogCtx({ checkpoint: second.checkpoint }));
      const fourth = await connector.fetchPage(defaultCatalogCtx({ checkpoint: third.checkpoint }));

      const expectedRequest = JSON.parse(readFileSync(fixture('region-contract-request.json'), 'utf8'));
      assert.equal(global.fetch.calls.length, 1);
      assert.match(global.fetch.calls[0].url, /\/v5\/regions\/suggest\.json$/);
      assert.deepEqual(global.fetch.calls[0].body.request, expectedRequest.request);
      assert.equal(global.fetch.calls[0].body.application_id, expectedRequest.application_id);
      assert.equal(typeof global.fetch.calls[0].body.request_id, 'number');
      assert.equal(global.fetch.calls[0].options.redirect, 'error');
      assert.ok(global.fetch.calls[0].options.signal instanceof AbortSignal);
      assert.equal(first.checkpoint.coverage, 'all-public-regions-observed');
      assert.equal(first.checkpoint.regionCatalog.total, 4);
      assert.deepEqual(first.checkpoint.regionCatalog.regions.map((region) => region.domain), ['www', 'spb', 'volgograd', 'kazan']);
      assert.deepEqual(first.checkpoint.sourceUrls, [urls.www, urls.spb, urls.volgograd, urls.kazan]);
      assert.equal(first.checkpoint.completedRegionCount, 1);
      assert.deepEqual(first.checkpoint.visitedListUrls, [urls.www]);
      assert.equal(first.checkpoint.nextUrl, urls.spb);
      assert.equal(first.checkpoint.listIndex, 1);
      assert.deepEqual(first.checkpoint.region, { id: 4, name: 'Санкт-Петербург', domain: 'spb' });
      assert.equal(second.checkpoint.nextUrl, urls.volgograd);
      assert.equal(second.checkpoint.completedRegionCount, 2);
      assert.equal(third.checkpoint.nextUrl, urls.kazan);
      assert.equal(third.checkpoint.completedRegionCount, 3);
      assert.equal(fourth.hasMore, false);
      assert.equal(fourth.checkpoint.coverage, 'all-public-regions-observed');
      assert.deepEqual(fourth.records.map((record) => record.externalId), ['1004']);
      assert.deepEqual(web.calls.filter((url) => url.endsWith('/vacancy/?sort=date')), [urls.www, urls.spb, urls.volgograd, urls.kazan]);
      assert.equal(fourth.checkpoint.completedRegionCount, fourth.checkpoint.regionCatalog.total);
      assert.equal(fourth.checkpoint.completedRegionCount, fourth.checkpoint.sourceUrls.length);
      assert.deepEqual(fourth.checkpoint.visitedListUrls, [urls.www, urls.spb, urls.volgograd, urls.kazan]);
      assert.deepEqual(fourth.checkpoint.seenExternalIds, ['1001', '1002', '1003', '1004']);
    } finally {
      restoreFetch();
    }
  });

  it('treats the registered default endpoint baseUrl as all-region scope, not manual override', async () => {
    const catalog = JSON.parse(readFileSync(fixture('region-contract-sample-response.json'), 'utf8'));
    const restoreFetch = mockFetch([{ status: 200, body: catalog }]);
    try {
      const web = new FakeExtraction({ [base]: listHtml({ jobs: [job(1101)], next: null }), [urlFor(1101)]: detailHtml(job(1101)) });
      const result = await new RabotaRuConnector(web).fetchPage(defaultCatalogCtx({ source: { endpoint: { baseUrl: base }, config: {} } }));

      assert.equal(global.fetch.calls.length, 1);
      assert.equal(result.checkpoint.coverage, 'all-public-regions-observed');
      assert.equal(result.checkpoint.nextUrl, spb);
      assert.equal(result.checkpoint.regionCatalog.total, 4);
    } finally {
      restoreFetch();
    }
  });

  it('retries an all-region continuation from the checkpoint region instead of starting from Moscow again', async () => {
    const catalog = JSON.parse(readFileSync(fixture('region-contract-sample-response.json'), 'utf8'));
    const restoreFetch = mockFetch([{ status: 200, body: catalog }]);
    try {
      const web = new FakeExtraction({
        [spb]: listHtml({ jobs: [job(2002)], next: null }),
        [urlFor(2002)]: detailHtml(job(2002)),
      });
      const seed = await new RabotaRuConnector(new FakeExtraction({ [base]: listHtml({ jobs: [job(2001)], next: null }), [urlFor(2001)]: detailHtml(job(2001)) })).fetchPage(defaultCatalogCtx());
      const retried = await new RabotaRuConnector(web).fetchPage(defaultCatalogCtx({ source: { config: { listUrl: base } }, checkpoint: seed.checkpoint }));

      assert.equal(global.fetch.calls.length, 1);
      assert.equal(retried.records[0].externalId, '2002');
      assert.equal(web.calls[0], spb);
      assert.equal(retried.checkpoint.nextUrl, 'https://volgograd.rabota.ru/vacancy/?sort=date');
    } finally {
      restoreFetch();
    }
  });

  it('keeps manual list URL overrides configured-only and does not call the region catalog', async () => {
    const restoreFetch = mockFetch([{ status: 500, body: { errors: [{ code: 'SHOULD_NOT_BE_USED' }] } }]);
    try {
      const web = new FakeExtraction({ [base]: listHtml({ jobs: [job(3001)], next: null }), [urlFor(3001)]: detailHtml(job(3001)) });
      const result = await new RabotaRuConnector(web).fetchPage(ctx({ source: { endpoint: {}, config: { listUrl: base } } }));

      assert.equal(global.fetch.calls.length, 0);
      assert.equal(result.checkpoint.coverage, 'configured-list-urls-only');
      assert.match(result.checkpoint.coverageLimitation, /Manual Rabota.ru list URL override/);
      assert.deepEqual(result.checkpoint.sourceUrls, [base]);
      assert.equal(result.checkpoint.completedRegionCount, undefined);
      assert.deepEqual(result.checkpoint.visitedListUrls, [base]);
    } finally {
      restoreFetch();
    }
  });

  it('rejects tampered all-region checkpoint catalogs before advancing a continuation', async () => {
    const catalog = JSON.parse(readFileSync(fixture('region-contract-sample-response.json'), 'utf8'));
    const restoreFetch = mockFetch([{ status: 200, body: catalog }]);
    try {
      const seed = await new RabotaRuConnector(new FakeExtraction({ [base]: listHtml({ jobs: [job(3051)], next: null }), [urlFor(3051)]: detailHtml(job(3051)) })).fetchPage(defaultCatalogCtx());
      await assert.rejects(
        () => new RabotaRuConnector(new FakeExtraction({})).fetchPage(defaultCatalogCtx({ checkpoint: { ...seed.checkpoint, regionCatalog: { ...seed.checkpoint.regionCatalog, hash: 'tampered' } } })),
        /region catalog hash mismatch/,
      );
    } finally {
      restoreFetch();
    }
  });


  it('treats observed past-last all-region pages as region-complete while preserving malformed empty failures', async () => {
    const catalog = JSON.parse(readFileSync(fixture('region-contract-sample-response.json'), 'utf8'));
    const restoreFetch = mockFetch([{ status: 200, body: catalog }]);
    try {
      const page164 = readFileSync(fixture('live-moscow-page164.html'), 'utf8');
      const page165 = readFileSync(fixture('live-moscow-page165.html'), 'utf8');
      assert.equal(jobPostingCount(page164), 13);
      assert.equal(jobPostingCount(page165), 0);

      const seed = await new RabotaRuConnector(new FakeExtraction({ [base]: listHtml({ jobs: [job(3301)], next: null }), [urlFor(3301)]: detailHtml(job(3301)) })).fetchPage(defaultCatalogCtx());
      const moscowCheckpoint = {
        ...seed.checkpoint,
        hasMore: true,
        nextUrl: 'https://www.rabota.ru/vacancy/?sort=date&page=165',
        listIndex: 0,
        regionIndex: 0,
        completedRegionCount: 0,
        visitedListUrls: ['https://www.rabota.ru/vacancy/?sort=date&page=164'],
      };
      const pastLast = await new RabotaRuConnector(new FakeExtraction({ ['https://www.rabota.ru/vacancy/?sort=date&page=165']: page165 })).fetchPage(defaultCatalogCtx({ checkpoint: moscowCheckpoint }));

      assert.deepEqual(pastLast.records, []);
      assert.equal(pastLast.stats.seen, 0);
      assert.equal(pastLast.hasMore, true);
      assert.equal(pastLast.checkpoint.nextUrl, spb);
      assert.equal(pastLast.checkpoint.listIndex, 1);
      assert.equal(pastLast.checkpoint.completedRegionCount, 1);
      assert.deepEqual(pastLast.checkpoint.visitedListUrls, ['https://www.rabota.ru/vacancy/?sort=date&page=164', 'https://www.rabota.ru/vacancy/?sort=date&page=165']);

      const earlyEmpty = page165.replace('totalVacancies:4903', 'totalVacancies:6000');
      await assert.rejects(
        () => new RabotaRuConnector(new FakeExtraction({ ['https://www.rabota.ru/vacancy/?sort=date&page=165']: earlyEmpty })).fetchPage(defaultCatalogCtx({ checkpoint: moscowCheckpoint })),
        /no public JobPosting JSON-LD/,
      );
      const wrongRegion = page165.replace('location.region_id:3', 'location.region_id:9999');
      await assert.rejects(
        () => new RabotaRuConnector(new FakeExtraction({ ['https://www.rabota.ru/vacancy/?sort=date&page=165']: wrongRegion })).fetchPage(defaultCatalogCtx({ checkpoint: moscowCheckpoint })),
        /no public JobPosting JSON-LD/,
      );
      const noNuxt = '<!doctype html><html><body>captcha required</body></html>';
      await assert.rejects(
        () => new RabotaRuConnector(new FakeExtraction({ ['https://www.rabota.ru/vacancy/?sort=date&page=165']: noNuxt })).fetchPage(defaultCatalogCtx({ checkpoint: moscowCheckpoint })),
        /no public JobPosting JSON-LD/,
      );
    } finally {
      restoreFetch();
    }
  });

  it('advances verified all-region empty pages but rejects missing or mismatched all-region checkpoints', async () => {
    const baseCatalog = JSON.parse(readFileSync(fixture('region-contract-sample-response.json'), 'utf8'));
    const catalog = { response: { regions: [baseCatalog.response.regions[0], { id: 1855, name: 'Ровно', domain: 'rovno' }, baseCatalog.response.regions[1]], total: 3 }, request_id: baseCatalog.request_id };
    const restoreFetch = mockFetch([{ status: 200, body: catalog }]);
    try {
      const rovno = 'https://rovno.rabota.ru/vacancy/?sort=date';
      const seed = await new RabotaRuConnector(new FakeExtraction({ [base]: listHtml({ jobs: [job(3061)], next: null }), [urlFor(3061)]: detailHtml(job(3061)) })).fetchPage(defaultCatalogCtx());
      const emptyHtml = readFileSync(fixture('live-empty-region-rovno.html'), 'utf8');
      const empty = await new RabotaRuConnector(new FakeExtraction({ [rovno]: emptyHtml })).fetchPage(defaultCatalogCtx({ checkpoint: seed.checkpoint }));
      const renamedAliasesHtml = emptyHtml
        .replace('(function(a,b,c,d,f,t,u)', '(function(a,b,c,z,f,t,q)')
        .replace(/:d\b/g, ':z')
        .replace(/:u\b/g, ':q');
      const renamedAliases = await new RabotaRuConnector(new FakeExtraction({ [rovno]: renamedAliasesHtml })).fetchPage(defaultCatalogCtx({ checkpoint: seed.checkpoint }));

      assert.deepEqual(empty.records, []);
      assert.deepEqual(renamedAliases.records, []);
      assert.equal(empty.stats.seen, 0);
      assert.equal(empty.hasMore, true);
      assert.equal(empty.checkpoint.nextUrl, spb);
      assert.equal(empty.checkpoint.completedRegionCount, 2);
      assert.deepEqual(empty.checkpoint.visitedListUrls, [base, rovno]);

      const wrongRegionFingerprint = emptyHtml.replace('location.region_id:1855', 'location.region_id:9999');
      await assert.rejects(
        () => new RabotaRuConnector(new FakeExtraction({ [rovno]: wrongRegionFingerprint })).fetchPage(defaultCatalogCtx({ checkpoint: seed.checkpoint })),
        /no public JobPosting JSON-LD/,
      );

      for (const html of [
        emptyHtml.replace('})(false,null,"",0,true,30,"date")', '})(false,null,"",1,true,30,"date")'),
        emptyHtml.replace('})(false,null,"",0,true,30,"date")', '})(false,null,"",0,true,30,"relevance")'),
        emptyHtml.replace('(function(a,b,c,d,f,t,u)', '(function(a,b,c,x,f,t,y)'),
        '<!doctype html><html><body><div id="app"></div><script src="/nuxt-public-rabota/app.js"></script></body></html>',
        '<!doctype html><html><title>Maintenance</title><body>Попробуйте позже</body></html>',
        '<!doctype html><html><body>captcha required</body></html>',
        '<!doctype html><html><script>window.__NUXT__={state:{rabota:{search:{totalVacancies:0,relevantVacancies:0,actualVacancies:0,vacancies:[]}}}}</script></html>',
      ]) {
        await assert.rejects(
          () => new RabotaRuConnector(new FakeExtraction({ [rovno]: html })).fetchPage(defaultCatalogCtx({ checkpoint: seed.checkpoint })),
          /no public JobPosting JSON-LD/,
        );
      }

      await assert.rejects(
        () => new RabotaRuConnector(new FakeExtraction({ [rovno]: readFileSync(fixture('live-empty-region-rovno.html'), 'utf8') })).fetchPage(ctx({ source: { endpoint: {}, config: { listUrl: rovno } } })),
        /no public JobPosting JSON-LD/,
      );

      await assert.rejects(
        () => new RabotaRuConnector(new FakeExtraction({})).fetchPage(defaultCatalogCtx({ checkpoint: { hasMore: true, coverage: 'all-public-regions-observed', sourceUrls: seed.checkpoint.sourceUrls, listIndex: 1, nextUrl: spb } })),
        /no valid region catalog/,
      );
      await assert.rejects(
        () => new RabotaRuConnector(new FakeExtraction({})).fetchPage(defaultCatalogCtx({ checkpoint: { ...seed.checkpoint, sourceUrls: [base, spb] } })),
        /source URLs do not match the catalog/,
      );
    } finally {
      restoreFetch();
    }
  });

  it('continues old configured-only checkpoints even when the source no longer has manual list URLs', async () => {
    const restoreFetch = mockFetch([{ status: 500, body: { errors: [{ code: 'SHOULD_NOT_BE_USED' }] } }]);
    try {
      const web = new FakeExtraction({ [spb]: listHtml({ jobs: [job(3101)], next: null }), [urlFor(3101)]: detailHtml(job(3101)) });
      const result = await new RabotaRuConnector(web).fetchPage(defaultCatalogCtx({ checkpoint: { hasMore: true, coverage: 'configured-list-urls-only', sourceUrls: [spb], listIndex: 0, nextUrl: spb, backfillSince: '2026-09-04T00:00:00.000Z', windowTo: '2026-10-05T00:00:00.000Z' } }));

      assert.equal(global.fetch.calls.length, 0);
      assert.equal(result.records[0].externalId, '3101');
      assert.equal(result.checkpoint.coverage, 'configured-list-urls-only');
    } finally {
      restoreFetch();
    }
  });

  it('fails loudly for partial, duplicate or unsafe public region catalogs and falls back from v5 endpoint-not-found to v4', async () => {
    const sample = JSON.parse(readFileSync(fixture('region-contract-sample-response.json'), 'utf8'));
    const partial = { response: { regions: sample.response.regions.slice(0, 2), total: 4 } };
    const duplicate = { response: { regions: [sample.response.regions[0], { ...sample.response.regions[1], domain: sample.response.regions[0].domain }], total: 2 } };
    const unsafe = { response: { regions: [{ id: 1, name: 'Bad', domain: 'evil.example' }], total: 1 } };
    const fractionalTotal = { response: { regions: [sample.response.regions[0]], total: 1.5 } };
    const fractionalId = { response: { regions: [{ id: 1.5, name: 'Bad', domain: 'bad' }], total: 1 } };

    for (const [body, message] of [[partial, /total 4 does not match 2/], [duplicate, /duplicate domain/], [unsafe, /unsafe domain/], [fractionalTotal, /positive integer total/], [fractionalId, /incomplete region entry/]]) {
      const restoreFetch = mockFetch([{ status: 200, body }]);
      try {
        await assert.rejects(() => new RabotaRuConnector(new FakeExtraction({})).fetchPage(defaultCatalogCtx()), message);
      } finally {
        restoreFetch();
      }
    }

    const restoreLargeFetch = mockFetch([{ response: new Response('x'.repeat(1_000_001), { status: 200 }) }]);
    try {
      await assert.rejects(() => new RabotaRuConnector(new FakeExtraction({})).fetchPage(defaultCatalogCtx()), /response is too large/);
    } finally {
      restoreLargeFetch();
    }

    const restoreFetch = mockFetch([
      { status: 404, body: { errors: [{ code: 'ENDPOINT_NOT_FOUND' }], request_id: 1 } },
      { status: 200, body: sample },
    ]);
    try {
      const web = new FakeExtraction({ [base]: listHtml({ jobs: [job(3201)], next: null }), [urlFor(3201)]: detailHtml(job(3201)) });
      const result = await new RabotaRuConnector(web).fetchPage(defaultCatalogCtx());

      assert.equal(result.records[0].externalId, '3201');
      assert.equal(global.fetch.calls.length, 2);
      assert.match(global.fetch.calls[0].url, /\/v5\/regions\/suggest\.json$/);
      assert.match(global.fetch.calls[1].url, /\/v4\/regions\/suggest\.json$/);
    } finally {
      restoreFetch();
    }
  });

  it('does not turn unknown salary amount currency and period into machine originalText', async () => {
    const unknownSalary = job(54205119, {
      title: 'Hr-менеджер',
      baseSalary: { '@type': 'MonetaryAmount', currency: 'RUB', value: { '@type': 'QuantitativeValue', unitText: 'MONTH' } },
      estimatedSalary: { '@type': 'MonetaryAmount', currency: 'RUB', value: { '@type': 'QuantitativeValue', unitText: 'MONTH' } },
    });
    const knownMinZeroMax = job(54428957, {
      baseSalary: { '@type': 'MonetaryAmount', currency: 'RUB', minValue: 65000, maxValue: 0, value: { '@type': 'QuantitativeValue', unitText: 'MONTH' } },
    });
    const web = new FakeExtraction({
      [base]: listHtml({ jobs: [unknownSalary, knownMinZeroMax], next: null }),
      [unknownSalary.url]: detailHtml(unknownSalary, { salary: null }),
      [knownMinZeroMax.url]: detailHtml(knownMinZeroMax, { salary: { from: 65000, to: 0, currency: 'руб./мес.' } }),
    });

    const result = await new RabotaRuConnector(web).fetchPage(ctx());
    const normalized = result.records.map((record) => new SourceNormalizerService().normalize(source(), record));

    assert.deepEqual(result.records[0].sourceMetadata.salary, { currency: 'RUB', period: 'MONTH' });
    assert.equal(result.records[0].sourceMetadata.salary.originalText, undefined);
    assert.equal(normalized[0].money.originalText, undefined);
    assert.deepEqual(normalized[0].money, { currency: 'RUB', period: 'MONTH' });
    assert.deepEqual(result.records[0].rawPayload.jsonLd, unknownSalary);

    assert.deepEqual(result.records[1].sourceMetadata.salary, { min: 65000, currency: 'RUB', period: 'MONTH', originalText: '65000 RUB MONTH' });
    assert.deepEqual(normalized[1].money, { originalText: '65000 RUB MONTH', min: 65000, currency: 'RUB', period: 'MONTH' });
  });

  it('reads only top-level Nuxt properties and ignores strings or nested child objects with matching keys', async () => {
    const poisoned = job(77, { datePosted: '2026-10-04T08:00:00.000Z' });
    const web = new FakeExtraction({
      [base]: listHtml({ jobs: [poisoned], next: null }),
      [poisoned.url]: detailHtml(poisoned, {
        description: '<p>Literal ,id:999 and ,currency:"USD" must stay body text</p>',
        companyObject: '{description:"nested ,name:\"Wrong Co\"",child:{name:"Wrong Child"},name:"Right Co"}',
        skills: ['TypeScript'],
      }),
    });

    const result = await new RabotaRuConnector(web).fetchPage(ctx());

    assert.equal(result.records[0].externalId, '77');
    assert.match(result.records[0].description, /id:999/);
    assert.equal(result.records[0].companyOrClient, 'Right Co');
    assert.deepEqual(result.records[0].sourceMetadata.skills, ['TypeScript']);
  });

  it('parses saved anonymous same-ID live detail fixtures for published descriptions', async () => {
    const liveList = firstLiveJobs(readFileSync(fixture('live-list-first3.html'), 'utf8'), 3);
    const web = new FakeExtraction({
      [base]: liveList,
      'https://www.rabota.ru/vacancy/54205119/': readFileSync(fixture('live-detail-54205119.html'), 'utf8'),
      'https://www.rabota.ru/vacancy/54428957/': readFileSync(fixture('live-detail-54428957.html'), 'utf8'),
      'https://www.rabota.ru/vacancy/54336588/': readFileSync(fixture('live-detail-54336588.html'), 'utf8'),
    });
    const result = await new RabotaRuConnector(web).fetchPage(ctx({ source: { endpoint: {}, config: { listUrl: base } }, backfillSince: '2026-09-01T00:00:00.000Z', checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } }));

    assert.deepEqual(result.records.map((record) => record.externalId), ['54205119', '54428957', '54336588']);
    assert.equal(result.records.every((record) => /^\d+$/.test(record.externalId)), true);
    assert.equal(result.records.some((record) => /career/i.test(record.url)), false);
    assert.match(result.records[0].description, /полное формирование команды/);
    assert.ok(result.records[2].description.length > 500);
    assert.equal(result.records[0].sourceMetadata.extraction, 'rabota-ru-detail-nuxt-ssr');
    assert.equal(result.records[0].rawPayload.detailState.id, '54205119');
    assert.equal(result.checkpoint.coverage, 'configured-list-urls-only');
    assert.match(result.checkpoint.coverageLimitation, /Manual Rabota.ru list URL override/);
  });

  it('continues beyond configured maxPages and advances to another public region list after terminal page', async () => {
    const web = new FakeExtraction({
      [base]: listHtml({ jobs: [job(1)], next: '/vacancy/?sort=date&page=2' }),
      [urlFor(1)]: detailHtml(job(1)),
      'https://www.rabota.ru/vacancy/?sort=date&page=2': listHtml({ jobs: [job(2)], next: null }),
      [urlFor(2)]: detailHtml(job(2)),
      [spb]: listHtml({ jobs: [job(3, { url: 'https://spb.rabota.ru/vacancy/3/' })], next: null }),
      ['https://spb.rabota.ru/vacancy/3/']: detailHtml(job(3, { url: 'https://spb.rabota.ru/vacancy/3/' })),
    });
    const connector = new RabotaRuConnector(web);

    const first = await connector.fetchPage(ctx());
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));
    const third = await connector.fetchPage(ctx({ checkpoint: second.checkpoint }));

    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, true);
    assert.equal(second.checkpoint.nextUrl, spb);
    assert.equal(third.hasMore, false);
    assert.deepEqual(web.calls, [base, urlFor(1), 'https://www.rabota.ru/vacancy/?sort=date&page=2', urlFor(2), spb, 'https://spb.rabota.ru/vacancy/3/']);
  });

  it('keeps unknown dates, filters records outside the fixed window, and follows observed pagination without assuming date sort semantics', async () => {
    const freshUnknown = job(10, { datePosted: undefined });
    const old = job(11, { datePosted: '2026-08-01T10:00:00.000Z' });
    const future = job(12, { datePosted: new Date(Date.now() + 86_400_000).toISOString() });
    const detailOld = job(13, { datePosted: undefined });
    const web = new FakeExtraction({
      [base]: listHtml({ jobs: [freshUnknown, old, future, detailOld], next: '/vacancy/?sort=date&page=2' }),
      [freshUnknown.url]: detailHtml(freshUnknown, { publishStartAt: undefined }),
      [future.url]: detailHtml(future),
      [detailOld.url]: detailHtml(detailOld, { publishStartAt: '2026-08-01T10:00:00.000Z' }),
    });

    const result = await new RabotaRuConnector(web).fetchPage(ctx());

    assert.deepEqual(result.records.map((record) => record.externalId), ['10']);
    assert.equal(result.records[0].publishedAt, undefined);
    assert.equal(result.hasMore, true);
    assert.equal(result.checkpoint.backfillSince, '2026-09-04T00:00:00.000Z');

    const exhaustedWeb = new FakeExtraction({ [base]: listHtml({ jobs: [old], next: '/vacancy/?sort=date&page=2' }) });
    const exhausted = await new RabotaRuConnector(exhaustedWeb).fetchPage(ctx());
    assert.equal(exhausted.records.length, 0);
    assert.equal(exhausted.hasMore, true);
    assert.equal(exhausted.checkpoint.nextUrl, 'https://www.rabota.ru/vacancy/?sort=date&page=2');

    const relevance = 'https://www.rabota.ru/vacancy/?sort=relevance';
    const relevanceWeb = new FakeExtraction({ [relevance]: listHtml({ jobs: [old], next: '/vacancy/?sort=relevance&page=2' }) });
    const relevanceResult = await new RabotaRuConnector(relevanceWeb).fetchPage(ctx({ source: { endpoint: { baseUrl: relevance } } }));
    assert.equal(relevanceResult.hasMore, true);
    assert.equal(relevanceResult.checkpoint.nextUrl, 'https://www.rabota.ru/vacancy/?sort=relevance&page=2');

    const terminalCheckpointWeb = new FakeExtraction({ [base]: listHtml({ jobs: [job(14, { datePosted: '2026-09-05T10:00:00.000Z' })], next: null }), [urlFor(14)]: detailHtml(job(14, { datePosted: '2026-09-05T10:00:00.000Z' })) });
    const terminal = await new RabotaRuConnector(terminalCheckpointWeb).fetchPage(ctx({ checkpoint: { hasMore: false, backfillSince: '2026-01-01T00:00:00.000Z', windowTo: '2026-01-02T00:00:00.000Z' } }));
    assert.deepEqual(terminal.records.map((record) => record.externalId), ['14']);
  });

  it('rejects landing pages and hostile continuation URLs without fabricating records', async () => {
    const web = new FakeExtraction({ [base]: '<html><title>Работа и карьера</title><a href="/career">Карьера</a></html>' });
    await assert.rejects(() => new RabotaRuConnector(web).fetchPage(ctx()), /no public JobPosting JSON-LD/);

    for (const nextUrl of ['https://evil.example/vacancy/?page=2', 'https://www.rabota.ru:444/vacancy/?page=2', 'https://user:pass@www.rabota.ru/vacancy/?page=2', 'https://www.rabota.ru/vacancy/123/']) {
      await assert.rejects(() => new RabotaRuConnector(web).fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl } })), /invalid listing URL/);
    }
    assert.deepEqual(web.calls, [base]);
  });



  it('rejects pagination cycles, out-of-range list indexes, cross-region continuations and redirects', async () => {
    const web = new FakeExtraction({
      [base]: listHtml({ jobs: [job(1)], next: '/vacancy/?sort=date&page=2' }),
      [urlFor(1)]: detailHtml(job(1)),
      'https://www.rabota.ru/vacancy/?sort=date&page=2': listHtml({ jobs: [job(2)], next: '/vacancy/?sort=date&page=2' }),
      [urlFor(2)]: detailHtml(job(2)),
      [spb]: listHtml({ jobs: [job(3, { url: 'https://spb.rabota.ru/vacancy/3/' })], next: null }),
      'https://www.rabota.ru/vacancy/?sort=date&page=3': { finalUrl: 'https://spb.rabota.ru/vacancy/?sort=date&page=3', html: listHtml({ jobs: [job(4, { url: 'https://spb.rabota.ru/vacancy/4/' })], next: null }) },
    });
    const connector = new RabotaRuConnector(web);

    await assert.rejects(() => connector.fetchPage(ctx({ checkpoint: { hasMore: true, listIndex: 3, nextUrl: base } })), /listIndex is outside/);
    await assert.rejects(() => connector.fetchPage(ctx({ checkpoint: { hasMore: true, listIndex: 0, nextUrl: spb } })), /current configured regional origin/);
    await assert.rejects(() => connector.fetchPage(ctx({ checkpoint: { hasMore: true, listIndex: 0, nextUrl: 'https://www.rabota.ru/vacancy/?sort=date&page=2', visitedListUrls: ['https://www.rabota.ru/vacancy/?sort=date&page=2'] } })), /pagination cycle/);
    await assert.rejects(() => connector.fetchPage(ctx({ checkpoint: { hasMore: true, listIndex: 0, nextUrl: 'https://www.rabota.ru/vacancy/?sort=date&page=3' } })), /redirected outside the current configured regional origin/);
  });

  it('rejects detail redirects, id mismatches and missing detail bodies without accepting list snippets', async () => {
    const redirectWeb = new FakeExtraction({ [base]: listHtml({ jobs: [job(20)], next: null }), [urlFor(20)]: { finalUrl: urlFor(21), html: detailHtml(job(20)) } });
    await assert.rejects(() => new RabotaRuConnector(redirectWeb).fetchPage(ctx()), /redirected away/);

    const mismatchWeb = new FakeExtraction({ [base]: listHtml({ jobs: [job(22)], next: null }), [urlFor(22)]: detailHtml(job(23)) });
    await assert.rejects(() => new RabotaRuConnector(mismatchWeb).fetchPage(ctx()), /detail payload id mismatch/);

    const missingBodyWeb = new FakeExtraction({ [base]: listHtml({ jobs: [job(24, { description: '<p>List snippet only</p>' })], next: null }), [urlFor(24)]: detailHtml(job(24), { description: '' }) });
    await assert.rejects(() => new RabotaRuConnector(missingBodyWeb).fetchPage(ctx()), /no public detail description/);
  });

  it('propagates fetch failures and forwards abort signals to list and detail extraction', async () => {
    const signal = new AbortController().signal;
    const failWeb = new FakeExtraction({ [base]: new Error('HTTP 503') });
    await assert.rejects(() => new RabotaRuConnector(failWeb).fetchPage(ctx({ signal })), /HTTP 503/);
    assert.equal(failWeb.options[0].signal, signal);

    const web = new FakeExtraction({ [base]: listHtml({ jobs: [job(30)], next: null }), [urlFor(30)]: detailHtml(job(30)) });
    await new RabotaRuConnector(web).fetchPage(ctx({ signal }));
    assert.equal(web.options[0].signal, signal);
    assert.equal(web.options[1].signal, signal);
  });
});

function jobPostingCount(html) {
  return (html.match(/"@type"\s*:\s*"JobPosting"/g) ?? []).length;
}

function listHtml({ jobs, next }) {
  return `<!doctype html><html><head>${next ? `<link rel="next" href="${next}">` : ''}<script type="application/ld+json">${JSON.stringify(jobs)}</script></head><body><a href="/career">Career landing</a></body></html>`;
}

function job(id, overrides = {}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: `Backend engineer ${id}`,
    url: `https://www.rabota.ru/vacancy/${id}/`,
    datePosted: `2026-10-04T08:${String(id).padStart(2, '0')}:00.000Z`,
    description: `<p>Build APIs ${id}</p><ul><li>Ship services</li></ul>`,
    hiringOrganization: { '@type': 'Organization', name: `Company ${id}` },
    baseSalary: { '@type': 'MonetaryAmount', currency: 'RUB', minValue: 100000, maxValue: 150000, value: { '@type': 'QuantitativeValue', unitText: 'MONTH' } },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Москва', streetAddress: 'Тверская', addressCountry: 'Россия' } },
    employmentType: ['FULL_TIME', 'REMOTE'],
    skills: ['Node.js', 'Postgres'],
    ...overrides,
  };
}


function detailPages(jobs) {
  return Object.fromEntries(jobs.map((posting) => [posting.url, detailHtml(posting)]));
}

function detailHtml(posting, overrides = {}) {
  const id = /\/(\d+)\/?$/.exec(posting.url)[1];
  const salary = overrides.salary === null ? 'b' : salaryLiteral(overrides.salary ?? { from: 100000, to: 150000, currency: 'руб./мес.' });
  const publishStartAt = Object.prototype.hasOwnProperty.call(overrides, 'publishStartAt') ? overrides.publishStartAt : posting.datePosted;
  const description = overrides.description ?? `<p>Full published body ${id}</p><ul><li>Ship services from detail</li></ul>`;
  const company = overrides.company === undefined ? `Company ${id}` : overrides.company;
  const companyObject = overrides.companyObject ?? `{name:${company ? JSON.stringify(company) : 'b'}}`;
  const skills = overrides.skills ?? ['Node.js', 'Postgres'];
  return `<html><script>window.__NUXT__={state:{vacancy:{vacancy:{id:${id},title:${JSON.stringify(posting.title)},salary:${salary},description:${JSON.stringify(description)},short_description:${JSON.stringify('Short ' + id)},places:[{name:${JSON.stringify('Office ' + id)},address:${JSON.stringify('Москва, Тверская, Россия')},region:{name:${JSON.stringify('Москва')}}}],publish_start_at:${publishStartAt ? JSON.stringify(publishStartAt) : 'b'},operating_schedule:{name:${JSON.stringify('удаленная работа')}},experience:{name:${JSON.stringify('от 1 года')}},company:${companyObject},skills:[${skills.map((skill) => `{name:${JSON.stringify(skill)}}`).join(',')}],tags:[{name:${JSON.stringify('not-a-skill')}}]}}}}}</script></html>`;
}

function salaryLiteral(value) {
  return `{from:${value.from ?? 'b'},to:${value.to ?? 'b'},currency:${JSON.stringify(value.currency ?? 'руб./мес.')}}`;
}

function firstLiveJobs(html, count) {
  const match = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  assert.ok(match, 'live Rabota fixture must contain JobPosting JSON-LD');
  const data = JSON.parse(match[1]);
  const jobs = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value['@type'] === 'JobPosting') jobs.push(value);
    if (Array.isArray(value['@graph'])) value['@graph'].forEach(walk);
  };
  walk(data);
  return listHtml({ jobs: jobs.slice(0, count), next: null });
}

function urlFor(id) {
  return `https://www.rabota.ru/vacancy/${id}/`;
}


function fixture(name) {
  return new URL(`./fixtures/rabota-ru/${name}`, import.meta.url);
}

function defaultCatalogCtx(overrides = {}) {
  const { source: sourceOverride, ...rest } = overrides;
  return ctx({
    ...rest,
    source: { endpoint: {}, config: {}, ...(sourceOverride ?? {}) },
  });
}

function mockFetch(responses) {
  const previous = global.fetch;
  const queue = [...responses];
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : undefined });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected fetch ${url}`);
    if (next.response) return next.response;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      async text() {
        return typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
      },
    };
  };
  global.fetch.calls = calls;
  return () => {
    global.fetch = previous;
  };
}

function source() {
  return { _id: 'rabota_ru', name: 'Rabota.ru', connectorFamily: 'PublicHtml', group: 'job_board' };
}
