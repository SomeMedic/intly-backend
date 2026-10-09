import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { WebExtractionHttpError } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const { B2bCenterConnector, parseB2bCenterNativeSearch, parseB2bCenterDetail } = require('../src/modules/sources/connectors/b2b-center.connector.ts');

const fixture = (name) => readFileSync(new URL(`./fixtures/b2b-center-native/${name}`, import.meta.url), 'utf8');
const buyPage1 = fixture('api-search-buy-all-page-1.json');
const buyPage2 = fixture('api-search-buy-all-page-2.json');
const sellPage1 = fixture('api-search-sell-all-page-1.json');
const detail4630191 = fixture('detail-4630191.html');
const origin = 'https://www.b2b-center.ru';
const source = { _id: 'b2b-center', name: 'B2B-Center', endpoint: { baseUrl: `${origin}/site/api/v1/market-search/` }, config: {}, timeoutMs: 20_000 };
const retainedListUrl = `${origin}/site/api/v1/market-search/?date_start_dmy=06.09.2026&date_end_dmy=06.10.2026&macro_trade_type=buy&tab=all&sort=date_desc&page=1&page_size=20&is_seo=0`;
const retainedDetailUrl = `${origin}/app/market-next/postavka-bumazhnykh-paketov-dlia-khleba-ts-perekrestok/tender-4630191/`;

function retainedB2bPayload() {
  const nativeTrade = JSON.parse(buyPage1).trades[0];
  return {
    rawPayload: {
      native: {
        url: retainedListUrl,
        trade: nativeTrade,
        publishedText: nativeTrade.date_published,
        deadlineText: nativeTrade.date_actual,
        detailUrl: retainedDetailUrl,
      },
      detail: {
        url: retainedDetailUrl,
        rows: {},
        title: 'Объявление о продаже № 4630191 Зарегистрируйтесь, чтобы сохранять процедуры в Избранное',
        description: 'Retained public detail description',
        documents: [],
        htmlHash: 'retained-html-hash',
        publicAccessGap: 'some detail fields are visible only to registered users',
      },
    },
    sourceMetadata: {
      sourceUrl: retainedListUrl,
      macroTradeType: 'buy',
      nativeKey: '4630191:4630191458',
      windowSince: '2026-09-06T20:08:23.981Z',
      windowUntil: '2026-10-06T20:08:23.981Z',
    },
  };
}

function fixed(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T19:30:00.000Z') });
}

function ctx(overrides = {}) {
  return { source, checkpoint: {}, backfillDays: 30, requestId: 'b2b-center-test', ...overrides };
}

class FakeExtraction {
  constructor(detailHtml) { this.detailHtml = detailHtml; this.calls = []; }
  async extractUrl(url, options) {
    this.calls.push({ url, options });
    options.signal?.throwIfAborted();
    if (url.includes('/tender-4630191/')) return { finalUrl: `${origin}/app/market-next/postavka-bumazhnykh-paketov-dlia-khleba-ts-perekrestok/tender-4630191/`, html: this.detailHtml, metadata: { firecrawl: false } };
    throw new WebExtractionHttpError(404, url);
  }
}

function nativeFixtures(sequence) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      options.signal?.throwIfAborted();
      const parsed = new URL(url);
      const macro = parsed.searchParams.get('macro_trade_type');
      const page = parsed.searchParams.get('page');
      const key = `${macro}:${page}`;
      if (!(key in sequence)) throw new Error(`Unexpected native URL ${url}`);
      return { status: 200, finalUrl: url, contentType: 'application/json; charset=utf-8', text: sequence[key] };
    },
  };
}

