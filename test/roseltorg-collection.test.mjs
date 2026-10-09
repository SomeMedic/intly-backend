import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { load } = require('cheerio');
const { RoseltorgConnector } = require('../src/modules/sources/connectors/roseltorg.connector.ts');
const { WebExtractionHttpError } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'roseltorg-native');
const fixture = name => readFileSync(join(fixtures, name), 'utf8');
const origin = 'https://www.roseltorg.ru';
const since = '2026-09-05T10:00:00.000Z';
const until = '2026-10-05T10:00:00.000Z';
const statuses = ['5', '0', '1', '2', '3', '4'];
const retainedDetails = new Map(['32616434303', '0351300051326000203', 'RT05102600001', '32616434268', 'B0509261353325'].map(id => [`${id}:1`, fixture(`detail-${id}-1.html`)]));

function connectorFor(extraction, clock) {
  let elapsed = 0;
  return new RoseltorgConnector(extraction, clock ?? { now: () => elapsed, async wait(ms, signal) { signal?.throwIfAborted(); elapsed += ms; } });
}

function ctx(overrides = {}) {
  return {
    source: { _id: 'roseltorg', name: 'Росэлторг', endpoint: { baseUrl: origin }, config: {}, timeoutMs: 30_000 },
    checkpoint: {}, backfillDays: 31, backfillSince: since, requestId: 'roseltorg-native-test', ...overrides,
  };
}

function fixedClock(t, now = '2026-10-06T00:00:00.000Z') {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
}

function listUrl(page, lower = '05.09.26', upper = '05.10.26') {
  const url = new URL('/procedures/search_ajax', origin);
  for (const [key, value] of [['sale', '1'], ['currency', 'all'], ['start_date_published', lower], ['end_date_published', upper]]) url.searchParams.set(key, value);
  statuses.forEach(value => url.searchParams.append('status[]', value));
  url.searchParams.set('page', String(page));
  return url.toString();
}

function card(id) {
  const [procedure, lot] = id.split(':');
  return `<div class="search-results__item" data-feature-favorite-lots-procedure-number="${procedure}" data-feature-favorite-lots-lot-number="${lot}"><a class="search-results__link--description" href="/procedure/${procedure}/${lot}">Native lot ${id}</a><div class="search-results__section">Коммерческие закупки</div><div class="search-results__region">Москва</div><div class="search-results__status">Прием заявок</div></div>`;
}

function list(ids, next) {
  return `${ids.map(card).join('')} ${next ? `<button class="pagination__btn--next" rel="next" data-href="${next}">Следующая</button>` : ''}`;
}

function nativeCards(html) {
  const $ = load(html);
  return $('.search-results__item').map((_, node) => ({
    id: `${$(node).attr('data-feature-favorite-lots-procedure-number')}:${$(node).attr('data-feature-favorite-lots-lot-number')}`,
    html: $.html(node),
  })).get();
}

function selectedNativeList(entries, next) {
  return entries.map(item => item.html).join('') + (next ? `<button class="pagination__btn--next" rel="next" data-href="${next}">Следующая</button>` : '');
}

function detail(id, options = {}) {
  const [procedure, lot] = id.split(':');
  const published = options.published === undefined ? '2026-10-05T08:00:00+03:00' : options.published;
  const url = `${origin}/procedure/${procedure}/${lot}`;
  const product = { '@type': 'Product', sku: procedure, url, offers: { ...(published ? { validFrom: published } : {}), validThrough: '2026-10-14T11:00:00+03:00', price: '999999', priceCurrency: 'RUB' } };
  return `<html><head><link rel="canonical" href="${options.canonical ?? url}"><script type="application/ld+json">${JSON.stringify(product)}</script></head><body><div class="lot-page__left-column-lot" data-feature-favorite-lots="lot" data-feature-favorite-lots-procedure-number="${procedure}" data-feature-favorite-lots-lot-number="${lot}"><div class="lot-title"><h1>Полное название лота ${id}</h1></div><div class="lot-status">${options.status ?? 'Прием заявок'}</div><div class="lot-additional-info"><div class="lot-expand-text__text"><p>Публичные технические требования</p><p>Поставка по техническому заданию</p></div></div><div class="lot-common-info__row"><span class="lot-common-info__text">Приём заявок</span><span class="lot-common-info__value">до 14.10.26 11:00 (МСК)</span></div>${options.localPublished ? `<div class="lot-common-info__row"><span class="lot-common-info__text">Публикация извещения</span><span class="lot-common-info__value">${options.localPublished}</span></div>` : ''}<div class="lot-price">${options.price ?? '100 000,00 ₽ без НДС'}</div><div class="lot-units__item">Код ОКПД2 27.12.40, Количество: 20, Цена единицы: <span class="lot-unit__price">5 000,00 ₽</span></div><div class="customer-item"><span class="customer-name">Нативный заказчик</span><span class="customer-inn">ИНН 7700000000</span></div>${options.extra ?? ''}</div></body></html>`;
}

function occurrenceFrom(record) {
  return { sourceId: 'roseltorg', externalId: record.externalId, url: record.url, publishedAt: record.publishedAt, status: record.sourceStatus, rawPayload: record.rawPayload, sourceMetadata: record.sourceMetadata };
}

async function hydroOccurrence() {
  const selected = nativeCards(fixture('list-page-0.html')).filter(item => item.id === '32616434303:1');
  const extraction = new FakeExtraction({ 0: selectedNativeList(selected) });
  const { records: [record] } = await connectorFor(extraction).fetchPage(ctx());
  return occurrenceFrom(record);
}

function alterHtml(html, fn) { const $ = load(html); fn($); return $.html(); }

function alterProduct($, fn) {
  $('script[type="application/ld+json"]').each((_, node) => {
    const product = JSON.parse($(node).text());
    if (product['@type'] === 'Product') { fn(product); $(node).text(JSON.stringify(product)); }
  });
}

