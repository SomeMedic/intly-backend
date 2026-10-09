import { fetch as undiciFetch } from 'undici';

import { createPinnedDispatcher } from '../extraction/pinned-fetch';
import { parseHttpUrl } from '../extraction/url-safety';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { numberValue, stringValue } from './connector-utils';

const ORIGIN = 'https://www.workingnomads.com';
const SEARCH_URL = `${ORIGIN}/jobsapi/_search`;
const INDEX = 'jobsapi';
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_BACKFILL_DAYS = 30;
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 100;

const SOURCE_FIELDS = [
  'company', 'company_slug', 'category_name', 'locations', 'location_base', 'salary_range', 'salary_range_short', 'number_of_applicants', 'instructions', 'id', 'external_id',
  'slug', 'title', 'pub_date', 'tags', 'source', 'apply_option', 'apply_email', 'apply_email_subject', 'apply_url', 'premium', 'expired', 'use_ats', 'position_type', 'annual_salary_usd', 'experience_level', 'description',
];

type WorkingNomadsResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
};

type WorkingNomadsFetcher = (body: Record<string, unknown>, ctx: FetchContext) => Promise<WorkingNomadsResponse>;

type Hit = { _id?: unknown; _index?: unknown; _source?: unknown; sort?: unknown };

type ExcludedInternalDocument = {
  readonly identity: string;
  readonly reason: 'working-nomads-internal-search-document';
  readonly index?: string;
  readonly hitId?: string;
  readonly sort?: Array<string | number | boolean | null>;
};