describe('B2B-Center anonymous native connector', () => {
  it('parses actual native buy/sell JSON and fresh app-next detail evidence', () => {
    const buy = parseB2bCenterNativeSearch(buyPage1, { macroTradeType: 'buy', page: 1, pageSize: 20, sort: 'date_desc', url: `${origin}/site/api/v1/market-search/` });
    assert.equal(buy.cards.length, 20);
    assert.equal(buy.pageCount, 2000);
    assert.equal(buy.tabs.find((tab) => tab.type === 'actual').count, 6434);
    assert.equal(buy.tabs.find((tab) => tab.type === 'all').count, 2284145);
    assert.equal(buy.cards[0].id, '4630191');
    assert.equal(buy.cards[0].nativeKey, '4630191:4630191458');
    assert.equal(buy.cards[0].title, 'Поставка пакетов для хлеба ТС «Перекресток».');
    assert.equal(buy.cards[0].companyOrClient, 'ПАО "КОРПОРАТИВНЫЙ ЦЕНТР ИКС 5"');
    assert.equal(buy.cards[0].publishedAt.toISOString(), '2026-10-06T18:59:00.000Z');
    assert.equal(buy.cards[0].deadlineAt.toISOString(), '2026-10-12T09:00:00.000Z');
    assert.equal(buy.cards[0].priceText, 'Без указания цены');
    assert.equal(buy.cards[0].region, 'г. Москва');

    const sell = parseB2bCenterNativeSearch(sellPage1, { macroTradeType: 'sell', page: 1, pageSize: 20, sort: 'date_desc', url: `${origin}/site/api/v1/market-search/` });
    assert.equal(sell.cards.length, 20);
    assert.equal(sell.pageCount, 145);
    assert.equal(sell.tabs.find((tab) => tab.type === 'actual').count, 1290);
    assert.equal(sell.cards[0].id, '4630194');
    assert.equal(sell.cards[0].macroTradeType, 'sell');
    assert.equal(sell.cards[0].priceText, '73 183,22 ₽');

    const detail = parseB2bCenterDetail(detail4630191, `${origin}/app/market-next/postavka-bumazhnykh-paketov-dlia-khleba-ts-perekrestok/tender-4630191/`, '4630191');
    assert.equal(detail.title, 'Поставка бумажных пакетов для хлеба ТС «Перекресток».');
    assert.equal(detail.documents.length, 0);
    assert.equal(detail.publicAccessGap, 'some detail fields are visible only to registered users');
  });

  it('fetches proven buy and sell first pages, marks guest pagination bounded incomplete, and keeps public native fields', async t => {
    fixed(t);
    const native = nativeFixtures({ 'buy:1': buyPage1, 'sell:1': sellPage1 });
    const extraction = new FakeExtraction(detail4630191);
    const result = await new B2bCenterConnector(extraction, native.fetch).fetchPage(ctx());

    assert.equal(result.records.length, 40);
    assert.equal(result.hasMore, false);
    assert.equal(result.nextPage, undefined);
    assert.equal(result.checkpoint.parserVersion, 'b2b-center-native-public-v1');
    assert.equal(result.checkpoint.dateStartDmy, '06.09.2026');
    assert.equal(result.checkpoint.dateEndDmy, '06.10.2026');
    assert.equal(result.checkpoint.macroTradeType, undefined);
    assert.equal(result.checkpoint.incomplete, true);
    assert.equal(result.checkpoint.terminalReason, 'native-anonymous-pagination-boundary');
    assert.match(result.checkpoint.completenessLimit, /mode=guest/);
    assert.match(result.checkpoint.completenessLimit, /public UI disables pagination controls/);
    assert.equal(result.checkpoint.publicAccess, 'registration-required-for-full-catalog');
    assert.equal(result.checkpoint.fullCatalogRequiresCredentials, true);
    assert.deepEqual(result.checkpoint.completedMacroTradeTypes, ['buy', 'sell']);
    assert.equal(result.checkpoint.activePublicCount, 6434);
    assert.equal(result.checkpoint.sellActivePublicCount, 1290);

    assert.equal(native.calls.length, 2);
    assert.equal(new URL(native.calls[0].url).pathname, '/site/api/v1/market-search/');
    assert.equal(new URL(native.calls[0].url).searchParams.get('macro_trade_type'), 'buy');
    assert.equal(new URL(native.calls[1].url).searchParams.get('macro_trade_type'), 'sell');
    assert.equal(new URL(native.calls[0].url).searchParams.get('date_start_dmy'), '06.09.2026');
    assert.equal(new URL(native.calls[0].url).searchParams.get('tab'), 'all');
    assert.equal(new URL(native.calls[0].url).searchParams.get('page_size'), '20');

    const buyRecord = result.records.find((record) => record.externalId === '4630191:4630191458');
    assert.ok(buyRecord);
    assert.equal(buyRecord.type, 'tender');
    assert.equal(buyRecord.url, `${origin}/app/market-next/postavka-bumazhnykh-paketov-dlia-khleba-ts-perekrestok/tender-4630191/`);
    assert.equal(buyRecord.title, 'Поставка бумажных пакетов для хлеба ТС «Перекресток».');
    assert.equal(buyRecord.companyOrClient, 'ПАО "КОРПОРАТИВНЫЙ ЦЕНТР ИКС 5"');
    assert.equal(buyRecord.sourceStatus, 'Active');
    assert.equal(buyRecord.publishedAt.toISOString(), '2026-10-06T18:59:00.000Z');
    assert.equal(buyRecord.sourceMetadata.deadlineAt, '2026-10-12T09:00:00.000Z');
    assert.equal(buyRecord.sourceMetadata.budget.kind, 'unpublished-lot-price');
    assert.equal(buyRecord.sourceMetadata.budget.currency, undefined);
    assert.equal(buyRecord.sourceMetadata.tenderData.macroTradeType, 'buy');
    assert.equal(buyRecord.sourceMetadata.tenderData.sphinxId, '4630191458');
    assert.equal(buyRecord.sourceMetadata.location, 'г. Москва');
    assert.equal(buyRecord.sourceMetadata.detailAvailability, 'verified-public-html');

    const sellRecord = result.records.find((record) => record.externalId === '4630194:4630194003');
    assert.ok(sellRecord);
    assert.equal(sellRecord.sourceMetadata.tenderData.macroTradeType, 'sell');
    assert.equal(sellRecord.sourceMetadata.budget.amount, 73183.22);
    assert.equal(sellRecord.sourceMetadata.budget.currency, 'RUB');
  });


  it('maps retained native payload without network and cleans legacy registration title contamination', () => {
    const { rawPayload, sourceMetadata } = retainedB2bPayload();
    const before = structuredClone(rawPayload);
    const mapped = new B2bCenterConnector(new FakeExtraction(detail4630191)).mapRetainedPayload(rawPayload, sourceMetadata);

    assert.equal(mapped.externalId, '4630191:4630191458');
    assert.equal(mapped.url, retainedDetailUrl);
    assert.equal(mapped.title, 'Поставка пакетов для хлеба ТС «Перекресток».');
    assert.equal(mapped.description.includes('Retained public detail description'), true);
    assert.equal(mapped.title.includes('Зарегистрируйтесь'), false);
    assert.deepEqual(mapped.rawPayload, before);
    assert.equal(mapped.sourceMetadata.windowSince, '2026-09-06T20:08:23.981Z');
    assert.equal(mapped.sourceMetadata.windowUntil, '2026-10-06T20:08:23.981Z');
    assert.equal(mapped.sourceMetadata.tenderData.macroTradeType, 'buy');
    assert.equal(mapped.sourceMetadata.tenderData.nativeKey, '4630191:4630191458');
  });


  it('falls back to native card title for retained favorite-only control titles', () => {
    const retained = retainedB2bPayload();
    retained.rawPayload.detail.title = 'чтобы сохранять процедуры в Избранное Поставка трубной продукции ООО КС ГОК';

    const mapped = new B2bCenterConnector(new FakeExtraction(detail4630191)).mapRetainedPayload(retained.rawPayload, retained.sourceMetadata);

    assert.equal(mapped.title, 'Поставка пакетов для хлеба ТС «Перекресток».');
    assert.equal(mapped.description.includes('Retained public detail description'), true);
    assert.deepEqual(mapped.rawPayload, retained.rawPayload);
  });

  it('rejects retained native identity and URL mismatches', () => {
    const connector = new B2bCenterConnector(new FakeExtraction(detail4630191));
    const retained = retainedB2bPayload();

    assert.throws(
      () => connector.mapRetainedPayload(retained.rawPayload, { ...retained.sourceMetadata, nativeKey: 'other' }),
      /native key does not match/,
    );

    const urlMismatch = retainedB2bPayload();
    urlMismatch.rawPayload.native.detailUrl = `${origin}/app/market-next/other/tender-4630192/`;
    assert.throws(
      () => connector.mapRetainedPayload(urlMismatch.rawPayload, urlMismatch.sourceMetadata),
      /detail URL does not match/,
    );
  });

  it('closes a legacy repeated anonymous page as access-limited instead of falsely exhausting pagination', async t => {
    fixed(t);
    const native = nativeFixtures({ 'buy:2': buyPage2 });
    const checkpoint = {
      parserVersion: 'b2b-center-native-public-v1',
      hasMore: true,
      page: 2,
      macroIndex: 0,
      macroTradeType: 'buy',
      windowSince: '2026-09-06T19:30:00.000Z',
      windowUntil: '2026-10-06T19:30:00.000Z',
      dateStartDmy: '06.09.2026',
      dateEndDmy: '06.10.2026',
      seenNativeIds: parseB2bCenterNativeSearch(buyPage1, { macroTradeType: 'buy', page: 1, pageSize: 20, sort: 'date_desc', url: `${origin}/site/api/v1/market-search/` }).cards.map((card) => card.nativeKey),
      visitedNativePages: [],
      completedMacroTradeTypes: [],
    };
    const result = await new B2bCenterConnector(new FakeExtraction(detail4630191), native.fetch).fetchPage(ctx({ checkpoint }));
    assert.equal(result.records.length, 0);
    assert.equal(result.hasMore, false);
    assert.equal(result.checkpoint.incomplete, true);
    assert.equal(result.checkpoint.terminalReason, 'native-anonymous-pagination-boundary');
    assert.equal(result.checkpoint.publicAccess, 'registration-required-for-full-catalog');
    assert.equal(result.checkpoint.fullCatalogRequiresCredentials, true);
    assert.deepEqual(result.checkpoint.completedMacroTradeTypes, ['buy', 'sell']);
  });
});


