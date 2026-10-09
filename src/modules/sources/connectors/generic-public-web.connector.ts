import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { WebExtractionService } from '../extraction/web-extraction.service';

export class GenericPublicWebConnector implements Connector {
  readonly id = 'generic-public-web';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly webExtraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: 30 };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    if (typeof config.baseUrl !== 'string') return { ok: false, message: 'Public web source requires registry baseUrl' };
    return { ok: true, message: 'Registry baseUrl configured' };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const baseUrl = this.baseUrl(ctx.source.endpoint);
      const allowedHosts = [new URL(baseUrl).hostname];
      await this.webExtraction.extractUrl(baseUrl, { allowedHosts, timeoutMs: Math.min(ctx.source.timeoutMs ?? 30_000, 20_000), maxBytes: 2_000_000, signal: ctx.signal });
      return { state: 'Healthy', message: 'Public web source fetched', checkedAt: new Date() };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Public web source fetch failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const baseUrl = this.baseUrl(ctx.source.endpoint);
    const allowedHosts = [new URL(baseUrl).hostname];
    if (ctx.source._id === 'workspace') {
      return this.fetchWorkspaceTenders(ctx, baseUrl, allowedHosts);
    }
    if (ctx.source._id === 'fl_ru') {
      return this.fetchFlRuProjects(ctx, baseUrl, allowedHosts);
    }
    if (ctx.source._id === 'weblancer') {
      return this.fetchWeblancerProjects(ctx, baseUrl, allowedHosts);
    }
    const listPage = this.listPageRequest(ctx, baseUrl);
    const document = await this.webExtraction.extractUrl(listPage.url, { allowedHosts, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: 2_000_000, signal: ctx.signal });
    const links = this.webExtraction.extractOpportunityLinks(document, allowedHosts);
    const records: RawOpportunityRecord[] = [];
    if (links.length === 0) {
      records.push(this.webExtraction.documentToRecord(document, {
        sourceId: ctx.source._id,
        sourceName: ctx.source.name,
        type: ctx.source.opportunityTypes[0] ?? 'vacancy',
        requireOpportunitySignal: true,
      }));
    } else {
      for (const url of links) {
        const record = await this.webExtraction.extractOpportunityFromUrl(url, {
          sourceId: ctx.source._id,
          sourceName: ctx.source.name,
          type: ctx.source.opportunityTypes[0] ?? 'vacancy',
          allowedHosts,
          requireOpportunitySignal: true,
          signal: ctx.signal,
        });
        records.push(record);
      }
    }
    if (records.length === 0) {
      throw new Error(`No public opportunities extracted from ${baseUrl}`);
    }
    return {
      records,
      ...this.publicListPageContinuation(document.html, document.finalUrl, baseUrl, listPage, records.length),
      stats: { seen: records.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private baseUrl(endpoint: Record<string, unknown>): string {
    if (typeof endpoint.baseUrl !== 'string') throw new Error('Public web source requires registry baseUrl');
    return endpoint.baseUrl;
  }

  private async fetchWorkspaceTenders(ctx: FetchContext, baseUrl: string, allowedHosts: string[]): Promise<FetchPage> {
    const listPage = this.listPageRequest(ctx, baseUrl);
    const document = await this.webExtraction.extractUrl(listPage.url, {
      allowedHosts,
      timeoutMs: ctx.source.timeoutMs ?? 30_000,
      maxBytes: 2_000_000,
      signal: ctx.signal,
      ...(listPage.url !== baseUrl ? { ajaxHtmlField: 'tender' as const } : {}),
    });
    const cards = this.workspaceTenderCards(document.html, document.finalUrl);
    const records: RawOpportunityRecord[] = [];
    for (const card of cards) {
      const detail = await this.workspaceTenderDetail(card.url, allowedHosts, ctx.source.timeoutMs ?? 30_000, ctx.signal);
      if (!detail.description) throw new Error(`Workspace tender detail is missing description: ${card.url}`);
      const canonicalUrl = detail.canonicalUrl ?? card.url;
      const budget = card.budget.originalText ? card.budget : this.workspaceBudget(detail.budgetText);
      const publishedAt = card.publishedAt ?? this.ruDate(detail.publishedText);
      const deadlineAt = card.deadlineAt ?? this.ruDate(detail.deadlineText);
      records.push({
        externalId: card.externalId,
        url: canonicalUrl,
        type: 'tender',
        title: card.title,
        companyOrClient: 'Workspace',
        description: detail.description,
        publishedAt,
        sourceStatus: card.statusText.toLowerCase().includes('идет') ? 'Active' : 'Unknown',
        rawPayload: {
          listUrl: document.finalUrl,
          detailUrl: card.url,
          title: card.title,
          budgetText: card.budgetText ?? detail.budgetText,
          statusText: card.statusText,
          publishedText: card.publishedText ?? detail.publishedText,
          deadlineText: card.deadlineText ?? detail.deadlineText,
          description: detail.description,
        },
        sourceMetadata: {
          extraction: 'workspace-html',
          sourceUrl: document.finalUrl,
          budget,
          deadlineAt: deadlineAt?.toISOString(),
          deadlineText: card.deadlineText ?? detail.deadlineText,
          publishedText: card.publishedText ?? detail.publishedText,
          statusText: card.statusText,
        },
      });
    }
    if (records.length === 0) {
      throw new Error(`No Workspace tender cards extracted from ${baseUrl}`);
    }
    return {
      records,
      ...this.publicListPageContinuation(document.html, document.finalUrl, baseUrl, listPage, records.length),
      stats: { seen: records.length },
    };
  }

  private async fetchFlRuProjects(ctx: FetchContext, baseUrl: string, allowedHosts: string[]): Promise<FetchPage> {
    const listPage = this.listPageRequest(ctx, baseUrl);
    const document = await this.webExtraction.extractUrl(listPage.url, { allowedHosts, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: 2_000_000, signal: ctx.signal });
    const cards = this.flRuProjectCards(document.html, document.finalUrl);
    const records: RawOpportunityRecord[] = [];
    for (const card of cards) {
      const detail = await this.flRuProjectDetail(card.url, allowedHosts, ctx.source.timeoutMs ?? 30_000, card.externalId, ctx.signal);
      if (!detail.description && !detail.isPublicPreviewOnly) throw new Error(`FL.ru project detail is missing description: ${card.url}`);
      const description = detail.description ?? card.description;
      const priceText = detail.priceText ?? card.priceText;
      records.push({
        externalId: card.externalId,
        url: detail.canonicalUrl ?? card.url,
        type: card.kindText.toLowerCase().includes('вакан') ? 'vacancy' : 'freelance',
        title: detail.title ?? card.title,
        companyOrClient: 'FL.ru',
        description,
        sourceStatus: 'Unknown',
        rawPayload: {
          listUrl: document.finalUrl,
          detailUrl: card.url,
          title: card.title,
          detailTitle: detail.title,
          description,
          listDescription: card.description,
          detailDescription: detail.description,
          requirementsText: detail.requirementsText,
          priceText,
          deadlineText: detail.deadlineText,
          publishedText: detail.publishedText,
          kindText: card.kindText,
          ageText: card.ageText,
          responsesText: card.responsesText,
          viewsText: card.viewsText,
          descriptionCoverage: detail.description ? 'detail-full' : 'list-preview',
        },
        sourceMetadata: {
          extraction: 'fl-ru-html',
          sourceUrl: document.finalUrl,
          detailSourceUrl: detail.finalUrl,
          price: this.flRuPrice(priceText),
          budget: this.flRuPrice(priceText),
          priceText,
          deadlineText: detail.deadlineText,
          publishedText: detail.publishedText,
          requirementsText: detail.requirementsText,
          descriptionCoverage: detail.description ? 'detail-full' : 'list-preview',
          ageText: card.ageText,
          responsesText: card.responsesText,
          viewsText: card.viewsText,
          kindText: card.kindText,
        },
      });
    }
    if (records.length === 0) {
      throw new Error(`No FL.ru project cards extracted from ${baseUrl}`);
    }
    return {
      records,
      ...this.publicListPageContinuation(document.html, document.finalUrl, baseUrl, listPage, records.length),
      stats: { seen: records.length },
    };
  }

  private async fetchWeblancerProjects(ctx: FetchContext, baseUrl: string, allowedHosts: string[]): Promise<FetchPage> {
    const listPage = this.listPageRequest(ctx, baseUrl);
    const document = await this.webExtraction.extractUrl(listPage.url, { allowedHosts, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: 2_000_000, signal: ctx.signal });
    const cards = this.weblancerProjectCards(document.html, document.finalUrl);
    if (cards.length === 0) {
      return {
        records: [],
        checkpoint: {
          lastFetchedAt: new Date().toISOString(),
          issue: 'Weblancer public HTML contains no project cards; landing/catalog text was not emitted as an opportunity.',
        },
        hasMore: false,
        stats: { seen: 0 },
      };
    }
    const records = cards.map<RawOpportunityRecord>((card) => ({
      externalId: card.externalId,
      url: card.url,
      type: 'freelance',
      title: card.title,
      companyOrClient: 'Weblancer',
      description: card.description,
      publishedAt: card.publishedAt,
      sourceStatus: 'Active',
      rawPayload: {
        listUrl: document.finalUrl,
        title: card.title,
        description: card.description,
        priceText: card.priceText,
        categoryTags: card.categoryTags,
        dateText: card.dateText,
        bidsText: card.bidsText,
        viewsText: card.viewsText,
      },
      sourceMetadata: {
        extraction: 'weblancer-html',
        sourceUrl: document.finalUrl,
        price: card.price,
        budget: card.price,
        priceText: card.priceText,
        categoryTags: card.categoryTags,
        dateText: card.dateText,
        bidsText: card.bidsText,
        viewsText: card.viewsText,
      },
    }));
    return {
      records,
      ...this.publicListPageContinuation(document.html, document.finalUrl, baseUrl, listPage, records.length),
      stats: { seen: records.length },
    };
  }

  private listPageRequest(ctx: FetchContext, baseUrl: string): { url: string; page: number; visitedUrls: string[] } {
    const checkpointNextUrl = typeof ctx.checkpoint.nextUrl === 'string' ? ctx.checkpoint.nextUrl : undefined;
    const checkpointHasMore = ctx.checkpoint.hasMore === true;
    const safeNextUrl = checkpointHasMore ? this.safePublicNextUrl(checkpointNextUrl, baseUrl) : undefined;
    const checkpointPage = Number(ctx.checkpoint.nextPage ?? ctx.checkpoint.page);
    const page = safeNextUrl
      ? Math.max(0, ctx.page ?? (Number.isFinite(checkpointPage) ? checkpointPage : 1))
      : Math.max(0, ctx.page ?? 0);
    const checkpointVisited = Array.isArray(ctx.checkpoint.visitedListUrls) ? ctx.checkpoint.visitedListUrls.filter((url): url is string => typeof url === 'string') : [];
    return {
      url: safeNextUrl ?? baseUrl,
      page,
      visitedUrls: safeNextUrl ? checkpointVisited : [],
    };
  }

  private publicListPageContinuation(
    html: string,
    finalUrl: string,
    baseUrl: string,
    current: { page: number; visitedUrls: string[] },
    count: number,
  ): Pick<FetchPage, 'checkpoint' | 'hasMore' | 'nextPage'> {
    const lastFetchedAt = new Date().toISOString();
    const currentUrl = this.normalizeUrl(finalUrl);
    const visitedUrls = Array.from(new Set([...current.visitedUrls, currentUrl]));
    const nextUrl = this.observedPublicNextUrl(html, finalUrl, baseUrl);
    const hasMore = typeof nextUrl === 'string' && !visitedUrls.includes(this.normalizeUrl(nextUrl));
    if (!hasMore) {
      return {
        checkpoint: { lastFetchedAt, count, hasMore: false },
        hasMore: false,
      };
    }
    return {
      checkpoint: {
        lastFetchedAt,
        count,
        hasMore: true,
        page: current.page,
        nextPage: current.page + 1,
        currentUrl,
        nextUrl,
        visitedListUrls: visitedUrls,
      },
      hasMore: true,
      nextPage: current.page + 1,
    };
  }

  private observedPublicNextUrl(html: string, finalUrl: string, baseUrl: string): string | undefined {
    const anchors = Array.from(html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi));
    const numericNext = this.observedNumericAdjacentNextUrl(anchors, finalUrl, baseUrl);
    if (numericNext) return numericNext;
    for (const anchor of anchors) {
      const attrs = anchor[1] ?? '';
      const label = this.cleanHtml(anchor[2])?.toLowerCase() ?? '';
      const rel = this.attribute(/\brel=["']([^"']+)["']/i.exec(attrs)?.[1])?.toLowerCase() ?? '';
      const className = this.attribute(/\bclass=["']([^"']+)["']/i.exec(attrs)?.[1])?.toLowerCase() ?? '';
      const ariaLabel = this.attribute(/\baria-label=["']([^"']+)["']/i.exec(attrs)?.[1])?.toLowerCase() ?? '';
      const href = this.attribute(/\bhref=["']([^"']+)["']/i.exec(attrs)?.[1]);
      const looksLikeNext =
        /\bnext\b/.test(rel) ||
        /\b(next|pagination__next|pager__next|box-more__btn|fl-pagination-next)\b/.test(className) ||
        /\b(next|след|дальше|впер[её]д)\b/.test(ariaLabel) ||
        /^(next|следующая|дальше|показать ещё\s+\d+|впер[её]д|→|›|»|следующая\s+→)$/.test(label);
      if (!looksLikeNext) continue;
      const safe = this.safePublicNextUrl(href, baseUrl, finalUrl);
      if (safe) return safe;
    }
    return undefined;
  }

  private observedNumericAdjacentNextUrl(anchors: RegExpMatchArray[], finalUrl: string, baseUrl: string): string | undefined {
    const currentPage = this.publicListPageNumber(new URL(finalUrl), new URL(baseUrl));
    const candidates: Array<{ page: number; url: string }> = [];
    for (const anchor of anchors) {
      const attrs = anchor[1] ?? '';
      const label = this.cleanHtml(anchor[2]) ?? '';
      const href = this.attribute(/\bhref=["']([^"']+)["']/i.exec(attrs)?.[1]);
      const labelPage = /^\d+$/.test(label) ? Number(label) : undefined;
      const safe = this.safePublicNextUrl(href, baseUrl, finalUrl);
      if (!safe) continue;
      const page = labelPage ?? this.publicListPageNumber(new URL(safe), new URL(baseUrl));
      if (page > currentPage) candidates.push({ page, url: safe });
    }
    const adjacent = candidates.find((candidate) => candidate.page === currentPage + 1);
    return adjacent?.url;
  }

  private safePublicNextUrl(value: string | undefined, baseUrl: string, fromUrl = baseUrl): string | undefined {
    if (!value) return undefined;
    let next: URL;
    let base: URL;
    try {
      base = new URL(baseUrl);
      next = new URL(value, fromUrl);
    } catch {
      return undefined;
    }
    if (!['http:', 'https:'].includes(next.protocol)) return undefined;
    if (next.username || next.password) return undefined;
    if (next.origin !== base.origin) return undefined;
    if (!this.isPublicListPageUrl(next, base)) return undefined;
    const normalizedBase = this.normalizeUrl(base.toString());
    const normalizedNext = this.normalizeUrl(next.toString());
    if (normalizedNext === normalizedBase && !next.search) return undefined;
    return normalizedNext;
  }

  private isPublicListPageUrl(next: URL, base: URL): boolean {
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    const nextPath = next.pathname.endsWith('/') ? next.pathname : `${next.pathname}/`;
    if (nextPath === basePath) return next.search.length > 0;
    const suffix = nextPath.slice(basePath.length);
    return /^(?:(?:page|pages|p)\/\d+|page-\d+|\d+)\/$/i.test(suffix);
  }

  private publicListPageNumber(url: URL, base: URL): number {
    const searchPage = Number(url.searchParams.get('page') ?? url.searchParams.get('p'));
    if (Number.isFinite(searchPage) && searchPage > 0) return searchPage;
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    if (path === basePath) return 1;
    const suffix = path.slice(basePath.length);
    const match = /^(?:(?:page|pages|p)\/(\d+)|page-(\d+)|(\d+))\/$/i.exec(suffix);
    const value = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  private normalizeUrl(value: string): string {
    const url = new URL(value);
    url.hash = '';
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    return url.toString();
  }


  private async flRuProjectDetail(url: string, allowedHosts: string[], timeoutMs: number, externalId: string, signal?: AbortSignal): Promise<FlRuProjectDetail> {
    const document = await this.webExtraction.extractUrl(url, { allowedHosts, timeoutMs, maxBytes: 2_000_000, signal });
    const canonicalUrl = this.attribute(/<link\b[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(document.html)?.[1]);
    const titlePattern = String.raw`<h1\b[^>]+id=["']prj_name_${externalId}["'][^>]*>([\s\S]*?)<\/h1>`;
    const title = this.cleanHtml(new RegExp(titlePattern, 'i').exec(document.html)?.[1])
      ?? this.cleanHtml(/<h1\b[^>]+id=["']prj_name_\d+["'][^>]*>([\s\S]*?)<\/h1>/i.exec(document.html)?.[1]);
    const description = this.flRuDetailDescription(document.html, externalId);
    const info = this.flRuDetailInfo(document.html);
    const priceText = this.flRuDetailPriceText(document.html);
    const publishedBlock = this.cleanHtml(/<div\b[^>]+class=["'][^"']*text-10[^"']*opacity-50[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(document.html)?.[1]);
    const deadlineText = this.attribute(/до\s+(\d{2}\.\d{2}\.\d{4})/i.exec(publishedBlock ?? '')?.[1]);
    return {
      finalUrl: document.finalUrl,
      canonicalUrl,
      title,
      description,
      requirementsText: info.requirementsText,
      priceText,
      publishedText: publishedBlock,
      deadlineText,
      isPublicPreviewOnly: !description && this.flRuDetailIsPublicPreviewOnly(document.html),
    };
  }

  private flRuDetailDescription(html: string, externalId: string): string | undefined {
    const exactPattern = String.raw`<div\b[^>]+id=["']projectp${externalId}["'][^>]*>([\s\S]*?)(?=<div>\s*<div\b[^>]+class=["'][^"']*text-10[^"']*opacity-50|<div\b[^>]+class=["'][^"']*fl-project-content-buttons|<\/div>\s*<\/div>\s*<!--)`;
    const exact = new RegExp(exactPattern, 'i').exec(html)?.[1];
    const generic = exact ?? /<div\b[^>]+id=["']projectp\d+["'][^>]*>([\s\S]*?)(?=<div>\s*<div\b[^>]+class=["'][^"']*text-10[^"']*opacity-50|<div\b[^>]+class=["'][^"']*fl-project-content-buttons|<\/div>\s*<\/div>\s*<!--)/i.exec(html)?.[1];
    return this.cleanHtml(generic);
  }

  private flRuDetailInfo(html: string): { requirementsText?: string } {
    const lines = Array.from(html.matchAll(/<div\b[^>]+class=["'][^"']*fl-project-card__vacancy-info-line[^"']*["'][^>]*>[\s\S]*?<span\b[^>]+class=["'][^"']*text-6[^"']*["'][^>]*>([\s\S]*?)<\/span>[\s\S]*?<span\b[^>]+class=["'][^"']*text-5[^"']*["'][^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/div>/gi))
      .map((match) => {
        const label = this.cleanHtml(match[1])?.replace(/:$/, '');
        const value = this.cleanHtml(match[2]);
        return label && value ? `${label}: ${value}` : undefined;
      })
      .filter((line): line is string => Boolean(line));
    return { requirementsText: lines.length > 0 ? lines.join('; ') : undefined };
  }

  private flRuDetailPriceText(html: string): string | undefined {
    return this.cleanHtml(/<!--\s*Бюджет\s*-->[\s\S]*?(?:Оплата|Бюджет):[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1]);
  }

  private flRuDetailIsPublicPreviewOnly(html: string): boolean {
    const content = this.cleanHtml(/<div\b[^>]+class=["'][^"']*fl-project-content[^"']*["'][^>]*>([\s\S]*?)(?:<section\b[^>]+class=["'][^"']*fl-project-footer|<\/main>|$)/i.exec(html)?.[1]) ?? '';
    return /(?:полное|подробное|детальное).{0,80}(?:описание|задание|ваканси|проект).{0,120}(?:доступн|откроет|показыва)/i.test(content)
      || /(?:описание|задание|ваканси|проект).{0,120}(?:доступн|откроет|показыва).{0,80}(?:после|только).{0,40}(?:авторизац|регистрац|входа)/i.test(content);
  }

  private flRuProjectCards(html: string, finalUrl: string): FlRuProjectCard[] {
    const blocks = html.match(/<div[^>]+class=["'][^"']*b-page__lenta_item[^"']*b-post[\s\S]*?(?=<div[^>]+class=["'][^"']*b-page__lenta_item[^"']*b-post|<div class="b-page__lenta_pager"|$)/g) ?? [];
    const cards: FlRuProjectCard[] = [];
    for (const block of blocks) {
      const anchor = /<a\b[^>]*data-disposable-project-id=["'](\d+)["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
      if (!anchor) continue;
      const title = this.cleanHtml(anchor[3]);
      const description = this.cleanHtml(/<div class="b-post__txt text-5\s*">([\s\S]*?)<\/div>/i.exec(block)?.[1]);
      if (!title || !description) continue;
      const priceText = this.cleanHtml(/<div class="[^"]*b-post__price[^"]*"[^>]*>[\s\S]*?<span class="text-4[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1]);
      const footer = this.flRuFooter(block);
      cards.push({
        externalId: anchor[1],
        url: new URL(anchor[2], finalUrl).toString(),
        title,
        description,
        priceText,
        price: this.flRuPrice(priceText),
        kindText: footer.kindText,
        ageText: footer.ageText,
        viewsText: footer.viewsText,
        responsesText: footer.responsesText,
      });
    }
    return cards;
  }

  private flRuFooter(block: string): { kindText: string; ageText?: string; viewsText?: string; responsesText?: string } {
    const kindText = this.cleanHtml(/<span class="b-post__bold[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1]) ?? 'Заказ';
    const ageText = this.cleanHtml(/<span class="text-gray-opacity-4[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1]);
    const viewsText = this.cleanHtml(/title="Количество просмотров"[\s\S]*?<span class="text-7">([\s\S]*?)<\/span>/i.exec(block)?.[1]);
    const responsesText = this.cleanHtml(/title="Количество ответов"[\s\S]*?<\/svg>\s*([\s\S]*?)(?:<\/a>|<\/span>)/i.exec(block)?.[1]);
    return { kindText, ageText, viewsText, responsesText };
  }

  private flRuPrice(text?: string): { amount?: number; currency?: 'RUB'; originalText?: string } {
    const amount = Number((text ?? '').match(/\d[\d\s]*/)?.[0]?.replace(/\s/g, ''));
    return {
      amount: Number.isFinite(amount) ? amount : undefined,
      currency: /₽|руб|8381/.test(text ?? '') ? 'RUB' : undefined,
      originalText: text,
    };
  }


  private weblancerProjectCards(html: string, finalUrl: string): WeblancerProjectCard[] {
    const blocks = html.match(/<article\b[^>]*class=["'][^"']*bg-white[^"']*rounded-md[^"']*["'][\s\S]*?<\/article>/g) ?? [];
    const cards: WeblancerProjectCard[] = [];
    for (const block of blocks) {
      const anchor = /<h2\b[\s\S]*?<a\b[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(block);
      if (!anchor) continue;
      const href = this.attribute(anchor[1]);
      if (!href || !/^\/freelance\/.+-\d+\/$/i.test(href)) continue;
      const title = this.cleanHtml(anchor[2]);
      const description = this.cleanHtml(/<p\b[^>]*class=["'][^"']*text-gray-600[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1]);
      if (!title || !description || this.isLandingTitle(title)) continue;
      const externalId = /-(\d+)\/$/.exec(href)?.[1];
      if (!externalId) continue;
      const priceText = this.cleanHtml(/<span\b[^>]*class=["'][^"']*text-green-600[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1]);
      const tags = Array.from(block.matchAll(/<a\b[^>]+href=["']\/freelance\/(?![^"']+-\d+\/)([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi))
        .map((match) => this.cleanHtml(match[2]))
        .filter((tag): tag is string => Boolean(tag));
      const footerTexts = Array.from(block.matchAll(/<span>([\s\S]*?)<\/span>/gi)).map((match) => this.cleanHtml(match[1])).filter((text): text is string => Boolean(text));
      const dateText = footerTexts.find((text) => /^\d{2}\.\d{2}\.\d{4}$/.test(text));
      const bidsText = footerTexts.find((text) => /заяв/i.test(text));
      const viewsText = footerTexts.find((text) => /просмотр/i.test(text));
      cards.push({
        externalId,
        url: new URL(href, finalUrl).toString(),
        title,
        description,
        priceText,
        price: this.weblancerPrice(priceText),
        categoryTags: Array.from(new Set(tags)),
        dateText,
        publishedAt: this.dotDate(dateText),
        bidsText,
        viewsText,
      });
    }
    return cards;
  }

  private isLandingTitle(title: string): boolean {
    return /^(фриланс|freelance|weblancer|каталог фрилансеров|биржа заказов)/i.test(title.trim());
  }

  private weblancerPrice(text?: string): { amount?: number; currency?: 'USD' | 'UAH' | 'RUB'; originalText?: string } {
    const amount = Number((text ?? '').match(/\d[\d\s.,]*/)?.[0]?.replace(/\s/g, '').replace(',', '.'));
    const lower = text?.toLowerCase() ?? '';
    return {
      amount: Number.isFinite(amount) ? amount : undefined,
      currency: lower.includes('$') ? 'USD' : lower.includes('₴') || lower.includes('грн') ? 'UAH' : lower.includes('₽') || lower.includes('руб') ? 'RUB' : undefined,
      originalText: text,
    };
  }

  private dotDate(text?: string): Date | undefined {
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text ?? '');
    if (!match) return undefined;
    return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 12, 0, 0));
  }

  private workspaceTenderCards(html: string, finalUrl: string): WorkspaceTenderCard[] {
    const cards: WorkspaceTenderCard[] = [];
    const blocks = html.match(/<div class="vacancies__card _tender"[\s\S]*?(?=<div class="vacancies__card _tender"|<\/div>\s*<footer|$)/g) ?? [];
    for (const block of blocks) {
      const anchor = /<a\b[^>]+href=["'](\/tenders\/[^"']+-\d+\/)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
      if (!anchor) continue;
      const title = this.cleanHtml(anchor[2]);
      if (!title || title === 'Workspace') continue;
      const url = new URL(anchor[1], finalUrl).toString();
      const externalId = /-(\d+)\/?$/.exec(anchor[1])?.[1] ?? anchor[1];
      const budgetText = this.cleanHtml(/<\/a>\s*<\/div>\s*<div class="b-tender__info-item-text">([\s\S]*?)<\/div>/i.exec(block)?.[1]);
      const info = this.workspaceInfo(block);
      const statusText = this.cleanHtml(/<div class="tendercart-type__status-public[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1]) ?? '';
      cards.push({
        externalId,
        url,
        title,
        budgetText,
        budget: this.workspaceBudget(budgetText),
        statusText,
        publishedText: info.publishedText,
        publishedAt: this.ruDate(info.publishedText),
        deadlineText: info.deadlineText,
        deadlineAt: this.ruDate(info.deadlineText),
      });
    }
    return cards;
  }

  private async workspaceTenderDetail(url: string, allowedHosts: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ canonicalUrl?: string; description?: string; budgetText?: string; publishedText?: string; deadlineText?: string }> {
    const document = await this.webExtraction.extractUrl(url, { allowedHosts, timeoutMs, maxBytes: 2_000_000, signal });
    const info = this.workspaceInfo(document.html);
    return {
      canonicalUrl: this.attribute(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(document.html)?.[1] ?? /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["'][^>]*>/i.exec(document.html)?.[1]),
      description: this.cleanHtml(/<div class="tendercard__desc[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(document.html)?.[1]) ?? this.attribute(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i.exec(document.html)?.[1]),
      budgetText: info.budgetText,
      publishedText: info.publishedText,
      deadlineText: info.deadlineText,
    };
  }

  private workspaceInfo(block: string): { budgetText?: string; publishedText?: string; deadlineText?: string } {
    const result: { budgetText?: string; publishedText?: string; deadlineText?: string } = {};
    const pattern = /<div class="b-tender__info-item-title">([\s\S]*?)<\/div>\s*<div class="b-tender__info-item-text">([\s\S]*?)<\/div>/gi;
    for (const match of block.matchAll(pattern)) {
      const label = this.cleanHtml(match[1])?.toLowerCase() ?? '';
      const value = this.cleanHtml(match[2]);
      if (label.includes('бюджет')) result.budgetText = value;
      if (label.includes('опубликован')) result.publishedText = value;
      if (label.includes('крайний срок')) result.deadlineText = value;
    }
    return result;
  }

  private workspaceBudget(text?: string): { min?: number; max?: number; currency: 'RUB'; originalText?: string } {
    const numbers = Array.from((text ?? '').matchAll(/\d[\d\s]*/g)).map((match) => Number(match[0].replace(/\s/g, ''))).filter(Number.isFinite);
    const lower = text?.toLowerCase() ?? '';
    return {
      min: lower.includes('до') ? undefined : numbers[0],
      max: lower.includes('от') ? undefined : numbers.at(-1),
      currency: 'RUB',
      originalText: text,
    };
  }

  private ruDate(text?: string): Date | undefined {
    if (!text) return undefined;
    const match = /(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i.exec(text);
    if (!match) return undefined;
    const month = RU_MONTHS[match[2].toLowerCase()];
    if (month === undefined) return undefined;
    return new Date(Date.UTC(Number(match[3]), month, Number(match[1]), 12, 0, 0));
  }

  private cleanHtml(value?: string): string | undefined {
    return this.attribute(value?.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, ' '));
  }

  private attribute(value?: string): string | undefined {
    const normalized = value
      ?.replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized || undefined;
  }
}

type WorkspaceTenderCard = {
  externalId: string;
  url: string;
  title: string;
  budgetText?: string;
  budget: { min?: number; max?: number; currency: 'RUB'; originalText?: string };
  statusText: string;
  publishedText?: string;
  publishedAt?: Date;
  deadlineText?: string;
  deadlineAt?: Date;
};

type WeblancerProjectCard = {
  externalId: string;
  url: string;
  title: string;
  description: string;
  priceText?: string;
  price: { amount?: number; currency?: 'USD' | 'UAH' | 'RUB'; originalText?: string };
  categoryTags: string[];
  dateText?: string;
  publishedAt?: Date;
  bidsText?: string;
  viewsText?: string;
};

type FlRuProjectCard = {
  externalId: string;
  url: string;
  title: string;
  description: string;
  priceText?: string;
  price: { amount?: number; currency?: 'RUB'; originalText?: string };
  kindText: string;
  ageText?: string;
  viewsText?: string;
  responsesText?: string;
};

type FlRuProjectDetail = {
  finalUrl: string;
  canonicalUrl?: string;
  title?: string;
  description?: string;
  requirementsText?: string;
  priceText?: string;
  publishedText?: string;
  deadlineText?: string;
  isPublicPreviewOnly: boolean;
};

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