export class WorkingNomadsConnector implements Connector {
  readonly id = 'workingnomads';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly fetcher: WorkingNomadsFetcher = fetchWorkingNomads) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    try {
      this.assertFixedConfig(config);
      return { ok: true, message: 'Working Nomads public jobsapi search configured', details: { origin: ORIGIN, index: INDEX } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Working Nomads source is not configured' };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1, page: 0 });
      return { state: 'Healthy', message: `Working Nomads returned ${page.records.length} records`, checkedAt: new Date(), details: { seen: page.records.length } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Working Nomads health failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    this.assertFixedConfig({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) });
    const continuing = ctx.checkpoint.hasMore === true;
    const perPage = continuing ? this.checkpointPerPage(ctx.checkpoint.perPage) : this.perPage(ctx);
    const searchAfter = continuing ? this.requiredSearchAfterFromCheckpoint(ctx.checkpoint.searchAfter) : undefined;
    const seenBefore = continuing ? this.requiredSeen(ctx.checkpoint.seenSoFar) : 0;
    const windowFrom = continuing ? this.requiredCheckpointDate(ctx.checkpoint.windowFrom, 'windowFrom') : this.windowFrom(ctx);
    const windowTo = continuing ? this.requiredCheckpointDate(ctx.checkpoint.windowTo, 'windowTo') : new Date();
    if (windowFrom > windowTo) throw new Error('Working Nomads continuation checkpoint windowFrom must be before or equal to windowTo');
    const visitedSearchAfter = continuing ? this.requiredCheckpointStringArray(ctx.checkpoint.visitedSearchAfter, 'visitedSearchAfter') : [];
    const requestCursorKey = this.cursorKey(searchAfter);
    if (continuing && visitedSearchAfter.includes(requestCursorKey)) throw new Error('Working Nomads pagination repeated search_after cursor');
    const body = this.searchBody(perPage, windowFrom, windowTo, searchAfter);
    const payload = await this.fetchJson(body, ctx);
    const hits = this.hits(payload);
    const total = this.total(payload);
    const maxObservedTotal = continuing ? Math.max(total, this.checkpointNonNegativeInteger(ctx.checkpoint.maxObservedTotal), this.checkpointNonNegativeInteger(ctx.checkpoint.total)) : total;
    if (hits.length === 0 && seenBefore < maxObservedTotal) throw new Error('Working Nomads jobsapi returned empty hits before observed total was exhausted');
    const seenIds = new Set(continuing ? this.requiredCheckpointStringArray(ctx.checkpoint.seenIds, 'seenIds') : []);
    const excludedInternalDocuments = new Map((continuing ? this.checkpointExcludedInternalDocuments(ctx.checkpoint.excludedInternalDocuments) : []).map((entry) => [entry.identity, entry]));
    const records: RawOpportunityRecord[] = [];
    let newHitIds = 0;
    for (const hit of hits) {
      const excluded = this.excludedInternalSearchDocument(hit);
      if (excluded) {
        if (seenIds.has(excluded.identity)) continue;
        seenIds.add(excluded.identity);
        excludedInternalDocuments.set(excluded.identity, excluded);
        newHitIds += 1;
        continue;
      }
      const record = this.record(hit);
      if (seenIds.has(record.externalId)) continue;
      seenIds.add(record.externalId);
      newHitIds += 1;
      if (this.withinWindow(record, windowFrom, windowTo)) records.push(record);
    }
    if (hits.length > 0 && newHitIds === 0 && seenBefore < maxObservedTotal) throw new Error('Working Nomads jobsapi repeated all hit ids before observed total was exhausted');
    const nextSeen = Math.max(seenBefore, seenIds.size);
    const nextSearchAfter = hits.length > 0 ? this.sortCursor(hits[hits.length - 1]) : undefined;
    const nextCursorKey = this.cursorKey(nextSearchAfter);
    const hasMore = hits.length > 0 && nextSeen < maxObservedTotal;
    if (hasMore && !nextSearchAfter) throw new Error('Working Nomads jobsapi hit is missing search_after sort cursor');
    if (hasMore && nextCursorKey === requestCursorKey) throw new Error('Working Nomads jobsapi returned a non-advancing search_after cursor');
    const nextVisitedSearchAfter = [...visitedSearchAfter, requestCursorKey];
    if (hasMore && nextVisitedSearchAfter.includes(nextCursorKey)) throw new Error('Working Nomads pagination would revisit a search_after cursor');
    return {
      records,
      hasMore,
      nextPage: hasMore ? Math.floor(nextSeen / perPage) : undefined,
      checkpoint: {
        hasMore,
        searchAfter: hasMore ? nextSearchAfter : undefined,
        seenSoFar: nextSeen,
        perPage,
        total,
        maxObservedTotal,
        seenIds: [...seenIds],
        excludedInternalDocuments: [...excludedInternalDocuments.values()],
        visitedSearchAfter: nextVisitedSearchAfter,
        windowFrom: windowFrom.toISOString(),
        windowTo: windowTo.toISOString(),
        window: 'finite_current_catalog',
        publicSearchScope: 'Working Nomads public jobsapi current catalog, bounded by fixed pub_date window plus undated public jobs',
        terminalReason: hasMore ? undefined : 'observed-search-exhausted',
        lastFetchedAt: new Date().toISOString(),
      },
      stats: { seen: hits.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private searchBody(perPage: number, windowFrom: Date, windowTo: Date, searchAfter?: Array<string | number | boolean | null>): Record<string, unknown> {
    return {
      track_total_hits: true,
      size: perPage,
      _source: SOURCE_FIELDS,
      sort: [{ premium: { order: 'desc' } }, { pub_date: { order: 'desc' } }, { id: { order: 'asc' } }],
      ...(searchAfter ? { search_after: searchAfter } : {}),
      query: {
        bool: {
          filter: [{
            bool: {
              should: [
                { range: { pub_date: { gte: windowFrom.toISOString(), lte: windowTo.toISOString() } } },
                { bool: { must_not: { exists: { field: 'pub_date' } } } },
              ],
              minimum_should_match: 1,
            },
          }],
        },
      },
    };
  }

  private async fetchJson(body: Record<string, unknown>, ctx: FetchContext): Promise<Record<string, unknown>> {
    const response = await this.fetcher(body, ctx);
    if (!response.ok) throw new Error(`Working Nomads jobsapi returned ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/\bjson\b|\+json\b/i.test(contentType)) throw new Error(`Working Nomads jobsapi returned unsupported content type ${contentType || 'unknown'}`);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('Working Nomads jobsapi response is larger than the v1 safety limit');
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('Working Nomads jobsapi returned malformed JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Working Nomads jobsapi returned an invalid payload');
    this.assertCompletePayload(payload as Record<string, unknown>);
    return payload as Record<string, unknown>;
  }


  private assertCompletePayload(payload: Record<string, unknown>): void {
    if (payload.error) throw new Error('Working Nomads jobsapi returned an error payload');
    if (payload.timed_out === true) throw new Error('Working Nomads jobsapi returned a timed out partial payload');
    const shards = this.recordValue(payload._shards);
    const failedShards = numberValue(shards?.failed);
    if (failedShards !== undefined && failedShards > 0) throw new Error('Working Nomads jobsapi returned a partial shard failure payload');
  }

  private hits(payload: Record<string, unknown>): Hit[] {
    const hitsRoot = this.recordValue(payload.hits);
    const hits = Array.isArray(hitsRoot?.hits) ? hitsRoot.hits : undefined;
    if (!hits) throw new Error('Working Nomads jobsapi payload is missing hits');
    return hits.map((hit) => {
      if (!hit || typeof hit !== 'object' || Array.isArray(hit)) throw new Error('Working Nomads jobsapi returned a malformed hit');
      return hit as Hit;
    });
  }

  private total(payload: Record<string, unknown>): number {
    const hitsRoot = this.recordValue(payload.hits);
    const total = this.recordValue(hitsRoot?.total);
    if (total && stringValue(total.relation) && stringValue(total.relation) !== 'eq') throw new Error('Working Nomads jobsapi returned an inexact total');
    const value = numberValue(total?.value) ?? numberValue(hitsRoot?.total);
    if (value === undefined || value < 0) throw new Error('Working Nomads jobsapi payload is missing total hits');
    return Math.floor(value);
  }


  private excludedInternalSearchDocument(hit: Hit): ExcludedInternalDocument | undefined {
    const source = this.recordValue(hit._source);
    if (stringValue(hit._index) !== INDEX || stringValue(hit._id) !== '_search' || !source || Object.keys(source).length > 0) return undefined;
    const sort = this.sortCursor(hit);
    if (!sort) return undefined;
    return {
      identity: `${INDEX}:internal:${stringValue(hit._id)}`,
      reason: 'working-nomads-internal-search-document',
      index: INDEX,
      hitId: '_search',
      sort,
    };
  }

  private checkpointExcludedInternalDocuments(value: unknown): ExcludedInternalDocument[] {
    if (!Array.isArray(value)) return [];
    const entries: ExcludedInternalDocument[] = [];
    for (const item of value) {
      const entry = this.recordValue(item);
      const identity = stringValue(entry?.identity);
      if (identity !== `${INDEX}:internal:_search`) continue;
      const reason = stringValue(entry?.reason);
      if (reason !== 'working-nomads-internal-search-document') continue;
      entries.push({
        identity,
        reason: 'working-nomads-internal-search-document',
        index: stringValue(entry?.index),
        hitId: stringValue(entry?.hitId),
        sort: this.searchAfterFromCheckpoint(entry?.sort),
      });
    }
    return entries;
  }

  private record(hit: Hit): RawOpportunityRecord {
    const source = this.recordValue(hit._source);
    if (!source) throw new Error('Working Nomads jobsapi hit is missing _source');
    const id = stringValue(source.id) ?? stringValue(source.external_id) ?? stringValue(hit._id);
    const title = stringValue(source.title);
    const slug = stringValue(source.slug);
    if (!id || !title || !slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('Working Nomads jobsapi hit is missing stable id title or slug');
    const descriptionHtml = stringValue(source.description);
    if (!descriptionHtml) throw new Error(`Working Nomads jobsapi hit ${id} is missing full description`);
    const locations = this.stringArray(source.locations);
    const tags = this.stringArray(source.tags);
    const publishedAt = this.date(source.pub_date);
    const expired = source.expired === true;
    const salaryText = stringValue(source.salary_range);
    const salaryShortText = stringValue(source.salary_range_short);
    return {
      externalId: id,
      url: `${ORIGIN}/jobs/${slug}`,
      type: 'vacancy',
      title,
      companyOrClient: stringValue(source.company),
      description: this.htmlToText(descriptionHtml),
      publishedAt,
      sourceStatus: expired ? 'Closed' : 'Active',
      rawPayload: {
        index: INDEX,
        hitId: hit._id,
        sort: hit.sort,
        source,
      },
      sourceMetadata: {
        extraction: 'working-nomads-jobsapi',
        sourceUrl: SEARCH_URL,
        category: stringValue(source.category_name),
        companySlug: stringValue(source.company_slug),
        locations,
        locationBase: stringValue(source.location_base),
        tags,
        skills: tags,
        salary: { originalText: salaryText, shortText: salaryShortText, annualUsd: numberValue(source.annual_salary_usd) },
        remoteType: 'remote',
        remoteTypeSource: 'https://www.workingnomads.com/faq',
        remoteTypeEvidence: 'Working Nomads FAQ states all jobs listed on the platform are remote jobs',
        salaryText,
        salaryShortText,
        positionType: stringValue(source.position_type),
        experienceLevel: stringValue(source.experience_level),
        applyOption: stringValue(source.apply_option),
        applyUrl: stringValue(source.apply_url),
        applyEmailSubject: stringValue(source.apply_email_subject),
        source: stringValue(source.source),
        premium: source.premium === true,
        expired,
        useAts: source.use_ats === true,
        numberOfApplicants: numberValue(source.number_of_applicants),
        descriptionHtml,
        dateTimezone: publishedAt ? 'UTC' : undefined,
      },
    };
  }


  private withinWindow(record: RawOpportunityRecord, windowFrom: Date, windowTo: Date): boolean {
    if (!record.publishedAt) return true;
    return record.publishedAt >= windowFrom && record.publishedAt <= windowTo;
  }

  private assertFixedConfig(config: Record<string, unknown>): void {
    const root = stringValue(config.elasticRootUrl) ?? stringValue(config.rootUrl);
    if (root) this.assertRootUrl(root);
    const baseUrl = stringValue(config.baseUrl);
    if (baseUrl) this.assertListingUrl(baseUrl);
    const searchUrl = stringValue(config.searchUrl) ?? stringValue(config.apiUrl) ?? stringValue(config.url);
    if (searchUrl) this.assertSearchUrl(searchUrl);
    const index = stringValue(config.elasticIndex) ?? stringValue(config.index);
    if (index && index !== INDEX) throw new Error('Working Nomads connector only supports the public jobsapi index');
  }


  private assertRootUrl(value: string): void {
    const url = new URL(value);
    if (url.username || url.password || url.origin !== ORIGIN || !['', '/'].includes(url.pathname) || url.search || url.hash) {
      throw new Error('Working Nomads connector only supports https://www.workingnomads.com');
    }
  }

  private assertListingUrl(value: string): void {
    const url = new URL(value);
    if (url.username || url.password || url.origin !== ORIGIN || !['/jobs', '/jobs/'].includes(url.pathname) || url.search || url.hash) {
      throw new Error('Working Nomads connector only supports https://www.workingnomads.com/jobs');
    }
  }

  private assertSearchUrl(value: string): void {
    const url = new URL(value);
    if (url.username || url.password || url.origin !== ORIGIN || url.pathname !== '/jobsapi/_search' || url.search || url.hash) {
      throw new Error('Working Nomads connector only supports https://www.workingnomads.com/jobsapi/_search');
    }
  }

  private perPage(ctx: FetchContext): number {
    return this.normalizePerPage(ctx.source.limits?.perPage);
  }

  private checkpointPerPage(value: unknown): number {
    return this.normalizePerPage(value);
  }

  private normalizePerPage(value: unknown): number {
    const raw = numberValue(value);
    if (!raw) return DEFAULT_PER_PAGE;
    return Math.min(Math.max(Math.floor(raw), 1), MAX_PER_PAGE);
  }

  private requiredSeen(value: unknown): number {
    const seen = numberValue(value);
    if (seen === undefined || seen < 0) throw new Error('Working Nomads continuation checkpoint is missing valid seenSoFar');
    return Math.floor(seen);
  }

  private requiredSearchAfterFromCheckpoint(value: unknown): Array<string | number | boolean | null> {
    const cursor = this.searchAfterFromCheckpoint(value);
    if (!cursor) throw new Error('Working Nomads continuation checkpoint is missing valid searchAfter cursor');
    return cursor;
  }

  private searchAfterFromCheckpoint(value: unknown): Array<string | number | boolean | null> | undefined {
    if (!Array.isArray(value)) return undefined;
    const cursor = value.filter((item): item is string | number | boolean | null => item === null || ['string', 'number', 'boolean'].includes(typeof item));
    return cursor.length === 3 && cursor.length === value.length ? cursor : undefined;
  }

  private sortCursor(hit: Hit): Array<string | number | boolean | null> | undefined {
    return this.searchAfterFromCheckpoint(hit.sort);
  }

  private cursorKey(value: Array<string | number | boolean | null> | undefined): string {
    return value ? JSON.stringify(value) : 'FIRST_PAGE';
  }

  private windowFrom(ctx: FetchContext): Date {
    const explicitSince = ctx.backfillSince ? Date.parse(ctx.backfillSince) : NaN;
    if (Number.isFinite(explicitSince)) return new Date(explicitSince);
    return new Date(Date.now() - Math.min(Math.max(ctx.backfillDays || 1, 1), MAX_BACKFILL_DAYS) * 86_400_000);
  }

  private requiredCheckpointDate(value: unknown, field: 'windowFrom' | 'windowTo'): Date {
    if (typeof value !== 'string') throw new Error(`Working Nomads continuation checkpoint is missing valid ${field}`);
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new Error(`Working Nomads continuation checkpoint is missing valid ${field}`);
    const date = new Date(timestamp);
    return date;
  }


  private requiredCheckpointStringArray(value: unknown, field: 'seenIds' | 'visitedSearchAfter'): string[] {
    if (!Array.isArray(value)) throw new Error(`Working Nomads continuation checkpoint is missing valid ${field}`);
    const values = this.checkpointStringArray(value);
    if (values.length !== value.length) throw new Error(`Working Nomads continuation checkpoint is missing valid ${field}`);
    return values;
  }

  private checkpointStringArray(value: unknown): string[] {
    return Array.isArray(value) ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))) : [];
  }

  private checkpointNonNegativeInteger(value: unknown): number {
    const number = numberValue(value);
    return number !== undefined && Number.isInteger(number) && number >= 0 ? number : 0;
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item)) : [];
  }

  private date(value: unknown): Date | undefined {
    const text = stringValue(value);
    if (!text) return undefined;
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
  }

  private htmlToText(value: string): string {
    return value
      .replace(/<\/?(?:p|div|li|h[1-6]|ul|ol|br)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

async function fetchWorkingNomads(body: Record<string, unknown>, ctx: FetchContext): Promise<WorkingNomadsResponse> {
  const url = parseHttpUrl(SEARCH_URL);
  const dispatcher = await createPinnedDispatcher(url);
  try {
    const response = await undiciFetch(url, {
      dispatcher,
      method: 'POST',
      redirect: 'manual',
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'INTLY WorkingNomads collector/1.0',
      },
      body: JSON.stringify(body),
    } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    const text = await readBoundedText(response, 'Working Nomads jobsapi');
    return bufferedResponse(response, text);
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

async function readBoundedText(response: Response, label: string): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel(`${label} response is larger than the v1 safety limit`).catch(() => undefined);
        throw new Error(`${label} response is larger than the v1 safety limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(output);
}

function bufferedResponse(response: Response, text: string): WorkingNomadsResponse {
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    async text() {
      return text;
    },
  };
}