it('B2B-Center delayed first execution preserves the original30-day publication window', () => {
  const instance = new B2bCenterConnector({});
  const since = new Date(Date.now() - 31 * 86400000).toISOString();
  const bounds = instance.collectionWindow({ backfillSince: since, backfillDays: 30 }, false, {});
  assert.equal(bounds.sinceIso, since);
  assert.equal(Date.parse(bounds.untilIso) - Date.parse(since), 30 * 86400000);
});


it('B2B-Center accepts attested plural sell detail routes while rejecting another trade ID', () => {
  const url = `${origin}/market/sell-catalog/tenders-4630191/`;
  const detail = parseB2bCenterDetail(detail4630191, url, '4630191');
  assert.ok(detail.title);
  assert.throws(() => parseB2bCenterDetail(detail4630191, url, '4630192'), /identity differs/);
});

it('B2B-Center legacy sell headings retain the procedure title without registration controls', () => {
  const html='<h1>Объявление о продаже № 4630097 <span class="favorite-container"><button class="favorite-button"><span>Зарегистрируйтесь, чтобы сохранять процедуры в Избранное</span></button></span><div class="s2">Запасные части LIEBHERR</div></h1>';
  const detail=parseB2bCenterDetail(html,`${origin}/market/zapasnye-chasti-liebherr/tender-4630097/`,'4630097');
  assert.equal(detail.title,'Запасные части LIEBHERR');
});
