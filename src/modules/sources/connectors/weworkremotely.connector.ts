import { load, CheerioAPI } from 'cheerio';

import { WebExtractionHttpError, WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorCheckpoint, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, RefreshResult, ValidationResult } from './connector.types';
import { numberValue, stringValue } from './connector-utils';
import { RssFeedConnector } from './rss-feed.connector';

const ORIGIN = 'https://weworkremotely.com';
const HOME_URL = `${ORIGIN}/`;
const MAX_BACKFILL_DAYS = 30;
const MAX_HTML_BYTES = 2_000_000;
const ALLOWED_HOSTS = ['weworkremotely.com'];
const DETAIL_CONCURRENCY = 4;
const DEFAULT_DETAIL_BATCH = 25;
const CATEGORY_PATH_RE = /^\/categories\/[a-z0-9-]+jobs$/i;
const DETAIL_PATH_RE = /^\/remote-jobs\/[a-z0-9-]+$/i;
const CATEGORY_FEED_URLS = [
  'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss',
  'https://weworkremotely.com/categories/all-other-remote-jobs.rss',
  'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
  'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-management-and-finance-jobs.rss',
  'https://weworkremotely.com/categories/remote-customer-support-jobs.rss',
  'https://weworkremotely.com/categories/remote-design-jobs.rss',
  'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-product-jobs.rss',
];

type WwrCatalogLink = {
  url: string;
  label: string;
  expectedCount?: number;
  seenCount?: number;
  visitedUrls?: string[];
};

type WwrDiscovery = {
  categories: WwrCatalogLink[];
  homepageCount?: number;
  homepageCards: WwrListCard[];
};

type WwrListCard = {
  url: string;
  externalId: string;
  title: string;
  rawText: string;
  categoryUrl: string;
  categoryLabel: string;
  publishedAt?: Date;
  publishedText?: string;
  relativeDays?: number;
};

type WwrDetail = {
  externalId: string;
  url: string;
  title: string;
  company?: string;
  description?: string;
  descriptionHtml?: string;
  publishedAt?: Date;
  publishedText?: string;
  deadlineAt?: Date;
  deadlineText?: string;
  employment?: string;
  category?: string;
  region?: string;
  salaryText?: string;
  money?: Record<string, unknown>;
  rawText: string;
  dateApproximate?: boolean;
};

type CollectionWindow = { since: string; until: string; sinceDate: Date; untilDate: Date };

type WwrCheckpoint = ConnectorCheckpoint & {
  mode?: 'wwr-public-html-catalog' | 'wwr-finite-category-feed-fallback';
  backfillSince?: string;
  windowUntil?: string;
  hasMore?: boolean;
  sourceUrl?: string;
  homepageCount?: number;
  categories?: WwrCatalogLink[];
  categoryIndex?: number;
  currentCategoryNextUrl?: string;
  detailQueue?: WwrListCard[];
  seenExternalIds?: string[];
  seen?: number;
  retained?: number;
  unknownDateCount?: number;
  approximateDateCount?: number;
  unparsedControlCount?: number;
  perPage?: number;
  feedIndex?: number;
  feedUrls?: string[];
  feedCheckpoints?: ConnectorCheckpoint[];
};

type HtmlState = {
  mode: 'wwr-public-html-catalog';
  hasMore: true;
  sourceUrl: string;
  backfillSince: string;
  windowUntil: string;
  homepageCount?: number;
  categories: WwrCatalogLink[];
  categoryIndex: number;
  currentCategoryNextUrl?: string;
  detailQueue: WwrListCard[];
  seenExternalIds: string[];
  seen: number;
  retained: number;
  unknownDateCount: number;
  approximateDateCount: number;
  unparsedControlCount: number;
  perPage: number;
};

type WwrRssFallback = Pick<Connector, 'fetchPage' | 'healthCheck'>;

export class WeWorkRemotelyConnector implements Connector {
  readonly id = 'weworkremotely';
  readonly family = 'PublicHtml' as const;
  private readonly rssFallbacks: WwrRssFallback[];

