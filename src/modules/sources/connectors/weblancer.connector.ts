import { load } from 'cheerio';

import { WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { stringValue } from './connector-utils';

const ORIGIN = 'https://www.weblancer.net';
const LIST_URL = `${ORIGIN}/freelance/`;
const LEGACY_JOBS_URL = `${ORIGIN}/jobs/`;
const MAX_HTML_BYTES = 2_000_000;
const MAX_BACKFILL_DAYS = 30;
const DETAIL_CONCURRENCY = 4;
const DETAIL_PATH_RE = /^\/freelance\/[^?#]+-(\d+)\/$/i;

type WeblancerCard = {
  externalId: string;
  url: string;
  title: string;
  preview?: string;
  budgetText?: string;
  tags: string[];
  publishedText?: string;
  publishedAt?: Date;
  bidsText?: string;
  viewsText?: string;
};

type WeblancerDetail = {
  url: string;
  title: string;
  description: string;
  descriptionHtml: string;
  publishedText?: string;
  publishedAt?: Date;
  clientName?: string;
  clientNotice?: string;
  tags: string[];
};

type CollectionWindow = {
  since: string;
  until: string;
};

export class WeblancerConnector implements Connector {
  readonly id = 'weblancer';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly extraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    try {
      const configured = this.configuredListUrl(config);
      return { ok: true, message: 'Weblancer public freelance catalog configured', details: { url: configured, canonicalUrl: LIST_URL } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Weblancer source is not configured' };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const document = await this.extractStage('health-listing', LIST_URL, ctx);
      this.assertListUrl(document.finalUrl);
      const cards = this.cards(document.html, document.finalUrl);
      return { state: cards.length > 0 ? 'Healthy' : 'Failed', message: `Weblancer returned ${cards.length} public freelance cards`, checkedAt: new Date(), details: { cards: cards.length } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Weblancer health failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    this.configuredListUrl({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) });
    const window = this.collectionWindow(ctx);
    const listUrl = this.nextListUrl(ctx);
    const document = await this.extractStage('listing', listUrl, ctx);
    const finalListUrl = this.assertListUrl(document.finalUrl);
    const cards = this.cards(document.html, finalListUrl);
    if (cards.length === 0) throw new Error('Weblancer public freelance catalog returned no supported order cards');

    const continuingPagination = ctx.checkpoint.hasMore === true;
    const priorSeen = new Set(continuingPagination ? this.checkpointStrings(ctx.checkpoint.seenNativeIds) : []);
    const pageSeen = new Set<string>();
    const freshCards = cards.filter((card) => {
      if (priorSeen.has(card.externalId) || pageSeen.has(card.externalId)) return false;
      pageSeen.add(card.externalId);
      return true;
    });
    const details = await mapWithConcurrency(freshCards, DETAIL_CONCURRENCY, async (card) => this.detail(card, ctx));
    const records = details
      .map((detail, index) => this.record(freshCards[index], detail, finalListUrl))
      .filter((record) => this.withinWindow(record.publishedAt, window));
    const visitedListUrls = Array.from(new Set([...(continuingPagination ? this.checkpointStrings(ctx.checkpoint.visitedListUrls) : []), finalListUrl]));
    const nextUrl = this.observedNextUrl(document.html, finalListUrl);
    if (nextUrl && visitedListUrls.includes(nextUrl)) {
      throw new Error(`Weblancer pagination cycle detected at ${nextUrl}`);
    }
    const seenNativeIds = Array.from(new Set([...priorSeen, ...pageSeen]));

    return {
      records,
      hasMore: Boolean(nextUrl),
      nextPage: nextUrl ? this.pageNumber(nextUrl) : undefined,
      checkpoint: nextUrl
        ? { hasMore: true, nextUrl, nextPage: this.pageNumber(nextUrl), visitedListUrls, seenNativeIds, windowSince: window.since, windowUntil: window.until, lastFetchedAt: new Date().toISOString(), seen: cards.length, emitted: records.length }
        : { hasMore: false, visitedListUrls, seenNativeIds, terminalReason: 'observed-pagination-exhausted', windowSince: window.since, windowUntil: window.until, lastFetchedAt: new Date().toISOString(), seen: cards.length, emitted: records.length },
      stats: { seen: cards.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private cards(html: string, finalUrl: string): WeblancerCard[] {
    const $ = load(html);
    const cards: WeblancerCard[] = [];
    const seen = new Set<string>();
    $('article').each((_, element) => {
      const article = $(element);
      const anchor = article.find('h2 a[href]').first();
      const url = this.detailUrl(anchor.attr('href'), finalUrl);
      if (!url) return;
      const externalId = this.detailId(url);
      if (!externalId || seen.has(externalId)) return;
      const title = this.text(anchor.text());
      const preview = this.text(article.find('p.text-gray-600').first().text());
      if (!title || this.isLandingTitle(title)) return;
      const budgetText = this.text(article.find('span.text-green-600').first().text());
      const tags = article.find('a[href^="/freelance/"]').map((__, item) => {
        const href = $(item).attr('href') ?? '';
        const tag = this.text($(item).text());
        return href !== new URL(url).pathname && tag !== title ? tag : '';
      }).get().filter((tag): tag is string => Boolean(tag));
      const allText = this.text(article.text()) ?? '';
      const publishedText = allText.match(/\b\d{2}\.\d{2}\.\d{4}\b/)?.[0];
      cards.push({
        externalId,
        url,
        title,
        preview,
        budgetText,
        tags: Array.from(new Set(tags)),
        publishedText,
        publishedAt: this.dotDate(publishedText),
        bidsText: allText.match(/\b\d+\s+заяв(?:ка|ки|ок)\b/i)?.[0],
        viewsText: allText.match(/\b\d+\s+просмотр(?:а|ов)?\b/i)?.[0],
      });
      seen.add(externalId);
    });
    return cards;
  }

  private async detail(card: WeblancerCard, ctx: FetchContext): Promise<WeblancerDetail> {
    throwIfAborted(ctx.signal);
    const document = await this.extractStage('detail', card.url, ctx);
    throwIfAborted(ctx.signal);
    const finalUrl = this.detailUrl(document.finalUrl, card.url);
    if (!finalUrl || this.detailId(finalUrl) !== card.externalId) throw new Error(`Weblancer order ${card.externalId} redirected away from its detail page`);
    const $ = load(document.html);
    const canonical = this.detailUrl($('link[rel="canonical"]').attr('href'), finalUrl);
    if (canonical && this.detailId(canonical) !== card.externalId) throw new Error(`Weblancer order ${card.externalId} canonical URL points to another order`);
    const section = $('section.bg-white.p-6.rounded-md.shadow.space-y-5').first();
    const body = section.find('div.text-rich').first();
    const title = this.text($('h1').first().text()) || card.title;
    const description = this.richText(body.html() ?? '');
    if (!description) throw new Error(`Weblancer order ${card.externalId} has no public order description`);
    const sectionText = this.text(section.text()) ?? '';
    const publishedText = sectionText.match(/\b\d{2}\.\d{2}\.\d{4}\b/)?.[0] ?? card.publishedText;
    const notice = section.find('.text-sm.text-gray-400').first().text();
    const clientName = this.text(section.find('[itemprop="name"]').first().text()) || this.clientName(sectionText);
    const tags = section.find('a[href^="/freelance/"]').map((_, item) => this.text($(item).text())).get().filter((tag): tag is string => Boolean(tag));
    return {
      url: finalUrl,
      title,
      description,
      descriptionHtml: body.html() ?? '',
      publishedText,
      publishedAt: this.dotDate(publishedText) ?? card.publishedAt,
      clientName,
      clientNotice: this.text(notice),
      tags: Array.from(new Set(tags)),
    };
  }

  private record(card: WeblancerCard, detail: WeblancerDetail, listUrl: string): RawOpportunityRecord {
    const budget = this.budget(card.budgetText);
    const tags = detail.tags.length ? detail.tags : card.tags;
    return {
      externalId: card.externalId,
      url: detail.url,
      type: 'freelance',
      title: detail.title,
      companyOrClient: detail.clientName,
      description: detail.description,
      publishedAt: detail.publishedAt,
      sourceStatus: 'Active',
      rawPayload: {
        list: {
          sourceUrl: listUrl,
          title: card.title,
          preview: card.preview,
          budgetText: card.budgetText,
          publishedText: card.publishedText,
          bidsText: card.bidsText,
          viewsText: card.viewsText,
          tags: card.tags,
        },
        detail: {
          url: detail.url,
          title: detail.title,
          description: detail.description,
          descriptionHtml: detail.descriptionHtml,
          publishedText: detail.publishedText,
          clientName: detail.clientName,
          clientNotice: detail.clientNotice,
          tags: detail.tags,
        },
        descriptionCoverage: 'detail-full',
      },
      sourceMetadata: {
        extraction: 'weblancer-native-html-detail-v1',
        sourceUrl: listUrl,
        detailUrl: detail.url,
        descriptionCoverage: 'detail-full',
        datePrecision: detail.publishedAt ? 'day' : undefined,
        dateTimezone: detail.publishedAt ? 'UTC' : undefined,
        publishedText: detail.publishedText,
        budget,
        price: budget,
        priceText: card.budgetText,
        categoryTags: tags,
        skills: tags,
        bidsText: card.bidsText,
        viewsText: card.viewsText,
        clientPublicName: detail.clientName,
      },
    };
  }

  private configuredListUrl(config: Record<string, unknown>): string {
    const configured = stringValue(config.baseUrl) ?? stringValue(config.url) ?? LIST_URL;
    const url = new URL(configured);
    if (url.origin !== ORIGIN || url.search || url.hash || url.username || url.password) {
      throw new Error('Weblancer connector only supports https://www.weblancer.net/freelance/ or legacy https://www.weblancer.net/jobs/');
    }
    const pathname = this.slashPath(url.pathname);
    if (pathname === '/freelance/') return LIST_URL;
    if (pathname === '/jobs/') return LEGACY_JOBS_URL;
    throw new Error('Weblancer connector only supports https://www.weblancer.net/freelance/ or legacy https://www.weblancer.net/jobs/');
  }

  private async extractStage(stage: 'health-listing' | 'listing' | 'detail', url: string, ctx: FetchContext | ConnectorContext): Promise<{ finalUrl: string; html: string; metadata: Record<string, unknown> }> {
    try {
      return await this.extraction.extractUrl(url, { allowedHosts: ['www.weblancer.net'], timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error);
      const annotated = new Error(`Weblancer ${stage} fetch failed for ${url}: ${message}`);
      (annotated as Error & { cause?: unknown }).cause = error;
      throw annotated;
    }
  }

  private nextListUrl(ctx: FetchContext): string {
    if (ctx.checkpoint.hasMore !== true) return LIST_URL;
    const nextUrl = typeof ctx.checkpoint.nextUrl === 'string' ? this.listUrl(ctx.checkpoint.nextUrl) : undefined;
    if (!nextUrl) throw new Error('Weblancer continuation has an invalid listing URL');
    return nextUrl;
  }

  private assertListUrl(value: string): string {
    const url = this.listUrl(value);
    if (!url) throw new Error('Weblancer catalog redirected outside its public freelance listing');
    return url;
  }

  private listUrl(value: string): string | undefined {
    try {
      const url = new URL(value, LIST_URL);
      if (url.origin !== ORIGIN || url.username || url.password || url.hash || this.slashPath(url.pathname) !== '/freelance/') return undefined;
      const keys = [...url.searchParams.keys()];
      if (keys.some((key) => key !== 'page')) return undefined;
      if (url.searchParams.has('page') && !/^[1-9]\d*$/.test(url.searchParams.get('page') ?? '')) return undefined;
      url.hash = '';
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private detailUrl(value: string | undefined, from: string): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, from);
      if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !DETAIL_PATH_RE.test(url.pathname)) return undefined;
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private detailId(value: string): string | undefined {
    return DETAIL_PATH_RE.exec(new URL(value).pathname)?.[1];
  }

  private observedNextUrl(html: string, finalUrl: string): string | undefined {
    const $ = load(html);
    const currentPage = this.pageNumber(finalUrl);
    for (const anchor of $('a[href*="page="]').toArray()) {
      const url = this.listUrl($(anchor).attr('href') ? new URL($(anchor).attr('href')!, finalUrl).toString() : '');
      if (url && this.pageNumber(url) === currentPage + 1) return url;
    }
    return undefined;
  }

  private pageNumber(value: string): number {
    const parsed = new URL(value, LIST_URL);
    return Number.parseInt(parsed.searchParams.get('page') ?? '1', 10);
  }

  private collectionWindow(ctx: FetchContext): CollectionWindow {
    const checkpointSince = typeof ctx.checkpoint.windowSince === 'string' ? Date.parse(ctx.checkpoint.windowSince) : NaN;
    const checkpointUntil = typeof ctx.checkpoint.windowUntil === 'string' ? Date.parse(ctx.checkpoint.windowUntil) : NaN;
    const continuingSameWindow = ctx.checkpoint.hasMore === true
      && (!ctx.backfillSince || ctx.backfillSince === ctx.checkpoint.windowSince);
    if (continuingSameWindow && Number.isFinite(checkpointSince) && Number.isFinite(checkpointUntil)) {
      return { since: new Date(checkpointSince).toISOString(), until: new Date(checkpointUntil).toISOString() };
    }
    const explicitSince = ctx.backfillSince ? Date.parse(ctx.backfillSince) : NaN;
    const until = new Date();
    const backfillDays = Math.min(Math.max(ctx.backfillDays || 1, 1), MAX_BACKFILL_DAYS);
    const since = Number.isFinite(explicitSince) ? new Date(explicitSince) : new Date(until.getTime() - backfillDays * 86_400_000);
    return { since: since.toISOString(), until: until.toISOString() };
  }

  private withinWindow(date: Date | undefined, window: CollectionWindow): boolean {
    if (!date) return true;
    return date.getTime() >= Date.parse(window.since) && date.getTime() <= Date.parse(window.until);
  }

  private dotDate(text?: string): Date | undefined {
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text ?? '');
    if (!match) return undefined;
    const result = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 12, 0, 0));
    return Number.isNaN(result.getTime()) ? undefined : result;
  }

  private budget(text?: string): { amount?: number; currency?: 'USD' | 'UAH' | 'RUB' | 'EUR'; originalText?: string } {
    const amountText = text?.match(/\d[\d\s\u00a0.,]*/)?.[0];
    const amount = amountText ? Number(amountText.replace(/[\s\u00a0]/g, '').replace(',', '.')) : undefined;
    const lower = text?.toLowerCase() ?? '';
    return {
      amount: Number.isFinite(amount) ? amount : undefined,
      currency: lower.includes('$') ? 'USD' : lower.includes('₴') || lower.includes('грн') ? 'UAH' : lower.includes('₽') || lower.includes('руб') ? 'RUB' : lower.includes('€') || lower.includes('eur') ? 'EUR' : undefined,
      originalText: text,
    };
  }

  private clientName(value: string): string | undefined {
    const notice = 'Данные заказчика';
    const index = value.indexOf(notice);
    const prefix = index >= 0 ? value.slice(0, index) : '';
    return this.text(prefix.replace(/\d+\s*дн(?:я|ей)?\s*в\s*сервисе/i, ''));
  }

  private checkpointStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  private slashPath(pathname: string): string {
    return pathname.endsWith('/') ? pathname : `${pathname}/`;
  }

  private isLandingTitle(title: string): boolean {
    return /^(фриланс|freelance|weblancer|каталог фрилансеров|биржа заказов)$/i.test(title.trim());
  }

  private text(value: string): string | undefined {
    return stringValue(value.replace(/\s+/g, ' '));
  }

  private richText(value: string): string {
    if (!value) return '';
    const $ = load(`<main>${value}</main>`);
    $('br').replaceWith('\n');
    $('li').each((_, item) => {
      const element = $(item);
      element.prepend('- ');
      element.append('\n');
    });
    $('p, div, section, article, h1, h2, h3, h4, blockquote, ul, ol').each((_, item) => {
      $(item).append('\n\n');
    });
    return ($('main').text() ?? '')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
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
  throw signal.reason instanceof Error ? signal.reason : new Error('Weblancer collection aborted');
}
