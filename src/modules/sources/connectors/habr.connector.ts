import { load } from 'cheerio';

import { WebExtractionHttpError, WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorCheckpoint, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { numberValue, stringValue } from './connector-utils';

const HABR_ORIGIN = 'https://career.habr.com';
const DEFAULT_LIST_URL = `${HABR_ORIGIN}/vacancies?sort=date&type=all&page=1`;
const MAX_BACKFILL_DAYS = 30;
const MAX_HTML_BYTES = 1_500_000;
const ALLOWED_HOSTS = ['career.habr.com'];
const DETAIL_CONCURRENCY = 4;

type HabrListCard = {
  id: string;
  url: string;
  title: string;
  companyOrClient?: string;
  publishedAt?: Date;
  publishedAtRaw?: string;
  salaryText?: string;
  location?: string;
  locations: string[];
  seniority?: string;
  remoteType?: string;
  skills: string[];
  rawText: string;
};

type HabrWindow = { since: Date; to: Date; sinceIso: string; toIso: string };

type HabrCheckpoint = ConnectorCheckpoint & {
  hasMore?: boolean;
  nextUrl?: string;
  page?: number;
  backfillSince?: string;
  windowTo?: string;
  visitedListUrls?: string[];
  seenExternalIds?: string[];
};

export class HabrConnector implements Connector {
  readonly id = 'habr';
  readonly family = 'OfficialFeed' as const;

  constructor(private readonly webExtraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(): Promise<ValidationResult> {
    return { ok: true, message: 'Habr Career public HTML date-sorted vacancy list configured', details: { listUrl: DEFAULT_LIST_URL } };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1 });
      return { state: 'Healthy', message: `Habr Career HTML returned ${page.records.length} records`, checkedAt: new Date(), details: { seen: page.stats.seen, hasMore: page.hasMore } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Habr Career HTML health failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const continuing = ctx.checkpoint.hasMore === true;
    const checkpoint = ctx.checkpoint as HabrCheckpoint;
    const window = this.window(ctx, continuing, checkpoint);
    const listUrl = continuing ? this.safeListUrl(stringValue(checkpoint.nextUrl), 'checkpoint') : this.initialListUrl(ctx);
    if (!listUrl) throw new Error('Habr Career continuation has an invalid list URL');
    const visited = new Set(this.stringArray(continuing ? checkpoint.visitedListUrls : undefined));
    if (visited.has(listUrl)) throw new Error(`Habr Career pagination cycle detected at ${listUrl}`);

    let document: { finalUrl: string; html: string; metadata: Record<string, unknown> };
    try {
      document = await this.webExtraction.extractUrl(listUrl, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal });
    } catch (error) {
      if (error instanceof WebExtractionHttpError && error.status === 429) throw new ConnectorRateLimitError('Habr Career HTML rate limited', 60);
      throw error;
    }
    ctx.signal?.throwIfAborted();
    const finalUrl = this.safeListUrl(document.finalUrl, 'final URL');
    if (!finalUrl) throw new Error('Habr Career list redirected outside the public date-sorted vacancy list');
    if (finalUrl !== listUrl) throw new Error('Habr Career list redirected to a different listing URL');

    const cards = this.parseCards(document.html, finalUrl);
    if (cards.length === 0) throw new Error('Habr Career listing contains no public vacancy cards');
    const seen = new Set(this.stringArray(continuing ? checkpoint.seenExternalIds : undefined));
    const candidates = cards.filter((card) => !card.publishedAt || (card.publishedAt >= window.since && card.publishedAt <= window.to));
    const newCards: HabrListCard[] = [];
    for (const card of candidates) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      newCards.push(card);
    }
    if (continuing && candidates.length > 0 && newCards.length === 0) throw new Error(`Habr Career repeated listing page at ${finalUrl}`);
    const records = await mapWithConcurrency(newCards, DETAIL_CONCURRENCY, async (card) => {
      throwIfAborted(ctx.signal);
      const detail = await this.fetchDetail(card, ctx);
      throwIfAborted(ctx.signal);
      return this.mergeDetail(card, detail, finalUrl, window);
    });

    visited.add(finalUrl);
    const allKnownOlder = this.allKnownCardsAreOlderInDateOrder(cards, window);
    const observedNext = this.nextListUrl(document.html, finalUrl);
    if (observedNext && visited.has(observedNext)) throw new Error(`Habr Career pagination cycle detected at ${observedNext}`);
    const currentPage = this.listPage(finalUrl);
    const hasMore = Boolean(observedNext) && !allKnownOlder;
    const nextPage = hasMore ? currentPage + 1 : undefined;
    return {
      records,
      hasMore,
      nextPage,
      checkpoint: this.omitUndefined({
        hasMore,
        nextUrl: hasMore ? observedNext : undefined,
        page: nextPage,
        backfillSince: window.sinceIso,
        windowTo: window.toIso,
        visitedListUrls: [...visited],
        seenExternalIds: [...seen],
        coverage: 'public-html-date-pagination',
        terminalReason: hasMore ? undefined : allKnownOlder ? 'fixed-window-exhausted' : 'pagination-exhausted',
      }),
      stats: { seen: cards.length },
    };
  }

  checkpoint(result: FetchPage): ConnectorCheckpoint {
    return result.checkpoint;
  }

  private initialListUrl(ctx: FetchContext): string {
    const config = this.recordValue(ctx.source.config) ?? {};
    const endpoint = this.recordValue(ctx.source.endpoint) ?? {};
    const explicit = stringValue(config.listUrl) ?? stringValue(endpoint.baseUrl);
    const url = this.safeListUrl(explicit ?? DEFAULT_LIST_URL, 'initial');
    if (!url) throw new Error('Habr Career initial list URL is not the public date-sorted type=all vacancy list');
    return url;
  }

  private async fetchDetail(card: HabrListCard, ctx: FetchContext): Promise<RawOpportunityRecord> {
    try {
      const detail = await this.webExtraction.extractOpportunityFromUrl(card.url, {
        sourceId: ctx.source._id,
        sourceName: ctx.source.name,
        type: 'vacancy',
        allowedHosts: ALLOWED_HOSTS,
        requireOpportunitySignal: true,
        signal: ctx.signal,
      });
      ctx.signal?.throwIfAborted();
      const detailUrl = this.safeDetailUrl(detail.url, card.url);
      if (detailUrl !== card.url) throw new Error('Habr Career detail redirected to a different vacancy');
      return detail;
    } catch (error) {
      if (error instanceof WebExtractionHttpError && error.status === 429) throw new ConnectorRateLimitError('Habr Career detail rate limited', 60);
      throw error;
    }
  }

  private mergeDetail(card: HabrListCard, detail: RawOpportunityRecord, listUrl: string, window: HabrWindow): RawOpportunityRecord {
    const detailFacts = this.habrDeclaredFacts(detail.description);
    const sourceMetadata = {
      ...detail.sourceMetadata,
      ...detailFacts,
    } as Record<string, unknown>;
    const existingLocation = this.hasMeaningfulLocation(sourceMetadata);
    if (card.location && !existingLocation) {
      sourceMetadata.location = card.location;
      sourceMetadata.area = card.location;
      sourceMetadata.locations = card.locations;
    }
    if (card.seniority && !sourceMetadata.seniority) sourceMetadata.seniority = card.seniority;
    if (card.remoteType && !sourceMetadata.remoteType) sourceMetadata.remoteType = card.remoteType;
    if (card.skills.length) sourceMetadata.skills = card.skills;
    return {
      ...detail,
      externalId: card.id,
      url: card.url,
      type: 'vacancy',
      title: detail.title || card.title,
      companyOrClient: detail.companyOrClient || card.companyOrClient,
      publishedAt: card.publishedAt,
      rawPayload: {
        listCard: card,
        detail: detail.rawPayload,
        listUrl,
        originalWindow: { since: window.sinceIso, to: window.toIso },
        descriptionCoverage: 'detail-full',
      },
      sourceMetadata: this.omitUndefined({
        ...sourceMetadata,
        detailUrl: card.url,
        listUrl,
        listPublishedAt: card.publishedAtRaw,
        ...(card.salaryText ? { salaryText: card.salaryText } : {}),
        ...(card.location ? { listLocation: card.location, listLocations: card.locations } : {}),
        ...(card.seniority ? { listSeniority: card.seniority } : {}),
        ...(card.remoteType ? { listRemoteType: card.remoteType } : {}),
        descriptionCoverage: 'detail-full',
        collectionWindow: { since: window.sinceIso, to: window.toIso },
      }),
    };
  }

  private parseCards(html: string, finalUrl: string): HabrListCard[] {
    const $ = load(html);
    const cards: HabrListCard[] = [];
    $('.vacancy-card').each((index, element) => {
      const card = $(element);
      const titleLink = card.find('a.vacancy-card__title-link[href]').first();
      const href = titleLink.attr('href');
      const url = this.safeDetailUrl(href, finalUrl);
      if (!url) throw new Error(`Habr Career listing card ${index + 1} has an invalid public vacancy URL`);
      const id = this.vacancyId(url);
      if (!id) throw new Error(`Habr Career listing card ${index + 1} has no numeric vacancy id`);
      const title = this.text(titleLink.text());
      if (!title) throw new Error(`Habr Career listing card ${id} has no title`);
      const time = card.find('time[datetime]').first();
      const datetime = stringValue(time.attr('datetime'));
      const publishedAt = this.date(datetime);
      const salaryText = this.text(card.find('.vacancy-card__salary').text());
      const skills = card.find('.vacancy-card__skills-chip').map((__, skill) => this.text($(skill).text())).get().filter((value): value is string => Boolean(value));
      const locations: string[] = [];
      let seniority: string | undefined;
      let remoteType: string | undefined;
      card.find('.vacancy-card__meta .basic-chip').each((__, chipElement) => {
        const chip = $(chipElement);
        const text = this.text(chip.find('.chip-with-icon__text').first().text());
        if (!text) return;
        const icon = `${chip.find('use').attr('href') ?? ''} ${chip.find('use').attr('xlink:href') ?? ''}`;
        if (/#placemark\b/.test(icon)) {
          locations.push(text);
          return;
        }
        if (/#grade\b/.test(icon)) {
          seniority = seniority ?? text;
          return;
        }
        if (/удален|удалён|remote/i.test(text)) remoteType = remoteType ?? 'remote';
      });
      const uniqueLocations = [...new Set(locations)];
      cards.push({
        id,
        url,
        title,
        companyOrClient: this.text(card.find('.vacancy-card__company a').first().text()),
        publishedAt,
        publishedAtRaw: datetime ?? this.text(time.text()),
        salaryText,
        location: uniqueLocations.length ? uniqueLocations.join(', ') : undefined,
        locations: uniqueLocations,
        seniority,
        remoteType,
        skills: [...new Set(skills)],
        rawText: this.text(card.text()) ?? '',
      });
    });
    return cards;
  }

  private nextListUrl(html: string, finalUrl: string): string | undefined {
    const $ = load(html);
    const currentPage = this.listPage(finalUrl);
    const candidates: Array<{ url: string; page: number; text: string; explicit: boolean }> = [];
    $('a[href]').each((_, element) => {
      const link = $(element);
      const text = this.text($(element).text()) ?? '';
      const href = link.attr('href');
      const rel = this.text(link.attr('rel')) ?? '';
      const classes = this.text(link.attr('class')) ?? '';
      const explicit = /\bnext\b|следующ|›|→/i.test([text, rel, classes].join(' '));
      const url = this.safeListUrl(href, 'pagination');
      if (!url) {
        if (explicit) throw new Error('Habr Career observed next pagination link is not a safe type=all listing URL');
        return;
      }
      const page = numberValue(new URL(url).searchParams.get('page'));
      if (!page) return;
      if (explicit && page !== currentPage + 1) throw new Error(`Habr Career observed next pagination jumps from page ${currentPage} to ${page}`);
      candidates.push({ url, page, text, explicit });
    });
    const nextByLabel = candidates.find((entry) => entry.explicit && entry.page === currentPage + 1);
    if (nextByLabel) return nextByLabel.url;
    const adjacent = candidates.find((entry) => entry.page === currentPage + 1);
    return adjacent?.url;
  }

  private safeListUrl(input: string | undefined, _label: string): string | undefined {
    if (!input) return undefined;
    let url: URL;
    try {
      url = new URL(input, DEFAULT_LIST_URL);
    } catch {
      return undefined;
    }
    if (url.origin !== HABR_ORIGIN || url.protocol !== 'https:' || url.port || url.username || url.password) return undefined;
    if (url.pathname !== '/vacancies') return undefined;
    if (url.hash) return undefined;
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => !['page', 'sort', 'type'].includes(key))) return undefined;
    if (new Set(keys).size !== keys.length) return undefined;
    const sort = url.searchParams.get('sort');
    if (sort !== 'date') return undefined;
    const type = url.searchParams.get('type');
    if (type !== 'all') return undefined;
    const page = numberValue(url.searchParams.get('page')) ?? 1;
    if (!Number.isInteger(page) || page < 1) return undefined;
    return `${HABR_ORIGIN}/vacancies?page=${page}&sort=date&type=all`;
  }

  private safeDetailUrl(input: string | undefined, base: string): string | undefined {
    if (!input) return undefined;
    let url: URL;
    try {
      url = new URL(input, base);
    } catch {
      return undefined;
    }
    if (url.origin !== HABR_ORIGIN || url.protocol !== 'https:' || url.port || url.username || url.password) return undefined;
    if (url.search || url.hash) return undefined;
    if (!/^\/vacancies\/\d+\/?$/.test(url.pathname)) return undefined;
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString();
  }

  private vacancyId(inputUrl: string): string | undefined {
    try {
      const url = new URL(inputUrl);
      return /^\/vacancies\/(\d+)\/?$/.exec(url.pathname)?.[1];
    } catch {
      return undefined;
    }
  }

  private hasMeaningfulLocation(metadata: Record<string, unknown>): boolean {
    if (this.text(metadata.location) || this.text(metadata.area)) return true;
    const locations = metadata.locations;
    if (Array.isArray(locations)) return locations.some((location) => Boolean(this.text(location)));
    return Boolean(this.text(locations));
  }

  private listPage(inputUrl: string): number {
    const page = numberValue(new URL(inputUrl).searchParams.get('page')) ?? 1;
    if (!Number.isInteger(page) || page < 1) throw new Error('Habr Career listing URL contains invalid page');
    return page;
  }

  private allKnownCardsAreOlderInDateOrder(cards: HabrListCard[], window: HabrWindow): boolean {
    if (cards.length === 0 || cards.some((card) => !card.publishedAt)) return false;
    let previous = Number.POSITIVE_INFINITY;
    for (const card of cards) {
      const current = card.publishedAt!.getTime();
      if (current > previous) return false;
      previous = current;
    }
    return cards.every((card) => card.publishedAt! < window.since);
  }

  private window(ctx: FetchContext, continuing: boolean, checkpoint: HabrCheckpoint): HabrWindow {
    if (continuing && (!stringValue(checkpoint.backfillSince) || !stringValue(checkpoint.windowTo))) {
      throw new Error('Habr Career continuation checkpoint is missing the fixed collection window');
    }
    const since = continuing ? new Date(stringValue(checkpoint.backfillSince) as string) : new Date(ctx.backfillSince ?? Date.now() - Math.min(Math.max(ctx.backfillDays || 1, 1), MAX_BACKFILL_DAYS) * 86_400_000);
    const to = continuing ? new Date(stringValue(checkpoint.windowTo) as string) : new Date();
    if (!Number.isFinite(since.getTime()) || !Number.isFinite(to.getTime())) throw new Error('Habr Career checkpoint contains invalid collection window');
    return { since, to, sinceIso: since.toISOString(), toIso: to.toISOString() };
  }

  private date(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }

  private habrDeclaredFacts(description?: string): Record<string, unknown> {
    const declared = /^Навыки:\s*([\s\S]*?)\.\s*(?:Квалификация:\s*(.*?)\.\s*)?Специализации:/i.exec(description ?? '');
    if (!declared) return {};
    const skills = [...new Set(declared[1].split(',').map((value) => value.trim()).filter(Boolean))];
    const seniority = declared[2]?.trim();
    return { ...(skills.length ? { skills } : {}), ...(seniority ? { seniority } : {}) };
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item)) : [];
  }

  private text(value: unknown): string | undefined {
    return typeof value === 'string' && value.replace(/\s+/g, ' ').trim() ? value.replace(/\s+/g, ' ').trim() : undefined;
  }

  private omitUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown;
  async function worker(): Promise<void> {
    while (next < items.length && !firstError) {
      const index = next;
      next += 1;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        firstError = firstError ?? error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Habr Career detail enrichment aborted');
}
