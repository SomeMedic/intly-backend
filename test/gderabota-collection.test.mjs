import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { GdeRabotaConnector } = require('../src/modules/sources/connectors/gderabota.connector.ts');
const { WebExtractionHttpError } = require('../src/modules/sources/extraction/web-extraction.service.ts');

const base = 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8?sort=date';
const detailUrl = 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8/%D0%BC%D0%BE%D1%81%D0%BA%D0%B2%D0%B0/%D1%81%D0%BE%D1%82%D1%80%D1%83%D0%B4%D0%BD%D0%B8%D0%BA-%D0%B4%D0%B5%D0%B6%D1%83%D1%80%D0%BD%D0%BE%D0%B9-%D1%87%D0%B0%D1%81%D1%82%D0%B8-%D0%BC%D0%B2%D0%B4-%D0%BD%D0%B0-%D0%B2%D0%BE%D0%BA%D0%B7%D0%B0%D0%BB%D0%B5/159668';

function fixture(name) {
  return readFileSync(new URL(`./fixtures/gderabota/${name}`, import.meta.url), 'utf8');
}

function ctx(overrides = {}) {
  return {
    source: { _id: 'gderabota', name: 'GdeRabota', connectorFamily: 'PublicHtml', endpoint: { baseUrl: base }, config: {}, timeoutMs: 30_000, ...overrides.source },
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
    requestId: 'gderabota-test',
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
    const entry = this.pages[url] ?? this.pages[decodeURIComponent(url)];
    if (entry instanceof Error) throw entry;
    if (!entry) throw new Error(`Unexpected GdeRabota URL ${url}`);
    if (typeof entry === 'object' && 'html' in entry) return { finalUrl: entry.finalUrl ?? url, html: entry.html, metadata: { firecrawl: false } };
    return { finalUrl: url, html: entry, metadata: { firecrawl: false } };
  }
}