  constructor(
    private readonly extraction: WebExtractionService,
    rssFallbacks: WwrRssFallback | WwrRssFallback[] = CATEGORY_FEED_URLS.map((feedUrl) => new RssFeedConnector('weworkremotely', feedUrl)),
  ) {
    this.rssFallbacks = Array.isArray(rssFallbacks) ? rssFallbacks : [rssFallbacks];
  }

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(config: Record<string, unknown> = {}): Promise<ValidationResult> {
    try {
      const configured = this.configuredHomeUrl(config);
      return { ok: true, message: 'We Work Remotely public HTML catalog configured', details: { url: configured } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'We Work Remotely catalog is not configured' };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const document = await this.fetchHtml(this.configuredHomeUrl({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) }), ctx);
      const window = this.collectionWindow({ ...ctx, checkpoint: {}, backfillDays: 1 });
      const discovered = this.discoverCategories(document.html, document.finalUrl, window);
      return { state: discovered.categories.length > 0 ? 'Healthy' : 'Failed', message: `We Work Remotely homepage exposed ${discovered.categories.length} category links`, checkedAt: new Date(Date.now()), details: { categories: discovered.categories.length, homepageCount: discovered.homepageCount } };
    } catch (error) {
      if (!this.isInitialAccessFailure(error)) return { state: 'Failed', message: error instanceof Error ? error.message : 'We Work Remotely catalog health failed', checkedAt: new Date(Date.now()) };
      try {
        const fallback = await this.rssFallbacks[0]?.healthCheck(ctx);
        if (!fallback || fallback.state === 'Failed' || fallback.state === 'Disabled') {
          return { state: 'Failed', message: `We Work Remotely HTML catalog unavailable and category RSS fallback is ${fallback?.state ?? 'unavailable'}`, checkedAt: new Date(Date.now()), details: this.omitUndefined({ accessReason: this.accessReason(error), fallbackState: fallback?.state, fallbackMessage: fallback?.message }) };
        }
        return { state: 'Degraded', message: 'We Work Remotely HTML catalog unavailable; finite category RSS fallback is usable', checkedAt: new Date(Date.now()), details: this.omitUndefined({ accessReason: this.accessReason(error), fallbackState: fallback.state, fallbackMessage: fallback.message, fallbackFeeds: this.rssFallbacks.length }) };
      } catch (fallbackError) {
        return { state: 'Failed', message: `We Work Remotely HTML catalog unavailable and category RSS fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`, checkedAt: new Date(Date.now()), details: { accessReason: this.accessReason(error) } };
      }
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const homeUrl = this.configuredHomeUrl({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) });
    const window = this.collectionWindow(ctx);
    const savedCheckpoint = (ctx.checkpoint ?? {}) as WwrCheckpoint;
    const context = savedCheckpoint.mode && savedCheckpoint.backfillSince !== window.since ? { ...ctx, checkpoint: {} } : ctx;
    const checkpoint = (context.checkpoint ?? {}) as WwrCheckpoint;
    if (checkpoint.mode && checkpoint.hasMore === false) return { records: [], hasMore: false, checkpoint, stats: { seen: 0 } };
    if (checkpoint.mode === 'wwr-finite-category-feed-fallback') return this.fetchRssFallback(context, undefined, window);

    const stateOrFallback = await this.htmlState(homeUrl, context, window);
    if ('fallback' in stateOrFallback) return stateOrFallback.fallback;
    const state = stateOrFallback;
    const records: RawOpportunityRecord[] = [];

    if (state.detailQueue.length === 0) await this.advanceOneCategoryPage(state, context, window);
    const batch = state.detailQueue.splice(0, state.perPage);
    const details = await mapWithConcurrency(batch, DETAIL_CONCURRENCY, async (card) => this.fetchDetail(card, context, window));
    for (let index = 0; index < batch.length; index += 1) {
      const record = this.record(batch[index], details[index], window);
      if (!record.publishedAt) state.unknownDateCount += 1;
      if (details[index].dateApproximate) state.approximateDateCount += 1;
      if (this.withinWindow(record.publishedAt, window)) {
        records.push(record);
        state.retained += 1;
      }
    }

