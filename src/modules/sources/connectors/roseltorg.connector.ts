import { load } from 'cheerio';
import { setTimeout as delay } from 'node:timers/promises';

import { WebExtractionHttpError, WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, RefreshResult, ValidationResult } from './connector.types';

const ORIGIN = 'https://www.roseltorg.ru';
const LIST_PATH = '/procedures/search_ajax';
const DAY_MS = 86_400_000;
const STATUSES = ['5', '0', '1', '2', '3', '4'];
const MAX_BYTES = 2_000_000;
const ID = /^[A-Za-z0-9]+$/;
const LOT = /^[1-9]\d*$/;
const REQUEST_INTERVAL_MS = 1_000;

type RequestClock = { now(): number; wait(ms: number, signal?: AbortSignal): Promise<void> };
const REQUEST_CLOCK: RequestClock = {
  now: () => performance.now(),
  wait: async (ms, signal) => { await delay(ms, undefined, { signal }); },
};

type Window = { since: string; until: string };
type PageDocument = { finalUrl: string; html: string; metadata: Record<string, unknown> };
type NativeCard = {
  externalId: string; procedureNumber: string; lotNumber: string; url: string;
  title: string; html: string; section?: string; region?: string; organizer?: string;
  status?: string; priceText?: string; procurementMethod?: string; deadlineText?: string;
};
type NativeDocument = { label: string; url: string };
type TenderData = {
  customer?: string; region?: string; procurementMethod?: string; contractNumber: string;
  platform: string; procedureNumber: string; lotNumber: string; numberLabel: string;
  organizer?: string; customerInn?: string; nativeStatus?: string; delivery?: string;
  requirementsText?: string; procurementObjects: string[]; priceText?: string;
  priceKind: string; taxText?: string; publishedText?: string; deadlineText?: string;
};

/** The anonymous catalog returns native lot HTML, including archived procurement sections. */
export class RoseltorgConnector implements Connector {
  readonly id = 'roseltorg';
  readonly family = 'TenderPlatform' as const;
  private requestTail: Promise<void> = Promise.resolve();
  private lastRequestFinishedAt?: number;

