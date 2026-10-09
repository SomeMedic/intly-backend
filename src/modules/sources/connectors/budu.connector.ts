import { fetch as undiciFetch } from 'undici';

import { WebExtractionHttpError, WebExtractionService } from '../extraction/web-extraction.service';
import { createPinnedDispatcher } from '../extraction/pinned-fetch';
import { parseHttpUrl } from '../extraction/url-safety';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { stringValue } from './connector-utils';

const ORIGIN = 'https://budu.jobs';
const VACANCIES_URL = `${ORIGIN}/vacancies`;
const MAX_HTML_BYTES = 2_000_000;
const DETAIL_CONCURRENCY = 4;
const DETAIL_BATCH_SIZE = 10;
const MAX_BACKFILL_DAYS = 30;
const SEARCH_MUTATION = 'app.model.feed.vacancies/search!';
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VACANCY_PATH_RE = new RegExp(`^/vacancy/(${UUID_RE})/?$`, 'i');

export type BuduResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
};

type BuduFetchRequest = {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
};

export type BuduFetcher = (url: string, ctx: FetchContext | ConnectorContext, request?: BuduFetchRequest) => Promise<BuduResponse>;

type BuduCard = {
  id: string;
  url: string;
  company?: string;
  title: string;
  description?: string;
  salaryText?: string;
  locationText?: string;
  rawHtml: string;
};

type BuduHtmlResponse = {
  html: string;
  cookie?: string;
};

type BuduNativeSearch = {
  records: BuduNativeVacancy[];
  meta: BuduNativePageMeta;
  filters: BuduNativeFilters;
  csrfToken?: string;
  cookie?: string;
};

type BuduNativeFilters = {
  query: string;
  startupsOnly: boolean;
  remote: boolean;
  cities: string[];
  specializations: string[];
};

type BuduNativePageMeta = {
  size?: number;
  current?: number;
  totalPages?: number;
  totalResults?: number;
};

type BuduNativeVacancy = {
  id: string;
  title: string;
  url: string;
  company?: string;
  summary?: string;
  remote?: boolean;
  geo?: string;
  city?: unknown;
  skills?: string[];
  specializations?: unknown[];
  salary?: unknown;
  companyId?: string;
  companyLogoUrl?: string;
  raw: Record<string, unknown>;
  page: number;
};

const BUDU_NATIVE_VACANCY_CARD_QUERY = [
  'vacancy/id',
  'vacancy/title',
  'vacancy/summary',
  { '>/specialization+skill-tags': [
    'vacancy/id',
    'vacancy.wip/id',
    { 'vacancy/specializations*': ['specialization/id', 'specialization/name', 'specialization/skills'] },
    'vacancy/skills',
  ] },
  'vacancy/salary',
  { 'vacancy/city': ['city.algolia/id', 'city.algolia/name', 'city.algolia/country'] },
  'vacancy/remote?',
  'vacancy/geo',
  'vacancy/url',
  'company/id',
  'company/logo-url',
  'company/name',
] as const;

const BUDU_NATIVE_SEARCH_RESULT_QUERY = [
  'vacancy/id',
  { '>/vacancy': BUDU_NATIVE_VACANCY_CARD_QUERY },
] as const;

const BUDU_NATIVE_RETURN_QUERY = {
  component: 'app.ui.feed.vacancies/SearchResultsQuery',
  resultIdent: ['vacancy/id'],
  resultComponent: 'app.ui.feed.vacancies/SearchResult',
  vacancyCardComponent: 'app.ui.hr.vacancy-card/VacancyCard',
  query: [
    { results: BUDU_NATIVE_SEARCH_RESULT_QUERY },
    'meta',
    'specializations-facet',
    'cities-facet',
  ],
};

export class BuduConnector implements Connector {
  readonly id = 'budu';
  readonly family = 'PublicHtml' as const;

