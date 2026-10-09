import { load } from 'cheerio';
import { fetch as undiciFetch } from 'undici';

import { createPinnedDispatcher } from '../extraction/pinned-fetch';
import { parseHttpUrl } from '../extraction/url-safety';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { numberValue, stringValue } from './connector-utils';

type GetmatchListResponse = {
  meta?: {
    total?: number;
    offset?: number;
    limit?: number;
  };
  offers?: Array<Record<string, unknown>>;
};

type GetmatchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: Buffer;
};

type GetmatchFetcher = (url: string, ctx: FetchContext | ConnectorContext) => Promise<GetmatchResponse>;

const ORIGIN = 'https://getmatch.ru';
const MAX_BODY_BYTES = 4_000_000;

export class GetmatchConnector implements Connector {
  readonly id = 'getmatch';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly fetcher: GetmatchFetcher = fetchGetmatchJson) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: 30 };
  }

  async validateConfig(): Promise<ValidationResult> {
    return { ok: true, message: 'GetMatch public offers API configured', details: { origin: ORIGIN, auth: 'anonymous-public' } };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1, page: 0 });
      return { state: 'Healthy', message: `GetMatch returned ${page.records.length} public offers`, checkedAt: new Date(), details: { seen: page.records.length } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'GetMatch health failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    if (stringValue(ctx.source.config?.searchText)) throw new Error('GetMatch public offers API searchText is not supported by the verified public fetchVacancies contract');
    const requestedOffset = this.requestedOffset(ctx);
    const limit = this.requestedLimit(ctx);
    const windowTo = this.windowTo(ctx);
    const list = await this.getJson<GetmatchListResponse>(this.listUrl(requestedOffset, limit), ctx);
    const { total, offset: metaOffset, limit: metaLimit, offers } = this.validList(list, requestedOffset, limit);
    const backfillSince = this.backfillSince(ctx);
    const observedTotal = this.observedTotal(ctx, total);
    const seenIds = new Set(this.checkpointStringArray(ctx.checkpoint.seenIds));
    const visitedOffsets = this.checkpointNumberArray(ctx.checkpoint.visitedOffsets);
    if (visitedOffsets.includes(metaOffset)) throw new Error(`GetMatch pagination repeated offset ${metaOffset}`);
    if (offers.length === 0 && metaOffset < observedTotal.max) throw new Error(`GetMatch list returned empty offers before observed total at offset ${metaOffset}`);

    const records: RawOpportunityRecord[] = [];
    let newOfferIds = 0;
    for (const offer of offers) {
      const id = this.offerId(offer);
      if (!id) continue;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      newOfferIds += 1;
      if (!this.withinWindow(offer, backfillSince, windowTo)) continue;
      const detail = this.validDetail(await this.fetchDetail(id, ctx), id);
      const merged = { ...offer, ...detail, offer_type: offer.offer_type ?? detail.offer_type };
      if (!this.withinWindow(merged, backfillSince, windowTo)) continue;
      records.push(this.toRecord(merged));
    }
    if (offers.length > 0 && newOfferIds === 0 && metaOffset < observedTotal.max) throw new Error(`GetMatch pagination repeated all offer ids at offset ${metaOffset}`);

    const nextOffset = metaOffset + metaLimit;
    const hasMore = nextOffset < observedTotal.max;
    if (hasMore && visitedOffsets.includes(nextOffset)) throw new Error(`GetMatch pagination would revisit offset ${nextOffset}`);
    const nextVisitedOffsets = [...visitedOffsets, metaOffset];
    const checkpointBase = {
      offset: hasMore ? nextOffset : 0,
      hasMore,
      windowTo: windowTo.toISOString(),
      limit: metaLimit,
      backfillSince: backfillSince.toISOString(),
      upstreamWindow: 'pa=all; GetMatch ignores from_date/to_date in live public API proof',
      total,
      initialObservedTotal: observedTotal.initial,
      maxObservedTotal: observedTotal.max,
      visitedOffsets: nextVisitedOffsets,
      seenIds: [...seenIds],
      lastFetchedAt: new Date().toISOString(),
    };
    return {
      records,
      checkpoint: checkpointBase,
      hasMore,
      nextPage: hasMore ? nextOffset : undefined,
      stats: { seen: offers.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private listUrl(offset: number, limit: number): string {
    const params = new URLSearchParams({
      sa: 'any',
      p: String(Math.floor(offset / limit) + 1),
      offset: String(offset),
      limit: String(limit),
      pa: 'all',
    });
    return `${ORIGIN}/api/offers?${params.toString()}`;
  }

  private async fetchDetail(id: string, ctx: FetchContext): Promise<Record<string, unknown>> {
    return this.getJson<Record<string, unknown>>(`${ORIGIN}/api/offers/${encodeURIComponent(id)}`, ctx);
  }

  private async getJson<T>(url: string, ctx: FetchContext | ConnectorContext): Promise<T> {
    const response = await this.fetcher(url, ctx);
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new ConnectorRateLimitError(`GetMatch rate limit${retryAfter ? `; retry after ${retryAfter}s` : ''}`, this.retryAfterSeconds(retryAfter));
    }
    if (!response.ok) throw new Error(`GetMatch API returned ${response.status}`);
    if (!this.isJsonContent(response.headers.get('content-type'))) throw new Error('GetMatch API returned non-JSON response');
    return JSON.parse(response.body.toString('utf8')) as T;
  }

  private toRecord(offer: Record<string, unknown>): RawOpportunityRecord {
    const id = this.offerId(offer);
    if (!id) throw new Error('GetMatch detail is missing numeric/string id');
    const company = this.recordValue(offer.company);
    const locations = this.locationItems(offer);
    const skills = this.skills(offer);
    const description = this.description(offer);
    const publishedAt = this.publishedAt(offer);
    const publishedAtRaw = stringValue(offer.published_at);
    const title = stringValue(offer.position);
    if (!title) throw new Error(`GetMatch detail ${id} is missing position`);
    if (!description) throw new Error(`GetMatch detail ${id} is missing opportunity description`);
    return {
      externalId: id,
      url: this.offerUrl(offer, id),
      type: 'vacancy',
      title,
      companyOrClient: stringValue(company?.name),
      description,
      sourceStatus: offer.is_active === false ? 'Closed' : 'Active',
      publishedAt,
      rawPayload: offer,
      sourceMetadata: {
        publicAccess: 'anonymous GetMatch public offers API',
        publishedAtRaw,
        publishedAtTimezone: publishedAtRaw ? this.publishedAtTimezone(publishedAtRaw) : undefined,
        offerType: stringValue(offer.offer_type),
        source: stringValue(offer.source),
        language: stringValue(offer.language),
        salary: {
          originalText: stringValue(offer.salary_description),
          min: numberValue(offer.salary_display_from),
          max: numberValue(offer.salary_display_to),
          currency: stringValue(offer.salary_currency),
          taxes: stringValue(offer.salary_taxes),
          hidden: offer.salary_hidden === true,
          total: offer.salary_is_total === true,
        },
        company,
        locations,
        skills,
        seniority: this.stringArray(offer.seniorities).join(', ') || stringValue(offer.seniority),
        specialization: stringValue(offer.specialization),
        requiredYearsOfExperience: numberValue(offer.required_years_of_experience),
        englishLevel: stringValue(offer.english_level),
        detailTextSources: this.detailTextSources(offer),
        upstreamWindow: 'pa=all; verified GetMatch public API ignores from_date/to_date',
      },
    };
  }

  private description(offer: Record<string, unknown>): string {
    return [
      this.htmlToText(offer.description),
      this.htmlToText(offer.short_description),
      this.htmlToText(offer.stack_description),
      this.htmlToText(offer.offer_description),
      this.htmlToText(offer.description_html),
      this.promoText(offer),
    ].filter((value): value is string => Boolean(value && value.trim())).join('\n\n');
  }

  private detailTextSources(offer: Record<string, unknown>): string[] {
    return ['description', 'short_description', 'stack_description', 'offer_description', 'description_html'].filter((key) => Boolean(stringValue(offer[key])));
  }

  private offerId(offer: Record<string, unknown>): string | undefined {
    const id = offer.id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    return stringValue(id);
  }

  private requestedOffset(ctx: FetchContext): number {
    if (ctx.checkpoint.hasMore === true) {
      const checkpointOffset = Number(ctx.checkpoint.offset);
      if (!Number.isInteger(checkpointOffset) || checkpointOffset < 0) throw new Error('GetMatch checkpoint is missing valid offset');
      if (ctx.page !== undefined && ctx.page !== checkpointOffset) throw new Error(`GetMatch continuation page ${ctx.page} does not match checkpoint offset ${checkpointOffset}`);
      return checkpointOffset;
    }
    return 0;
  }

  private requestedLimit(ctx: FetchContext): number {
    if (ctx.checkpoint.hasMore === true) {
      const checkpointLimit = Number(ctx.checkpoint.limit);
      if (!Number.isInteger(checkpointLimit) || checkpointLimit <= 0 || checkpointLimit > 50) throw new Error('GetMatch checkpoint is missing valid limit');
      return checkpointLimit;
    }
    return Math.min(Math.max(Math.floor(Number(ctx.source.limits?.perPage ?? 20)), 1), 50);
  }



  private checkpointStringArray(value: unknown): string[] {
    return Array.isArray(value) ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))) : [];
  }

  private checkpointNumberArray(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    const values: number[] = [];
    for (const item of value) {
      const number = Number(item);
      if (Number.isInteger(number) && number >= 0 && !values.includes(number)) values.push(number);
    }
    return values;
  }

  private validList(payload: unknown, expectedOffset: number, expectedLimit: number): { total: number; offset: number; limit: number; offers: Array<Record<string, unknown>> } {
    if (!this.isRecord(payload) || Array.isArray(payload)) throw new Error('GetMatch list payload must be an object');
    const meta = this.recordValue(payload.meta);
    if (!meta) throw new Error('GetMatch list payload is missing meta');
    const total = numberValue(meta.total);
    const offset = numberValue(meta.offset);
    const limit = numberValue(meta.limit);
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) throw new Error('GetMatch list meta.total must be a non-negative integer');
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new Error('GetMatch list meta.offset must be a non-negative integer');
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) throw new Error('GetMatch list meta.limit must be a positive integer');
    if (offset !== expectedOffset) throw new Error(`GetMatch list meta.offset ${offset} does not match requested offset ${expectedOffset}`);
    if (limit !== expectedLimit) throw new Error(`GetMatch list meta.limit ${limit} does not match requested limit ${expectedLimit}`);
    if (!Array.isArray(payload.offers)) throw new Error('GetMatch list payload is missing offers array');
    return { total, offset, limit, offers: payload.offers.map((item) => {
      if (!this.isRecord(item)) throw new Error('GetMatch list offer must be an object');
      if (!this.offerId(item)) throw new Error('GetMatch list offer is missing id');
      return item;
    }) };
  }

  private validDetail(detail: unknown, expectedId: string): Record<string, unknown> {
    if (!this.isRecord(detail)) throw new Error(`GetMatch detail ${expectedId} payload must be an object`);
    const id = this.offerId(detail);
    if (id !== expectedId) throw new Error(`GetMatch detail id ${id ?? 'missing'} does not match list id ${expectedId}`);
    this.offerUrl(detail, expectedId);
    if (!stringValue(detail.position)) throw new Error(`GetMatch detail ${expectedId} is missing position`);
    if (!this.description(detail)) throw new Error(`GetMatch detail ${expectedId} is missing opportunity description`);
    return detail;
  }

  private withinWindow(offer: Record<string, unknown>, backfillSince: Date, windowTo: Date): boolean {
    const value = stringValue(offer.published_at);
    if (!value) return true;
    if (this.hasExplicitTimezone(value)) {
      const timestamp = Date.parse(value);
      return !Number.isFinite(timestamp) || (timestamp >= backfillSince.getTime() && timestamp <= windowTo.getTime());
    }
    const day = value.slice(0, 10);
    return day >= this.naiveIso(this.conservativeNaiveFloor(backfillSince)).slice(0, 10)
      && day <= this.naiveIso(this.conservativeNaiveCeiling(windowTo)).slice(0, 10);
  }

  private backfillSince(ctx: FetchContext): Date {
    const checkpointTimestamp = typeof ctx.checkpoint.backfillSince === 'string' ? Date.parse(ctx.checkpoint.backfillSince) : NaN;
    if (ctx.checkpoint.hasMore === true) {
      if (Number.isFinite(checkpointTimestamp)) return new Date(checkpointTimestamp);
      throw new Error('GetMatch continuation checkpoint is missing fixed backfillSince');
    }
    const timestamp = typeof ctx.backfillSince === 'string' ? Date.parse(ctx.backfillSince) : NaN;
    if (Number.isFinite(timestamp)) return new Date(timestamp);
    return new Date(Date.now() - Math.min(Math.max(ctx.backfillDays, 1), 30) * 86_400_000);
  }

  private windowTo(ctx: FetchContext): Date {
    const checkpoint = typeof ctx.checkpoint.windowTo === 'string' ? Date.parse(ctx.checkpoint.windowTo) : NaN;
    if (ctx.checkpoint.hasMore === true) {
      if (Number.isFinite(checkpoint)) return new Date(checkpoint);
      throw new Error('GetMatch continuation checkpoint is missing fixed windowTo');
    }
    return new Date();
  }



  private observedTotal(ctx: FetchContext, currentTotal: number): { initial: number; max: number } {
    const priorInitial = numberValue(ctx.checkpoint.initialObservedTotal);
    const priorMax = numberValue(ctx.checkpoint.maxObservedTotal ?? ctx.checkpoint.total);
    const initial = ctx.checkpoint.hasMore === true && typeof priorInitial === 'number' && Number.isInteger(priorInitial) && priorInitial >= 0 ? priorInitial : currentTotal;
    const max = Math.max(initial, typeof priorMax === 'number' && Number.isInteger(priorMax) && priorMax >= 0 ? priorMax : 0, currentTotal);
    return { initial, max };
  }

  private naiveIso(value: Date): string {
    return value.toISOString().replace(/Z$/, '');
  }

  private conservativeNaiveFloor(value: Date): Date {
    return new Date(value.getTime() - 86_400_000);
  }

  private conservativeNaiveCeiling(value: Date): Date {
    return new Date(value.getTime() + 86_400_000);
  }

  private hasExplicitTimezone(value: string): boolean {
    return /[zZ]|[+-]\d{2}:\d{2}$/.test(value);
  }

  private publishedAt(offer: Record<string, unknown>): Date | undefined {
    const value = stringValue(offer.published_at);
    if (!value || !this.hasExplicitTimezone(value)) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
  }

  private publishedAtTimezone(value: string): string | undefined {
    return this.hasExplicitTimezone(value) ? 'specified' : 'unspecified';
  }

  private offerUrl(offer: Record<string, unknown>, id: string): string {
    const raw = stringValue(offer.url);
    if (!raw) throw new Error(`GetMatch detail ${id} is missing public vacancy URL`);
    const url = new URL(raw, ORIGIN);
    const slugPattern = new RegExp(`^/vacancies/${this.escapeRegExp(id)}-[^/]+/?$`);
    if (url.origin !== ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash || !slugPattern.test(url.pathname)) {
      throw new Error(`GetMatch detail ${id} has unsafe vacancy URL`);
    }
    return url.toString();
  }

  private locationItems(offer: Record<string, unknown>): Array<Record<string, unknown>> {
    return Array.isArray(offer.location_items) ? offer.location_items.filter(this.isRecord) : [];
  }

  private skills(offer: Record<string, unknown>): string[] {
    const items = Array.isArray(offer.skills_objects) ? offer.skills_objects.filter(this.isRecord) : [];
    return items.map((item) => stringValue(item.name)).filter((item): item is string => Boolean(item));
  }

  private promoText(offer: Record<string, unknown>): string | undefined {
    const blocks: string[] = [];
    const v3 = this.recordValue(offer.one_day_offer_content_v3);
    if (v3) this.collectStrings(v3, blocks);
    const legacy = this.recordValue(offer.one_day_offer_content);
    if (legacy) this.collectStrings(legacy, blocks);
    return blocks.length > 0 ? blocks.join('\n\n') : undefined;
  }

  private collectStrings(value: unknown, output: string[]): void {
    if (typeof value === 'string' && value.trim()) {
      const text = this.htmlToText(value);
      if (text) output.push(text);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.collectStrings(item, output);
      return;
    }
    if (this.isRecord(value)) {
      for (const item of Object.values(value)) this.collectStrings(item, output);
    }
  }

  private htmlToText(value: unknown): string | undefined {
    const text = stringValue(value);
    if (!text) return undefined;
    const $ = load(text, null, false);
    const root = $.root();
    root.find('script,style').remove();
    root.find('br').replaceWith('\n');
    root.find('p,div,li,ul,ol,pre,blockquote,h1,h2,h3,h4,h5,h6').each((_, element) => {
      const node = $(element);
      node.before('\n');
      node.after('\n');
    });
    return root.text()
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private isJsonContent(value: string | null): boolean {
    return !value || /\bapplication\/json\b|\+json\b/i.test(value);
  }

  private retryAfterSeconds(value: string | null): number {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const date = value ? Date.parse(value) : NaN;
    if (Number.isFinite(date)) return Math.max(Math.ceil((date - Date.now()) / 1000), 1);
    return 60;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return this.isRecord(value) ? value : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

}

async function fetchGetmatchJson(urlText: string, ctx: FetchContext | ConnectorContext): Promise<GetmatchResponse> {
  const url = parseHttpUrl(urlText);
  if (url.origin !== ORIGIN) throw new Error(`GetMatch connector blocks non-GetMatch URL: ${url.origin}`);
  if (!url.pathname.startsWith('/api/offers')) throw new Error(`GetMatch connector blocks non-offers endpoint: ${url.pathname}`);
  const dispatcher = await createPinnedDispatcher(url);
  try {
    const response = await undiciFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': process.env.GETMATCH_USER_AGENT ?? 'INTLY/1.0',
        'X-Client-Platform': 'web',
      },
      dispatcher,
      redirect: 'error',
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as GetmatchResponse;
    const body = await readBoundedBody(response as unknown as Response);
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      body,
    };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`GetMatch API response exceeds ${MAX_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}
