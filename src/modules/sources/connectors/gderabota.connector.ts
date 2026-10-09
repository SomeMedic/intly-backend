import { load } from 'cheerio';

import { WebExtractionHttpError, WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { stringValue } from './connector-utils';

const ORIGIN = 'https://gderabota.ru';
const DEFAULT_LIST_URL = `${ORIGIN}/%D0%B2%D0%B0%D0%BA%D0%B0%D0%BD%D1%81%D0%B8%D0%B8?autocompleteCity=-1&filterInSevenDays=&filterInThirtyDays=1&page=1`;
const MAX_BACKFILL_DAYS = 30;
const MAX_HTML_BYTES = 2_000_000;
const ALLOWED_HOSTS = ['gderabota.ru'];

type InertiaPage = { component?: string; props?: Record<string, unknown> };
type VacancyList = { data?: unknown[]; next_page_url?: unknown; current_page?: unknown; total?: unknown; per_page?: unknown };
type VacancyItem = Record<string, unknown>;
type ListRecord = { id: string; url?: string; publishedAt?: Date; updatedAt?: Date; raw: VacancyItem };
type DetailListRecord = ListRecord & { url: string };
type DetailCoverageIssue = { id: string; url?: string; reason: 'detail_under_moderation' | 'detail_http_404' | 'detail_url_missing'; title?: string; companyOrClient?: string; publishedAt?: string; listUrl: string; component?: 'vacancyFirstModeration/index'; httpStatus?: 404; resolvedUrl?: string };
type DetailOutcome = { kind: 'record'; record: RawOpportunityRecord } | { kind: 'coverageIssue'; issue: DetailCoverageIssue };

export class GdeRabotaConnector implements Connector {
  readonly id = 'gderabota';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly extraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    const url = this.safeUrl(typeof config.baseUrl === 'string' ? config.baseUrl : DEFAULT_LIST_URL, DEFAULT_LIST_URL, 'list');
    return url
      ? { ok: true, message: 'GdeRabota public Inertia vacancy list configured', details: { url } }
      : { ok: false, message: 'GdeRabota requires a public /вакансии listing URL' };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1 });
      return { state: 'Healthy', message: `GdeRabota returned ${page.records.length} public vacancies`, checkedAt: new Date(), details: { seen: page.stats.seen } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'GdeRabota fetch failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const baseUrl = this.baseUrl(ctx);
    const continuing = ctx.checkpoint.hasMore === true;
    const nextUrl = continuing && typeof ctx.checkpoint.nextUrl === 'string' ? this.safeUrl(ctx.checkpoint.nextUrl, baseUrl, 'list') : undefined;
    if (continuing && !nextUrl) throw new Error('GdeRabota continuation has an invalid listing URL');
    const listUrl = nextUrl ?? baseUrl;
    const document = await this.extraction.extractUrl(listUrl, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal });
    ctx.signal?.throwIfAborted();
    const finalUrl = this.safeUrl(document.finalUrl, listUrl, 'list');
    if (!finalUrl) throw new Error('GdeRabota listing redirected outside public vacancy lists');

    const page = this.inertiaPage(document.html);
    if (page.component !== 'VacancyList/index') throw new Error(`GdeRabota expected VacancyList SSR page, got ${page.component ?? 'unknown'}`);
    const vacancyList = this.record(page.props?.vacancyList) as VacancyList | undefined;
    if (!Array.isArray(vacancyList?.data)) throw new Error('GdeRabota listing has no public vacancy data array');
    const items = vacancyList.data;

    const window = this.window(ctx, continuing);
    const records: RawOpportunityRecord[] = [];
    const coverageIssues = continuing && Array.isArray(ctx.checkpoint.detailCoverageIssues) ? ctx.checkpoint.detailCoverageIssues.filter((value): value is DetailCoverageIssue => this.isDetailCoverageIssue(value)) : [];
    const seenIds = new Set<string>(continuing && Array.isArray(ctx.checkpoint.seenIds) ? ctx.checkpoint.seenIds.filter((value): value is string => typeof value === 'string') : []);
    for (const item of items) {
      ctx.signal?.throwIfAborted();
      if (!this.isRecord(item)) throw new Error('GdeRabota listing returned a malformed vacancy record');
      const listRecord = this.listRecord(item, finalUrl);
      if (seenIds.has(listRecord.id)) continue;
      if (listRecord.publishedAt && (listRecord.publishedAt < window.since || listRecord.publishedAt > window.to)) continue;
      if (!listRecord.url) {
        coverageIssues.push(this.detailUrlMissingIssue(listRecord, finalUrl));
        seenIds.add(listRecord.id);
        continue;
      }
      const detailListRecord: DetailListRecord = { ...listRecord, url: listRecord.url };
      let detailOutcome: DetailOutcome;
      try {
        const detail = await this.extraction.extractUrl(detailListRecord.url, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal });
        const finalDetailUrl = this.safeUrl(detail.finalUrl, detailListRecord.url, 'detail');
        if (!finalDetailUrl || finalDetailUrl !== detailListRecord.url) throw new Error(`GdeRabota vacancy ${detailListRecord.id} redirected away from its detail page`);
        detailOutcome = this.detailRecord(detail.html, detailListRecord, finalUrl);
      } catch (error) {
        if (!this.isExpectedDetailHttp404(error, detailListRecord.url)) throw error;
        detailOutcome = { kind: 'coverageIssue', issue: this.detailHttp404Issue(detailListRecord, finalUrl, error.url) };
      }
      if (detailOutcome.kind === 'coverageIssue') {
        coverageIssues.push(detailOutcome.issue);
        seenIds.add(listRecord.id);
        continue;
      }
      records.push(detailOutcome.record);
      seenIds.add(listRecord.id);
    }

    const visited = new Set<string>(continuing && Array.isArray(ctx.checkpoint.visitedListUrls) ? ctx.checkpoint.visitedListUrls.filter((value): value is string => typeof value === 'string') : []);
    if (continuing && visited.has(finalUrl)) throw new Error(`GdeRabota pagination cycle detected at ${finalUrl}`);
    visited.add(finalUrl);
    const nextValue = vacancyList.next_page_url;
    if (nextValue !== null && nextValue !== undefined && typeof nextValue !== 'string') throw new Error('GdeRabota listing returned an invalid next_page_url');
    const rawNext = stringValue(nextValue);
    const observedNext = rawNext ? this.safeUrl(rawNext, finalUrl, 'list') : undefined;
    if (rawNext && !observedNext) throw new Error('GdeRabota listing returned an invalid next_page_url');
    if (observedNext && new URL(baseUrl).searchParams.get('filterInThirtyDays') === '1' && new URL(observedNext).searchParams.get('filterInThirtyDays') !== '1') throw new Error('GdeRabota pagination dropped the configured monthly filter');
    if (observedNext && visited.has(observedNext)) throw new Error(`GdeRabota pagination cycle detected at ${observedNext}`);
    const hasMore = Boolean(observedNext);
    const nextPage = hasMore ? (this.numberValue(ctx.checkpoint.nextPage) ?? 0) + 1 : undefined;
    const checkpointBase = { visitedListUrls: [...visited], seenIds: [...seenIds], backfillSince: window.since.toISOString(), windowTo: window.to.toISOString(), coverage: 'configured-list-url', detailCoverageIssues: coverageIssues.length > 0 ? coverageIssues : undefined, lastFetchedAt: new Date().toISOString() };
    return {
      records,
      hasMore,
      nextPage,
      checkpoint: hasMore
        ? this.omitUndefined({ hasMore: true, nextUrl: observedNext, nextPage, ...checkpointBase })
        : this.omitUndefined({ hasMore: false, ...checkpointBase }),
      stats: { seen: items.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private baseUrl(ctx: FetchContext): string {
    const candidate = typeof ctx.source.endpoint?.baseUrl === 'string' ? ctx.source.endpoint.baseUrl : typeof ctx.source.config?.baseUrl === 'string' ? ctx.source.config.baseUrl : DEFAULT_LIST_URL;
    const safe = this.safeUrl(candidate, DEFAULT_LIST_URL, 'list');
    if (!safe) throw new Error('GdeRabota source has no safe public vacancy list URL');
    return safe;
  }

  private listRecord(item: VacancyItem, listUrl: string): ListRecord {
    const entityId = this.numberValue(item.entityId) ?? this.numberValue(item.id);
    const id = entityId?.toString();
    if (!id) throw new Error('GdeRabota listing returned a vacancy without a stable id');
    const rawUrl = stringValue(item.viewUrl);
    const url = rawUrl ? this.safeUrl(rawUrl, listUrl, 'detail') : undefined;
    if (rawUrl && !url) throw new Error(`GdeRabota listing vacancy ${id} has an invalid detail URL`);
    const urlId = url ? this.detailUrlId(url) : undefined;
    if (url && urlId && urlId !== id) throw new Error(`GdeRabota listing vacancy ${id} detail URL id mismatch`);
    return { id, url, publishedAt: this.russianDate(stringValue(item.humanizeCreatedAt)), updatedAt: this.russianDate(stringValue(item.humanizeUpdatedAt)), raw: item };
  }

  private detailUrlMissingIssue(listRecord: ListRecord, listUrl: string): DetailCoverageIssue {
    return this.omitUndefined({
      id: listRecord.id,
      reason: 'detail_url_missing',
      title: stringValue(listRecord.raw.title),
      companyOrClient: this.companyName(listRecord.raw),
      publishedAt: listRecord.publishedAt?.toISOString(),
      listUrl,
    }) as DetailCoverageIssue;
  }

  private detailHttp404Issue(listRecord: DetailListRecord, listUrl: string, resolvedUrl: string): DetailCoverageIssue {
    return this.omitUndefined({
      id: listRecord.id,
      url: listRecord.url,
      resolvedUrl: resolvedUrl === listRecord.url ? undefined : resolvedUrl,
      reason: 'detail_http_404',
      httpStatus: 404,
      title: stringValue(listRecord.raw.title),
      companyOrClient: this.companyName(listRecord.raw),
      publishedAt: listRecord.publishedAt?.toISOString(),
      listUrl,
    }) as DetailCoverageIssue;
  }

  private detailRecord(html: string, listRecord: DetailListRecord, listUrl: string): DetailOutcome {
    const page = this.inertiaPage(html);
    if (page.component === 'vacancyFirstModeration/index') {
      return {
        kind: 'coverageIssue',
        issue: this.omitUndefined({
          id: listRecord.id,
          url: listRecord.url,
          component: 'vacancyFirstModeration/index',
          reason: 'detail_under_moderation',
          title: stringValue(listRecord.raw.title),
          companyOrClient: this.companyName(listRecord.raw),
          publishedAt: listRecord.publishedAt?.toISOString(),
          listUrl,
        }) as DetailCoverageIssue,
      };
    }
    if (page.component !== 'Vacancy/index') throw new Error(`GdeRabota vacancy ${listRecord.id} expected detail SSR page, got ${page.component ?? 'unknown'}`);
    const vacancy = this.record(page.props?.vacancy);
    if (!vacancy) throw new Error(`GdeRabota vacancy ${listRecord.id} has no public detail payload`);
    const detailPayloadId = (this.numberValue(vacancy.entityId) ?? this.numberValue(vacancy.id))?.toString();
    if (!detailPayloadId && !this.detailUrlId(listRecord.url)) throw new Error(`GdeRabota vacancy ${listRecord.id} detail payload has no stable id`);
    const id = detailPayloadId ?? listRecord.id;
    if (id !== listRecord.id) throw new Error(`GdeRabota vacancy ${listRecord.id} detail payload id mismatch`);
    const title = stringValue(vacancy.title);
    const rawAbout = stringValue(vacancy.about);
    const description = this.htmlToText(rawAbout ?? '');
    if (!title || !description || /\.\.\.$/.test(description)) throw new Error(`GdeRabota vacancy ${listRecord.id} has no usable public detail body`);
    const salary = this.salary(vacancy.salaryFrom, vacancy.salaryTo);
    const addressList = Array.isArray(vacancy.addressList) ? vacancy.addressList.filter(this.isRecord) : [];
    const locations = this.locations(addressList, stringValue(listRecord.raw.cityName));
    const company = this.companyName(page.props) ?? this.companyName(listRecord.raw);
    const schedule = this.stringList(vacancy.scheduleList).join(', ') || undefined;
    const categories = [...this.stringList(vacancy.specializationList), ...this.stringList(vacancy.socialCategories)];
    const skills = this.stringList(vacancy.skills ?? vacancy.skillList ?? vacancy.skillsList);
    const updatedAt = this.russianDate(stringValue(vacancy.humanizeUpdatedAt)) ?? listRecord.updatedAt;
    return {
      kind: 'record',
      record: {
        externalId: id,
        url: listRecord.url,
        type: 'vacancy',
        title,
        companyOrClient: company,
        description,
        publishedAt: listRecord.publishedAt,
        updatedAt,
        sourceStatus: 'Unknown',
        rawPayload: { listUrl, listItem: listRecord.raw, detailVacancy: vacancy },
        sourceMetadata: {
          extraction: 'gderabota-inertia-ssr',
          sourceUrl: listUrl,
          salary,
          area: locations[0],
          locations: locations.length > 0 ? locations : undefined,
          employment: stringValue(vacancy.employment),
          schedule,
          seniority: stringValue(vacancy.experience),
          categoryTags: categories.length > 0 ? Array.from(new Set(categories)) : undefined,
          skills: skills.length > 0 ? Array.from(new Set(skills)) : undefined,
          dateKnown: Boolean(listRecord.publishedAt),
        },
      },
    };
  }

  private inertiaPage(html: string): InertiaPage {
    const raw = /data-page="([^"]+)"/i.exec(html)?.[1];
    if (!raw) throw new Error('GdeRabota page has no Inertia SSR data-page payload');
    const parsed = JSON.parse(this.unescape(raw)) as unknown;
    if (!this.isRecord(parsed)) throw new Error('GdeRabota Inertia payload is not an object');
    return parsed as InertiaPage;
  }

  private safeUrl(value: string | undefined, from: string, kind: 'list' | 'detail'): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, from);
      if (url.origin !== ORIGIN || url.username || url.password || url.port) return undefined;
      const decodedPath = decodeURIComponent(url.pathname);
      if (kind === 'detail') {
        const legacyDetailPath = /^\/вакансии\/[^/]+\/[^/]+\/\d+\/?$/i.test(decodedPath);
        const trudvsemDetailPath = /^\/вакансии\/трудвсем\/\d+\/?$/i.test(decodedPath);
        const vacancyInfoDetailPath = /^\/вакансии\/vacancy-info\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(decodedPath);
        if ((!legacyDetailPath && !trudvsemDetailPath && !vacancyInfoDetailPath) || url.search) return undefined;
      } else {
        if (!/^\/вакансии(?:\/[^/]+(?:\/[^/]+)?)?\/?$/i.test(decodedPath) || /\/\d+\/?$/.test(decodedPath)) return undefined;
        for (const key of url.searchParams.keys()) if (!['page', 'sort', 'autocompleteCity', 'filterInSevenDays', 'filterInThirtyDays'].includes(key)) return undefined;
        if (url.searchParams.has('page') && !/^[1-9]\d*$/.test(url.searchParams.get('page')!)) return undefined;
        if (url.searchParams.has('sort') && !/^(?:date)$/.test(url.searchParams.get('sort')!)) return undefined;
        if (url.searchParams.has('autocompleteCity') && url.searchParams.get('autocompleteCity') !== '-1') return undefined;
        if (url.searchParams.has('filterInSevenDays') && url.searchParams.get('filterInSevenDays') !== '') return undefined;
        if (url.searchParams.has('filterInThirtyDays') && url.searchParams.get('filterInThirtyDays') !== '1') return undefined;
      }
      url.hash = '';
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private window(ctx: FetchContext, continuing: boolean): { since: Date; to: Date } {
    const since = (continuing ? this.date(typeof ctx.checkpoint.backfillSince === 'string' ? ctx.checkpoint.backfillSince : undefined) : undefined)
      ?? this.date(ctx.backfillSince)
      ?? new Date(Date.now() - Math.min(ctx.backfillDays, MAX_BACKFILL_DAYS) * 86_400_000);
    const to = (continuing ? this.date(typeof ctx.checkpoint.windowTo === 'string' ? ctx.checkpoint.windowTo : undefined) : undefined) ?? new Date();
    return { since, to };
  }

  private salary(from: unknown, to: unknown): Record<string, unknown> | undefined {
    const min = this.positiveNumber(from);
    const max = this.positiveNumber(to);
    if (!min && !max) return undefined;
    const originalText = [min && `от ${min}`, max && `до ${max}`, 'RUB'].filter(Boolean).join(' ');
    return this.omitUndefined({ min, max, currency: 'RUB', originalText });
  }

  private locations(items: VacancyItem[], fallback?: string): string[] {
    const values = items.map((item) => [item.localityName, item.provinceName, item.streetName, item.house].map((value) => stringValue(value)).filter(Boolean).join(', ')).filter(Boolean);
    if (fallback) values.push(fallback);
    return Array.from(new Set(values));
  }

  private companyName(value: unknown): string | undefined {
    const record = this.record(value);
    return stringValue(this.record(record?.employerCompanyData)?.name) ?? stringValue(this.record(record?.companyData)?.name) ?? stringValue(record?.companyName);
  }

  private russianDate(value?: string): Date | undefined {
    if (!value) return undefined;
    const match = /^(\d{1,2})\s+([а-яё]+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})$/i.exec(value.trim());
    if (!match) return undefined;
    const month = MONTHS[match[2].toLowerCase()];
    if (!month) return undefined;
    const date = new Date(Date.UTC(Number(match[3]), month - 1, Number(match[1]), Number(match[4]) - 3, Number(match[5]), 0));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private htmlToText(value: string): string {
    return load(value.replace(/<br\s*\/?\s*>/gi, '\n')).text().replace(/\u00a0/g, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n+ */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private stringList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((item) => stringValue(this.record(item)?.name) ?? stringValue(item)).filter((item): item is string => Boolean(item));
    return [];
  }

  private date(value?: string): Date | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
  }

  private positiveNumber(value: unknown): number | undefined {
    const number = this.numberValue(value);
    return number && number > 0 ? number : undefined;
  }

  private record(value: unknown): Record<string, unknown> | undefined {
    return this.isRecord(value) ? value : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  private isDetailCoverageIssue(value: unknown): value is DetailCoverageIssue {
    const issue = this.record(value);
    if (typeof issue?.id !== 'string' || typeof issue.listUrl !== 'string') return false;
    if (issue.reason === 'detail_under_moderation') return typeof issue.url === 'string' && issue.component === 'vacancyFirstModeration/index';
    if (issue.reason === 'detail_http_404') return typeof issue.url === 'string' && issue.httpStatus === 404;
    if (issue.reason === 'detail_url_missing') return true;
    return false;
  }

  private isExpectedDetailHttp404(error: unknown, expectedUrl: string): error is WebExtractionHttpError {
    if (!(error instanceof WebExtractionHttpError) || error.status !== 404) return false;
    if (error.url === expectedUrl) return true;
    const expectedId = this.detailUrlId(expectedUrl);
    const actualId = this.detailUrlId(error.url);
    return Boolean(expectedId && actualId && expectedId === actualId);
  }

  private detailUrlId(value: string): string | undefined {
    const safe = this.safeUrl(value, ORIGIN, 'detail');
    if (!safe) return undefined;
    return /\/(\d+)\/?$/.exec(decodeURIComponent(new URL(safe).pathname))?.[1];
  }

  private omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
  }

  private unescape(value: string): string {
    return value.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code))).replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
  }
}

const MONTHS: Record<string, number> = {
  января: 1,
  февраля: 2,
  марта: 3,
  апреля: 4,
  мая: 5,
  июня: 6,
  июля: 7,
  августа: 8,
  сентября: 9,
  октября: 10,
  ноября: 11,
  декабря: 12,
};