  constructor(
    private readonly fetcher: BuduFetcher = fetchBudu,
    private readonly webExtraction?: WebExtractionService,
  ) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    try {
      this.assertConfig(config);
      return { ok: true, message: 'Budu public vacancies page configured', details: { url: VACANCIES_URL } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Budu source is not configured' };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const { html, cookie } = await this.fetchHtml(VACANCIES_URL, { ...ctx, checkpoint: {}, backfillDays: 1 });
      const native = this.nativeFromHtml(html, cookie);
      if (native) {
        return { state: native.records.length > 0 ? 'Healthy' : 'Failed', message: `Budu native bootstrap returned ${native.records.length} vacancies`, checkedAt: new Date(), details: { records: native.records.length, totalResults: native.meta.totalResults } };
      }
      const cards = this.cards(html);
      return { state: cards.length > 0 ? 'Healthy' : 'Failed', message: `Budu SSR returned ${cards.length} unique vacancy cards`, checkedAt: new Date(), details: { cards: cards.length } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Budu health failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    this.assertConfig({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) });
    if (ctx.checkpoint.mode === 'native_fulcro_transit_detail_batches' && ctx.checkpoint.hasMore === true) {
      return this.detailBatch(ctx);
    }
    const { html, cookie } = await this.fetchHtml(VACANCIES_URL, ctx);
    const native = this.nativeFromHtml(html, cookie);
    if (!native) return this.ssrFallback(html, ctx, 'Budu native INITIAL_APP_STATE was not available or did not match the public vacancies contract');
    assertPageMeta(native.meta, 1);
    const windowBounds = this.windowBounds(ctx);
    const collected = new Map<string, BuduNativeVacancy>();
    const seenPages = new Set<number>();
    const seenIdsByPage: Record<string, number> = {};
    const addNative = (page: BuduNativeSearch) => {
      const current = page.meta.current ?? native.meta.current ?? 1;
      if (seenPages.has(current)) throw new Error(`Budu native pagination returned duplicate page ${current}`);
      seenPages.add(current);
      for (const record of page.records) {
        seenIdsByPage[record.id] = (seenIdsByPage[record.id] ?? 0) + 1;
        if (!collected.has(record.id)) collected.set(record.id, { ...record, page: current });
      }
    };
    addNative(native);

    let current = native.meta.current ?? 1;
    const totalPages = native.meta.totalPages ?? current;
    while (current < totalPages) {
      throwIfAborted(ctx.signal);
      const nextPage = current + 1;
      const response = await this.fetchNativePage(nextPage, native, ctx);
      if (response.meta.size !== native.meta.size || response.meta.totalPages !== native.meta.totalPages || response.meta.totalResults !== native.meta.totalResults) {
        throw new Error(`Budu native catalogue metadata changed during collection at page ${nextPage}`);
      }
      const sizeBefore = collected.size;
      addNative(response);
      if (collected.size === sizeBefore && nextPage < totalPages) throw new Error(`Budu native pagination page ${nextPage} returned only duplicate vacancies before terminal page`);
      current = response.meta.current ?? nextPage;
    }
    if (collected.size !== native.meta.totalResults) throw new Error(`Budu native catalogue returned ${collected.size} unique vacancies instead of ${native.meta.totalResults}`);

    const catalog = [...collected.values()];
    const checkpoint = {
      lastFetchedAt: new Date().toISOString(),
      sourceUrl: VACANCIES_URL,
      mode: this.webExtraction ? 'native_fulcro_transit_detail_batches' : 'native_fulcro_transit',
      mutation: SEARCH_MUTATION,
      nativeReturnQuery: BUDU_NATIVE_RETURN_QUERY,
      ...windowBounds,
      pageSize: native.meta.size,
      currentPage: current,
      totalPages: native.meta.totalPages,
      totalResults: native.meta.totalResults,
      nativeSeen: Object.values(seenIdsByPage).reduce((sum, count) => sum + count, 0),
      duplicateIds: Object.entries(seenIdsByPage).filter(([, count]) => count > 1).map(([id]) => id),
      nativeCatalog: this.webExtraction ? catalog.map(record => ({ id: record.id, raw: record.raw, page: record.page })) : undefined,
      detailCursor: 0,
      seen: 0,
      retained: 0,
      unavailableDetailIds: [],
      hasMore: Boolean(this.webExtraction),
    };
    if (this.webExtraction) return this.detailBatch({ ...ctx, checkpoint });
    const records = catalog.map(record => this.nativeRecord(record, windowBounds));
    return { records, hasMore: false, checkpoint: { ...checkpoint, seen: checkpoint.nativeSeen, retained: records.length, terminalReason: 'page_metadata_exhausted' }, stats: { seen: checkpoint.nativeSeen } };
  }

  private async detailBatch(ctx: FetchContext): Promise<FetchPage> {
    const saved = ctx.checkpoint;
    if (saved.sourceUrl !== VACANCIES_URL || !Array.isArray(saved.nativeCatalog) || saved.nativeCatalog.length !== saved.totalResults || !Number.isInteger(saved.detailCursor)) {
      throw new Error('Budu continuation is missing its frozen native catalogue or detail cursor');
    }
    const cursor = saved.detailCursor as number;
    if (cursor < 0 || cursor >= saved.nativeCatalog.length || !Number.isInteger(saved.retained) || (saved.retained as number) < 0 || (saved.retained as number) > cursor) {
      throw new Error('Budu continuation has inconsistent detail progress');
    }
    const lower = typeof saved.backfillSince === 'string' ? Date.parse(saved.backfillSince) : NaN;
    const upper = typeof saved.windowUntil === 'string' ? Date.parse(saved.windowUntil) : NaN;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper || (ctx.backfillSince && Date.parse(ctx.backfillSince) !== lower)) {
      throw new Error('Budu continuation does not match its frozen publication window');
    }
    const catalog = saved.nativeCatalog.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Budu continuation has an invalid native card');
      const entry = value as Record<string, unknown>;
      if (typeof entry.id !== 'string' || !entry.raw || typeof entry.raw !== 'object' || Array.isArray(entry.raw) || !Number.isInteger(entry.page) || (entry.page as number) < 1 || (entry.page as number) > (saved.totalPages as number)) throw new Error('Budu continuation has an invalid native card');
      const record = this.nativeVacancyRecord(entry.id, entry.raw as Record<string, unknown>, entry.page as number);
      if (!record) throw new Error('Budu continuation has an invalid native vacancy identity');
      return record;
    });
    if (new Set(catalog.map(record => record.id)).size !== catalog.length) throw new Error('Budu continuation repeats a native vacancy');
    const processed = new Set(catalog.slice(0, cursor).map(record => record.id));
    if (!Array.isArray(saved.unavailableDetailIds) || saved.unavailableDetailIds.some(id => typeof id !== 'string' || !processed.has(id))) throw new Error('Budu continuation has inconsistent unavailable detail IDs');
    const unavailableDetailIds = [...saved.unavailableDetailIds] as string[];
    const bounds = { backfillSince: saved.backfillSince as string, windowUntil: saved.windowUntil as string };
    const batch = catalog.slice(cursor, cursor + DETAIL_BATCH_SIZE);
    const records = await this.enrichedNativeRecords(batch, ctx, bounds, unavailableDetailIds);
    const detailCursor = cursor + batch.length;
    const hasMore = detailCursor < catalog.length;
    return {
      records,
      hasMore,
      nextPage: hasMore ? Math.floor(detailCursor / DETAIL_BATCH_SIZE) + 1 : undefined,
      stats: { seen: batch.length },
      checkpoint: {
        ...saved,
        lastFetchedAt: new Date().toISOString(),
        detailCursor,
        seen: detailCursor,
        retained: (saved.retained as number) + records.length,
        unavailableDetailIds: catalog.filter(record => unavailableDetailIds.includes(record.id)).map(record => record.id),
        unavailableDetailStatus: unavailableDetailIds.length ? 404 : undefined,
        hasMore,
        terminalReason: hasMore ? 'detail_batches_pending' : 'page_metadata_exhausted',
      },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private async ssrFallback(html: string, ctx: FetchContext, limitation: string): Promise<FetchPage> {
    const cards = this.cards(html);
    if (cards.length === 0) throw new Error('Budu public vacancies page returned no native vacancies and no SSR vacancy cards');
    const remainingHint = this.remainingHint(html);
    const unavailableDetailIds: string[] = [];
    const records = this.webExtraction
      ? await this.enrichedRecords(cards, ctx, unavailableDetailIds)
      : cards.map((card) => this.cardRecord(card));
    return {
      records,
      hasMore: false,
      checkpoint: {
        lastFetchedAt: new Date().toISOString(),
        sourceUrl: VACANCIES_URL,
        mode: 'ssr_initial_page_fallback',
        seen: cards.length,
        retained: records.length,
        remainingHint,
        unavailableDetailIds,
        incomplete: true,
        terminalReason: 'native_contract_unavailable',
        limitation,
      },
      stats: { seen: cards.length },
    };
  }

  private async fetchHtml(url: string, ctx: FetchContext | ConnectorContext): Promise<BuduHtmlResponse> {
    let response: BuduResponse;
    try {
      response = await this.fetcher(url, ctx, { method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml' } });
    } catch (error) {
      throw annotateBuduFetchError(error);
    }
    if (!response.ok) throw new Error(`Budu public page returned ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/\btext\/html\b/i.test(contentType)) throw new Error(`Budu public page returned unsupported content type ${contentType || 'unknown'}`);
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('Budu public page is larger than the v1 safety limit');
    if (!/<html\b/i.test(html) || !/\/vacancy\//i.test(html)) throw new Error('Budu public page did not contain vacancy HTML');
    return { html, cookie: cookieHeaderFromSetCookie(response.headers.get('set-cookie')) };
  }

  private async fetchNativePage(page: number, bootstrap: BuduNativeSearch, ctx: FetchContext): Promise<BuduNativeSearch> {
    const body = this.nativeSearchBody(page, bootstrap.filters);
    let response: BuduResponse;
    try {
      response = await this.fetcher(`${ORIGIN}/api`, ctx, {
        method: 'POST',
        body,
        headers: {
          Accept: 'application/transit+json',
          'Content-Type': 'application/transit+json',
          'X-CSRF-Token': bootstrap.csrfToken ?? '',
          ...(bootstrap.cookie ? { Cookie: bootstrap.cookie } : {}),
        },
      });
    } catch (error) {
      throw annotateBuduFetchError(error);
    }
    if (!response.ok) throw new Error(`Budu native API returned ${response.status} for page ${page}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/\bapplication\/transit\+json\b/i.test(contentType) && !/\bapplication\/json\b/i.test(contentType)) {
      throw new Error(`Budu native API returned unsupported content type ${contentType || 'unknown'}`);
    }
    const text = await response.text();
    const native = this.nativeFromTransit(text, page, bootstrap.filters);
    if (!native) throw new Error(`Budu native API page ${page} did not match SearchResultsQuery response contract`);
    assertPageMeta(native.meta, page);
    return native;
  }

  private nativeSearchBody(page: number, filters: BuduNativeFilters): string {
    // EQL mutation joins have a list key; Transit represents composite map keys with cmap.
    return JSON.stringify([
      ['~#cmap', [
        ['~#list', [
          `~$${SEARCH_MUTATION}`,
          ['^ ',
            '~:ui/query', filters.query,
            '~:ui/startups-only?', filters.startupsOnly,
            '~:ui/remote?', filters.remote,
            '~:ui/cities', ['~#set', filters.cities],
            '~:ui/specializations', ['~#set', filters.specializations],
            '~:page', page,
          ],
        ]],
        this.nativeSearchResultsQuery(),
      ]],
    ]);
  }

  private nativeSearchResultsQuery(): unknown[] {
    return transitQuery(BUDU_NATIVE_RETURN_QUERY.query) as unknown[];
  }

  private nativeFromHtml(html: string, cookie?: string): BuduNativeSearch | null {
    const encoded = /window\.INITIAL_APP_STATE\s*=\s*'([^']+)'/.exec(html)?.[1];
    if (!encoded) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      return null;
    }
    const native = this.nativeFromBootstrapTransit(decoded, 1);
    if (!native) return null;
    const csrfToken = /fulcro_network_csrf_token\s*=\s*'([^']+)'/.exec(html)?.[1];
    return { ...native, csrfToken, cookie };
  }

  private nativeFromTransit(text: string, expectedPage: number, fallbackFilters?: BuduNativeFilters): BuduNativeSearch | null {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    return this.nativeFromApiValue(decodeTransitCache(value), expectedPage, fallbackFilters);
  }

  private nativeFromBootstrapTransit(text: string, expectedPage: number): BuduNativeSearch | null {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    const maps = transitLikeMaps(decodeTransitCache(value));
    const search = maps.find((entry) => Array.isArray(entry.map['ui/results']) && entry.map['ui/meta']);
    if (!search) return null;
    const meta = pageMeta(search.map['ui/meta']);
    const resultIds = (search.map['ui/results'] as unknown[])
      .map((item) => vacancyIdFromIdent(item))
      .filter((id): id is string => Boolean(id));
    const vacancyById = new Map<string, Record<string, unknown>>();
    for (const entry of maps) {
      const id = stringValue(entry.map['vacancy/id'] ?? entry.key);
      const title = stringValue(entry.map['vacancy/title']);
      const url = stringValue(entry.map['vacancy/url']);
      if (id && title && url) vacancyById.set(id.toLowerCase(), entry.map);
    }
    const page = meta.current ?? expectedPage;
    const records: BuduNativeVacancy[] = [];
    for (const id of resultIds) {
      const raw = vacancyById.get(id.toLowerCase());
      if (!raw) continue;
      const record = this.nativeVacancyRecord(id, raw, page);
      if (record) records.push(record);
    }
    if (records.length === 0) return null;
    return {
      records,
      meta,
      filters: {
        query: stringValue(search.map['ui/query']) ?? '',
        startupsOnly: typeof search.map['ui/startups-only?'] === 'boolean' ? search.map['ui/startups-only?'] as boolean : false,
        remote: typeof search.map['ui/remote?'] === 'boolean' ? search.map['ui/remote?'] as boolean : false,
        cities: stringArray(search.map['ui/cities']) ?? [],
        specializations: stringArray(search.map['ui/specializations']) ?? [],
      },
    };
  }

  private nativeFromApiValue(value: unknown, expectedPage: number, fallbackFilters?: BuduNativeFilters): BuduNativeSearch | null {
    const root = normalizeBuduNativeValue(value);
    if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
    const search = (root as Record<string, unknown>)[SEARCH_MUTATION];
    if (!search || typeof search !== 'object' || Array.isArray(search)) return null;
    const payload = search as Record<string, unknown>;
    if (!Array.isArray(payload.results) || !payload.meta) return null;
    const meta = pageMeta(payload.meta);
    const page = meta.current ?? expectedPage;
    const records = payload.results
      .map((item) => this.nativeSearchResultRecord(item, page))
      .filter((record): record is BuduNativeVacancy => Boolean(record));
    if (records.length === 0) return null;
    return {
      records,
      meta,
      filters: fallbackFilters ?? {
        query: '',
        startupsOnly: false,
        remote: false,
        cities: [],
        specializations: [],
      },
    };
  }

  private nativeSearchResultRecord(value: unknown, page: number): BuduNativeVacancy | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = value as Record<string, unknown>;
    const id = stringValue(result['vacancy/id']);
    const joined = result['>/vacancy'];
    const raw = joined && typeof joined === 'object' && !Array.isArray(joined)
      ? joined as Record<string, unknown>
      : result;
    return this.nativeVacancyRecord(id ?? stringValue(raw['vacancy/id']), raw, page);
  }

  private nativeVacancyRecord(idValue: string | undefined, raw: Record<string, unknown>, page: number): BuduNativeVacancy | null {
    const id = idValue?.toLowerCase();
    if (!id || !new RegExp(`^${UUID_RE}$`, 'i').test(id)) return null;
    const url = stringValue(raw['vacancy/url']);
    const title = stringValue(raw['vacancy/title']);
    if (!url || !title) return null;
    const nativeUrl = this.vacancyUrl(url);
    const joinedId = stringValue(raw['vacancy/id'])?.toLowerCase();
    if ((joinedId && joinedId !== id) || !new URL(nativeUrl).pathname.toLowerCase().includes(`/vacancy/${id}`)) {
      throw new Error('Budu native result identity does not match its vacancy card and URL');
    }
    const tags = raw['>/specialization+skill-tags'];
    const tagFields = tags && typeof tags === 'object' && !Array.isArray(tags) ? tags as Record<string, unknown> : raw;
    return {
      id,
      title,
      url: nativeUrl,
      company: stringValue(raw['company/name']),
      summary: stringValue(raw['vacancy/summary']),
      remote: typeof raw['vacancy/remote?'] === 'boolean' ? raw['vacancy/remote?'] as boolean : undefined,
      geo: stringValue(raw['vacancy/geo']),
      city: raw['vacancy/city'],
      skills: stringArray(tagFields['vacancy/skills']),
      specializations: Array.isArray(tagFields['vacancy/specializations*']) ? tagFields['vacancy/specializations*'] as unknown[] : undefined,
      salary: raw['vacancy/salary'],
      companyId: stringValue(raw['company/id']),
      companyLogoUrl: stringValue(raw['company/logo-url']),
      raw,
      page,
    };
  }

  private nativeRecord(record: BuduNativeVacancy, windowBounds: { backfillSince: string; windowUntil: string }): RawOpportunityRecord {
    return {
      externalId: record.id,
      url: record.url,
      type: 'vacancy',
      title: record.title,
      companyOrClient: record.company,
      description: record.summary,
      sourceStatus: 'Unknown',
      rawPayload: {
        native: record.raw,
        sourceUrl: VACANCIES_URL,
        page: record.page,
      },
      sourceMetadata: {
        extraction: 'budu-native-fulcro-transit',
        sourceUrl: VACANCIES_URL,
        coverage: 'native-public-search',
        descriptionCoverage: record.summary ? 'native-summary' : undefined,
        nativeReturnQuery: BUDU_NATIVE_RETURN_QUERY,
        page: record.page,
        companyId: record.companyId,
        companyLogoUrl: record.companyLogoUrl,
        nativeSalary: record.salary,
        salary: this.nativeSalary(record.salary),
        area: stringValue(record.city && typeof record.city === 'object' ? (record.city as Record<string, unknown>)['city.algolia/name'] : undefined) ?? record.geo,
        schedule: record.remote === true ? 'Remote' : undefined,
        locationText: record.geo,
        city: record.city,
        remote: record.remote,
        skills: record.skills,
        specializations: record.specializations,
        dateKnown: false,
        backfillSince: windowBounds.backfillSince,
        windowUntil: windowBounds.windowUntil,
      },
    };
  }


  private async enrichedNativeRecords(records: BuduNativeVacancy[], ctx: FetchContext, windowBounds: { backfillSince: string; windowUntil: string }, unavailableDetailIds: string[]): Promise<RawOpportunityRecord[]> {
    const enriched = await mapWithConcurrency(records, DETAIL_CONCURRENCY, async (record): Promise<RawOpportunityRecord | null> => {
      throwIfAborted(ctx.signal);
      const detail = await this.fetchDetail(record.url, ctx);
      if (!detail) { unavailableDetailIds.push(record.id); return null; }
      throwIfAborted(ctx.signal);
      this.assertDetailMatchesNative(record, detail.url);
      if (detail.publishedAt && (detail.publishedAt < new Date(windowBounds.backfillSince) || detail.publishedAt > new Date(windowBounds.windowUntil))) return null;
      const native = this.nativeRecord(record, windowBounds);
      return {
        ...detail,
        externalId: record.id,
        url: detail.url || record.url,
        type: 'vacancy',
        title: record.title || detail.title,
        companyOrClient: record.company || detail.companyOrClient,
        description: detail.description || record.summary,
        rawPayload: {
          native: record.raw,
          detail: detail.rawPayload,
          sourceUrl: VACANCIES_URL,
          page: record.page,
        },
        sourceMetadata: {
          ...detail.sourceMetadata,
          ...native.sourceMetadata,
          salary: detail.sourceMetadata.salary ?? native.sourceMetadata.salary,
          area: detail.sourceMetadata.area ?? native.sourceMetadata.area,
          schedule: detail.sourceMetadata.schedule ?? native.sourceMetadata.schedule,
          skills: Array.from(new Set([...(record.skills ?? []), ...(Array.isArray(detail.sourceMetadata.skills) ? detail.sourceMetadata.skills.filter((value): value is string => typeof value === 'string') : [])])),
          sourceUrl: VACANCIES_URL,
          detailUrl: detail.url,
          extraction: 'budu-native-fulcro-transit',
          coverage: 'native-public-search-detail-enriched',
          descriptionCoverage: detail.description ? 'detail-full' : native.sourceMetadata.descriptionCoverage,
          dateKnown: Boolean(detail.publishedAt),
        },
      };
    });
    return enriched.filter((record): record is RawOpportunityRecord => Boolean(record));
  }

  private cards(html: string): BuduCard[] {
    const cards: BuduCard[] = [];
    const seen = new Set<string>();
    const anchorRe = new RegExp(`<a\\b([^>]*?)href=["'](https://budu\\.jobs/vacancy/(${UUID_RE})/?|/vacancy/(${UUID_RE})/?)["']([^>]*)>([\\s\\S]*?)</a>`, 'gi');
    for (const match of html.matchAll(anchorRe)) {
      const href = match[2];
      const id = (match[3] ?? match[4]).toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      const rawHtml = match[6] ?? '';
      const textParts = this.cardTextParts(rawHtml);
      const company = textParts[0];
      const title = textParts[1];
      if (!title) throw new Error(`Budu vacancy card ${id} is missing title`);
      const metaParts = this.cardMetaParts(rawHtml);
      cards.push({
        id,
        url: this.vacancyUrl(href),
        company,
        title,
        description: textParts[2],
        salaryText: metaParts[0],
        locationText: metaParts[1],
        rawHtml,
      });
    }
    return cards;
  }

  private cardTextParts(html: string): string[] {
    return [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>|<div\b[^>]*class=["'][^"']*text-ellipsis-3[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)]
      .map((match) => this.htmlToText(match[1] ?? match[2] ?? ''))
      .filter((value): value is string => Boolean(value));
  }

  private cardMetaParts(html: string): string[] {
    const matches = [...html.matchAll(/<div\b[^>]*class=["'][^"']*lg:px-4 first:pl-0[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)];
    return matches.map((match) => this.htmlToText(match[1] ?? '')).filter((value): value is string => Boolean(value));
  }

  private cardRecord(card: BuduCard): RawOpportunityRecord {
    return {
      externalId: card.id,
      url: card.url,
      type: 'vacancy',
      title: card.title,
      companyOrClient: card.company,
      description: card.description,
      sourceStatus: 'Unknown',
      rawPayload: { card, sourceUrl: VACANCIES_URL },
      sourceMetadata: {
        extraction: 'budu-ssr-card',
        sourceUrl: VACANCIES_URL,
        coverage: 'ssr-initial-page',
        salaryText: card.salaryText,
        locationText: card.locationText,
        dateKnown: false,
      },
    };
  }

  private async enrichedRecords(cards: BuduCard[], ctx: FetchContext, unavailableDetailIds: string[]): Promise<RawOpportunityRecord[]> {
    const records = await mapWithConcurrency(cards, DETAIL_CONCURRENCY, async (card): Promise<RawOpportunityRecord | null> => {
      throwIfAborted(ctx.signal);
      const detail = await this.fetchDetail(card.url, ctx);
      if (!detail) { unavailableDetailIds.push(card.id); return null; }
      throwIfAborted(ctx.signal);
      this.assertDetailMatchesCard(card, detail.url);
      if (detail.publishedAt && !this.withinWindow(detail.publishedAt, ctx)) return null;
      const fallback = this.cardRecord(card);
      return {
        ...detail,
        externalId: card.id,
        url: detail.url || card.url,
        type: 'vacancy',
        rawPayload: {
          card,
          detail: detail.rawPayload,
          sourceUrl: VACANCIES_URL,
          descriptionCoverage: 'detail-full',
        },
        sourceMetadata: {
          ...detail.sourceMetadata,
          sourceUrl: VACANCIES_URL,
          detailUrl: detail.url,
          coverage: 'ssr-initial-page-detail-enriched',
          descriptionCoverage: 'detail-full',
          salaryText: fallback.sourceMetadata.salaryText,
          locationText: fallback.sourceMetadata.locationText,
          dateKnown: Boolean(detail.publishedAt),
        },
      };
    });
    return records.filter((record): record is RawOpportunityRecord => Boolean(record));
  }

  private nativeSalary(value: unknown): Record<string, unknown> | undefined {
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const from = typeof value[0] === 'number' && Number.isFinite(value[0]) && value[0] >= 0 ? value[0] : undefined;
    const to = typeof value[1] === 'number' && Number.isFinite(value[1]) && value[1] >= 0 ? value[1] : undefined;
    if (from === undefined && to === undefined) return undefined;
    if (from !== undefined && to !== undefined && from > to) return undefined;
    return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), currency: 'RUB' };
  }

  private async fetchDetail(url: string, ctx: FetchContext): Promise<RawOpportunityRecord | null> {
    try {
      return await this.webExtraction!.extractOpportunityFromUrl(url, {
        sourceId: ctx.source._id, sourceName: ctx.source.name, type: 'vacancy',
        requireOpportunitySignal: true, allowedHosts: ['budu.jobs'], signal: ctx.signal,
      });
    } catch (error) {
      // The live search can reference missing native detail routes. Their SEO JSON-LD
      // remains rendered in a 404 page, so it must not be ingested as an available job.
      if (error instanceof WebExtractionHttpError && error.status === 404 && error.url === url) return null;
      throw error;
    }
  }

  private assertDetailMatchesNative(record: BuduNativeVacancy, detailUrl: string): void {
    this.assertDetailUrlMatchesId(record.id, detailUrl);
  }

  private assertDetailMatchesCard(card: BuduCard, detailUrl: string): void {
    this.assertDetailUrlMatchesId(card.id, detailUrl);
  }

  private assertDetailUrlMatchesId(id: string, detailUrl: string): void {
    let url: URL;
    try {
      url = new URL(detailUrl);
    } catch {
      throw new Error(`Budu detail URL ${detailUrl} does not match feed vacancy ${id}`);
    }
    const match = VACANCY_PATH_RE.exec(url.pathname);
    const detailId = match?.[1]?.toLowerCase();
    if (url.origin !== ORIGIN || url.search || url.hash || url.username || url.password || detailId !== id) {
      throw new Error(`Budu detail URL ${detailUrl} does not match feed vacancy ${id}`);
    }
  }

  private withinWindow(date: Date | undefined, ctx: FetchContext): boolean {
    if (!date) return true;
    const bounds = this.windowBounds(ctx);
    return date >= new Date(bounds.backfillSince) && date <= new Date(bounds.windowUntil);
  }

  private windowBounds(ctx: FetchContext): { backfillSince: string; windowUntil: string } {
    const checkpoint = ctx.checkpoint ?? {};
    const explicitSince = ctx.backfillSince ? Date.parse(ctx.backfillSince) : NaN;
    const backfillDays = Math.min(Math.max(ctx.backfillDays || 1, 1), MAX_BACKFILL_DAYS);
    const lower = new Date(Number.isFinite(explicitSince) ? explicitSince : Date.now() - backfillDays * 86_400_000).toISOString();
    const savedLower = typeof checkpoint.backfillSince === 'string' ? checkpoint.backfillSince : undefined;
    const savedUpper = typeof checkpoint.windowUntil === 'string' ? checkpoint.windowUntil : undefined;
    return { backfillSince: savedLower === lower ? savedLower : lower, windowUntil: savedLower === lower && savedUpper ? savedUpper : new Date(Math.min(Date.now(), Date.parse(lower) + backfillDays * 86_400_000)).toISOString() };
  }

  private remainingHint(html: string): number {
    const buttonIndex = html.indexOf('Показать еще');
    if (buttonIndex < 0) return 0;
    const nearby = html.slice(buttonIndex, buttonIndex + 500);
    const value = /<!-- react-text:\s*\d+\s*-->\+(?:<!-- \/react-text -->)?<!-- react-text:\s*\d+\s*-->(\d+)/.exec(nearby)?.[1]
      ?? /\+\s*(\d+)/.exec(this.htmlToText(nearby) ?? '')?.[1];
    const parsed = value ? Number.parseInt(value, 10) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private assertConfig(config: Record<string, unknown>): void {
    const url = stringValue(config.baseUrl) ?? stringValue(config.url) ?? VACANCIES_URL;
    const parsed = new URL(url);
    if (parsed.origin !== ORIGIN || !['/vacancies', '/vacancies/'].includes(parsed.pathname) || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error('Budu connector only supports https://budu.jobs/vacancies');
    }
  }

  private vacancyUrl(value: string): string {
    const url = new URL(value, ORIGIN);
    if (url.origin !== ORIGIN || url.search || url.hash || url.username || url.password || !VACANCY_PATH_RE.test(url.pathname)) {
      throw new Error('Budu vacancy card URL is outside the allowed source path');
    }
    return url.toString();
  }

  private htmlToText(value: string): string | undefined {
    return stringValue(value
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/\s+/g, ' '));
  }
}

function decodeTransitCache(value: unknown): unknown {
  const cache: string[] = [];
  let next = 0;
  const cacheable = (item: string, mapKey: boolean) => item.length > 3 && (mapKey || item.startsWith('~:') || item.startsWith('~$') || item.startsWith('~#'));
  const putCache = (item: string): void => {
    if (next >= 44 * 44) next = 0;
    cache[next++] = item;
  };
  const cacheIndex = (item: string): number => {
    if (item.length === 2) return item.charCodeAt(1) - 48;
    return (item.charCodeAt(1) - 48) * 44 + (item.charCodeAt(2) - 48);
  };
  const visit = (node: unknown, mapKey = false): unknown => {
    if (typeof node === 'string') {
      if (isTransitCacheCode(node)) return cache[cacheIndex(node)] ?? node;
      if (cacheable(node, mapKey) && !isTransitCacheMarker(node)) putCache(node);
      return node;
    }
    if (Array.isArray(node)) {
      if (node[0] === '^ ') {
        const decoded: unknown[] = ['^ '];
        for (let index = 1; index < node.length; index += 2) {
          decoded.push(visit(node[index], true), visit(node[index + 1], false));
        }
        return decoded;
      }
      return node.map((item) => visit(item, false));
    }
    return node;
  };
  return visit(value);
}

function transitQuery(value: unknown): unknown {
  if (typeof value === 'string') return `~:${value}`;
  if (Array.isArray(value)) return value.map(transitQuery);
  return ['^ ', ...Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [`~:${key}`, transitQuery(nested)])];
}

function transitLikeMaps(value: unknown): Array<{ key?: string; map: Record<string, unknown> }> {
  const maps: Array<{ key?: string; map: Record<string, unknown> }> = [];
  const visit = (node: unknown, key?: string): void => {
    if (!Array.isArray(node)) return;
    if (node[0] === '^ ') {
      const map: Record<string, unknown> = {};
      for (let index = 1; index < node.length; index += 2) {
        const rawKey = normalizeBuduNativeKey(node[index]);
        const valueNode = normalizeBuduNativeValue(node[index + 1]);
        if (rawKey) map[rawKey] = valueNode;
        visit(node[index + 1], typeof valueNode === 'string' ? valueNode : rawKey);
      }
      maps.push({ key, map });
      return;
    }
    if (isUuidToken(node[0]) && Array.isArray(node[1])) {
      visit(node[1], stripTransitUuid(String(node[0])));
    }
    for (const child of node) visit(child, key);
  };
  visit(value);
  return maps;
}

function normalizeBuduNativeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (isUuidToken(value)) return stripTransitUuid(value);
  return stripTransitKeyword(value);
}

function normalizeBuduNativeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (isUuidToken(value)) return stripTransitUuid(value);
    return stripTransitKeyword(value);
  }
  if (Array.isArray(value)) {
    if (value[0] === '~#set' || value[0] === '~#list') return normalizeBuduNativeValue(value[1]);
    if (value[0] === '^@') return value.slice(1).map(normalizeBuduNativeValue);
    if (value[0] === '^ ') {
      const nested: Record<string, unknown> = {};
      for (let index = 1; index < value.length; index += 2) {
        const key = normalizeBuduNativeKey(value[index]);
        if (key) nested[key] = normalizeBuduNativeValue(value[index + 1]);
      }
      return nested;
    }
    return value.map(normalizeBuduNativeValue);
  }
  return value;
}

function pageMeta(value: unknown): BuduNativePageMeta {
  const page = typeof value === 'object' && value && !Array.isArray(value) ? (value as Record<string, unknown>).page : undefined;
  const raw = typeof page === 'object' && page && !Array.isArray(page) ? page as Record<string, unknown> : value as Record<string, unknown>;
  return {
    size: numberValue(raw?.size),
    current: numberValue(raw?.current),
    totalPages: numberValue(raw?.total_pages),
    totalResults: numberValue(raw?.total_results),
  };
}

function assertPageMeta(meta: BuduNativePageMeta, expectedPage: number): void {
  const { size, current, totalPages, totalResults } = meta;
  if (![size, current, totalPages, totalResults].every((value) => value !== undefined && Number.isSafeInteger(value))
    || size! <= 0 || current! <= 0 || totalPages! <= 0 || totalResults! < 0
    || current! > totalPages! || totalPages !== Math.max(1, Math.ceil(totalResults! / size!))) {
    throw new Error('Budu native search returned incomplete or inconsistent pagination metadata');
  }
  if (current !== expectedPage) throw new Error(`Budu native pagination did not advance to page ${expectedPage}`);
}