  constructor(private readonly extraction: WebExtractionService, private readonly clock: RequestClock = REQUEST_CLOCK) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    try {
      this.validateBaseUrl(config.baseUrl);
      return { ok: true, message: 'Roseltorg anonymous native procurement catalog configured' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Invalid Roseltorg catalog URL' };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      this.validateSource(ctx);
      const until = new Date().toISOString();
      const window = { since: new Date(Date.parse(until) - DAY_MS).toISOString(), until };
      const url = this.listUrl(window, 0);
      const document = await this.extract('health listing', url, ctx);
      if (this.canonicalListUrl(document.finalUrl, window) !== url) throw new Error('Roseltorg health listing redirected to different filters');
      const cards = this.cards(document.html, url);
      if (!cards.length && !this.nativeEmpty(document.html)) throw new Error('Roseltorg listing has no recognized native cards or empty-result marker');
      return { state: 'Healthy', message: `Roseltorg returned ${cards.length} native public lots`, checkedAt: new Date(), details: { scope: 'anonymous-public-procurement' } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Roseltorg public catalog fetch failed', checkedAt: new Date(), ...(error instanceof WebExtractionHttpError ? { details: { status: error.status, retryAfter: error.retryAfter, accessReason: error.accessReason } } : {}) };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    ctx.signal?.throwIfAborted();
    this.validateSource(ctx);
    const window = this.collectionWindow(ctx);
    const continuing = ctx.checkpoint.hasMore === true;
    const requestedUrl = continuing
      ? this.canonicalListUrl(this.checkpointString(ctx.checkpoint.nextUrl, 'next URL'), window)
      : this.listUrl(window, 0);
    const page = Number(new URL(requestedUrl).searchParams.get('page'));
    if (continuing && ctx.checkpoint.nextPage !== page) throw new Error('Roseltorg continuation page disagrees with its native next URL');
    const visited = continuing ? this.checkpointStrings(ctx.checkpoint.visitedListUrls, 'visited URLs').map(url => this.canonicalListUrl(url, window)) : [];
    if (new Set(visited).size !== visited.length) throw new Error('Roseltorg continuation repeats equivalent visited listing URLs');
    if (visited.includes(requestedUrl)) throw new Error('Roseltorg pagination cycle: listing URL was already visited');
    const previousIds = new Set(continuing ? this.checkpointStrings(ctx.checkpoint.seenNativeIds, 'seen lot IDs') : []);
    for (const id of previousIds) this.assertExternalId(id);
    const previousStaleDetail404Ids = continuing ? this.checkpointStaleDetail404Ids(ctx.checkpoint) : [];

    const document = await this.extract('listing', requestedUrl, ctx);
    const finalUrl = this.canonicalListUrl(document.finalUrl, window);
    if (finalUrl !== requestedUrl) throw new Error('Roseltorg listing redirected to a different page or filter');
    const cards = this.cards(document.html, finalUrl);
    const currentPageVerified = this.currentPageMatches(document.html, finalUrl, window, page);
    const nextUrl = this.observedNext(document.html, finalUrl, window, page);
    if (!cards.length && (!this.nativeEmpty(document.html) || nextUrl)) throw new Error('Roseltorg listing has no recognized native cards or terminal empty-result marker');
    const pageIds = new Set(cards.map(card => card.externalId));
    if (pageIds.size !== cards.length) throw new Error('Roseltorg listing repeats a native procedure/lot ID within the page');
    const fresh = cards.filter(card => !previousIds.has(card.externalId));
    if (continuing && cards.length && !fresh.length && !currentPageVerified) throw new Error('Roseltorg listing repeats all previously seen native lot IDs');
    const visitedListUrls = [...visited, finalUrl];
    if (nextUrl && visitedListUrls.includes(nextUrl)) throw new Error('Roseltorg pagination cycle: next URL was already visited');

    const records: RawOpportunityRecord[] = [];
    const staleDetail404Ids: string[] = [];
    for (const card of fresh) {
      let record: RawOpportunityRecord;
      try {
        record = await this.detail(card, document, window, ctx);
      } catch (error) {
        if (this.isStaleNativeDetail404(error, card)) {
          staleDetail404Ids.push(card.externalId);
          continue;
        }
        throw error;
      }
      if (!record.publishedAt || record.publishedAt.getTime() >= Date.parse(window.since) && record.publishedAt.getTime() <= Date.parse(window.until)) records.push(record);
    }
    ctx.signal?.throwIfAborted();
    const seenNativeIds = Array.from(new Set([...previousIds, ...pageIds]));
    const cumulativeStaleDetail404Ids = Array.from(new Set([...previousStaleDetail404Ids, ...staleDetail404Ids]));
    const hasMore = Boolean(nextUrl);
    const nextPage = nextUrl ? Number(new URL(nextUrl).searchParams.get('page')) : undefined;
    const stats: FetchPage['stats'] & Record<string, unknown> = { seen: cards.length };
    if (staleDetail404Ids.length) stats.staleDetail404 = staleDetail404Ids.length;
    return {
      records, hasMore, nextPage,
      checkpoint: {
        collectionVersion: 1, hasMore, ...(nextUrl ? { nextUrl, nextPage } : { terminalReason: cards.length ? 'observed-pagination-exhausted' : 'native-empty-result' }),
        windowSince: window.since, windowUntil: window.until,
        wireSince: this.wireDate(window.since), wireUntil: this.wireDate(window.until),
        seenNativeIds, visitedListUrls, coverage: 'anonymous-native-public-procurement-catalog',
        lastFetchedAt: new Date().toISOString(), seen: cards.length, emitted: records.length,
        currentPageVerified, deduplicated: cards.length - fresh.length,
        ...(cumulativeStaleDetail404Ids.length ? { staleDetail404Ids: cumulativeStaleDetail404Ids, staleDetail404: cumulativeStaleDetail404Ids.length, ...(staleDetail404Ids.length ? { staleDetail404Page: staleDetail404Ids.length } : {}) } : {}),
      },
      stats,
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> { return result.checkpoint; }

  async refresh(occurrence: Record<string, unknown>, ctx: FetchContext): Promise<RefreshResult> {
    ctx.signal?.throwIfAborted();
    this.validateSource(ctx);
    if (typeof occurrence.externalId !== 'string' || typeof occurrence.url !== 'string') throw new Error('Roseltorg refresh requires an existing native procedure/lot identity and URL');
    this.assertExternalId(occurrence.externalId);
    const [procedure, lot] = occurrence.externalId.split(':');
    const url = this.detailUrl(occurrence.url, ORIGIN);
    if (url !== `${ORIGIN}/procedure/${procedure}/${lot}`) throw new Error('Roseltorg refresh occurrence identity disagrees with its native detail URL');
    const payload = this.object(occurrence.rawPayload), retainedList = this.object(payload.list), retainedDetail = this.object(payload.detail);
    if (typeof retainedList.html !== 'string' || typeof retainedList.url !== 'string') throw new Error('Roseltorg refresh requires retained native lot card HTML and its catalog URL');
    const listUrl = new URL(retainedList.url);
    if (listUrl.origin !== ORIGIN || listUrl.username || listUrl.password || listUrl.hash || ![LIST_PATH, '/procedures/search'].includes(listUrl.pathname)) throw new Error('Roseltorg refresh has an invalid retained native catalog URL');
    const cards = this.cards(retainedList.html, listUrl.toString());
    if (cards.length !== 1 || cards[0].externalId !== occurrence.externalId || cards[0].url !== url) throw new Error('Roseltorg refresh retained native card does not match its occurrence');
    if (typeof retainedDetail.html !== 'string' || typeof retainedDetail.url !== 'string' || this.detailUrl(retainedDetail.url, url) !== url) throw new Error('Roseltorg refresh requires retained detail evidence for the same native lot');
    this.assertDetail(retainedDetail.html, url, cards[0]);
    const retainedHtml = typeof retainedDetail.effectiveHtml === 'string' ? retainedDetail.effectiveHtml : retainedDetail.html;
    this.assertDetail(retainedHtml, url, cards[0]);
    const listing = { finalUrl: listUrl.toString(), html: retainedList.html, metadata: {} };
    const record = await this.detail(cards[0], listing, undefined, ctx, retainedHtml);
    const retainedPublished = occurrence.publishedAt instanceof Date ? occurrence.publishedAt : this.isoDate(occurrence.publishedAt);
    if (!record.publishedAt && retainedPublished && Number.isFinite(retainedPublished.getTime())) {
      record.publishedAt = new Date(retainedPublished);
      this.object(record.rawPayload.detail).publishedAt = record.publishedAt.toISOString();
      record.sourceMetadata.dateUnknown = false;
      record.sourceMetadata.publicationTimezone = 'Europe/Moscow';
    }
    record.sourceMetadata = { ...this.object(occurrence.sourceMetadata), ...record.sourceMetadata };
    record.sourceMetadata.tenderData = { ...this.object(this.object(occurrence.sourceMetadata).tenderData), ...this.object(record.sourceMetadata.tenderData) };
    record.rawPayload.collection = { ...this.object(payload.collection) };
    record.rawPayload.refresh = { operation: 'native-detail-refresh', fetchedAt: new Date().toISOString(), retainedFrom: url, fieldFallback: 'retained-native-html', publicationWindowApplied: false };
    return { record };
  }

  private cards(html: string, from: string): NativeCard[] {
    const $ = load(html);
    return $('.search-results__item').map((_, element): NativeCard => {
      const card = $(element);
      const procedureNumber = card.attr('data-feature-favorite-lots-procedure-number') ?? '';
      const lotNumber = card.attr('data-feature-favorite-lots-lot-number') ?? '';
      this.assertIdentity(procedureNumber, lotNumber);
      const anchor = card.find('a.search-results__link--description').first();
      const url = this.detailUrl(anchor.attr('href') ?? '', from);
      if (url !== `${ORIGIN}/procedure/${procedureNumber}/${lotNumber}`) throw new Error('Roseltorg native lot attributes disagree with its detail URL');
      const title = this.text(anchor.text());
      if (!title) throw new Error('Roseltorg native lot card has no title');
      const sum = card.find('.search-results__sum').first();
      const priceText = this.text(sum.find('p').first().text() || sum.text());
      return {
        externalId: `${procedureNumber}:${lotNumber}`, procedureNumber, lotNumber, url, title,
        html: $.html(element),
        section: this.text(card.find('.search-results__section').first().text()) || undefined,
        region: this.text(card.find('.search-results__region').first().text()) || undefined,
        organizer: this.text(card.find('.search-results__customer a[href*="/companies/"]').first().text()) || undefined,
        status: this.text(card.find('.search-results__status').first().text()) || undefined,
        priceText: priceText || undefined,
        procurementMethod: this.text(card.find('.search-results__type').first().text()) || undefined,
        deadlineText: this.text(card.find('.search-results__time').first().text()) || undefined,
      };
    }).get();
  }

  private async detail(card: NativeCard, listing: PageDocument, window: Window | undefined, ctx: FetchContext, retainedHtml?: string): Promise<RawOpportunityRecord> {
    const document = await this.extract('detail', card.url, ctx);
    return this.parseDetail(card, listing, window, document, retainedHtml);
  }

  private assertDetail(html: string, finalUrl: string, card: NativeCard): void {
    if (this.detailUrl(finalUrl, card.url) !== card.url) throw new Error(`Roseltorg lot ${card.externalId} redirected to another native lot`);
    const $ = load(html), root = $('.lot-page__left-column-lot[data-feature-favorite-lots="lot"]').first();
    if (!root.length || root.attr('data-feature-favorite-lots-procedure-number') !== card.procedureNumber || root.attr('data-feature-favorite-lots-lot-number') !== card.lotNumber) throw new Error(`Roseltorg detail identity does not match native lot ${card.externalId}`);
    const product = this.productJsonLd(html);
    if (product.sku !== undefined && String(product.sku) !== card.procedureNumber) throw new Error(`Roseltorg structured procedure ID does not match lot ${card.externalId}`);
    for (const value of [$('link[rel="canonical"]').attr('href'), $('meta[property="og:url"]').attr('content'), typeof product.url === 'string' ? product.url : undefined]) {
      if (value && this.detailUrl(value, finalUrl, true) !== card.url) throw new Error(`Roseltorg canonical URL does not match native lot ${card.externalId}`);
    }
    if (!this.text(root.find('.lot-title h1').first().text())) throw new Error(`Roseltorg detail for ${card.externalId} has no native title`);
  }

  private isStaleNativeDetail404(error: unknown, card: NativeCard): boolean {
    if (!(error instanceof WebExtractionHttpError) || error.status !== 404) return false;
    try {
      return this.detailUrl(error.url, card.url) === card.url;
    } catch {
      return false;
    }
  }

  private parseDetail(card: NativeCard, listing: PageDocument, window: Window | undefined, document: PageDocument, retainedHtml?: string): RawOpportunityRecord {
    const finalUrl = this.detailUrl(document.finalUrl, card.url);
    this.assertDetail(document.html, finalUrl, card);
    const effectiveHtml = retainedHtml ? this.retainMissingDetail(document.html, retainedHtml) : document.html;
    const $ = load(effectiveHtml);
    const root = $('.lot-page__left-column-lot[data-feature-favorite-lots="lot"]').first();
    const product = this.productJsonLd(effectiveHtml);
    const title = this.text(root.find('.lot-title h1').first().text());
    if (!title) throw new Error(`Roseltorg detail for ${card.externalId} has no native title`);
    const fields: Record<string, string> = {};
    root.find('.lot-common-info__row').each((_, element) => {
      const row = $(element);
      const label = this.text(row.find('.lot-common-info__text').first().text());
      const value = this.text(row.find('.lot-common-info__value').first().text());
      if (label && value) fields[label] = value;
    });
    const offers = this.object(product.offers);
    const publishedText = fields['Публикация извещения'] ?? fields['Дата публикации'];
    const deadlineText = fields['Приём заявок'] ?? fields['Дата и время окончания подачи заявок'];
    const publishedAt = this.nativeDate(offers.validFrom, publishedText, 'publication', card.externalId);
    const deadlineAt = this.nativeDate(offers.validThrough, deadlineText, 'deadline', card.externalId);
    const statusText = this.text(root.find('.lot-status').first().text()) || card.status;
    const section = fields['Торговая секция'] || this.text(root.find('.lot-header-title__platform').first().text()) || card.section || 'Росэлторг';
    const customers = root.find('.customer-item').map((_, element) => {
      const item = $(element);
      return { name: this.text(item.find('.customer-name').first().text()), inn: this.text(item.find('.customer-inn').first().text()).replace(/^ИНН\s*/i, ''), text: this.text(item.text()), html: $.html(element) };
    }).get();
    const customer = customers.map(item => item.name).filter(Boolean).join('; ') || this.sellerName(offers.seller);
    const organizer = fields['Организатор торгов'] || card.organizer;
    const optionalDescription = root.find('.lot-additional-info .lot-expand-text__text').first();
    const descriptionHtml = optionalDescription.html() ?? '';
    const requirements = this.richText(descriptionHtml);
    const objects = root.find('.lot-units__item').map((_, item) => ({ text: this.text($(item).text()), html: $.html(item) })).get();
    const delivery = this.text(root.find('.lot-delivery__text').first().text()) || undefined;
    const documents = this.documents(effectiveHtml, finalUrl);
    const sum = root.find('.lot-price').first();
    const nativePriceText = this.text(sum.text()) || this.structuredPrice(offers) || card.priceText;
    const visibleCurrency = this.text(sum.find('.lot-item__currency').first().text());
    const budget = this.budget(nativePriceText, visibleCurrency, offers.priceCurrency);
    const taxText = this.text((sum.length ? sum : root).find('.lot-price__nds').first().text()) || undefined;
    const procurementMethod = this.text(root.find('.lot-type-name .lot-card-info__value').first().text()) || this.property(product, 'Способ проведения') || card.procurementMethod;
    const description = [
      requirements,
      objects.length ? `Объекты закупки:\n${objects.map(item => item.text).join('\n')}` : '',
      delivery ? `Место поставки: ${delivery}` : '',
      ...Object.entries(fields).map(([label, value]) => `${label}: ${value}`),
      ...customers.map(item => `Заказчик: ${item.text}`),
      nativePriceText ? `Цена лота: ${nativePriceText}` : '',
      procurementMethod ? `Способ проведения: ${procurementMethod}` : '',
      statusText ? `Статус: ${statusText}` : '',
      documents.length ? `Документы:\n${documents.map(item => `${item.label}: ${item.url}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    if (!description) throw new Error(`Roseltorg lot ${card.externalId} has no public procurement body`);
    const tenderData: TenderData = {
      customer, customerInn: customers.map(item => item.inn).filter(Boolean).join('; ') || undefined,
      region: card.region, procurementMethod, contractNumber: card.procedureNumber,
      numberLabel: 'Номер процедуры', procedureNumber: card.procedureNumber, lotNumber: card.lotNumber,
      platform: section, organizer, nativeStatus: statusText, delivery,
      requirementsText: [requirements, ...objects.map(item => item.text)].filter(Boolean).join('\n\n') || undefined,
      procurementObjects: objects.map(item => item.text), priceText: nativePriceText,
      priceKind: budget.kind, taxText, publishedText, deadlineText,
    };
    return {
      externalId: card.externalId, url: finalUrl, type: 'tender', title,
      companyOrClient: customer || organizer, description, publishedAt,
      sourceStatus: this.sourceStatus(statusText),
      rawPayload: {
        list: { ...card, detailUrl: card.url, url: listing.finalUrl, html: card.html },
        detail: { url: finalUrl, html: document.html, ...(retainedHtml ? { effectiveHtml, observedProduct: this.productJsonLd(document.html) } : {}), title, description, customer, organizer, nativeStatus: statusText, publishedAt: publishedAt?.toISOString(), deadlineAt: deadlineAt?.toISOString(), product, fields, descriptionHtml, objects, customers, documents, publishedText, deadlineText, priceText: nativePriceText, taxText, schemaPrice: offers.price, schemaCurrency: offers.priceCurrency },
        collection: { ...(window ? { windowSince: window.since, windowUntil: window.until } : {}), scope: 'anonymous-public-procurement' },
      },
      sourceMetadata: {
        extraction: 'roseltorg-native-public-html', sourceUrl: listing.finalUrl,
        nativeProcedureNumber: card.procedureNumber, nativeLotNumber: card.lotNumber,
        nativeStatus: statusText, publicationText: publishedText, publicationTimezone: publishedAt ? 'Europe/Moscow' : undefined,
        deadlineAt: deadlineAt?.toISOString(), deadlineText,
        location: card.region || delivery, budget, tenderData, sourceDocuments: documents,
        detailAccess: 'anonymous-public-detail', dateUnknown: !publishedAt,
      },
    };
  }

  private retainMissingDetail(freshHtml: string, retainedHtml: string): string {
    const $ = load(freshHtml), old = load(retainedHtml);
    const root = $('.lot-page__left-column-lot[data-feature-favorite-lots="lot"]').first();
    const previous = old('.lot-page__left-column-lot[data-feature-favorite-lots="lot"]').first();
    const freshProduct = this.productJsonLd(freshHtml), priorProduct = this.productJsonLd(retainedHtml);
    const offers = Object.fromEntries(Object.entries(this.object(freshProduct.offers)).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    const effectiveOffers = { ...this.object(priorProduct.offers), ...offers };
    const freshLabels = new Set(root.find('.lot-common-info__row').map((_, node) => this.text($(node).find('.lot-common-info__text').first().text())).get());
    const dateGroups = [
      { key: 'validFrom', labels: ['Публикация извещения', 'Дата публикации'] },
      { key: 'validThrough', labels: ['Приём заявок', 'Дата и время окончания подачи заявок'] },
    ];
    for (const group of dateGroups) {
      if (offers[group.key] !== undefined && !this.isoDate(offers[group.key])) throw new Error(`Roseltorg refresh has an invalid native ${group.key} datetime`);
      if (offers[group.key] === undefined && group.labels.some(label => freshLabels.has(label))) delete effectiveOffers[group.key];
    }
    previous.find('.lot-common-info__row').each((_, node) => {
      const label = this.text(old(node).find('.lot-common-info__text').first().text());
      if (!label || freshLabels.has(label)) return;
      const group = dateGroups.find(group => group.labels.includes(label));
      if (group?.labels.some(label => freshLabels.has(label))) return;
      if (group && offers[group.key] !== undefined) {
        const priorDate = this.moscowDate(this.text(old(node).find('.lot-common-info__value').first().text()));
        const freshDate = this.isoDate(offers[group.key]);
        if (!priorDate || !freshDate || Math.floor(priorDate.getTime() / 60_000) !== Math.floor(freshDate.getTime() / 60_000)) return;
      }
      root.append(old.html(node));
    });
    for (const selector of ['.lot-status', '.lot-price', '.lot-type-name', '.lot-header-title__platform', '.lot-additional-info', '.lot-units__item', '.lot-delivery__text', '.customer-item']) {
      if (root.find(selector).length) continue;
      if (selector === '.lot-price' && (offers.price !== undefined || offers.priceCurrency !== undefined) && this.structuredPrice(effectiveOffers)) continue;
      if (selector === '.customer-item' && this.sellerName(offers.seller)) continue;
      if (selector === '.lot-type-name' && this.property(freshProduct, 'Способ проведения')) continue;
      const priorNodes = previous.find(selector);
      const selected = ['.lot-units__item', '.customer-item'].includes(selector) ? priorNodes : priorNodes.first();
      selected.each((_, node) => { root.append(old.html(node)); });
    }
    if (!root.find('.lot-price').length && !root.find('.lot-price__nds').length) previous.find('.lot-price__nds').first().each((_, node) => { root.append(old.html(node)); });
    if (!$('a.lot-docs__file').length) old('a.lot-docs__file').each((_, node) => { $('body').append(old.html(node)); });
    const effectiveProduct = { ...priorProduct, ...freshProduct, offers: effectiveOffers };
    $('script[type="application/ld+json"]').each((_, node) => {
      if (Object.keys(this.productJsonLd($.html(node))).length) $(node).remove();
    });
    $('<script type="application/ld+json"></script>').text(JSON.stringify(effectiveProduct)).appendTo('head');
    return $.html();
  }

  private collectionWindow(ctx: FetchContext): Window {
    const continuing = ctx.checkpoint.hasMore === true;
    if (continuing) {
      if (ctx.checkpoint.collectionVersion !== 1) throw new Error('Roseltorg continuation has an unsupported collection version');
      const since = this.checkpointString(ctx.checkpoint.windowSince, 'lower publication boundary');
      const until = this.checkpointString(ctx.checkpoint.windowUntil, 'upper publication boundary');
      this.assertWindow(since, until);
      if (ctx.backfillSince && Date.parse(ctx.backfillSince) !== Date.parse(since)) throw new Error('Roseltorg lower publication boundary changed during collection');
      if (ctx.checkpoint.wireSince !== this.wireDate(since) || ctx.checkpoint.wireUntil !== this.wireDate(until)) throw new Error('Roseltorg native publication date filters changed during collection');
      return { since, until };
    }
    if (!Number.isInteger(ctx.backfillDays) || ctx.backfillDays < 1) throw new Error('Roseltorg backfill requires a positive whole number of days');
    const days = Math.min(ctx.backfillDays, 30);
    const now = Date.now();
    const lower = ctx.backfillSince === undefined ? now - days * DAY_MS : Date.parse(ctx.backfillSince);
    if (!Number.isFinite(lower)) throw new Error('Roseltorg has an invalid lower publication boundary');
    const window = { since: new Date(lower).toISOString(), until: new Date(Math.min(now, lower + days * DAY_MS)).toISOString() };
    this.assertWindow(window.since, window.until);
    return window;
  }

  private assertWindow(since: string, until: string): void {
    const lower = Date.parse(since), upper = Date.parse(until);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper || upper - lower > 30 * DAY_MS || new Date(lower).toISOString() !== since || new Date(upper).toISOString() !== until) throw new Error('Roseltorg has invalid fixed publication boundaries');
  }

  private wireDate(value: string): string {
    const moscow = new Date(Date.parse(value) + 3 * 3_600_000).toISOString().slice(0, 10);
    const [year, month, day] = moscow.split('-');
    return `${day}.${month}.${year.slice(-2)}`;
  }

  private listUrl(window: Window, page: number): string {
    const url = new URL(LIST_PATH, ORIGIN);
    url.searchParams.set('sale', '1');
    url.searchParams.set('currency', 'all');
    url.searchParams.set('start_date_published', this.wireDate(window.since));
    url.searchParams.set('end_date_published', this.wireDate(window.until));
    STATUSES.forEach(value => url.searchParams.append('status[]', value));
    url.searchParams.set('page', String(page));
    return url.toString();
  }

  private canonicalListUrl(value: string, window: Window, from = `${ORIGIN}${LIST_PATH}`): string {
    const url = new URL(value, from);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || ![LIST_PATH, '/procedures/search'].includes(url.pathname)) throw new Error('Roseltorg has an invalid native listing URL');
    const expected = { sale: '1', currency: 'all', start_date_published: this.wireDate(window.since), end_date_published: this.wireDate(window.until) };
    const statuses: string[] = [];
    const statusKeys: string[] = [];
    for (const [key, value] of url.searchParams) {
      if (key === 'status[]' || /^status\[[0-5]\]$/.test(key)) { statuses.push(value); statusKeys.push(key); }
      else if (!['page', ...Object.keys(expected)].includes(key)) throw new Error('Roseltorg pagination changes the publication or section filters');
    }
    for (const [key, value] of Object.entries(expected)) {
      if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) throw new Error('Roseltorg pagination changes the fixed catalog filters');
    }
    if (statuses.length !== STATUSES.length || new Set(statuses).size !== STATUSES.length || STATUSES.some(value => !statuses.includes(value))) throw new Error('Roseltorg pagination changes the all-status scope');
    if (!statusKeys.every(key => key === 'status[]') && (statusKeys.includes('status[]') || new Set(statusKeys).size !== STATUSES.length)) throw new Error('Roseltorg pagination has ambiguous status-array filters');
    const pages = url.searchParams.getAll('page');
    if (pages.length !== 1 || !/^(?:0|[1-9]\d*)$/.test(pages[0]) || !Number.isSafeInteger(Number(pages[0]))) throw new Error('Roseltorg pagination has an invalid native page number');
    return this.listUrl(window, Number(pages[0]));
  }

  private currentPageMatches(html: string, from: string, window: Window, page: number): boolean {
    const $ = load(html);
    const controls = $('.pagination__link--active');
    if (!controls.length) return false;
    if (controls.length !== 1) throw new Error('Roseltorg listing has ambiguous native current controls');
    const href = controls.attr('data-href');
    if (!href) throw new Error('Roseltorg native current control has no URL');
    const current = this.canonicalListUrl(href, window, from);
    if (Number(new URL(current).searchParams.get('page')) !== page) throw new Error('Roseltorg native current page disagrees with the requested page');
    const label = controls.clone().children().remove().end().text().trim();
    if (!/^[1-9]\d*$/.test(label) || !Number.isSafeInteger(Number(label)) || Number(label) !== page + 1) throw new Error('Roseltorg native current page label disagrees with the requested page');
    return true;
  }

  private observedNext(html: string, from: string, window: Window, page: number): string | undefined {
    const $ = load(html);
    const controls = $('.pagination__btn--next[rel="next"]');
    if (!controls.length) {
      if ($('.pagination__more-link').length) throw new Error('Roseltorg listing has a more-results control without a native next URL');
      return undefined;
    }
    if (controls.length !== 1) throw new Error('Roseltorg listing has ambiguous native next controls');
    const href = controls.attr('data-href');
    if (!href) throw new Error('Roseltorg native next control has no URL');
    const next = this.canonicalListUrl(href, window, from);
    if (Number(new URL(next).searchParams.get('page')) !== page + 1) throw new Error('Roseltorg native pagination skips, reverses, or repeats a page');
    return next;
  }

  private nativeEmpty(html: string): boolean { return this.text(load(html)('.search-autocomplete__no-result-text').text()).startsWith('Нет результатов, соответствующих всем условиям'); }

  private detailUrl(value: string, from: string, allowNativeHttp = false): string {
    const url = new URL(value, from);
    if (allowNativeHttp && url.protocol === 'http:' && url.hostname === 'www.roseltorg.ru' && !url.port) url.protocol = 'https:';
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.search) throw new Error('Roseltorg has an invalid native detail URL');
    const match = /^\/procedure\/([A-Za-z0-9]+)\/([1-9]\d*)$/.exec(url.pathname);
    if (!match) throw new Error('Roseltorg detail URL is not a native procedure and lot');
    this.assertIdentity(match[1], match[2]);
    return url.toString();
  }

  private assertIdentity(procedure: string, lot: string): void {
    if (!ID.test(procedure) || !LOT.test(lot) || !Number.isSafeInteger(Number(lot))) throw new Error('Roseltorg has an invalid native procedure/lot identity');
  }

  private assertExternalId(value: string): void {
    const parts = value.split(':');
    if (parts.length !== 2) throw new Error('Roseltorg checkpoint has an invalid native lot ID');
    this.assertIdentity(parts[0], parts[1]);
  }

  private validateSource(ctx: ConnectorContext): void { this.validateBaseUrl(ctx.source.config?.baseUrl ?? ctx.source.endpoint?.baseUrl); }

  private validateBaseUrl(value: unknown): void {
    if (value === undefined) return;
    if (typeof value !== 'string') throw new Error('Roseltorg catalog URL must be a string');
    const url = new URL(value);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || url.search || !['/', '/procedures/search', LIST_PATH].includes(url.pathname)) throw new Error('Roseltorg requires its anonymous public catalog without narrowed filters');
  }

  private async extract(stage: string, url: string, ctx: ConnectorContext): Promise<PageDocument> {
    ctx.signal?.throwIfAborted();
    const previous = this.requestTail;
    let release!: () => void;
    const finished = new Promise<void>(resolve => { release = resolve; });
    this.requestTail = previous.then(() => finished);
    let started = false;
    try {
      await waitForTurn(previous, ctx.signal);
      while (this.lastRequestFinishedAt !== undefined) {
        const remaining = Math.ceil(this.lastRequestFinishedAt + REQUEST_INTERVAL_MS - this.clock.now());
        if (remaining <= 0) break;
        await this.clock.wait(remaining, ctx.signal);
        ctx.signal?.throwIfAborted();
      }
      ctx.signal?.throwIfAborted();
      started = true;
      const document = await this.extraction.extractUrl(url, { allowedHosts: ['www.roseltorg.ru'], timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_BYTES, signal: ctx.signal });
      ctx.signal?.throwIfAborted();
      return document;
    } catch (error) {
      if (ctx.signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof WebExtractionHttpError) {
        const failure = new WebExtractionHttpError(error.status, error.url, { accessReason: error.accessReason, retryAfter: error.retryAfter, cause: error });
        failure.message = `Roseltorg ${stage} fetch failed for ${url}: ${error.message}`;
        throw failure;
      }
      throw new Error(`Roseltorg ${stage} fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      if (started) this.lastRequestFinishedAt = this.clock.now();
      release();
    }
  }

  private productJsonLd(html: string): Record<string, unknown> {
    const $ = load(html);
    let product: Record<string, unknown> = {};
    $('script[type="application/ld+json"]').each((_, element) => {
      let value: unknown;
      try { value = JSON.parse($(element).text()); } catch { return; }
      const candidates = Array.isArray(value) ? value : [value, ...this.array(this.object(value)['@graph'])];
      for (const candidate of candidates) {
        const node = this.object(candidate);
        if (node['@type'] === 'Product') product = node;
      }
    });
    return product;
  }

  private documents(html: string, from: string): NativeDocument[] {
    const $ = load(html), result = new Map<string, NativeDocument>();
    $('a.lot-docs__file').each((_, element) => {
      const item = $(element), href = item.attr('href');
      const label = this.text(item.attr('title') || item.text());
      if (!href || !label) return;
      try {
        const url = new URL(href, from);
        const host = url.hostname.toLowerCase();
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.port || !(host === 'roseltorg.ru' || host.endsWith('.roseltorg.ru') || host === 'zakupki.gov.ru' || host.endsWith('.zakupki.gov.ru'))) return;
        result.set(url.toString(), { label, url: url.toString() });
      } catch { /* An unsafe attachment is never fetched or exposed as a document. */ }
    });
    return [...result.values()];
  }

  private nativeDate(structured: unknown, text: string | undefined, field: string, id: string): Date | undefined {
    const iso = this.isoDate(structured), local = this.moscowDate(text);
    if (iso && local && Math.floor(iso.getTime() / 60_000) !== Math.floor(local.getTime() / 60_000)) throw new Error(`Roseltorg ${field} datetime disagrees between native fields for ${id}`);
    return iso ?? local;
  }

  private isoDate(value: unknown): Date | undefined {
    if (typeof value !== 'string') return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return undefined;
    const offset = match[7] === 'Z' ? 0 : (match[7][0] === '-' ? -1 : 1) * (Number(match[7].slice(1, 3)) * 60 + Number(match[7].slice(4, 6)));
    if (Math.abs(offset) > 14 * 60 || Number(match[7].slice(4, 6)) > 59) return undefined;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19) !== value.slice(0, 19)) return undefined;
    return date;
  }

  private moscowDate(value?: string): Date | undefined {
    const match = /^(?:до\s+)?(\d{2})\.(\d{2})\.(\d{2}|\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*(?:\(МСК\))?$/.exec(value ?? '');
    if (!match) return undefined;
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return this.isoDate(`${year}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6] ?? '00'}+03:00`);
  }

  private budget(text: string | undefined, visibleCurrency: string, schemaCurrency: unknown): { amount?: number; currency?: string; originalText?: string; kind: string } {
    if (!text || /не указано|не определен/i.test(text)) return { originalText: text, kind: 'unpublished-lot-price' };
    const match = /\d[\d\s\u00a0]*(?:[.,]\d{1,2})?/.exec(text);
    const amount = match ? Number(match[0].replace(/[\s\u00a0]/g, '').replace(',', '.')) : undefined;
    const currencyText = `${visibleCurrency} ${text}`;
    const currency = /₽|руб|RUB/i.test(currencyText) ? 'RUB' : /\$|USD/i.test(currencyText) ? 'USD' : /€|EUR/i.test(currencyText) ? 'EUR' : typeof schemaCurrency === 'string' && /^[A-Z]{3}$/.test(schemaCurrency) ? schemaCurrency : undefined;
    return { amount: Number.isFinite(amount) ? amount : undefined, currency, originalText: text, kind: amount === 0 ? 'published-zero-lot-price' : 'published-initial-lot-price' };
  }

  private structuredPrice(offers: Record<string, unknown>): string | undefined {
    const value = typeof offers.price === 'string' || typeof offers.price === 'number' ? String(offers.price) : '';
    if (!/^\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0 || typeof offers.priceCurrency !== 'string' || !/^[A-Z]{3}$/.test(offers.priceCurrency)) return undefined;
    return `${value} ${offers.priceCurrency}`;
  }

  private sourceStatus(value?: string): RawOpportunityRecord['sourceStatus'] {
    if (/^(?:При[её]м заявок|Ожидание приема заявок)/i.test(value ?? '')) return 'Active';
    if (/Процедура отменена/i.test(value ?? '')) return 'Removed';
    if (/Работа комиссии|Процедура завершена|Завершен/i.test(value ?? '')) return 'Closed';
    return 'Unknown';
  }

  private sellerName(value: unknown): string | undefined {
    const names = this.array(value).map(item => this.object(item)).map(item => typeof item.legalName === 'string' ? item.legalName : typeof item.name === 'string' ? item.name : '').filter(Boolean);
    return names.join('; ') || undefined;
  }

  private property(product: Record<string, unknown>, name: string): string | undefined {
    const item = this.array(product.additionalProperty).map(value => this.object(value)).find(value => value.name === name);
    return typeof item?.value === 'string' ? item.value : undefined;
  }

  private checkpointString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value) throw new Error(`Roseltorg continuation is missing its ${label}`);
    return value;
  }

  private checkpointStrings(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item) || new Set(value).size !== value.length) throw new Error(`Roseltorg continuation has invalid ${label}`);
    return value as string[];
  }

  private checkpointStaleDetail404Ids(checkpoint: Record<string, unknown>): string[] {
    const ids = checkpoint.staleDetail404Ids === undefined ? [] : this.checkpointStrings(checkpoint.staleDetail404Ids, 'stale detail 404 IDs');
    for (const id of ids) this.assertExternalId(id);
    if (checkpoint.staleDetail404 !== undefined) {
      if (!Number.isSafeInteger(checkpoint.staleDetail404) || checkpoint.staleDetail404 !== ids.length) throw new Error('Roseltorg continuation has invalid stale detail 404 count');
    }
    return ids;
  }

  private object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  private array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
  private text(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
  private richText(html: string): string {
    return load(html.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')).text().split('\n').map(line => this.text(line)).filter(Boolean).join('\n');
  }
}

function waitForTurn(turn: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return turn;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    turn.then(() => { signal.removeEventListener('abort', abort); resolve(); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
