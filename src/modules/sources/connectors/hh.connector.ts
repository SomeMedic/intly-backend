import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';

type HhEmployer = { name?: string };
type HhSalary = { from?: number; to?: number; currency?: string; gross?: boolean };
type HhArea = { name?: string };
type HhSnippet = { requirement?: string; responsibility?: string };
type HhVacancyListItem = {
  id: string;
  name: string;
  alternate_url?: string;
  published_at?: string;
  created_at?: string;
  archived?: boolean;
  employer?: HhEmployer;
  salary?: HhSalary;
  area?: HhArea;
  snippet?: HhSnippet;
  professional_roles?: Array<{ name?: string }>;
  employment?: { name?: string };
  schedule?: { name?: string };
};
type HhVacancyResponse = {
  items: HhVacancyListItem[];
  page: number;
  pages: number;
  per_page: number;
  found: number;
};

type HhErrorResponse = {
  description?: string;
  request_id?: string;
  errors?: Array<{ type?: string; value?: string }>;
};

const HH_SEARCH_DEPTH_LIMIT = 2_000;

export class HhConnector implements Connector {
  readonly id = 'hh';
  readonly family = 'OfficialRestApi' as const;

  capabilities(): ConnectorCapabilities {
    return {
      supportsBackfill: true,
      supportsIncremental: true,
      supportsRefresh: true,
      requiresCredentials: false,
      maxBackfillDays: 30,
    };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    const baseUrl = typeof config.apiUrl === 'string' ? config.apiUrl : 'https://api.hh.ru';
    try {
      const params = new URLSearchParams({ page: '0', per_page: '1' });
      const response = await fetch(`${baseUrl}/vacancies?${params.toString()}`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (response.ok) return { ok: true, message: 'HH vacancies search API reachable', details: { publicAccess: 'anonymous-search' } };
      return { ok: false, message: await this.errorMessage(response, 'HH vacancies search validation'), details: { endpoint: '/vacancies', status: response.status } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'HH API validation failed' };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const validation = await this.validateConfig(ctx.source.endpoint ?? {});
    return {
      state: validation.ok ? 'Healthy' : 'Failed',
      message: validation.message,
      checkedAt: new Date(),
      details: validation.details,
    };
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const baseUrl = typeof ctx.source.endpoint?.apiUrl === 'string' ? ctx.source.endpoint.apiUrl : 'https://api.hh.ru';
    const continuing = ctx.checkpoint.hasMore === true;
    const page = continuing ? this.nonNegativeInteger(ctx.checkpoint.page) ?? this.nonNegativeInteger(ctx.page) ?? 0 : 0;
    const perPage = continuing ? this.validPerPage(ctx.checkpoint.perPage) ?? this.validPerPage(ctx.source.limits?.perPage) ?? 50 : this.validPerPage(ctx.source.limits?.perPage) ?? 50;
    const windowTo = continuing ? this.checkpointDate(ctx.checkpoint.windowTo) ?? new Date() : new Date();
    const backfillDays = Math.min(Math.max(ctx.backfillDays, 1), 30);
    const backfillSince = continuing ? this.checkpointDate(ctx.checkpoint.backfillSince) ?? this.backfillSince(ctx.backfillSince, backfillDays, windowTo) : this.backfillSince(ctx.backfillSince, backfillDays, windowTo);
    const dateFrom = this.isoWithoutMs(backfillSince);
    const dateTo = this.isoWithoutMs(windowTo);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      date_from: dateFrom,
      date_to: dateTo,
      order_by: 'publication_time',
    });
    const response = await fetch(`${baseUrl}/vacancies?${params.toString()}`, {
      headers: this.headers(),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new ConnectorRateLimitError(`HH rate limit${retryAfter ? `; retry after ${retryAfter}` : ''}`, this.retryAfterSeconds(retryAfter));
    }
    if (!response.ok) {
      throw new Error(await this.errorMessage(response, 'HH vacancies search API'));
    }

    const payload = await this.vacancyPayload(response);
    const records = payload.items.map((item) => this.toRawRecord(item));
    const nextPage = payload.page + 1;
    const hasMore = nextPage < payload.pages && (nextPage + 1) * payload.per_page <= HH_SEARCH_DEPTH_LIMIT;
    const coverageLimitation = this.coverageLimitation(payload);
    return {
      records,
      checkpoint: {
        page: hasMore ? nextPage : 0,
        hasMore,
        perPage: hasMore ? payload.per_page : undefined,
        backfillSince: hasMore || coverageLimitation ? backfillSince.toISOString() : undefined,
        windowTo: hasMore || coverageLimitation ? windowTo.toISOString() : undefined,
        lastFetchedAt: new Date().toISOString(),
        dateFrom,
        dateTo,
        hhSearchDepthLimit: coverageLimitation ? HH_SEARCH_DEPTH_LIMIT : undefined,
        hhReachableResultLimit: coverageLimitation ? this.reachableResultLimit(payload.per_page) : undefined,
        coverageLimitation,
        incomplete: coverageLimitation ? true : undefined,
        limitation: coverageLimitation,
      },
      hasMore,
      nextPage: hasMore ? nextPage : undefined,
      stats: { seen: records.length },
    };
  }

  async fetchById(externalId: string, ctx: FetchContext): Promise<RawOpportunityRecord | null> {
    const baseUrl = typeof ctx.source.endpoint?.apiUrl === 'string' ? ctx.source.endpoint.apiUrl : 'https://api.hh.ru';
    const response = await fetch(`${baseUrl}/vacancies/${encodeURIComponent(externalId)}`, {
      headers: this.headers(),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await this.errorMessage(response, 'HH detail API'));
    const payload = (await response.json()) as HhVacancyListItem & { description?: string; key_skills?: Array<{ name: string }> };
    return this.toRawRecord(payload);
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private toRawRecord(item: HhVacancyListItem & { description?: string; key_skills?: Array<{ name: string }> }): RawOpportunityRecord {
    const publishedAt = this.parseDate(item.published_at ?? item.created_at);
    const description = item.description ?? [item.snippet?.requirement, item.snippet?.responsibility].filter(Boolean).join('\n\n');
    const skills = item.key_skills?.map((skill) => skill.name).filter(Boolean) ?? item.professional_roles?.map((role) => role.name ?? '').filter(Boolean) ?? [];
    return {
      externalId: item.id,
      url: item.alternate_url ?? `https://hh.ru/vacancy/${item.id}`,
      type: 'vacancy',
      title: item.name,
      companyOrClient: item.employer?.name,
      description,
      publishedAt,
      updatedAt: publishedAt,
      sourceStatus: item.archived ? 'Closed' : 'Active',
      rawPayload: item as unknown as Record<string, unknown>,
      sourceMetadata: {
        salary: item.salary ?? null,
        area: item.area?.name ?? null,
        employment: item.employment?.name ?? null,
        schedule: item.schedule?.name ?? null,
        skills,
      },
    };
  }

  private headers(): HeadersInit {
    const userAgent = process.env.HH_USER_AGENT ?? 'INTLY/1.0 (contact: admin@intly.local)';
    return {
      Accept: 'application/json',
      'User-Agent': userAgent,
      'HH-User-Agent': userAgent,
    };
  }

  private parseDate(value?: string): Date | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
  }

  private isoWithoutMs(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, '+0000');
  }

  private backfillSince(value: string | undefined, backfillDays: number, windowTo: Date): Date {
    const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) ? new Date(timestamp) : new Date(windowTo.getTime() - backfillDays * 86_400_000);
  }

