import { createHash } from 'node:crypto';
import { load, CheerioAPI } from 'cheerio';
import { fetch as undiciFetch } from 'undici';

import { SourceStatus } from '../../opportunities/schemas/opportunity.schema';
import { createPinnedDispatcher } from '../extraction/pinned-fetch';
import { assertAllowedHost, assertPublicHttpUrl } from '../extraction/url-safety';
import { WebExtractionHttpError, WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorCheckpoint, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { stringValue } from './connector-utils';

const ORIGIN = 'https://www.b2b-center.ru';
const NATIVE_SEARCH_PATH = '/site/api/v1/market-search/';
const PARSER_VERSION = 'b2b-center-native-public-v1';
const MAX_BACKFILL_DAYS = 30;
const PAGE_SIZE = 20;
const MAX_NATIVE_BYTES = 1_500_000;
const MAX_DETAIL_BYTES = 1_000_000;
const ALLOWED_HOSTS = ['www.b2b-center.ru'];
const MACRO_TRADE_TYPES = ['buy', 'sell'] as const;
const ANONYMOUS_PAGINATION_LIMIT = 'anonymous B2B-Center guest search returns mode=guest and exposes page_count while public UI disables pagination controls; only the first public page per buy/sell macro is accessible without an account';
const ANONYMOUS_PAGINATION_TERMINAL_REASON = 'native-anonymous-pagination-boundary';
const FULL_CATALOG_PUBLIC_ACCESS = 'registration-required-for-full-catalog';

type MacroTradeType = typeof MACRO_TRADE_TYPES[number];

type NativeHttpResult = {
  status: number;
  finalUrl: string;
  contentType?: string;
  text: string;
  retryAfter?: string;
};

type NativeHttp = (url: string, options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }) => Promise<NativeHttpResult>;

export type B2bCenterNativeCard = {
  id: string;
  nativeKey: string;
  sphinxId?: string;
  macroTradeType: MacroTradeType;
  url: string;
  canonicalDetailUrl: string;
  title: string;
  companyOrClient?: string;
  description?: string;
  publishedAt?: Date;
  publishedText?: string;
  deadlineAt?: Date;
  deadlineText?: string;
  priceText?: string;
  region?: string;
  tags?: string;
  volume?: Record<string, unknown>;
  isSimplePurchase?: boolean;
  raw: Record<string, unknown>;
};

export type B2bCenterNativePage = {
  cards: B2bCenterNativeCard[];
  pageCount?: number;
  currentSort?: string;
  tabs: { type: string; name?: string; count?: number }[];
  mode?: string;
  raw: Record<string, unknown>;
};

export type B2bCenterCard = {
  id: string;
  url: string;
  canonicalDetailUrl: string;
  category?: string;
  title: string;
  companyOrClient?: string;
  description?: string;
  publishedAt?: Date;
  publishedText?: string;
  deadlineAt?: Date;
  deadlineText?: string;
  quantityText?: string;
  priceText?: string;
  region?: string;
  html: string;
  rawText: string;
};

type B2bCenterWindow = {
  since: Date;
  until: Date;
  sinceIso: string;
  untilIso: string;
  sinceDmy: string;
  untilDmy: string;
};

type B2bCenterCheckpoint = ConnectorCheckpoint & {
  parserVersion?: string;
  hasMore?: boolean;
  nextUrl?: string;
  page?: number;
  pageSize?: number;
  macroIndex?: number;
  macroTradeType?: MacroTradeType;
  windowSince?: string;
  windowUntil?: string;
  dateStartDmy?: string;
  dateEndDmy?: string;
  seenNativeIds?: string[];
  visitedNativePages?: string[];
  completedMacroTradeTypes?: MacroTradeType[];
  activePublicCount?: number;
  archivePublicCount?: number;
  totalPublicCount?: number;
  sellActivePublicCount?: number;
  sellTotalPublicCount?: number;
  terminalReason?: string;
  coverage?: string;
  incomplete?: boolean;
  completenessLimit?: string;
  publicAccess?: string;
  fullCatalogRequiresCredentials?: boolean;
};

type DetailFacts = {
  title?: string;
  description?: string;
  rows: Record<string, string>;
  documents: { label: string; url: string }[];
  statusText?: string;
  statusSummary?: string;
  publicAccessGap?: string;
  htmlHash: string;
};

export class B2bCenterConnector implements Connector {
  readonly id = 'b2b-center';
  readonly family = 'TenderPlatform' as const;