describe('GdeRabota public Inertia vacancy collection', () => {
  it('parses the saved live list fixture and enriches a public detail page with full text', async () => {
    const list = fixture('search.html');
    const detail = fixture('detail.html');
    const web = new FakeExtraction({ [base]: singleItemList(list), [detailUrl]: detail });

    const result = await new GdeRabotaConnector(web).fetchPage(ctx({ backfillSince: '2026-07-01T00:00:00.000Z', checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } }));

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].externalId, '159668');
    assert.equal(result.records[0].title, 'Сотрудник дежурной части МВД на вокзале');
    assert.equal(result.records[0].companyOrClient, 'ЛО МВД РОССИИ НА СТАНЦИИ МОСКВА-БЕЛОРУССКАЯ');
    assert.match(result.records[0].description, /Принимать и обрабатывать информацию о происшествиях/);
    assert.doesNotMatch(result.records[0].description, /\.\.\./);
    assert.deepEqual(result.records[0].sourceMetadata.salary, { min: 65000, currency: 'RUB', originalText: 'от 65000 RUB' });
    assert.equal(result.records[0].sourceMetadata.seniority, 'Без опыта');
    assert.equal(result.records[0].sourceMetadata.employment, 'Полная занятость');
    assert.equal(result.records[0].sourceMetadata.schedule, 'Полный день');
    assert.equal(result.records[0].publishedAt.toISOString(), '2026-07-15T10:17:00.000Z');
    assert.equal(result.records[0].updatedAt.toISOString(), '2026-10-04T10:01:00.000Z');
    assert.equal(result.hasMore, true);
    assert.equal(result.checkpoint.nextUrl, 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8?sort=date&page=2');
    assert.deepEqual(web.options[0].allowedHosts, ['gderabota.ru']);
  });



  it('accepts the observed Trudvsem provider detail URL shape for vacancy 907316 and keeps same-id safety', async () => {
    const listUrl = 'https://gderabota.ru/вакансии?autocompleteCity=-1&filterInThirtyDays=1&page=306';
    const providerDetailUrl = 'https://gderabota.ru/вакансии/трудвсем/907316';
    const web = new FakeExtraction({
      [listUrl]: listWithVacancy('live-page-306.html', '907316'),
      [providerDetailUrl]: fixture('live-detail-907316.html'),
    });

    const result = await new GdeRabotaConnector(web).fetchPage(ctx({
      source: { endpoint: { baseUrl: listUrl } },
      backfillSince: '2021-01-01T00:00:00.000Z',
      checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' },
    }));

    assert.deepEqual(web.calls, [
      'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8?autocompleteCity=-1&filterInThirtyDays=1&page=306',
      'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8/%D1%82%D1%80%D1%83%D0%B4%D0%B2%D1%81%D0%B5%D0%BC/907316',
    ]);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].externalId, '907316');
    assert.equal(result.records[0].url, 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8/%D1%82%D1%80%D1%83%D0%B4%D0%B2%D1%81%D0%B5%D0%BC/907316');
    assert.equal(result.records[0].title, 'Электромонтажник по вторичным цепям и электрооборудованию на вахту');
    assert.equal(result.records[0].companyOrClient, 'ООО "КУБ"');
    assert.match(result.records[0].description, /Монтаж разъединителей/);
    assert.equal(result.records[0].sourceMetadata.salary.originalText, 'от 80000 до 100000 RUB');

    for (const viewUrl of [
      '/вакансии/трудвсем/999',
      '/вакансии/трудвсем/907316?utm=1',
      'https://evil.example/вакансии/трудвсем/907316',
      'https://user:pass@gderabota.ru/вакансии/трудвсем/907316',
    ]) {
      const unsafe = new FakeExtraction({ [base]: listHtml({ items: [item(907316, { viewUrl })], next: null }) });
      await assert.rejects(() => new GdeRabotaConnector(unsafe).fetchPage(ctx()), /invalid detail URL|detail URL id mismatch/);
    }
  });



  it('accepts the observed vacancy-info provider detail URL shape for vacancy 2172937 and verifies identity from detail payload', async () => {
    const listUrl = 'https://gderabota.ru/вакансии?autocompleteCity=-1&filterInThirtyDays=1&page=631';
    const providerDetailUrl = 'https://gderabota.ru/вакансии/vacancy-info/1220200004397/8a73f358-be4d-11f1-a6ab-f7c7dbb1567d';
    const web = new FakeExtraction({
      [listUrl]: listWithVacancy('live-page-631.html', '2172937'),
      [providerDetailUrl]: fixture('live-detail-2172937.html'),
    });

    const result = await new GdeRabotaConnector(web).fetchPage(ctx({
      source: { endpoint: { baseUrl: listUrl } },
      checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' },
    }));

    assert.deepEqual(web.calls, [
      'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8?autocompleteCity=-1&filterInThirtyDays=1&page=631',
      'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8/vacancy-info/1220200004397/8a73f358-be4d-11f1-a6ab-f7c7dbb1567d',
    ]);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].externalId, '2172937');
    assert.equal(result.records[0].url, 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8/vacancy-info/1220200004397/8a73f358-be4d-11f1-a6ab-f7c7dbb1567d');
    assert.equal(result.records[0].title, 'Тестомес');
    assert.equal(result.records[0].companyOrClient, 'ООО "МАКОВСКАЯ И КО"');
    assert.match(result.records[0].description, /Ведение процесса приготовления теста/);
    assert.deepEqual(result.records[0].sourceMetadata.salary, { min: 40000, max: 40000, currency: 'RUB', originalText: 'от 40000 до 40000 RUB' });

    for (const viewUrl of [
      '/вакансии/vacancy-info/1220200004397/not-a-uuid',
      '/вакансии/vacancy-info/1220200004397/8a73f358-be4d-11f1-a6ab-f7c7dbb1567d?utm=1',
      'https://evil.example/вакансии/vacancy-info/1220200004397/8a73f358-be4d-11f1-a6ab-f7c7dbb1567d',
      'https://user:pass@gderabota.ru/вакансии/vacancy-info/1220200004397/8a73f358-be4d-11f1-a6ab-f7c7dbb1567d',
    ]) {
      const unsafe = new FakeExtraction({ [base]: listHtml({ items: [item(2172937, { viewUrl })], next: null }) });
      await assert.rejects(() => new GdeRabotaConnector(unsafe).fetchPage(ctx()), /invalid detail URL/);
    }

    const mismatch = new FakeExtraction({
      [base]: listHtml({ items: [item(2172937, { viewUrl: '/вакансии/vacancy-info/1220200004397/8a73f358-be4d-11f1-a6ab-f7c7dbb1567d' })], next: null }),
      [providerDetailUrl]: detailHtml(detailVacancy(2172938)),
    });
    await assert.rejects(() => new GdeRabotaConnector(mismatch).fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } })), /detail payload id mismatch/);

    const missingDetailId = new FakeExtraction({
      [base]: listHtml({ items: [item(2172937, { viewUrl: '/вакансии/vacancy-info/1220200004397/8a73f358-be4d-11f1-a6ab-f7c7dbb1567d' })], next: null }),
      [providerDetailUrl]: detailHtml({ ...detailVacancy(2172937), id: undefined, entityId: undefined }),
    });
    await assert.rejects(() => new GdeRabotaConnector(missingDetailId).fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } })), /detail payload has no stable id/);
  });

  it('uses durable pagination, deduplicates list items, and keeps a fixed known-date window', async () => {
    const page1 = listHtml({ items: [item(1), item(1)], next: `${base}&page=2` });
    const page2 = listHtml({ items: [item(1), item(2, { humanizeCreatedAt: '1 августа 2026, 10:00', humanizeUpdatedAt: '4 октября 2026, 10:00' }), item(3, { humanizeCreatedAt: undefined, humanizeUpdatedAt: '1 августа 2026, 10:00' })], next: null });
    const web = new FakeExtraction({
      [base]: page1,
      [`${base}&page=2`]: page2,
      [urlFor(1)]: detailHtml(detailVacancy(1)),
      [urlFor(2)]: detailHtml(detailVacancy(2)),
      [urlFor(3)]: detailHtml(detailVacancy(3, { humanizeUpdatedAt: undefined })),
    });
    const connector = new GdeRabotaConnector(web);

    const first = await connector.fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } }));
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint, backfillSince: '2026-10-01T00:00:00.000Z' }));

    assert.deepEqual(first.records.map((record) => record.externalId), ['1']);
    assert.equal(first.checkpoint.backfillSince, '2026-09-04T00:00:00.000Z');
    assert.deepEqual(second.records.map((record) => record.externalId), ['3']);
    assert.deepEqual(second.checkpoint.seenIds, ['1', '3']);
    assert.equal(second.checkpoint.backfillSince, '2026-09-04T00:00:00.000Z');
    assert.equal(second.hasMore, false);
  });

  it('rejects landing pages, hostile continuations, cycles, redirects and failed details without advancing', async () => {
    const web = new FakeExtraction({ [base]: '<html><body>Найти вакансию</body></html>' });
    await assert.rejects(() => new GdeRabotaConnector(web).fetchPage(ctx()), /no Inertia SSR/);
    for (const nextUrl of ['https://evil.example/вакансии?page=2', 'https://gderabota.ru:444/вакансии?page=2', 'https://user:pass@gderabota.ru/вакансии?page=2', 'https://gderabota.ru/вакансии/москва/title/123']) {
      await assert.rejects(() => new GdeRabotaConnector(web).fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl } })), /invalid listing URL/);
    }

    const invalidNextWeb = new FakeExtraction({ [base]: listHtml({ items: [item(1)], next: 'https://evil.example/вакансии?page=2' }), [urlFor(1)]: detailHtml(detailVacancy(1)) });
    await assert.rejects(() => new GdeRabotaConnector(invalidNextWeb).fetchPage(ctx()), /invalid next_page_url/);

    const malformedWeb = new FakeExtraction({ [base]: listHtml({ items: ['not-a-vacancy'], next: null }) });
    await assert.rejects(() => new GdeRabotaConnector(malformedWeb).fetchPage(ctx()), /malformed vacancy record/);

    const invalidIdWeb = new FakeExtraction({ [base]: listHtml({ items: [item(1, { entityId: null, id: 'opaque' })], next: null }) });
    await assert.rejects(() => new GdeRabotaConnector(invalidIdWeb).fetchPage(ctx()), /without a stable id/);

    const invalidUrlWeb = new FakeExtraction({ [base]: listHtml({ items: [item(1, { viewUrl: '/login' })], next: null }) });
    await assert.rejects(() => new GdeRabotaConnector(invalidUrlWeb).fetchPage(ctx()), /invalid detail URL/);

    const cycleWeb = new FakeExtraction({ [base]: listHtml({ items: [item(1)], next: base }), [urlFor(1)]: detailHtml(detailVacancy(1)) });
    await assert.rejects(() => new GdeRabotaConnector(cycleWeb).fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl: base, visitedListUrls: [base] } })), /pagination cycle/);

    const redirectWeb = new FakeExtraction({ [base]: listHtml({ items: [item(1)], next: null }), [urlFor(1)]: { finalUrl: 'https://gderabota.ru/вакансии/москва/other/2', html: detailHtml(detailVacancy(1)) } });
    await assert.rejects(() => new GdeRabotaConnector(redirectWeb).fetchPage(ctx()), /redirected away/);

    const snippetWeb = new FakeExtraction({ [base]: listHtml({ items: [item(1)], next: null }), [urlFor(1)]: detailHtml(detailVacancy(1, { about: undefined })) });
    await assert.rejects(() => new GdeRabotaConnector(snippetWeb).fetchPage(ctx()), /no usable public detail body/);

    const unknownComponentWeb = new FakeExtraction({ [base]: listHtml({ items: [item(1)], next: null }), [urlFor(1)]: inertiaHtml({ component: 'UnexpectedDetail/index', props: {} }) });
    await assert.rejects(() => new GdeRabotaConnector(unknownComponentWeb).fetchPage(ctx()), /expected detail SSR page, got UnexpectedDetail\/index/);

    const failWeb = new FakeExtraction({ [base]: listHtml({ items: [item(1)], next: null }), [urlFor(1)]: new Error('HTTP 503') });
    const checkpoint = {};
    await assert.rejects(() => new GdeRabotaConnector(failWeb).fetchPage(ctx({ checkpoint })), /HTTP 503/);
    assert.deepEqual(checkpoint, {});
  });

  it('records the observed first-moderation detail page as a coverage issue and carries it only through the active cycle', async () => {
    const moderationDetail = fixture('moderation-234667.html');
    const moderatedUrl = 'https://gderabota.ru/вакансии/катайск/обработчик-рыбы/234667';
    const expectedIssue = {
      id: '234667',
      url: 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8/%D0%BA%D0%B0%D1%82%D0%B0%D0%B9%D1%81%D0%BA/%D0%BE%D0%B1%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D1%87%D0%B8%D0%BA-%D1%80%D1%8B%D0%B1%D1%8B/234667',
      component: 'vacancyFirstModeration/index',
      reason: 'detail_under_moderation',
      title: 'Обработчик рыбы',
      companyOrClient: 'ООО "РЕСУРС ГРУПП"',
      publishedAt: '2026-10-01T19:03:00.000Z',
      listUrl: base,
    };
    const web = new FakeExtraction({
      [base]: listHtml({
        items: [
          item(234667, {
            title: 'Обработчик рыбы',
            cityName: 'Катайск',
            companyData: { name: 'ООО "РЕСУРС ГРУПП"' },
            humanizeCreatedAt: '1 октября 2026, 22:03',
            humanizeUpdatedAt: '2 октября 2026, 07:14',
            viewUrl: '/вакансии/катайск/обработчик-рыбы/234667',
          }),
          item(2),
        ],
        next: `${base}&page=2`,
      }),
      [`${base}&page=2`]: listHtml({ items: [item(3)], next: null }),
      [moderatedUrl]: moderationDetail,
      [urlFor(2)]: detailHtml(detailVacancy(2)),
      [urlFor(3)]: detailHtml(detailVacancy(3)),
    });
    const connector = new GdeRabotaConnector(web);

    const first = await connector.fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } }));
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint, backfillSince: '2026-10-01T00:00:00.000Z' }));

    assert.deepEqual(first.records.map((record) => record.externalId), ['2']);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.checkpoint.seenIds, ['234667', '2']);
    assert.deepEqual(first.checkpoint.detailCoverageIssues, [expectedIssue]);
    assert.deepEqual(second.records.map((record) => record.externalId), ['3']);
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.checkpoint.seenIds, ['234667', '2', '3']);
    assert.deepEqual(second.checkpoint.detailCoverageIssues, [expectedIssue]);

    const freshWeb = new FakeExtraction({
      [base]: listHtml({ items: [item(4)], next: null }),
      [urlFor(4)]: detailHtml(detailVacancy(4)),
    });
    const fresh = await new GdeRabotaConnector(freshWeb).fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } }));
    assert.deepEqual(fresh.records.map((record) => record.externalId), ['4']);
    assert.equal(fresh.hasMore, false);
    assert.equal(fresh.checkpoint.detailCoverageIssues, undefined);
  });

  it('records observed stale public detail 404s as coverage while preserving hard failures for listing, 403 and 5xx', async () => {
    const staleUrl = 'https://gderabota.ru/вакансии/санкт-петербург/водитель-экспедитор/233426';
    const resolvedStaleUrl = 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8/%D1%81%D0%B0%D0%BD%D0%BA%D1%82-%D0%BF%D0%B5%D1%82%D0%B5%D1%80%D0%B1%D1%83%D1%80%D0%B3/%D0%B2%D0%BE%D0%B4%D0%B8%D1%82%D0%B5%D0%BB%D1%8C-%D1%8D%D0%BA%D1%81%D0%BF%D0%B5%D0%B4%D0%B8%D1%82%D0%BE%D1%80-%D0%BF%D1%80%D0%BE%D0%B4%D1%83%D0%BA%D1%82%D1%8B-%D0%BF%D0%B8%D1%82%D0%B0%D0%BD%D0%B8%D1%8F/233426';
    const expectedIssue = {
      id: '233426',
      url: 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8/%D1%81%D0%B0%D0%BD%D0%BA%D1%82-%D0%BF%D0%B5%D1%82%D0%B5%D1%80%D0%B1%D1%83%D1%80%D0%B3/%D0%B2%D0%BE%D0%B4%D0%B8%D1%82%D0%B5%D0%BB%D1%8C-%D1%8D%D0%BA%D1%81%D0%BF%D0%B5%D0%B4%D0%B8%D1%82%D0%BE%D1%80/233426',
      resolvedUrl: resolvedStaleUrl,
      reason: 'detail_http_404',
      httpStatus: 404,
      title: 'Водитель-экспедитор',
      companyOrClient: 'ООО Картекс',
      publishedAt: '2026-09-29T05:41:00.000Z',
      listUrl: base,
    };
    const sameUrlIssue = {
      id: '8',
      url: urlFor(8),
      reason: 'detail_http_404',
      httpStatus: 404,
      title: 'Vacancy 8',
      companyOrClient: 'Company 8',
      publishedAt: '2026-10-04T06:00:00.000Z',
      listUrl: base,
    };
    const web = new FakeExtraction({
      [base]: listHtml({
        items: [
          item(233426, {
            title: 'Водитель-экспедитор',
            cityName: 'Санкт-Петербург',
            companyData: { name: 'ООО Картекс' },
            humanizeCreatedAt: '29 сентября 2026, 08:41',
            viewUrl: '/вакансии/санкт-петербург/водитель-экспедитор/233426',
          }),
          item(8),
          item(5),
        ],
        next: `${base}&page=2`,
      }),
      [`${base}&page=2`]: listHtml({ items: [item(6)], next: null }),
      [staleUrl]: httpError(404, resolvedStaleUrl),
      [urlFor(8)]: httpError(404, urlFor(8)),
      [urlFor(5)]: detailHtml(detailVacancy(5)),
      [urlFor(6)]: detailHtml(detailVacancy(6)),
    });
    const connector = new GdeRabotaConnector(web);

    const first = await connector.fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } }));
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));

    assert.deepEqual(first.records.map((record) => record.externalId), ['5']);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.checkpoint.seenIds, ['233426', '8', '5']);
    assert.deepEqual(first.checkpoint.detailCoverageIssues, [expectedIssue, sameUrlIssue]);
    assert.deepEqual(second.records.map((record) => record.externalId), ['6']);
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.checkpoint.seenIds, ['233426', '8', '5', '6']);
    assert.deepEqual(second.checkpoint.detailCoverageIssues, [expectedIssue, sameUrlIssue]);
    assert.equal(inertiaPayload(fixture('detail-233426-404.html')).component, 'Errors/index');

    await assert.rejects(() => new GdeRabotaConnector(new FakeExtraction({ [base]: httpError(404, base) })).fetchPage(ctx()), /HTTP 404/);
    const plain404 = new FakeExtraction({ [base]: listHtml({ items: [item(7)], next: null }), [urlFor(7)]: new Error('URL returned HTTP 404') });
    await assert.rejects(() => new GdeRabotaConnector(plain404).fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } })), /HTTP 404/);
    const redirected404 = new FakeExtraction({ [base]: listHtml({ items: [item(7)], next: null }), [urlFor(7)]: httpError(404, urlFor(999)) });
    await assert.rejects(() => new GdeRabotaConnector(redirected404).fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } })), /HTTP 404/);
    for (const status of [403, 500]) {
      const failing = new FakeExtraction({ [base]: listHtml({ items: [item(7)], next: null }), [urlFor(7)]: httpError(status, urlFor(7)) });
      await assert.rejects(() => new GdeRabotaConnector(failing).fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } })), new RegExp(`HTTP ${status}`));
    }
  });

  it('records listed vacancies without a public detail URL as coverage while preserving unsafe URL failures', async () => {
    const web = new FakeExtraction({
      [base]: listHtml({
        items: [inertiaPayload(fixture('page89-missing-url-231461.html')).props.vacancyList.data[0], item(5)],
        next: null,
      }),
      [urlFor(5)]: detailHtml(detailVacancy(5)),
    });

    const result = await new GdeRabotaConnector(web).fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } }));

    assert.deepEqual(result.records.map((record) => record.externalId), ['5']);
    assert.deepEqual(result.checkpoint.seenIds, ['231461', '5']);
    assert.deepEqual(result.checkpoint.detailCoverageIssues, [{
      id: '231461',
      reason: 'detail_url_missing',
      title: 'Мойщик посуды в пищевую промышленность',
      companyOrClient: 'ИП Кротов Николай Валерьевич',
      publishedAt: '2026-09-25T02:55:00.000Z',
      listUrl: base,
    }]);

    const unsafe = new FakeExtraction({ [base]: listHtml({ items: [item(9, { viewUrl: '/login' })], next: null }) });
    await assert.rejects(() => new GdeRabotaConnector(unsafe).fetchPage(ctx()), /invalid detail URL/);
  });

  it('keeps categories separate from skills and does not invent an employer fallback', async () => {
    const web = new FakeExtraction({
      [base]: listHtml({ items: [item(4, { companyData: {} })], next: null }),
      [urlFor(4)]: detailHtml(detailVacancy(4, { companyName: undefined, skills: ['TypeScript'], specializationList: ['IT'], socialCategories: ['Без опыта'] })),
    });

    const result = await new GdeRabotaConnector(web).fetchPage(ctx({ checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } }));

    assert.equal(result.records[0].companyOrClient, undefined);
    assert.deepEqual(result.records[0].sourceMetadata.categoryTags, ['IT', 'Без опыта']);
    assert.deepEqual(result.records[0].sourceMetadata.skills, ['TypeScript']);
  });

  it('accepts a structurally valid empty final list and rejects malformed pagination values', async () => {
    const empty = new FakeExtraction({ [base]: listHtml({ items: [], next: null }) });
    const result = await new GdeRabotaConnector(empty).fetchPage(ctx());
    assert.deepEqual(result.records, []);
    assert.equal(result.hasMore, false);
    for (const next of [2, {}, []]) {
      const invalid = new FakeExtraction({ [base]: listHtml({ items: [], next }) });
      await assert.rejects(() => new GdeRabotaConnector(invalid).fetchPage(ctx()), /invalid next_page_url/);
    }
    const missing = new FakeExtraction({ [base]: inertiaHtml({ component: 'VacancyList/index', props: { vacancyList: {} } }) });
    await assert.rejects(() => new GdeRabotaConnector(missing).fetchPage(ctx()), /no public vacancy data array/);
  });

  it('preserves the observed monthly filter while keeping local publication dates authoritative', async () => {
    const monthBase = 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8?autocompleteCity=-1&filterInSevenDays=&filterInThirtyDays=1&page=1';
    const monthNext = 'https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8?autocompleteCity=-1&filterInThirtyDays=1&page=2';
    const web = new FakeExtraction({ [monthBase]: listHtml({ items: [item(7, { humanizeCreatedAt: '15 июля 2026, 10:00' })], next: monthNext }) });
    const connector = new GdeRabotaConnector(web);
    const result = await connector.fetchPage(ctx({ source: { endpoint: { baseUrl: monthBase } } }));
    assert.deepEqual(result.records, []);
    assert.equal(result.hasMore, true);
    assert.equal(result.checkpoint.nextUrl, monthNext);
    assert.deepEqual(web.calls, [monthBase]);
    const dropped = new FakeExtraction({ [monthBase]: listHtml({ items: [], next: `${base}&page=2` }) });
    await assert.rejects(() => new GdeRabotaConnector(dropped).fetchPage(ctx({ source: { endpoint: { baseUrl: monthBase } } })), /dropped the configured monthly filter/);
  });

  it('forwards abort signals to list and detail extraction calls', async () => {
    const signal = new AbortController().signal;
    const web = new FakeExtraction({ [base]: listHtml({ items: [item(1)], next: null }), [urlFor(1)]: detailHtml(detailVacancy(1)) });
    await new GdeRabotaConnector(web).fetchPage(ctx({ signal, checkpoint: { windowTo: '2026-10-05T00:00:00.000Z' } }));
    assert.equal(web.options[0].signal, signal);
    assert.equal(web.options[1].signal, signal);
  });
});


