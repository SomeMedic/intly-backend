import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { load } = require('cheerio');
const { FabrikantConnector } = require('../src/modules/sources/connectors/fabrikant.connector.ts');
const { fabrikantListUrl, fabrikantDetailUrl, parseFabrikantCatalog, fabrikantPublished, fabrikantDetail, fabrikantBudget, fabrikantStoredCard, fabrikantTenderMetadata, FabrikantLotPageError } = require('../src/modules/sources/connectors/fabrikant-native.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');
const { WebExtractionHttpError } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const { ConnectorRegistryService } = require('../src/modules/sources/connectors/connector-registry.service.ts');
const { SOURCE_CATALOG } = require('../src/modules/sources/catalog/source-catalog.ts');
const fixture = name => readFileSync(new URL(`./fixtures/fabrikant-native/${name}`, import.meta.url), 'utf8');
const samples = JSON.parse(fixture('catalogs.json'));
const day = '2026-10-06';
const origin = 'https://www.fabrikant.ru';
const partition = { day: '2026-10-05', page: 1 };
const source = { _id: 'fabrikant', connectorFamily: 'TenderPlatform', name: 'Фабрикант', endpoint: { baseUrl: origin }, config: { perPage: 1 }, timeoutMs: 20_000 };
const ctx = overrides => ({ source, checkpoint: {}, backfillDays: 1, backfillSince: '2026-10-06T00:00:00.000Z', requestId: 'fabrikant-test', ...overrides });
function connector(extraction, legacy) {
  let elapsed = 0;
  return new FabrikantConnector(extraction, legacy, { now: () => elapsed, async wait(ms, signal) { signal?.throwIfAborted(); elapsed += ms; } });
}
function fixed(t) { t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T18:00:00.000Z') }); }
const baseline = load(samples.baseline.html);
const commercialCard = baseline('[data-slot="card"][data-id]').filter((_, e) => baseline(e).text().includes('№ 5583367-1')).first().toString();
const regulatedCard = baseline('[data-slot="card"][data-id]').filter((_, e) => baseline(e).find('a[href*="/0348600004326000047"]').length).first().toString();
const legacyCard = baseline('[data-slot="card"][data-id]').filter((_, e) => baseline(e).find('a[href*="id=1023815"]').length).first().toString();
assert.ok(commercialCard && regulatedCard && legacyCard, 'Retained native detail identities must exist in the public catalog');

// Test variants keep actual card DOM/taxonomy; their synthetic count and query isolate cursor behavior.
function nativeList(cards, scope = { day, page: 1 }, total = cards.length, pages = Math.ceil(total / 40)) {
  const html = load(samples['day-1'].html);
  const script = JSON.parse(html('script').text().slice(19, -1))[1];
  const objects = script.split('\n').map(row => JSON.parse(row.slice(row.indexOf(':') + 1)));
  const taxonomy = objects.find(value => value.success);
  const reflected = { searchParams: { date_publication_from: scope.day, date_publication_to: scope.day, ...(scope.sectionId ? { section_ids: [scope.sectionId] } : {}), page_limit: '40', page_number: String(scope.page) } };
  const pagination = { keys: { page: 'page_number', limit: 'page_limit' }, total, pages };
  return `<html><body>${cards.join('')}${cards.length ? `<li class="rc-pagination-item-active" title="${scope.page}"></li>` : '<div>По вашему запросу ничего не найдено</div>'}<script>self.__next_f.push(${JSON.stringify([1, [reflected, taxonomy, pagination].map((x, i) => i + ':' + JSON.stringify(x)).join('\n')])})</script></body></html>`;
}
function fake(html, detail = fixture('detail-commercial.html')) {
  const calls = [];
  return { calls, async extractUrl(url) { calls.push(url); return { finalUrl: url, html: new URL(url).pathname === '/procedure/search' ? html : detail, metadata: { firecrawl: false } }; } };
}
function alter(html, edit) { const $ = load(html); edit($); return $.html(); }

describe('Fabrikant native public contract', () => {
  it('reads actual All pages, native day/section contracts, 1000-result cap and distinct next-page IDs', () => {
    const first = parseFabrikantCatalog(samples['day-1'].html, samples['day-1'].url, partition);
    const second = parseFabrikantCatalog(samples['day-2'].html, samples['day-2'].url, { ...partition, page: 2 });
    const section = parseFabrikantCatalog(samples['day-section'].html, samples['day-section'].url, { ...partition, sectionId: '2' });
    assert.equal(first.cards.length, 40);
    assert.equal(first.total, 1146);
    assert.equal(first.pages, 25);
    assert.equal(first.sectionIds.length, 24);
    assert.equal(second.cards.length, 40);
    assert.equal(first.cards.filter(a => second.cards.some(b => a.id === b.id)).length, 0);
    assert.equal(section.total, 68);
    assert.equal(section.pages, 2);
    assert.ok(first.cards.some(card => card.section === 'Торги по банкротству'));
    assert.ok(first.cards.some(card => card.url.includes('44.fabrikant.ru')));
  });

  it('accepts the observed native empty marker with exact reflected filters, and rejects an arbitrary no-card page', () => {
    assert.equal(parseFabrikantCatalog(samples['day-empty'].html, samples['day-empty'].url, { ...partition, sectionId: '31' }).empty, true);
    assert.throws(() => parseFabrikantCatalog('<h1>Access denied</h1>', fabrikantListUrl(partition), partition), /reflected filters/);
    const noMarker = alter(samples['day-empty'].html, $ => $('div').remove());
    assert.throws(() => parseFabrikantCatalog(noMarker, samples['day-empty'].url, { ...partition, sectionId: '31' }), /verified native empty/);
    assert.throws(() => parseFabrikantCatalog(samples['day-empty'].html, samples['day-empty'].url, { ...partition, sectionId: '2' }), /different filters/);
  });

  it('rejects server filter drift, homepage tender links, repeated native IDs and wrong current page', () => {
    assert.throws(() => parseFabrikantCatalog(samples['day-1'].html, samples['day-1'].url, { ...partition, page: 2 }), /different filters/);
    const drift = samples['day-1'].html.replace(/page_number\\":\\"1/g, 'page_number\\":\\"2');
    assert.throws(() => parseFabrikantCatalog(drift, samples['day-1'].url, partition), /reflected filters/);
    const home = alter(samples['day-1'].html, $ => $('[data-slot="card"][data-id]').first().find('a[data-slot="anchor"]').first().attr('href', origin));
    assert.throws(() => parseFabrikantCatalog(home, samples['day-1'].url, partition), /native procedure detail/);
    const repeated = alter(samples['day-1'].html, $ => $('[data-slot="card"][data-id]').last().attr('data-id', $('[data-slot="card"][data-id]').first().attr('data-id')));
    assert.throws(() => parseFabrikantCatalog(repeated, samples['day-1'].url, partition), /repeats lot IDs/);
    const wrongPage = alter(samples['day-1'].html, $ => $('.rc-pagination-item-active').attr('title', '2'));
    assert.throws(() => parseFabrikantCatalog(wrongPage, samples['day-1'].url, partition), /current page/);
  });

  it('preserves distinct native lot IDs when sales lots share one procedure URL', () => {
    const $ = load(samples.sales.html);
    const cards = $('[data-slot="card"][data-id]').slice(0, 3).map((_, e) => $.html(e)).get();
    const parsed = parseFabrikantCatalog(nativeList(cards), fabrikantListUrl({ day, page: 1 }), { day, page: 1 });
    assert.equal(new Set(parsed.cards.map(card => card.id)).size, 3);
    assert.equal(new Set(parsed.cards.map(card => card.url)).size, 1);
    assert.equal(new Set(parsed.cards.map(card => card.title)).size, 3);
  });

  it('recognizes the exact live native Market notice URL and auxiliary MSP badge while preserving all 40 page cards', () => {
    const evidence = JSON.parse(fixture('live-native-page-2-evidence.json'));
    const catalog = parseFabrikantCatalog(fixture('live-native-page-2.html'), evidence.finalUrl, { day, page: 2 });
    assert.equal(catalog.cards.length, evidence.cardCount);
    assert.equal(catalog.cards.length, 40);
    const card = catalog.cards.find(card => card.id === '679731849');
    assert.equal(card.url, 'https://market.fabrikant.ru/purchase_notice/view?id=01m48rrgwthw8m2aph3062hgbt');
    assert.deepEqual(card.nativeBadges, ['МСП', 'Прием предложений', 'Маркет']);
    assert.equal(card.nativeStatus, 'Прием предложений');
    assert.equal(card.section, 'Маркет');
    assert.equal(card.title, 'Поставка шестеренного электронасоса');
    assert.equal(fabrikantDetailUrl(card.url), card.url);
    assert.equal(fabrikantDetail(card, fixture('live-market-native-detail.html')), null);
    for (const input of [card.url.replace('/view?', '/edit?'), card.url.replace('market.fabrikant.ru', 'evil.fabrikant.ru'), card.url.replace('01m48rrgwthw8m2aph3062hgbt', '../other'), card.url + '&id=another', 'https://market.fabrikant.ru/purchase_notice/view']) assert.throws(() => fabrikantDetailUrl(input), /native procedure detail/);
  });

  it('verifies v2 lot, 44 notice and decoded CP1251 legacy procedure identities from actual details', () => {
    for (const [html, file, kind] of [[commercialCard, 'detail-commercial.html', 'native-v2-procedure-lot'], [regulatedCard, 'detail-44.html', 'native-regulated-procedure'], [legacyCard, 'detail-legacy.html', 'native-legacy-procedure']]) {
      const card = parseFabrikantCatalog(nativeList([html]), fabrikantListUrl({ day, page: 1 }), { day, page: 1 }).cards[0];
      const detail = fabrikantDetail(card, fixture(file));
      assert.equal(detail.kind, kind);
      assert.ok(detail.publication);
      assert.ok(detail.text.length > 100);
      assert.throws(() => fabrikantDetail({ ...card, procedureNumber: '99999999999', url: card.url.includes('/44/') ? card.url.replace('0348600004326000047', '99999999999') : card.url }, fixture(file)), /identity|number/);
    }
    assert.equal(fabrikantPublished('06.10.2026 17:06').toISOString(), '2026-10-06T14:06:00.000Z');
    assert.equal(fabrikantPublished('32.10.2026 17:06'), undefined);
  });

  it('selects the exact real GIS Torgi lots across the procedure’s published native pages', () => {
    const evidence = JSON.parse(fixture('live-gis-multilot-detail-evidence.json'));
    const second = JSON.parse(fixture('live-gis-multilot-detail-page-2-evidence.json'));
    for (const { card } of evidence.cards) {
      const html = fixture(card.lotNumber === '5' ? 'live-gis-multilot-detail.html' : 'live-gis-multilot-detail-page-2.html');
      const url = card.lotNumber === '5' ? evidence.finalUrl : second.finalUrl;
      const detail = fabrikantDetail(card, html, url);
      assert.equal(detail.lotSpecific, true);
      assert.equal(detail.kind, 'native-v2-procedure-lot');
      assert.ok(detail.text.includes(card.title));
      assert.ok(detail.text.startsWith(`Лот №${card.lotNumber}.`));
      assert.equal(detail.nativeStatus, 'Ожидается начало приема заявок');
      if (card.lotNumber !== '5') assert.throws(() => fabrikantDetail(card, fixture('live-gis-multilot-detail.html')), error => error instanceof FabrikantLotPageError && error.nextPageUrl === second.requestUrl);
    }
    const card = evidence.cards[1].card;
    assert.throws(() => fabrikantDetail({ ...card, lotNumber: '99' }, fixture('live-gis-multilot-detail-page-2.html'), second.finalUrl), /does not contain the catalog lot number/);
    assert.throws(() => fabrikantDetail({ ...card, procedureNumber: '9999999' }, fixture('live-gis-multilot-detail.html')), /procedure number differs/);
    assert.throws(() => fabrikantDetail(card, fixture('live-gis-multilot-detail.html'), second.finalUrl), /current page differs/);
    for (const href of [second.requestUrl.replace('a3UZKTFkE1oOaxv6MaqAYw', 'another-procedure'), second.requestUrl + '&section=other', second.requestUrl + '&page=2', second.requestUrl.replace('www.fabrikant.ru', 'user@www.fabrikant.ru'), second.requestUrl + '#lot']) {
      const malformed = alter(fixture('live-gis-multilot-detail.html'), $ => $('ul.pagination a').attr('href', href));
      assert.throws(() => fabrikantDetail(card, malformed), /changes procedure identity or query/);
    }
    const duplicated = alter(fixture('live-gis-multilot-detail-page-2.html'), $ => { const panel = $('[data-lot-idc]').first().closest('.panel'); panel.after(panel.clone()); });
    assert.throws(() => fabrikantDetail(card, duplicated, second.finalUrl), /ambiguous native lot markers/);
  });

  it('normalizes only literal BSON null optional evidence while keeping native identity and optional types strict', () => {
    const observed = JSON.parse(fixture('persisted-null-legacy-cards.json'));
    for (const { card } of observed.cards) {
      const before = structuredClone(card);
      const normalized = fabrikantStoredCard(Object.freeze(card));
      assert.deepEqual(card, before);
      assert.equal(Object.hasOwn(normalized, 'lotNumber'), false);
      assert.equal(Object.hasOwn(normalized, 'deadlineText'), false);
      assert.equal(normalized.id, card.id);
      assert.equal(normalized.url, card.url);
      assert.equal(normalized.procedureNumber, card.procedureNumber);
      assert.equal(Object.hasOwn(fabrikantTenderMetadata(normalized).tenderData, 'lotNumber'), false);
      for (const field of ['id', 'procedureNumber', 'title', 'text', 'url']) assert.throws(() => fabrikantStoredCard({ ...card, [field]: null }), /native card is invalid/);
      for (const field of ['id', 'procedureNumber']) assert.throws(() => fabrikantStoredCard({ ...card, [field]: Number(card[field]) }), /native card is invalid/);
      for (const lotNumber of ['0', '', 1, [], {}]) assert.throws(() => fabrikantStoredCard({ ...card, lotNumber }), /optional evidence is invalid/);
      assert.throws(() => fabrikantStoredCard({ ...card, deadlineText: 0 }), /optional evidence is invalid/);
      assert.throws(() => fabrikantStoredCard({ ...card, nativeBadges: [null] }), /optional evidence is invalid/);
      const allUnknown = fabrikantStoredCard({ ...card, nativeStatus: null, section: null, organizer: null, publishedText: null, priceText: null, participationText: null, nativeBadges: null });
      for (const field of ['nativeStatus', 'section', 'organizer', 'publishedText', 'priceText', 'participationText', 'nativeBadges']) assert.equal(Object.hasOwn(allUnknown, field), false);
    }
  });

  it('reads native lot numbers from their own header node without appending the adjacent EIS notice number', () => {
    const evidence = JSON.parse(fixture('live-native-page-4-evidence.json'));
    const catalog = parseFabrikantCatalog(fixture('live-native-page-4.html'), evidence.finalUrl, { day, page: 4 });
    assert.equal(catalog.cards.length, 40);
    const card = catalog.cards.find(card => card.id === '679731553');
    assert.equal(card.procedureNumber, '1200249');
    assert.equal(card.lotNumber, '1');
    assert.equal(card.nativeCatalogNumberText, '№ 1200249-1');
    assert.equal(card.nativeNoticeNumber, '0848300062226001063');
    assert.equal(/№\s*(\d+)(?:\s*-(\d+))?/.exec(card.text)[2], '10848300062226001063');
    const normalized = fabrikantTenderMetadata(card);
    assert.equal(normalized.tenderData.lotNumber, '1');
    assert.equal(normalized.tenderData.catalogLotNumber, undefined);
  });

  it('resolves the exact old concatenated v2 lot only with matching native heading and dedicated EIS evidence', () => {
    const observed = JSON.parse(fixture('live-v2-external-lot-number-evidence.json'));
    const card = fabrikantStoredCard(observed.card);
    const before = structuredClone(card);
    const detail = fabrikantDetail(card, fixture('live-v2-external-lot-number.html'), observed.finalUrl);
    assert.ok(detail.text.startsWith('Лот №1.'));
    assert.ok(detail.text.includes('Номер закупки в ЕИС 32616441359'));
    const metadata = fabrikantTenderMetadata(Object.freeze(card), detail.text);
    assert.equal(metadata.tenderData.lotNumber, '1');
    assert.equal(metadata.tenderData.catalogLotNumber, '132616441359');
    assert.equal(metadata.tenderData.lotNumberEvidence, 'native-lot-heading-and-eis-number');
    assert.deepEqual(card, before);
    assert.equal(fabrikantTenderMetadata(card).tenderData.lotNumber, '132616441359');
    for (const text of [detail.text.replace('32616441359', '32616441358'), detail.text.replace('Лот №1.', 'Лот №2.'), detail.text.replace('Номер закупки в ЕИС', 'Неизвестный номер'), detail.text + ' Номер закупки в ЕИС 32616441359']) assert.equal(fabrikantTenderMetadata(card, text).tenderData.lotNumber, '132616441359');
    for (const edit of [
      $ => $('.panel-group-element-external_oos_number_url').remove(),
      $ => $('.panel-group-element-external_oos_number_url .col-md-8 a').attr('href', 'https://zakupki.gov.ru/epz/order/extendedsearch/results.html?searchString=32616441358'),
      $ => $('.panel-group-element-external_oos_number_url .col-md-8 a').attr('href', 'https://another.example/notice?searchString=32616441359'),
    ]) assert.throws(() => fabrikantDetail(card, alter(fixture('live-v2-external-lot-number.html'), edit), observed.finalUrl), /does not contain the catalog lot number/);
  });
});

describe('Fabrikant resumable collection', () => {
  it('emits a concrete native lot with detail seconds, unknown participation payment and preserved frozen window', async t => {
    fixed(t);
    const extraction = fake(nativeList([commercialCard]));
    const result = await connector(extraction).fetchPage(ctx());
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].title, 'Поставка геодезического оборудования');
    assert.equal(result.records[0].publishedAt.toISOString(), '2026-10-06T14:06:31.000Z');
    assert.equal(result.records[0].sourceMetadata.detailAvailability, 'verified-public-native');
    assert.equal(result.records[0].sourceMetadata.participationPayment, 'unknown');
    assert.equal(result.checkpoint.windowSince, '2026-10-06T00:00:00.000Z');
    assert.equal(result.hasMore, false);
    assert.equal(result.checkpoint.catalogComplete, true);
    assert.equal(extraction.calls.length, 2);
  });

  it('maps observed procurement number, price and deadline into canonical tender fields without changing the frontier', async t => {
    fixed(t);
    const extraction = fake(nativeList([regulatedCard]), fixture('detail-44.html'));
    const result = await connector(extraction).fetchPage(ctx());
    const record = result.records[0];
    const card = record.rawPayload.nativeCatalogCard;
    const normalized = new SourceNormalizerService().normalize(source, record);
    assert.equal(normalized.tenderData.contractNumber, card.procedureNumber);
    assert.equal(normalized.tenderData.procedureNumber, card.procedureNumber);
    assert.equal(normalized.tenderData.lotNumber, card.lotNumber);
    assert.equal(normalized.tenderData.platform, 'Фабрикант');
    assert.equal(normalized.tenderData.organizer, card.organizer);
    assert.equal(normalized.tenderData.nativeStatus, 'Прием заявок');
    assert.equal(normalized.tenderData.priceText, card.priceText);
    assert.equal(normalized.money.originalText, card.priceText);
    assert.equal(normalized.money.amount, 752177.16);
    assert.equal(normalized.money.currency, 'RUB');
    assert.equal(normalized.deadline.toISOString(), '2026-10-13T07:00:00.000Z');
    assert.equal(normalized.tenderData.deadlineText, '13.10.2026 10:00');
    assert.equal(record.sourceMetadata.deadlinePrecision, 'minute');
    assert.equal(record.sourceMetadata.participationPayment, 'unknown');
    assert.equal(normalized.sourceOccurrences[0].externalId, card.id);
    assert.equal(normalized.sourceOccurrences[0].url, card.url);
    assert.equal(result.checkpoint.windowSince, '2026-10-06T00:00:00.000Z');
    assert.equal(result.checkpoint.seenNativeIds[0], card.id);
  });

  it('retains nonnumeric price text and unknown deadline/lot without inventing money, tax or participation facts', async t => {
    fixed(t);
    const extraction = fake(nativeList([legacyCard]));
    const legacy = async url => ({ finalUrl: url, html: fixture('detail-legacy.html'), metadata: { encoding: 'windows-1251' } });
    const result = await connector(extraction, legacy).fetchPage(ctx());
    const normalized = new SourceNormalizerService().normalize(source, result.records[0]);
    assert.equal(Object.hasOwn(normalized.tenderData, 'lotNumber'), false);
    assert.equal(normalized.money.originalText, result.records[0].rawPayload.nativeCatalogCard.priceText);
    assert.equal(Object.hasOwn(normalized.money, 'gross'), false);
    for (const text of ['По результатам переговоров', '1,234 RUB', '1.234 RUB', '100 RUB без НДС', '1 00,00 RUB', '100–200 RUB', '9007199254740990,99 RUB']) {
      const money = fabrikantBudget(text);
      assert.equal(money.originalText, text);
      assert.equal(money.amount, undefined);
      assert.equal(money.currency, undefined);
    }
    assert.deepEqual(fabrikantBudget('135 000,00 RUB'), { originalText: '135 000,00 RUB', amount: 135000, currency: 'RUB', kind: 'published-initial-lot-price' });
    assert.equal(fabrikantBudget('0,00 RUB').amount, 0);
    assert.equal(fabrikantBudget('Цена не указана').amount, undefined);
    assert.equal(fabrikantPublished('13.10.2026'), undefined);
  });

  it('maps the exact live native679724853 procurement/deadline while retaining its unpublished price and paid-participation label', async () => {
    const observed = JSON.parse(fixture('native-card-live.json'));
    const card = observed.nativeCard;
    const checkpoint = { collectionVersion: 1, hasMore: true, batch: 1, windowSince: '2026-10-06T00:00:00.000Z', windowUntil: '2026-10-06T18:00:00.000Z', partitions: [{ day, page: 1, status: 'complete', total: 1, pages: 1, ids: [card.id], pageSignatures: ['retained-native-catalog-page'] }], pendingDetails: [{ card, catalogUrl: observed.catalogUrl }], seenNativeIds: [], catalogOnlyNativeIds: [], unknownPublicationNativeIds: [], coverageWarnings: [] };
    // Mapping must also survive an unavailable detail without losing already verified catalog facts.
    const extraction = { async extractUrl(url) { throw new WebExtractionHttpError(404, url); } };
    const result = await connector(extraction).fetchPage(ctx({ checkpoint }));
    const record = result.records[0];
    const normalized = new SourceNormalizerService().normalize(source, record);
    const retainedCard = structuredClone(card);
    const retainedMetadata = fabrikantTenderMetadata(retainedCard);
    assert.deepEqual(retainedCard, card);
    assert.deepEqual(retainedMetadata.tenderData, record.sourceMetadata.tenderData);
    assert.deepEqual(retainedMetadata.budget, record.sourceMetadata.budget);
    assert.equal(retainedMetadata.deadlineAt, '2026-10-13T13:00:00.000Z');
    assert.equal(normalized.tenderData.contractNumber, '5583059');
    assert.equal(normalized.tenderData.procedureNumber, '5583059');
    assert.equal(normalized.tenderData.lotNumber, '1');
    assert.equal(normalized.tenderData.deadlineText, '13.10.2026 16:00');
    assert.equal(normalized.deadline.toISOString(), '2026-10-13T13:00:00.000Z');
    assert.equal(normalized.money.originalText, 'Цена не указана');
    assert.equal(Object.hasOwn(normalized.money, 'amount'), false);
    assert.equal(Object.hasOwn(normalized.money, 'currency'), false);
    assert.equal(record.sourceMetadata.participationText, 'Платное участие');
    assert.equal(record.sourceMetadata.participationPayment, 'unknown');
    assert.equal(record.externalId, '679724853');
    assert.equal(record.url, card.url);
    assert.equal(result.checkpoint.windowSince, checkpoint.windowSince);
    assert.equal(result.checkpoint.windowUntil, checkpoint.windowUntil);
    assert.deepEqual(result.checkpoint.partitions, checkpoint.partitions);
  });

  it('normalizes the exact observed RUB price labels and explicit midnight MSK deadline through the pure retained-card helper', () => {
    const cards = JSON.parse(fixture('native-price-cards-live.json'));
    const expected = { '679731858': 22230.52, '679731878': 9386000, '679731916': 1054636.8 };
    for (const card of cards) {
      const before = structuredClone(card);
      const sourceMetadata = fabrikantTenderMetadata(Object.freeze(card));
      const record = { externalId: card.id, url: card.url, type: 'tender', title: card.title, sourceStatus: 'Unknown', rawPayload: { nativeCatalogCard: card }, sourceMetadata };
      const normalized = new SourceNormalizerService().normalize(source, record);
      assert.equal(normalized.money.amount, expected[card.id]);
      assert.equal(normalized.money.originalText, card.priceText);
      assert.equal(normalized.money.currency, 'RUB');
      assert.equal(normalized.tenderData.contractNumber, card.procedureNumber);
      assert.equal(normalized.tenderData.lotNumber, card.lotNumber);
      assert.deepEqual(card, before);
      if (card.id === '679731858') {
        assert.equal(normalized.deadline.toISOString(), '2026-10-12T21:00:00.000Z');
        assert.equal(sourceMetadata.deadlinePrecision, 'minute');
        assert.equal(sourceMetadata.deadlineTimezone, 'Europe/Moscow');
        assert.equal(sourceMetadata.tenderData.deadlineText, '13.10.2026 00:00');
      }
    }
  });

  it('keeps the new native Market SPA lot as explicit catalog-only data without dropping it or changing checkpoint identities', async () => {
    const evidence = JSON.parse(fixture('live-native-page-2-evidence.json'));
    const catalog = parseFabrikantCatalog(fixture('live-native-page-2.html'), evidence.finalUrl, { day, page: 2 });
    const card = catalog.cards.find(card => card.id === '679731849');
    const checkpoint = { collectionVersion: 1, hasMore: true, batch: 2, windowSince: '2026-10-06T00:00:00.000Z', windowUntil: '2026-10-06T18:00:00.000Z', partitions: [{ day, page: 2, status: 'complete', total: 1, pages: 2, ids: [card.id], pageSignatures: ['retained-page-one', 'retained-page-two'] }], pendingDetails: [{ card, catalogUrl: evidence.finalUrl }], seenNativeIds: [], catalogOnlyNativeIds: [], unknownPublicationNativeIds: [], coverageWarnings: [] };
    const extraction = { async extractUrl() { throw new Error('Market SPA catalog-only resume must not use a guessed detail API'); } };
    const result = await connector(extraction).fetchPage(ctx({ checkpoint }));
    assert.equal(result.records.length, 1);
    const record = result.records[0];
    assert.equal(record.externalId, card.id);
    assert.equal(record.url, card.url);
    assert.equal(record.sourceStatus, 'Active');
    assert.equal(record.sourceMetadata.detailAvailability, 'native-market-spa-catalog-only');
    assert.equal(record.sourceMetadata.tenderData.nativeStatus, 'Прием предложений');
    assert.equal(record.sourceMetadata.tenderData.section, 'Маркет');
    assert.deepEqual(record.rawPayload.nativeCatalogCard.nativeBadges, card.nativeBadges);
    assert.equal(result.checkpoint.detailComplete, false);
    assert.equal(result.checkpoint.coverageComplete, false);
    assert.deepEqual(result.checkpoint.catalogOnlyNativeIds, [card.id]);
    assert.deepEqual(result.checkpoint.partitions, checkpoint.partitions);
    assert.equal(result.checkpoint.windowSince, checkpoint.windowSince);
    assert.equal(result.checkpoint.windowUntil, checkpoint.windowUntil);
  });

  it('drains a persisted detail queue without rereading the catalog or losing lot IDs', async t => {
    fixed(t);
    const extraction = fake(nativeList([commercialCard, regulatedCard]));
    const first = await connector(extraction).fetchPage(ctx());
    assert.equal(first.hasMore, true);
    assert.equal(first.checkpoint.pendingDetails.length, 1);
    const resumed = fake('', fixture('detail-44.html'));
    const next = await connector(resumed).fetchPage(ctx({ checkpoint: first.checkpoint, backfillSince: '2020-01-01', backfillDays: 999 }));
    assert.equal(next.hasMore, false);
    assert.equal(next.records.length, 1);
    assert.equal(next.checkpoint.seenNativeIds.length, 2);
    assert.equal(next.checkpoint.windowSince, first.checkpoint.windowSince);
    assert.equal(next.checkpoint.windowUntil, first.checkpoint.windowUntil);
    assert.equal(resumed.calls.length, 1);
    assert.ok(!resumed.calls[0].includes('/procedure/search'));
  });

  it('continues BSON-style optional-null checkpoints without inventing a lot or mutating persisted evidence', async () => {
    const observed = JSON.parse(fixture('persisted-null-legacy-cards.json'));
    const checkpoint = JSON.parse(JSON.stringify({ collectionVersion: 1, hasMore: true, batch: 7, windowSince: '2026-10-06T00:00:00.000Z', windowUntil: '2026-10-06T18:00:00.000Z', partitions: [{ day, page: 5, status: 'pending', ids: observed.cards.map(item => item.card.id), pageSignatures: ['retained-native-page-four'] }], pendingDetails: observed.cards.map(item => ({ ...item, card: { ...item.card, nativeBadges: undefined, participationText: undefined } })), seenNativeIds: [], catalogOnlyNativeIds: [], unknownPublicationNativeIds: [], coverageWarnings: [] }, (_, value) => value === undefined ? null : value));
    assert.equal(checkpoint.pendingDetails[0].card.lotNumber, null);
    assert.equal(checkpoint.pendingDetails[0].card.nativeBadges, null);
    const before = structuredClone(checkpoint);
    let calls = 0;
    const extraction = { async extractUrl() { throw new Error('Retained native legacy checkpoint must not reread the catalog'); } };
    const legacy = async url => { calls++; throw new WebExtractionHttpError(404, url); };
    const c = connector(extraction, legacy);
    const result = await c.fetchPage(ctx({ checkpoint, source: { ...source, config: { perPage: 3 } } }));
    assert.equal(calls, 3);
    assert.equal(result.records.length, 3);
    assert.equal(result.checkpoint.pendingDetails.length, 0);
    assert.deepEqual(result.checkpoint.seenNativeIds, observed.cards.map(item => item.card.id));
    assert.deepEqual(result.checkpoint.partitions, before.partitions);
    assert.equal(result.checkpoint.windowSince, before.windowSince);
    assert.equal(result.checkpoint.windowUntil, before.windowUntil);
    assert.deepEqual(checkpoint, before);
    for (const record of result.records) {
      const retained = observed.cards.find(item => item.card.id === record.externalId).card;
      assert.equal(record.url, retained.url);
      assert.equal(record.rawPayload.nativeCatalogCard.procedureNumber, retained.procedureNumber);
      assert.equal(Object.hasOwn(record.rawPayload.nativeCatalogCard, 'lotNumber'), false);
      assert.equal(Object.hasOwn(record.sourceMetadata.tenderData, 'lotNumber'), false);
      assert.equal(record.sourceMetadata.detailAvailability, 'native-detail-http-404');
      const persistedOccurrence = JSON.parse(JSON.stringify({ externalId: retained.id, url: retained.url, rawPayload: { nativeCatalogCard: retained, catalogUrl: observed.cards[0].catalogUrl } }, (_, value) => value === undefined ? null : value));
      const refreshed = await c.refresh(persistedOccurrence, ctx());
      assert.equal(refreshed.record.externalId, retained.id);
      assert.equal(Object.hasOwn(refreshed.record.rawPayload.nativeCatalogCard, 'lotNumber'), false);
      assert.equal(persistedOccurrence.rawPayload.nativeCatalogCard.lotNumber, null);
    }
    assert.equal(calls, 6);
  });

  it('maps the verified old EIS-concatenated native lot while preserving original raw card and canonical source identity', async () => {
    const evidence = JSON.parse(fixture('live-v2-external-lot-number-evidence.json'));
    const original = { externalId: evidence.card.id, url: evidence.card.url, rawPayload: { nativeCatalogCard: evidence.card, catalogUrl: evidence.catalogUrl } };
    const before = structuredClone(original);
    const extraction = { async extractUrl(url) { assert.equal(url, evidence.finalUrl); return { finalUrl: url, html: fixture('live-v2-external-lot-number.html'), metadata: {} }; } };
    const refreshed = await connector(extraction).refresh(original, ctx());
    const record = refreshed.record;
    assert.equal(record.externalId, '679731171');
    assert.equal(record.url, original.url);
    assert.equal(record.sourceMetadata.detailAvailability, 'verified-public-native');
    assert.equal(record.sourceMetadata.detailLotSpecific, true);
    assert.equal(record.sourceMetadata.lotNumber, '1');
    assert.equal(record.sourceMetadata.tenderData.lotNumber, '1');
    assert.equal(record.sourceMetadata.tenderData.catalogLotNumber, '132616441359');
    assert.equal(record.rawPayload.nativeCatalogCard.lotNumber, '132616441359');
    assert.deepEqual(original, before);
    const reprocessed = new SourceNormalizerService().normalize(source, { ...record, sourceMetadata: fabrikantTenderMetadata(record.rawPayload.nativeCatalogCard, record.rawPayload.nativeDetailText) });
    assert.equal(reprocessed.tenderData.lotNumber, '1');
    assert.equal(reprocessed.tenderData.catalogLotNumber, '132616441359');
    assert.equal(reprocessed.sourceOccurrences[0].externalId, '679731171');
    assert.equal(reprocessed.sourceOccurrences[0].url, original.url);
  });

  it('resumes the exact retained GIS lots using only published detail links and preserves canonical identities, window and catalog pointer', async () => {
    const evidence = JSON.parse(fixture('live-gis-multilot-detail-evidence.json'));
    const second = JSON.parse(fixture('live-gis-multilot-detail-page-2-evidence.json'));
    const checkpoint = { collectionVersion: 1, hasMore: true, batch: 7, windowSince: '2026-09-06T14:40:27.721Z', windowUntil: '2026-10-06T14:40:27.721Z', partitions: Array.from({ length: 31 }, (_, i) => ({ day: new Date(Date.parse('2026-10-06T00:00:00Z') - i * 86400000).toISOString().slice(0, 10), page: i === 0 ? 5 : 1, status: i === 0 ? 'pending' : 'complete', ids: i === 0 ? evidence.cards.map(item => item.card.id) : [], pageSignatures: i === 0 ? ['retained-native-page-four'] : [] })), pendingDetails: evidence.cards, seenNativeIds: ['679700000'], catalogOnlyNativeIds: [], unknownPublicationNativeIds: [], coverageWarnings: [] };
    const before = structuredClone(checkpoint);
    const calls = [];
    const extraction = { async extractUrl(url) { calls.push(url); assert.ok(url === evidence.finalUrl || url === second.finalUrl); return { finalUrl: url, html: fixture(url === second.finalUrl ? 'live-gis-multilot-detail-page-2.html' : 'live-gis-multilot-detail.html'), metadata: { firecrawl: false } }; } };
    const result = await connector(extraction).fetchPage(ctx({ checkpoint, source: { ...source, config: { perPage: 4 } }, backfillDays: 999, backfillSince: '2020-01-01' }));
    assert.equal(result.records.length, 4);
    for (const record of result.records) {
      const retained = evidence.cards.find(item => item.card.id === record.externalId).card;
      assert.equal(record.url, retained.url);
      const expectedCard = { ...retained };
      if (expectedCard.participationText === null) delete expectedCard.participationText;
      assert.deepEqual(record.rawPayload.nativeCatalogCard, expectedCard);
      assert.equal(record.sourceMetadata.detailAvailability, 'verified-public-native');
      assert.equal(record.sourceMetadata.detailLotSpecific, true);
      assert.equal(record.sourceMetadata.tenderData.contractNumber, '5583349');
      assert.equal(record.sourceMetadata.tenderData.lotNumber, retained.lotNumber);
      assert.ok(record.rawPayload.nativeDetailText.startsWith(`Лот №${retained.lotNumber}.`));
      assert.equal(record.rawPayload.nativeDetailUrl, retained.lotNumber === '5' ? evidence.finalUrl : second.finalUrl);
    }
    assert.equal(calls.length, 7);
    assert.equal(result.hasMore, true);
    assert.equal(result.checkpoint.batch, 8);
    assert.equal(result.checkpoint.nextPage, 9);
    assert.deepEqual(result.checkpoint.partitions, before.partitions);
    assert.equal(result.checkpoint.windowSince, before.windowSince);
    assert.equal(result.checkpoint.windowUntil, before.windowUntil);
    assert.deepEqual(result.checkpoint.seenNativeIds, [...before.seenNativeIds, ...evidence.cards.map(item => item.card.id)]);
    assert.equal(result.checkpoint.pendingDetails.length, 0);
    assert.deepEqual(checkpoint, before);
  });

  it('rejects ignored or repeated native lot pages instead of dropping the retained pending lot', async () => {
    const evidence = JSON.parse(fixture('live-gis-multilot-detail-evidence.json'));
    const second = JSON.parse(fixture('live-gis-multilot-detail-page-2-evidence.json'));
    const card = evidence.cards[1].card;
    const original = { externalId: card.id, url: card.url, rawPayload: { nativeCatalogCard: card, catalogUrl: evidence.cards[1].catalogUrl } };
    let calls = 0;
    const ignored = { async extractUrl(url) { calls++; return { finalUrl: url, html: fixture('live-gis-multilot-detail.html'), metadata: {} }; } };
    await assert.rejects(() => connector(ignored).refresh(original, ctx()), /current page differs/);
    assert.equal(calls, 2);
    const repeatedHtml = alter(fixture('live-gis-multilot-detail.html'), $ => { $('ul.pagination li.active span').text('2'); $('ul.pagination a').attr('href', second.finalUrl.replace('page=2', 'page=3')).text('3'); });
    calls = 0;
    const repeated = { async extractUrl(url) { calls++; return { finalUrl: url, html: calls === 1 ? fixture('live-gis-multilot-detail.html') : repeatedHtml, metadata: {} }; } };
    await assert.rejects(() => connector(repeated).refresh(original, ctx()), /repeats previously returned lots/);
    assert.equal(calls, 2);
    calls = 0;
    const bounded = { async extractUrl(url) {
      const page = ++calls;
      const html = alter(fixture('live-gis-multilot-detail.html'), $ => {
        $('ul.pagination li.active span').text(String(page));
        $('ul.pagination a').attr('href', second.finalUrl.replace('page=2', `page=${page + 1}`)).text(String(page + 1));
        $('[data-lot-idc]').each((_, e) => $(e).attr('data-lot-idc', `${$(e).attr('data-lot-idc')}-${page}`));
      });
      return { finalUrl: url, html, metadata: {} };
    } };
    await assert.rejects(() => connector(bounded).refresh(original, ctx()), /exceeded its bounded page limit/);
    assert.equal(calls, 20);
  });

  it('seeds only observed section IDs when capped and retains original day/native next pointer and unresolved coverage', async () => {
    const extraction = fake(samples['day-1'].html);
    // Existing frozen source run, with its native next page and history intact.
    const checkpoint = { collectionVersion: 1, hasMore: true, batch: 7, windowSince: '2026-10-05T00:00:00.000Z', windowUntil: '2026-10-05T20:00:00.000Z', partitions: [{ ...partition, status: 'pending', ids: [], pageSignatures: [] }], pendingDetails: [], seenNativeIds: [], catalogOnlyNativeIds: [], unknownPublicationNativeIds: [], coverageWarnings: [] };
    // Market card is catalog-only, requiring no unrelated details for this frontier assertion.
    const $ = load(samples['day-1'].html);
    const market = $('[data-slot="card"][data-id]').filter((_, e) => $(e).find('a[href*="market.fabrikant.ru"]').length).first();
    const html = nativeList(Array.from({ length: 40 }, (_, i) => alter(market.toString(), $ => { $('[data-id]').attr('data-id', String(900000000 + i)); })), partition, 1146, 25);
    extraction.extractUrl = async url => ({ finalUrl: url, html, metadata: {} });
    const result = await connector(extraction).fetchPage(ctx({ checkpoint }));
    assert.equal(result.checkpoint.partitions.length, 25);
    assert.equal(result.checkpoint.partitions[0].page, 2);
    assert.equal(result.checkpoint.partitions[0].status, 'pending');
    assert.equal(result.checkpoint.batch, 8);
    assert.equal(result.checkpoint.catalogComplete, false);
    assert.equal(result.checkpoint.pendingDetails.length, 39);
    assert.equal(result.records[0].sourceMetadata.detailAvailability, 'unsupported-native-detail-shape');
  });

  it('rejects a repeated page, silently ignored publication day, missing day frontier and incompatible checkpoint', async t => {
    fixed(t);
    const base = fake(nativeList([commercialCard, regulatedCard]));
    const first = await connector(base).fetchPage(ctx());
    const invalid = structuredClone(first.checkpoint);
    invalid.partitions[0].day = '2026-10-04';
    await assert.rejects(() => connector(base).fetchPage(ctx({ checkpoint: invalid })), /outside its frozen window/);
    await assert.rejects(() => connector(base).fetchPage(ctx({ checkpoint: { hasMore: true } })), /another connector continuation/);
    const badDate = commercialCard.replaceAll('06.10.2026 17:06', '05.10.2026 17:06');
    await assert.rejects(() => connector(fake(nativeList([badDate]))).fetchPage(ctx()), /another publication day/);
  });

  it('detects an identical returned lot page even when the server echoes the next page correctly', async () => {
    const $ = load(samples['day-1'].html);
    const market = $('[data-slot="card"][data-id]').filter((_, e) => $(e).find('a[href*="market.fabrikant.ru"]').length).first().toString();
    const cards = Array.from({ length: 40 }, (_, i) => alter(market, $ => $('[data-id]').attr('data-id', String(910000000 + i))));
    const extraction = { async extractUrl(url) { const page = Number(new URL(url).searchParams.get('page_number')); return { finalUrl: url, html: nativeList(cards, { ...partition, page }, 80, 2), metadata: {} }; } };
    const checkpoint = { collectionVersion: 1, hasMore: true, batch: 0, windowSince: '2026-10-05T00:00:00.000Z', windowUntil: '2026-10-05T20:00:00.000Z', partitions: [{ ...partition, status: 'pending', ids: [], pageSignatures: [] }], pendingDetails: [], seenNativeIds: [], catalogOnlyNativeIds: [], unknownPublicationNativeIds: [], coverageWarnings: [] };
    const context = ctx({ checkpoint, source: { ...source, config: { perPage: 40 } } });
    const first = await connector(extraction).fetchPage(context);
    await assert.rejects(() => connector(extraction).fetchPage({ ...context, checkpoint: first.checkpoint }), /repeated a previously returned lot page/);
  });

  it('retains boundary-precision and unsupported/404 details truthfully, propagates access denial and enforces 30 days', async t => {
    fixed(t);
    const extraction = fake(nativeList([regulatedCard]));
    extraction.extractUrl = async url => { if (new URL(url).pathname !== '/procedure/search') throw new WebExtractionHttpError(404, url); return { finalUrl: url, html: nativeList([regulatedCard]), metadata: {} }; };
    const result = await connector(extraction).fetchPage(ctx({ backfillSince: '2026-10-06T14:06:30.000Z' }));
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].publishedAt, undefined);
    assert.equal(result.records[0].sourceMetadata.windowMembership, 'unknown-boundary-precision');
    assert.equal(result.checkpoint.detailComplete, false);
    const denied = { async extractUrl(url) { throw new WebExtractionHttpError(403, url, { accessReason: 'access_denied' }); } };
    await assert.rejects(() => connector(denied).fetchPage(ctx()), /access denied/);
    const empty = { async extractUrl(url) { const u = new URL(url); return { finalUrl: url, html: nativeList([], { day: u.searchParams.get('date_publication_from'), page: 1 }), metadata: {} }; } };
    const bounded = await connector(empty).fetchPage(ctx({ backfillSince: '2020-01-01', backfillDays: 999 }));
    assert.equal(Date.parse(bounded.checkpoint.windowUntil) - Date.parse(bounded.checkpoint.windowSince), 30 * 86400000);
    assert.equal(bounded.checkpoint.partitions.length, 31);
  });

  it('uses the legacy byte transport only for native legacy details and refresh preserves native lot identity', async t => {
    fixed(t);
    let calls = 0;
    const extraction = fake(nativeList([legacyCard]));
    const legacy = async url => { calls++; return { finalUrl: url, html: fixture('detail-legacy.html'), metadata: { encoding: 'windows-1251' } }; };
    const c = connector(extraction, legacy);
    const result = await c.fetchPage(ctx());
    assert.equal(calls, 1);
    assert.equal(result.records[0].sourceMetadata.detailAvailability, 'verified-public-native');
    const record = result.records[0];
    const persisted = JSON.parse(JSON.stringify({ ...record }, (_, value) => value === undefined ? null : value));
    assert.equal(persisted.rawPayload.nativeCatalogCard.lotNumber, null);
    const refreshed = await c.refresh(persisted, ctx());
    assert.equal(refreshed.record.externalId, record.externalId);
    assert.equal(refreshed.record.sourceMetadata.detailAvailability, 'verified-public-native');
    assert.equal(Object.hasOwn(refreshed.record.rawPayload.nativeCatalogCard, 'lotNumber'), false);
    await assert.rejects(() => c.refresh({ ...record, externalId: '99999' }, ctx()), /native catalog lot identity/);
  });

  it('registers Fabrikant without changing its endpoint/family/default config', () => {
    const registry = new ConnectorRegistryService(fake(''));
    assert.ok(registry.get(source) instanceof FabrikantConnector);
    const row = SOURCE_CATALOG.find(row => row.id === 'fabrikant');
    assert.equal(row.endpoint.baseUrl, 'https://www.fabrikant.ru');
    assert.equal(row.connectorFamily, 'TenderPlatform');
    assert.equal(row.parserVersion, 'fabrikant-native-public-v1');
    assert.equal(row.unavailableReason, undefined);
    assert.equal(new FabrikantConnector(fake('')).capabilities().maxBackfillDays, 30);
  });
});
