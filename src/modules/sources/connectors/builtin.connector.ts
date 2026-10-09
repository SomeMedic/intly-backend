import { load, CheerioAPI } from 'cheerio';

import { OpportunityType } from '../../opportunities/schemas/opportunity.schema';
import { WebExtractionHttpError, WebExtractionService } from '../extraction/web-extraction.service';
import { assertBuiltinCriteriaContinuation, builtinListingCriteria, builtinListingIsVerifiedEmpty, builtinListingTaxonomy, BuiltinListingCriteria, validatedBuiltinCriteria } from './builtin-listing-contract';
import { assertBuiltinFrontierTaxonomy, BuiltinFrontier, BuiltinFrontierPartition, builtinFrontierSummary, createBuiltinFrontier, nextBuiltinPartition, recordBuiltinPartition, refineBuiltinFrontier, suspendBuiltinPartition, validatedBuiltinFrontier } from './builtin-listing-frontier';
import { decodeBuiltinSeenIds, encodeBuiltinSeenIds } from './builtin-seen-ids';
import { Connector, ConnectorCapabilities, ConnectorCheckpoint, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { numberValue, stringValue } from './connector-utils';

const ORIGIN = 'https://builtin.com';
const DEFAULT_LIST_URL = `${ORIGIN}/jobs`;
const ALLOWED_HOSTS = ['builtin.com'];
const MAX_BACKFILL_DAYS = 30;
const MAX_HTML_BYTES = 2_500_000;
const DETAIL_CONCURRENCY = 4;
const DEFAULT_DETAIL_BATCH = 25;
const MAX_DETAIL_BATCH = 50;
const OBSERVED_PLATFORM_PAGE_CAP = 1000;
const MAX_CHECKPOINT_BYTES = 4_000_000;

type CollectionWindow = { since: string; until: string; sinceDate: Date; untilDate: Date };
type ExtractedDocument = { finalUrl: string; html: string; metadata: Record<string, unknown>; title?: string };

type BuiltinListCard = {
  externalId: string;
  url: string;
  title: string;
  rawText: string;
  listUrl: string;
  summary?: string;
  company?: string;
  location?: string;
  remoteType?: string;
  salaryText?: string;
  experience?: string;
  publishedText?: string;
  industries?: string[];
};

type BuiltinDetail = {
  externalId: string;
  url: string;
  nativeIdentifier?: string;
  title: string;
  company?: string;
  description?: string;
  descriptionHtml?: string;
  publishedAt?: Date;
  updatedAt?: Date;
  validThrough?: Date;
  employmentType?: string;
  location?: string;
  locations?: string[];
  remoteType?: string;
  salary?: Record<string, unknown>;
  salaryText?: string;
  applicantLocationRequirements?: string[];
  industries?: string[];
  benefits?: string[];
  skills?: string[];
  responsibilities?: string[];
  qualifications?: string[];
  seniority?: string;
  rawJobPosting?: Record<string, unknown>;
  dateKnown: boolean;
};

type BuiltinCheckpoint = ConnectorCheckpoint & {
  mode?: 'builtin-public-html-jobs';
  hasMore?: boolean;
  baseUrl?: string;
  nextListUrl?: string;
  currentListUrl?: string;
  detailQueue?: BuiltinListCard[];
  visitedListUrls?: string[];
  seenExternalIds?: string[];
  seenIdsEncoding?: 'deflate-base64-v1';
  seenExternalIdsCompressed?: string;
  backfillSince?: string;
  windowUntil?: string;
  perPage?: number;
  seen?: number;
  retained?: number;
  unknownDateCount?: number;
  filteredKnownDateCount?: number;
  maxObservedPage?: number;
  paginationCapObserved?: boolean;
  listingCriteria?: BuiltinListingCriteria;
  listingCriteriaVersion?: 1;
  criteriaVerifiedFromStart?: boolean;
  frontier?: BuiltinFrontier;
};

type BuiltinState = {
  mode: 'builtin-public-html-jobs';
  baseUrl: string;
  nextListUrl?: string;
  currentListUrl?: string;
  detailQueue: BuiltinListCard[];
  visitedListUrls: string[];
  seenExternalIds: string[];
  seenIdSet: Set<string>;
  backfillSince: string;
  windowUntil: string;
  perPage: number;
  seen: number;
  retained: number;
  unknownDateCount: number;
  filteredKnownDateCount: number;
  maxObservedPage: number;
  paginationCapObserved: boolean;
  listingCriteria?: BuiltinListingCriteria;
  criteriaVerifiedFromStart: boolean;
  frontier?: BuiltinFrontier;
};

export class BuiltinConnector implements Connector {
  readonly id = 'builtin';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly extraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(config: Record<string, unknown> = {}): Promise<ValidationResult> {
    try {
      return { ok: true, message: 'Built In public jobs listing configured', details: { url: this.configuredListUrl(config), parserVersion: 'builtin-native-html-v1' } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Built In source is not configured' };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const document = await this.fetchHtml(this.configuredListUrl({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) }), ctx);
      const listingCriteria = builtinListingCriteria(document.html, document.finalUrl);
      const parsed = this.parseListing(document.html, document.finalUrl);
      return { state: parsed.cards.length > 0 ? 'Healthy' : 'Failed', message: `Built In listing exposed ${parsed.cards.length} public job cards`, checkedAt: new Date(), details: { cards: parsed.cards.length, nextUrl: parsed.nextListUrl, maxObservedPage: parsed.maxObservedPage, listingCriteria, parserVersion: 'builtin-native-html-v1' } };
    } catch (error) {
      if (error instanceof WebExtractionHttpError && error.status === 429) {
        return { state: 'Degraded', message: 'Built In public listing is rate limited', checkedAt: new Date(), details: { retryAfter: error.retryAfter } };
      }
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Built In health failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const baseUrl = this.configuredListUrl({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) });
    const window = this.collectionWindow(ctx);
    const checkpoint = (ctx.checkpoint ?? {}) as BuiltinCheckpoint;
    if (checkpoint.mode === 'builtin-public-html-jobs' && checkpoint.hasMore === false && checkpoint.backfillSince === window.since) {
      return { records: [], hasMore: false, checkpoint, stats: { seen: 0 } };
    }
    const state = checkpoint.mode === 'builtin-public-html-jobs' && checkpoint.backfillSince === window.since
      ? this.resumeState(checkpoint, baseUrl, window, ctx)
      : this.initialState(baseUrl, window, ctx);

    if (state.detailQueue.length === 0 && state.nextListUrl) {
      if (state.frontier) await this.advanceFrontier(state, ctx);
      else await this.advanceListing(state, ctx);
    }

    const batch = state.detailQueue.splice(0, state.perPage);
    const details = await mapWithConcurrency(batch, DETAIL_CONCURRENCY, async (card) => this.fetchDetail(card, ctx));
    const records: RawOpportunityRecord[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const detail = details[index];
      const card = batch[index];
      if (!detail.dateKnown) state.unknownDateCount += 1;
      if (detail.publishedAt && (detail.publishedAt < window.sinceDate || detail.publishedAt > window.untilDate)) {
        state.filteredKnownDateCount += 1;
        continue;
      }
      records.push(this.record(card, detail, window));
      state.retained += 1;
    }

    const hasMore = state.detailQueue.length > 0 || Boolean(state.nextListUrl);
    return {
      records,
      hasMore,
      nextPage: hasMore ? (numberValue(ctx.checkpoint.nextPage) ?? numberValue(ctx.page) ?? 0) + 1 : undefined,
      checkpoint: hasMore ? this.progressCheckpoint(state, ctx) : this.terminalCheckpoint(state),
      stats: { seen: batch.length },
    };
  }

  async fetchById(externalId: string, ctx: FetchContext): Promise<RawOpportunityRecord | null> {
    const url = this.detailUrl(externalId, DEFAULT_LIST_URL);
    if (!url) return null;
    const card: BuiltinListCard = { externalId: this.externalIdFromUrl(url), url, title: '', rawText: '', listUrl: DEFAULT_LIST_URL };
    const window = this.collectionWindow(ctx);
    const detail = await this.fetchDetail(card, ctx);
    return this.record(card, detail, window);
  }

  checkpoint(result: FetchPage): ConnectorCheckpoint {
    return result.checkpoint;
  }

  private initialState(baseUrl: string, window: CollectionWindow, ctx: FetchContext): BuiltinState {
    return {
      mode: 'builtin-public-html-jobs',
      baseUrl,
      nextListUrl: baseUrl,
      detailQueue: [],
      visitedListUrls: [],
      seenExternalIds: [],
      seenIdSet: new Set(),
      backfillSince: window.since,
      windowUntil: window.until,
      perPage: this.perPage(ctx),
      seen: 0,
      retained: 0,
      unknownDateCount: 0,
      filteredKnownDateCount: 0,
      maxObservedPage: 1,
      paginationCapObserved: false,
      criteriaVerifiedFromStart: true,
    };
  }

  private resumeState(checkpoint: BuiltinCheckpoint, baseUrl: string, window: CollectionWindow, ctx: FetchContext): BuiltinState {
    if (checkpoint.baseUrl !== baseUrl) throw new Error('Built In continuation checkpoint baseUrl does not match the configured source URL');
    if (checkpoint.backfillSince !== window.since) throw new Error('Built In continuation checkpoint lower bound does not match the requested collection window');
    if (checkpoint.windowUntil !== window.until) throw new Error('Built In continuation checkpoint windowUntil does not match the frozen collection window');
    if (!Number.isFinite(window.sinceDate.getTime()) || !Number.isFinite(window.untilDate.getTime()) || window.sinceDate > window.untilDate) throw new Error('Built In continuation checkpoint has an invalid frozen collection window');
    const perPage = this.checkpointPerPage(checkpoint.perPage ?? this.perPage(ctx));
    if (checkpoint.listingCriteriaVersion !== undefined && checkpoint.listingCriteriaVersion !== 1) throw new Error('Built In continuation checkpoint has an unsupported listing criteria version');
    if (checkpoint.listingCriteriaVersion === 1 && checkpoint.listingCriteria === undefined) throw new Error('Built In continuation checkpoint has no saved listing criteria');
    const listingCriteria = checkpoint.listingCriteria === undefined ? undefined : validatedBuiltinCriteria(checkpoint.listingCriteria);
    const seenExternalIds = decodeBuiltinSeenIds(checkpoint) ?? this.idArray(checkpoint.seenExternalIds, 'seenExternalIds');
    const frontier = checkpoint.frontier === undefined ? undefined : validatedBuiltinFrontier(checkpoint.frontier);
    if (frontier && checkpoint.seenIdsEncoding === undefined) throw new Error('Built In partition frontier has no exact shared ID history');
    if (frontier && (nextBuiltinPartition(frontier)?.currentListUrl ?? undefined) !== checkpoint.nextListUrl) throw new Error('Built In partition frontier next URL does not match its checkpoint');
    return {
      mode: 'builtin-public-html-jobs',
      baseUrl,
      nextListUrl: checkpoint.nextListUrl === undefined ? undefined : this.requiredListUrl(checkpoint.nextListUrl, baseUrl, 'nextListUrl'),
      currentListUrl: checkpoint.currentListUrl === undefined ? undefined : this.requiredListUrl(checkpoint.currentListUrl, baseUrl, 'currentListUrl'),
      detailQueue: this.cardArray(checkpoint.detailQueue),
      visitedListUrls: this.urlArray(checkpoint.visitedListUrls, baseUrl, 'visitedListUrls'),
      seenExternalIds,
      seenIdSet: new Set(seenExternalIds),
      backfillSince: window.since,
      windowUntil: window.until,
      perPage,
      seen: numberValue(checkpoint.seen) ?? 0,
      retained: numberValue(checkpoint.retained) ?? 0,
      unknownDateCount: numberValue(checkpoint.unknownDateCount) ?? 0,
      filteredKnownDateCount: numberValue(checkpoint.filteredKnownDateCount) ?? 0,
      maxObservedPage: numberValue(checkpoint.maxObservedPage) ?? 1,
      paginationCapObserved: checkpoint.paginationCapObserved === true,
      listingCriteria,
      criteriaVerifiedFromStart: listingCriteria !== undefined && checkpoint.criteriaVerifiedFromStart === true,
      frontier,
    };
  }

  private async advanceListing(state: BuiltinState, ctx: FetchContext): Promise<void> {
    const listUrl = state.nextListUrl;
    if (!listUrl) return;
    if (state.visitedListUrls.includes(listUrl)) throw new Error(`Built In pagination cycle detected at ${listUrl}`);
    const document = await this.fetchHtml(listUrl, ctx);
    const finalUrl = this.listUrl(document.finalUrl, listUrl);
    if (!finalUrl) throw new Error(`Built In listing redirected outside public jobs URLs: ${listUrl}`);
    if (this.pageNumber(finalUrl) !== this.pageNumber(listUrl)) throw new Error(`Built In listing pagination redirected from ${listUrl} to mismatched page ${finalUrl}`);
    if (!this.sameListingScope(finalUrl, listUrl)) throw new Error(`Built In listing redirected to a different listing scope: ${listUrl}`);
    if (state.visitedListUrls.includes(finalUrl)) throw new Error(`Built In pagination redirected to an already visited URL: ${finalUrl}`);
    const listingCriteria = builtinListingCriteria(document.html, finalUrl);
    if (state.listingCriteria) assertBuiltinCriteriaContinuation(state.listingCriteria, listingCriteria);
    const parsed = this.parseListing(document.html, finalUrl);
    if (parsed.cards.length === 0) throw new Error(`Built In listing contained no public job cards: ${finalUrl}`);
    state.listingCriteria = listingCriteria;
    state.visitedListUrls.push(finalUrl);
    state.currentListUrl = finalUrl;
    state.maxObservedPage = Math.max(state.maxObservedPage, parsed.maxObservedPage ?? this.pageNumber(finalUrl));
    state.paginationCapObserved = state.paginationCapObserved || state.maxObservedPage >= OBSERVED_PLATFORM_PAGE_CAP;
    let newCards = 0;
    for (const card of parsed.cards) {
      state.seen += 1;
      if (state.seenIdSet.has(card.externalId)) continue;
      state.seenExternalIds.push(card.externalId);
      state.seenIdSet.add(card.externalId);
      state.detailQueue.push({ ...card, listUrl: finalUrl });
      newCards += 1;
    }
    if (newCards === 0 && parsed.cards.length > 0 && state.seenExternalIds.length > 0) throw new Error(`Built In listing repeated previously seen job ids at ${finalUrl}`);
    if (parsed.nextListUrl) {
      if (state.visitedListUrls.includes(parsed.nextListUrl)) throw new Error(`Built In pagination would revisit ${parsed.nextListUrl}`);
      state.nextListUrl = parsed.nextListUrl;
    } else {
      state.nextListUrl = undefined;
    }
    if (this.canExpandCatalog(state.baseUrl)) {
      const taxonomy = builtinListingTaxonomy(document.html);
      if (taxonomy) {
        state.frontier = createBuiltinFrontier(taxonomy, {
          baseUrl: state.baseUrl,
          currentListUrl: state.currentListUrl,
          nextListUrl: state.nextListUrl,
          listingCriteria: state.listingCriteria,
          maxObservedPage: state.maxObservedPage,
          criteriaVerifiedFromStart: state.criteriaVerifiedFromStart,
        });
        state.nextListUrl = nextBuiltinPartition(state.frontier)?.currentListUrl ?? undefined;
      }
    }
  }

  private async advanceFrontier(state: BuiltinState, ctx: FetchContext): Promise<void> {
    if (!state.frontier) return;
    const partition = nextBuiltinPartition(state.frontier);
    if (!partition?.currentListUrl) {
      state.nextListUrl = undefined;
      return;
    }
    const listUrl = this.requiredListUrl(partition.currentListUrl, state.baseUrl, 'frontier currentListUrl');
    const document = await this.fetchHtml(listUrl, ctx);
    const finalUrl = this.listUrl(document.finalUrl, listUrl);
    if (!finalUrl || !this.sameListingScope(finalUrl, listUrl) || this.pageNumber(finalUrl) !== this.pageNumber(listUrl)) throw new Error(`Built In partition listing redirected away from its requested scope: ${listUrl}`);
    const criteria = builtinListingCriteria(document.html, finalUrl);
    const taxonomy = builtinListingTaxonomy(document.html);
    if (!taxonomy) throw new Error('Built In partition listing has lost its native taxonomy contract');
    state.frontier = refineBuiltinFrontier(state.frontier, taxonomy);
    assertBuiltinFrontierTaxonomy(state.frontier, taxonomy);
    assertBuiltinCriteriaContinuation(partition.observedCriteria ?? partition.expectedCriteria, criteria);
    const parsed = this.parseListing(document.html, finalUrl);
    if (parsed.cards.length === 0) {
      if (partition.kind === 'legacy') throw new Error(`Built In listing contained no public job cards: ${finalUrl}`);
      if (builtinListingIsVerifiedEmpty(document.html, finalUrl)) {
        state.frontier = recordBuiltinPartition(state.frontier, partition.id, {
          requestedUrl: listUrl,
          finalUrl,
          criteria,
          nativeIds: [],
          nextListUrl: parsed.nextListUrl,
          maxObservedPage: parsed.maxObservedPage,
          terminal: true,
          verifiedEmpty: true,
        });
      } else {
        state.frontier = suspendBuiltinPartition(state.frontier, partition.id, 'unverified-native-empty');
      }
    } else {
      state.frontier = recordBuiltinPartition(state.frontier, partition.id, {
        requestedUrl: listUrl,
        finalUrl,
        criteria,
        nativeIds: parsed.cards.map(card => card.externalId),
        nextListUrl: parsed.nextListUrl,
        maxObservedPage: parsed.maxObservedPage,
      });
      if (partition.kind === 'legacy') this.rememberLegacyListing(state, partition, finalUrl);
      for (const card of parsed.cards) {
        state.seen += 1;
        if (state.seenIdSet.has(card.externalId)) continue;
        state.seenExternalIds.push(card.externalId);
        state.seenIdSet.add(card.externalId);
        state.detailQueue.push({ ...card, listUrl: finalUrl });
      }
    }
    state.currentListUrl = finalUrl;
    state.listingCriteria = criteria;
    state.maxObservedPage = Math.max(state.maxObservedPage, parsed.maxObservedPage);
    state.paginationCapObserved ||= parsed.maxObservedPage >= OBSERVED_PLATFORM_PAGE_CAP;
    state.nextListUrl = nextBuiltinPartition(state.frontier)?.currentListUrl ?? undefined;
  }

  private rememberLegacyListing(state: BuiltinState, partition: BuiltinFrontierPartition, finalUrl: string): void {
    if (state.visitedListUrls.includes(finalUrl)) throw new Error(`Built In pagination cycle detected at ${finalUrl}`);
    if (partition.lastFinalUrl && this.pageNumber(finalUrl) <= this.pageNumber(partition.lastFinalUrl)) throw new Error(`Built In legacy pagination did not advance: ${finalUrl}`);
    state.visitedListUrls.push(finalUrl);
  }

  private canExpandCatalog(baseUrl: string): boolean {
    const url = new URL(baseUrl);
    if (url.pathname !== '/jobs' || this.pageNumber(baseUrl) !== 1) return false;
    if (!url.search) return true;
    return url.searchParams.get('city') === '' && url.searchParams.get('state') === '' && url.searchParams.get('country') === 'USA' && url.searchParams.get('allLocations') === 'true' && [...url.searchParams.keys()].every(key => ['page', 'city', 'state', 'country', 'allLocations'].includes(key));
  }

  private progressCheckpoint(state: BuiltinState, ctx: FetchContext): ConnectorCheckpoint {
    return this.boundedCheckpoint(this.omitUndefined({
      mode: state.mode,
      hasMore: true,
      nextPage: (numberValue(ctx.checkpoint.nextPage) ?? numberValue(ctx.page) ?? 0) + 1,
      baseUrl: state.baseUrl,
      nextListUrl: state.nextListUrl,
      currentListUrl: state.currentListUrl,
      detailQueue: state.detailQueue,
      visitedListUrls: state.visitedListUrls,
      ...(state.frontier ? encodeBuiltinSeenIds(state.seenExternalIds) : { seenExternalIds: state.seenExternalIds }),
      backfillSince: state.backfillSince,
      windowUntil: state.windowUntil,
      perPage: state.perPage,
      seen: state.seen,
      uniqueSeen: state.seenExternalIds.length,
      retained: state.retained,
      unknownDateCount: state.unknownDateCount,
      filteredKnownDateCount: state.filteredKnownDateCount,
      maxObservedPage: state.maxObservedPage,
      paginationCapObserved: state.paginationCapObserved,
      listingCriteria: state.listingCriteria,
      listingCriteriaVersion: state.listingCriteria ? 1 : undefined,
      criteriaVerifiedFromStart: state.criteriaVerifiedFromStart,
      frontier: state.frontier,
      frontierSummary: state.frontier ? builtinFrontierSummary(state.frontier) : undefined,
      catalogComplete: false,
      fullWindowCompletenessProven: false,
      publicSearchScope: 'Built In public jobs HTML, observed native taxonomy partitions and guarded pagination',
      scopeLimitation: 'Built In exposes a visible page range up to page=1000; terminal pagination does not prove whole-platform completeness.',
      lastFetchedAt: new Date().toISOString(),
    }));
  }

  private terminalCheckpoint(state: BuiltinState): ConnectorCheckpoint {
    return this.boundedCheckpoint(this.omitUndefined({
      mode: state.mode,
      hasMore: false,
      terminalReason: state.paginationCapObserved ? 'observed-pagination-frontier-exhausted-cap-unproven' : 'observed-pagination-frontier-exhausted',
      incomplete: true,
      limitation: `${state.paginationCapObserved ? 'Built In visible pagination reached page=1000; ' : ''}observed listing scope ended, but whole-platform geography, taxonomy coverage and publication dates are not fully proven.`,
      observedListingScopeComplete: !state.frontier && !state.paginationCapObserved && state.criteriaVerifiedFromStart,
      catalogComplete: false,
      fullWindowCompletenessProven: false,
      incompleteReason: [
        'platform_scope_unproven',
        state.paginationCapObserved ? 'visible_page_cap_1000' : undefined,
        !state.criteriaVerifiedFromStart ? 'legacy_criteria_prefix_unverified' : undefined,
        state.unknownDateCount > 0 ? 'unknown_publication_dates' : undefined,
        state.frontier && builtinFrontierSummary(state.frontier).unresolved > 0 ? 'unresolved_native_partitions' : undefined,
        state.frontier && builtinFrontierSummary(state.frontier).unresolvedLeafCaps > 0 ? 'unresolved_leaf_page_caps' : undefined,
      ].filter(Boolean).join('_and_'),
      baseUrl: state.baseUrl,
      currentListUrl: state.currentListUrl,
      visitedListUrls: state.visitedListUrls,
      ...(state.frontier ? encodeBuiltinSeenIds(state.seenExternalIds) : { seenExternalIds: state.seenExternalIds }),
      perPage: state.perPage,
      backfillSince: state.backfillSince,
      windowUntil: state.windowUntil,
      seen: state.seen,
      uniqueSeen: state.seenExternalIds.length,
      retained: state.retained,
      unknownDateCount: state.unknownDateCount,
      filteredKnownDateCount: state.filteredKnownDateCount,
      maxObservedPage: state.maxObservedPage,
      paginationCapObserved: state.paginationCapObserved,
      listingCriteria: state.listingCriteria,
      listingCriteriaVersion: state.listingCriteria ? 1 : undefined,
      criteriaVerifiedFromStart: state.criteriaVerifiedFromStart,
      frontier: state.frontier,
      frontierSummary: state.frontier ? builtinFrontierSummary(state.frontier) : undefined,
      publicSearchScope: 'Built In public jobs HTML, observed native taxonomy partitions and guarded pagination',
      scopeLimitation: 'Built In exposes a visible page range up to page=1000; terminal pagination does not prove whole-platform completeness.',
      lastFetchedAt: new Date().toISOString(),
    }));
  }

  private boundedCheckpoint(checkpoint: ConnectorCheckpoint): ConnectorCheckpoint {
    if (Buffer.byteLength(JSON.stringify(checkpoint)) > MAX_CHECKPOINT_BYTES) throw new Error('Built In resumable frontier checkpoint exceeds its Mongo delivery limit');
    return checkpoint;
  }

  private async fetchHtml(url: string, ctx: ConnectorContext): Promise<ExtractedDocument> {
    try {
      const document = await this.extraction.extractUrl(url, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal }) as ExtractedDocument;
      ctx.signal?.throwIfAborted();
      return document;
    } catch (error) {
      if (error instanceof WebExtractionHttpError && error.status === 429) throw new ConnectorRateLimitError('Built In public HTML rate limited', 60);
      throw error;
    }
  }

  private parseListing(html: string, finalUrl: string): { cards: BuiltinListCard[]; nextListUrl?: string; maxObservedPage: number } {
    const $ = load(html);
    const jsonLdItems = this.itemList($);
    const cardsByUrl = new Map<string, BuiltinListCard>();
    $('[id^="job-card-"], .job-bounded-responsive').each((_, element) => {
      const root = $(element);
      const anchor = root.find('a[href*="/job/"]').first();
      const url = this.detailUrl(anchor.attr('href'), finalUrl);
      if (!url) return;
      const externalId = this.externalIdFromUrl(url);
      const rawText = this.text(root.text()) ?? '';
      const structured = jsonLdItems.get(url);
      const title = this.text(anchor.text()) ?? structured?.title;
      if (!title) return;
      cardsByUrl.set(url, this.omitUndefined({
        externalId,
        url,
        title,
        rawText,
        listUrl: finalUrl,
        summary: structured?.description ?? this.summary(root),
        company: this.company(root, title),
        location: this.location(rawText),
        remoteType: this.remoteType(rawText),
        salaryText: this.salaryText(rawText),
        experience: this.experience(rawText),
        publishedText: this.publishedText(rawText),
        industries: this.industries(rawText),
      }) as BuiltinListCard);
    });
    if (cardsByUrl.size === 0) {
      for (const item of jsonLdItems.values()) {
        cardsByUrl.set(item.url, { externalId: this.externalIdFromUrl(item.url), url: item.url, title: item.title, rawText: item.description ?? item.title, listUrl: finalUrl, summary: item.description });
      }
    }
    return { cards: [...cardsByUrl.values()], nextListUrl: this.nextListUrl($, finalUrl), maxObservedPage: this.maxObservedPage($, finalUrl) };
  }

  private itemList($: CheerioAPI): Map<string, { url: string; title: string; description?: string }> {
    const out = new Map<string, { url: string; title: string; description?: string }>();
    for (const script of $('script[type="application/ld+json"]').toArray()) {
      const parsed = this.parseJson($(script).text());
      for (const node of this.graphNodes(parsed)) {
        if (stringValue(node['@type']) !== 'ItemList' || !Array.isArray(node.itemListElement)) continue;
        for (const item of node.itemListElement) {
          const record = this.recordValue(item);
          const url = this.detailUrl(record?.url, DEFAULT_LIST_URL);
          const title = stringValue(record?.name);
          if (url && title) out.set(url, { url, title, description: stringValue(record?.description) });
        }
      }
    }
    return out;
  }

  private async fetchDetail(card: BuiltinListCard, ctx: FetchContext): Promise<BuiltinDetail> {
    const document = await this.fetchHtml(card.url, ctx);
    const finalUrl = this.detailUrl(document.finalUrl, card.url);
    if (!finalUrl || finalUrl !== card.url) throw new Error(`Built In detail redirected away from ${card.url}`);
    return this.parseDetail(document.html, finalUrl, card);
  }

  private parseDetail(html: string, finalUrl: string, card: BuiltinListCard): BuiltinDetail {
    const $ = load(html);
    const posting = this.jobPosting($, finalUrl);
    if (!posting) throw new Error(`Built In detail has no JobPosting JSON-LD: ${finalUrl}`);
    const title = stringValue(posting.title) ?? card.title;
    const descriptionHtml = stringValue(posting.description);
    const description = this.htmlToText(descriptionHtml ?? '');
    if (!title || !description) throw new Error(`Built In detail has no usable public job body: ${finalUrl}`);
    const salary = this.salary(posting.baseSalary);
    const publishedAt = this.date(stringValue(posting.datePosted));
    const jobLocations = this.locationNames(posting.jobLocation);
    const applicantLocationRequirements = this.locationNames(posting.applicantLocationRequirements);
    const displayLocations = jobLocations.length > 0 ? jobLocations : applicantLocationRequirements;
    return this.omitUndefined({
      externalId: this.externalId(posting, finalUrl),
      url: finalUrl,
      nativeIdentifier: this.nativeIdentifier(posting),
      title,
      company: this.organizationName(posting.hiringOrganization) ?? card.company,
      description,
      descriptionHtml,
      publishedAt,
      validThrough: this.date(stringValue(posting.validThrough)),
      employmentType: this.employmentType(posting.employmentType),
      location: displayLocations.length > 0 ? displayLocations.join(', ') : card.location,
      locations: displayLocations.length > 0 ? displayLocations : undefined,
      remoteType: this.remoteTypeFromPosting(posting) ?? card.remoteType,
      salary,
      salaryText: salary ? stringValue(salary.originalText) : card.salaryText,
      applicantLocationRequirements: applicantLocationRequirements.length > 0 ? applicantLocationRequirements : undefined,
      industries: stringArray(posting.industry).length > 0 ? stringArray(posting.industry) : card.industries,
      benefits: stringArray(posting.jobBenefits),
      skills: stringArray(posting.skills ?? posting.skillRequirements),
      responsibilities: stringArray(posting.responsibilities),
      qualifications: stringArray(posting.qualifications),
      seniority: stringValue(posting.experienceRequirements) ?? card.experience,
      rawJobPosting: posting,
      dateKnown: Boolean(publishedAt),
    }) as BuiltinDetail;
  }

  private jobPosting($: CheerioAPI, finalUrl: string): Record<string, unknown> | undefined {
    const canonicalUrl = this.detailUrl($('link[rel="canonical"]').attr('href') ?? $('meta[property="og:url"]').attr('content'), finalUrl);
    for (const script of $('script[type="application/ld+json"]').toArray()) {
      const parsed = this.parseJson($(script).text());
      const postings = this.graphNodes(parsed).filter((node) => stringValue(node['@type']) === 'JobPosting');
      const exact = postings.find((node) => {
        const postingUrl = stringValue(node.url);
        return postingUrl ? this.detailUrl(postingUrl, finalUrl) === finalUrl : false;
      });
      if (exact) return exact;
      if (postings.length === 1 && (canonicalUrl === finalUrl || this.nativeIdentifier(postings[0]) === this.externalIdFromUrl(finalUrl))) return postings[0];
    }
    return undefined;
  }

  private record(card: BuiltinListCard, detail: BuiltinDetail, window: CollectionWindow): RawOpportunityRecord {
    return {
      externalId: detail.externalId,
      url: detail.url,
      type: 'vacancy' as OpportunityType,
      title: detail.title,
      companyOrClient: detail.company,
      description: detail.description,
      publishedAt: detail.publishedAt,
      updatedAt: detail.updatedAt,
      sourceStatus: 'Unknown',
      rawPayload: {
        listCard: card,
        detail: {
          title: detail.title,
          nativeIdentifier: detail.nativeIdentifier,
          company: detail.company,
          description: detail.description,
          descriptionHtml: detail.descriptionHtml,
          publishedAt: detail.publishedAt?.toISOString(),
          validThrough: detail.validThrough?.toISOString(),
          employmentType: detail.employmentType,
          salaryText: detail.salaryText,
          location: detail.location,
          locations: detail.locations,
          applicantLocationRequirements: detail.applicantLocationRequirements,
          remoteType: detail.remoteType,
        },
        jobPosting: detail.rawJobPosting,
      },
      sourceMetadata: this.omitUndefined({
        extraction: 'builtin-native-html-v1',
        sourceUrl: card.listUrl,
        detailUrl: detail.url,
        nativeIdentifier: detail.nativeIdentifier,
        company: detail.company,
        employment: detail.employmentType,
        nativeType: detail.employmentType,
        area: detail.location,
        location: detail.location,
        locations: detail.locations,
        nativeJobLocations: detail.locations,
        applicantLocationRequirements: detail.applicantLocationRequirements,
        remoteType: detail.remoteType,
        salary: detail.salary,
        nativeSalaryText: detail.salaryText,
        industries: detail.industries,
        categoryTags: detail.industries,
        benefits: detail.benefits,
        skills: detail.skills,
        responsibilities: detail.responsibilities,
        qualifications: detail.qualifications,
        seniority: detail.seniority,
        deadlineAt: detail.validThrough?.toISOString(),
        dateKnown: detail.dateKnown,
        descriptionCoverage: 'detail-jsonld-full',
        collectionWindow: { since: window.since, until: window.until },
        publicSearchScope: 'Built In public /jobs HTML listings and observed pagination only',
        scopeLimitation: 'Built In exposes a visible page range up to page=1000; terminal pagination does not prove whole-platform completeness.',
      }),
    };
  }

  private configuredListUrl(config: Record<string, unknown>): string {
    const url = this.listUrl(stringValue(config.baseUrl) ?? stringValue(config.url) ?? DEFAULT_LIST_URL, DEFAULT_LIST_URL);
    if (!url) throw new Error('Built In source only supports public https://builtin.com/jobs listing URLs');
    return url;
  }

  private listUrl(value: unknown, base: string): string | undefined {
    const url = this.safeUrl(value, base);
    if (!url || url.origin !== ORIGIN || url.username || url.password || url.hash) return undefined;
    if (!/^\/jobs(?:\/[a-z0-9-]+)*\/?$/i.test(url.pathname)) return undefined;
    for (const key of url.searchParams.keys()) {
      if (!['page', 'daysSinceUpdated', 'city', 'state', 'country', 'allLocations'].includes(key)) return undefined;
      if (url.searchParams.getAll(key).length > 1) return undefined;
    }
    const page = url.searchParams.get('page');
    if (page && !/^[1-9]\d{0,3}$/.test(page)) return undefined;
    const days = url.searchParams.get('daysSinceUpdated');
    if (days !== null && !['1', '3', '7', '30'].includes(days)) return undefined;
    const country = url.searchParams.get('country');
    if (country !== null && !/^[A-Z]{3}$/.test(country)) return undefined;
    if (url.searchParams.has('allLocations') && url.searchParams.get('allLocations') !== 'true') return undefined;
    return this.canonicalUrl(url);
  }

  private detailUrl(value: unknown, base: string): string | undefined {
    const url = this.safeUrl(value, base);
    if (!url || url.origin !== ORIGIN || url.username || url.password || url.hash || url.search) return undefined;
    if (!/^\/job\/[a-z0-9-]+\/\d+\/?$/i.test(url.pathname)) return undefined;
    return this.canonicalUrl(url);
  }

  private nextListUrl($: CheerioAPI, finalUrl: string): string | undefined {
    const currentPage = this.pageNumber(finalUrl);
    const candidates = $('a[href]').toArray()
      .map((element) => this.listUrl($(element).attr('href'), finalUrl))
      .filter((url): url is string => Boolean(url))
      .filter((url) => this.sameListingScope(url, finalUrl))
      .filter((url) => this.pageNumber(url) === currentPage + 1);
    return candidates[0];
  }

  private maxObservedPage($: CheerioAPI, finalUrl: string): number {
    let max = this.pageNumber(finalUrl);
    $('a[href]').each((_, element) => {
      const url = this.listUrl($(element).attr('href'), finalUrl);
      if (url && this.sameListingScope(url, finalUrl)) max = Math.max(max, this.pageNumber(url));
    });
    return max;
  }

  private pageNumber(url: string): number {
    const value = new URL(url).searchParams.get('page');
    return value ? Number(value) : 1;
  }

  private sameListingScope(left: string, right: string): boolean {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.searchParams.delete('page');
    rightUrl.searchParams.delete('page');
    leftUrl.searchParams.sort();
    rightUrl.searchParams.sort();
    return leftUrl.toString() === rightUrl.toString();
  }

  private collectionWindow(ctx: FetchContext): CollectionWindow {
    const checkpoint = (ctx.checkpoint ?? {}) as BuiltinCheckpoint;
    const explicitSince = ctx.backfillSince ? Date.parse(ctx.backfillSince) : NaN;
    const backfillDays = Math.min(Math.max(ctx.backfillDays || 1, 1), MAX_BACKFILL_DAYS);
    const requestedSince = new Date(Number.isFinite(explicitSince) ? explicitSince : Date.now() - backfillDays * 86_400_000).toISOString();
    const savedSince = checkpoint.backfillSince === requestedSince ? checkpoint.backfillSince : undefined;
    const savedUntil = savedSince ? stringValue(checkpoint.windowUntil) : undefined;
    const since = savedSince ?? requestedSince;
    const until = savedUntil ?? new Date().toISOString();
    return { since, until, sinceDate: new Date(since), untilDate: new Date(until) };
  }

  private perPage(ctx: FetchContext): number {
    const value = numberValue(ctx.source.limits?.perPage);
    return Math.min(Math.max(Math.floor(value ?? DEFAULT_DETAIL_BATCH), 1), MAX_DETAIL_BATCH);
  }

  private safeUrl(value: unknown, base: string): URL | undefined {
    const text = stringValue(value);
    if (!text) return undefined;
    try {
      const url = /^https?:\/\//i.test(text) ? new URL(text) : new URL(text, base);
      if (url.protocol !== 'https:') return undefined;
      return url;
    } catch {
      return undefined;
    }
  }

  private canonicalUrl(url: URL): string {
    url.pathname = url.pathname.replace(/\/$/, '') || '/';
    return url.toString();
  }

  private externalId(posting: Record<string, unknown>, fallbackUrl: string): string {
    const urlId = this.externalIdFromUrl(fallbackUrl);
    const postingUrl = stringValue(posting.url);
    if (postingUrl) {
      const normalized = this.detailUrl(postingUrl, fallbackUrl);
      if (normalized !== fallbackUrl) throw new Error(`Built In JobPosting url does not match detail URL ${fallbackUrl}`);
    }
    return urlId;
  }

  private nativeIdentifier(posting: Record<string, unknown>): string | undefined {
    return stringValue(this.recordValue(posting.identifier)?.value);
  }

  private externalIdFromUrl(url: string): string {
    const match = new URL(url).pathname.match(/\/(\d+)\/?$/);
    return match?.[1] ?? url;
  }

  private company(root: ReturnType<CheerioAPI>, title: string): string | undefined {
    const text = this.text(root.text());
    if (!text) return undefined;
    const index = text.indexOf(title);
    return index > 0 ? this.text(text.slice(0, index)) : undefined;
  }

  private summary(root: ReturnType<CheerioAPI>): string | undefined {
    const paragraphs = root.find('p');
    const candidates = paragraphs.map((index) => this.text(paragraphs.eq(index).text())).get().filter(Boolean);
    return candidates.find((item) => item.length > 60);
  }

  private publishedText(text: string): string | undefined {
    return text.match(/\b(?:Reposted\s+)?(?:\d+\s+(?:Minutes?|Hours?|Days?)\s+Ago|Yesterday)\b/i)?.[0];
  }

  private remoteType(text: string): string | undefined {
    if (/\bRemote\b/i.test(text)) return 'remote';
    if (/\bHybrid\b/i.test(text)) return 'hybrid';
    if (/\bOn-?site\b/i.test(text)) return 'onsite';
    return undefined;
  }

  private remoteTypeFromPosting(posting: Record<string, unknown>): string | undefined {
    if (stringValue(posting.jobLocationType) === 'TELECOMMUTE') return 'remote';
    const location = this.locationNames(posting.jobLocation).join(', ');
    return location && /\bremote\b/i.test(location) ? 'remote' : undefined;
  }

  private salaryText(text: string): string | undefined {
    return text.match(/\b\d{2,3}K\s*-\s*\d{2,3}K\s+(?:Annually|Yearly|Monthly|Hourly)\b/i)?.[0];
  }

  private experience(text: string): string | undefined {
    return text.match(/\b(?:Entry level|Mid level|Senior level|Expert\/Leader)\b/i)?.[0];
  }

  private location(text: string): string | undefined {
    const marker = this.remoteType(text);
    if (!marker) return undefined;
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`\\b${escaped}\\b\\s+([^\\n]+?)(?:\\s+(?:Easy Apply|\\d{2,3}K|Entry level|Mid level|Senior level|Expert/Leader|[A-Z][a-z]+ •))`, 'i'));
    return this.text(match?.[1]);
  }

  private industries(text: string): string[] | undefined {
    const match = text.match(/([A-Za-z][A-Za-z +&/-]+(?:\s+•\s+[A-Za-z][A-Za-z +&/-]+)+)/);
    return match ? match[1].split(/\s+•\s+/).map((item) => item.trim()).filter(Boolean) : undefined;
  }

  private salary(value: unknown): Record<string, unknown> | undefined {
    const record = this.recordValue(value);
    const currency = stringValue(record?.currency);
    const salaryValue = this.recordValue(record?.value);
    const min = numberValue(salaryValue?.minValue);
    const max = numberValue(salaryValue?.maxValue);
    const amount = numberValue(salaryValue?.value);
    const period = stringValue(salaryValue?.unitText);
    if (!currency && min === undefined && max === undefined && amount === undefined) return undefined;
    const originalText = [min ?? amount, max && max !== min ? max : undefined].filter((item) => item !== undefined).join(' – ');
    return this.omitUndefined({ min, max, amount, currency, period, originalText: originalText ? `${originalText} ${currency ?? ''} ${period ?? ''}`.trim() : undefined });
  }

  private locationNames(value: unknown): string[] {
    const locations = Array.isArray(value) ? value : value ? [value] : [];
    return locations.map((item) => {
      const address = this.recordValue(this.recordValue(item)?.address);
      const direct = stringValue(this.recordValue(item)?.name) ?? stringValue(item);
      const parts = [address?.addressLocality, address?.addressRegion, address?.addressCountry].map(stringValue).filter(Boolean);
      return parts.length > 0 ? parts.join(', ') : direct;
    }).filter((item): item is string => Boolean(item));
  }

  private organizationName(value: unknown): string | undefined {
    return stringValue(this.recordValue(value)?.name);
  }

  private employmentType(value: unknown): string | undefined {
    const first = Array.isArray(value) ? value.map(stringValue).find(Boolean) : stringValue(value);
    return first?.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private date(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }

  private htmlToText(html: string): string {
    const $ = load(`<main>${html}</main>`);
    $('script,style,noscript').remove();
    return this.readableText(this.nodeText($('main').get(0))) ?? '';
  }

  private nodeText(node: unknown): string {
    const current = node as { type?: string; tagName?: string; name?: string; data?: string; children?: unknown[] } | undefined;
    if (!current) return '';
    if (current.type === 'text') return current.data ?? '';
    const tag = (current.tagName ?? current.name ?? '').toLowerCase();
    if (tag === 'br') return '\n';
    const children = (current.children ?? []).map((child) => this.nodeText(child)).join('');
    if (tag === 'li') return `\n- ${children.trim()}\n`;
    if (this.isBlockTag(tag)) return `\n${children.trim()}\n`;
    return children;
  }

  private isBlockTag(tag: string): boolean {
    return /^(?:main|article|section|div|p|h[1-6]|ul|ol|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|dl|dt|dd|aside|header|footer)$/i.test(tag);
  }

  private readableText(value: string): string | undefined {
    const text = value
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n[ \t]*-\s+/g, '\n- ')
      .replace(/(- [^\n]+)\n\n(?=- )/g, '$1\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text || undefined;
  }

  private text(value: unknown): string | undefined {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || undefined : undefined;
  }

  private parseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  private graphNodes(value: unknown): Record<string, unknown>[] {
    const root = this.recordValue(value);
    const graph = root && Array.isArray(root['@graph']) ? root['@graph'] : value ? [value] : [];
    return graph.map((item) => this.recordValue(item)).filter((item): item is Record<string, unknown> => Boolean(item));
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private cardArray(value: unknown): BuiltinListCard[] {
    if (!Array.isArray(value)) return [];
    return value.map((item, index) => {
      const record = this.recordValue(item);
      if (!record) throw new Error(`Built In checkpoint detailQueue[${index}] is malformed`);
      const url = this.detailUrl(record.url, DEFAULT_LIST_URL);
      const externalId = stringValue(record.externalId);
      const title = stringValue(record.title);
      const rawText = stringValue(record.rawText);
      const listUrl = this.listUrl(record.listUrl, DEFAULT_LIST_URL);
      if (!url || !externalId || externalId !== this.externalIdFromUrl(url) || !title || rawText === undefined || !listUrl) throw new Error(`Built In checkpoint detailQueue[${index}] has an invalid native job card`);
      return {
        externalId,
        url,
        title,
        rawText,
        listUrl,
        summary: stringValue(record.summary),
        company: stringValue(record.company),
        location: stringValue(record.location),
        remoteType: stringValue(record.remoteType),
        salaryText: stringValue(record.salaryText),
        experience: stringValue(record.experience),
        publishedText: stringValue(record.publishedText),
        industries: stringArray(record.industries),
      };
    });
  }

  private checkpointPerPage(value: unknown): number {
    const parsed = numberValue(value);
    if (parsed === undefined || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DETAIL_BATCH) throw new Error('Built In continuation checkpoint has an invalid perPage');
    return parsed;
  }

  private requiredListUrl(value: unknown, base: string, field: string): string {
    const url = this.listUrl(value, base);
    if (!url) throw new Error(`Built In continuation checkpoint has an invalid ${field}`);
    return url;
  }

  private urlArray(value: unknown, base: string, field: string): string[] {
    if (!Array.isArray(value)) return [];
    const urls = value.map((item, index) => {
      const url = this.listUrl(item, base);
      if (!url) throw new Error(`Built In continuation checkpoint ${field}[${index}] is invalid`);
      return url;
    });
    if (new Set(urls).size !== urls.length) throw new Error(`Built In continuation checkpoint ${field} contains duplicate URLs`);
    return urls;
  }

  private idArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) return [];
    const ids = value.map((item, index) => {
      const id = stringValue(item);
      if (!id || !/^\d+$/.test(id)) throw new Error(`Built In continuation checkpoint ${field}[${index}] is invalid`);
      return id;
    });
    if (new Set(ids).size !== ids.length) throw new Error(`Built In continuation checkpoint ${field} contains duplicate ids`);
    return ids;
  }

  private omitUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item)) : [];
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && firstError === undefined) {
      const index = next;
      next += 1;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        firstError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}