function vacancyIdFromIdent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const key = normalizeBuduNativeKey(value[0]);
  const id = normalizeBuduNativeValue(value[1]);
  return key === 'vacancy/id' && typeof id === 'string' && new RegExp(`^${UUID_RE}$`, 'i').test(id) ? id.toLowerCase() : undefined;
}

function stripTransitKeyword(value: string): string {
  if (value === '~_') return '';
  if (/^~[~^`]/.test(value)) return value.slice(1);
  if (value.startsWith('~:') || value.startsWith('~$')) return value.slice(2);
  return value;
}

function isTransitCacheMarker(value: string): boolean {
  return value === '^ ' || value === '^@';
}

function isTransitCacheCode(value: string): boolean {
  if (!value.startsWith('^') || isTransitCacheMarker(value) || (value.length !== 2 && value.length !== 3)) return false;
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 91) return false;
  }
  return true;
}

function isUuidToken(value: unknown): boolean {
  return typeof value === 'string' && new RegExp(`^~u${UUID_RE}$`, 'i').test(value);
}

function stripTransitUuid(value: string): string {
  return value.startsWith('~u') ? value.slice(2).toLowerCase() : value.toLowerCase();
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cookieHeaderFromSetCookie(value: string | null): string | undefined {
  if (!value) return undefined;
  const cookies = value
    .split(/,(?=\s*[^;,=]+=[^;,]+)/)
    .map((part) => part.split(';')[0]?.trim())
    .filter((part): part is string => Boolean(part));
  return cookies.length > 0 ? cookies.join('; ') : undefined;
}

function annotateBuduFetchError(error: unknown): Error {
  if (error instanceof Error && /^Budu /i.test(error.message)) return error;
  const annotated = new Error(`Budu public page fetch failed: ${safeErrorSummary(error)}`);
  (annotated as Error & { cause?: unknown }).cause = error;
  return annotated;
}

function safeErrorSummary(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name || 'Error');
    if (error.message) parts.push(error.message);
  } else if (typeof error === 'string' && error.trim()) {
    parts.push(error.trim());
  }
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (cause && typeof cause === 'object') {
    const code = typeof (cause as { code?: unknown }).code === 'string' ? (cause as { code: string }).code : undefined;
    const name = cause instanceof Error ? cause.name : undefined;
    const message = cause instanceof Error
      ? cause.message
      : typeof (cause as { message?: unknown }).message === 'string'
        ? (cause as { message: string }).message
        : undefined;
    if (code) parts.push(`cause=${code}`);
    else if (name) parts.push(`cause=${name}`);
    if (message && message !== code) parts.push(message);
  }
  return parts.filter(Boolean).join(' | ') || 'unknown network error';
}

async function fetchBudu(urlText: string, ctx: FetchContext | ConnectorContext, request: BuduFetchRequest = {}): Promise<BuduResponse> {
  const url = parseHttpUrl(urlText);
  const method = request.method ?? 'GET';
  const isVacanciesGet = method === 'GET' && url.origin === ORIGIN && url.pathname === '/vacancies' && !url.search && !url.hash && !url.username && !url.password;
  const isApiPost = method === 'POST' && url.origin === ORIGIN && url.pathname === '/api' && !url.search && !url.hash && !url.username && !url.password;
  if (!isVacanciesGet && !isApiPost) {
    throw new Error('Budu connector only fetches https://budu.jobs/vacancies and posts https://budu.jobs/api');
  }
  const dispatcher = await createPinnedDispatcher(url);
  try {
    const response = await undiciFetch(url, {
      dispatcher,
      method,
      body: request.body,
      redirect: 'manual',
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
      headers: {
        Accept: isApiPost ? 'application/transit+json' : 'text/html,application/xhtml+xml',
        'User-Agent': 'INTLY Budu collector/1.0',
        ...request.headers,
      },
    } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_HTML_BYTES) throw new Error('Budu response is larger than the v1 safety limit');
    return { ok: response.ok, status: response.status, headers: response.headers, async text() { return text; } };
  } finally {
    await dispatcher.close().catch(() => undefined);
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
  throw signal.reason instanceof Error ? signal.reason : new Error('Budu collection aborted');
}
