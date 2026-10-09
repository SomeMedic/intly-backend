import { createHash } from 'node:crypto';

import { load } from 'cheerio';

import { WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { stringValue } from './connector-utils';

const DEFAULT_LIST_URL = 'https://www.rabota.ru/vacancy/?sort=date';
const REGION_CATALOG_URL = 'https://www.rabota.ru/api-web/v5/regions/suggest.json';
const REGION_CATALOG_FALLBACK_URL = 'https://www.rabota.ru/api-web/v4/regions/suggest.json';
const MAX_BACKFILL_DAYS = 30;
const MAX_HTML_BYTES = 2_000_000;
const MAX_REGION_CATALOG_REGIONS = 2_000;
const PUBLIC_LIST_PAGE_SIZE = 30;
const ALLOWED_HOSTS = ['rabota.ru'];

type JobPosting = Record<string, unknown>;
type RabotaListRecord = {
  externalId: string;
  url: string;
  title?: string;
  companyOrClient?: string;
  description?: string;
  publishedAt?: Date;
  salary?: Record<string, unknown>;
  locations: string[];
  employment?: string;
  skills: string[];
  jsonLd: JobPosting;
  rawDescription?: string;
};
type RabotaRegion = {
  id: number;
  name: string;
  domain: string;
};
type RabotaCatalogPlan = {
  sourceUrls: string[];
  manual: boolean;
  coverage: 'all-public-regions-observed' | 'configured-list-urls-only';
  coverageLimitation?: string;
  regionCatalog?: { total: number; hash: string; regions: RabotaRegion[] };
};
type RabotaDetailRecord = {
  id: string;
  title?: string;
  description: string;
  rawDescription: string;
  companyOrClient?: string;
  publishedAt?: Date;
  salary?: Record<string, unknown>;
  locations: string[];
  employment?: string;
  schedule?: string;
  seniority?: string;
  skills: string[];
  rawState: Record<string, unknown>;
};

export class RabotaRuConnector implements Connector {
  readonly id = 'rabota-ru';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly extraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    const urls = this.listUrls({ endpoint: config, config: {} });
    return urls.length > 0
      ? { ok: true, message: 'Rabota.ru public SSR vacancy list configured', details: { urls } }
      : { ok: false, message: 'Rabota.ru requires public /vacancy list URLs on rabota.ru subdomains' };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1 });
      return { state: 'Healthy', message: `Rabota.ru returned ${page.records.length} public vacancy records`, checkedAt: new Date(), details: { seen: page.stats.seen } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Rabota.ru fetch failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const continuing = ctx.checkpoint.hasMore === true;
    const plan = await this.catalogPlan(ctx, continuing);
    const { sourceUrls } = plan;
    if (sourceUrls.length === 0) throw new Error('Rabota.ru source has no safe public vacancy list URL');

    const listIndex = continuing ? this.numberValue(ctx.checkpoint.listIndex) ?? this.numberValue(ctx.checkpoint.regionIndex) ?? 0 : 0;
    if (continuing && (listIndex < 0 || listIndex >= sourceUrls.length)) throw new Error('Rabota.ru continuation listIndex is outside configured list URLs');
    const currentSourceUrl = sourceUrls[listIndex];
    const checkpointNext = continuing && typeof ctx.checkpoint.nextUrl === 'string'
      ? this.safeUrl(ctx.checkpoint.nextUrl, currentSourceUrl, 'list')
      : undefined;
    if (continuing && !checkpointNext) throw new Error('Rabota.ru continuation has an invalid listing URL');
    if (continuing && checkpointNext && new URL(checkpointNext).origin !== new URL(currentSourceUrl).origin) {
      throw new Error('Rabota.ru continuation URL must stay on the current configured regional origin');
    }

    const listUrl = checkpointNext ?? currentSourceUrl;
    const document = await this.extraction.extractUrl(listUrl, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal });
    ctx.signal?.throwIfAborted();
    const finalUrl = this.safeUrl(document.finalUrl, listUrl, 'list');
    if (!finalUrl) throw new Error('Rabota.ru listing redirected outside public vacancy lists');
    if (new URL(finalUrl).origin !== new URL(listUrl).origin) throw new Error('Rabota.ru listing redirected outside the current configured regional origin');

    const postings = this.jobPostings(document.html);
    const window = this.window(ctx, continuing);
    if (postings.length === 0) {
      if (!this.canAcceptEmptyRegionPage(plan, finalUrl, document.html)) throw new Error('Rabota.ru listing contains no public JobPosting JSON-LD records');
      return this.emptyRegionPage(plan, sourceUrls, listIndex, finalUrl, window, ctx);
    }

    const candidates = postings
      .map((posting) => this.listRecord(posting, finalUrl))
      .filter((record) => !record.publishedAt || (record.publishedAt >= window.since && record.publishedAt <= window.to));
    const seenExternalIds = new Set(continuing && Array.isArray(ctx.checkpoint.seenExternalIds) ? ctx.checkpoint.seenExternalIds.filter((value): value is string => typeof value === 'string') : []);
    const records: RawOpportunityRecord[] = [];
    for (const candidate of candidates) {
      if (seenExternalIds.has(candidate.externalId)) continue;
      ctx.signal?.throwIfAborted();
      const detail = await this.extraction.extractUrl(candidate.url, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal });
      const finalDetailUrl = this.safeUrl(detail.finalUrl, candidate.url, 'detail');
      if (!finalDetailUrl || finalDetailUrl !== candidate.url) throw new Error(`Rabota.ru vacancy ${candidate.externalId} redirected away from its detail page`);
      const record = this.detailRecord(detail.html, candidate, finalUrl);
      if (!record.publishedAt || (record.publishedAt >= window.since && record.publishedAt <= window.to)) {
        records.push(record);
        seenExternalIds.add(record.externalId);
      }
    }
    const visited = new Set<string>(continuing && Array.isArray(ctx.checkpoint.visitedListUrls) ? ctx.checkpoint.visitedListUrls.filter((value): value is string => typeof value === 'string') : []);
    if (continuing && visited.has(finalUrl)) throw new Error(`Rabota.ru pagination cycle detected at ${finalUrl}`);
    visited.add(finalUrl);
    const observedNext = this.nextListUrl(document.html, finalUrl);
    if (observedNext && visited.has(observedNext)) throw new Error(`Rabota.ru pagination cycle detected at ${observedNext}`);
    const nextSourceUrl = sourceUrls[listIndex + 1];
    const hasObservedNext = Boolean(observedNext);
    const hasNextSource = !hasObservedNext && Boolean(nextSourceUrl);
    const hasMore = hasObservedNext || hasNextSource;
    const nextUrl = hasObservedNext ? observedNext : hasNextSource ? nextSourceUrl : undefined;
    const nextListIndex = hasObservedNext ? listIndex : listIndex + 1;
    const nextPage = hasMore ? (this.numberValue(ctx.checkpoint.nextPage) ?? 0) + 1 : undefined;
    const nextRegion = hasMore ? this.regionForUrl(plan.regionCatalog?.regions, sourceUrls[nextListIndex]) : undefined;
    const completedRegionCount = hasObservedNext ? listIndex : nextListIndex;
    const checkpointBase = this.checkpointBase(plan, sourceUrls, window, [...seenExternalIds], [...visited], completedRegionCount);

    return {
      records,
      hasMore,
      nextPage,
      checkpoint: hasMore
        ? this.omitUndefined({
          ...checkpointBase,
          hasMore: true,
          nextUrl,
          nextPage,
          listIndex: nextListIndex,
          regionIndex: nextListIndex,
          region: nextRegion,
        })
        : this.omitUndefined({ ...checkpointBase, hasMore: false }),
      stats: { seen: postings.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }


  private canAcceptEmptyRegionPage(plan: RabotaCatalogPlan, finalUrl: string, html: string): boolean {
    if (plan.manual || plan.coverage !== 'all-public-regions-observed' || !plan.regionCatalog) return false;
    const region = this.regionForUrl(plan.regionCatalog.regions, finalUrl);
    if (!region) return false;
    return this.hasObservedEmptySearchState(html, region.id) || this.hasObservedPastLastSearchPage(html, region.id, finalUrl);
  }

  private hasObservedEmptySearchState(html: string, regionId: number): boolean {
    const observed = this.observedSearchState(html);
    if (!observed) return false;
    return this.isZeroLiteral(this.literalToken(observed.searchState, 'totalVacancies'), observed.aliases)
      && this.isZeroLiteral(this.literalToken(observed.searchState, 'relevantVacancies'), observed.aliases)
      && this.isZeroLiteral(this.literalToken(observed.searchState, 'actualVacancies'), observed.aliases)
      && this.searchStateHasEmptyResults(observed.searchState)
      && this.searchStateHasDateSort(observed.searchState, observed.aliases)
      && this.searchStateMatchesRegion(observed.searchState, regionId);
  }

  private hasObservedPastLastSearchPage(html: string, regionId: number, finalUrl: string): boolean {
    const observed = this.observedSearchState(html);
    if (!observed) return false;
    const total = this.numericLiteral(this.literalToken(observed.searchState, 'totalVacancies'), observed.aliases);
    const page = this.listPage(finalUrl);
    if (!total || page <= Math.ceil(total / PUBLIC_LIST_PAGE_SIZE)) return false;
    return this.searchStateHasEmptyResults(observed.searchState)
      && this.searchStateHasDateSort(observed.searchState, observed.aliases)
      && this.searchStateMatchesRegion(observed.searchState, regionId);
  }

  private observedSearchState(html: string): { searchState: string; aliases: Map<string, unknown> | undefined } | undefined {
    if (!html.includes('__NUXT__') || !html.includes('rabota:{') || !html.includes('search:{')) return undefined;
    const searchStart = html.indexOf('search:{', html.indexOf('rabota:{'));
    if (searchStart < 0) return undefined;
    return { searchState: html.slice(searchStart, searchStart + 80_000), aliases: this.nuxtIifeAliases(html) };
  }

  private searchStateHasEmptyResults(searchState: string): boolean {
    return /vacancies\s*:\s*\[\s*\]/.test(searchState) && /queryGroups\s*:\s*\[\s*\]/.test(searchState);
  }

  private searchStateHasDateSort(searchState: string, aliases: Map<string, unknown> | undefined): boolean {
    const sort = /sort\s*:\s*\{([^}]*)\}/.exec(searchState)?.[1];
    const field = sort ? this.literalToken(sort, 'field') : undefined;
    const direction = sort ? this.literalToken(sort, 'direction') : undefined;
    const fieldValue = this.literalValue(field, aliases);
    const directionValue = this.literalValue(direction, aliases);
    if (fieldValue !== undefined || directionValue !== undefined) return fieldValue === 'date' && directionValue === 'desc';
    return /sort\.field:date::sort\.direction:desc/.test(searchState);
  }

  private searchStateMatchesRegion(searchState: string, regionId: number): boolean {
    return new RegExp(`location\\.region_id:${regionId}(?:::|\\b)`).test(searchState);
  }

  private numericLiteral(token: string | undefined, aliases: Map<string, unknown> | undefined): number | undefined {
    const value = this.literalValue(token, aliases);
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private listPage(url: string): number {
    const raw = new URL(url).searchParams.get('page');
    const page = raw ? Number(raw) : 1;
    return Number.isInteger(page) && page > 0 ? page : 1;
  }

  private literalToken(source: string, key: string): string | undefined {
    const match = new RegExp(`${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?|[A-Za-z_$][A-Za-z0-9_$]*)`).exec(source);
    return match?.[1];
  }

  private isZeroLiteral(token: string | undefined, aliases: Map<string, unknown> | undefined): boolean {
    const value = this.literalValue(token, aliases);
    return value === 0;
  }

  private isStringLiteral(token: string | undefined, aliases: Map<string, unknown> | undefined, expected: string): boolean {
    const value = this.literalValue(token, aliases);
    return value === expected;
  }

  private literalValue(token: string | undefined, aliases: Map<string, unknown> | undefined): unknown {
    if (!token) return undefined;
    if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
    if (token.startsWith('"')) return this.readString(token, 0)?.value;
    return aliases?.has(token) ? aliases.get(token) : undefined;
  }

  private nuxtIifeAliases(html: string): Map<string, unknown> | undefined {
    const header = /__NUXT__\s*=\s*\(function\s*\(([^)]*)\)/.exec(html);
    if (!header) return undefined;
    const bodyStart = html.indexOf('{', header.index + header[0].length);
    if (bodyStart < 0) return undefined;
    const body = this.readNested(html, bodyStart);
    if (!body) return undefined;
    let argsStart = bodyStart + body.length;
    while (/\s/.test(html[argsStart] ?? '')) argsStart += 1;
    if (html[argsStart] === ')' && html[argsStart + 1] === '(') argsStart += 1;
    const argsText = this.readParenthesized(html, argsStart);
    if (!argsText) return undefined;
    const names = header[1].split(',').map((name) => name.trim()).filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));
    const args = this.splitTopLevel(argsText.slice(1, -1)).map((token) => this.simpleLiteral(token));
    if (names.length !== args.length) return undefined;
    return new Map(names.flatMap((name, index) => args[index].ok ? [[name, args[index].value] as [string, unknown]] : []));
  }

  private simpleLiteral(token: string): { ok: true; value: unknown } | { ok: false } {
    const value = token.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return { ok: true, value: Number(value) };
    if (value === 'true') return { ok: true, value: true };
    if (value === 'false') return { ok: true, value: false };
    if (value === 'null') return { ok: true, value: null };
    if (value === 'void 0') return { ok: true, value: undefined };
    if (value.startsWith('"')) {
      const parsed = this.readString(value, 0);
      return parsed ? { ok: true, value: parsed.value } : { ok: false };
    }
    return { ok: false };
  }

  private readParenthesized(source: string, start: number): string | undefined {
    if (source[start] !== '(') return undefined;
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === '"') {
        const parsed = this.readString(source, index);
        if (!parsed) return undefined;
        index = parsed.end;
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    return undefined;
  }

  private splitTopLevel(source: string): string[] {
    const values: string[] = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (char === '"') {
        const parsed = this.readString(source, index);
        if (!parsed) return [];
        index = parsed.end;
        continue;
      }
      if (char === '(' || char === '{' || char === '[') depth += 1;
      if (char === ')' || char === '}' || char === ']') depth -= 1;
      if (char === ',' && depth === 0) {
        values.push(source.slice(start, index));
        start = index + 1;
      }
    }
    values.push(source.slice(start));
    return values;
  }

  private emptyRegionPage(plan: RabotaCatalogPlan, sourceUrls: string[], listIndex: number, finalUrl: string, window: { since: Date; to: Date }, ctx: FetchContext): FetchPage {
    const visited = new Set<string>(ctx.checkpoint.hasMore === true && Array.isArray(ctx.checkpoint.visitedListUrls) ? ctx.checkpoint.visitedListUrls.filter((value): value is string => typeof value === 'string') : []);
    if (ctx.checkpoint.hasMore === true && visited.has(finalUrl)) throw new Error(`Rabota.ru pagination cycle detected at ${finalUrl}`);
    visited.add(finalUrl);
    const nextSourceUrl = sourceUrls[listIndex + 1];
    const hasMore = Boolean(nextSourceUrl);
    const nextListIndex = listIndex + 1;
    const nextPage = hasMore ? (this.numberValue(ctx.checkpoint.nextPage) ?? 0) + 1 : undefined;
    const nextRegion = hasMore ? this.regionForUrl(plan.regionCatalog?.regions, sourceUrls[nextListIndex]) : undefined;
    const seenExternalIds = ctx.checkpoint.hasMore === true && Array.isArray(ctx.checkpoint.seenExternalIds) ? ctx.checkpoint.seenExternalIds.filter((value): value is string => typeof value === 'string') : [];
    const checkpointBase = this.checkpointBase(plan, sourceUrls, window, seenExternalIds, [...visited], nextListIndex);
    return {
      records: [],
      hasMore,
      nextPage,
      checkpoint: hasMore
        ? this.omitUndefined({ ...checkpointBase, hasMore: true, nextUrl: nextSourceUrl, nextPage, listIndex: nextListIndex, regionIndex: nextListIndex, region: nextRegion })
        : this.omitUndefined({ ...checkpointBase, hasMore: false }),
      stats: { seen: 0 },
    };
  }

  private checkpointBase(
    plan: RabotaCatalogPlan,
    sourceUrls: string[],
    window: { since: Date; to: Date },
    seenExternalIds: string[],
    visitedListUrls: string[],
    completedRegionCount: number,
  ): Record<string, unknown> {
    return this.omitUndefined({
      sourceUrls,
      regionCatalog: plan.regionCatalog,
      backfillSince: window.since.toISOString(),
      windowTo: window.to.toISOString(),
      coverage: plan.coverage,
      coverageLimitation: plan.coverageLimitation,
      seenExternalIds,
      visitedListUrls,
      completedRegionCount: plan.coverage === 'all-public-regions-observed' ? completedRegionCount : undefined,
      lastFetchedAt: new Date().toISOString(),
    });
  }

  private listRecord(posting: JobPosting, listUrl: string): RabotaListRecord {
    const url = this.safeUrl(stringValue(posting.url), listUrl, 'detail');
    if (!url) throw new Error('Rabota.ru JobPosting has an invalid vacancy URL');
    const id = new URL(url).pathname.match(/\/vacancy\/(\d+)\/?$/)?.[1];
    if (!id) throw new Error(`Rabota.ru JobPosting has no stable numeric vacancy id: ${url}`);
    const title = stringValue(posting.title ?? posting.name);
    if (!title) throw new Error(`Rabota.ru vacancy ${id} has no title`);
    const rawDescription = stringValue(posting.description);
    const description = this.htmlToText(rawDescription ?? '', { preserveStructure: true }) || undefined;
    const publishedAt = this.date(stringValue(posting.datePosted));
    const salary = this.salary(posting.baseSalary) ?? this.salary(posting.estimatedSalary);
    const locations = this.locations(posting.jobLocation);
    const employment = this.joinStrings(posting.employmentType);
    const skills = this.stringList(posting.skills ?? posting.skillRequirements);
    return { externalId: id, url, title, companyOrClient: this.organization(posting.hiringOrganization), description, publishedAt, salary, locations, employment, skills, jsonLd: posting, rawDescription };
  }

  private detailRecord(html: string, listRecord: RabotaListRecord, listUrl: string): RawOpportunityRecord {
    const detail = this.detailVacancy(html, listRecord.externalId);
    const title = detail.title ?? listRecord.title;
    if (!title) throw new Error(`Rabota.ru vacancy ${listRecord.externalId} has no title`);
    const salary = detail.salary ?? listRecord.salary;
    const locations = detail.locations.length > 0 ? detail.locations : listRecord.locations;
    const employment = detail.employment ?? listRecord.employment;
    const skills = detail.skills.length > 0 ? detail.skills : listRecord.skills;
    const publishedAt = detail.publishedAt ?? listRecord.publishedAt;
    return {
      externalId: listRecord.externalId,
      url: listRecord.url,
      type: 'vacancy',
      title,
      companyOrClient: detail.companyOrClient ?? listRecord.companyOrClient,
      description: detail.description,
      publishedAt,
      sourceStatus: 'Unknown',
      rawPayload: { listUrl, jsonLd: listRecord.jsonLd, listRawDescription: listRecord.rawDescription, detailState: detail.rawState, rawDescription: detail.rawDescription },
      sourceMetadata: {
        extraction: 'rabota-ru-detail-nuxt-ssr',
        sourceUrl: listUrl,
        salary,
        area: locations[0],
        locations: locations.length > 0 ? locations : undefined,
        employment,
        schedule: detail.schedule,
        seniority: detail.seniority,
        skills: skills.length > 0 ? Array.from(new Set(skills)) : undefined,
        dateKnown: Boolean(publishedAt),
      },
    };
  }

  private detailVacancy(html: string, expectedId: string): RabotaDetailRecord {
    const objectText = this.nestedAfter(html, 'vacancy:{vacancy:', '{');
    if (!objectText) throw new Error(`Rabota.ru vacancy ${expectedId} has no public Nuxt detail state`);
    const id = this.numberProperty(objectText, 'id')?.toString();
    if (id !== expectedId) throw new Error(`Rabota.ru vacancy ${expectedId} detail payload id mismatch`);
    const rawDescription = this.stringProperty(objectText, 'description');
    const description = this.htmlToText(rawDescription ?? '', { preserveStructure: true });
    if (!description) throw new Error(`Rabota.ru vacancy ${expectedId} has no public detail description`);
    const salary = this.detailSalary(this.objectProperty(objectText, 'salary'));
    const company = this.stringProperty(this.objectProperty(objectText, 'company') ?? '', 'name');
    const schedule = this.stringProperty(this.objectProperty(objectText, 'operating_schedule') ?? '', 'name');
    const seniority = this.stringProperty(this.objectProperty(objectText, 'experience') ?? '', 'name');
    const employment = undefined;
    const rawPlaces = this.arrayProperty(objectText, 'places');
    const locations = this.detailLocations(rawPlaces);
    const rawSkills = this.arrayProperty(objectText, 'skills');
    const skills = this.namesFromArray(rawSkills);
    const rawState = this.omitUndefined({ id, title: this.stringProperty(objectText, 'title'), rawDescription, company, publish_start_at: this.stringProperty(objectText, 'publish_start_at'), salaryText: this.objectProperty(objectText, 'salary'), placesText: rawPlaces, skillsText: rawSkills });
    return {
      id,
      title: this.stringProperty(objectText, 'title'),
      description,
      rawDescription: rawDescription ?? '',
      companyOrClient: company,
      publishedAt: this.date(this.stringProperty(objectText, 'publish_start_at')),
      salary,
      locations,
      employment,
      schedule,
      seniority,
      skills,
      rawState,
    };
  }

  private detailSalary(value: string | undefined): Record<string, unknown> | undefined {
    if (!value) return undefined;
    const min = this.positiveNumber(this.numberProperty(value, 'from'));
    const max = this.positiveNumber(this.numberProperty(value, 'to'));
    const rawCurrency = this.stringProperty(value, 'currency');
    const currency = rawCurrency && /руб|rub/i.test(rawCurrency) ? 'RUB' : rawCurrency;
    const period = rawCurrency && /мес|month/i.test(rawCurrency) ? 'MONTH' : undefined;
    const originalText = this.salaryText(min, max, currency, period);
    const salary = this.omitUndefined({ min, max, currency, period, originalText });
    return Object.keys(salary).length > 0 ? salary : undefined;
  }

  private detailLocations(value: string | undefined): string[] {
    if (!value) return [];
    const locations: string[] = [];
    for (const item of this.topLevelObjects(value)) {
      const address = this.stringProperty(item, 'address');
      const placeName = this.stringProperty(item, 'name');
      const regionName = this.stringProperty(this.objectProperty(item, 'region') ?? '', 'name');
      const parts = [address, regionName && (!address || !address.toLowerCase().includes(regionName.toLowerCase())) ? regionName : undefined].filter(Boolean);
      const text = this.htmlToText(parts.join(', ') || placeName || '');
      if (text) locations.push(text);
    }
    return Array.from(new Set(locations));
  }

  private namesFromArray(value: string | undefined): string[] {
    if (!value) return [];
    return Array.from(new Set(this.topLevelObjects(value).map((item) => this.stringProperty(item, 'name')).filter((item): item is string => Boolean(item))));
  }

  private listUrls(source: { endpoint?: Record<string, unknown>; config?: Record<string, unknown> }): string[] {
    return this.configuredListUrls(source) || [DEFAULT_LIST_URL];
  }

  private configuredListUrls(source: { endpoint?: Record<string, unknown>; config?: Record<string, unknown> }): string[] | undefined {
    const configRaw = [source.config?.baseUrl, source.config?.listUrl, source.config?.baseUrls, source.config?.listUrls].flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
    const endpointListRaw = [source.endpoint?.listUrl, source.endpoint?.baseUrls, source.endpoint?.listUrls].flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
    const endpointBaseRaw = source.endpoint?.baseUrl ? [source.endpoint.baseUrl] : [];
    const endpointBaseUrls = endpointBaseRaw.map((value) => typeof value === 'string' ? this.safeUrl(value, DEFAULT_LIST_URL, 'list') : undefined).filter((value): value is string => Boolean(value));
    const onlyDefaultEndpointBase = configRaw.length === 0 && endpointListRaw.length === 0 && endpointBaseRaw.length === 1 && endpointBaseUrls.length === 1 && endpointBaseUrls[0] === DEFAULT_LIST_URL;
    const raw = onlyDefaultEndpointBase ? [] : [...configRaw, ...endpointListRaw, ...endpointBaseRaw];
    if (raw.length === 0) return undefined;
    const urls = Array.from(new Set(raw.map((value) => typeof value === 'string' ? this.safeUrl(value, DEFAULT_LIST_URL, 'list') : undefined).filter((value): value is string => Boolean(value))));
    return urls.length > 0 ? urls : undefined;
  }

  private async catalogPlan(ctx: FetchContext, continuing: boolean): Promise<RabotaCatalogPlan> {
    const checkpointCoverage = typeof ctx.checkpoint.coverage === 'string' ? ctx.checkpoint.coverage : undefined;
    if (continuing && checkpointCoverage === 'configured-list-urls-only') {
      const checkpointUrls = this.checkpointSourceUrls(ctx.checkpoint.sourceUrls);
      if (checkpointUrls.length > 0) return this.configuredPlan(checkpointUrls);
    }

    if (continuing && checkpointCoverage === 'all-public-regions-observed') {
      const checkpointCatalog = this.checkpointRegionCatalog(ctx.checkpoint.regionCatalog);
      if (!checkpointCatalog) throw new Error('Rabota.ru all-region continuation has no valid region catalog');
      const checkpointUrls = this.checkpointSourceUrls(ctx.checkpoint.sourceUrls);
      const canonicalUrls = checkpointCatalog.regions.map((region) => this.regionListUrl(region.domain));
      if (checkpointUrls.length !== canonicalUrls.length || checkpointUrls.some((url, index) => url !== canonicalUrls[index])) {
        throw new Error('Rabota.ru all-region continuation source URLs do not match the catalog');
      }
      return { sourceUrls: checkpointUrls, coverage: 'all-public-regions-observed', regionCatalog: checkpointCatalog, manual: false };
    }

    const configured = this.configuredListUrls(ctx.source);
    if (configured) return this.configuredPlan(configured);

    if (continuing) throw new Error('Rabota.ru continuation has no recognized coverage scope');

    const catalog = await this.fetchRegionCatalog(ctx);
    return { sourceUrls: catalog.regions.map((region) => this.regionListUrl(region.domain)), coverage: 'all-public-regions-observed', regionCatalog: catalog, manual: false };
  }

  private configuredPlan(sourceUrls: string[]): RabotaCatalogPlan {
    return {
      sourceUrls,
      manual: true,
      coverage: 'configured-list-urls-only',
      coverageLimitation: 'Manual Rabota.ru list URL override is configured; only those public /vacancy list URLs are collected.',
    };
  }

  private checkpointSourceUrls(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((item) => typeof item === 'string' ? this.safeUrl(item, DEFAULT_LIST_URL, 'list') : undefined).filter((item): item is string => Boolean(item))));
  }

  private checkpointRegionCatalog(value: unknown): { total: number; hash: string; regions: RabotaRegion[] } | undefined {
    if (value === undefined) return undefined;
    const record = this.recordValue(value);
    if (!record || !Array.isArray(record.regions)) throw new Error('Rabota.ru continuation region catalog is invalid');
    const hash = stringValue(record.hash);
    if (!hash) throw new Error('Rabota.ru continuation region catalog has no hash');
    const regions = this.validRegions(record.regions, this.numberValue(record.total) ?? record.regions.length);
    if (hash !== this.catalogHash(regions)) throw new Error('Rabota.ru continuation region catalog hash mismatch');
    return { total: regions.length, hash, regions };
  }

  private async fetchRegionCatalog(ctx: FetchContext): Promise<{ total: number; hash: string; regions: RabotaRegion[] }> {
    const request = { filter: { type_ids: [2], excluded_type_ids: [11] }, offset: 0, limit: MAX_REGION_CATALOG_REGIONS, fields: ['domain', 'id', 'name'] };
    const body = { request, request_id: this.catalogRequestId(ctx.requestId), application_id: 13 };
    const payload = await this.postRegionCatalog(REGION_CATALOG_URL, body, ctx);
    const regions = this.validRegions(this.catalogRegions(payload), this.catalogTotal(payload));
    return { total: regions.length, hash: this.catalogHash(regions), regions };
  }

  private async postRegionCatalog(url: string, body: Record<string, unknown>, ctx: FetchContext): Promise<Record<string, unknown>> {
    const timeoutSignal = AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', 'application-id': '13' },
      body: JSON.stringify(body),
      signal,
    });
    const text = await this.readLimitedResponse(response, 1_000_000);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Rabota.ru region catalog returned non-JSON HTTP ${response.status}`);
    }
    const record = this.recordValue(payload);
    if (response.ok && record) return record;
    if (url === REGION_CATALOG_URL && response.status === 404 && this.catalogEndpointNotFound(record)) return this.postRegionCatalog(REGION_CATALOG_FALLBACK_URL, body, ctx);
    throw new Error(`Rabota.ru region catalog failed with HTTP ${response.status}`);
  }

  private catalogEndpointNotFound(payload: Record<string, unknown> | undefined): boolean {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    return errors.some((error) => stringValue(this.recordValue(error)?.code) === 'ENDPOINT_NOT_FOUND');
  }

  private catalogRegions(payload: Record<string, unknown>): unknown[] {
    const response = this.recordValue(payload.response);
    const regions = response?.regions;
    if (!Array.isArray(regions)) throw new Error('Rabota.ru region catalog response has no regions array');
    return regions;
  }

  private catalogTotal(payload: Record<string, unknown>): number {
    const response = this.recordValue(payload.response);
    const total = this.numberValue(response?.total);
    if (typeof total !== 'number' || !Number.isInteger(total) || total <= 0) throw new Error('Rabota.ru region catalog response has no positive integer total');
    return total;
  }

  private async readLimitedResponse(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return response.text();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Rabota.ru region catalog response is too large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private validRegions(values: unknown[], total: number): RabotaRegion[] {
    if (total !== values.length) throw new Error(`Rabota.ru region catalog total ${total} does not match ${values.length} regions`);
    if (values.length === 0 || values.length > MAX_REGION_CATALOG_REGIONS) throw new Error(`Rabota.ru region catalog size ${values.length} is outside expected bounds`);
    const ids = new Set<number>();
    const domains = new Set<string>();
    const regions = values.map((value) => {
      const record = this.recordValue(value);
      const id = this.numberValue(record?.id);
      const name = stringValue(record?.name);
      const domain = stringValue(record?.domain);
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0 || !name || !domain) throw new Error('Rabota.ru region catalog has an incomplete region entry');
      if (!/^(?:www|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.test(domain)) throw new Error(`Rabota.ru region catalog has an unsafe domain: ${domain}`);
      if (ids.has(id)) throw new Error(`Rabota.ru region catalog has duplicate id: ${id}`);
      if (domains.has(domain)) throw new Error(`Rabota.ru region catalog has duplicate domain: ${domain}`);
      ids.add(id);
      domains.add(domain);
      return { id, name, domain };
    });
    return regions;
  }

  private regionListUrl(domain: string): string {
    return domain === 'www' ? DEFAULT_LIST_URL : `https://${domain}.rabota.ru/vacancy/?sort=date`;
  }

  private regionForUrl(regions: RabotaRegion[] | undefined, url: string | undefined): RabotaRegion | undefined {
    if (!regions || !url) return undefined;
    const exact = regions.find((region) => this.regionListUrl(region.domain) === url);
    if (exact) return exact;
    try {
      const parsed = new URL(url);
      if (!/^\/vacancy\/?$/.test(parsed.pathname)) return undefined;
      return regions.find((region) => new URL(this.regionListUrl(region.domain)).origin === parsed.origin);
    } catch {
      return undefined;
    }
  }

  private catalogHash(regions: RabotaRegion[]): string {
    return createHash('sha256').update(JSON.stringify(regions)).digest('hex');
  }

  private catalogRequestId(value: string): number {
    const hash = createHash('sha256').update(value || 'rabota-regions').digest();
    return 1_000_000 + hash.readUInt32BE(0) % 99_000_000;
  }

  private jobPostings(html: string): JobPosting[] {
    const postings: JobPosting[] = [];
    const $ = load(html);
    $('script[type="application/ld+json"]').each((_index, element) => {
      const text = $(element).text().trim();
      if (!text) return;
      try {
        for (const candidate of this.jsonLdCandidates(JSON.parse(text))) {
          if (this.hasSchemaType(candidate, 'JobPosting') && stringValue(candidate.url)) postings.push(candidate);
        }
      } catch {
        return;
      }
    });
    const seen = new Set<string>();
    return postings.filter((posting) => {
      const key = stringValue(posting.url);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private jsonLdCandidates(value: unknown): JobPosting[] {
    if (Array.isArray(value)) return value.flatMap((item) => this.jsonLdCandidates(item));
    if (!value || typeof value !== 'object') return [];
    const record = value as JobPosting;
    const graph = record['@graph'];
    return [record, ...(Array.isArray(graph) ? graph.flatMap((item) => this.jsonLdCandidates(item)) : [])];
  }

  private hasSchemaType(value: JobPosting, type: string): boolean {
    const schemaType = value['@type'];
    return Array.isArray(schemaType) ? schemaType.includes(type) : schemaType === type;
  }

  private nextListUrl(html: string, finalUrl: string): string | undefined {
    const $ = load(html);
    const relNext = $('link[rel="next"]').first().attr('href') ?? $('a[rel="next"]').first().attr('href');
    return this.safeUrl(relNext, finalUrl, 'list');
  }

  private safeUrl(value: string | undefined, from: string, kind: 'list' | 'detail'): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, from);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
      const host = url.hostname.toLowerCase();
      if (host !== 'rabota.ru' && !host.endsWith('.rabota.ru')) return undefined;
      if (kind === 'detail') {
        if (!/^\/vacancy\/\d+\/?$/.test(url.pathname) || url.search) return undefined;
      } else {
        if (!/^\/vacancy\/?$/.test(url.pathname)) return undefined;
        for (const key of url.searchParams.keys()) if (!['page', 'sort'].includes(key)) return undefined;
        if (url.searchParams.has('page') && !/^[1-9]\d*$/.test(url.searchParams.get('page')!)) return undefined;
        if (url.searchParams.has('sort') && !/^(?:date|relevance)$/.test(url.searchParams.get('sort')!)) return undefined;
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

  private salary(value: unknown): Record<string, unknown> | undefined {
    const record = this.recordValue(value);
    if (!record) return undefined;
    const nested = this.recordValue(record.value);
    const currency = stringValue(record.currency);
    const min = this.positiveNumber(record.minValue) ?? this.positiveNumber(nested?.minValue) ?? this.positiveNumber(nested?.value) ?? this.positiveNumber(record.value);
    const max = this.positiveNumber(record.maxValue) ?? this.positiveNumber(nested?.maxValue);
    const period = stringValue(nested?.unitText) ?? stringValue(record.unitText);
    const originalText = this.salaryText(min, max, currency, period);
    const salary = this.omitUndefined({ min, max, currency, period, originalText });
    return Object.keys(salary).length > 0 ? salary : undefined;
  }

  private salaryText(min?: number, max?: number, currency?: string, period?: string): string | undefined {
    const amounts = [min, max].filter((value, index, array): value is number => typeof value === 'number' && array.indexOf(value) === index);
    if (amounts.length === 0) return undefined;
    const amount = amounts.length === 2 ? `${amounts[0]} – ${amounts[1]}` : amounts[0].toString();
    return [amount, currency, period].filter(Boolean).join(' ') || undefined;
  }

  private locations(value: unknown): string[] {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return Array.from(new Set(values.flatMap((item) => {
      const place = this.recordValue(item);
      const address = this.recordValue(place?.address);
      const parts = [address?.addressLocality, address?.addressRegion, address?.streetAddress, address?.addressCountry]
        .map((part) => stringValue(typeof part === 'object' ? this.recordValue(part)?.name : part))
        .filter((part): part is string => Boolean(part));
      const direct = stringValue(place?.name) ?? stringValue(place?.address);
      return this.htmlToText(parts.join(', ') || direct || '') ? [this.htmlToText(parts.join(', ') || direct || '')] : [];
    })));
  }

  private organization(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    return stringValue(this.recordValue(value)?.name);
  }

  private htmlToText(value: string, options: { preserveStructure?: boolean } = {}): string {
    if (!options.preserveStructure) {
      return load(value.replace(/<br\s*\/?\s*>/gi, '\n')).text().replace(/\u00a0/g, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n+ */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    const $ = load(value, null, false);
    $('script,style').remove();
    $('br').replaceWith('\n');
    $('li').each((_index, element) => {
      $(element).prepend('\n');
      $(element).append('\n');
    });
    $('p,div,section,article,header,footer,h1,h2,h3,h4,h5,h6,ul,ol,table,tr,blockquote').each((_index, element) => {
      $(element).prepend('\n');
      $(element).append('\n');
    });
    return $.root().text()
      .replace(/\u00a0/g, ' ')
      .split(/\n+/)
      .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  private joinStrings(value: unknown): string | undefined {
    const values = this.stringList(value);
    return values.length > 0 ? values.join(', ') : undefined;
  }


  private nestedAfter(source: string, marker: string, opener: '{' | '['): string | undefined {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return undefined;
    const start = source.indexOf(opener, markerIndex + marker.length - 1);
    return start >= 0 ? this.readNested(source, start) : undefined;
  }

  private objectProperty(source: string, key: string): string | undefined {
    const start = this.propertyValueIndex(source, key);
    if (start === undefined || source[start] !== '{') return undefined;
    return this.readNested(source, start);
  }

  private arrayProperty(source: string, key: string): string | undefined {
    const start = this.propertyValueIndex(source, key);
    if (start === undefined || source[start] !== '[') return undefined;
    return this.readNested(source, start);
  }

  private stringProperty(source: string, key: string): string | undefined {
    const start = this.propertyValueIndex(source, key);
    if (start === undefined || source[start] !== '"') return undefined;
    const parsed = this.readString(source, start);
    return parsed ? parsed.value : undefined;
  }

  private numberProperty(source: string, key: string): number | undefined {
    const start = this.propertyValueIndex(source, key);
    if (start === undefined) return undefined;
    const match = /^-?\d+(?:\.\d+)?/.exec(source.slice(start));
    return match ? Number(match[0]) : undefined;
  }

  private propertyValueIndex(source: string, key: string): number | undefined {
    let depth = 0;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (char === '"') {
        const parsed = this.readString(source, index);
        if (!parsed) return undefined;
        if (depth === 1) {
          let cursor = parsed.end + 1;
          while (/\s/.test(source[cursor] ?? '')) cursor += 1;
          if (source[cursor] === ':' && parsed.value === key) return this.valueStart(source, cursor + 1);
        }
        index = parsed.end;
        continue;
      }
      if (char === '{' || char === '[') {
        depth += 1;
        continue;
      }
      if (char === '}' || char === ']') {
        depth -= 1;
        continue;
      }
      if (depth !== 1 || !/[A-Za-z_$]/.test(char)) continue;
      const start = index;
      while (/[A-Za-z0-9_$]/.test(source[index + 1] ?? '')) index += 1;
      const name = source.slice(start, index + 1);
      let cursor = index + 1;
      while (/\s/.test(source[cursor] ?? '')) cursor += 1;
      if (source[cursor] === ':' && name === key) return this.valueStart(source, cursor + 1);
    }
    return undefined;
  }

  private valueStart(source: string, start: number): number {
    let index = start;
    while (/\s/.test(source[index] ?? '')) index += 1;
    return index;
  }

  private readNested(source: string, start: number): string | undefined {
    const opener = source[start];
    const closer = opener === '{' ? '}' : opener === '[' ? ']' : undefined;
    if (!closer) return undefined;
    let depth = 0;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === '"') {
        const parsed = this.readString(source, index);
        if (!parsed) return undefined;
        index = parsed.end;
        continue;
      }
      if (char === opener) depth += 1;
      if (char === closer) {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    return undefined;
  }

  private readString(source: string, start: number): { value: string; end: number } | undefined {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] === '"') {
        const literal = source.slice(start, index + 1);
        try {
          return { value: JSON.parse(literal) as string, end: index };
        } catch {
          return undefined;
        }
      }
      index += 1;
    }
    return undefined;
  }

  private topLevelObjects(arrayText: string): string[] {
    const objects: string[] = [];
    let depth = 0;
    for (let index = 0; index < arrayText.length; index += 1) {
      const char = arrayText[index];
      if (char === '"') {
        const parsed = this.readString(arrayText, index);
        if (!parsed) break;
        index = parsed.end;
        continue;
      }
      if (char === '[') {
        depth += 1;
        continue;
      }
      if (char === ']') {
        depth -= 1;
        continue;
      }
      if (char !== '{' || depth !== 1) continue;
      const object = this.readNested(arrayText, index);
      if (!object) break;
      objects.push(object);
      index += object.length - 1;
    }
    return objects;
  }

  private stringList(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => this.stringList(item));
    const text = stringValue(value);
    if (!text) return [];
    return text.split(/[,;]+/).map((item) => item.trim()).filter(Boolean);
  }

  private date(value?: string): Date | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private positiveNumber(value: unknown): number | undefined {
    const number = this.numberValue(value);
    return number && number > 0 ? number : undefined;
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  }

  private omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
  }
}