  private checkpointDate(value: unknown): Date | undefined {
    if (typeof value !== 'string') return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
  }

  private nonNegativeInteger(value: unknown): number | undefined {
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isInteger(number) && number >= 0 ? number : undefined;
  }

  private validPerPage(value: unknown): number | undefined {
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(number) || number < 1) return undefined;
    return Math.min(Math.floor(number), 100);
  }

  private retryAfterSeconds(value: string | null): number {
    if (!value) return 60;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
    return 60;
  }

  private async vacancyPayload(response: Response): Promise<HhVacancyResponse> {
    const payload = (await response.json()) as unknown;
    if (!this.isVacancyResponse(payload)) throw new Error('HH vacancies search API returned malformed response');
    return payload;
  }

  private isVacancyResponse(value: unknown): value is HhVacancyResponse {
    if (!value || typeof value !== 'object') return false;
    const payload = value as HhVacancyResponse;
    return Array.isArray(payload.items) && Number.isInteger(payload.page) && payload.page >= 0 && Number.isInteger(payload.pages) && payload.pages >= 0 && Number.isInteger(payload.per_page) && payload.per_page > 0 && Number.isInteger(payload.found) && payload.found >= 0;
  }

  private coverageLimitation(payload: HhVacancyResponse): string | undefined {
    if (payload.found <= HH_SEARCH_DEPTH_LIMIT) return undefined;
    const reachable = this.reachableResultLimit(payload.per_page);
    return `HH public vacancy search reports ${payload.found} matches, but the official API limits pageable search depth to ${HH_SEARCH_DEPTH_LIMIT}; with per_page=${payload.per_page}, this cycle contains only the reachable first ${reachable} results for the fixed date window.`;
  }

  private reachableResultLimit(perPage: number): number {
    return Math.floor(HH_SEARCH_DEPTH_LIMIT / perPage) * perPage;
  }

  private async errorMessage(response: Response, context: string): Promise<string> {
    const payload = await this.errorPayload(response);
    const requestId = payload?.request_id ? ` request_id=${payload.request_id}` : '';
    const description = payload?.description ? `: ${payload.description}` : '';
    const errors = payload?.errors?.map((error) => [error.type, error.value].filter(Boolean).join(':')).filter(Boolean).join(', ');
    const suffix = errors ? `${description}; errors=${errors}` : description;
    if (response.status === 403) {
      return `${context} returned 403${suffix}; anonymous public vacancies search is not available from this environment or now requires additional access.${requestId}`;
    }
    return `${context} returned ${response.status}${suffix}${requestId}`;
  }

  private async errorPayload(response: Response): Promise<HhErrorResponse | undefined> {
    try {
      const payload = (await response.json()) as unknown;
      if (!payload || typeof payload !== 'object') return undefined;
      return payload as HhErrorResponse;
    } catch {
      return undefined;
    }
  }
}
