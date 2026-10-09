import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { WebExtractionHttpError, WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, RefreshResult, ValidationResult } from './connector.types';
import { FabrikantCard, FabrikantPartition, FabrikantLotPageError, FABRIKANT_ORIGIN, fabrikantDay, fabrikantDetail, fabrikantDetailUrl, fabrikantListUrl, fabrikantPublished, fabrikantStoredCard, fabrikantTenderMetadata, parseFabrikantCatalog } from './fabrikant-native';
import { FabrikantDocument, FabrikantLegacyTransport, fetchFabrikantLegacy } from './fabrikant-public-html';

const DAY_MS = 86_400_000;
const MAX_NATIVE_DETAIL_PAGES = 20;
type Window = { since: string; until: string };
type Pending = { card: FabrikantCard; catalogUrl: string };
type Clock = { now(): number; wait(ms: number, signal?: AbortSignal): Promise<void> };
const CLOCK: Clock = { now: () => performance.now(), wait: async (ms, signal) => { await delay(ms, undefined, { signal }); } };

/** Anonymous native lots from the All catalog; caps and unsupported detail surfaces remain explicit. */
export class FabrikantConnector implements Connector {
  readonly id = 'fabrikant';
  readonly family = 'TenderPlatform' as const;
  private requestTail: Promise<void> = Promise.resolve();
  private finishedAt?: number;

  constructor(private readonly extraction: WebExtractionService, private readonly legacy: FabrikantLegacyTransport = fetchFabrikantLegacy, private readonly clock: Clock = CLOCK) {}