    const pending = state.detailQueue.length > 0 || state.currentCategoryNextUrl !== undefined || state.categoryIndex < state.categories.length;
    const terminal = pending ? undefined : this.terminalCheckpoint(state, records.length);
    return {
      records,
      hasMore: pending,
      checkpoint: terminal ?? this.progressCheckpoint(state),
      stats: { seen: batch.length },
    };
  }

  async fetchById(externalId: string, ctx: FetchContext): Promise<RawOpportunityRecord | null> {
    const url = this.detailUrl(externalId, HOME_URL);
    if (!url) return null;
    const window = this.collectionWindow(ctx);
    const card: WwrListCard = { url, externalId: url, title: '', rawText: '', categoryUrl: '', categoryLabel: '' };
    const detail = await this.fetchDetail(card, ctx, window);
    return this.record(card, detail, window);
  }

  async refresh(occurrence: Record<string, unknown>, ctx: FetchContext): Promise<RefreshResult> {
    const externalId = stringValue(occurrence.externalId) ?? stringValue(occurrence.url);
    if (!externalId) return { record: null };
    return { record: await this.fetchById(externalId, ctx) };
  }

  checkpoint(result: FetchPage): ConnectorCheckpoint {
    return result.checkpoint;
  }

  private async htmlState(homeUrl: string, ctx: FetchContext, window: CollectionWindow): Promise<HtmlState | { fallback: FetchPage }> {
    const checkpoint = (ctx.checkpoint ?? {}) as WwrCheckpoint;
    if (checkpoint.mode === 'wwr-public-html-catalog') return this.resumeHtmlState(checkpoint, window, ctx);
    try {
      const home = await this.fetchHtml(homeUrl, ctx);
      const discovery = this.discoverCategories(home.html, home.finalUrl, window);
      const state: HtmlState = {
        mode: 'wwr-public-html-catalog',
        hasMore: true,
        sourceUrl: homeUrl,
        backfillSince: window.since,
        windowUntil: window.until,
        homepageCount: discovery.homepageCount,
        categories: discovery.categories,
        categoryIndex: 0,
        detailQueue: [],
        seenExternalIds: [],
        seen: 0,
        retained: 0,
        unknownDateCount: 0,
        approximateDateCount: 0,
        unparsedControlCount: 0,
        perPage: this.perPage(ctx),
      };
      this.enqueueFreshCards(state, discovery.homepageCards);
      return state;
    } catch (error) {
      if (!this.canFallbackToRss(ctx, error)) throw error;
      return { fallback: await this.fetchRssFallback(ctx, error, window) };
    }
  }

  private resumeHtmlState(checkpoint: WwrCheckpoint, window: CollectionWindow, ctx: FetchContext): HtmlState {
    if (checkpoint.backfillSince !== window.since) throw new Error('We Work Remotely HTML checkpoint lower bound does not match the requested collection window');
    const categories = Array.isArray(checkpoint.categories) ? checkpoint.categories.map((item) => ({ ...item, visitedUrls: stringArray(item.visitedUrls) })) : [];
    if (categories.length === 0) throw new Error('We Work Remotely checkpoint cannot resume without frozen category frontier');
    return {
      mode: 'wwr-public-html-catalog',
      hasMore: true,
      sourceUrl: stringValue(checkpoint.sourceUrl) ?? HOME_URL,
      backfillSince: window.since,
      windowUntil: window.until,
      homepageCount: numberValue(checkpoint.homepageCount),
      categories,
      categoryIndex: Math.max(0, numberValue(checkpoint.categoryIndex) ?? 0),
      currentCategoryNextUrl: stringValue(checkpoint.currentCategoryNextUrl),
      detailQueue: this.cardArray(checkpoint.detailQueue),
      seenExternalIds: stringArray(checkpoint.seenExternalIds),
      seen: numberValue(checkpoint.seen) ?? 0,
      retained: numberValue(checkpoint.retained) ?? 0,
      unknownDateCount: numberValue(checkpoint.unknownDateCount) ?? 0,
      approximateDateCount: numberValue(checkpoint.approximateDateCount) ?? 0,
      unparsedControlCount: numberValue(checkpoint.unparsedControlCount) ?? 0,
      perPage: numberValue(checkpoint.perPage) ?? this.perPage(ctx),
    };
  }

  private async advanceOneCategoryPage(state: HtmlState, ctx: FetchContext, window: CollectionWindow): Promise<void> {
    if (state.categoryIndex >= state.categories.length) return;
    const category = state.categories[state.categoryIndex];
    const pageUrl = state.currentCategoryNextUrl ?? category.url;
    if (category.visitedUrls?.includes(pageUrl)) throw new Error(`We Work Remotely category pagination cycle detected at ${pageUrl}`);
    const document = await this.fetchHtml(pageUrl, ctx);
    const finalUrl = this.categoryUrl(document.finalUrl, HOME_URL);
    if (!finalUrl) throw new Error('We Work Remotely category redirected outside public category URLs');
    category.visitedUrls = [...(category.visitedUrls ?? []), finalUrl];
    const parsed = this.parseCategory(document.html, finalUrl, category, window);
    if (parsed.unparsedPaginationControl) state.unparsedControlCount += 1;
    category.seenCount = (category.seenCount ?? 0) + parsed.cards.length;
    this.enqueueFreshCards(state, parsed.cards);
    if (parsed.nextUrl) {
      state.currentCategoryNextUrl = parsed.nextUrl;
    } else {
      state.currentCategoryNextUrl = undefined;
      state.categoryIndex += 1;
    }
  }

  private enqueueFreshCards(state: HtmlState, cards: WwrListCard[]): void {
    state.seen += cards.length;
    for (const card of cards) {
      if (state.seenExternalIds.includes(card.externalId)) continue;
      state.seenExternalIds.push(card.externalId);
      state.detailQueue.push(card);
    }
  }

  private progressCheckpoint(state: HtmlState): ConnectorCheckpoint {
    return this.omitUndefined({
      mode: state.mode,
      hasMore: true,
      sourceUrl: state.sourceUrl,
      backfillSince: state.backfillSince,
      windowUntil: state.windowUntil,
      homepageCount: state.homepageCount,
      categories: state.categories,
      categoryIndex: state.categoryIndex,
      currentCategoryNextUrl: state.currentCategoryNextUrl,
      detailQueue: state.detailQueue,
      seenExternalIds: state.seenExternalIds,
      seen: state.seen,
      uniqueSeen: state.seenExternalIds.length,
      retained: state.retained,
      unknownDateCount: state.unknownDateCount,
      approximateDateCount: state.approximateDateCount,
      unparsedControlCount: state.unparsedControlCount,
      perPage: state.perPage,
      lastFetchedAt: new Date(Date.now()).toISOString(),
    });
  }

  private terminalCheckpoint(state: HtmlState, batchRetained: number): ConnectorCheckpoint {
    const categoryCountMismatches = state.categories
      .filter((category) => category.expectedCount !== undefined && category.seenCount !== category.expectedCount)
      .map((category) => ({ url: category.url, expectedCount: category.expectedCount, seenCount: category.seenCount ?? 0 }));
    const incompleteReasons = [
      state.homepageCount !== undefined && state.homepageCount !== state.seenExternalIds.length ? 'homepage_count_reconciliation' : undefined,
      categoryCountMismatches.length > 0 ? 'category_count_reconciliation' : undefined,
      state.unparsedControlCount > 0 ? 'unparsed_controls' : undefined,
      state.unknownDateCount > 0 ? 'unknown_dates' : undefined,
    ].filter(Boolean);
    const complete = incompleteReasons.length === 0;
    return this.omitUndefined({
      mode: state.mode,
      hasMore: false,
      terminalReason: complete ? 'html-catalog-frontier-exhausted' : 'html-catalog-frontier-exhausted-incomplete',
      incompleteReason: complete ? undefined : incompleteReasons.join('_and_'),
      catalogComplete: complete,
      fullWindowCompletenessProven: complete && state.approximateDateCount === 0,
      windowIncompleteReason: state.approximateDateCount > 0 ? 'approximate_dates' : undefined,
      sourceUrl: state.sourceUrl,
      homepageCount: state.homepageCount,
      discoveredCategories: state.categories.length,
      categories: state.categories,
      categoryUrls: state.categories.map((item) => item.url),
      homepageVsUniqueSeenDelta: state.homepageCount === undefined ? undefined : state.homepageCount - state.seenExternalIds.length,
      backfillSince: state.backfillSince,
      windowUntil: state.windowUntil,
      seen: state.seen,
      uniqueSeen: state.seenExternalIds.length,
      retained: state.retained,
      retainedThisPage: batchRetained,
      unknownDateCount: state.unknownDateCount,
      approximateDateCount: state.approximateDateCount,
      unparsedControlCount: state.unparsedControlCount,
      categoryCountMismatches: categoryCountMismatches.length ? categoryCountMismatches : undefined,
      lastFetchedAt: new Date(Date.now()).toISOString(),
    });
  }

  private async fetchHtml(url: string, ctx: ConnectorContext): Promise<{ finalUrl: string; html: string }> {
    try {
      const document = await this.extraction.extractUrl(url, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal });
      throwIfAborted(ctx.signal);
      return { finalUrl: document.finalUrl, html: document.html };
    } catch (error) {
      if (error instanceof WebExtractionHttpError && error.status === 429) throw new ConnectorRateLimitError('We Work Remotely public HTML rate limited', 60);
      throw error;
    }
  }

  private discoverCategories(html: string, finalUrl: string, window: CollectionWindow): WwrDiscovery {
    const $ = load(html);
    const homepageCount = this.countFromText(this.text($('body').text()) ?? '', /All jobs\s*([\d,]+)/i);
    const byUrl = new Map<string, WwrCatalogLink>();
    $('a[href]').each((_, element) => {
      const anchor = $(element);
      const url = this.categoryUrl(anchor.attr('href'), finalUrl);
      if (!url) return;
      const label = this.text(anchor.text()) ?? categoryNameFromUrl(url);
      const expectedCount = this.countFromText(label, /View all\s+([\d,]+)/i);
      const existing = byUrl.get(url);
      byUrl.set(url, { url, label: existing?.label ?? label, expectedCount: existing?.expectedCount ?? expectedCount });
    });
    const categories = [...byUrl.values()].filter((category) => /view all|jobs|programming|design|support|marketing|product|finance|sysadmin|other/i.test(category.label));
    if (categories.length === 0) throw new Error('We Work Remotely homepage did not expose public category catalog links');
    return { categories, homepageCount, homepageCards: this.homepageCards($, finalUrl, window) };
  }

  private homepageCards($: CheerioAPI, finalUrl: string, window: CollectionWindow): WwrListCard[] {
    return this.listCards($, finalUrl, { url: HOME_URL, label: 'Homepage native job cards' }, window);
  }

  private parseCategory(html: string, finalUrl: string, category: WwrCatalogLink, window: CollectionWindow): { cards: WwrListCard[]; nextUrl?: string; unparsedPaginationControl: boolean } {
    const $ = load(html);
    const cards = this.listCards($, finalUrl, category, window);
    if (cards.length === 0) throw new Error(`We Work Remotely category ${finalUrl} contained no public job links`);
    const nextUrl = this.nextCategoryUrl($, finalUrl);
    const body = this.text($('body').text()) ?? '';
    const unparsedPaginationControl = !nextUrl && /next|load more|show more/i.test(body) && !/← Back to all jobs/i.test(body);
    return { cards, nextUrl, unparsedPaginationControl };
  }

  private listCards($: CheerioAPI, finalUrl: string, category: Pick<WwrCatalogLink, 'url' | 'label'>, window: CollectionWindow): WwrListCard[] {
    const cards: WwrListCard[] = [];
    const seen = new Set<string>();
    const roots = $('.jobs').toArray().filter((element) => !/listing-ad|advert/i.test(`${$(element).attr('class') ?? ''} ${$(element).attr('id') ?? ''}`));
    for (const root of roots) {
      $(root).find('a[href]').each((_, element) => {
        const anchor = $(element);
        if (anchor.parents('nav, header, footer, .navigation, .menu, .listing-ad').length > 0) return;
        const url = this.detailUrl(anchor.attr('href'), finalUrl);
        if (!url || seen.has(url)) return;
        const container = anchor.closest('li, article, div, section');
        const rawText = this.text((container.length ? container : anchor).text()) ?? '';
        const title = this.titleFromListText(this.text(anchor.text()) ?? rawText);
        if (!title || /^post a job$/i.test(title)) return;
        const age = this.relativeAge(rawText);
        cards.push({ url, externalId: url, title, rawText, categoryUrl: category.url, categoryLabel: category.label, publishedAt: age ? daysAgoFrom(window.untilDate, age.days) : undefined, publishedText: age?.text, relativeDays: age?.days });
        seen.add(url);
      });
    }
    return cards;
  }

  private async fetchDetail(card: WwrListCard, ctx: FetchContext, window: CollectionWindow): Promise<WwrDetail> {
    const document = await this.fetchHtml(card.url, ctx);
    const finalUrl = this.detailUrl(document.finalUrl, card.url);
    if (!finalUrl || finalUrl !== card.url) throw new Error(`We Work Remotely detail redirected away from ${card.url}`);
    return this.parseDetail(document.html, finalUrl, card, window);
  }

  private parseDetail(html: string, finalUrl: string, card: WwrListCard, window: CollectionWindow): WwrDetail {
    const $ = load(html);
    const bodyText = this.text($('body').text()) ?? '';
    const title = this.text($('h1').first().text()) || card.title;
    if (!title) throw new Error(`We Work Remotely detail ${finalUrl} has no title`);
    const descriptionRoot = this.descriptionRoot($);
    const descriptionHtml = descriptionRoot.html() ?? undefined;
    const description = descriptionHtml ? this.richText(descriptionHtml) : undefined;
    const sidebar = this.sidebarFacts($, bodyText);
    const jsonLd = this.jsonLdDates($);
    const posted = jsonLd.datePosted ?? (sidebar.publishedText ? this.postedDate(sidebar.publishedText, window) : card.publishedAt);
    const deadlineAt = jsonLd.validThrough ?? (sidebar.deadlineText ? this.deadlineDate(sidebar.deadlineText) : undefined);
    const salaryText = this.salaryText(bodyText) ?? this.salaryText(card.rawText);
    return this.omitUndefined({
      externalId: finalUrl,
      url: finalUrl,
      title,
      company: this.company($),
      description,
      descriptionHtml,
      publishedAt: posted,
      publishedText: jsonLd.datePosted ? jsonLd.datePosted.toISOString() : sidebar.publishedText ?? card.publishedText,
      deadlineAt,
      deadlineText: jsonLd.validThrough ? jsonLd.validThrough.toISOString() : sidebar.deadlineText,
      employment: sidebar.employment,
      category: sidebar.category || categoryNameFromUrl(card.categoryUrl),
      region: sidebar.region,
      salaryText,
      money: salaryText ? this.money(salaryText) : undefined,
      rawText: bodyText,
      dateApproximate: Boolean(!jsonLd.datePosted && (sidebar.publishedText || card.publishedText)),
    }) as WwrDetail;
  }

  private record(card: WwrListCard, detail: WwrDetail, window: CollectionWindow): RawOpportunityRecord {
    return {
      externalId: detail.url,
      url: detail.url,
      type: 'vacancy',
      title: detail.title,
      companyOrClient: detail.company,
      description: detail.description,
      publishedAt: detail.publishedAt,
      sourceStatus: 'Unknown',
      rawPayload: {
        listCard: card,
        detail: {
          title: detail.title,
          company: detail.company,
          description: detail.description,
          descriptionHtml: detail.descriptionHtml,
          publishedText: detail.publishedText,
          deadlineText: detail.deadlineText,
          salaryText: detail.salaryText,
          rawText: detail.rawText,
        },
        sourceUrl: HOME_URL,
      },
      sourceMetadata: this.omitUndefined({
        extraction: 'wwr-public-html-catalog',
        sourceUrl: HOME_URL,
        detailUrl: detail.url,
        categoryUrl: card.categoryUrl,
        category: detail.category,
        nativeCategory: detail.category,
        employment: detail.employment,
        nativeType: detail.employment,
        region: detail.region,
        nativeRegion: detail.region,
        area: detail.region,
        location: detail.region,
        remoteType: 'remote',
        nativeSalaryText: detail.salaryText,
        salary: detail.money ? { ...detail.money, originalText: detail.salaryText } : undefined,
        deadlineAt: detail.deadlineAt?.toISOString(),
        descriptionCoverage: detail.description ? 'detail-full' : undefined,
        dateKnown: Boolean(detail.publishedAt),
        dateApproximate: detail.dateApproximate,
        collectionWindow: { since: window.since, until: window.until },
      }),
    };
  }

  private configuredHomeUrl(config: Record<string, unknown>): string {
    const url = new URL(stringValue(config.baseUrl) ?? stringValue(config.url) ?? HOME_URL, HOME_URL);
    if (url.origin !== ORIGIN || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('We Work Remotely catalog only supports https://weworkremotely.com/');
    return url.toString();
  }

  private categoryUrl(value: unknown, base: string): string | undefined {
    const url = this.safeUrl(value, base);
    if (!url || url.origin !== ORIGIN || !CATEGORY_PATH_RE.test(url.pathname) || url.hash || url.username || url.password) return undefined;
    return url.toString();
  }

  private detailUrl(value: unknown, base: string): string | undefined {
    const url = this.safeUrl(value, base);
    if (!url || url.origin !== ORIGIN || !DETAIL_PATH_RE.test(url.pathname) || url.pathname === '/remote-jobs/new' || url.search || url.hash || url.username || url.password) return undefined;
    return url.toString();
  }

  private safeUrl(value: unknown, base: string): URL | undefined {
    const text = stringValue(value);
    if (!text) return undefined;
    try {
      return /^https?:\/\//i.test(text) ? new URL(text) : new URL(text, base);
    } catch {
      return undefined;
    }
  }

  private nextCategoryUrl($: CheerioAPI, finalUrl: string): string | undefined {
    const candidates = $('a[href]').filter((_, element) => {
      const anchor = $(element);
      return /\bnext\b|load more|show more|›|»/i.test(this.text(anchor.text()) ?? '') || /\bnext\b/i.test(anchor.attr('rel') ?? '') || /next/i.test(anchor.attr('class') ?? '');
    }).toArray();
    for (const element of candidates) {
      const url = this.categoryUrl($(element).attr('href'), finalUrl);
      if (url) return url;
    }
    return undefined;
  }

  private collectionWindow(ctx: FetchContext): CollectionWindow {
    const checkpoint = (ctx.checkpoint ?? {}) as WwrCheckpoint;
    const explicitSince = ctx.backfillSince ? Date.parse(ctx.backfillSince) : NaN;
    const backfillDays = Math.min(Math.max(ctx.backfillDays || 1, 1), MAX_BACKFILL_DAYS);
    const since = new Date(Number.isFinite(explicitSince) ? explicitSince : Date.now() - backfillDays * 86_400_000).toISOString();
    const savedSince = typeof checkpoint.backfillSince === 'string' ? checkpoint.backfillSince : undefined;
    const savedUntil = typeof checkpoint.windowUntil === 'string' ? checkpoint.windowUntil : undefined;
    const until = savedSince === since && savedUntil ? savedUntil : new Date(Date.now()).toISOString();
    return { since: savedSince === since ? savedSince : since, until, sinceDate: new Date(savedSince === since ? savedSince : since), untilDate: new Date(until) };
  }

  private withinWindow(value: Date | undefined, window: CollectionWindow): boolean {
    if (!value) return true;
    return value >= window.sinceDate && value <= window.untilDate;
  }

  private descriptionRoot($: CheerioAPI) {
    const candidates = ['.listing-container', '.content-intro', '.listing', 'article', 'main'];
    for (const selector of candidates) {
      const node = $(selector).first();
      if (node.length && this.text(node.text())) return node;
    }
    return $('body').first();
  }

  private company($: CheerioAPI): string | undefined {
    const candidates = ['.company-card h3', '[class*=company] h3', '[class*=company] a', 'h2.company'];
    for (const selector of candidates) {
      const value = this.text($(selector).first().text());
      if (value && !/^about the job$/i.test(value)) return value;
    }
    return undefined;
  }

  private sidebarFacts($: CheerioAPI, bodyText: string): { publishedText?: string; deadlineText?: string; employment?: string; category?: string; region?: string } {
    const items = $('li').map((_, element) => this.text($(element).text())).get().filter((item): item is string => Boolean(item));
    const fact = (label: RegExp) => items.find((item) => label.test(item));
    const strip = (value: string | undefined, label: RegExp) => value ? this.text(value.replace(label, '')) : undefined;
    return this.omitUndefined({
      publishedText: fact(/^Posted(?: on)?\b/i)?.match(/Posted(?: on)?\s+(.+)$/i)?.[1] ?? bodyText.match(/Posted\s+((?:New|yesterday|\d+\s*d|\d+\s+days?\s+ago))/i)?.[1],
      deadlineText: fact(/^Apply before\b/i)?.replace(/^Apply before\s+/i, ''),
      employment: strip(fact(/^Job type\b/i), /^Job type\s*/i),
      category: strip(fact(/^Category\b/i), /^Category\s*/i),
      region: strip(fact(/^Region\b/i), /^Region\s*/i),
    });
  }

  private jsonLdDates($: CheerioAPI): { datePosted?: Date; validThrough?: Date } {
    const out: { datePosted?: Date; validThrough?: Date } = {};
    $('script[type="application/ld+json"]').each((_, element) => {
      const text = $(element).text();
      out.datePosted = out.datePosted ?? this.isoDate(text.match(/"datePosted"\s*:\s*"([^"]+)"/i)?.[1]);
      out.validThrough = out.validThrough ?? this.isoDate(text.match(/"validThrough"\s*:\s*"([^"]+)"/i)?.[1]);
    });
    return out;
  }

  private isoDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }

  private postedDate(text: string | undefined, window: CollectionWindow): Date | undefined {
    const age = this.relativeAge(text ?? '');
    return age ? daysAgoFrom(window.untilDate, age.days) : undefined;
  }

  private deadlineDate(text: string): Date | undefined {
    const match = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(text);
    if (!match) return undefined;
    const months: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    return new Date(Date.UTC(Number(match[3]), months[match[1].slice(0, 3).toLowerCase()], Number(match[2]), 23, 59, 59));
  }

  private relativeAge(text: string): { text: string; days: number } | undefined {
    if (/\bNew\b/i.test(text)) return { text: 'New', days: 0 };
    const match = /\b(\d+)\s*d\b|\b(\d+)\s+days?\s+ago\b/i.exec(text);
    if (match) return { text: match[0], days: Number(match[1] ?? match[2]) };
    if (/yesterday/i.test(text)) return { text: 'yesterday', days: 1 };
    return undefined;
  }

  private titleFromListText(text: string): string | undefined {
    const beforeAge = text.split(/\b(?:New|\d+\s*d|\d+\s+days?\s+ago)\b/i)[0]?.trim();
    return stringValue(beforeAge || text.replace(/\s+HQ:.+$/i, ''));
  }

  private salaryText(text: string): string | undefined {
    const plainText = /<[^>]+>/.test(text) ? load(text).text() : text;
    return this.text(plainText.match(/\$[\d,]+(?:\s*[—–-]\s*\$?[\d,]+)?\s*USD|\$[\d,]+\s+or more\s+USD/i)?.[0] ?? '');
  }

  private money(text: string): Record<string, unknown> | undefined {
    const range = /\$([\d,]+)\s*[—–-]\s*\$?([\d,]+)\s*USD/i.exec(text);
    if (range) return { min: Number(range[1].replace(/,/g, '')), max: Number(range[2].replace(/,/g, '')), currency: 'USD' };
    const lower = /\$([\d,]+)\s+or more\s+USD/i.exec(text);
    if (lower) return { min: Number(lower[1].replace(/,/g, '')), currency: 'USD' };
    return undefined;
  }

  private richText(html: string): string | undefined {
    const $ = load(`<div>${html}</div>`);
    $('script,style,nav,aside,form').remove();
    const root = $('div').first();
    root.find('*').each((_, element) => {
      const tag = element.tagName?.toLowerCase();
      if (!tag || ['p', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'br', 'h2', 'h3', 'h4', 'div', 'span'].includes(tag)) return;
      $(element).replaceWith($(element).text());
    });
    const normalized = (root.html() ?? '').replace(/\s+class="[^"]*"/g, '').replace(/\s+id="[^"]*"/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return normalized || this.text(root.text());
  }

  private async fetchRssFallback(ctx: FetchContext, cause: unknown, window: CollectionWindow): Promise<FetchPage> {
    const checkpoint = (ctx.checkpoint ?? {}) as WwrCheckpoint;
    const feedIndex = checkpoint.mode === 'wwr-finite-category-feed-fallback' ? Math.max(0, numberValue(checkpoint.feedIndex) ?? 0) : 0;
    const feedCheckpoints = Array.isArray(checkpoint.feedCheckpoints) ? [...checkpoint.feedCheckpoints] : [];
    const seenIds = new Set(checkpoint.mode === 'wwr-finite-category-feed-fallback' ? stringArray(checkpoint.seenExternalIds) : []);
    if (feedIndex >= this.rssFallbacks.length) return this.rssFallbackPage([], feedIndex, feedCheckpoints, seenIds, 0, window, false, cause);

    throwIfAborted(ctx.signal);
    const fallback = this.rssFallbacks[feedIndex];
    const rssCheckpoint = feedCheckpoints[feedIndex] ?? {};
    const page = await fallback.fetchPage({ ...ctx, backfillSince: window.since, checkpoint: { ...rssCheckpoint, backfillSince: window.since, windowUntil: window.until } });
    feedCheckpoints[feedIndex] = page.checkpoint;
    const records: RawOpportunityRecord[] = [];
    for (const record of page.records) {
      if (seenIds.has(record.externalId)) continue;
      seenIds.add(record.externalId);
      records.push(this.enrichRssFallbackRecord(record, CATEGORY_FEED_URLS[feedIndex]));
    }
    return this.rssFallbackPage(records, feedIndex + 1, feedCheckpoints, seenIds, page.stats.seen, window, feedIndex + 1 < this.rssFallbacks.length, cause);
  }

  private rssFallbackPage(records: RawOpportunityRecord[], feedIndex: number, feedCheckpoints: ConnectorCheckpoint[], seenIds: Set<string>, seen: number, window: CollectionWindow, hasMore: boolean, cause: unknown): FetchPage {
    return {
      records,
      hasMore,
      checkpoint: this.omitUndefined({
        mode: 'wwr-finite-category-feed-fallback',
        hasMore,
        collectionScope: 'finite-category-feed-fallback',
        catalogComplete: false,
        fullWindowCompletenessProven: false,
        fallbackReason: 'initial-html-catalog-unavailable',
        accessReason: cause ? this.accessReason(cause) : undefined,
        terminalReason: hasMore ? undefined : 'finite-category-feed-fallback-exhausted',
        feedUrls: CATEGORY_FEED_URLS.slice(0, this.rssFallbacks.length),
        feedIndex,
        feedCount: this.rssFallbacks.length,
        feedCheckpoints,
        seenExternalIds: [...seenIds],
        backfillSince: window.since,
        windowUntil: window.until,
        seen,
        uniqueSeen: seenIds.size,
        retained: records.length,
        lastFetchedAt: new Date(Date.now()).toISOString(),
      }),
      stats: { seen },
    };
  }

  private enrichRssFallbackRecord(record: RawOpportunityRecord, feedUrl: string | undefined): RawOpportunityRecord {
    const salaryText = stringValue(record.sourceMetadata.salaryText) ?? (record.description ? this.salaryText(record.description) : undefined);
    const salary = salaryText ? this.money(salaryText) : undefined;
    return {
      ...record,
      sourceMetadata: this.omitUndefined({
        ...record.sourceMetadata,
        collectionScope: 'finite-category-feed-fallback',
        fallbackFeedUrl: feedUrl,
        nativeSalaryText: salaryText,
        salary: salary ? { ...salary, originalText: salaryText } : record.sourceMetadata.salary,
      }),
    };
  }

  private canFallbackToRss(ctx: FetchContext, error: unknown): boolean {
    const checkpoint = (ctx.checkpoint ?? {}) as WwrCheckpoint;
    if (checkpoint.mode === 'wwr-public-html-catalog' || Array.isArray(checkpoint.categories) || Array.isArray(checkpoint.detailQueue)) return false;
    return this.isInitialAccessFailure(error);
  }

  private isInitialAccessFailure(error: unknown): boolean {
    if (error instanceof ConnectorRateLimitError) return true;
    if (error instanceof WebExtractionHttpError && [403, 429].includes(error.status)) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|bot[_ -]?challenge|access denied|forbidden/i.test(message);
  }

  private accessReason(error: unknown): string {
    if (error instanceof ConnectorRateLimitError) return 'rate_limited';
    if (error instanceof WebExtractionHttpError) return `http_${error.status}`;
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'timeout';
    if (/bot[_ -]?challenge|access denied|forbidden/i.test(message)) return 'access_blocked';
    return 'network_or_access_error';
  }

  private perPage(ctx: FetchContext): number {
    return Math.min(Math.max(Math.floor(numberValue(ctx.source.limits?.perPage) ?? DEFAULT_DETAIL_BATCH), 1), 100);
  }

  private cardArray(value: unknown): WwrListCard[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is WwrListCard => Boolean(item && typeof item === 'object' && typeof (item as WwrListCard).url === 'string' && typeof (item as WwrListCard).externalId === 'string'));
  }

  private text(value: string): string | undefined {
    return stringValue(value.replace(/\s+/g, ' '));
  }

  private countFromText(text: string, pattern: RegExp): number | undefined {
    const match = pattern.exec(text);
    if (!match) return undefined;
    return numberValue(match[1].replace(/,/g, ''));
  }

  private omitUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
  }
}

function categoryNameFromUrl(url: string): string {
  const pathname = new URL(url).pathname;
  return pathname.replace(/^\/categories\/remote-/, '').replace(/-jobs$/i, '').replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function daysAgoFrom(anchor: Date, days: number): Date {
  return new Date(anchor.getTime() - days * 86_400_000);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !firstError) {
      const index = next;
      next += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        firstError = firstError ?? error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('We Work Remotely collection aborted');
}
