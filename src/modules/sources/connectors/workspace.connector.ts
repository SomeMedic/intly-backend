import { load } from 'cheerio';

import { WebExtractionHttpError, WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, RefreshResult, ValidationResult } from './connector.types';
import { stringValue } from './connector-utils';

const ORIGIN = 'https://workspace.ru';
const LIST_URL = `${ORIGIN}/tenders/`;
const MAX_BACKFILL_DAYS = 30;
const MAX_HTML_BYTES = 2_000_000;
const DETAIL_CONCURRENCY = 4;
const DAY_MS = 86_400_000;
const TENDER_PATH_RE = /^\/tenders\/[^/?#]+-(\d+)\/$/i;

type CollectionWindow = { since: string; until: string };

type WorkspaceTenderCard = {
  externalId: string;
  url: string;
  title: string;
  budgetText?: string;
  statusText?: string;
  tenderTypeText?: string;
  viewsText?: string;
  publishedText?: string;
  publishedAt?: Date;
  deadlineText?: string;
  deadlineAt?: Date;
};

type WorkspaceTenderDetail = {
  url: string;
  title: string;
  description: string;
  descriptionHtml: string;
  budgetText?: string;
  publishedText?: string;
  publishedAt?: Date;
  deadlineText?: string;
  deadlineAt?: Date;
  requiredService?: string;
  requiredServiceUrl?: string;
  documentAttachments: WorkspaceDocumentAttachment[];
  executorPreferenceText?: string;
  organizerType?: string;
  locationText?: string;
  statusText?: string;
  tenderTypeText?: string;
  viewsText?: string;
};

type WorkspaceDocumentAttachment = {
  label: string;
  url: string;
};

type WorkspaceCheerio = ReturnType<ReturnType<typeof load>>;
type WorkspaceCheerioNode = ReturnType<WorkspaceCheerio['toArray']>[number];
type RichTextNode = { type?: string; data?: string; tagName?: string };

export class WorkspaceConnector implements Connector {
  readonly id = 'workspace';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly extraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: true, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    try {
      const url = this.configuredListUrl(config);
      return { ok: true, message: 'Workspace public tender catalog configured', details: { url } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Workspace public tender catalog is not configured' };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const document = await this.extractStage('health-listing', LIST_URL, ctx);
      const cards = this.cards(this.listHtml(document.html), document.finalUrl);
      return { state: cards.length > 0 ? 'Healthy' : 'Failed', message: `Workspace returned ${cards.length} public tender cards`, checkedAt: new Date(), details: { cards: cards.length } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Workspace health failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    this.configuredListUrl({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) });
    const window = this.collectionWindow(ctx);
    const continuing = ctx.checkpoint.hasMore === true;
    const requestedUrl = this.nextListUrl(ctx);
    const previousVisited = continuing ? this.checkpointStrings(ctx.checkpoint.visitedListUrls) : [];
    if (previousVisited.includes(requestedUrl)) throw new Error(`Workspace continuation repeats a previously visited page: ${requestedUrl}`);

    const document = await this.extractStage('listing', requestedUrl, ctx, requestedUrl !== LIST_URL);
    const finalUrl = this.assertListUrl(document.finalUrl);
    if (finalUrl !== requestedUrl) throw new Error('Workspace catalog redirected to a different page or filter');
    const html = this.listHtml(document.html);
    const cards = this.cards(html, finalUrl);
    if (cards.length === 0) throw new Error('Workspace public tender catalog returned no supported tender cards');

    const priorSeen = new Set(continuing ? this.checkpointStrings(ctx.checkpoint.seenNativeIds) : []);
    const pageSeen = new Set<string>();
    const freshCards = cards.filter((card) => {
      if (pageSeen.has(card.externalId)) throw new Error(`Workspace listing repeats native tender ID ${card.externalId}`);
      pageSeen.add(card.externalId);
      return !priorSeen.has(card.externalId);
    });

    const detailCards = freshCards.filter((card) => this.withinWindow(card.publishedAt, window));
    const details = await mapWithConcurrency(detailCards, DETAIL_CONCURRENCY, async (card) => this.detail(card, ctx));
    const records = details
      .map((detail, index) => this.record(detailCards[index], detail, finalUrl))
      .filter((record) => this.withinWindow(record.publishedAt, window));

    const visitedListUrls = Array.from(new Set([...previousVisited, finalUrl]));
    const nextUrl = this.observedNextUrl(html, finalUrl);
    if (nextUrl && visitedListUrls.includes(nextUrl)) throw new Error(`Workspace pagination cycle detected at ${nextUrl}`);
    if (continuing && freshCards.length === 0) throw new Error(`Workspace continuation page ${finalUrl} contains only previously seen native tender IDs`);
    const seenNativeIds = Array.from(new Set([...priorSeen, ...pageSeen]));

    return {
      records,
      hasMore: Boolean(nextUrl),
      nextPage: nextUrl ? this.pageNumber(nextUrl) : undefined,
      checkpoint: nextUrl
        ? { hasMore: true, nextUrl, nextPage: this.pageNumber(nextUrl), visitedListUrls, seenNativeIds, windowSince: window.since, windowUntil: window.until, coverage: 'native-public-tender-catalog', lastFetchedAt: new Date().toISOString(), seen: cards.length, emitted: records.length }
        : { hasMore: false, visitedListUrls, seenNativeIds, terminalReason: 'observed-pagination-exhausted', windowSince: window.since, windowUntil: window.until, coverage: 'native-public-tender-catalog', lastFetchedAt: new Date().toISOString(), seen: cards.length, emitted: records.length },
      stats: { seen: cards.length },
    };
  }

  async refresh(occurrence: Record<string, unknown>, ctx: FetchContext): Promise<RefreshResult> {
    this.configuredListUrl({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) });
    const card = this.refreshCard(occurrence);
    const sourceUrl = stringValue(this.valueAt(occurrence, ['sourceMetadata', 'sourceUrl'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'list', 'sourceUrl'])) ?? LIST_URL;
    const detail = await this.detail(card, ctx);
    return { record: this.record(card, detail, sourceUrl, { preferDetail: true }) };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private cards(html: string, finalUrl: string): WorkspaceTenderCard[] {
    const $ = load(html);
    const cards: WorkspaceTenderCard[] = [];
    $('[data-tender-card], .vacancies__card._tender').each((_, element) => {
      const card = $(element);
      const anchor = card.find('a[href^="/tenders/"]').filter((__, item) => TENDER_PATH_RE.test(new URL($(item).attr('href')!, finalUrl).pathname)).first();
      const url = this.tenderUrl(anchor.attr('href'), finalUrl);
      if (!url) return;
      const externalId = this.tenderId(url);
      const title = this.text(anchor.text());
      if (!externalId || !title || title === 'Workspace') return;
      const labels = card.find('.b-tender__info-item').map((__, item) => {
        const label = this.text($(item).find('.b-tender__info-item-title').first().text()).toLowerCase();
        const value = this.text($(item).find('.b-tender__info-item-text').first().text());
        return { label, value };
      }).get();
      const info = this.info(labels);
      const budgetText = this.text(card.find('.b-tender__block--title > .b-tender__info-item-text').first().text()) || info.budgetText;
      const statusText = this.text(card.find('.tendercart-type__status-public').first().text());
      const tenderTypeText = this.text(card.find('.reference._public, .reference._private').first().text());
      const viewsText = this.text(card.find('.reference._views').first().text());
      cards.push({
        externalId,
        url,
        title,
        budgetText,
        statusText,
        tenderTypeText,
        viewsText,
        publishedText: info.publishedText,
        publishedAt: this.ruDate(info.publishedText),
        deadlineText: info.deadlineText,
        deadlineAt: this.ruDate(info.deadlineText),
      });
    });
    return cards;
  }

  private async detail(card: WorkspaceTenderCard, ctx: FetchContext): Promise<WorkspaceTenderDetail> {
    const document = await this.extractStage('detail', card.url, ctx);
    const finalUrl = this.tenderUrl(document.finalUrl, card.url);
    if (!finalUrl || this.tenderId(finalUrl) !== card.externalId) throw new Error(`Workspace tender ${card.externalId} redirected away from its detail page`);
    const $ = load(document.html);
    const canonical = this.tenderUrl($('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content'), finalUrl);
    if (canonical && this.tenderId(canonical) !== card.externalId) throw new Error(`Workspace tender ${card.externalId} canonical URL points to another tender`);
    const title = this.text($('h1').first().text()) || card.title;
    const detailRoot = this.detailRoot($);
    const desc = detailRoot.find('.tendercard__desc').first();
    const descriptionHtml = desc.html() ?? '';
    const description = this.richText(descriptionHtml);
    if (!description) throw new Error(`Workspace tender ${card.externalId} has no public tender detail description`);
    const labels = detailRoot.find('.b-tender__info-item, .tendercard__info-item, .tendercard__conditions-item, .tendercard__conditions-row').map((_, item) => {
      const node = $(item);
      const label = this.text(node.find('.b-tender__info-item-title, .tendercard__info-title, .tendercard__conditions-title, .tendercard__conditions-label').first().text());
      const value = this.text(node.find('.b-tender__info-item-text, .tendercard__info-text, .tendercard__conditions-text, .tendercard__conditions-value').first().text());
      return { label: label.toLowerCase(), value };
    }).get();
    const info = this.info(labels);
    const detailText = this.text(detailRoot.text() || $('body').text());
    const requiredServiceAnchor = this.anchorAfterHeading($, detailRoot, /требуемая услуга/i);
    return {
      url: canonical ?? finalUrl,
      title,
      description,
      descriptionHtml,
      budgetText: info.budgetText || this.valueAfterLabel(detailText, /Бюджет:/i),
      publishedText: info.publishedText || this.valueAfterLabel(detailText, /Опубликован:/i),
      publishedAt: this.ruDate(info.publishedText || this.valueAfterLabel(detailText, /Опубликован:/i)),
      deadlineText: info.deadlineText || this.valueAfterLabel(detailText, /Крайний срок приема заявок:/i),
      deadlineAt: this.ruDate(info.deadlineText || this.valueAfterLabel(detailText, /Крайний срок приема заявок:/i)),
      requiredService: requiredServiceAnchor?.text,
      requiredServiceUrl: requiredServiceAnchor?.url,
      documentAttachments: this.documentAttachments($, detailRoot, finalUrl),
      executorPreferenceText: this.textAfterHeading($, detailRoot, /Исполнители/i) || this.valueAfterLabel(detailText, /Исполнители/i),
      organizerType: this.textAfterHeading($, detailRoot, /Oрганизатор|Организатор/i) || this.valueAfterLabel(detailText, /Oрганизатор|Организатор/i),
      locationText: this.locationText(detailText),
      statusText: this.text($('.tendercart-type__status-public, [data-change-status-text]').first().text()) || card.statusText,
      tenderTypeText: this.text($('.reference._public, .reference._private').first().text()) || card.tenderTypeText,
      viewsText: this.text($('.reference._views').first().text()) || card.viewsText,
    };
  }

  private record(card: WorkspaceTenderCard, detail: WorkspaceTenderDetail, listUrl: string, options: { preferDetail?: boolean } = {}): RawOpportunityRecord {
    const budgetText = options.preferDetail ? (detail.budgetText || card.budgetText) : (card.budgetText || detail.budgetText);
    const budget = this.budget(budgetText);
    const publishedAt = options.preferDetail ? (detail.publishedAt ?? card.publishedAt) : (card.publishedAt ?? detail.publishedAt);
    const deadlineAt = options.preferDetail ? (detail.deadlineAt ?? card.deadlineAt) : (card.deadlineAt ?? detail.deadlineAt);
    const publishedText = options.preferDetail ? (detail.publishedText || card.publishedText) : (card.publishedText || detail.publishedText);
    const deadlineText = options.preferDetail ? (detail.deadlineText || card.deadlineText) : (card.deadlineText || detail.deadlineText);
    const statusText = options.preferDetail ? (detail.statusText || card.statusText) : (card.statusText || detail.statusText);
    const tenderTypeText = options.preferDetail ? (detail.tenderTypeText || card.tenderTypeText) : (card.tenderTypeText || detail.tenderTypeText);
    const viewsText = options.preferDetail ? (detail.viewsText || card.viewsText) : (card.viewsText || detail.viewsText);
    const documentAttachments = this.sanitizedDocumentAttachments(detail.documentAttachments);
    const tenderData = compactRecord({
      category: detail.requiredService,
      customer: undefined,
      region: detail.locationText,
      procurementMethod: tenderTypeText,
      contractNumber: undefined,
      platform: 'Workspace',
      requiredService: detail.requiredService,
      executorPreferenceText: detail.executorPreferenceText,
      organizerType: detail.organizerType,
      statusText,
      viewsText,
      documentAttachments: documentAttachments.length ? documentAttachments : undefined,
    });
    return {
      externalId: card.externalId,
      url: detail.url,
      type: 'tender',
      title: detail.title,
      description: detail.description,
      publishedAt,
      sourceStatus: this.sourceStatus(statusText),
      rawPayload: {
        list: {
          sourceUrl: listUrl,
          detailUrl: card.url,
          title: card.title,
          budgetText: card.budgetText,
          statusText: card.statusText,
          tenderTypeText: card.tenderTypeText,
          viewsText: card.viewsText,
          publishedText: card.publishedText,
          deadlineText: card.deadlineText,
        },
        detail: {
          url: detail.url,
          title: detail.title,
          description: detail.description,
          descriptionHtml: detail.descriptionHtml,
          budgetText: detail.budgetText,
          statusText: detail.statusText,
          tenderTypeText: detail.tenderTypeText,
          viewsText: detail.viewsText,
          publishedText: detail.publishedText,
          deadlineText: detail.deadlineText,
          requiredService: detail.requiredService,
          requiredServiceUrl: detail.requiredServiceUrl,
          documentAttachments,
          executorPreferenceText: detail.executorPreferenceText,
          organizerType: detail.organizerType,
          locationText: detail.locationText,
        },
        nativePayload: {
          budgetText,
          publishedText,
          deadlineText,
          tenderData,
        },
        descriptionCoverage: 'detail-full',
      },
      sourceMetadata: {
        extraction: 'workspace-native-html-detail-v1',
        sourceUrl: listUrl,
        detailUrl: detail.url,
        descriptionCoverage: 'detail-full',
        budget,
        deadlineAt: deadlineAt?.toISOString(),
        deadlineText,
        deadlinePrecision: deadlineAt ? 'day' : undefined,
        deadlineTimezone: deadlineAt ? 'UTC' : undefined,
        publishedText,
        datePrecision: publishedAt ? 'day' : undefined,
        dateTimezone: publishedAt ? 'UTC' : undefined,
        statusText,
        tenderTypeText,
        location: detail.locationText,
        categoryTags: detail.requiredService ? [detail.requiredService] : [],
        skills: detail.requiredService ? [detail.requiredService] : [],
        sourceDocuments: documentAttachments,
        tenderData,
      },
    };
  }

  private configuredListUrl(config: Record<string, unknown>): string {
    const configured = stringValue(config.baseUrl) ?? stringValue(config.url) ?? LIST_URL;
    const url = new URL(configured);
    if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || this.slashPath(url.pathname) !== '/tenders/') {
      throw new Error('Workspace connector only supports https://workspace.ru/tenders/');
    }
    return LIST_URL;
  }

  private async extractStage(stage: 'health-listing' | 'listing' | 'detail', url: string, ctx: FetchContext | ConnectorContext, ajax = false): Promise<{ finalUrl: string; html: string; metadata: Record<string, unknown> }> {
    try {
      return await this.extraction.extractUrl(url, { allowedHosts: ['workspace.ru'], timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal, ...(ajax ? { ajaxHtmlField: 'tender' as const } : {}) });
    } catch (error) {
      if (error instanceof WebExtractionHttpError || (error instanceof Error && error.name === 'AbortError')) throw error;
      const message = error instanceof Error && error.message ? error.message : String(error);
      const annotated = new Error(`Workspace ${stage} fetch failed for ${url}: ${message}`);
      (annotated as Error & { cause?: unknown }).cause = error;
      throw annotated;
    }
  }

  private refreshCard(occurrence: Record<string, unknown>): WorkspaceTenderCard {
    const externalId = stringValue(occurrence.externalId);
    if (!externalId || !/^[1-9]\d*$/.test(externalId)) throw new Error('Workspace refresh requires a numeric externalId');
    const retainedUrl = stringValue(occurrence.url) ?? stringValue(this.valueAt(occurrence, ['sourceMetadata', 'detailUrl'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'detail', 'url'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'list', 'detailUrl']));
    const url = this.tenderUrl(retainedUrl, LIST_URL);
    if (!url) throw new Error('Workspace refresh requires an exact native tender URL');
    if (this.tenderId(url) !== externalId) throw new Error('Workspace refresh occurrence URL does not match externalId');
    const publishedText = stringValue(this.valueAt(occurrence, ['sourceMetadata', 'publishedText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'detail', 'publishedText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'list', 'publishedText']));
    const deadlineText = stringValue(this.valueAt(occurrence, ['sourceMetadata', 'deadlineText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'detail', 'deadlineText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'list', 'deadlineText']));
    return {
      externalId,
      url,
      title: stringValue(occurrence.title) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'detail', 'title'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'list', 'title'])) ?? '',
      budgetText: stringValue(this.valueAt(occurrence, ['sourceMetadata', 'budget', 'originalText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'detail', 'budgetText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'list', 'budgetText'])),
      statusText: stringValue(this.valueAt(occurrence, ['sourceMetadata', 'statusText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'detail', 'statusText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'list', 'statusText'])),
      tenderTypeText: stringValue(this.valueAt(occurrence, ['sourceMetadata', 'tenderTypeText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'detail', 'tenderTypeText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'list', 'tenderTypeText'])),
      viewsText: stringValue(this.valueAt(occurrence, ['rawPayload', 'detail', 'viewsText'])) ?? stringValue(this.valueAt(occurrence, ['rawPayload', 'list', 'viewsText'])),
      publishedText,
      publishedAt: this.dateValue(occurrence.publishedAt) ?? this.ruDate(publishedText),
      deadlineText,
      deadlineAt: this.dateValue(this.valueAt(occurrence, ['sourceMetadata', 'deadlineAt'])) ?? this.ruDate(deadlineText),
    };
  }

  private nextListUrl(ctx: FetchContext): string {
    if (ctx.checkpoint.hasMore !== true) return LIST_URL;
    const nextUrl = typeof ctx.checkpoint.nextUrl === 'string' ? this.listUrl(ctx.checkpoint.nextUrl) : undefined;
    if (!nextUrl) throw new Error('Workspace continuation has an invalid listing URL');
    if (ctx.backfillSince && ctx.checkpoint.windowSince && ctx.backfillSince !== ctx.checkpoint.windowSince) throw new Error('Workspace lower publication boundary changed');
    this.fixedCheckpointWindow(ctx.checkpoint);
    return nextUrl;
  }

  private assertListUrl(value: string): string {
    const url = this.listUrl(value);
    if (!url) throw new Error('Workspace catalog redirected outside its public tender listing');
    return url;
  }

  private listUrl(value: string): string | undefined {
    try {
      const url = new URL(value, LIST_URL);
      if (url.origin !== ORIGIN || url.username || url.password || url.hash || this.slashPath(url.pathname) !== '/tenders/') return undefined;
      if ([...url.searchParams.keys()].some((key) => !['page', 'SORT', 'ORDER'].includes(key))) return undefined;
      const page = url.searchParams.get('page');
      const sort = url.searchParams.get('SORT');
      const order = url.searchParams.get('ORDER');
      if (page !== null && (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)))) return undefined;
      if (sort !== null && sort !== 'public') return undefined;
      if (order !== null && order !== '0') return undefined;
      url.pathname = '/tenders/';
      url.search = '';
      if (page && page !== '1') url.searchParams.set('page', page);
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private tenderUrl(value: string | undefined, from: string): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, from);
      if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !TENDER_PATH_RE.test(url.pathname)) return undefined;
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private tenderId(value: string): string | undefined {
    return TENDER_PATH_RE.exec(new URL(value).pathname)?.[1];
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
    return Number.parseInt(new URL(value, LIST_URL).searchParams.get('page') ?? '1', 10);
  }

  private collectionWindow(ctx: FetchContext): CollectionWindow {
    const continuingSameWindow = ctx.checkpoint.hasMore === true && (!ctx.backfillSince || ctx.backfillSince === ctx.checkpoint.windowSince);
    if (ctx.checkpoint.hasMore === true) {
      const checkpoint = this.fixedCheckpointWindow(ctx.checkpoint);
      if (!continuingSameWindow) throw new Error('Workspace continuation cannot change its fixed publication window');
      return checkpoint;
    }
    const backfillDays = Math.min(Math.max(ctx.backfillDays || 1, 1), MAX_BACKFILL_DAYS);
    const now = new Date();
    if (ctx.backfillSince) {
      const explicitSince = Date.parse(ctx.backfillSince);
      if (!Number.isFinite(explicitSince) || explicitSince > now.getTime()) throw new Error('Workspace initial publication boundary is invalid or in the future');
      const since = new Date(explicitSince);
      const until = new Date(Math.min(now.getTime(), explicitSince + backfillDays * DAY_MS));
      return { since: since.toISOString(), until: until.toISOString() };
    }
    const until = now;
    const since = new Date(until.getTime() - backfillDays * DAY_MS);
    return { since: since.toISOString(), until: until.toISOString() };
  }

  private fixedCheckpointWindow(checkpoint: Record<string, unknown>): CollectionWindow {
    const since = typeof checkpoint.windowSince === 'string' ? Date.parse(checkpoint.windowSince) : NaN;
    const until = typeof checkpoint.windowUntil === 'string' ? Date.parse(checkpoint.windowUntil) : NaN;
    if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error('Workspace continuation has invalid fixed publication boundaries');
    return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
  }

  private withinWindow(date: Date | undefined, window: CollectionWindow): boolean {
    if (!date) return true;
    return date.getTime() >= Date.parse(window.since) && date.getTime() <= Date.parse(window.until);
  }

  private listHtml(html: string): string {
    const trimmed = html.trim();
    if (!trimmed.startsWith('{')) return html;
    const parsed = JSON.parse(trimmed) as { tender?: unknown };
    if (typeof parsed.tender !== 'string') throw new Error('Workspace AJAX listing response is missing tender HTML');
    return parsed.tender;
  }

  private info(labels: { label: string; value: string }[]): { budgetText?: string; publishedText?: string; deadlineText?: string } {
    const result: { budgetText?: string; publishedText?: string; deadlineText?: string } = {};
    for (const { label, value } of labels) {
      if (!value) continue;
      if (label.includes('бюджет')) result.budgetText = value;
      if (label.includes('опубликован')) result.publishedText = value;
      if (label.includes('крайний срок')) result.deadlineText = value;
    }
    return result;
  }

  private sourceStatus(text?: string): RawOpportunityRecord['sourceStatus'] {
    const lower = text?.toLowerCase() ?? '';
    if (lower.includes('идет') || lower.includes('идёт')) return 'Active';
    if (lower.includes('заверш') || lower.includes('закрыт')) return 'Closed';
    return 'Unknown';
  }

  private budget(text?: string): { min?: number; max?: number; currency?: 'RUB'; originalText?: string } {
    const numbers = Array.from((text ?? '').matchAll(/\d[\d\s\u00a0]*(?:[.,]\d+)?/g)).map((match) => Number(match[0].replace(/[\s\u00a0]/g, '').replace(',', '.'))).filter((value) => Number.isFinite(value) && value > 0);
    const lower = text?.toLowerCase() ?? '';
    const hasCurrency = numbers.length > 0 && !/(договор|не указан|не определ|без бюджета|по договор)/i.test(lower);
    const [first, second] = numbers;
    return compactRecord({
      min: lower.includes('до') && numbers.length === 1 ? undefined : first,
      max: lower.includes('от') && numbers.length === 1 ? undefined : (second ?? (lower.includes('до') ? first : undefined)),
      currency: hasCurrency ? 'RUB' : undefined,
      originalText: text,
    }) as { min?: number; max?: number; currency?: 'RUB'; originalText?: string };
  }

  private ruDate(text?: string): Date | undefined {
    const match = /(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i.exec(text ?? '');
    if (!match) return undefined;
    const month = RU_MONTHS[match[2].toLowerCase()];
    if (month === undefined) return undefined;
    const result = new Date(Date.UTC(Number(match[3]), month, Number(match[1]), 12, 0, 0));
    return Number.isNaN(result.getTime()) ? undefined : result;
  }

  private detailRoot($: ReturnType<typeof load>): WorkspaceCheerio {
    const desc = $('.tendercard__desc').first();
    return desc.length ? desc.closest('main, article, .grid__content, .content, body') : $('body');
  }

  private anchorAfterHeading($: ReturnType<typeof load>, root: WorkspaceCheerio, heading: RegExp): { text: string; url?: string } | undefined {
    for (const element of root.find('h2, h3, .tendercard__conditions-title, .b-tender__info-item-title, div, p').toArray()) {
      const node = $(element);
      if (!heading.test(this.text(node.clone().children().remove().end().text()))) continue;
      const anchor = node.nextUntil('h2, h3, .tendercard__conditions-title, .b-tender__info-item-title').find('a[href]').addBack('a[href]').first();
      const text = this.text(anchor.text());
      if (text) return { text, url: anchor.attr('href') ? new URL(anchor.attr('href')!, ORIGIN).toString() : undefined };
    }
    return undefined;
  }

  private valueAfterLabel(text: string, label: RegExp): string | undefined {
    const lines = text.split(/\s{2,}|\n/).map((line) => line.trim()).filter(Boolean);
    const index = lines.findIndex((line) => label.test(line));
    if (index < 0) return undefined;
    return lines[index].replace(label, '').trim() || lines[index + 1];
  }

  private textAfterHeading($: ReturnType<typeof load>, root: WorkspaceCheerio, heading: RegExp): string | undefined {
    for (const element of root.find('h2, h3, .tendercard__conditions-title, .b-tender__info-item-title, div, p').toArray()) {
      const node = $(element);
      if (!heading.test(this.text(node.clone().children().remove().end().text()))) continue;
      const value = this.text(node.nextUntil('h2, h3, .tendercard__conditions-title, .b-tender__info-item-title').filter('p, div, span').first().text());
      if (value) return value;
    }
    return undefined;
  }

  private documentAttachments($: ReturnType<typeof load>, root: WorkspaceCheerio, finalUrl: string): WorkspaceDocumentAttachment[] {
    const attachments: WorkspaceDocumentAttachment[] = [];
    const roots = this.attachmentRoots($, root);
    roots.find('a[href]').each((_, item) => {
      const href = $(item).attr('href');
      if (!href) return;
      const url = new URL(href, finalUrl);
      const label = this.text($(item).text()) || url.pathname.split('/').at(-1) || url.toString();
      if (!this.isTenderDocumentUrl(url)) return;
      attachments.push({ label, url: url.toString() });
    });
    return this.sanitizedDocumentAttachments(attachments);
  }

  private attachmentRoots($: ReturnType<typeof load>, root: WorkspaceCheerio): WorkspaceCheerio {
    const selector = [
      '.tendercard__desc',
      '[class*="attach"]',
      '[class*="file"]',
      '[class*="document"]',
      '[class*="docs"]',
      '[data-attachments]',
      '[data-documents]',
    ].join(', ');
    return root.find(selector).filter((_, item) => {
      const node = $(item);
      if (node.is('.tendercard__desc')) return true;
      const ownText = this.text(node.clone().children().remove().end().text());
      const className = String(node.attr('class') ?? '');
      return /файл|документ|вложен|прикреп|техническ|тз|attach|file|document|docs/i.test(`${className} ${ownText}`);
    });
  }

  private sanitizedDocumentAttachments(attachments: WorkspaceDocumentAttachment[]): WorkspaceDocumentAttachment[] {
    return Array.from(new Map(attachments.filter((item) => {
      try {
        return this.isTenderDocumentUrl(new URL(item.url));
      } catch {
        return false;
      }
    }).map((item) => [item.url, item])).values());
  }

  private isTenderDocumentUrl(url: URL): boolean {
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    if (url.origin === ORIGIN && /^\/upload\/(?:security_policy|terms_of_use)\.pdf$/i.test(url.pathname)) return false;
    return /\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|png|jpe?g)(?:$|[?#])/i.test(url.pathname);
  }

  private locationText(text: string): string | undefined {
    const match = /заказчиком из\s+([^.?]+)[.?]/i.exec(text);
    return match?.[1]?.trim();
  }

  private richText(html: string): string | undefined {
    const $ = load(`<div data-root>${html}</div>`);
    const blocks: string[] = [];
    const walk = (node: WorkspaceCheerioNode): string => {
      const richNode = node as RichTextNode;
      if (richNode.type === 'text') return this.decode(richNode.data ?? '');
      if (richNode.type !== 'tag') return '';
      const element = $(node as Parameters<typeof $>[0]);
      const tag = (richNode.tagName ?? '').toLowerCase();
      if (tag === 'br') return '\n';
      const children = element.contents().toArray().map((child) => walk(child)).join('');
      const cleaned = children.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
      if (!cleaned) return '';
      if (tag === 'li') return `- ${cleaned}`;
      if (/^(p|div|section|article|h[1-6]|ul|ol)$/.test(tag)) {
        blocks.push(cleaned);
        return '';
      }
      return cleaned;
    };
    $('[data-root]').contents().each((_, node) => {
      const text = walk(node).trim();
      if (text) blocks.push(text);
    });
    const normalized = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    return normalized || undefined;
  }

  private text(value?: string): string {
    return this.decode(value ?? '').replace(/\s+/g, ' ').trim();
  }

  private decode(value: string): string {
    return value
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  private checkpointStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  private dateValue(value: unknown): Date | undefined {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
    if (typeof value !== 'string') return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
  }

  private valueAt(input: unknown, path: string[]): unknown {
    let current = input;
    for (const key of path) {
      if (!current || typeof current !== 'object' || !(key in current)) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  private slashPath(pathname: string): string {
    return pathname.endsWith('/') ? pathname : `${pathname}/`;
  }
}

const RU_MONTHS: Record<string, number> = {
  января: 0,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11,
};

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== ''));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}
