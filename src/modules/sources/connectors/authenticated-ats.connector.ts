import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { firstTextLine, safePublicHostOrSlug, stringValue } from './connector-utils';

type AuthenticatedAtsId = 'workable';

type HttpOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export class AuthenticatedAtsConnector implements Connector {
  readonly family = 'AtsAuthenticated' as const;

  constructor(readonly id: AuthenticatedAtsId) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: true, maxBackfillDays: 30 };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    const credentials = this.credentialsFromConfig(config);
    if (!this.credentialValue(credentials, ['token', 'accessToken', 'apiToken'])) {
      return { ok: false, message: 'workable requires API credentials', details: { state: 'NeedsConfiguration' } };
    }
    const subdomain = this.workableSubdomain(config, credentials);
    if (!subdomain) {
      return { ok: false, message: 'workable requires a Workable subdomain', details: { state: 'NeedsConfiguration' } };
    }
    return { ok: true, message: 'workable API configured', details: { state: 'Credentialed', provider: 'workable', subdomain } };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const validation = await this.validateConfig({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}), credentials: ctx.credentials });
    if (!validation.ok) return { state: 'Disabled', message: validation.message, checkedAt: new Date(), details: validation.details };
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1, page: 0 });
      return { state: 'Healthy', message: `workable returned ${page.records.length} records`, checkedAt: new Date(), details: { seen: page.records.length } };
    } catch (error) {
      return { state: 'Failed', message: this.safeErrorMessage(error, 'workable health failed'), checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const config = { ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) };
    const validation = await this.validateConfig({ ...config, credentials: ctx.credentials });
    if (!validation.ok) throw new Error(validation.message ?? 'workable source is not configured');
    const token = this.credentialValue(ctx.credentials, ['token', 'accessToken', 'apiToken']);
    const subdomain = this.workableSubdomain(config, ctx.credentials);
    if (!token || !subdomain) throw new Error('workable source is not configured');

    const limit = Math.min(Number(ctx.source.limits?.perPage ?? 50), 100);
    const params = new URLSearchParams({ state: 'published', limit: String(limit), include_fields: 'description,full_description,requirements,benefits' });
    const pagingNext = this.safeWorkableNextUrl(stringValue(ctx.checkpoint.nextUrl), subdomain);
    const sinceId = stringValue(ctx.checkpoint.sinceId);
    if (!pagingNext && sinceId) params.set('since_id', sinceId);
    const url = pagingNext ?? `https://${subdomain}.workable.com/spi/v3/jobs?${params.toString()}`;
    const payload = await this.getJson<Record<string, unknown>>(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    const items = this.extractJobs(payload).filter(this.isRecord);
    const cutoff = this.cutoff(ctx.backfillDays);
    const records = items.map((item) => this.workableRecord(item, subdomain)).filter((record) => this.withinBackfill(record, cutoff));
    const last = items.at(-1);
    const nextSinceId = stringValue(last?.id) ?? stringValue(last?.shortcode) ?? sinceId;
    const paging = this.recordValue(payload.paging);
    const nextUrl = this.safeWorkableNextUrl(stringValue(paging?.next), subdomain);
    const hasMore = Boolean(nextUrl);
    return {
      records,
      checkpoint: { sinceId: hasMore ? nextSinceId : undefined, nextUrl: hasMore ? nextUrl : undefined, lastFetchedAt: new Date().toISOString() },
      hasMore,
      nextPage: hasMore ? (ctx.page ?? 0) + 1 : undefined,
      stats: { seen: items.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }


  private safeWorkableNextUrl(next: string | undefined, subdomain: string): string | undefined {
    if (!next) return undefined;
    try {
      const url = new URL(next);
      return url.protocol === 'https:' && url.host === `${subdomain}.workable.com` && url.pathname === '/spi/v3/jobs' ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }

  private workableRecord(item: Record<string, unknown>, subdomain: string): RawOpportunityRecord {
    const shortcode = stringValue(item.shortcode);
    const id = stringValue(item.id) ?? shortcode ?? this.hashFallback(item);
    const location = this.recordValue(item.location);
    const department = this.recordValue(item.department);
    const title = stringValue(item.title) ?? firstTextLine(this.description(item) ?? '', 'Untitled Workable job');
    return {
      externalId: id,
      url: stringValue(item.url) ?? stringValue(item.shortlink) ?? (shortcode ? `https://${subdomain}.workable.com/jobs/${shortcode}` : `https://${subdomain}.workable.com`),
      type: 'vacancy',
      title,
      companyOrClient: stringValue(item.company) ?? subdomain,
      description: this.description(item),
      publishedAt: this.date(item.published_on) ?? this.date(item.created_at),
      updatedAt: this.date(item.updated_at),
      sourceStatus: 'Active',
      rawPayload: item,
      sourceMetadata: {
        ats: 'workable',
        subdomain,
        shortcode,
        state: stringValue(item.state),
        area: stringValue(location?.location_str) ?? stringValue(location?.city) ?? stringValue(item.location),
        department: stringValue(department?.name) ?? stringValue(item.department),
      },
    };
  }

  private description(item: Record<string, unknown>): string | undefined {
    return [stringValue(item.full_description), stringValue(item.description), stringValue(item.requirements), stringValue(item.benefits)].filter(Boolean).join('\n\n') || undefined;
  }

  private extractJobs(payload: Record<string, unknown>): unknown[] {
    if (Array.isArray(payload.jobs)) return payload.jobs;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.results)) return payload.results;
    return [];
  }

  private workableSubdomain(config: Record<string, unknown>, credentials?: Record<string, unknown>): string | undefined {
    const candidate = stringValue(config.subdomain) ?? stringValue(config.accountSubdomain) ?? stringValue(credentials?.subdomain) ?? stringValue(credentials?.accountSubdomain);
    if (!candidate) return undefined;
    const normalized = candidate.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.workable\.com$/i, '').trim().toLowerCase();
    if (!safePublicHostOrSlug(normalized)) return undefined;
    if (normalized.includes('.')) return undefined;
    return normalized;
  }

  private async getJson<T>(urlText: string, options: HttpOptions = {}): Promise<T> {
    const response = await fetch(urlText, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new ConnectorRateLimitError(`${this.id} rate limit${retryAfter ? `; retry after ${retryAfter}s` : ''}`, Number(retryAfter ?? 60));
    }
    if (!response.ok) throw new Error(`${this.id} API returned ${response.status}`);
    return response.json() as Promise<T>;
  }

  private safeErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
  }

  private credentialsFromConfig(config: Record<string, unknown>): Record<string, unknown> | undefined {
    return this.recordValue(config.credentials) ?? config;
  }

  private credentialValue(credentials: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    if (!credentials) return undefined;
    for (const key of keys) {
      const value = stringValue(credentials[key]);
      if (value) return value;
    }
    return undefined;
  }

  private withinBackfill(record: RawOpportunityRecord, cutoff: number): boolean {
    const relevantDate = record.updatedAt ?? record.publishedAt;
    return !relevantDate || relevantDate.getTime() >= cutoff;
  }

  private date(value: unknown): Date | undefined {
    const text = stringValue(value);
    if (!text) return undefined;
    const timestamp = Date.parse(text);
    return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
  }

  private cutoff(backfillDays: number): number {
    return Date.now() - Math.min(Math.max(backfillDays, 1), 30) * 86_400_000;
  }

  private hashFallback(value: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(value).slice(0, 128)).toString('base64url');
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return this.isRecord(value) ? value : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }
}