function httpError(status, url) {
  return new WebExtractionHttpError(status, url);
}

function singleItemList(html) {
  const page = inertiaPayload(html);
  page.props.vacancyList.data = [page.props.vacancyList.data[0]];
  return inertiaHtml(page);
}

function listWithVacancy(fixtureName, id) {
  const page = inertiaPayload(fixture(fixtureName));
  const item = page.props.vacancyList.data.find((value) => String(value.entityId ?? value.id) === id);
  assert.ok(item, `expected fixture ${fixtureName} to contain vacancy ${id}`);
  page.props.vacancyList.data = [item];
  page.props.vacancyList.next_page_url = null;
  return inertiaHtml(page);
}

function inertiaPayload(html) {
  return JSON.parse(unescapeHtml(/data-page="([^"]+)"/i.exec(html)[1]));
}

function listHtml({ items, next }) {
  return inertiaHtml({ component: 'VacancyList/index', props: { vacancyList: { data: items, next_page_url: next } } });
}

function detailHtml(vacancy) {
  return inertiaHtml({ component: 'Vacancy/index', props: { vacancy, employerCompanyData: { name: vacancy.companyName } } });
}

function inertiaHtml(payload) {
  return `<html><body><div id="app" data-page="${JSON.stringify(payload).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></div></body></html>`;
}