class FakeExtraction {
  constructor(pages, details = retainedDetails) { this.pages = pages; this.details = details; this.calls = []; }
  async extractUrl(url, options) {
    this.calls.push({ url, options });
    options.signal?.throwIfAborted();
    if (this.onRequest) await this.onRequest(url, options);
    options.signal?.throwIfAborted();
    const parsed = new URL(url);
    if (parsed.pathname === '/procedures/search_ajax') {
      const page = Number(parsed.searchParams.get('page'));
      const response = this.pages[page];
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error(`Unexpected listing ${url}`);
      return typeof response === 'string' ? { finalUrl: url, html: response, metadata: {} } : response;
    }
    const match = /^\/procedure\/([A-Za-z0-9]+)\/(\d+)$/.exec(parsed.pathname);
    assert.ok(match, `Only native lot detail GETs are allowed: ${url}`);
    const id = `${match[1]}:${match[2]}`;
    const response = this.details.get(id) ?? detail(id);
    if (response instanceof Error) throw response;
    return typeof response === 'string' ? { finalUrl: url, html: response, metadata: {} } : response;
  }
}

describe('Roseltorg anonymous native procurement collection', () => {
  it('collects retained native AJAX pages with all statuses, freezes exactly 30 days, and stops on native empty results', async t => {
    fixedClock(t);
    const extraction = new FakeExtraction({ 0: fixture('list-page-0.html'), 1: fixture('list-page-1.html'), 2: fixture('empty-native.html') });
    const connector = connectorFor(extraction);
    const first = await connector.fetchPage(ctx());
    assert.equal(first.records.length, 10);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextPage, 1);
    assert.equal(first.checkpoint.windowSince, since);
    assert.equal(first.checkpoint.windowUntil, until);
    assert.equal(Date.parse(until) - Date.parse(since), 30 * 86_400_000);
    assert.equal(first.checkpoint.wireSince, '05.09.26');
    assert.equal(first.checkpoint.wireUntil, '05.10.26');
    t.mock.timers.setTime(Date.parse('2026-10-20T00:00:00Z'));
    const second = await connector.fetchPage(ctx({ checkpoint: connector.checkpoint(first) }));
    assert.equal(second.records.length, 10);
    assert.equal(second.nextPage, 2);
    assert.equal(second.checkpoint.windowUntil, until);
    const last = await connector.fetchPage(ctx({ checkpoint: second.checkpoint }));
    assert.deepEqual(last.records, []);
    assert.equal(last.hasMore, false);
    assert.equal(last.checkpoint.terminalReason, 'native-empty-result');
    assert.equal(last.checkpoint.seenNativeIds.length, 20);
    for (const { url, options } of extraction.calls) {
      assert.equal(options.ajaxHtmlField, undefined, 'native AJAX returns HTML rather than JSON');
      assert.deepEqual(options.allowedHosts, ['www.roseltorg.ru']);
      assert.equal(options.maxBytes, 2_000_000);
      if (new URL(url).pathname === '/procedures/search_ajax') {
        assert.deepEqual(new URL(url).searchParams.getAll('status[]'), statuses);
        assert.equal(new URL(url).searchParams.get('currency'), 'all');
        assert.equal(new URL(url).searchParams.get('start_date_published'), '05.09.26');
        assert.equal(new URL(url).searchParams.has('source[]'), false, 'all public sections remain in scope');
      }
    }
  });

  it('preserves real complete detail facts, total lot budget, native file labels, and Moscow datetimes', async t => {
    fixedClock(t);
    const selected = nativeCards(fixture('list-page-0.html')).filter(item => ['32616434303:1', '0351300051326000203:1', 'RT05102600001:1'].includes(item.id));
    const extraction = new FakeExtraction({ 0: selectedNativeList(selected) });
    const result = await connectorFor(extraction).fetchPage(ctx());
    const hydro = result.records.find(record => record.externalId === '32616434303:1');
    const medical = result.records.find(record => record.externalId === '0351300051326000203:1');
    const rfi = result.records.find(record => record.externalId === 'RT05102600001:1');
    assert.equal(hydro.publishedAt.toISOString(), '2026-10-04T21:00:00.000Z');
    assert.equal(hydro.sourceMetadata.deadlineAt, '2026-10-21T07:00:00.000Z');
    assert.equal(hydro.sourceMetadata.budget.amount, 137_100_000);
    assert.equal(hydro.sourceMetadata.budget.currency, 'RUB');
    assert.match(hydro.sourceMetadata.budget.originalText, /без НДС/);
    assert.equal(hydro.sourceMetadata.tenderData.taxText, 'без НДС');
    assert.equal(hydro.sourceMetadata.tenderData.customer, 'ПАО "САХАЛИНЭНЕРГО"');
    assert.equal(hydro.sourceMetadata.tenderData.customerInn, '6500000024');
    assert.equal(hydro.sourceMetadata.tenderData.organizer, 'АКЦИОНЕРНОЕ ОБЩЕСТВО "РУСГИДРО СНАБЖЕНИЕ"');
    assert.equal(hydro.sourceMetadata.tenderData.platform, 'Группа «РусГидро»');
    assert.equal(hydro.sourceMetadata.tenderData.contractNumber, '32616434303');
    assert.ok(hydro.sourceMetadata.tenderData.procurementMethod);
    assert.ok(hydro.sourceMetadata.tenderData.region);
    assert.match(hydro.description, /Объекты закупки:/);
    assert.match(hydro.description, /Приложение №1 - ТЕХНИЧЕСКИЕ ТРЕБОВАНИЯ/);
    assert.equal(hydro.rawPayload.detail.title, hydro.title);
    assert.equal(hydro.rawPayload.detail.description, hydro.description);
    assert.equal(hydro.rawPayload.detail.customer, hydro.companyOrClient);
    assert.equal(hydro.rawPayload.detail.publishedAt, hydro.publishedAt.toISOString());
    assert.equal(hydro.rawPayload.detail.html, retainedDetails.get(hydro.externalId));
    assert.equal(hydro.rawPayload.list.url, listUrl(0));
    assert.equal(hydro.rawPayload.list.detailUrl, hydro.url);
    assert.equal(hydro.sourceMetadata.sourceDocuments[0].label, 'Приложение №1 - ТЕХНИЧЕСКИЕ ТРЕБОВАНИЯ.rar');
    assert.match(hydro.sourceMetadata.sourceDocuments[0].url, /^https:\/\/rushydro\.roseltorg\.ru\/file\/get\//);
    assert.equal(medical.sourceMetadata.budget.amount, 350_000);
    assert.equal(medical.publishedAt.toISOString(), '2026-10-05T02:12:00.000Z');
    assert.equal(medical.sourceMetadata.deadlineAt, '2026-10-13T01:00:00.000Z');
    assert.match(medical.sourceMetadata.sourceDocuments[0].url, /^https:\/\/zakupki\.gov\.ru\/44fz\/filestore\//);
    assert.equal(rfi.sourceMetadata.budget.amount, 0);
    assert.equal(rfi.sourceMetadata.budget.kind, 'published-zero-lot-price');
    assert.match(rfi.sourceMetadata.sourceDocuments[0].label, /Документация_RFI/);
    assert.ok(rfi.description.length > rfi.title.length);
    assert.equal(extraction.calls.length, 4, 'document links are recorded without downloading files');
    assert.equal(hydro.sourceStatus, 'Active');
    assert.equal(hydro.sourceMetadata.eligibility, undefined);
  });

  it('keeps a native unspecified budget unknown despite JSON-LD zero and ignores unit price', async t => {
    fixedClock(t);
    const missing = nativeCards(fixture('control-no-xhr.html')).filter(item => item.id === 'B0509261353325:1');
    assert.equal(missing.length, 1);
    const extraction = new FakeExtraction({ 0: selectedNativeList(missing) });
    const { records: [record] } = await connectorFor(extraction).fetchPage(ctx());
    assert.equal(record.publishedAt.toISOString(), '2026-09-05T10:53:00.000Z');
    assert.equal(record.sourceMetadata.budget.amount, undefined);
    assert.equal(record.sourceMetadata.budget.kind, 'unpublished-lot-price');
    assert.equal(record.sourceMetadata.budget.originalText, 'НМЦ не указано');
    assert.equal(record.rawPayload.detail.schemaPrice, '0.00');
    assert.equal(record.sourceStatus, 'Closed');
    const synthetic = new FakeExtraction({ 0: list(['TOTAL:1']) });
    const { records: [total] } = await connectorFor(synthetic).fetchPage(ctx());
    assert.equal(total.sourceMetadata.budget.amount, 100_000);
    assert.match(total.sourceMetadata.tenderData.requirementsText, /Цена единицы: 5 000,00/);
  });

  it('filters exact instants within broad Moscow calendar days, retains unknown dates, and continues after older entries', async t => {
    fixedClock(t);
    const ids = ['OLD:1', 'BEFORE:1', 'LOWER:1', 'UPPER:1', 'AFTER:1', 'UNKNOWN:1', 'LOCAL:1'];
    const times = ['2026-08-20T12:00:00+03:00', '2026-09-05T12:59:59+03:00', '2026-09-05T13:00:00+03:00', '2026-10-05T13:00:00+03:00', '2026-10-05T13:00:01+03:00', null, null];
    const details = new Map(ids.map((id, index) => [id, detail(id, { published: times[index], ...(id === 'LOCAL:1' ? { localPublished: '05.09.26 13:00 (МСК)' } : {}) })]));
    const extraction = new FakeExtraction({ 0: list(ids, listUrl(1)), 1: list(['LATER:1']) }, details);
    const connector = connectorFor(extraction);
    const first = await connector.fetchPage(ctx());
    assert.deepEqual(first.records.map(record => record.externalId), ['LOWER:1', 'UPPER:1', 'UNKNOWN:1', 'LOCAL:1']);
    assert.equal(first.stats.seen, 7);
    assert.equal(first.hasMore, true);
    assert.equal(first.records.find(record => record.externalId === 'UNKNOWN:1').sourceMetadata.dateUnknown, true);
    assert.equal(first.records.find(record => record.externalId === 'LOCAL:1').publishedAt.toISOString(), since);
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));
    assert.deepEqual(second.records.map(record => record.externalId), ['LATER:1']);
    assert.equal(second.checkpoint.terminalReason, 'observed-pagination-exhausted');
  });

  it('keeps lots distinct, tolerates partial overlap, and rejects an all-ID repeated terminal page', async t => {
    fixedClock(t);
    const extraction = new FakeExtraction({ 0: list(['PROC:1', 'PROC:2'], listUrl(1)), 1: list(['PROC:2', 'FRESH:1'], listUrl(2)), 2: list(['PROC:1', 'FRESH:1']) });
    const connector = connectorFor(extraction);
    const first = await connector.fetchPage(ctx());
    assert.deepEqual(first.records.map(record => record.externalId), ['PROC:1', 'PROC:2']);
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));
    assert.deepEqual(second.records.map(record => record.externalId), ['FRESH:1']);
    assert.equal(second.stats.seen, 2);
    await assert.rejects(connector.fetchPage(ctx({ checkpoint: second.checkpoint })), /repeats all previously seen native lot IDs/);
    assert.equal(extraction.calls.filter(call => call.url === `${origin}/procedure/PROC/2`).length, 1);
  });

  it('advances through retained native all-known pages before collecting a later fresh lot', async t => {
    fixedClock(t);
    const firstHtml = fixture('list-overlap-page-396-20261005.html');
    const secondHtml = fixture('list-overlap-page-397-20261005.html');
    const priorIds = [...new Set([...nativeCards(firstHtml), ...nativeCards(secondHtml)].map(card => card.id))];
    const extraction = new FakeExtraction({ 396: firstHtml, 397: secondHtml, 398: list(['AFTEROVERLAP:1']) });
    const connector = connectorFor(extraction);
    const checkpoint = { collectionVersion: 1, hasMore: true, nextUrl: listUrl(396), nextPage: 396, windowSince: since, windowUntil: until, wireSince: '05.09.26', wireUntil: '05.10.26', seenNativeIds: priorIds, visitedListUrls: [listUrl(395)] };
    const first = await connector.fetchPage(ctx({ checkpoint }));
    assert.deepEqual(first.records, []);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextPage, 397);
    assert.equal(first.checkpoint.currentPageVerified, true);
    assert.equal(first.checkpoint.deduplicated, 10);
    assert.deepEqual(first.checkpoint.seenNativeIds, priorIds);
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));
    assert.deepEqual(second.records, []);
    assert.equal(second.hasMore, true);
    assert.equal(second.nextPage, 398);
    const final = await connector.fetchPage(ctx({ checkpoint: second.checkpoint }));
    assert.deepEqual(final.records.map(record => record.externalId), ['AFTEROVERLAP:1']);
    assert.equal(final.hasMore, false);
    assert.equal(final.checkpoint.terminalReason, 'observed-pagination-exhausted');
    assert.deepEqual(extraction.calls.filter(call => call.url.includes('/procedure/')).map(call => call.url), [`${origin}/procedure/AFTEROVERLAP/1`]);
    assert.deepEqual(final.checkpoint.visitedListUrls, [395, 396, 397, 398].map(page => listUrl(page)));
    assert.equal(final.checkpoint.windowSince, since);
    assert.equal(final.checkpoint.windowUntil, until);
  });

  it('rejects all-known pages without native current-page evidence even when a next URL advances', async t => {
    fixedClock(t);
    const extraction = new FakeExtraction({ 0: list(['SAFE:1'], listUrl(1)), 1: list(['SAFE:1'], listUrl(2)) });
    const connector = connectorFor(extraction);
    const first = await connector.fetchPage(ctx());
    await assert.rejects(connector.fetchPage(ctx({ checkpoint: first.checkpoint })), /repeats all previously seen native lot IDs/);
    assert.equal(extraction.calls.filter(call => call.url.includes('/procedure/')).length, 1);
  });

  it('rejects contradictory or ambiguous current-page markers before detail requests', async t => {
    fixedClock(t);
    const html = fixture('list-page-0.html');
    const cases = [
      [alterHtml(html, $ => $('.pagination__link--active').attr('data-href', listUrl(1))), /current page disagrees/],
      [alterHtml(html, $ => $('.pagination__link--active').appendTo('.pagination').clone().appendTo('.pagination')), /ambiguous native current/],
      [alterHtml(html, $ => $('.pagination__link--active').removeAttr('data-href')), /current control has no URL/],
      [alterHtml(html, $ => $('.pagination__link--active').text('999')), /current page label disagrees/],
      [alterHtml(html, $ => $('.pagination__link--active').attr('data-href', listUrl(0).replace('currency=all', 'currency=RUB'))), /fixed catalog filters/],
    ];
    for (const [document, expected] of cases) {
      const extraction = new FakeExtraction({ 0: document });
      await assert.rejects(connectorFor(extraction).fetchPage(ctx()), expected);
      assert.equal(extraction.calls.length, 1);
    }
  });

  it('uses explicit native pagination exhaustion rather than duplicate IDs as the terminal signal', async t => {
    fixedClock(t);
    const html = fixture('list-overlap-page-396-20261005.html');
    const terminalHtml = alterHtml(html, $ => $('.pagination__btn--next, .pagination__more-link').remove());
    const priorIds = nativeCards(html).map(card => card.id);
    const extraction = new FakeExtraction({ 396: terminalHtml });
    const checkpoint = { collectionVersion: 1, hasMore: true, nextUrl: listUrl(396), nextPage: 396, windowSince: since, windowUntil: until, wireSince: '05.09.26', wireUntil: '05.10.26', seenNativeIds: priorIds, visitedListUrls: [listUrl(395)] };
    const page = await connectorFor(extraction).fetchPage(ctx({ checkpoint }));
    assert.deepEqual(page.records, []);
    assert.equal(page.hasMore, false);
    assert.equal(page.checkpoint.currentPageVerified, true);
    assert.equal(page.checkpoint.terminalReason, 'observed-pagination-exhausted');
    assert.equal(extraction.calls.length, 1);
  });

  it('follows every observed next link across a long finite sequence without a hard page cap', async t => {
    fixedClock(t);
    const pages = Object.fromEntries(Array.from({ length: 65 }, (_, page) => [page, list([`LONG${page}:1`], page < 64 ? listUrl(page + 1) : undefined)]));
    const extraction = new FakeExtraction(pages);
    const connector = connectorFor(extraction);
    let checkpoint = {}, count = 0, result;
    do {
      result = await connector.fetchPage(ctx({ checkpoint }));
      checkpoint = result.checkpoint;
      count += result.records.length;
    } while (result.hasMore);
    assert.equal(count, 65);
    assert.equal(checkpoint.visitedListUrls.length, 65);
    assert.equal(checkpoint.terminalReason, 'observed-pagination-exhausted');
    assert.equal(extraction.calls.filter(call => call.url.includes('/procedures/search_ajax')).length, 65);
  });

  it('rejects narrowed or hostile pagination and malformed identities before fetching details', async t => {
    fixedClock(t);
    const cases = [
      [list(['SAFE:1'], listUrl(1).replace('currency=all', 'currency=RUB')), /fixed catalog filters/],
      [list(['SAFE:1'], listUrl(1).replace('status%5B%5D=4', 'status%5B%5D=0')), /all-status scope/],
      [list(['SAFE:1'], listUrl(1).replaceAll('status%5B%5D=', 'status%5B0%5D=')), /ambiguous status-array/],
      [list(['SAFE:1'], `${listUrl(1)}&source%5B%5D=1`), /section filters/],
      [list(['SAFE:1'], listUrl(1).replace(origin, 'https://evil.example')), /listing URL/],
      [list(['SAFE:1'], listUrl(0)), /skips, reverses, or repeats/],
      [list(['SAFE:1'], listUrl(2)), /skips, reverses, or repeats/],
      [list(['SAFE:1']).replace('/procedure/SAFE/1', 'https://evil.example/procedure/SAFE/1'), /detail URL/],
      [list(['SAFE:1']).replace('/procedure/SAFE/1', '/procedure/OTHER/1'), /attributes disagree/],
      [list(['SAFE:1', 'SAFE:1']), /within the page/],
      ['<html><h1>Please verify</h1></html>', /no recognized native cards/],
      [`${list(['SAFE:1'])}<button class="pagination__more-link">Еще</button>`, /without a native next URL/],
    ];
    for (const [html, expected] of cases) {
      const extraction = new FakeExtraction({ 0: html });
      await assert.rejects(connectorFor(extraction).fetchPage(ctx()), expected);
      assert.equal(extraction.calls.length, 1);
    }
  });

  it('validates frozen checkpoints and detects resumed cycles without network requests', async t => {
    fixedClock(t);
    const extraction = new FakeExtraction({ 0: list(['SAFE:1'], listUrl(1)) });
    const connector = connectorFor(extraction);
    const first = await connector.fetchPage(ctx());
    const calls = extraction.calls.length;
    const cases = [
      [{ ...first.checkpoint, windowUntil: '2026-10-06T10:00:00.000Z' }, {}, /invalid fixed publication/],
      [first.checkpoint, { backfillSince: '2026-09-05T10:00:00.001Z' }, /boundary changed/],
      [{ ...first.checkpoint, wireUntil: '05.10.2026' }, {}, /date filters changed/],
      [{ ...first.checkpoint, visitedListUrls: [...first.checkpoint.visitedListUrls, listUrl(1)] }, {}, /already visited/],
      [{ ...first.checkpoint, visitedListUrls: [listUrl(0), listUrl(0).replace('status%5B%5D=5', 'status%5B0%5D=5').replace('status%5B%5D=0', 'status%5B1%5D=0').replace('status%5B%5D=1', 'status%5B2%5D=1').replace('status%5B%5D=2', 'status%5B3%5D=2').replace('status%5B%5D=3', 'status%5B4%5D=3').replace('status%5B%5D=4', 'status%5B5%5D=4')] }, {}, /equivalent visited/],
      [{ ...first.checkpoint, nextPage: 2 }, {}, /continuation page disagrees/],
      [{ ...first.checkpoint, seenNativeIds: ['../BAD:1'] }, {}, /invalid native/],
      [{ ...first.checkpoint, staleDetail404Ids: ['../BAD:1'], staleDetail404: 1 }, {}, /invalid native/],
      [{ ...first.checkpoint, staleDetail404Ids: ['STALE:1'], staleDetail404: 2 }, {}, /invalid stale detail 404 count/],
    ];
    for (const [checkpoint, overrides, expected] of cases) await assert.rejects(connector.fetchPage(ctx({ ...overrides, checkpoint })), expected);
    assert.equal(extraction.calls.length, calls);
  });

  it('skips stale native detail HTTP 404s, records loss, and continues collecting the page', async t => {
    fixedClock(t);
    const stale = new WebExtractionHttpError(404, `${origin}/procedure/STALE/1`, { accessReason: 'not_found' });
    const extraction = new FakeExtraction({ 0: list(['STALE:1', 'FRESH:1']) }, new Map([['STALE:1', stale], ['FRESH:1', detail('FRESH:1')]]));
    const result = await connectorFor(extraction).fetchPage(ctx());
    assert.deepEqual(result.records.map(record => record.externalId), ['FRESH:1']);
    assert.equal(result.stats.staleDetail404, 1);
    assert.equal(result.checkpoint.staleDetail404, 1);
    assert.deepEqual(result.checkpoint.staleDetail404Ids, ['STALE:1']);
    assert.deepEqual(result.checkpoint.seenNativeIds, ['STALE:1', 'FRESH:1']);
    assert.equal(result.checkpoint.emitted, 1);
    assert.deepEqual(extraction.calls.map(call => new URL(call.url).pathname), ['/procedures/search_ajax', '/procedure/STALE/1', '/procedure/FRESH/1']);
  });

  it('carries stale native detail 404 coverage through a later clean continuation page', async t => {
    fixedClock(t);
    const stale = new WebExtractionHttpError(404, `${origin}/procedure/STALE/1`, { accessReason: 'not_found' });
    const extraction = new FakeExtraction(
      { 0: list(['STALE:1', 'FIRST:1'], listUrl(1)), 1: list(['SECOND:1']) },
      new Map([['STALE:1', stale], ['FIRST:1', detail('FIRST:1')], ['SECOND:1', detail('SECOND:1')]]),
    );
    const connector = connectorFor(extraction);
    const first = await connector.fetchPage(ctx());
    assert.deepEqual(first.records.map(record => record.externalId), ['FIRST:1']);
    assert.deepEqual(first.checkpoint.staleDetail404Ids, ['STALE:1']);
    assert.equal(first.checkpoint.staleDetail404, 1);
    assert.equal(first.checkpoint.staleDetail404Page, 1);
    assert.equal(first.stats.staleDetail404, 1);
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));
    assert.deepEqual(second.records.map(record => record.externalId), ['SECOND:1']);
    assert.deepEqual(second.checkpoint.staleDetail404Ids, ['STALE:1']);
    assert.equal(second.checkpoint.staleDetail404, 1);
    assert.equal(second.checkpoint.staleDetail404Page, undefined);
    assert.equal(second.stats.staleDetail404, undefined);
    assert.deepEqual(second.checkpoint.seenNativeIds, ['STALE:1', 'FIRST:1', 'SECOND:1']);
    assert.equal(second.checkpoint.terminalReason, 'observed-pagination-exhausted');
  });

  it('propagates non-native 404 text and canonical/date identity failures instead of returning a terminal page', async t => {
    fixedClock(t);
    const cases = [
      [new Error('HTTP 404 Not Found'), /detail fetch failed.*HTTP 404/],
      [detail('SAFE:1', { canonical: `${origin}/procedure/OTHER/1` }), /canonical URL does not match/],
      [detail('SAFE:1').replace('data-feature-favorite-lots-lot-number="1"', 'data-feature-favorite-lots-lot-number="2"'), /detail identity/],
      [detail('SAFE:1', { localPublished: '05.10.26 12:00 (МСК)' }), /publication datetime disagrees/],
    ];
    for (const [value, expected] of cases) {
      const extraction = new FakeExtraction({ 0: list(['SAFE:1']) }, new Map([['SAFE:1', value]]));
      await assert.rejects(connectorFor(extraction).fetchPage(ctx()), expected);
    }
  });

  it('propagates cancellation before and during public GETs', async t => {
    fixedClock(t);
    const before = new AbortController();
    before.abort();
    const extraction = new FakeExtraction({ 0: list(['SAFE:1']) });
    await assert.rejects(connectorFor(extraction).fetchPage(ctx({ signal: before.signal })), { name: 'AbortError' });
    assert.equal(extraction.calls.length, 0);
    const during = new AbortController();
    extraction.onRequest = url => { if (url.includes('/procedure/')) during.abort(); };
    await assert.rejects(connectorFor(extraction).fetchPage(ctx({ signal: during.signal })), { name: 'AbortError' });
    assert.equal(extraction.calls.length, 2);
    assert.equal(extraction.calls[1].options.signal, during.signal);
  });

  it('serializes concurrent collection calls and spaces every listing/detail/page request by at least one second', async t => {
    fixedClock(t);
    let elapsed = 0, active = 0, maximumActive = 0;
    const clock = { now: () => elapsed, async wait(ms, signal) { signal?.throwIfAborted(); elapsed += ms; } };
    const extraction = new FakeExtraction({ 0: list(['ONE:1', 'TWO:1'], listUrl(1)), 1: list(['THREE:1']) });
    const starts = [];
    extraction.onRequest = async () => {
      starts.push(elapsed);
      maximumActive = Math.max(maximumActive, ++active);
      await Promise.resolve();
      active--;
    };
    const connector = connectorFor(extraction, clock);
    const [first] = await Promise.all([connector.fetchPage(ctx()), connector.fetchPage(ctx())]);
    await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));
    assert.equal(maximumActive, 1);
    assert.equal(starts.length, 8);
    for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 1_000);
  });

  it('uses a real production pause of at least one second between public requests', async t => {
    fixedClock(t);
    const extraction = new FakeExtraction({ 0: list(['ONE:1']) });
    const starts = [];
    extraction.onRequest = () => { starts.push(performance.now()); };
    await new RoseltorgConnector(extraction).fetchPage(ctx());
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 1_000);
  });

  it('stops starting details on the first HTTP 429 and preserves status, access reason, Retry-After and cause', async t => {
    fixedClock(t);
    for (const retryAfter of ['120', undefined]) {
      const original = new WebExtractionHttpError(429, `${origin}/procedure/FIRST/1`, { accessReason: 'rate_limited', retryAfter });
      const extraction = new FakeExtraction({ 0: list(['FIRST:1', 'SECOND:1', 'THIRD:1']) }, new Map([['FIRST:1', original]]));
      await assert.rejects(connectorFor(extraction).fetchPage(ctx()), error => {
        assert.ok(error instanceof WebExtractionHttpError);
        assert.equal(error.status, 429);
        assert.equal(error.url, original.url);
        assert.equal(error.accessReason, 'rate_limited');
        assert.equal(error.retryAfter, retryAfter);
        assert.equal(error.cause, original);
        assert.match(error.message, /Roseltorg detail fetch failed.*HTTP 429/);
        return true;
      });
      assert.deepEqual(extraction.calls.map(call => new URL(call.url).pathname), ['/procedures/search_ajax', '/procedure/FIRST/1']);
    }
  });

  it('cancels an actual pacing wait before starting the next request', async t => {
    fixedClock(t);
    const abort = new AbortController();
    const extraction = new FakeExtraction({ 0: list(['WAIT:1']) });
    let waiting;
    const waitStarted = new Promise(resolve => { waiting = resolve; });
    const clock = { now: () => 0, wait(ms, signal) {
      assert.equal(ms, 1_000);
      waiting();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } };
    const promise = connectorFor(extraction, clock).fetchPage(ctx({ signal: abort.signal }));
    await waitStarted;
    abort.abort();
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(extraction.calls.length, 1);
  });

  it('cancels a queued collection before the active request completes', async t => {
    fixedClock(t);
    const extraction = new FakeExtraction({ 0: list(['ONE:1']) });
    let release, notifyStarted;
    const active = new Promise(resolve => { notifyStarted = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    extraction.onRequest = async () => { if (extraction.calls.length === 1) { notifyStarted(); await held; } };
    const connector = connectorFor(extraction);
    const first = connector.fetchPage(ctx());
    await active;
    const abort = new AbortController();
    const queued = connector.fetchPage(ctx({ signal: abort.signal }));
    abort.abort();
    await assert.rejects(queued, { name: 'AbortError' });
    assert.equal(extraction.calls.length, 1);
    release();
    assert.equal((await first).records.length, 1);
    assert.equal(extraction.calls.length, 2);
  });

  it('keeps only safe native document URLs, accepts native HTTP structured canonical, and does not fabricate eligibility', async t => {
    fixedClock(t);
    const native = 'https://rt.roseltorg.ru/file/get/t/LotDocuments/id/42';
    const docs = `<a class="lot-docs__file" href="${native}" title="Оригинальное техническое задание">download</a><a class="lot-docs__file" href="${native}" title="Оригинальное техническое задание">duplicate</a><a class="lot-docs__file" href="javascript:alert(1)" title="Unsafe">x</a><a class="lot-docs__file" href="https://evil.example/file" title="Offsite">x</a><a class="lot-docs__file" href="https://user:secret@rt.roseltorg.ru/file" title="Credentials">x</a><a class="js-use-auth-check" href="${origin}/download-all" title="Скачать все">x</a>`;
    const html = detail('SAFE:1', { canonical: 'http://www.roseltorg.ru/procedure/SAFE/1', extra: docs });
    const extraction = new FakeExtraction({ 0: list(['SAFE:1']) }, new Map([['SAFE:1', html]]));
    const { records: [record] } = await connectorFor(extraction).fetchPage(ctx());
    assert.deepEqual(record.sourceMetadata.sourceDocuments, [{ label: 'Оригинальное техническое задание', url: native }]);
    assert.equal(record.sourceMetadata.eligibility, undefined);
    assert.equal(extraction.calls.length, 2);
  });

  it('converts day filters to Moscow calendar dates and rejects alternate configured entry points', async t => {
    fixedClock(t, '2026-10-05T22:30:00.000Z');
    const extraction = new FakeExtraction({ 0: fixture('empty-native.html') });
    const connector = connectorFor(extraction);
    const result = await connector.fetchPage(ctx({ backfillDays: 30, backfillSince: undefined }));
    assert.equal(result.checkpoint.windowSince, '2026-09-05T22:30:00.000Z');
    assert.equal(result.checkpoint.windowUntil, '2026-10-05T22:30:00.000Z');
    assert.equal(result.checkpoint.wireSince, '06.09.26');
    assert.equal(result.checkpoint.wireUntil, '06.10.26');
    assert.equal((await connector.validateConfig({ baseUrl: `${origin}/procedures/search` })).ok, true);
    for (const baseUrl of [`${origin}/tenderplan`, `${origin}/procedures/search?status[]=0`, 'https://roseltorg.ru', 'https://evil.example']) assert.equal((await connector.validateConfig({ baseUrl })).ok, false);
  });

  it('refreshes existing native lots with fresh status, deadline and lot price winning over stale listing', async t => {
    fixedClock(t);
    const occurrence = await hydroOccurrence();
    const extraction = new FakeExtraction({}, new Map([[occurrence.externalId, fixture('refresh-hydro-changed.html')]]));
    const connector = connectorFor(extraction);
    assert.equal(connector.capabilities().supportsRefresh, true);
    const { record } = await connector.refresh(occurrence, ctx());
    assert.equal(record.externalId, occurrence.externalId);
    assert.equal(record.url, occurrence.url);
    assert.equal(record.sourceStatus, 'Closed');
    assert.equal(record.sourceMetadata.nativeStatus, 'Процедура завершена');
    assert.equal(record.sourceMetadata.deadlineAt, '2026-10-25T14:30:00.000Z');
    assert.equal(record.sourceMetadata.budget.amount, 200_000_000);
    assert.equal(record.sourceMetadata.tenderData.taxText, 'с НДС');
    assert.equal(record.publishedAt.toISOString(), occurrence.publishedAt.toISOString());
    assert.equal(record.sourceMetadata.tenderData.customer, occurrence.sourceMetadata.tenderData.customer);
    assert.deepEqual(record.sourceMetadata.sourceDocuments, occurrence.sourceMetadata.sourceDocuments);
    assert.equal(record.rawPayload.detail.html, fixture('refresh-hydro-changed.html'));
    assert.equal(record.rawPayload.detail.observedProduct.offers.price, '200000000.00');
    assert.equal(record.rawPayload.refresh.publicationWindowApplied, false);
    assert.deepEqual(record.rawPayload.collection, occurrence.rawPayload.collection);
    assert.deepEqual(extraction.calls.map(call => call.url), [occurrence.url]);
  });

  it('retains omitted native detail fields and their evidence across repeated partial refreshes', async t => {
    fixedClock(t);
    const occurrence = await hydroOccurrence();
    occurrence.sourceMetadata.publicObservation = 'retained';
    occurrence.sourceMetadata.tenderData.nativeLabel = 'retained native metadata';
    const details = new Map([[occurrence.externalId, fixture('refresh-hydro-omitted.html')]]);
    const extraction = new FakeExtraction({}, details);
    const connector = connectorFor(extraction);
    const { record } = await connector.refresh(occurrence, ctx());
    assert.equal(record.sourceStatus, 'Unknown');
    assert.equal(record.sourceMetadata.nativeStatus, 'Приостановлена');
    assert.equal(record.sourceMetadata.budget.amount, 137_100_000);
    assert.equal(record.sourceMetadata.deadlineAt, occurrence.sourceMetadata.deadlineAt);
    assert.equal(record.sourceMetadata.tenderData.customerInn, occurrence.sourceMetadata.tenderData.customerInn);
    assert.equal(record.sourceMetadata.tenderData.organizer, occurrence.sourceMetadata.tenderData.organizer);
    assert.equal(record.sourceMetadata.tenderData.procurementMethod, occurrence.sourceMetadata.tenderData.procurementMethod);
    assert.deepEqual(record.sourceMetadata.tenderData.procurementObjects, occurrence.sourceMetadata.tenderData.procurementObjects);
    assert.deepEqual(record.sourceMetadata.sourceDocuments, occurrence.sourceMetadata.sourceDocuments);
    assert.equal(record.sourceMetadata.publicObservation, 'retained');
    assert.equal(record.sourceMetadata.tenderData.nativeLabel, 'retained native metadata');
    assert.equal(record.rawPayload.detail.html, fixture('refresh-hydro-omitted.html'));
    assert.match(record.rawPayload.detail.effectiveHtml, /137 100 000/);
    assert.equal(record.sourceMetadata.eligibility, undefined);
    details.set(occurrence.externalId, fixture('refresh-hydro-changed.html'));
    const changed = (await connector.refresh(occurrenceFrom(record), ctx())).record;
    details.set(occurrence.externalId, alterHtml(fixture('refresh-hydro-omitted.html'), $ => $('.lot-status').remove()));
    const repeated = (await connector.refresh(occurrenceFrom(changed), ctx())).record;
    assert.equal(repeated.sourceStatus, 'Closed', 'last native detail status wins over retained accepting-applications card');
    assert.equal(repeated.sourceMetadata.budget.amount, 200_000_000);
    assert.equal(repeated.sourceMetadata.deadlineAt, '2026-10-25T14:30:00.000Z');
    assert.equal(repeated.sourceMetadata.tenderData.customer, occurrence.sourceMetadata.tenderData.customer);
    assert.deepEqual(repeated.sourceMetadata.sourceDocuments, occurrence.sourceMetadata.sourceDocuments);
  });

  it('refreshes publications older than the initial window and preserves original publication without reading collection boundaries', async t => {
    fixedClock(t);
    const occurrence = await hydroOccurrence();
    occurrence.rawPayload.detail.html = fixture('refresh-hydro-older.html');
    occurrence.publishedAt = new Date('2025-01-15T09:00:00.000Z');
    const extraction = new FakeExtraction({}, new Map([[occurrence.externalId, fixture('refresh-hydro-omitted.html')]]));
    const { record } = await connectorFor(extraction).refresh(occurrence, ctx({ backfillDays: -1, backfillSince: 'invalid', checkpoint: { collectionVersion: 999, hasMore: true } }));
    assert.equal(record.publishedAt.toISOString(), '2025-01-15T09:00:00.000Z');
    assert.equal(record.rawPayload.detail.publishedAt, '2025-01-15T09:00:00.000Z');
    assert.equal(record.sourceMetadata.publicationText, '15.01.25 12:00 (МСК)');
    assert.equal(record.rawPayload.refresh.publicationWindowApplied, false);
    assert.equal(extraction.calls.length, 1);
  });

  it('refreshes deadline from either current HTML or structured data without comparing it to stale counterpart text', async t => {
    fixedClock(t);
    const occurrence = await hydroOccurrence();
    const htmlOnly = alterHtml(fixture('refresh-hydro-changed.html'), $ => alterProduct($, product => { delete product.offers.validThrough; }));
    const schemaOnly = alterHtml(fixture('refresh-hydro-changed.html'), $ => $('.lot-common-info__row').each((_, node) => { if ($(node).find('.lot-common-info__text').text().trim() === 'Приём заявок') $(node).remove(); }));
    for (const html of [htmlOnly, schemaOnly]) {
      const extraction = new FakeExtraction({}, new Map([[occurrence.externalId, html]]));
      const { record } = await connectorFor(extraction).refresh(occurrence, ctx());
      assert.equal(record.sourceMetadata.deadlineAt, '2026-10-25T14:30:00.000Z');
      assert.notEqual(record.rawPayload.detail.fields['Приём заявок'], 'до 21.10.26 10:00 (МСК)');
    }
    const invalid = alterHtml(fixture('refresh-hydro-changed.html'), $ => alterProduct($, product => { product.offers.validThrough = 'invalid datetime'; }));
    await assert.rejects(connectorFor(new FakeExtraction({}, new Map([[occurrence.externalId, invalid]]))).refresh(occurrence, ctx()), /invalid native validThrough/);
  });

  it('refreshes a structured positive lot price and explicit unknown price without reviving a stale budget', async t => {
    fixedClock(t);
    const occurrence = await hydroOccurrence();
    const structured = alterHtml(fixture('refresh-hydro-changed.html'), $ => $('.lot-price').remove());
    const extraction = new FakeExtraction({}, new Map([[occurrence.externalId, structured]]));
    const { record } = await connectorFor(extraction).refresh(occurrence, ctx());
    assert.equal(record.sourceMetadata.budget.amount, 200_000_000);
    assert.equal(record.sourceMetadata.budget.currency, 'RUB');
    assert.equal(record.sourceMetadata.tenderData.taxText, occurrence.sourceMetadata.tenderData.taxText);
    assert.equal(record.rawPayload.detail.taxText, occurrence.sourceMetadata.tenderData.taxText);
    const currencyOmitted = alterHtml(structured, $ => alterProduct($, product => { delete product.offers.priceCurrency; }));
    const partialPrice = (await connectorFor(new FakeExtraction({}, new Map([[occurrence.externalId, currencyOmitted]]))).refresh(occurrence, ctx())).record;
    assert.equal(partialPrice.sourceMetadata.budget.amount, 200_000_000);
    assert.equal(partialPrice.sourceMetadata.budget.currency, 'RUB');
    assert.equal(partialPrice.sourceMetadata.tenderData.taxText, occurrence.sourceMetadata.tenderData.taxText);
    const unknown = alterHtml(fixture('refresh-hydro-changed.html'), $ => {
      $('.lot-price').text('НМЦ не указано');
      alterProduct($, product => { product.offers.price = '0.00'; });
    });
    const missing = (await connectorFor(new FakeExtraction({}, new Map([[occurrence.externalId, unknown]]))).refresh(occurrence, ctx())).record;
    assert.equal(missing.sourceMetadata.budget.amount, undefined);
    assert.equal(missing.sourceMetadata.budget.kind, 'unpublished-lot-price');
  });

  it('rejects invalid occurrence/card/detail identities before GET and fresh canonical redirects or parser failures after GET', async t => {
    fixedClock(t);
    const occurrence = await hydroOccurrence();
    const clone = () => structuredClone(occurrence);
    const cases = [
      { ...clone(), externalId: '32616434303:0' },
      { ...clone(), externalId: 'OTHER:1' },
      { ...clone(), url: 'https://evil.example/procedure/32616434303/1' },
      { ...clone(), url: `${origin}/procedure/32616434303/2` },
    ];
    const cardMismatch = clone(); cardMismatch.rawPayload.list.html = card('OTHER:1'); cases.push(cardMismatch);
    const detailMismatch = clone(); detailMismatch.rawPayload.detail.url = `${origin}/procedure/OTHER/1`; cases.push(detailMismatch);
    for (const invalid of cases) {
      const extraction = new FakeExtraction({}, new Map([[occurrence.externalId, fixture('refresh-hydro-changed.html')]]));
      await assert.rejects(connectorFor(extraction).refresh(invalid, ctx()), /identity|native|occurrence/);
      assert.equal(extraction.calls.length, 0);
    }
    const canonical = alterHtml(fixture('refresh-hydro-changed.html'), $ => $('head').append(`<link rel="canonical" href="${origin}/procedure/OTHER/1">`));
    for (const response of [canonical, '<html><h1>Verify your browser</h1></html>', { finalUrl: `${origin}/procedure/OTHER/1`, html: fixture('refresh-hydro-changed.html'), metadata: {} }]) {
      const extraction = new FakeExtraction({}, new Map([[occurrence.externalId, response]]));
      await assert.rejects(connectorFor(extraction).refresh(occurrence, ctx()), /canonical URL|detail identity|redirected/);
      assert.equal(extraction.calls.length, 1);
    }
  });

  it('propagates native refresh 403/429/404/410 for root-owned access handling and retirement', async t => {
    fixedClock(t);
    const occurrence = await hydroOccurrence();
    for (const status of [403, 429, 404, 410]) {
      const original = new WebExtractionHttpError(status, occurrence.url, { ...(status === 403 ? { accessReason: 'access_denied' } : status === 429 ? { accessReason: 'rate_limited', retryAfter: '60' } : {}) });
      const extraction = new FakeExtraction({}, new Map([[occurrence.externalId, original]]));
      await assert.rejects(connectorFor(extraction).refresh(occurrence, ctx()), error => {
        assert.ok(error instanceof WebExtractionHttpError);
        assert.equal(error.status, status);
        assert.equal(error.retryAfter, original.retryAfter);
        assert.equal(error.cause, original);
        return true;
      });
      assert.equal(extraction.calls.length, 1);
    }
  });

  it('cancels refresh before GET and during pacing without starting another detail', async t => {
    fixedClock(t);
    const occurrence = await hydroOccurrence();
    const before = new AbortController(); before.abort();
    const extraction = new FakeExtraction({}, new Map([[occurrence.externalId, fixture('refresh-hydro-changed.html')]]));
    await assert.rejects(connectorFor(extraction).refresh(occurrence, ctx({ signal: before.signal })), { name: 'AbortError' });
    assert.equal(extraction.calls.length, 0);
    let notifyWaiting;
    const waiting = new Promise(resolve => { notifyWaiting = resolve; });
    const clock = { now: () => 0, wait(ms, signal) {
      assert.equal(ms, 1_000);
      notifyWaiting();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } };
    const connector = connectorFor(extraction, clock);
    await connector.refresh(occurrence, ctx());
    const during = new AbortController();
    const promise = connector.refresh(occurrence, ctx({ signal: during.signal }));
    await waiting;
    during.abort();
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(extraction.calls.length, 1);
  });
});
