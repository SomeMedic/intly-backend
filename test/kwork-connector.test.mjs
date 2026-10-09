import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { KworkConnector } = require('../src/modules/sources/connectors/kwork.connector.ts');

const listUrl = 'https://kwork.ru/projects';
const page2Url = 'https://kwork.ru/projects?page=2';
const page3Url = 'https://kwork.ru/projects?page=3';
const lower = '2026-09-05T19:30:00.000Z';
const upper = '2026-10-05T19:30:00.000Z';

function ctx(overrides = {}) {
  return {
    source: { _id: 'kwork', name: 'Kwork', connectorFamily: 'PublicHtml', endpoint: { baseUrl: listUrl }, timeoutMs: 1_000 },
    requestId: 'kwork-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: lower,
    ...overrides,
  };
}

function extractor(pages = {}) {
  return {
    requests: [],
    async extractUrl(url, options = {}) {
      this.requests.push({ url, options });
      const html = pages[url];
      if (!html) throw new Error(`fixture fetch failure: ${url}`);
      return { html, finalUrl: url, metadata: { firecrawl: false } };
    },
  };
}

function html(state) {
  return `<html><body><script>window.stateData=${JSON.stringify(state)};window.afterState=true;</script></body></html>`;
}

function state({ page = 1, last = 2, next = page === 1 ? 'http://kwork.ru/projects?page=2' : null, projects = [project(3263825)] } = {}) {
  return {
    wantsListData: {
      pagination: {
        current_page: page,
        data: projects,
        last_page: last,
        next_page_url: next,
        total: projects.length,
      },
    },
    categories: {
      11: {
        CATID: '11',
        name: 'Разработка и IT',
        cats: [{ CATID: '38', id: '38', name: 'Доработка и настройка сайта' }],
      },
      42: {
        CATID: '42',
        name: 'Бизнес и жизнь',
        cats: [{ CATID: '84', id: '84', name: 'Персональный помощник' }],
      },
    },
  };
}

function project(id, overrides = {}) {
  return {
    id,
    status: 'active',
    isWantActive: true,
    isWantArchive: false,
    category_id: '38',
    description: 'Здравствуйте! Нужно настроить доступ.<br>JSON marker: safe',
    files: [],
    kwork_count: 3,
    name: `Kwork project ${id}`,
    max_days: '10',
    priceLimit: '2000.00',
    possiblePriceLimit: 6000,
    user: { USERID: 25409872, username: 'client_name', data: { wants_count: '1' } },
    date_active: '2026-10-05 22:09:42',
    date_expire: '2026-10-06 22:09:42',
    date_create: '2026-10-05 22:07:07',
    views_dirty: '25',
    ...overrides,
  };
}