function item(id, overrides = {}) {
  return {
    id: `opaque-${id}`,
    entityId: id,
    title: `Vacancy ${id}`,
    salaryFrom: 70000,
    salaryTo: 90000,
    experience: '1-3 года',
    employment: 'Полная занятость',
    scheduleList: ['Полный день'],
    cityName: 'Москва',
    about: `Short ${id}...`,
    humanizeCreatedAt: '4 октября 2026, 09:00',
    humanizeUpdatedAt: '4 октября 2026, 10:00',
    viewUrl: `/вакансии/москва/vacancy-${id}/${id}`,
    source: 'gderabota',
    companyData: { name: `Company ${id}` },
    ...overrides,
  };
}

function detailVacancy(id, overrides = {}) {
  return {
    id,
    entityId: id,
    title: `Vacancy ${id}`,
    salaryFrom: 70000,
    salaryTo: 90000,
    experience: '1-3 года',
    employment: 'Полная занятость',
    scheduleList: ['Полный день'],
    specializationList: ['Backend'],
    socialCategories: [],
    addressList: [{ localityName: 'Москва', provinceName: 'Москва', streetName: 'Тверская', house: '1' }],
    about: `<p>Full detail ${id}</p><ul><li>Build systems</li></ul>`,
    humanizeUpdatedAt: '4 октября 2026, 10:00',
    viewUrl: urlFor(id),
    source: 'gderabota',
    companyName: `Company ${id}`,
    ...overrides,
  };
}

function urlFor(id) {
  return `https://gderabota.ru/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8/%D0%BC%D0%BE%D1%81%D0%BA%D0%B2%D0%B0/vacancy-${id}/${id}`;
}

function unescapeHtml(value) {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
