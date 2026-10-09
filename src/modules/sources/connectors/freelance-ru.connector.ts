import { load } from 'cheerio';

import { WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';

interface NativeCategory { id: string; label: string; }

/** The public task catalog replaced /project/search. Sweep its declared category partitions. */
export class FreelanceRuConnector implements Connector {
  readonly id = 'freelance-ru';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly extraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: 30 };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    const url = this.safeUrl(typeof config.baseUrl === 'string' ? config.baseUrl : 'https://freelance.ru/task', 'https://freelance.ru/task', 'list');
    return { ok: Boolean(url), message: url ? 'Public Freelance.ru task catalog configured' : 'Freelance.ru requires its public /task catalog' };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1 });
      return { state: 'Healthy', message: `Freelance.ru returned ${page.records.length} task cards`, checkedAt: new Date() };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Freelance.ru fetch failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const baseUrl = 'https://freelance.ru/task';
    const continuing = ctx.checkpoint.hasMore === true;
    const now = new Date().toISOString();
    const backfillSince = continuing ? ctx.checkpoint.backfillSince : ctx.backfillSince ?? new Date(Date.now() - ctx.backfillDays * 86_400_000).toISOString();
    const windowTo = continuing ? ctx.checkpoint.windowTo : now;
    if (typeof backfillSince !== 'string' || typeof windowTo !== 'string' || !Number.isFinite(Date.parse(backfillSince)) || !Number.isFinite(Date.parse(windowTo)) || Date.parse(backfillSince) > Date.parse(windowTo)) throw new Error('Freelance.ru has invalid fixed publication boundaries');
    if (continuing && ctx.backfillSince && ctx.backfillSince !== backfillSince) throw new Error('Freelance.ru lower publication boundary changed');
    if (continuing && ctx.checkpoint.categorySweepVersion !== undefined && ctx.checkpoint.categorySweepVersion !== 1) throw new Error('Freelance.ru continuation has an unsupported category sweep version');
    const categorySweep = continuing && ctx.checkpoint.categorySweepVersion === 1;
    if (categorySweep && (!Array.isArray(ctx.checkpoint.partitionVisitedListUrls) || !Array.isArray(ctx.checkpoint.partitionSeenExternalIds))) throw new Error('Freelance.ru continuation has invalid category partition history');
    const catalog = categorySweep ? this.readCheckpointCatalog(ctx.checkpoint.observedCategoryCatalog) : undefined;
    const categoryIndex = categorySweep ? Number(ctx.checkpoint.categoryIndex) : 0;
    if (catalog && (!Number.isSafeInteger(categoryIndex) || categoryIndex < 0 || categoryIndex >= catalog.length)) throw new Error('Freelance.ru continuation has an invalid category position');
    const category = catalog?.[categoryIndex];
    const page = continuing ? Number(ctx.checkpoint.nextPage) : 0;
    if (!Number.isSafeInteger(page) || page < 0 || (continuing && !categorySweep && page === 0)) throw new Error('Freelance.ru continuation has an invalid page number');
    const nextUrl = continuing && typeof ctx.checkpoint.nextUrl === 'string' ? this.safeUrl(ctx.checkpoint.nextUrl, baseUrl, 'list', category?.id) : undefined;
    if (continuing && (!nextUrl || this.listPage(nextUrl) !== page + 1)) throw new Error('Freelance.ru continuation has an invalid listing URL');
    const completedCategoryIds = categorySweep ? ctx.checkpoint.completedCategoryIds : [];
    if (!Array.isArray(completedCategoryIds) || completedCategoryIds.length !== categoryIndex || completedCategoryIds.some((id, index) => id !== catalog?.[index].id)) throw new Error('Freelance.ru continuation has invalid completed categories');
    // Legacy unpartitioned checkpoints restart discovery, retaining their fixed window and IDs.
    const discovering = !categorySweep;
    const requestedUrl = discovering ? baseUrl : nextUrl!;
    const visited = new Set<string>(continuing && Array.isArray(ctx.checkpoint.visitedListUrls) ? ctx.checkpoint.visitedListUrls.filter((value): value is string => typeof value === 'string') : []);
    const partitionVisited = new Set<string>(categorySweep && Array.isArray(ctx.checkpoint.partitionVisitedListUrls) ? ctx.checkpoint.partitionVisitedListUrls.filter((value): value is string => typeof value === 'string') : []);
    if (!discovering && (visited.has(requestedUrl) || partitionVisited.has(requestedUrl))) throw new Error('Freelance.ru continuation repeats a previously visited page');
    const seenIds = new Set<string>(continuing && Array.isArray(ctx.checkpoint.seenExternalIds) ? ctx.checkpoint.seenExternalIds.filter((value): value is string => typeof value === 'string') : []);
    const partitionSeenIds = new Set<string>(categorySweep && Array.isArray(ctx.checkpoint.partitionSeenExternalIds) ? ctx.checkpoint.partitionSeenExternalIds.filter((value): value is string => typeof value === 'string') : []);
    ctx.signal?.throwIfAborted();
    const document = await this.extraction.extractUrl(requestedUrl, { allowedHosts: ['freelance.ru'], timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: 2_000_000, signal: ctx.signal });
    const finalUrl = this.safeUrl(document.finalUrl, baseUrl, 'list', category?.id);
    if (!finalUrl) throw new Error('Freelance.ru catalog redirected outside its public task listing or changed category filters');
    if (finalUrl !== requestedUrl) throw new Error('Freelance.ru catalog redirected to a different page or category');
    const $ = load(document.html);
    const observedCatalog = this.categoryCatalog($);
    if (catalog && (observedCatalog.length !== catalog.length || observedCatalog.some(item => !catalog.some(frozen => frozen.id === item.id && frozen.label === item.label)))) throw new Error('Freelance.ru declared category catalog changed during collection');
    const frozenCatalog = catalog ?? observedCatalog;
    const selectedCategories = $('form[method="get"][action="/task"] input[name="c[]"]:checked').map((_, item) => $(item).attr('value')).get();
    if (category ? selectedCategories.length !== 1 || selectedCategories[0] !== category.id : selectedCategories.length !== 0) throw new Error('Freelance.ru listing changed or ignored its category filter');
    const records: RawOpportunityRecord[] = [];
    const nativeIds = new Set<string>();
    let newPartitionIds = 0;
    for (const element of $('.task-card').toArray()) {
      ctx.signal?.throwIfAborted();
      const card = $(element);
      const anchor = card.find('.task-card__title-link').first();
      const url = this.safeUrl(anchor.attr('href'), document.finalUrl, 'detail');
      const title = this.text(anchor.text());
      const description = this.text(card.find('.task-card__desc').text());
      if (!url || !title) throw new Error('Freelance.ru task card has an invalid identity or title');
      const externalId = new URL(url).pathname.split('/').filter(Boolean).at(-1)!;
      if (nativeIds.has(externalId)) throw new Error('Freelance.ru listing repeats a native task ID');
      nativeIds.add(externalId);
      if (!partitionSeenIds.has(externalId)) newPartitionIds++;
      if (seenIds.has(externalId)) continue;
      const publishedText = card.find('.task-card__foot-item[title]').first().attr('title');
      const publishedAt = this.publicationDate(publishedText);
      if (publishedAt && (publishedAt.getTime() < Date.parse(backfillSince) || publishedAt.getTime() > Date.parse(windowTo))) continue;
      const detail = await this.extraction.extractUrl(url, { allowedHosts: ['freelance.ru'], timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: 2_000_000, signal: ctx.signal });
      if (this.safeUrl(detail.finalUrl, url, 'detail') !== url) throw new Error(`Freelance.ru task ${externalId} redirected away from its detail page`);
      const detailPage = load(detail.html);
      const hero = detailPage('.tv-hero').first();
      const preview = detailPage('.task-card').filter((_, item) => this.safeUrl(detailPage(item).find('.task-card__title-link').attr('href'), url, 'detail') === url).first();
      const publicPreview = !hero.length && preview.length > 0 && /нет доступа/i.test(detailPage('title').text());
      if (!publicPreview && (!hero.length || !this.text(hero.find('h1').text()))) throw new Error(`Freelance.ru task ${externalId} has no public task detail`);
      const body = publicPreview ? preview.find('.task-card__desc').clone() : hero.clone();
      if (!publicPreview) body.find('.tv-hero__top, h1, .tv-hero__meta').remove();
      const descriptionHtml = body.html() ?? '';
      const fullDescription = this.text(load(descriptionHtml.replace(/<br\s*\/?\s*>/gi, '\n')).text());
      if (!fullDescription && !publicPreview) throw new Error(`Freelance.ru task ${externalId} has no description`);
      const listBudgetText = this.text(card.find('.task-card__budget').text());
      const categories = card.find('.task-chip--cat').map((_, item) => this.text($(item).text())).get();
      const fields: Record<string, string> = {};
      hero.find('.tv-meta-item').each((_, item) => {
        const label = this.text(detailPage(item).find('.tv-meta-item__lbl').text());
        const value = this.text(detailPage(item).find('.tv-meta-item__val').text());
        if (label && value) fields[label] = value;
      });
      const budgetText = fields['Гонорар'] || listBudgetText;
      const skills = Array.from(new Set([...categories, ...detailPage('.tv-detail .task-chip').map((_, item) => this.text(detailPage(item).text())).get()].filter(Boolean)));
      const detailAccess = publicPreview ? 'public-preview' : 'public-detail';
      const freelanceData = {
        durationText: fields['Срок'], experienceText: fields['Опыт'], clientTimezone: fields['Часовой пояс'],
        engagementText: this.text(hero.find('.tv-meta-item__sub').text()) || undefined,
      };
      records.push({
        externalId, url, type: 'freelance', title: this.text(hero.find('h1').text()) || title, description: fullDescription || description, publishedAt, sourceStatus: 'Unknown',
        rawPayload: { listUrl: finalUrl, detailUrl: url, title, detailTitle: this.text(hero.find('h1').text()) || undefined, description: fullDescription || description, descriptionHtml, budgetText, listBudgetText, publishedText, categories, skills, fields, detailAccess },
        sourceMetadata: { extraction: 'freelance-ru-task-html', sourceUrl: finalUrl, budget: this.budget(budgetText), publishedText, dateTimezone: publishedAt ? 'Europe/Moscow' : undefined, categoryTags: categories, skills, fields, freelanceData, detailAccess },
      });
    }
    const nextControl = $('.pagination li.next:not(.disabled) a');
    const observedNext = this.safeUrl(nextControl.first().attr('href'), finalUrl, 'list', category?.id);
    if (nextControl.length && (!observedNext || nextControl.length !== 1)) throw new Error('Freelance.ru next control has an invalid listing URL or changed category filter');
    if (observedNext && this.listPage(observedNext) !== (discovering ? 2 : page + 2)) throw new Error('Freelance.ru next control skips or reverses a page');
    const resultCount = this.text($('.task-feed-toolbar-title span').first().text()).replace(/\s/g, '');
    if (!nativeIds.size && (resultCount !== '0' || observedNext)) throw new Error('Freelance.ru listing contains no supported public task cards');
    if (!discovering && nativeIds.size && !newPartitionIds) throw new Error('Freelance.ru category listing repeats all previously seen task IDs in its partition');
    for (const id of nativeIds) { seenIds.add(id); partitionSeenIds.add(id); }
    visited.add(finalUrl);
    partitionVisited.add(finalUrl);
    if (!discovering && observedNext && (visited.has(observedNext) || partitionVisited.has(observedNext))) throw new Error('Freelance.ru next control repeats a visited page');
    const completed = [...completedCategoryIds] as string[];
    let nextCategoryIndex = categoryIndex;
    let continuationUrl: string | undefined;
    let nextPage: number | undefined;
    if (discovering) {
      continuationUrl = this.categoryUrl(frozenCatalog[0].id);
      nextPage = 0;
    } else if (observedNext) {
      continuationUrl = observedNext;
      nextPage = page + 1;
    } else {
      completed.push(category!.id);
      nextCategoryIndex++;
      if (nextCategoryIndex < frozenCatalog.length) {
        continuationUrl = this.categoryUrl(frozenCatalog[nextCategoryIndex].id);
        nextPage = 0;
      }
    }
    const hasMore = Boolean(continuationUrl);
    const newPartition = discovering || nextCategoryIndex !== categoryIndex;
    return {
      records, hasMore, nextPage,
      checkpoint: {
        categorySweepVersion: 1, hasMore, ...(hasMore ? { nextUrl: continuationUrl, nextPage } : { terminalReason: 'all-category-partitions-exhausted' }),
        backfillSince, windowTo, observedCategoryCatalog: frozenCatalog, categoryIndex: nextCategoryIndex, completedCategoryIds: completed,
        visitedListUrls: [...visited], seenExternalIds: [...seenIds],
        partitionVisitedListUrls: newPartition ? [] : [...partitionVisited], partitionSeenExternalIds: newPartition ? [] : [...partitionSeenIds],
        coverage: 'categories-public-catalog', lastFetchedAt: new Date().toISOString(),
      },
      stats: { seen: nativeIds.size },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> { return result.checkpoint; }

  private safeUrl(value: string | undefined, from: string, kind: 'list' | 'detail', categoryId?: string): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, from);
      if (url.origin !== 'https://freelance.ru' || url.username || url.password || url.hash) return undefined;
      if (kind === 'detail' ? !/^\/task\/view\/\d+\/?$/.test(url.pathname) : !/^\/task\/?$/.test(url.pathname)) return undefined;
      if (kind === 'detail') return url.search ? undefined : url.toString();
      if ([...url.searchParams.keys()].some(key => !['page', 'c[]', 'c[0]'].includes(key))) return undefined;
      if (url.searchParams.getAll('page').length > 1) return undefined;
      const page = url.searchParams.get('page');
      if (page !== null && (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)))) return undefined;
      const categories = [...url.searchParams.getAll('c[]'), ...url.searchParams.getAll('c[0]')];
      if (categoryId ? categories.length !== 1 || categories[0] !== categoryId : categories.length !== 0) return undefined;
      url.pathname = '/task';
      url.search = '';
      if (categoryId) url.searchParams.set('c[0]', categoryId);
      if (page && page !== '1') url.searchParams.set('page', page);
      return url.toString();
    } catch { return undefined; }
  }

  private categoryUrl(id: string): string {
    const url = new URL('https://freelance.ru/task');
    url.searchParams.set('c[0]', id);
    return url.toString();
  }

  private listPage(url: string): number { return Number(new URL(url).searchParams.get('page') ?? 1); }

  private categoryCatalog($: ReturnType<typeof load>): NativeCategory[] {
    const inputs = $('form[method="get"][action="/task"] input[name="c[]"]');
    if (!inputs.length) throw new Error('Freelance.ru listing is missing its declared native category catalog');
    const categories = inputs.map((_, item) => ({ id: $(item).attr('value') ?? '', label: this.text($(item).closest('label').text()) })).get();
    if (categories.some(item => !/^[1-9]\d*$/.test(item.id) || !item.label) || new Set(categories.map(item => item.id)).size !== categories.length) throw new Error('Freelance.ru listing has an invalid declared category catalog');
    return categories;
  }

  private readCheckpointCatalog(value: unknown): NativeCategory[] {
    if (!Array.isArray(value) || !value.length || value.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[1-9]\d*$/.test(item.id) || typeof item.label !== 'string' || !item.label.trim()) || new Set(value.map(item => item.id)).size !== value.length) throw new Error('Freelance.ru continuation has an invalid frozen category catalog');
    return value.map(item => ({ id: item.id, label: item.label }));
  }

  private publicationDate(value?: string): Date | undefined {
    const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(value ?? '');
    if (!match) return undefined;
    const result = new Date(`${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+03:00`);
    if (Number.isNaN(result.getTime())) return undefined;
    return new Date(result.getTime() + 3 * 3_600_000).toISOString() === `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00.000Z` ? result : undefined;
  }

  private budget(value: string): { amount?: number; currency?: 'RUB' | 'USD' | 'EUR'; originalText: string } {
    const match = value.match(/\d[\d\s\u00a0]*(?:[.,]\d+)?/);
    const amount = match ? Number(match[0].replace(/[\s\u00a0]/g, '').replace(',', '.')) : undefined;
    const currency = /₽|руб/i.test(value) ? 'RUB' : /\$|USD/i.test(value) ? 'USD' : /€|EUR/i.test(value) ? 'EUR' : undefined;
    return { amount: Number.isFinite(amount) ? amount : undefined, currency, originalText: value };
  }

  private text(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
}