  constructor(
    private readonly webExtraction: WebExtractionService,
    private readonly nativeHttp: NativeHttp = defaultNativeHttp,
  ) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(): Promise<ValidationResult> {
    return { ok: true, message: 'B2B-Center anonymous native market search configured', details: { parserVersion: PARSER_VERSION, baseUrl: `${ORIGIN}${NATIVE_SEARCH_PATH}`, macroTradeTypes: MACRO_TRADE_TYPES, maxBackfillDays: MAX_BACKFILL_DAYS } };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1 });
      return { state: 'Healthy', message: `B2B-Center native API returned ${page.stats.seen} public records`, checkedAt: new Date(), details: { records: page.records.length, hasMore: page.hasMore, incomplete: page.checkpoint.incomplete, terminalReason: page.checkpoint.terminalReason } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'B2B-Center health check failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const checkpoint = ctx.checkpoint as B2bCenterCheckpoint;
    const continuing = checkpoint.hasMore === true;
    const window = this.collectionWindow(ctx, continuing, checkpoint);
    const seen = new Set(this.stringArray(continuing ? checkpoint.seenNativeIds : undefined));
    const visited = new Set(this.stringArray(continuing ? checkpoint.visitedNativePages : undefined));
    const completed = new Set((Array.isArray(checkpoint.completedMacroTradeTypes) ? checkpoint.completedMacroTradeTypes : []).filter((item): item is MacroTradeType => this.isMacroTradeType(item)));

    if (!continuing) {
      return this.fetchInitialNativePages(ctx, window, seen, visited, completed);
    }

    const macroIndex = this.numberValue(checkpoint.macroIndex) ?? 0;
    const macroTradeType = this.macroAt(macroIndex);
    if (!macroTradeType) return this.emptyComplete(window, seen, visited, completed, 'native-macros-complete');
    const page = this.numberValue(checkpoint.page) ?? 2;
    return this.fetchOneNativePage(ctx, window, seen, visited, completed, macroIndex, macroTradeType, page);
  }

  checkpoint(result: FetchPage): ConnectorCheckpoint {
    return result.checkpoint;
  }

  mapRetainedPayload(rawPayload: Record<string, unknown>, sourceMetadata: Record<string, unknown> = {}): RawOpportunityRecord {
    const native = this.recordValue(rawPayload.native);
    const trade = this.recordValue(native?.trade);
    if (!native || !trade) throw new Error('B2B-Center retained raw payload is missing native trade data');
    const macroTradeType = stringValue(sourceMetadata.macroTradeType);
    if (!this.isMacroTradeType(macroTradeType)) throw new Error('B2B-Center retained source metadata is missing macroTradeType');
    const listUrl = this.safeNativeSearchUrl(stringValue(native.url) ?? stringValue(sourceMetadata.sourceUrl), 'retained native source URL');
    const card = parseNativeTrade(trade, macroTradeType, listUrl);
    const retainedNativeKey = stringValue(sourceMetadata.nativeKey);
    if (retainedNativeKey && retainedNativeKey !== card.nativeKey) throw new Error('B2B-Center retained native key does not match native trade data');
    const retainedDetailUrl = stringValue(native.detailUrl);
    if (retainedDetailUrl && this.safeDetailUrl(retainedDetailUrl, card.id) !== card.canonicalDetailUrl) throw new Error('B2B-Center retained native detail URL does not match native trade data');
    const detail = this.retainedDetail(rawPayload.detail, card);
    return this.buildRecord(card, detail, listUrl, undefined, rawPayload, sourceMetadata);
  }

  private async fetchInitialNativePages(ctx: FetchContext, window: B2bCenterWindow, seen: Set<string>, visited: Set<string>, completed: Set<MacroTradeType>): Promise<FetchPage> {
    const records: RawOpportunityRecord[] = [];
    const stats = { seen: 0 };
    const firstPageFacts: Record<string, unknown> = {};
    let firstNext: { macroIndex: number; macroTradeType: MacroTradeType; page: number; nextUrl: string; incomplete?: string } | undefined;
    let completenessLimit: string | undefined;

    for (let macroIndex = 0; macroIndex < MACRO_TRADE_TYPES.length; macroIndex += 1) {
      const macroTradeType = MACRO_TRADE_TYPES[macroIndex];
      const result = await this.fetchNativeCards(ctx, window, seen, visited, macroTradeType, 1, true);
      stats.seen += result.parsed.cards.length;
      records.push(...result.records);
      Object.assign(firstPageFacts, this.publicCounts(result.parsed, macroTradeType));
      const next = this.nextNativePage(result.parsed, macroIndex, macroTradeType, 1, window, result.observedAllOlder);
      if (next && this.isAnonymousGuestPage(result.parsed)) {
        completed.add(macroTradeType);
        completenessLimit ??= ANONYMOUS_PAGINATION_LIMIT;
      } else if (next && !firstNext) {
        firstNext = next;
      }
      if (!next) completed.add(macroTradeType);
    }

    return {
      records,
      hasMore: Boolean(firstNext),
      nextPage: firstNext?.page,
      checkpoint: this.checkpointPayload(window, seen, visited, completed, {
        ...firstPageFacts,
        hasMore: Boolean(firstNext),
        nextUrl: firstNext?.nextUrl,
        page: firstNext?.page,
        macroIndex: firstNext?.macroIndex,
        macroTradeType: firstNext?.macroTradeType,
        incomplete: Boolean(firstNext?.incomplete ?? completenessLimit),
        completenessLimit: firstNext?.incomplete ?? completenessLimit,
        terminalReason: firstNext ? undefined : completenessLimit ? ANONYMOUS_PAGINATION_TERMINAL_REASON : records.length === 0 ? 'native-empty-result' : 'native-macros-complete',
        publicAccess: completenessLimit ? FULL_CATALOG_PUBLIC_ACCESS : undefined,
        fullCatalogRequiresCredentials: completenessLimit ? true : undefined,
      }),
      stats,
    };
  }

  private async fetchOneNativePage(ctx: FetchContext, window: B2bCenterWindow, seen: Set<string>, visited: Set<string>, completed: Set<MacroTradeType>, macroIndex: number, macroTradeType: MacroTradeType, page: number): Promise<FetchPage> {
    const result = await this.fetchNativeCards(ctx, window, seen, visited, macroTradeType, page, false);
    if (result.repeatedAllKnown && this.isAnonymousGuestPage(result.parsed)) {
      for (const type of MACRO_TRADE_TYPES) completed.add(type);
      return {
        records: [],
        hasMore: false,
        checkpoint: this.checkpointPayload(window, seen, visited, completed, {
          ...this.publicCounts(result.parsed, macroTradeType),
          hasMore: false,
          incomplete: true,
          completenessLimit: ANONYMOUS_PAGINATION_LIMIT,
          terminalReason: ANONYMOUS_PAGINATION_TERMINAL_REASON,
          publicAccess: FULL_CATALOG_PUBLIC_ACCESS,
          fullCatalogRequiresCredentials: true,
        }),
        stats: { seen: result.parsed.cards.length },
      };
    }
    const next = this.nextNativePage(result.parsed, macroIndex, macroTradeType, page, window, result.observedAllOlder) ?? this.nextMacroPage(macroIndex, window, completed);
    if (!this.nextNativePage(result.parsed, macroIndex, macroTradeType, page, window, result.observedAllOlder)) completed.add(macroTradeType);
    return {
      records: result.records,
      hasMore: Boolean(next),
      nextPage: next?.page,
      checkpoint: this.checkpointPayload(window, seen, visited, completed, {
        ...this.publicCounts(result.parsed, macroTradeType),
        hasMore: Boolean(next),
        nextUrl: next?.nextUrl,
        page: next?.page,
        macroIndex: next?.macroIndex,
        macroTradeType: next?.macroTradeType,
        incomplete: Boolean(next && 'incomplete' in next && next.incomplete),
        completenessLimit: next && 'incomplete' in next ? next.incomplete : undefined,
        terminalReason: next ? undefined : result.observedAllOlder ? 'fixed-window-exhausted' : result.parsed.cards.length === 0 ? 'native-empty-result' : 'native-macros-complete',
      }),
      stats: { seen: result.parsed.cards.length },
    };
  }

  private async fetchNativeCards(ctx: FetchContext, window: B2bCenterWindow, seen: Set<string>, visited: Set<string>, macroTradeType: MacroTradeType, page: number, allowFirstPageRepeat: boolean): Promise<{ parsed: B2bCenterNativePage; records: RawOpportunityRecord[]; observedAllOlder: boolean; repeatedAllKnown: boolean }> {
    const nativeUrl = this.nativeSearchUrl(ctx, window, macroTradeType, page);
    if (visited.has(nativeUrl)) throw new Error(`B2B-Center native pagination cycle detected at ${nativeUrl}`);
    const response = await this.fetchNativeJson(nativeUrl, ctx);
    const finalUrl = this.safeNativeSearchUrl(response.finalUrl, 'final native URL');
    if (finalUrl !== nativeUrl) throw new Error('B2B-Center native search redirected away from the requested public API URL');
    const parsed = parseB2bCenterNativeSearch(response.text, { macroTradeType, page, pageSize: PAGE_SIZE, sort: 'date_desc', url: finalUrl });
    const candidates = parsed.cards.filter((card) => !card.publishedAt || (card.publishedAt >= window.since && card.publishedAt <= window.until));
    const newCards: B2bCenterNativeCard[] = [];
    for (const card of candidates) {
      if (seen.has(card.nativeKey)) continue;
      seen.add(card.nativeKey);
      newCards.push(card);
    }
    const repeatedAllKnown = !allowFirstPageRepeat && candidates.length > 0 && newCards.length === 0;
    if (repeatedAllKnown && !this.isAnonymousGuestPage(parsed)) throw new Error(`B2B-Center native page repeats all previously seen IDs at ${finalUrl}; pagination is incomplete`);

    const records: RawOpportunityRecord[] = [];
    for (const card of newCards) {
      ctx.signal?.throwIfAborted();
      const record = await this.record(card, ctx, finalUrl, window);
      if (record) records.push(record);
    }

    visited.add(finalUrl);
    return { parsed, records, observedAllOlder: parsed.cards.length > 0 && parsed.cards.every((card) => card.publishedAt && card.publishedAt < window.since), repeatedAllKnown };
  }

  private nextNativePage(parsed: B2bCenterNativePage, macroIndex: number, macroTradeType: MacroTradeType, page: number, window: B2bCenterWindow, observedAllOlder: boolean): { macroIndex: number; macroTradeType: MacroTradeType; page: number; nextUrl: string; incomplete?: string } | undefined {
    if (observedAllOlder) return undefined;
    if (!parsed.pageCount || page >= parsed.pageCount) return undefined;
    const nextPage = page + 1;
    return { macroIndex, macroTradeType, page: nextPage, nextUrl: this.nativeSearchUrlFor(window, macroTradeType, nextPage), incomplete: 'anonymous native API exposes page_count but page>1 is treated as unverified until a non-repeating page is observed' };
  }

  private isAnonymousGuestPage(parsed: B2bCenterNativePage): boolean {
    return parsed.mode === 'guest';
  }

  private nextMacroPage(macroIndex: number, window: B2bCenterWindow, completed: Set<MacroTradeType>): { macroIndex: number; macroTradeType: MacroTradeType; page: number; nextUrl: string } | undefined {
    for (let nextIndex = macroIndex + 1; nextIndex < MACRO_TRADE_TYPES.length; nextIndex += 1) {
      const macroTradeType = MACRO_TRADE_TYPES[nextIndex];
      if (!completed.has(macroTradeType)) return { macroIndex: nextIndex, macroTradeType, page: 1, nextUrl: this.nativeSearchUrlFor(window, macroTradeType, 1) };
    }
    return undefined;
  }

  private async fetchNativeJson(url: string, ctx: FetchContext): Promise<NativeHttpResult> {
    try {
      const result = await this.nativeHttp(url, { timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_NATIVE_BYTES, signal: ctx.signal });
      if (result.status === 429) throw new ConnectorRateLimitError('B2B-Center native API rate limited', retryAfterSeconds(result.retryAfter) ?? 60);
      if (result.status < 200 || result.status >= 300) throw new WebExtractionHttpError(result.status, url);
      const contentType = result.contentType ?? '';
      if (!contentType.includes('application/json')) throw new Error(`B2B-Center native API returned unsupported content type: ${contentType || 'unknown'}`);
      return result;
    } catch (error) {
      if (error instanceof ConnectorRateLimitError) throw error;
      if (error instanceof WebExtractionHttpError && error.status === 429) throw new ConnectorRateLimitError('B2B-Center native API rate limited', 60);
      throw error;
    }
  }

  private nativeSearchUrl(ctx: FetchContext, window: B2bCenterWindow, macroTradeType: MacroTradeType, page: number): string {
    const endpoint = this.recordValue(ctx.source.endpoint) ?? {};
    const config = this.recordValue(ctx.source.config) ?? {};
    const configured = stringValue(config.listUrl) ?? stringValue(endpoint.baseUrl) ?? `${ORIGIN}${NATIVE_SEARCH_PATH}`;
    const url = new URL(configured, ORIGIN);
    if (url.hostname !== 'www.b2b-center.ru') return this.nativeSearchUrlFor(window, macroTradeType, page);
    return this.nativeSearchUrlFor(window, macroTradeType, page);
  }

  private nativeSearchUrlFor(window: B2bCenterWindow, macroTradeType: MacroTradeType, page: number): string {
    const url = new URL(NATIVE_SEARCH_PATH, ORIGIN);
    url.searchParams.set('date_start_dmy', window.sinceDmy);
    url.searchParams.set('date_end_dmy', window.untilDmy);
    url.searchParams.set('macro_trade_type', macroTradeType);
    url.searchParams.set('tab', 'all');
    url.searchParams.set('sort', 'date_desc');
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', String(PAGE_SIZE));
    url.searchParams.set('is_seo', '0');
    return url.toString();
  }

  private async record(card: B2bCenterNativeCard, ctx: FetchContext, listUrl: string, window: B2bCenterWindow): Promise<RawOpportunityRecord | null> {
    const detail = await this.fetchDetail(card, ctx);
    if (detail?.title && !titlesCompatible(detail.title, card.title)) throw new Error(`B2B-Center detail title differs from native list title for ${card.id}`);
    const detailPublishedAt = this.moscowDate(detail?.rows?.['Дата публикации']);
    if (detailPublishedAt && (detailPublishedAt < window.since || detailPublishedAt > window.until)) return null;
    return this.buildRecord(card, detail, listUrl, window);
  }

  private buildRecord(card: B2bCenterNativeCard, detail: DetailFacts | undefined, listUrl: string, window?: B2bCenterWindow, rawPayloadOverride?: Record<string, unknown>, retainedSourceMetadata: Record<string, unknown> = {}): RawOpportunityRecord {
    if (detail?.title && !titlesCompatible(detail.title, card.title)) throw new Error(`B2B-Center detail title differs from native list title for ${card.id}`);
    const detailRows = detail?.rows ?? {};
    const title = detail?.title ?? card.title;
    const description = [detail?.description, card.description, card.tags ? `Категория: ${card.tags}` : undefined]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join('\n\n') || card.description || title;
    const companyOrClient = detailRows['Организатор'] ?? card.companyOrClient;
    const detailPublishedAt = this.moscowDate(detailRows['Дата публикации']);
    const publishedAt = detailPublishedAt ?? card.publishedAt;
    const deadlineAt = this.moscowDate(detailRows['Дата окончания подачи заявок']) ?? card.deadlineAt;
    const priceText = detailRows['Общая стоимость закупки'] ?? card.priceText;
    const budget = this.budget(priceText, detailRows['Вид валюты']);
    const location = this.locationFromRows(detailRows) ?? card.region;
    const statusText = detail?.statusText ?? detail?.statusSummary;
    const sourceStatus = this.sourceStatus(statusText, deadlineAt);
    const tenderData = this.omitUndefined({
      platform: 'B2B-Center',
      parserVersion: PARSER_VERSION,
      procedureNumber: card.id,
      contractNumber: card.id,
      sphinxId: card.sphinxId,
      nativeKey: card.nativeKey,
      macroTradeType: card.macroTradeType,
      nativeStatus: statusText,
      tags: card.tags,
      quantityText: detailRows['Количество'] ?? this.volumeText(card.volume),
      volume: card.volume,
      priceText,
      priceKind: budget.kind,
      taxText: detailRows['При выборе победителя учитывается'],
      organizer: companyOrClient,
      customer: companyOrClient,
      paymentTerms: detailRows['Условия оплаты'],
      deliveryTerms: detailRows['Условия поставки'],
      deliveryAddress: detailRows['Адрес места поставки товара, проведения работ или оказания услуг'],
      place: detailRows['Место проведения процедуры'],
      lastEditedText: detailRows['Дата последнего редактирования'],
      sourceDateField: 'date_start_dmy/date_end_dmy',
    });
    const retainedWindowSince = stringValue(retainedSourceMetadata.windowSince);
    const retainedWindowUntil = stringValue(retainedSourceMetadata.windowUntil);
    return {
      externalId: card.nativeKey,
      url: card.canonicalDetailUrl,
      type: 'tender',
      title,
      companyOrClient,
      description,
      publishedAt,
      sourceStatus,
      rawPayload: rawPayloadOverride ?? this.omitUndefined({
        native: { url: listUrl, trade: card.raw, publishedText: card.publishedText, deadlineText: card.deadlineText, detailUrl: card.canonicalDetailUrl },
        detail: detail ? { url: card.canonicalDetailUrl, rows: detail.rows, title: detail.title, description: detail.description, statusText: detail.statusText, statusSummary: detail.statusSummary, documents: detail.documents, htmlHash: detail.htmlHash, publicAccessGap: detail.publicAccessGap } : undefined,
      }),
      sourceMetadata: this.omitUndefined({
        extraction: 'public-native-json',
        parserVersion: PARSER_VERSION,
        sourceUrl: listUrl,
        macroTradeType: card.macroTradeType,
        nativeKey: card.nativeKey,
        location,
        area: location,
        locations: location ? [location] : undefined,
        publishedText: detailRows['Дата публикации'] ?? card.publishedText,
        deadlineAt: deadlineAt?.toISOString(),
        deadlineText: detailRows['Дата окончания подачи заявок'] ?? card.deadlineText,
        deadlinePrecision: deadlineAt ? 'minute' : undefined,
        deadlineTimezone: deadlineAt ? 'Europe/Moscow' : undefined,
        budget,
        tenderData,
        sourceDocuments: detail?.documents.length ? detail.documents : [],
        detailAvailability: detail ? 'verified-public-html' : 'public-detail-unavailable',
        publicAccessGap: detail?.publicAccessGap,
        windowSince: window?.sinceIso ?? retainedWindowSince,
        windowUntil: window?.untilIso ?? retainedWindowUntil,
      }),
    };
  }

  private retainedDetail(value: unknown, card: B2bCenterNativeCard): DetailFacts | undefined {
    const raw = this.recordValue(value);
    if (!raw) return undefined;
    const rowsRaw = this.recordValue(raw.rows) ?? {};
    const rows = Object.fromEntries(Object.entries(rowsRaw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    let title = stringValue(raw.title);
    if (title && hasRegistrationControlText(title)) title = card.title;
    if (title && !titlesCompatible(title, card.title)) throw new Error(`B2B-Center retained detail title differs from native list title for ${card.id}`);
    const documents = Array.isArray(raw.documents) ? raw.documents.map((item) => this.retainedDocument(item)).filter((item): item is { label: string; url: string } => Boolean(item)) : [];
    return {
      title,
      description: stringValue(raw.description),
      rows,
      documents,
      statusText: stringValue(raw.statusText),
      statusSummary: stringValue(raw.statusSummary),
      publicAccessGap: stringValue(raw.publicAccessGap),
      htmlHash: stringValue(raw.htmlHash) ?? createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
    };
  }

  private retainedDocument(value: unknown): { label: string; url: string } | undefined {
    const raw = this.recordValue(value);
    const label = stringValue(raw?.label);
    const url = stringValue(raw?.url);
    if (!label || !url) return undefined;
    return { label, url };
  }

  private async fetchDetail(card: B2bCenterNativeCard, ctx: FetchContext): Promise<DetailFacts | undefined> {
    try {
      const document = await this.webExtraction.extractUrl(card.canonicalDetailUrl, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_DETAIL_BYTES, signal: ctx.signal });
      ctx.signal?.throwIfAborted();
      const finalUrl = this.safeDetailUrl(document.finalUrl, card.id);
      if (finalUrl !== card.canonicalDetailUrl) throw new Error('B2B-Center detail redirected to a different tender');
      return parseB2bCenterDetail(document.html, finalUrl, card.id);
    } catch (error) {
      if (error instanceof WebExtractionHttpError && error.status === 429) throw new ConnectorRateLimitError('B2B-Center detail rate limited', 60);
      if (error instanceof WebExtractionHttpError && error.status === 404) return undefined;
      if (error instanceof ConnectorRateLimitError) throw error;
      throw error;
    }
  }

  private collectionWindow(ctx: FetchContext, continuing: boolean, checkpoint: B2bCenterCheckpoint): B2bCenterWindow {
    if (continuing && checkpoint.windowSince && checkpoint.windowUntil && checkpoint.dateStartDmy && checkpoint.dateEndDmy) {
      return { since: new Date(checkpoint.windowSince), until: new Date(checkpoint.windowUntil), sinceIso: checkpoint.windowSince, untilIso: checkpoint.windowUntil, sinceDmy: checkpoint.dateStartDmy, untilDmy: checkpoint.dateEndDmy };
    }
    const now = Date.now();
    const days = Math.min(Math.max(ctx.backfillDays || MAX_BACKFILL_DAYS, 1), MAX_BACKFILL_DAYS);
    const lower = ctx.backfillSince ? Date.parse(ctx.backfillSince) : now - days * 86_400_000;
    if (!Number.isFinite(lower) || lower > now) throw new Error('B2B-Center original publication boundary is invalid');
    const since = new Date(lower);
    const until = new Date(Math.min(now, lower + days * 86_400_000));
    return { since, until, sinceIso: since.toISOString(), untilIso: until.toISOString(), sinceDmy: this.dmy(since), untilDmy: this.dmy(until) };
  }

  private safeNativeSearchUrl(value: string | undefined, label: string): string {
    if (!value) throw new Error(`B2B-Center ${label} is missing`);
    const url = new URL(value, ORIGIN);
    if (url.protocol !== 'https:' || url.hostname !== 'www.b2b-center.ru' || !url.pathname.startsWith(NATIVE_SEARCH_PATH)) throw new Error(`B2B-Center ${label} must be the public native market-search API URL`);
    return url.toString();
  }

  private safeDetailUrl(value: string, expectedId: string): string {
    const url = new URL(value, ORIGIN);
    if (url.protocol !== 'https:' || url.hostname !== 'www.b2b-center.ru') throw new Error('B2B-Center detail URL host is not allowed');
    const match = /\/(?:app\/market-next|market)\/[^?#]+\/tenders?-(\d+)\/?$/i.exec(url.pathname);
    if (!match || match[1] !== expectedId) throw new Error('B2B-Center detail URL does not match the native tender identity');
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  private sourceStatus(text: string | undefined, deadlineAt: Date | undefined): SourceStatus {
    const normalized = (text ?? '').toLowerCase();
    if (/архив|заверш|подвел итоги|выбрал победителя/.test(normalized)) return 'Closed';
    if (deadlineAt && deadlineAt.getTime() < Date.now()) return 'Closed';
    return deadlineAt ? 'Active' : 'Unknown';
  }

  private budget(text: string | undefined, currencyText: string | undefined): { amount?: number; currency?: string; originalText?: string; kind: string } {
    const originalText = text?.trim();
    const currency = /руб|₽/i.test(`${currencyText ?? ''} ${text ?? ''}`) ? 'RUB' : undefined;
    if (!originalText) return { currency, kind: 'unknown' };
    if (/без указания цены|не указ/i.test(originalText)) return { currency, originalText, kind: 'unpublished-lot-price' };
    const amount = this.moneyAmount(originalText);
    return { amount, currency, originalText, kind: amount === undefined ? 'text' : 'amount' };
  }

  private moneyAmount(text: string): number | undefined {
    const match = /\d[\d\s]*(?:[,.]\d{1,2})?/.exec(text.replace(/\u00a0/g, ' '));
    if (!match) return undefined;
    const value = Number(match[0].replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(value) ? value : undefined;
  }

  private locationFromRows(rows: Record<string, string>): string | undefined {
    return rows['Адрес места поставки товара, проведения работ или оказания услуг'];
  }

  private moscowDate(value?: string): Date | undefined {
    return moscowDate(value);
  }

  private dmy(date: Date): string {
    const moscow = new Date(date.getTime() + 3 * 3_600_000);
    return `${String(moscow.getUTCDate()).padStart(2, '0')}.${String(moscow.getUTCMonth() + 1).padStart(2, '0')}.${moscow.getUTCFullYear()}`;
  }

  private volumeText(value: Record<string, unknown> | undefined): string | undefined {
    if (!value) return undefined;
    const type = stringValue(value.type);
    const count = this.numberValue(value.count);
    const units = stringValue(value.units);
    return [type, count, units].filter((part) => part !== undefined && part !== '').join(' ') || undefined;
  }

  private checkpointPayload(window: B2bCenterWindow, seen: Set<string>, visited: Set<string>, completed: Set<MacroTradeType>, extra: Record<string, unknown>): B2bCenterCheckpoint {
    return this.omitUndefined({
      parserVersion: PARSER_VERSION,
      pageSize: PAGE_SIZE,
      windowSince: window.sinceIso,
      windowUntil: window.untilIso,
      dateStartDmy: window.sinceDmy,
      dateEndDmy: window.untilDmy,
      seenNativeIds: [...seen],
      visitedNativePages: [...visited],
      completedMacroTradeTypes: [...completed],
      coverage: 'public-native-market-search-json-buy-and-sell-with-public-detail-pages',
      ...extra,
    }) as B2bCenterCheckpoint;
  }

  private emptyComplete(window: B2bCenterWindow, seen: Set<string>, visited: Set<string>, completed: Set<MacroTradeType>, terminalReason: string): FetchPage {
    return { records: [], hasMore: false, checkpoint: this.checkpointPayload(window, seen, visited, completed, { hasMore: false, terminalReason }), stats: { seen: 0 } };
  }

  private publicCounts(parsed: B2bCenterNativePage, macroTradeType: MacroTradeType): Record<string, unknown> {
    const actual = parsed.tabs.find((tab) => tab.type === 'actual')?.count;
    const archive = parsed.tabs.find((tab) => tab.type === 'archive')?.count;
    const total = parsed.tabs.find((tab) => tab.type === 'all')?.count;
    return macroTradeType === 'sell'
      ? { sellActivePublicCount: actual, sellArchivePublicCount: archive, sellTotalPublicCount: total }
      : { activePublicCount: actual, archivePublicCount: archive, totalPublicCount: total };
  }

  private macroAt(index: number): MacroTradeType | undefined {
    return MACRO_TRADE_TYPES[index];
  }

  private isMacroTradeType(value: unknown): value is MacroTradeType {
    return value === 'buy' || value === 'sell';
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private omitUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
  }
}

export function parseB2bCenterNativeSearch(text: string, requested: { macroTradeType: MacroTradeType; page: number; pageSize: number; sort: string; url: string }): B2bCenterNativePage {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('B2B-Center native response is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('B2B-Center native response shape is not an object');
  const raw = payload as Record<string, unknown>;
  const trades = raw.trades;
  if (!Array.isArray(trades)) {
    if (typeof raw.redirect_link === 'string') throw new Error('B2B-Center native response redirected instead of returning a concrete trade list');
    throw new Error('B2B-Center native response missing trades array');
  }
  const currentSort = stringValue(raw.current_sort);
  if (currentSort && currentSort !== requested.sort) throw new Error(`B2B-Center native sort mismatch: expected ${requested.sort}, got ${currentSort}`);
  const pageCount = numberValue(raw.page_count);
  const tabs = Array.isArray(raw.tabs) ? raw.tabs.map((tab) => parseNativeTab(tab)).filter((tab): tab is { type: string; name?: string; count?: number } => Boolean(tab)) : [];
  if (trades.length === 0 && pageCount === undefined && tabs.length === 0) throw new Error('B2B-Center native empty response is not a recognized list schema');
  const cards = trades.map((trade) => parseNativeTrade(trade, requested.macroTradeType, requested.url));
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.nativeKey)) throw new Error(`B2B-Center native response repeats trade key ${card.nativeKey}`);
    seen.add(card.nativeKey);
  }
  return { cards, pageCount, currentSort, tabs, mode: stringValue(raw.mode), raw };
}

export function parseB2bCenterCatalog(html: string, finalUrl: string): { cards: B2bCenterCard[]; nextPage?: number; totalPublicCount?: number; activePublicCount?: number } {
  const $ = load(html);
  const cards: B2bCenterCard[] = [];
  const seen = new Set<string>();
  $('.panel-procedure').each((_, element) => {
    const root = $(element);
    if (root.parents('.panel-procedure').length > 0) return;
    const card = parseB2bCenterCard($, root);
    if (!card) return;
    if (seen.has(card.id)) throw new Error(`B2B-Center listing repeats native tender ID ${card.id}`);
    seen.add(card.id);
    cards.push(card);
  });
  const currentPage = numberText($('.cds-pagination__item--active').first().text()) ?? numberText(new URL(finalUrl).searchParams.get('page')) ?? 1;
  const pages = $('.cds-pagination__item').map((_, element) => numberText($(element).text())).get().filter((value): value is number => Number.isFinite(value));
  const nextPage = pages.some((page) => page === currentPage + 1) ? currentPage + 1 : undefined;
  return { cards, nextPage, totalPublicCount: publicCount($, '.search__all-procedure'), activePublicCount: publicCount($, '.search__actual-procedure') };
}

export function parseB2bCenterDetail(html: string, finalUrl: string, expectedId: string): DetailFacts {
  if (!new RegExp(`tenders?-${expectedId}(?:/|$)`).test(new URL(finalUrl).pathname)) throw new Error('B2B-Center detail identity differs from requested tender');
  const $ = load(html);
  const rows: Record<string, string> = {};
  $('tr').each((_, row) => {
    const label = cleanText($(row).find('td.fname').first().text()).replace(/\s*:+\s*$/, ':');
    const value = cleanText($(row).find('td').last().text());
    if (!label || !value) return;
    const normalized = label.replace(/:$/, '');
    if (!rows[normalized]) rows[normalized] = value;
  });
  const heading = $('h1').first();
  const title = cleanText(heading.find('.s2').first().text())
    || cleanText(heading.clone().find('script,style,.favorite-button,.favorite-container').remove().end().text())
    .replace(/^(?:Запрос\s+предложений|Объявление\s+о\s+продаже)\s+№\s*\d+\s*/i, '')
    || cleanText($('title').first().text()).replace(/\s+—\s+Тендер\s+№\s+\d+[\s\S]*$/i, '')
    || undefined;
  const description = cleanText($('.s-expandable-text, .trade-info-description, [itemprop="description"]').first().text()) || undefined;
  const statusSummary = cleanText($('.bets_table_width').text()) || undefined;
  const documents = $('a[href]').map((_, link) => {
    const href = $(link).attr('href') ?? '';
    const label = cleanText($(link).text());
    if (!label || !/файл|скач|download|attachment|\.pdf|\.doc|\.xls|\.rar|\.zip/i.test(`${href} ${label}`)) return undefined;
    const url = new URL(href, finalUrl);
    if (url.hostname !== 'www.b2b-center.ru' || !/file|download|attachment|\.(pdf|docx?|xlsx?|rar|zip)(?:$|[?#])/i.test(url.pathname + url.search)) return undefined;
    return { label, url: url.toString() };
  }).get().filter((item): item is { label: string; url: string } => Boolean(item));
  const hasLoginOnly = /Для просмотра зарегистрируйтесь|Доступно зарегистрированным пользователям/i.test($.text());
  return {
    title,
    description,
    rows,
    documents,
    statusText: cleanText($('[id="bets_table"], .bets_table_width').first().text()) || undefined,
    statusSummary,
    publicAccessGap: hasLoginOnly ? 'some detail fields are visible only to registered users' : documents.length ? undefined : 'no public source document links observed in anonymous detail HTML',
    htmlHash: createHash('sha256').update(html).digest('hex'),
  };
}

async function defaultNativeHttp(inputUrl: string, options: { timeoutMs: number; maxBytes: number; signal?: AbortSignal }): Promise<NativeHttpResult> {
  const url = new URL(inputUrl);
  await assertPublicHttpUrl(url);
  assertAllowedHost(url, ALLOWED_HOSTS);
  const dispatcher = await createPinnedDispatcher(url);
  try {
    const response = await undiciFetch(url, {
      dispatcher,
      redirect: 'manual',
      headers: { Accept: 'application/json', 'User-Agent': process.env.INTLY_CRAWLER_USER_AGENT ?? 'INTLY/1.0' },
      signal: requestSignal(options),
    } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('B2B-Center native API redirect without location');
      const redirected = new URL(location, url);
      await assertPublicHttpUrl(redirected);
      assertAllowedHost(redirected, ALLOWED_HOSTS);
      return defaultNativeHttp(redirected.toString(), options);
    }
    return { status: response.status, finalUrl: url.toString(), contentType: response.headers.get('content-type') ?? undefined, retryAfter: response.headers.get('retry-after') ?? undefined, text: await readLimited(response, options.maxBytes) };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

function parseNativeTrade(value: unknown, macroTradeType: MacroTradeType, finalUrl: string): B2bCenterNativeCard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('B2B-Center native trade item is not an object');
  const raw = value as Record<string, unknown>;
  const tradeId = numberValue(raw.trade_id);
  if (!tradeId) throw new Error('B2B-Center native trade item missing trade_id');
  const sphinxId = numberValue(raw.sphinx_id);
  const rawUrl = stringValue(raw.url);
  if (!rawUrl) throw new Error(`B2B-Center native trade ${tradeId} missing detail URL`);
  const canonicalDetailUrl = canonicalTenderUrl(rawUrl, String(tradeId), finalUrl);
  const title = decodeHtmlText(stringValue(raw.description)) || `B2B-Center tender ${tradeId}`;
  const snippet = decodeHtmlText(stringValue(raw.snippet));
  const tags = decodeHtmlText(stringValue(raw.tags));
  const publishedText = stringValue(raw.date_published);
  const deadlineText = stringValue(raw.date_actual);
  const priceText = decodeHtmlText(stringValue(raw.price));
  const nativeKey = sphinxId ? `${tradeId}:${sphinxId}` : String(tradeId);
  return {
    id: String(tradeId),
    nativeKey,
    sphinxId: sphinxId ? String(sphinxId) : undefined,
    macroTradeType,
    url: new URL(rawUrl, ORIGIN).toString(),
    canonicalDetailUrl,
    title,
    companyOrClient: decodeHtmlText(stringValue(raw.org_name_short)),
    description: [title, snippet].filter(Boolean).join('\n\n') || title,
    publishedAt: moscowDate(publishedText),
    publishedText,
    deadlineAt: moscowDate(deadlineText),
    deadlineText,
    priceText,
    region: decodeHtmlText(stringValue(raw.region)),
    tags,
    volume: recordValue(raw.volume),
    isSimplePurchase: booleanValue(raw.is_simple_purchase),
    raw,
  };
}

function parseNativeTab(value: unknown): { type: string; name?: string; count?: number } | undefined {
  const raw = recordValue(value);
  const type = stringValue(raw?.type);
  if (!raw || !type) return undefined;
  return { type, name: stringValue(raw.name), count: numberValue(raw.count) };
}

function parseB2bCenterCard($: CheerioAPI, root: ReturnType<CheerioAPI>): B2bCenterCard | undefined {
  const href = root.find('a[href*="/market/"][href*="/tender-"]').first().attr('href');
  if (!href) return undefined;
  const url = new URL(href, ORIGIN);
  const id = /\/tender-(\d+)\//.exec(url.pathname)?.[1];
  if (!id) return undefined;
  const canonical = new URL(url.pathname, ORIGIN).toString();
  const description = cleanText(root.find('.panel-procedure__dscr-main').first().text());
  const title = description || cleanText(root.find('.panel-procedure__number-link').first().text()) || `B2B-Center tender ${id}`;
  const foreground = cleanText(root.find('.panel-procedure__foreground').first().text());
  const publishedText = /(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/.exec(foreground)?.[1];
  const deadlineText = cleanText(root.find('.panel-procedure__dscr-date').first().text()).replace(/^до\s+/i, '');
  const category = cleanText(root.find('.cds-tag').first().text());
  const companyOrClient = cleanText(root.find('.panel-procedure__dscr-branch').first().text());
  const quantityText = cleanText(root.find('.panel-procedure__details-item-volume').first().text());
  const priceText = cleanText(root.find('.panel-procedure__details-item-sum').first().text());
  const region = cleanText(root.find('.panel-procedure__details-item-region').first().text());
  const publishedAt = moscowDate(publishedText);
  const deadlineAt = moscowDate(deadlineText);
  return { id, url: url.toString(), canonicalDetailUrl: canonical, category, title, companyOrClient, description, publishedAt, publishedText, deadlineAt, deadlineText, quantityText, priceText, region, html: $.html(root), rawText: cleanText(root.text()) };
}

function canonicalTenderUrl(value: string, expectedId: string, baseUrl: string): string {
  const url = new URL(value, baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'www.b2b-center.ru') throw new Error('B2B-Center native detail URL host is not allowed');
  const match = /\/(?:app\/market-next|market)\/[^?#]+\/tenders?-(\d+)\/?$/i.exec(url.pathname);
  if (!match || match[1] !== expectedId) throw new Error(`B2B-Center native detail URL does not match trade_id ${expectedId}`);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function publicCount($: CheerioAPI, selector: string): number | undefined {
  const text = cleanText($(selector).text());
  const matches = [...text.matchAll(/\d[\d\s]*/g)].map((match) => Number(match[0].replace(/\s/g, ''))).filter(Number.isFinite);
  return matches.at(-1);
}

function numberText(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.replace(/\D/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function moscowDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const match = /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/.exec(value);
  if (!match) return undefined;
  const [, dd, mm, yyyy, hh, min] = match;
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh) - 3, Number(min), 0));
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function cleanText(value: string | undefined): string {
  return (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtmlText(value: string | undefined): string | undefined {
  const text = cleanText(load('<span></span>')('span').html(value ?? '').text());
  return text || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function hasRegistrationControlText(value: string): boolean {
  return /Зарегистрируйтесь|чтобы\s+сохранять\s+процедуры|сохранять\s+процедуры\s+в\s+Избранное|Избранное/i.test(value);
}

function titlesCompatible(left: string, right: string): boolean {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return true;
  if (a.includes(b.slice(0, Math.min(40, b.length))) || b.includes(a.slice(0, Math.min(40, a.length)))) return true;
  const aTokens = new Set(a.split(' ').filter((token) => token.length >= 5));
  const bTokens = b.split(' ').filter((token) => token.length >= 5);
  return bTokens.filter((token) => aTokens.has(token)).length >= 2;
}

function normalizeTitle(value: string): string {
  return cleanText(value).toLowerCase().replace(/[«»"'.,]/g, '').replace(/\s+/g, ' ');
}

function retryAfterSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function requestSignal(options: { timeoutMs: number; signal?: AbortSignal }): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Response exceeds v1 size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks, bytes));
}