  capabilities() { return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: 30 }; }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    try { this.baseUrl(config.baseUrl); return { ok: true, message: 'Fabrikant anonymous native All catalog configured' }; }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Invalid Fabrikant catalog URL' }; }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      this.validateSource(ctx);
      const partition = { day: fabrikantDay(new Date().toISOString()), page: 1 };
      const document = await this.extract(fabrikantListUrl(partition), ctx);
      const catalog = parseFabrikantCatalog(document.html, document.finalUrl, partition);
      return { state: 'Healthy', message: `Fabrikant returned ${catalog.cards.length} native public lots${catalog.empty ? ' (verified empty result)' : ''}`, checkedAt: new Date(), details: { scope: 'anonymous-native-all-catalog', nativeTotal: catalog.total, accessiblePages: catalog.pages, coverageVerified: false } };
    } catch (error) { return { state: 'Failed', message: error instanceof Error ? error.message : 'Fabrikant catalog access failed', checkedAt: new Date(), ...(error instanceof WebExtractionHttpError ? { details: { status: error.status, accessReason: error.accessReason, retryAfter: error.retryAfter } } : {}) }; }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    ctx.signal?.throwIfAborted();
    this.validateSource(ctx);
    const continuing = ctx.checkpoint.hasMore === true;
    if (continuing && ctx.checkpoint.collectionVersion !== 1) throw new Error('Fabrikant cannot reinterpret another connector continuation');
    const window = this.window(ctx, continuing);
    const partitions = continuing ? this.partitions(ctx.checkpoint.partitions, window) : this.days(window);
    const seen = new Set(continuing ? this.strings(ctx.checkpoint.seenNativeIds) : []);
    if ([...seen].some(id => !/^[1-9]\d*$/.test(id))) throw new Error('Fabrikant checkpoint has invalid native lot IDs');
    const pending: Pending[] = continuing ? this.pending(ctx.checkpoint.pendingDetails) : [];
    const unsupported = new Set(continuing ? this.strings(ctx.checkpoint.catalogOnlyNativeIds) : []);
    const unknownDates = new Set(continuing ? this.strings(ctx.checkpoint.unknownPublicationNativeIds) : []);
    const warnings = new Set(continuing ? this.strings(ctx.checkpoint.coverageWarnings) : []);
    const batch = continuing ? Number(ctx.checkpoint.batch) : 0;
    if (!Number.isSafeInteger(batch) || batch < 0) throw new Error('Fabrikant continuation batch is invalid');
    let listingSeen = 0;
    let lastCatalogEvidence: Record<string, unknown> | undefined;
    if (!pending.length) {
      const partition = partitions.find(item => item.status === 'pending');
      if (partition) {
        const requestedUrl = fabrikantListUrl(partition);
        const document = await this.extract(requestedUrl, ctx);
        const catalog = parseFabrikantCatalog(document.html, document.finalUrl, partition);
        listingSeen = catalog.cards.length;
        const signature = createHash('sha256').update(catalog.cards.map(card => card.id).join(',')).digest('hex');
        if (catalog.cards.length && partition.pageSignatures.includes(signature)) throw new Error('Fabrikant pagination repeated a previously returned lot page');
        if (partition.total !== undefined && partition.total !== catalog.total) warnings.add(`native-total-changed:${partition.day}:${partition.sectionId ?? 'all'}`);
        partition.total = catalog.total;
        partition.pages = catalog.pages;
        partition.pageSignatures.push(signature);
        for (const card of catalog.cards) {
          if (card.publishedText && fabrikantPublished(card.publishedText) && fabrikantDay(fabrikantPublished(card.publishedText)!.toISOString()) !== partition.day) throw new Error('Fabrikant date filter returned a lot from another publication day');
          if (!seen.has(card.id)) pending.push({ card, catalogUrl: requestedUrl });
          partition.ids = [...new Set([...partition.ids, card.id])];
        }
        const capped = (catalog.total ?? 0) > catalog.pages * 40;
        if (capped && !partition.sectionId) {
          for (const sectionId of catalog.sectionIds) if (!partitions.some(item => item.day === partition.day && item.sectionId === sectionId)) partitions.push({ day: partition.day, sectionId, page: 1, status: 'pending', ids: [], pageSignatures: [] });
        }
        if (partition.page < catalog.pages) partition.page++;
        else {
          partition.status = capped ? 'capped' : 'complete';
          if (!capped && partition.ids.length !== catalog.total) warnings.add(`native-unique-count-mismatch:${partition.day}:${partition.sectionId ?? 'all'}`);
        }
        lastCatalogEvidence = { requestedUrl, reflectedFilters: catalog.reflectedFilters, nativeTotal: catalog.total, accessiblePages: catalog.pages, capped, emptyVerified: catalog.empty };
      }
    }
    const budget = Math.floor(Math.min(40, Math.max(1, Number(ctx.source.config?.perPage ?? 20) || 20)));
    const records: RawOpportunityRecord[] = [];
    let processed = 0;
    while (pending.length && processed < budget) {
      const item = pending[0];
      const record = await this.record(item.card, item.catalogUrl, ctx, window);
      if (record.sourceMetadata.detailAvailability !== 'verified-public-native') unsupported.add(item.card.id);
      if (!record.publishedAt) unknownDates.add(item.card.id);
      if (record.sourceMetadata.windowMembership !== 'outside') records.push(record);
      seen.add(item.card.id);
      pending.shift();
      processed++;
    }
    ctx.signal?.throwIfAborted();
    const hasMore = pending.length > 0 || partitions.some(item => item.status === 'pending');
    const cappedPartitions = partitions.filter(item => item.status === 'capped').map(item => ({ day: item.day, sectionId: item.sectionId ?? null, nativeTotal: item.total, accessiblePages: item.pages, collectedNativeIds: item.ids.length, residual: item.sectionId ? 'native-section-day-result-cap' : 'native-section-taxonomy-exhaustiveness-unproven' }));
    const catalogComplete = !hasMore && !cappedPartitions.length && !warnings.size;
    return { records, hasMore, ...(hasMore ? { nextPage: batch + 2 } : {}), checkpoint: {
      collectionVersion: 1, hasMore, batch: batch + 1, ...(hasMore ? { nextPage: batch + 2 } : { terminalReason: catalogComplete ? 'native-day-pagination-exhausted' : 'accessible-native-frontier-exhausted-with-unresolved-coverage' }),
      windowSince: window.since, windowUntil: window.until, partitions, pendingDetails: pending, seenNativeIds: [...seen], catalogOnlyNativeIds: [...unsupported], unknownPublicationNativeIds: [...unknownDates], coverageWarnings: [...warnings], cappedPartitions, catalogComplete,
      detailComplete: catalogComplete && !unsupported.size, windowComplete: catalogComplete && !unknownDates.size, coverageComplete: catalogComplete && !unsupported.size && !unknownDates.size, coverage: 'anonymous-native-all-catalog-including-sales-and-price-analysis', publicationTimezone: 'Europe/Moscow', lastFetchedAt: new Date().toISOString(), ...(lastCatalogEvidence ? { lastCatalogEvidence } : {}),
    }, stats: { seen: listingSeen || processed } };
  }

  checkpoint(page: FetchPage) { return page.checkpoint; }

  async refresh(occurrence: Record<string, unknown>, ctx: FetchContext): Promise<RefreshResult> {
    this.validateSource(ctx);
    const raw = occurrence.rawPayload as Record<string, unknown> | undefined;
    const card = raw?.nativeCatalogCard ? fabrikantStoredCard(raw.nativeCatalogCard) : undefined;
    if (!card || occurrence.externalId !== card.id || typeof occurrence.url !== 'string' || fabrikantDetailUrl(occurrence.url) !== fabrikantDetailUrl(card.url) || typeof raw?.catalogUrl !== 'string') throw new Error('Fabrikant refresh requires an existing native catalog lot identity');
    const record = await this.record(card, raw.catalogUrl, ctx);
    if (!record.publishedAt && occurrence.publishedAt) {
      const previous = new Date(String(occurrence.publishedAt));
      if (Number.isFinite(previous.getTime())) record.publishedAt = previous;
    }
    return { record };
  }

  private async record(card: FabrikantCard, catalogUrl: string, ctx: ConnectorContext, window?: Window): Promise<RawOpportunityRecord> {
    let document: FabrikantDocument | undefined;
    let detail: ReturnType<typeof fabrikantDetail> = null;
    let availability = new URL(card.url).hostname === 'market.fabrikant.ru' && /^\/purchase_notice\/view\/?$/.test(new URL(card.url).pathname) ? 'native-market-spa-catalog-only' : 'unsupported-native-detail-shape';
    if (new URL(card.url).hostname !== 'market.fabrikant.ru') {
      try {
        let detailUrl = card.url;
        const visited = new Set<string>();
        const pageSignatures = new Set<string>();
        for (;;) {
          if (visited.size >= MAX_NATIVE_DETAIL_PAGES) throw new Error('Fabrikant native lot detail pagination exceeded its bounded page limit');
          if (visited.has(detailUrl)) throw new Error('Fabrikant native lot detail pagination repeats a page');
          visited.add(detailUrl);
          document = await this.extract(detailUrl, ctx);
          if (fabrikantDetailUrl(document.finalUrl) !== fabrikantDetailUrl(detailUrl)) throw new Error('Fabrikant detail redirected to another native procedure or page');
          try { detail = fabrikantDetail(card, document.html, document.finalUrl); break; }
          catch (error) {
            if (!(error instanceof FabrikantLotPageError)) throw error;
            if (pageSignatures.has(error.pageSignature)) throw new Error('Fabrikant native lot detail pagination repeats previously returned lots');
            pageSignatures.add(error.pageSignature);
            detailUrl = error.nextPageUrl;
          }
        }
        availability = detail ? 'verified-public-native' : availability;
      } catch (error) {
        if (error instanceof WebExtractionHttpError && [404, 410].includes(error.status)) availability = `native-detail-http-${error.status}`;
        else throw error;
      }
    }
    const catalogPublication = fabrikantPublished(card.publishedText);
    const publicationAgrees = !detail?.publication || !catalogPublication || Math.floor(detail.publication.getTime() / 60_000) === Math.floor(catalogPublication.getTime() / 60_000);
    let publication = publicationAgrees ? detail?.publication ?? catalogPublication : catalogPublication;
    const precision = detail?.publication && publicationAgrees ? detail.precision ?? 'minute' : 'minute';
    let windowMembership = publication ? 'inside' : 'unknown-publication';
    if (window && publication) {
      const start = publication.getTime();
      const end = start + (precision === 'minute' ? 59_999 : 0);
      if (end < Date.parse(window.since) || start > Date.parse(window.until)) windowMembership = 'outside';
      else if (start < Date.parse(window.since) || end > Date.parse(window.until)) { windowMembership = 'unknown-boundary-precision'; publication = undefined; }
    }
    const nativeStatus = detail?.nativeStatus ?? card.nativeStatus ?? '';
    const sourceStatus = /(?:заверш|отмен|закрыт)/i.test(nativeStatus) ? 'Closed' : /(?:прием|приём|ожидается|опубликован|подведени|рассмотрени)/i.test(nativeStatus) ? 'Active' : 'Unknown';
    const tenderMetadata = fabrikantTenderMetadata({ ...card, nativeStatus, publishedText: publicationAgrees ? detail?.publishedText ?? card.publishedText : card.publishedText }, detail?.text);
    return { externalId: card.id, url: card.url, type: 'tender', title: card.title, companyOrClient: card.organizer, description: detail ? `${card.text}\n\n${detail.text}` : card.text, publishedAt: publication, sourceStatus,
      rawPayload: { nativeCatalogCard: card, catalogUrl, nativeDetailText: detail?.text, nativeDetailKind: detail?.kind, nativeDetailUrl: document?.finalUrl, detailMetadata: document?.metadata, publicationText: detail?.publishedText ?? card.publishedText },
      sourceMetadata: { extraction: 'http-native-public-html', nativeLotId: card.id, procedureNumber: card.procedureNumber, lotNumber: tenderMetadata.tenderData.lotNumber, section: card.section, nativeStatus, statusEvidence: detail?.nativeStatus ? 'current-native-detail' : 'retained-native-catalog', nativePriceText: card.priceText, nativeDeadlineText: card.deadlineText, ...tenderMetadata, participationText: card.participationText, participationPayment: 'unknown', publicViewing: true, detailAvailability: availability, detailLotSpecific: detail?.lotSpecific ?? false, publicationEvidenceDisagreement: !publicationAgrees, publicationPrecision: publication ? precision : 'unknown', publicationTimezone: 'Europe/Moscow', windowMembership, catalogUrl, ...(document ? { contentHash: createHash('sha256').update(document.html).digest('hex') } : {}) },
    };
  }

  private async extract(url: string, ctx: ConnectorContext): Promise<FabrikantDocument> {
    const prior = this.requestTail;
    let release!: () => void;
    this.requestTail = new Promise(resolve => { release = resolve; });
    await prior;
    try {
      ctx.signal?.throwIfAborted();
      if (this.finishedAt !== undefined) await this.clock.wait(Math.max(0, 1000 - (this.clock.now() - this.finishedAt)), ctx.signal);
      const timeoutMs = Math.min(30_000, Math.max(1000, ctx.source.timeoutMs ?? 20_000));
      return new URL(url).pathname.startsWith('/trades/') ? await this.legacy(url, { timeoutMs, signal: ctx.signal }) : await this.extraction.extractUrl(url, { allowedHosts: ['fabrikant.ru'], timeoutMs, maxBytes: 3_000_000, signal: ctx.signal });
    } finally { this.finishedAt = this.clock.now(); release(); }
  }

  private baseUrl(value: unknown) {
    const url = new URL(typeof value === 'string' ? value : FABRIKANT_ORIGIN);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !['fabrikant.ru', 'www.fabrikant.ru'].includes(url.hostname) || !['/', '/procedure/search', '/procedure/search/'].includes(url.pathname) || url.search || url.hash) throw new Error('Fabrikant endpoint must be its unfiltered public homepage or All catalog');
  }
  private validateSource(ctx: ConnectorContext) { if (ctx.source._id !== this.id) throw new Error('Fabrikant connector source identity mismatch'); this.baseUrl(ctx.source.endpoint?.baseUrl); }
  private strings(value: unknown): string[] { if (!Array.isArray(value) || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length) throw new Error('Fabrikant checkpoint string list is invalid'); return [...value]; }
  private pending(value: unknown): Pending[] { if (!Array.isArray(value) || value.length > 40) throw new Error('Fabrikant pending details are invalid'); return value.map(item => { const card = fabrikantStoredCard(item?.card); const url = new URL(item.catalogUrl); if (url.origin !== FABRIKANT_ORIGIN || url.pathname !== '/procedure/search') throw new Error('Fabrikant pending catalog identity is invalid'); return { card, catalogUrl: url.toString() }; }); }
  private window(ctx: FetchContext, continuing: boolean): Window {
    const until = continuing ? String(ctx.checkpoint.windowUntil) : new Date().toISOString();
    const upper = Date.parse(until);
    const requested = continuing ? Date.parse(String(ctx.checkpoint.windowSince)) : ctx.backfillSince ? Date.parse(ctx.backfillSince) : upper - Math.min(30, Math.max(1, ctx.backfillDays || 1)) * DAY_MS;
    if (!Number.isFinite(upper) || !Number.isFinite(requested) || requested > upper || continuing && upper - requested > 30 * DAY_MS) throw new Error('Fabrikant frozen window is invalid');
    return { since: new Date(Math.max(requested, upper - 30 * DAY_MS)).toISOString(), until: new Date(upper).toISOString() };
  }
  private days(window: Window): FabrikantPartition[] {
    const result: FabrikantPartition[] = [];
    for (let date = Date.parse(`${fabrikantDay(window.until)}T00:00:00Z`); date >= Date.parse(`${fabrikantDay(window.since)}T00:00:00Z`); date -= DAY_MS) result.push({ day: new Date(date).toISOString().slice(0, 10), page: 1, status: 'pending', ids: [], pageSignatures: [] });
    return result;
  }
  private partitions(value: unknown, window: Window): FabrikantPartition[] {
    if (!Array.isArray(value) || !value.length || value.length > 3000) throw new Error('Fabrikant checkpoint frontier is invalid');
    const days = new Set(this.days(window).map(item => item.day));
    const identities = new Set<string>();
    const result = value.map(item => {
      if (!item || !days.has(item.day) || !['pending', 'complete', 'capped'].includes(item.status)) throw new Error('Fabrikant checkpoint partition is outside its frozen window');
      fabrikantListUrl(item);
      const identity = `${item.day}:${item.sectionId ?? 'all'}`;
      if (identities.has(identity)) throw new Error('Fabrikant checkpoint repeats a partition');
      identities.add(identity);
      return { ...item, ids: this.strings(item.ids), pageSignatures: this.strings(item.pageSignatures) } as FabrikantPartition;
    });
    if ([...days].some(day => !identities.has(`${day}:all`))) throw new Error('Fabrikant checkpoint omitted an original day partition');
    return result;
  }
}
