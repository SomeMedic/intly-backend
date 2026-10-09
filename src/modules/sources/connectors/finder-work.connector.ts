import { load } from 'cheerio';

import { WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { stringValue } from './connector-utils';

const ORIGIN = 'https://finder.work';
const LIST_URL = `${ORIGIN}/vacancies`;
const REGIONS_URL = `${ORIGIN}/vacancies/regions`;
const ALLOWED_HOSTS = ['finder.work'];
const MAX_HTML_BYTES = 2_000_000;
const WINDOW_MS = 86_400_000;

type FinderCard = {
  id: string;
  url: string;
  title?: string;
  description?: string;
  position?: number;
};

type ExtractedDocument = {
  finalUrl: string;
  html: string;
  markdown?: string;
  title?: string;
  metadata: Record<string, unknown>;
};

export class FinderWorkConnector implements Connector {
  readonly id = 'finder-work';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly extraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: 30 };
  }

  async validateConfig(): Promise<ValidationResult> {
    return {
      ok: true,
      message: 'Finder.work public vacancy listing configured',
      details: this.endpointMetadata(),
    };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1 });
      return { state: 'Healthy', message: `Finder.work returned ${page.records.length} public vacancies`, checkedAt: new Date(), details: { seen: page.stats.seen } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Finder.work fetch failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const continuing = ctx.checkpoint.hasMore === true;
    const backfillSince = this.backfillSince(ctx);
    const windowTo = this.windowTo(ctx);
    const regionUrls = continuing ? this.regionUrlsFromCheckpoint(ctx) : await this.fetchRegionUrls(ctx);
    if (regionUrls.length === 0) throw new Error('Finder.work public regions catalogue contains no region links');
    const regionIndex = continuing ? this.regionIndex(ctx, regionUrls) : 0;
    const currentListUrl = continuing ? this.safeListUrl(stringValue(ctx.checkpoint.currentListUrl), LIST_URL) : undefined;

    const regionUrl = regionUrls[regionIndex];
    if (!regionUrl) throw new Error(`Finder.work region index ${regionIndex} is outside the public regions catalogue`);
    const listUrl = currentListUrl ?? await this.regionListUrl(regionUrl, ctx);
    const pageResult = await this.fetchListPage(ctx, listUrl, regionUrl, regionIndex, regionUrls, backfillSince, windowTo);
    return pageResult;
  }

  checkpoint(result: FetchPage): Record<string, unknown> { return result.checkpoint; }

  private async fetchRegionUrls(ctx: FetchContext): Promise<string[]> {
    const document = await this.extraction.extractUrl(REGIONS_URL, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal }) as ExtractedDocument;
    if (this.safeRegionsUrl(document.finalUrl) !== REGIONS_URL) throw new Error('Finder.work regions catalogue redirected outside /vacancies/regions');
    const urls = this.regionOverviewUrls(document.html, document.finalUrl);
    if (urls.length === 0) throw new Error('Finder.work regions catalogue contains no public region links');
    return urls;
  }

  private async regionListUrl(regionUrl: string, ctx: FetchContext): Promise<string> {
    const safeRegionUrl = this.safeRegionOverviewUrl(regionUrl, REGIONS_URL);
    if (!safeRegionUrl) throw new Error(`Finder.work region URL is unsafe: ${regionUrl}`);
    const document = await this.extraction.extractUrl(safeRegionUrl, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal }) as ExtractedDocument;
    if (this.safeRegionOverviewUrl(document.finalUrl, safeRegionUrl) !== safeRegionUrl) throw new Error(`Finder.work region overview redirected outside its public page: ${safeRegionUrl}`);
    const url = this.allVacanciesListUrl(document.html, document.finalUrl);
    if (!url) throw new Error(`Finder.work region overview has no verified "Все вакансии" list link: ${safeRegionUrl}`);
    return url;
  }

  private async fetchListPage(ctx: FetchContext, listUrl: string, regionUrl: string, regionIndex: number, regionUrls: string[], backfillSince: Date, windowTo: Date): Promise<FetchPage> {
    const safeListUrl = this.safeListUrl(listUrl, LIST_URL);
    if (!safeListUrl) throw new Error('Finder.work continuation has an invalid listing URL');
    const visited = this.visitedUrls(ctx);
    if (visited.has(safeListUrl)) throw new Error(`Finder.work pagination loop detected before fetching ${safeListUrl}`);

    const document = await this.extraction.extractUrl(safeListUrl, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal }) as ExtractedDocument;
    const finalListUrl = this.safeListUrl(document.finalUrl, safeListUrl);
    if (!finalListUrl) throw new Error('Finder.work listing redirected outside the public vacancies list');
    if (finalListUrl !== safeListUrl && visited.has(finalListUrl)) throw new Error(`Finder.work listing redirected to an already visited page: ${finalListUrl}`);

    const cards = this.listCards(document.html, finalListUrl);
    if (cards.length === 0) throw new Error(`Finder.work listing contains no concrete numeric vacancy cards: ${finalListUrl}`);

    const previousIds = this.seenListIds(ctx);
    const currentIds = new Set<string>();
    const records: RawOpportunityRecord[] = [];

    for (const card of cards) {
      ctx.signal?.throwIfAborted();
      if (currentIds.has(card.id)) continue;
      currentIds.add(card.id);
      if (previousIds.has(card.id)) continue;
      const detail = await this.extraction.extractUrl(card.url, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal }) as ExtractedDocument;
      const finalDetailUrl = this.safeDetailUrl(detail.finalUrl, card.url);
      if (!finalDetailUrl) throw new Error(`Finder.work vacancy ${card.id} redirected outside its public detail page`);
      const detailId = this.detailId(finalDetailUrl);
      if (detailId !== card.id) throw new Error(`Finder.work vacancy detail id ${detailId ?? 'missing'} does not match list id ${card.id}`);
      const record = this.extraction.documentToRecord(detail, {
        sourceId: ctx.source._id,
        sourceName: ctx.source.name,
        type: ctx.source.opportunityTypes[0] ?? 'vacancy',
        requireOpportunitySignal: true,
      });
      if (record.publishedAt && (record.publishedAt.getTime() < backfillSince.getTime() || record.publishedAt.getTime() > windowTo.getTime())) continue;
      records.push({
        ...record,
        externalId: card.id,
        url: finalDetailUrl,
        rawPayload: {
          ...record.rawPayload,
          listUrl: finalListUrl,
          regionUrl,
          listCard: card,
        },
        sourceMetadata: {
          ...record.sourceMetadata,
          ...this.endpointMetadata(),
          extraction: 'finder-work-html-jobposting',
          listUrl: finalListUrl,
          regionUrl,
          regionIndex,
          listPosition: card.position,
          listTitle: card.title,
          listDescription: card.description,
          publicationWindow: {
            backfillSince: backfillSince.toISOString(),
            windowTo: windowTo.toISOString(),
            unknownDatesRetained: true,
          },
        },
      });
    }

    const nextUrl = this.nextListUrl(document.html, finalListUrl);
    visited.add(finalListUrl);
    const accumulatedIds = this.accumulatedIds(previousIds, currentIds);
    const repeatedOnly = currentIds.size > 0 && [...currentIds].every((id) => previousIds.has(id));
    if (nextUrl && visited.has(nextUrl)) throw new Error(`Finder.work pagination next URL was already visited: ${nextUrl}`);
    if (nextUrl && repeatedOnly) throw new Error(`Finder.work pagination repeated only previously seen vacancy ids at ${finalListUrl}; refusing to mark collection complete`);
    const nextRegionIndex = nextUrl ? regionIndex : regionIndex + 1;
    const nextRegionExists = nextRegionIndex < regionUrls.length;
    const hasMore = Boolean((nextUrl && !visited.has(nextUrl)) || nextRegionExists);
    const page = Number(ctx.checkpoint.nextPage ?? 0);

    return {
      records,
      hasMore,
      nextPage: hasMore ? page + 1 : undefined,
      checkpoint: hasMore ? {
        hasMore: true,
        currentListUrl: nextUrl && !visited.has(nextUrl) ? nextUrl : undefined,
        nextPage: page + 1,
        regionIndex: nextRegionIndex,
        regionUrls,
        visitedListUrls: nextUrl ? [...visited] : [],
        seenListIds: nextUrl ? accumulatedIds : [],
        backfillSince: backfillSince.toISOString(),
        windowTo: windowTo.toISOString(),
        endpoint: this.endpointMetadata(),
        lastFetchedAt: new Date().toISOString(),
      } : {
        hasMore: false,
        endpoint: this.endpointMetadata(),
        lastFetchedAt: new Date().toISOString(),
      },
      stats: { seen: cards.length },
    };
  }

  private regionOverviewUrls(html: string, finalUrl: string): string[] {
    const $ = load(html);
    const urls = new Set<string>();
    $('a[href]').each((_, item) => {
      const url = this.safeRegionOverviewUrl($(item).attr('href'), finalUrl);
      if (url) urls.add(url);
    });
    return [...urls];
  }

  private allVacanciesListUrl(html: string, finalUrl: string): string | undefined {
    const $ = load(html);
    for (const item of $('a[href]').toArray()) {
      const anchor = $(item);
      if (!/^Все\s+вакансии$/i.test(this.text(anchor.text()))) continue;
      const url = this.safeListUrl(anchor.attr('href'), finalUrl);
      if (url) return url;
    }
    return undefined;
  }

  private listCards(html: string, finalUrl: string): FinderCard[] {
    const cards = new Map<string, FinderCard>();
    for (const card of this.itemListCards(html, finalUrl)) cards.set(card.id, card);
    const $ = load(html);
    $('a[href]').each((_, item) => {
      const url = this.safeDetailUrl($(item).attr('href'), finalUrl);
      if (!url) return;
      const id = this.detailId(url);
      if (!id || cards.has(id)) return;
      const title = this.text($(item).text());
      cards.set(id, { id, url, title: title || undefined });
    });
    return [...cards.values()].sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
  }

  private itemListCards(html: string, finalUrl: string): FinderCard[] {
    const cards: FinderCard[] = [];
    for (const payload of this.jsonLdScripts(html)) {
      for (const itemList of this.jsonLdCandidates(payload)) {
        if (!this.hasSchemaType(itemList, 'ItemList')) continue;
        const elements = Array.isArray(itemList.itemListElement) ? itemList.itemListElement : [];
        for (const element of elements) {
          const record = this.recordValue(element);
          if (!record) continue;
          const url = this.safeDetailUrl(stringValue(record.url), finalUrl);
          const id = url ? this.detailId(url) : undefined;
          if (!url || !id) continue;
          cards.push({
            id,
            url,
            title: stringValue(record.name),
            description: stringValue(record.description),
            position: this.numberValue(record.position),
          });
        }
      }
    }
    return cards;
  }

  private nextListUrl(html: string, finalUrl: string): string | undefined {
    const $ = load(html);
    for (const item of $('a[href]').toArray()) {
      const anchor = $(item);
      if (!/Показать\s+еще/i.test(this.text(anchor.text()))) continue;
      const url = this.safeListUrl(anchor.attr('href'), finalUrl);
      if (url) return url;
    }
    return undefined;
  }

  private safeListUrl(value: string | undefined, from: string): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, from);
      if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return undefined;
      if (!/^\/vacancies(?:\/[a-z0-9-]+)?\/?$/.test(url.pathname)) return undefined;
      if (url.pathname.startsWith('/vacancies/regions')) return undefined;
      for (const key of url.searchParams.keys()) if (key !== 'page') return undefined;
      const page = url.searchParams.get('page');
      if (page !== null && !/^[1-9]\d*$/.test(page)) return undefined;
      url.pathname = url.pathname.replace(/\/$/, '') || '/vacancies';
      return url.toString();
    } catch { return undefined; }
  }

  private safeRegionsUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, REGIONS_URL);
      if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.port) return undefined;
      return url.pathname === '/vacancies/regions' ? url.toString() : undefined;
    } catch { return undefined; }
  }

  private safeRegionOverviewUrl(value: string | undefined, from: string): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, from);
      if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.port) return undefined;
      if (!/^\/vacancies\/regions\/[a-z0-9-]+\/?$/.test(url.pathname)) return undefined;
      url.pathname = url.pathname.replace(/\/$/, '');
      return url.toString();
    } catch { return undefined; }
  }

  private safeDetailUrl(value: string | undefined, from: string): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, from);
      if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return undefined;
      if (!/^\/vacancies\/\d+\/?$/.test(url.pathname) || url.search) return undefined;
      url.pathname = url.pathname.replace(/\/$/, '');
      return url.toString();
    } catch { return undefined; }
  }

  private detailId(urlText: string): string | undefined {
    return /^\/vacancies\/(\d+)$/.exec(new URL(urlText).pathname)?.[1];
  }

  private backfillSince(ctx: FetchContext): Date {
    const checkpoint = typeof ctx.checkpoint.backfillSince === 'string' ? Date.parse(ctx.checkpoint.backfillSince) : NaN;
    if (ctx.checkpoint.hasMore === true && Number.isFinite(checkpoint)) return new Date(checkpoint);
    const explicit = typeof ctx.backfillSince === 'string' ? Date.parse(ctx.backfillSince) : NaN;
    if (Number.isFinite(explicit)) return new Date(explicit);
    return new Date(Date.now() - Math.min(Math.max(ctx.backfillDays, 1), 30) * WINDOW_MS);
  }

  private windowTo(ctx: FetchContext): Date {
    const checkpoint = typeof ctx.checkpoint.windowTo === 'string' ? Date.parse(ctx.checkpoint.windowTo) : NaN;
    if (ctx.checkpoint.hasMore === true && Number.isFinite(checkpoint)) return new Date(checkpoint);
    return new Date();
  }

  private visitedUrls(ctx: FetchContext): Set<string> {
    const values = ctx.checkpoint.hasMore === true && Array.isArray(ctx.checkpoint.visitedListUrls) ? ctx.checkpoint.visitedListUrls : [];
    return new Set(values.filter((item): item is string => typeof item === 'string').map((item) => this.safeListUrl(item, LIST_URL)).filter((item): item is string => Boolean(item)));
  }

  private seenListIds(ctx: FetchContext): Set<string> {
    const values = ctx.checkpoint.hasMore === true && Array.isArray(ctx.checkpoint.seenListIds) ? ctx.checkpoint.seenListIds : [];
    return new Set(values.filter((item): item is string => /^\d+$/.test(item)));
  }

  private accumulatedIds(previous: Set<string>, current: Set<string>): string[] {
    return [...new Set([...previous, ...current])].slice(-1000);
  }

  private regionUrlsFromCheckpoint(ctx: FetchContext): string[] {
    const values = Array.isArray(ctx.checkpoint.regionUrls) ? ctx.checkpoint.regionUrls : [];
    const urls = values.map((item) => typeof item === 'string' ? this.safeRegionOverviewUrl(item, REGIONS_URL) : undefined).filter((item): item is string => Boolean(item));
    if (urls.length === 0) throw new Error('Finder.work continuation is missing public region catalogue URLs');
    return urls;
  }

  private regionIndex(ctx: FetchContext, regionUrls: string[]): number {
    const index = Number(ctx.checkpoint.regionIndex ?? 0);
    if (!Number.isInteger(index) || index < 0 || index >= regionUrls.length) throw new Error('Finder.work continuation has an invalid region index');
    return index;
  }

  private endpointMetadata(): Record<string, unknown> {
    return {
      parser: 'finder-work-public-html-v1',
      listUrl: LIST_URL,
      detailUrlPattern: `${ORIGIN}/vacancies/{numericId}`,
      regionsUrl: REGIONS_URL,
      observedScope: 'public-region-rotation',
      scopeLimitation: 'No verified anonymous all-region single endpoint was found; collector expands coverage through public /vacancies/regions -> /vacancies/regions/:slug -> verified "Все вакансии" region list links.',
      detailExtraction: 'WebExtractionService JobPosting/document extractor',
    };
  }

  private jsonLdScripts(html: string): unknown[] {
    const payloads: unknown[] = [];
    for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        payloads.push(JSON.parse(match[1].trim()) as unknown);
      } catch {
        continue;
      }
    }
    return payloads;
  }

  private jsonLdCandidates(value: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(value)) return value.flatMap((item) => this.jsonLdCandidates(item));
    const record = this.recordValue(value);
    if (!record) return [];
    const graph = Array.isArray(record['@graph']) ? record['@graph'].flatMap((item) => this.jsonLdCandidates(item)) : [];
    return [record, ...graph];
  }

  private hasSchemaType(value: Record<string, unknown>, type: string): boolean {
    const schemaType = value['@type'];
    return Array.isArray(schemaType) ? schemaType.includes(type) : schemaType === type;
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private text(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
}
