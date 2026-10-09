import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { firstTextLine, numberValue, stringValue } from './connector-utils';

type AuthenticatedMarketplaceId = 'upwork' | 'freelancer_com';

type HttpOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export class AuthenticatedMarketplaceConnector implements Connector {
  readonly family = 'AuthenticatedMarketplace' as const;

  constructor(readonly id: AuthenticatedMarketplaceId) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: true, maxBackfillDays: 30 };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    const credentials = this.credentialsFromConfig(config);
    if (!this.credentialValue(credentials, ['token', 'accessToken', 'apiToken'])) {
      return { ok: false, message: `${this.id} requires API credentials`, details: { state: 'NeedsConfiguration' } };
    }
    const apiBaseUrl = stringValue(config.apiBaseUrl);
    if (apiBaseUrl && !this.allowedApiBaseUrl(apiBaseUrl)) {
      return { ok: false, message: `${this.id} API base URL is not allowed`, details: { state: 'InvalidConfiguration' } };
    }
    return { ok: true, message: `${this.id} API configured`, details: { state: 'Credentialed', provider: this.id } };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const validation = await this.validateConfig({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}), credentials: ctx.credentials });
    if (!validation.ok) return { state: 'Disabled', message: validation.message, checkedAt: new Date(), details: validation.details };
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1, page: 0 });
      return { state: 'Healthy', message: `${this.id} returned ${page.records.length} records`, checkedAt: new Date(), details: { seen: page.records.length } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : `${this.id} health failed`, checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const validation = await this.validateConfig({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}), credentials: ctx.credentials });
    if (!validation.ok) throw new Error(validation.message ?? `${this.id} source is not configured`);
    if (this.id === 'upwork') return this.fetchUpwork(ctx);
    return this.fetchFreelancer(ctx);
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private async fetchUpwork(ctx: FetchContext): Promise<FetchPage> {
    const token = this.credentialValue(ctx.credentials, ['token', 'accessToken', 'apiToken']);
    if (!token) throw new Error('upwork requires API credentials');
    const page = Math.max(0, ctx.page ?? (ctx.checkpoint.hasMore === true ? Number(ctx.checkpoint.page ?? 0) : 0));
    const perPage = Math.min(Number(ctx.source.limits?.perPage ?? 20), 50);
    const offset = page * perPage;
    const after = ctx.checkpoint.hasMore === true ? stringValue(ctx.checkpoint.cursor) ?? String(offset) : '0';
    const query = this.upworkQuery();
    const variables = {
      filter: {
        searchExpression_eq: stringValue(ctx.source.config?.searchText) ?? stringValue(ctx.source.config?.query) ?? '',
        pagination_eq: { after, first: perPage },
      },
    };
    const payload = await this.postJson<Record<string, unknown>>(this.apiBase(ctx, 'https://api.upwork.com/graphql'), {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length > 0) throw new Error(`upwork GraphQL returned ${errors.length} error(s)`);
    const search = this.findSearchPayload(payload);
    const items = this.extractItems(search).filter(this.isRecord);
    const cutoff = this.cutoff(ctx.backfillDays);
    const records = items.map((item) => this.upworkRecord(item)).filter((record) => this.withinBackfill(record, cutoff));
    const searchRecord = this.recordValue(search);
    const total = numberValue(searchRecord?.totalCount);
    const pageInfo = this.recordValue(searchRecord?.pageInfo);
    const hasMore = pageInfo?.hasNextPage === true || (typeof total === 'number' ? offset + items.length < total : items.length === perPage);
    const endCursor = stringValue(pageInfo?.endCursor);
    return { records, checkpoint: { page: hasMore ? page + 1 : 0, cursor: hasMore ? endCursor : undefined, hasMore, lastFetchedAt: new Date().toISOString() }, hasMore, nextPage: hasMore ? page + 1 : undefined, stats: { seen: items.length } };
  }

  private upworkQuery(): string {
    return `query SearchJobs($filter: MarketplaceJobPostingsSearchFilter) {
  marketplaceJobPostingsSearch(
    marketPlaceJobFilter: $filter
    searchType: USER_JOBS_SEARCH
    sortAttributes: [{ field: RECENCY }]
  ) {
    totalCount
    edges {
      node {
        id
        title
        description
        ciphertext
        amount { displayValue currency }
        createdDateTime
        publishedDateTime
        hourlyBudgetMin { displayValue currency rawValue }
        hourlyBudgetMax { displayValue currency rawValue }
        duration
        skills { name }
        client { totalSpent verificationStatus totalFeedback location { country city } }
      }
      cursor
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
  }

  private upworkRecord(item: Record<string, unknown>): RawOpportunityRecord {
    const id = stringValue(item.id) ?? stringValue(item.uid) ?? stringValue(item.ciphertext) ?? this.hashFallback(item);
    const amount = this.recordValue(item.amount);
    const skills = Array.isArray(item.skills) ? item.skills.map((skill) => stringValue(this.recordValue(skill)?.name) ?? stringValue(skill)).filter((skill): skill is string => Boolean(skill)) : [];
    const client = this.recordValue(item.client);
    const clientLocation = this.recordValue(client?.location);
    return {
      externalId: id,
      url: stringValue(item.url) ?? `https://www.upwork.com/jobs/${encodeURIComponent(id)}`,
      type: 'freelance',
      title: stringValue(item.title) ?? firstTextLine(stringValue(item.description) ?? '', 'Untitled Upwork project'),
      companyOrClient: stringValue(client?.companyName) ?? stringValue(client?.name),
      description: stringValue(item.description),
      publishedAt: this.date(item.publishedDateTime) ?? this.date(item.createdDateTime),
      sourceStatus: 'Active',
      rawPayload: item,
      sourceMetadata: {
        marketplace: 'upwork',
        budget: { min: this.moneyNumber(item.hourlyBudgetMin), max: this.moneyNumber(item.hourlyBudgetMax), currency: stringValue(amount?.currency), originalText: stringValue(amount?.displayValue) },
        client: { totalSpent: numberValue(client?.totalSpent), verificationStatus: stringValue(client?.verificationStatus), country: stringValue(clientLocation?.country), city: stringValue(clientLocation?.city) },
        skills,
        duration: stringValue(item.duration),
      },
    };
  }


  private moneyNumber(value: unknown): number | undefined {
    const direct = numberValue(value);
    if (direct !== undefined) return direct;
    const money = this.recordValue(value);
    return numberValue(money?.rawValue) ?? numberValue(money?.amount);
  }

  private async fetchFreelancer(ctx: FetchContext): Promise<FetchPage> {
    const token = this.credentialValue(ctx.credentials, ['token', 'accessToken', 'apiToken']);
    if (!token) throw new Error('freelancer_com requires API credentials');
    const page = Math.max(0, ctx.page ?? (ctx.checkpoint.hasMore === true ? Number(ctx.checkpoint.page ?? 0) : 0));
    const limit = Math.min(Number(ctx.source.limits?.perPage ?? 50), 100);
    const offset = page * limit;
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset), full_description: 'true', job_details: 'true' });
    const query = stringValue(ctx.source.config?.searchText) ?? stringValue(ctx.source.config?.query);
    if (query) params.set('query', query);
    const payload = await this.getJson<Record<string, unknown>>(`${this.apiBase(ctx, 'https://www.freelancer.com')}/api/projects/0.1/projects/active/?${params.toString()}`, {
      headers: { Accept: 'application/json', 'Freelancer-OAuth-V1': token },
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    const items = this.freelancerProjects(payload).filter(this.isRecord);
    const cutoff = this.cutoff(ctx.backfillDays);
    const records = items.map((item) => this.freelancerRecord(item)).filter((record) => this.withinBackfill(record, cutoff));
    const hasMore = items.length === limit;
    return { records, checkpoint: { page: hasMore ? page + 1 : 0, hasMore, lastFetchedAt: new Date().toISOString() }, hasMore, nextPage: hasMore ? page + 1 : undefined, stats: { seen: items.length } };
  }

  private freelancerRecord(item: Record<string, unknown>): RawOpportunityRecord {
    const id = String(item.id ?? this.hashFallback(item));
    const budget = this.recordValue(item.budget);
    const currency = this.recordValue(budget?.currency) ?? this.recordValue(item.currency);
    const jobs = Array.isArray(item.jobs) ? item.jobs.filter(this.isRecord).map((job) => stringValue(job.name)).filter((name): name is string => Boolean(name)) : [];
    return {
      externalId: id,
      url: this.freelancerUrl(item, id),
      type: 'freelance',
      title: stringValue(item.title) ?? stringValue(item.name) ?? 'Untitled Freelancer project',
      companyOrClient: stringValue(item.owner_name) ?? stringValue(item.client_name),
      description: stringValue(item.description) ?? stringValue(item.preview_description),
      publishedAt: this.unixDate(item.submitdate) ?? this.date(item.time_submitted),
      updatedAt: this.unixDate(item.time_updated),
      sourceStatus: 'Active',
      rawPayload: item,
      sourceMetadata: {
        marketplace: 'freelancer_com',
        budget: { min: numberValue(budget?.minimum), max: numberValue(budget?.maximum), currency: stringValue(currency?.code) ?? stringValue(currency?.sign) },
        skills: jobs,
        bidStats: this.recordValue(item.bid_stats),
      },
    };
  }


  private freelancerUrl(item: Record<string, unknown>, id: string): string {
    const absolute = stringValue(item.url);
    if (absolute) return absolute;
    const seoUrl = stringValue(item.seo_url);
    if (seoUrl) {
      if (/^https:\/\//i.test(seoUrl)) return seoUrl;
      return `https://www.freelancer.com/projects/${seoUrl.replace(/^\/+/, '')}`;
    }
    return `https://www.freelancer.com/projects/${id}`;
  }

  private findSearchPayload(payload: Record<string, unknown>): unknown {
    const data = this.recordValue(payload.data) ?? payload;
    return data.publicMarketplaceJobPostingsSearch ?? data.marketplaceJobPostingsSearch ?? data.search ?? data;
  }

  private extractItems(value: unknown): unknown[] {
    const record = this.recordValue(value);
    if (!record) return Array.isArray(value) ? value : [];
    if (Array.isArray(record.jobs)) return record.jobs;
    if (Array.isArray(record.results)) return record.results;
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.edges)) return record.edges.map((edge) => this.recordValue(edge)?.node).filter(Boolean);
    return [];
  }

  private freelancerProjects(payload: Record<string, unknown>): unknown[] {
    const result = this.recordValue(payload.result) ?? payload;
    if (Array.isArray(result.projects)) return result.projects;
    if (Array.isArray(payload.projects)) return payload.projects;
    return [];
  }

  private async getJson<T>(urlText: string, options: HttpOptions = {}): Promise<T> {
    return this.requestJson<T>(urlText, { ...options, method: options.method ?? 'GET' });
  }

  private async postJson<T>(urlText: string, options: HttpOptions = {}): Promise<T> {
    return this.requestJson<T>(urlText, { ...options, method: 'POST' });
  }

  private async requestJson<T>(urlText: string, options: HttpOptions): Promise<T> {
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

  private apiBase(ctx: FetchContext, fallback: string): string {
    const configured = stringValue(ctx.source.config?.apiBaseUrl);
    if (configured && this.allowedApiBaseUrl(configured)) return configured.replace(/\/$/, '');
    return fallback;
  }

  private allowedApiBaseUrl(urlText: string): boolean {
    try {
      const url = new URL(urlText);
      if (url.protocol !== 'https:') return false;
      if (this.id === 'upwork') return url.host === 'api.upwork.com';
      return url.host === 'www.freelancer.com';
    } catch {
      return false;
    }
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

  private unixDate(value: unknown): Date | undefined {
    const number = numberValue(value);
    return number ? new Date(number * 1000) : undefined;
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