describe('Kwork native state public catalog collection', () => {
  it('extracts native fixture fields with full list description, budgets, files and Moscow timestamps', async () => {
    const fileUrl = 'https://kwork.ru/files/uploaded/81/96/b0/235ab68bd6/%D0%A2%D0%97.docx';
    const web = extractor({
      [listUrl]: html(state({
        projects: [project(3263825, {
          name: 'Настройка связки Tilda + Робокасса + Telegram под ключ',
          description: 'Здравствуйте! Мне нужно настроить выдачу доступа.&mdash; Проверить оплату',
          date_active: '2026-10-05 23:09:42',
          date_expire: '2026-10-06 23:09:42',
          date_create: '2026-10-05 23:07:07',
          files: [{ FID: 402734572, fname: 'ТЗ о вменяемом АП.docx', url: fileUrl }],
          kwork_count: 0,
        })],
      })),
    });

    const result = await new KworkConnector(web).fetchPage(ctx({ backfillSince: '2026-09-05T20:10:00.000Z' }));
    const record = result.records[0];

    assert.equal(result.stats.seen, 1);
    assert.equal(result.hasMore, true);
    assert.equal(result.nextPage, 2);
    assert.equal(result.checkpoint.nextUrl, page2Url);
    assert.deepEqual(web.requests[0].options.allowedHosts, ['kwork.ru']);
    assert.equal(web.requests[0].options.maxBytes, 2_000_000);
    assert.equal(record.externalId, '3263825');
    assert.equal(record.url, 'https://kwork.ru/projects/3263825/view');
    assert.equal(record.type, 'freelance');
    assert.equal(record.title, 'Настройка связки Tilda + Робокасса + Telegram под ключ');
    assert.match(record.description, /Проверить оплату/);
    assert.equal(record.companyOrClient, 'client_name');
    assert.equal(record.publishedAt.toISOString(), '2026-10-05T20:07:07.000Z');
    assert.equal(record.updatedAt.toISOString(), '2026-10-05T20:09:42.000Z');
    assert.equal(record.sourceStatus, 'Active');
    assert.deepEqual(record.sourceMetadata.budget, { max: 2000, currency: 'RUB', originalText: '2000.00', kind: 'desired-upper-bound' });
    assert.deepEqual(record.sourceMetadata.allowableBudget, { max: 6000, currency: 'RUB', originalText: '6000', kind: 'allowable-upper-bound' });
    assert.deepEqual(record.sourceMetadata.categoryTags, ['Разработка и IT', 'Доработка и настройка сайта']);
    assert.deepEqual(record.sourceMetadata.sourceDocuments, [{ label: 'ТЗ о вменяемом АП.docx', url: fileUrl }]);
    assert.equal(record.sourceMetadata.descriptionCoverage, 'list-native-full');
    assert.equal(record.sourceMetadata.dateTimezone, 'Europe/Moscow');
    assert.equal(record.rawPayload.listUrl, listUrl);
    assert.equal(record.rawPayload.project.id, 3263825);
    assert.equal(record.sourceMetadata.freelanceData.bids, 0);
    assert.deepEqual(record.sourceMetadata.freelanceData.attachments, [{ label: 'ТЗ о вменяемом АП.docx', url: fileUrl }]);
  });

  it('continues adjacent pagination with a frozen window, dedupes native IDs and does not stop on old creation dates', async () => {
    const web = extractor({
      [listUrl]: html(state({ page: 1, last: 3, next: 'http://kwork.ru/projects?page=2', projects: [project(1), project(2, { date_create: '2026-08-11 22:46:17', date_active: '2026-10-05 22:42:51' })] })),
      [page2Url]: html(state({ page: 2, last: 3, next: 'http://kwork.ru/projects?page=3', projects: [project(1), project(3)] })),
      [page3Url]: html(state({ page: 3, last: 3, next: null, projects: [project(4)] })),
    });
    const connector = new KworkConnector(web);

    const first = await connector.fetchPage(ctx());
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));
    const third = await connector.fetchPage(ctx({ checkpoint: second.checkpoint }));

    assert.deepEqual(first.records.map((record) => record.externalId), ['1']);
    assert.deepEqual(first.checkpoint.seenNativeIds, ['1', '2']);
    assert.equal(first.stats.seen, 2);
    assert.equal(first.checkpoint.windowSince, lower);
    assert.equal(first.checkpoint.windowUntil, upper);
    assert.deepEqual(second.records.map((record) => record.externalId), ['3']);
    assert.equal(second.checkpoint.windowUntil, upper);
    assert.deepEqual(third.records.map((record) => record.externalId), ['4']);
    assert.equal(third.hasMore, false);
    assert.equal(third.checkpoint.terminalReason, 'observed-pagination-exhausted');
    assert.deepEqual(third.checkpoint.visitedListUrls, [listUrl, page2Url, page3Url]);
    assert.deepEqual(web.requests.map((request) => request.url), [listUrl, page2Url, page3Url]);
  });

  it('accepts a legitimate empty terminal page without fabricating health success', async () => {
    const connector = new KworkConnector(extractor({
      [listUrl]: html(state({ page: 1, last: 1, next: null, projects: [] })),
    }));

    const page = await connector.fetchPage(ctx());
    const health = await connector.healthCheck(ctx());

    assert.deepEqual(page.records, []);
    assert.equal(page.stats.seen, 0);
    assert.equal(page.hasMore, false);
    assert.equal(page.checkpoint.terminalReason, 'observed-pagination-exhausted');
    assert.equal(health.state, 'Failed');
    assert.match(health.message, /0 public project cards/);
  });

  it('starts a fresh traversal after a terminal checkpoint instead of retaining old seen IDs', async () => {
    const terminalCheckpoint = {
      hasMore: false,
      visitedListUrls: [listUrl, page2Url],
      seenNativeIds: ['old-1', 'old-2'],
      terminalReason: 'observed-pagination-exhausted',
      windowSince: '2026-09-01T00:00:00.000Z',
      windowUntil: '2026-10-01T00:00:00.000Z',
    };
    const web = extractor({
      [listUrl]: html(state({ page: 1, last: 1, next: null, projects: [project(31)] })),
    });

    const result = await new KworkConnector(web).fetchPage(ctx({ checkpoint: terminalCheckpoint, backfillSince: lower }));

    assert.deepEqual(result.records.map((record) => record.externalId), ['31']);
    assert.deepEqual(result.checkpoint.visitedListUrls, [listUrl]);
    assert.deepEqual(result.checkpoint.seenNativeIds, ['31']);
    assert.equal(result.checkpoint.windowSince, lower);
    assert.notEqual(result.checkpoint.windowUntil, terminalCheckpoint.windowUntil);
  });

  it('rejects malformed state, IDs, dates, unsafe pages and auth walls instead of false success', async () => {
    await assert.rejects(
      () => new KworkConnector(extractor({ [listUrl]: '<html><body>login required</body></html>' })).fetchPage(ctx()),
      /does not expose window\.stateData/,
    );
    await assert.rejects(
      () => new KworkConnector(extractor({ [listUrl]: '<script>window.stateData={"wantsListData":</script>' })).fetchPage(ctx()),
      /not closed|not valid JSON/,
    );
    await assert.rejects(
      () => new KworkConnector(extractor({ [listUrl]: '<script>window.stateData=hydrate({"wantsListData":{"pagination":{"current_page":1,"data":[],"last_page":1}}})</script>' })).fetchPage(ctx()),
      /not an immediate JSON object/,
    );
    await assert.rejects(
      () => new KworkConnector(extractor({ [listUrl]: html(state({ projects: [project('bad')] })) })).fetchPage(ctx()),
      /invalid native ID/,
    );
    await assert.rejects(
      () => new KworkConnector(extractor({ [listUrl]: html(state({ projects: [project(9, { date_create: '05.10.2026' })] })) })).fetchPage(ctx()),
      /creation date is invalid/,
    );
    await assert.rejects(
      () => new KworkConnector(extractor({ [listUrl]: html(state({ projects: [project(10, { date_create: '2026-02-30 12:00:00' })] })) })).fetchPage(ctx()),
      /creation date is invalid/,
    );
    await assert.rejects(
      () => new KworkConnector(extractor({ [page2Url]: html(state({ page: 2, last: 2, projects: [project(2)] })) })).fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl: 'https://evil.example/projects?page=2', windowSince: lower, windowUntil: upper, visitedListUrls: [], seenNativeIds: [] } })),
      /invalid listing URL/,
    );
    await assert.rejects(
      () => new KworkConnector(extractor({ [page2Url]: html(state({ page: 2, last: 2, projects: [project(2)] })) })).fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl: 'https://kwork.ru:8443/projects?page=2', windowSince: lower, windowUntil: upper, visitedListUrls: [], seenNativeIds: [] } })),
      /invalid listing URL/,
    );
    await assert.rejects(
      () => new KworkConnector(extractor({ [listUrl]: html(state({ next: 'https://kwork.ru/projects?page=3' })) })).fetchPage(ctx()),
      /skipped or reversed/,
    );
    await assert.rejects(
      () => new KworkConnector(extractor({ [listUrl]: html(state({ next: 'https://kwork.ru/projects?foo=1' })) })).fetchPage(ctx()),
      /unsafe next page URL/,
    );
  });

  it('parses stateData as JSON without executing assignment-tail content', async () => {
    const injectedDescription = 'safe string with };globalThis.__KWORK_EXECUTED=true;// inside';
    const web = extractor({
      [listUrl]: html(state({ page: 1, last: 1, next: null, projects: [project(51, { description: injectedDescription })] })),
    });
    delete globalThis.__KWORK_EXECUTED;

    const result = await new KworkConnector(web).fetchPage(ctx());

    assert.equal(globalThis.__KWORK_EXECUTED, undefined);
    assert.equal(result.records[0].description, injectedDescription);
  });

  it('verifies native page identity and continues a valid page containing only duplicates', async () => {
    const web = extractor({
      [listUrl]: html(state({ last: 3, projects: [project(61)] })),
      [page2Url]: html(state({ page: 2, last: 3, next: 'http://kwork.ru/projects?page=3', projects: [project(61)] })),
    });
    const connector = new KworkConnector(web);
    const first = await connector.fetchPage(ctx());
    const duplicatePage = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));
    assert.deepEqual(duplicatePage.records, []);
    assert.equal(duplicatePage.hasMore, true);
    assert.equal(duplicatePage.nextPage, 3);
    web.extractUrl = async url => ({ finalUrl: url, html: html(state({ page: 1, last: 3, projects: [project(62)] })) });
    await assert.rejects(() => connector.fetchPage(ctx({ checkpoint: first.checkpoint })), /native page number/);
    await assert.rejects(() => new KworkConnector(extractor({ [listUrl]: html(state({ last: 3, next: null })) })).fetchPage(ctx()), /missing the next page/);
  });

  it('reports health as healthy only when native project data is present', async () => {
    const healthy = await new KworkConnector(extractor({ [listUrl]: html(state()) })).healthCheck(ctx());
    const failed = await new KworkConnector(extractor({ [listUrl]: html({ wantsListData: { pagination: { current_page: 1, data: [], last_page: 1, next_page_url: null } } }) })).healthCheck(ctx());
    const wrongPage = await new KworkConnector(extractor({ [listUrl]: html(state({ page: 2, last: 2, projects: [project(2)] })) })).healthCheck(ctx());
    const invalidProject = await new KworkConnector(extractor({ [listUrl]: html(state({ projects: [project(3, { name: '' })] })) })).healthCheck(ctx());

    assert.equal(healthy.state, 'Healthy');
    assert.equal(healthy.details.cards, 1);
    assert.equal(failed.state, 'Failed');
    assert.equal(wrongPage.state, 'Failed');
    assert.match(wrongPage.message, /first public project page|native page number/);
    assert.equal(invalidProject.state, 'Failed');
    assert.match(invalidProject.message, /no public title/);
  });
});
