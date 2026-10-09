import { load } from 'cheerio';
import { fetch as undiciFetch } from 'undici';

import { createPinnedDispatcher } from '../extraction/pinned-fetch';
import { parseHttpUrl } from '../extraction/url-safety';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { firstTextLine, numberValue, stringValue } from './connector-utils';
import { fetchHackerNewsHiringPage, HnHiringComment } from './hackernews-hiring-feed';

type PublicApiId = 'remoteok' | 'remotive' | 'trudvsem' | 'superjob' | 'freelancehunt' | 'adzuna' | 'hackernews_whoishiring';

const REMOTEOK_FEED_URL = 'https://remoteok.com/api';
const REMOTIVE_FEED_URL = 'https://remotive.com/api/remote-jobs';

// Whole-second GET diagnostics reach 9,950 but fail at depth 10,000.
const TRUDVSEM_RESULT_DEPTH = 10_000;

type TrudvsemPartition = {
  modifiedFrom: string;
  modifiedTo: string;
};

type TrudvsemCurrentPartition = TrudvsemPartition & {
  page: number;
  providerTotal?: number;
  seenExternalIds: string[];
  lastPageExternalIds: string[];
};

type TrudvsemPartitionState = {
  modifiedFrom: string;
  modifiedTo: string;
  currentPartition: TrudvsemCurrentPartition;
  pendingPartitions: TrudvsemPartition[];
  completedThrough: string;
  completedPartitionCount: number;
  completedProviderRecords: number;
  splitCount: number;
  previousCoverage?: Record<string, unknown>;
};

type HttpOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

type FeedWindow = {
  from: Date;
  to: Date;
  fromIso: string;
  toIso: string;
};

export class PublicApiFeedConnector implements Connector {
  readonly family = 'OfficialRestApi' as const;

  constructor(readonly id: PublicApiId) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: this.requiresCredentials(), maxBackfillDays: 30 };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    const credentials = this.credentialsFromConfig(config);
    if (this.requiresCredentials() && !this.hasRequiredCredentials(credentials)) {
      return { ok: false, message: `${this.id} requires API credentials`, details: { state: 'NeedsConfiguration' } };
    }
    return { ok: true, message: `${this.id} API configured`, details: { state: this.requiresCredentials() ? 'Credentialed' : 'Public' } };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const validation = await this.validateConfig({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}), credentials: ctx.credentials });
    if (!validation.ok) {
      return { state: 'Disabled', message: validation.message, checkedAt: new Date(), details: validation.details };
    }
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
    if (this.id === 'remoteok') return this.fetchRemoteOk(ctx);
    if (this.id === 'remotive') return this.fetchRemotive(ctx);
    if (this.id === 'trudvsem') return this.fetchTrudvsem(ctx);
    if (this.id === 'superjob') return this.fetchSuperJob(ctx);
    if (this.id === 'freelancehunt') return this.fetchFreelancehunt(ctx);
    if (this.id === 'adzuna') return this.fetchAdzuna(ctx);
    return this.fetchHackerNewsWhoIsHiring(ctx);
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  /** Replay one retained native record through the ingestion mapper, without fetching or window filtering. */
  mapRetainedPayload(rawPayload: Record<string, unknown>): RawOpportunityRecord {
    if (this.id !== 'remoteok' && this.id !== 'remotive' && this.id !== 'trudvsem') throw new Error(`Retained payload replay is unsupported for ${this.id}`);
    if (!this.isRecord(rawPayload)) throw new Error(`${this.id} retained payload must be a native record object`);
    if (this.id === 'remoteok') return this.remoteOkRecord(rawPayload);
    if (this.id === 'remotive') return this.remotiveRecord(rawPayload);
    return this.trudvsemRecord(rawPayload);
  }

  private async fetchRemoteOk(ctx: FetchContext): Promise<FetchPage> {
    const payload = await this.getJson<unknown>(REMOTEOK_FEED_URL, {
      headers: { Accept: 'application/json', 'User-Agent': process.env.REMOTEOK_USER_AGENT ?? 'INTLY/1.0' },
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    const { items, metadata } = this.remoteOkItems(payload);
    const window = this.feedWindow(ctx);
    const records = this.dedupRecords(items.map((item) => this.remoteOkRecord(item)).filter((record) => this.withinFeedWindow(record, window)));
    return this.finiteFeedPage('remoteok', records, items.length, window, metadata);
  }

  private remoteOkRecord(item: Record<string, unknown>): RawOpportunityRecord {
    const id = this.requiredText(item.id, 'remoteok job id');
    const title = stringValue(item.position) ?? stringValue(item.title);
    const description = stringValue(item.description);
    if (!title) throw new Error(`remoteok job ${id} is missing required title`);
    if (!description) throw new Error(`remoteok job ${id} is missing required description`);
    const publishedAt = this.zonedDate(item.date) ?? this.unixDate(item.epoch);
    const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    const salary = this.remoteOkSalary(item);
    const rawSalary = this.remoteOkRawSalary(item);
    const location = stringValue(item.location);
    return {
      externalId: id,
      url: stringValue(item.url) ?? stringValue(item.apply_url) ?? `https://remoteok.com/remote-jobs/${id}`,
      type: 'vacancy',
      title,
      companyOrClient: stringValue(item.company),
      description,
      publishedAt,
      sourceStatus: 'Active',
      rawPayload: item,
      sourceMetadata: this.omitUndefined({
        ...(salary ? { salary } : {}),
        ...(rawSalary ? { rawSalary } : {}),
        area: location,
        location,
        locations: location ? [location] : undefined,
        skills: tags,
        tags,
        remoteType: 'remote',
        sourceDateRaw: stringValue(item.date),
        sourceUrl: REMOTEOK_FEED_URL,
      }),
    };
  }

  private async fetchRemotive(ctx: FetchContext): Promise<FetchPage> {
    const payload = await this.getJson<unknown>(REMOTIVE_FEED_URL, {
      headers: { Accept: 'application/json' },
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    const { jobs, metadata } = this.remotiveItems(payload);
    const window = this.feedWindow(ctx);
    const records = this.dedupRecords(jobs.map((item) => this.remotiveRecord(item)).filter((record) => this.withinFeedWindow(record, window)));
    return this.finiteFeedPage('remotive', records, jobs.length, window, metadata);
  }

  private remotiveRecord(item: Record<string, unknown>): RawOpportunityRecord {
    const id = this.requiredText(item.id, 'remotive job id');
    const title = stringValue(item.title);
    const description = stringValue(item.description);
    if (!title) throw new Error(`remotive job ${id} is missing required title`);
    if (!description) throw new Error(`remotive job ${id} is missing required description`);
    const publicationDateRaw = stringValue(item.publication_date);
    const publishedAt = this.zonedDate(publicationDateRaw);
    const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0) : [];
    const category = stringValue(item.category);
    const candidateLocation = stringValue(item.candidate_required_location);
    return {
      externalId: id,
      url: stringValue(item.url) ?? `https://remotive.com/remote-jobs/${id}`,
      type: 'vacancy',
      title,
      companyOrClient: stringValue(item.company_name),
      description,
      publishedAt,
      sourceStatus: 'Active',
      rawPayload: item,
      sourceMetadata: this.omitUndefined({
        salary: this.originalTextSalary(item.salary),
        area: candidateLocation,
        location: candidateLocation,
        locations: candidateLocation ? [candidateLocation] : undefined,
        employment: stringValue(item.job_type),
        skills: tags,
        tags,
        category,
        remoteType: 'remote',
        publicationDateRaw,
        publicationDateTimezone: publicationDateRaw && !publishedAt ? 'unspecified' : undefined,
        sourceUrl: REMOTIVE_FEED_URL,
      }),
    };
  }

  private async fetchTrudvsem(ctx: FetchContext): Promise<FetchPage> {
    const limit = this.trudvsemRequestedLimit(ctx);
    const state = this.trudvsemPartitionState(ctx, limit);
    const current = state.currentPartition;
    const params = new URLSearchParams({ offset: String(current.page), limit: String(limit) });
    const searchText = stringValue(ctx.source.config?.searchText);
    if (searchText) params.set('text', searchText);
    params.set('modifiedFrom', current.modifiedFrom);
    params.set('modifiedTo', current.modifiedTo);
    const payload = await this.getJson<Record<string, unknown>>(`https://opendata.trudvsem.ru/api/v1/vacancies?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    this.assertTrudvsemSuccess(payload);
    const pageInfo = this.trudvsemPageInfo(payload, limit);
    const items = this.trudvsemItems(payload, pageInfo.total);
    this.assertTrudvsemPageProgress(current, pageInfo, items);
    // Probe pages still have to satisfy native identity/title/URL validation.
    const nativeRecords = items.map((item) => this.trudvsemRecord(item));
    const nativeIds = nativeRecords.map((record) => record.externalId);
    let records: RawOpportunityRecord[] = [];
    let nextPartition: TrudvsemCurrentPartition | undefined;

    // Equal modification timestamps have empirically unstable page membership.
    // A leaf must fit in one response: offset pagination cannot prove coverage,
    // even when successive pages happen to contain no repeated native IDs.
    if (pageInfo.total > limit) {
      const from = Date.parse(current.modifiedFrom);
      const to = Date.parse(current.modifiedTo);
      // A full second of overlap also covers a split when both provider bounds
      // are exclusive. At <=2 seconds that overlap cannot shrink both children.
      if (to - from <= 2_000) {
        throw new Error(`trudvsem unsplittable whole-second interval ${current.modifiedFrom} to ${current.modifiedTo} has ${pageInfo.total} records, beyond safe single-response limit ${limit}; coverage remains incomplete`);
      }
      const midpoint = from + Math.floor((to - from) / 2_000) * 1_000;
      state.pendingPartitions.unshift({ modifiedFrom: this.isoSeconds(new Date(midpoint)), modifiedTo: current.modifiedTo });
      nextPartition = this.trudvsemFreshPartition({ modifiedFrom: current.modifiedFrom, modifiedTo: this.isoSeconds(new Date(midpoint + 1_000)) });
      state.splitCount += 1;
    } else {
      if (new Set(nativeIds).size !== nativeIds.length) {
        throw new Error('trudvsem API repeated vacancy ids within single response; coverage remains incomplete');
      }
      const window = { from: new Date(state.modifiedFrom), to: new Date(state.modifiedTo), fromIso: state.modifiedFrom, toIso: state.modifiedTo };
      records = nativeRecords.filter((record) => this.withinFeedWindow(record, window));
      state.completedThrough = current.modifiedTo;
      state.completedPartitionCount += 1;
      state.completedProviderRecords += pageInfo.total;
      const pending = state.pendingPartitions.shift();
      nextPartition = pending ? this.trudvsemFreshPartition(pending) : undefined;
    }

    const hasMore = Boolean(nextPartition);
    return {
      records,
      checkpoint: this.omitUndefined({
        version: 4,
        page: nextPartition?.page ?? 0,
        hasMore,
        modifiedFrom: state.modifiedFrom,
        modifiedTo: state.modifiedTo,
        currentPartition: nextPartition ?? null,
        pendingPartitions: state.pendingPartitions,
        completedThrough: state.completedThrough,
        completedPartitionCount: state.completedPartitionCount,
        // Provider observations include overlap; native source identity upserts
        // may report repeated boundary vacancies as updates, not new vacancies.
        completedProviderRecords: state.completedProviderRecords,
        splitCount: state.splitCount,
        previousCoverage: state.previousCoverage,
        coverageMethod: 'single-response-date-partitions',
        lastFetchedAt: new Date().toISOString(),
        providerTotal: pageInfo.total,
        providerLimit: pageInfo.limit,
        observedScope: 'trudvsem-modified-window',
        terminalReason: hasMore ? undefined : 'all-date-partitions-exhausted',
      }),
      hasMore,
      nextPage: nextPartition?.page,
      stats: { seen: items.length },
    };
  }

  private trudvsemRecord(item: Record<string, unknown>): RawOpportunityRecord {
    const id = this.requiredText(item.id ?? item['vacancy_id'] ?? item.source_id, 'trudvsem vacancy id');
    const title = stringValue(item['job-name']) ?? stringValue(item.job_name) ?? stringValue(item.name);
    if (!title) throw new Error(`trudvsem vacancy ${id} is missing required title`);
    const company = this.recordValue(item.company);
    const region = this.recordValue(item.region);
    const requirement = this.recordValue(item.requirement);
    const locations = this.trudvsemLocations(item);
    const locationText = this.dedup(locations.map((location) => stringValue(location.location)).filter((value): value is string => Boolean(value)));
    const location = locationText.join(', ') || stringValue(region?.name) || stringValue(item.regionName);
    const schedule = stringValue(item.schedule);
    const description = [
      stringValue(item.duty),
      stringValue(item.requirements),
      stringValue(item.qualification),
      stringValue(item.benefit),
      stringValue(item.conditions),
      stringValue(item.description),
    ].filter((value): value is string => Boolean(value)).join('\n\n');
    const companyCode = stringValue(company?.companycode);
    return {
      externalId: id,
      url: this.trudvsemUrl(item, id, companyCode),
      type: 'vacancy',
      title,
      companyOrClient: stringValue(company?.name) ?? stringValue(item.company_name),
      description,
      publishedAt: this.date(item['creation-date']) ?? this.date(item.creation_date) ?? this.date(item.date_create),
      updatedAt: this.date(item.date_modify) ?? this.date(item.modify_date),
      sourceStatus: 'Active',
      rawPayload: item,
      sourceMetadata: this.omitUndefined({
        observedScope: 'trudvsem-modified-window',
        scopeLimitation: 'Filtered by Trudvsem modifiedFrom/modifiedTo window; provider does not prove complete platform snapshot order.',
        area: location,
        location,
        regionName: stringValue(region?.name) ?? stringValue(item.regionName),
        regionCode: stringValue(region?.region_code),
        locations: locations.length > 0 ? locations.map((location) => this.omitUndefined({
          label: stringValue(location.location),
          location: stringValue(location.location),
          lng: stringValue(location.lng),
          lat: stringValue(location.lat),
        })) : undefined,
        salary: this.omitUndefined({ min: numberValue(item.salary_min), max: numberValue(item.salary_max), currency: this.trudvsemCurrency(item.currency), originalText: stringValue(item.salary) }),
        nativeCurrencyText: stringValue(item.currency),
        employment: stringValue(item.employment),
        nativeSchedule: schedule,
        remoteType: schedule && /^удал[её]нная работа$/iu.test(schedule) ? 'Remote' : undefined,
        skills: this.trudvsemSkills(item.skills),
        vacancyData: this.omitUndefined({
          schedule,
          employment: stringValue(item.employment),
          qualification: stringValue(item.qualification),
          requirements: stringValue(item.requirements),
          education: stringValue(requirement?.education),
          experience: numberValue(requirement?.experience),
          companyCode,
          regionCode: stringValue(region?.region_code),
          category: stringValue(this.recordValue(item.category)?.specialisation),
          typicalPosition: stringValue(item.typicalPosition),
          workPlaces: numberValue(item.work_places),
        }),
      }),
    };
  }

  private async fetchSuperJob(ctx: FetchContext): Promise<FetchPage> {
    const apiKey = this.credential(ctx, ['apiKey', 'xApiAppId', 'appId']);
    if (!apiKey) throw new Error('superjob requires API credentials');
    const page = Math.max(0, ctx.page ?? (ctx.checkpoint.hasMore === true ? Number(ctx.checkpoint.page ?? 0) : 0));
    const count = Math.min(Number(ctx.source.limits?.perPage ?? 50), 100);
    const params = new URLSearchParams({ page: String(page), count: String(count), date_published_from: String(Math.floor(this.cutoff(ctx) / 1000)) });
    const keyword = stringValue(ctx.source.config?.searchText);
    if (keyword) params.set('keyword', keyword);
    const payload = await this.getJson<Record<string, unknown>>(`https://api.superjob.ru/2.0/vacancies/?${params.toString()}`, {
      headers: { Accept: 'application/json', 'X-Api-App-Id': apiKey },
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    const objects = Array.isArray(payload.objects) ? payload.objects.filter(this.isRecord) : [];
    const records = objects.map((item) => this.superJobRecord(item));
    const more = payload.more === true;
    return { records, checkpoint: { page: more ? page + 1 : 0, hasMore: more, lastFetchedAt: new Date().toISOString() }, hasMore: more, nextPage: more ? page + 1 : undefined, stats: { seen: objects.length } };
  }

  private superJobRecord(item: Record<string, unknown>): RawOpportunityRecord {
    const town = this.recordValue(item.town);
    return {
      externalId: String(item.id ?? this.hashFallback(item)),
      url: stringValue(item.link) ?? `https://www.superjob.ru/vakansii/${item.id}.html`,
      type: 'vacancy',
      title: stringValue(item.profession) ?? 'Untitled',
      companyOrClient: stringValue(item.firm_name),
      description: stringValue(item.candidat) ?? stringValue(item.work),
      publishedAt: this.unixDate(item.date_published),
      sourceStatus: 'Active',
      rawPayload: item,
      sourceMetadata: {
        area: stringValue(town?.title),
        salary: { min: numberValue(item.payment_from), max: numberValue(item.payment_to), currency: stringValue(item.currency) },
        employment: stringValue(item.type_of_work?.toString()),
      },
    };
  }

  private async fetchFreelancehunt(ctx: FetchContext): Promise<FetchPage> {
    const token = this.credential(ctx, ['token', 'accessToken', 'apiToken']);
    if (!token) throw new Error('freelancehunt requires API credentials');
    const page = Math.max(1, ctx.page ?? (ctx.checkpoint.hasMore === true ? Number(ctx.checkpoint.page ?? 1) : 1));
    const payload = await this.getJson<{ data?: Array<Record<string, unknown>>; links?: Record<string, unknown> }>(`https://api.freelancehunt.com/v2/projects?page[number]=${page}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    const cutoff = this.cutoff(ctx);
    const items = (payload.data ?? []).filter(this.isRecord);
    const records = items.map((item) => this.freelancehuntRecord(item)).filter((record) => this.withinBackfill(record, cutoff));
    const next = stringValue(payload.links?.next);
    return { records, checkpoint: { page: next ? page + 1 : 1, hasMore: Boolean(next), lastFetchedAt: new Date().toISOString() }, hasMore: Boolean(next), nextPage: next ? page + 1 : undefined, stats: { seen: items.length } };
  }

  private freelancehuntRecord(item: Record<string, unknown>): RawOpportunityRecord {
    const attributes = this.recordValue(item.attributes) ?? {};
    const budget = this.recordValue(attributes.budget);
    const skills = Array.isArray(attributes.skills) ? attributes.skills.map((skill) => stringValue(this.recordValue(skill)?.name) ?? stringValue(skill)).filter((skill): skill is string => Boolean(skill)) : [];
    const links = this.recordValue(item.links);
    return {
      externalId: String(item.id ?? this.hashFallback(item)),
      url: stringValue(links?.self) ?? `https://freelancehunt.com/project/${item.id}.html`,
      type: 'freelance',
      title: stringValue(attributes.name) ?? 'Untitled',
      companyOrClient: stringValue(this.recordValue(attributes.employer)?.login),
      description: stringValue(attributes.description),
      publishedAt: this.date(attributes.published_at),
      sourceStatus: 'Active',
      rawPayload: item,
      sourceMetadata: { budget, skills, status: stringValue(attributes.status) },
    };
  }

  private async fetchAdzuna(ctx: FetchContext): Promise<FetchPage> {
    const appId = this.credential(ctx, ['appId', 'app_id']);
    const appKey = this.credential(ctx, ['appKey', 'app_key', 'apiKey']);
    if (!appId || !appKey) throw new Error('adzuna requires API credentials');
    const country = stringValue(ctx.source.config?.country) ?? this.credential(ctx, ['country']) ?? 'gb';
    const page = Math.max(1, ctx.page ?? (ctx.checkpoint.hasMore === true ? Number(ctx.checkpoint.page ?? 1) : 1));
    const perPage = Math.min(Number(ctx.source.limits?.perPage ?? 50), 50);
    const params = new URLSearchParams({ app_id: appId, app_key: appKey, results_per_page: String(perPage), max_days_old: String(Math.min(ctx.backfillDays, 30)), content_type: 'application/json' });
    const what = stringValue(ctx.source.config?.searchText);
    if (what) params.set('what', what);
    const payload = await this.getJson<Record<string, unknown>>(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/${page}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    const results = Array.isArray(payload.results) ? payload.results.filter(this.isRecord) : [];
    const records = results.map((item) => this.adzunaRecord(item)).filter((record) => this.withinBackfill(record, this.cutoff(ctx)));
    const total = numberValue(payload.count) ?? 0;
    const hasMore = page * perPage < total;
    return { records, checkpoint: { page: hasMore ? page + 1 : 1, hasMore, lastFetchedAt: new Date().toISOString() }, hasMore, nextPage: hasMore ? page + 1 : undefined, stats: { seen: results.length } };
  }

  private adzunaRecord(item: Record<string, unknown>): RawOpportunityRecord {
    const company = this.recordValue(item.company);
    const location = this.recordValue(item.location);
    return {
      externalId: String(item.id ?? this.hashFallback(item)),
      url: stringValue(item.redirect_url) ?? stringValue(item.adref) ?? 'https://www.adzuna.com',
      type: 'vacancy',
      title: stringValue(item.title) ?? 'Untitled',
      companyOrClient: stringValue(company?.display_name),
      description: stringValue(item.description),
      publishedAt: this.date(item.created),
      sourceStatus: 'Active',
      rawPayload: item,
      sourceMetadata: {
        area: stringValue(location?.display_name),
        salary: { min: numberValue(item.salary_min), max: numberValue(item.salary_max), currency: stringValue(item.salary_currency) },
        category: stringValue(this.recordValue(item.category)?.label),
      },
    };
  }

  private async fetchHackerNewsWhoIsHiring(ctx: FetchContext): Promise<FetchPage> {
    const options = () => ({ signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000) });
    return fetchHackerNewsHiringPage(ctx, {
      profile: () => this.getJson<unknown>('https://hacker-news.firebaseio.com/v0/user/whoishiring.json', options()),
      item: (id) => this.getJson<unknown>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, options()),
      record: (item, threadId) => this.hnCommentRecord(item, threadId),
    });
  }

  private hnCommentRecord(item: HnHiringComment, threadId: number): RawOpportunityRecord {
    const text = this.htmlToText(item.text);
    return {
      externalId: String(item.id),
      url: `https://news.ycombinator.com/item?id=${item.id}`,
      type: 'vacancy',
      title: firstTextLine(text, 'Hacker News Who Is Hiring post'),
      description: text,
      publishedAt: this.unixDate(item.time),
      sourceStatus: 'Active',
      rawPayload: item as unknown as Record<string, unknown>,
      sourceMetadata: { threadId, by: item.by, parent: item.parent, sourceUrl: `https://news.ycombinator.com/item?id=${threadId}` },
    };
  }

  private remoteOkItems(payload: unknown): { items: Record<string, unknown>[]; metadata: Record<string, unknown> } {
    if (!Array.isArray(payload)) throw new Error('remoteok API returned malformed payload: expected array');
    const metadata: Record<string, unknown> = {};
    const items: Record<string, unknown>[] = [];
    for (const [index, value] of payload.entries()) {
      const item = this.recordValue(value);
      if (!item) throw new Error(`remoteok API returned malformed item at index ${index}`);
      if (index === 0 && !item.id && (item.legal || item.last_updated || item.total)) {
        Object.assign(metadata, item);
        continue;
      }
      if (!item.id) throw new Error(`remoteok API item at index ${index} is missing required id`);
      items.push(item);
    }
    return { items, metadata };
  }

  private remotiveItems(payload: unknown): { jobs: Record<string, unknown>[]; metadata: Record<string, unknown> } {
    const root = this.recordValue(payload);
    if (!root) throw new Error('remotive API returned malformed payload: expected object');
    if (!Array.isArray(root.jobs)) throw new Error('remotive API returned malformed payload: jobs must be an array');
    const declaredCount = numberValue(root['job-count']) ?? numberValue(root['0-job-count']);
    if (typeof declaredCount === 'number' && declaredCount !== root.jobs.length) {
      throw new Error(`remotive API declared job-count ${declaredCount} but returned ${root.jobs.length} jobs`);
    }
    return {
      jobs: root.jobs.map((item, index) => {
        const record = this.recordValue(item);
        if (!record) throw new Error(`remotive API returned malformed job at index ${index}`);
        return record;
      }),
      metadata: this.omitUndefined({
        'job-count': declaredCount,
        legalNotice: root.legalNotice,
        generatedAt: root.generatedAt,
      }),
    };
  }

  private finiteFeedPage(provider: 'remoteok' | 'remotive', records: RawOpportunityRecord[], seen: number, window: FeedWindow, nativeFeedMetadata: Record<string, unknown>): FetchPage {
    return {
      records,
      checkpoint: this.omitUndefined({
        provider,
        scope: 'official-public-finite-feed',
        hasMore: false,
        windowFrom: window.fromIso,
        backfillSince: window.fromIso,
        windowTo: window.toIso,
        seen,
        retained: records.length,
        nativeFeedMetadata: Object.keys(nativeFeedMetadata).length ? nativeFeedMetadata : undefined,
        terminalReason: 'finite-feed-exhausted',
        lastFetchedAt: new Date().toISOString(),
      }),
      hasMore: false,
      stats: { seen },
    };
  }

  private dedupRecords(records: RawOpportunityRecord[]): RawOpportunityRecord[] {
    const seen = new Set<string>();
    const deduped: RawOpportunityRecord[] = [];
    for (const record of records) {
      if (seen.has(record.externalId)) continue;
      seen.add(record.externalId);
      deduped.push(record);
    }
    return deduped;
  }

  private remoteOkSalary(item: Record<string, unknown>): Record<string, unknown> | undefined {
    const min = numberValue(item.salary_min);
    const max = numberValue(item.salary_max);
    const currency = stringValue(item.salary_currency) ?? stringValue(item.currency);
    const period = stringValue(item.salary_period) ?? stringValue(item.period);
    const hasMin = typeof min === 'number' && min > 0;
    const hasMax = typeof max === 'number' && max > 0;
    if (!hasMin && !hasMax) return undefined;
    return this.omitUndefined({ min: hasMin ? min : undefined, max: hasMax ? max : undefined, currency, period });
  }

  private remoteOkRawSalary(item: Record<string, unknown>): Record<string, unknown> | undefined {
    const min = numberValue(item.salary_min);
    const max = numberValue(item.salary_max);
    const hasMin = typeof min === 'number' && min > 0;
    const hasMax = typeof max === 'number' && max > 0;
    if (!hasMin && !hasMax) return undefined;
    return this.omitUndefined({
      salary_min: hasMin ? min : undefined,
      salary_max: hasMax ? max : undefined,
      salary_currency: stringValue(item.salary_currency) ?? stringValue(item.currency),
      salary_period: stringValue(item.salary_period) ?? stringValue(item.period),
    });
  }

  private originalTextSalary(value: unknown): Record<string, unknown> | undefined {
    const originalText = stringValue(value);
    return originalText ? { originalText } : undefined;
  }

  private requiredText(value: unknown, label: string): string {
    const text = stringValue(value) ?? (typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined);
    if (!text) throw new Error(`${this.id} API item is missing required ${label}`);
    return text;
  }

  private async getJson<T>(urlText: string, options: HttpOptions = {}, redirects = 0): Promise<T> {
    if (redirects > 3) throw new Error(`${this.id} API redirected too many times`);
    const url = parseHttpUrl(urlText);
    const dispatcher = await createPinnedDispatcher(url);
    try {
      const response = await undiciFetch(url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        dispatcher,
        redirect: 'manual',
        signal: options.signal ?? AbortSignal.timeout(30_000),
      } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new ConnectorRateLimitError(`${this.id} rate limit${retryAfter ? `; retry after ${retryAfter}s` : ''}`, Number(retryAfter ?? 60));
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`${this.id} API redirect is missing location`);
        return this.getJson<T>(new URL(location, url).toString(), options, redirects + 1);
      }
      if (!response.ok) throw new Error(`${this.id} API returned ${response.status}`);
      return response.json() as Promise<T>;
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }

  private requiresCredentials(): boolean {
    return this.id === 'superjob' || this.id === 'freelancehunt' || this.id === 'adzuna';
  }

  private hasRequiredCredentials(credentials?: Record<string, unknown>): boolean {
    if (!this.requiresCredentials()) return true;
    if (this.id === 'superjob') return Boolean(this.credentialValue(credentials, ['apiKey', 'xApiAppId', 'appId']));
    if (this.id === 'freelancehunt') return Boolean(this.credentialValue(credentials, ['token', 'accessToken', 'apiToken']));
    if (this.id === 'adzuna') return Boolean(this.credentialValue(credentials, ['appId', 'app_id']) && this.credentialValue(credentials, ['appKey', 'app_key', 'apiKey']));
    return false;
  }

  private credentialsFromConfig(config: Record<string, unknown>): Record<string, unknown> | undefined {
    const credentials = this.recordValue(config.credentials);
    return credentials ?? config;
  }

  private credential(ctx: FetchContext, keys: string[]): string | undefined {
    return this.credentialValue(ctx.credentials, keys);
  }

  private credentialValue(credentials: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    if (!credentials) return undefined;
    for (const key of keys) {
      const value = stringValue(credentials[key]);
      if (value) return value;
    }
    return undefined;
  }

  private arrayAt(value: Record<string, unknown>, path: string[]): unknown[] {
    let current: unknown = value;
    for (const key of path) current = this.recordValue(current)?.[key];
    return Array.isArray(current) ? current : [];
  }

  private recordAt(value: unknown, path: string[]): Record<string, unknown> | undefined {
    let current = value;
    for (const key of path) current = this.recordValue(current)?.[key];
    return this.recordValue(current);
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return this.isRecord(value) ? value : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  private assertTrudvsemSuccess(payload: Record<string, unknown>): void {
    const status = stringValue(payload.status);
    if (!status) {
      throw new Error('trudvsem API response is missing body status');
    }
    if (status && !/^200$|^ok$/i.test(status)) {
      throw new Error(`trudvsem API returned body status ${status}`);
    }
    const error = stringValue(payload.error) ?? stringValue(payload.message);
    if (error && status && !/^200$|^ok$/i.test(status)) {
      throw new Error(`trudvsem API returned ${status}: ${error}`);
    }
  }

  private trudvsemPageCursor(value: unknown): number {
    const page = value === undefined ? 0 : value;
    if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 0) throw new Error(`trudvsem page cursor ${String(value)} is malformed`);
    return page;
  }

  private trudvsemRequestedLimit(ctx: FetchContext): number {
    const raw = ctx.source.limits?.perPage ?? 50;
    const perPage = Number(raw);
    if (!Number.isSafeInteger(perPage) || perPage <= 0) throw new Error(`trudvsem perPage limit ${String(raw)} is malformed`);
    return Math.min(perPage, 100);
  }

  private trudvsemPartitionState(ctx: FetchContext, limit: number): TrudvsemPartitionState {
    // Queue page counters from v2/v3 must never replace an internal cursor.
    if (ctx.page !== undefined) this.trudvsemPageCursor(ctx.page);
    const checkpoint = ctx.checkpoint;
    if (checkpoint.version !== undefined && checkpoint.version !== 2 && checkpoint.version !== 3 && checkpoint.version !== 4) {
      throw new Error(`trudvsem checkpoint version ${String(checkpoint.version)} is unsupported`);
    }
    const continuation = checkpoint.hasMore === true;
    if (checkpoint.hasMore !== undefined && typeof checkpoint.hasMore !== 'boolean') throw new Error('trudvsem checkpoint hasMore is malformed');
    if ((checkpoint.version === 3 || checkpoint.version === 4) && typeof checkpoint.hasMore !== 'boolean') throw new Error('trudvsem versioned checkpoint hasMore is missing');
    if (continuation && checkpoint.version === 4) {
      const state = this.trudvsemResumePartitions(checkpoint, limit);
      if (state.currentPartition.page !== 0 || checkpoint.coverageMethod !== 'single-response-date-partitions' || state.completedProviderRecords > state.completedPartitionCount * limit) {
        throw new Error('trudvsem v4 checkpoint has unsafe pagination or inconsistent single-response coverage');
      }
      state.previousCoverage = this.trudvsemPreviousCoverage(checkpoint.previousCoverage, state.modifiedFrom, state.modifiedTo);
      return state;
    }
    if (checkpoint.version === 3 || checkpoint.version === 4) {
      if (continuation) this.trudvsemResumePartitions(checkpoint, limit);
      else this.trudvsemValidateTerminal(checkpoint, checkpoint.version === 4 ? limit : TRUDVSEM_RESULT_DEPTH);
    }

    const replayV3 = checkpoint.version === 3;
    const legacyPage = this.trudvsemPageCursor(continuation ? checkpoint.page ?? ctx.page : ctx.page);
    if (continuation && legacyPage > 0 && (checkpoint.modifiedFrom === undefined || checkpoint.modifiedTo === undefined)) {
      throw new Error('trudvsem legacy continuation is missing frozen modifiedFrom/modifiedTo bounds');
    }
    if (continuation && checkpoint.providerLimit !== undefined && checkpoint.providerLimit !== limit) {
      throw new Error('trudvsem checkpoint providerLimit differs from configured perPage');
    }
    const frozen = continuation || replayV3;
    const modifiedFrom = frozen && checkpoint.modifiedFrom !== undefined
      ? this.trudvsemBound(checkpoint.modifiedFrom, 'modifiedFrom')
      : ctx.backfillSince !== undefined ? this.trudvsemBound(ctx.backfillSince, 'backfillSince') : this.backfillSince(ctx).toISOString();
    const modifiedTo = frozen && checkpoint.modifiedTo !== undefined
      ? this.trudvsemBound(checkpoint.modifiedTo, 'modifiedTo')
      : new Date().toISOString();
    if (Date.parse(modifiedFrom) > Date.parse(modifiedTo)) throw new Error('trudvsem modifiedFrom is after modifiedTo');
    const initial = { modifiedFrom: this.isoSeconds(new Date(modifiedFrom)), modifiedTo: this.isoSeconds(new Date(modifiedTo)) };
    let previousCoverage: Record<string, unknown> | undefined;
    if (replayV3 || (continuation && checkpoint.version !== 4)) {
      const previousPartition = this.recordValue(checkpoint.currentPartition);
      previousCoverage = this.omitUndefined({
        version: checkpoint.version ?? 2,
        coverageProof: 'unverified-multi-page-observations',
        modifiedFrom, modifiedTo,
        page: previousPartition?.page ?? checkpoint.page ?? 0,
        completedThrough: checkpoint.completedThrough,
        completedPartitionCount: checkpoint.completedPartitionCount,
        completedProviderRecords: checkpoint.completedProviderRecords,
        partitionModifiedFrom: previousPartition?.modifiedFrom,
        partitionModifiedTo: previousPartition?.modifiedTo,
        providerTotal: previousPartition?.providerTotal ?? checkpoint.providerTotal,
        seenExternalIds: previousPartition?.seenExternalIds ?? [],
        lastPageExternalIds: previousPartition?.lastPageExternalIds ?? checkpoint.lastPageExternalIds ?? [],
      });
      previousCoverage = this.trudvsemPreviousCoverage(previousCoverage, modifiedFrom, modifiedTo);
    }
    // Replay ALL v2/v3 observations, including previously completed intervals.
    // Those offsets can omit tied IDs without repeating any ID. Existing source
    // identity upserts preserve earlier records and report the replay as updates.
    return {
      modifiedFrom, modifiedTo,
      currentPartition: this.trudvsemFreshPartition(initial),
      pendingPartitions: [],
      completedThrough: initial.modifiedFrom,
      completedPartitionCount: 0,
      completedProviderRecords: 0,
      splitCount: 0,
      previousCoverage,
    };
  }

  private trudvsemPreviousCoverage(value: unknown, modifiedFrom: string, modifiedTo: string): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    const history = this.recordValue(value);
    if (!history || (history.version !== 2 && history.version !== 3) || history.coverageProof !== 'unverified-multi-page-observations' || history.modifiedFrom !== modifiedFrom || history.modifiedTo !== modifiedTo) {
      throw new Error('trudvsem checkpoint previousCoverage is malformed or differs from frozen bounds');
    }
    this.trudvsemPageCursor(history.page);
    const seenExternalIds = this.trudvsemCheckpointIds(history.seenExternalIds, 'historical seenExternalIds');
    const lastPageExternalIds = this.trudvsemCheckpointIds(history.lastPageExternalIds, 'historical lastPageExternalIds');
    if (history.completedPartitionCount !== undefined) this.trudvsemCheckpointCount(history.completedPartitionCount, 'historical completedPartitionCount');
    if (history.completedProviderRecords !== undefined) this.trudvsemCheckpointCount(history.completedProviderRecords, 'historical completedProviderRecords');
    if (history.providerTotal !== undefined) this.trudvsemCheckpointCount(history.providerTotal, 'historical providerTotal');
    if (history.completedThrough !== undefined) this.trudvsemBound(history.completedThrough, 'historical completedThrough', true);
    if (history.partitionModifiedFrom !== undefined || history.partitionModifiedTo !== undefined) {
      this.trudvsemPartitionBounds({ modifiedFrom: history.partitionModifiedFrom, modifiedTo: history.partitionModifiedTo }, this.isoSeconds(new Date(modifiedFrom)), this.isoSeconds(new Date(modifiedTo)));
    }
    // Reconstruct known fields to prevent an unbounded nested legacy checkpoint.
    return this.omitUndefined({
      version: history.version, coverageProof: history.coverageProof,
      modifiedFrom, modifiedTo, page: history.page,
      completedThrough: history.completedThrough,
      completedPartitionCount: history.completedPartitionCount,
      completedProviderRecords: history.completedProviderRecords,
      partitionModifiedFrom: history.partitionModifiedFrom,
      partitionModifiedTo: history.partitionModifiedTo,
      providerTotal: history.providerTotal,
      seenExternalIds, lastPageExternalIds,
    });
  }

  private trudvsemResumePartitions(checkpoint: Record<string, unknown>, limit: number): TrudvsemPartitionState {
    const modifiedFrom = this.trudvsemBound(checkpoint.modifiedFrom, 'modifiedFrom');
    const modifiedTo = this.trudvsemBound(checkpoint.modifiedTo, 'modifiedTo');
    if (Date.parse(modifiedFrom) > Date.parse(modifiedTo)) throw new Error('trudvsem modifiedFrom is after modifiedTo');
    if (checkpoint.providerLimit !== limit) throw new Error('trudvsem checkpoint providerLimit differs from configured perPage');
    const outerFrom = this.isoSeconds(new Date(modifiedFrom));
    const outerTo = this.isoSeconds(new Date(modifiedTo));
    const partitionValue = this.recordValue(checkpoint.currentPartition);
    if (!partitionValue) throw new Error('trudvsem checkpoint currentPartition is malformed');
    const bounds = this.trudvsemPartitionBounds(partitionValue, outerFrom, outerTo);
    const page = this.trudvsemPageCursor(partitionValue.page);
    if (partitionValue.page === undefined || checkpoint.page !== page || page * limit >= TRUDVSEM_RESULT_DEPTH) {
      throw new Error('trudvsem checkpoint partition page cursor is inconsistent or beyond accessible depth');
    }
    const seenExternalIds = this.trudvsemCheckpointIds(partitionValue.seenExternalIds, 'seenExternalIds');
    const lastPageExternalIds = this.trudvsemCheckpointIds(partitionValue.lastPageExternalIds, 'lastPageExternalIds');
    const providerTotal = partitionValue.providerTotal;
    if (page === 0) {
      if (providerTotal !== undefined || seenExternalIds.length !== 0 || lastPageExternalIds.length !== 0) throw new Error('trudvsem checkpoint fresh partition progress is inconsistent');
    } else {
      if (typeof providerTotal !== 'number' || !Number.isSafeInteger(providerTotal) || providerTotal <= page * limit || providerTotal > TRUDVSEM_RESULT_DEPTH) {
        throw new Error('trudvsem checkpoint partition providerTotal is malformed or inconsistent');
      }
      const seenIds = new Set(seenExternalIds);
      if (seenExternalIds.length !== page * limit || lastPageExternalIds.length !== limit || lastPageExternalIds.some((id) => !seenIds.has(id))) {
        throw new Error('trudvsem checkpoint partition identity progress is inconsistent');
      }
    }
    if (!Array.isArray(checkpoint.pendingPartitions) || checkpoint.pendingPartitions.length > 64) throw new Error('trudvsem checkpoint pendingPartitions is malformed');
    const pendingPartitions = checkpoint.pendingPartitions.map((value) => {
      const partition = this.recordValue(value);
      if (!partition) throw new Error('trudvsem checkpoint pending partition is malformed');
      return this.trudvsemPartitionBounds(partition, outerFrom, outerTo);
    });
    const completedThrough = this.trudvsemBound(checkpoint.completedThrough, 'completedThrough', true);
    const completedPartitionCount = this.trudvsemCheckpointCount(checkpoint.completedPartitionCount, 'completedPartitionCount');
    const completedProviderRecords = this.trudvsemCheckpointCount(checkpoint.completedProviderRecords, 'completedProviderRecords');
    const splitCount = this.trudvsemCheckpointCount(checkpoint.splitCount, 'splitCount');
    const windowSeconds = (Date.parse(outerTo) - Date.parse(outerFrom)) / 1_000;
    if (completedProviderRecords > completedPartitionCount * TRUDVSEM_RESULT_DEPTH || completedPartitionCount > windowSeconds || splitCount >= Math.max(windowSeconds, 1)) {
      throw new Error('trudvsem checkpoint completed provider count or partition count is inconsistent');
    }
    if (completedPartitionCount > 0 && (completedThrough <= outerFrom || completedThrough >= outerTo)) throw new Error('trudvsem checkpoint completedThrough is inconsistent with active coverage');
    const expectedFrom = completedPartitionCount === 0 ? outerFrom : this.isoSeconds(new Date(Date.parse(completedThrough) - 1_000));
    if (bounds.modifiedFrom !== expectedFrom || (completedPartitionCount === 0 && completedThrough !== outerFrom)) {
      throw new Error('trudvsem checkpoint partition coverage has a gap or inconsistent completedThrough');
    }
    let previous = bounds;
    for (const pending of pendingPartitions) {
      if (Date.parse(pending.modifiedFrom) !== Date.parse(previous.modifiedTo) - 1_000 || Date.parse(pending.modifiedTo) <= Date.parse(previous.modifiedTo)) {
        throw new Error('trudvsem checkpoint pending partition coverage has a gap or invalid overlap');
      }
      previous = pending;
    }
    if (previous.modifiedTo !== outerTo || completedPartitionCount + pendingPartitions.length !== splitCount) {
      throw new Error('trudvsem checkpoint partition coverage does not exhaust frozen bounds');
    }
    return {
      modifiedFrom, modifiedTo,
      currentPartition: { ...bounds, page, providerTotal: typeof providerTotal === 'number' ? providerTotal : undefined, seenExternalIds, lastPageExternalIds },
      pendingPartitions, completedThrough, completedPartitionCount, completedProviderRecords, splitCount,
    };
  }

  private trudvsemValidateTerminal(checkpoint: Record<string, unknown>, maximumLeafRecords: number): void {
    const modifiedFrom = this.trudvsemBound(checkpoint.modifiedFrom, 'modifiedFrom');
    const modifiedTo = this.trudvsemBound(checkpoint.modifiedTo, 'modifiedTo');
    const completedPartitionCount = this.trudvsemCheckpointCount(checkpoint.completedPartitionCount, 'completedPartitionCount');
    const completedProviderRecords = this.trudvsemCheckpointCount(checkpoint.completedProviderRecords, 'completedProviderRecords');
    const splitCount = this.trudvsemCheckpointCount(checkpoint.splitCount, 'splitCount');
    if (checkpoint.version === 4 && checkpoint.coverageMethod !== 'single-response-date-partitions') throw new Error('trudvsem terminal checkpoint coverageMethod is malformed');
    const maximumLeaves = Math.max((Date.parse(this.isoSeconds(new Date(modifiedTo))) - Date.parse(this.isoSeconds(new Date(modifiedFrom)))) / 1_000 - 1, 1);
    if (completedPartitionCount > maximumLeaves) throw new Error('trudvsem terminal checkpoint partition count is inconsistent with frozen bounds');
    if (Date.parse(modifiedFrom) > Date.parse(modifiedTo) || checkpoint.page !== 0 || checkpoint.currentPartition !== null || !Array.isArray(checkpoint.pendingPartitions) || checkpoint.pendingPartitions.length !== 0 || checkpoint.completedThrough !== this.isoSeconds(new Date(modifiedTo)) || completedPartitionCount !== splitCount + 1 || completedProviderRecords > completedPartitionCount * maximumLeafRecords || checkpoint.terminalReason !== 'all-date-partitions-exhausted') {
      throw new Error('trudvsem terminal checkpoint does not exhaust frozen bounds');
    }
  }

  private trudvsemFreshPartition(bounds: TrudvsemPartition): TrudvsemCurrentPartition {
    return { ...bounds, page: 0, seenExternalIds: [], lastPageExternalIds: [] };
  }

  private trudvsemPartitionBounds(value: Record<string, unknown>, outerFrom: string, outerTo: string): TrudvsemPartition {
    const modifiedFrom = this.trudvsemBound(value.modifiedFrom, 'partition modifiedFrom', true);
    const modifiedTo = this.trudvsemBound(value.modifiedTo, 'partition modifiedTo', true);
    if (modifiedFrom < outerFrom || modifiedTo > outerTo || modifiedFrom > modifiedTo) throw new Error('trudvsem checkpoint partition bounds exceed frozen outer bounds');
    return { modifiedFrom, modifiedTo };
  }

  private trudvsemBound(value: unknown, name: string, wholeSeconds = false): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error(`trudvsem ${name} bound is malformed`);
    }
    const canonical = new Date(value).toISOString();
    if (canonical !== value && this.isoSeconds(new Date(value)) !== value) throw new Error(`trudvsem ${name} bound is malformed`);
    if (wholeSeconds && this.isoSeconds(new Date(value)) !== value) throw new Error(`trudvsem ${name} bound must use whole seconds`);
    return value;
  }

  private trudvsemCheckpointCount(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`trudvsem checkpoint ${name} is malformed`);
    return value;
  }

  private trudvsemItems(payload: Record<string, unknown>, verifiedTotal: number): Record<string, unknown>[] {
    const results = this.recordValue(payload.results);
    // The native API omits vacancies for an empty interval; status and metadata were validated first.
    if (verifiedTotal === 0 && results && Object.keys(results).length === 0) return [];
    const vacancies = results?.vacancies;
    if (!Array.isArray(vacancies)) throw new Error('trudvsem API response is missing results.vacancies array');
    return vacancies.map((item, index) => {
      const vacancy = this.recordAt(item, ['vacancy']);
      if (!vacancy) throw new Error(`trudvsem API vacancy at index ${index} is malformed`);
      return vacancy;
    });
  }

  private trudvsemPageInfo(payload: Record<string, unknown>, requestedLimit: number): { total: number; limit: number } {
    const meta = this.recordValue(payload.meta);
    if (!meta) throw new Error('trudvsem API response is missing meta');
    const total = numberValue(meta.total);
    const limit = numberValue(meta.limit);
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw new Error('trudvsem API response has malformed meta.total');
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('trudvsem API response has malformed meta.limit');
    if (limit !== requestedLimit) throw new Error(`trudvsem API returned meta.limit ${limit}, expected ${requestedLimit}`);
    return { total, limit };
  }

  private assertTrudvsemPageProgress(current: TrudvsemCurrentPartition, pageInfo: { total: number; limit: number }, items: Record<string, unknown>[]): void {
    const page = current.page;
    if (current.providerTotal !== undefined && current.providerTotal !== pageInfo.total) {
      throw new Error(`trudvsem API total changed during partition continuation from ${current.providerTotal} to ${pageInfo.total}; coverage remains incomplete`);
    }
    const seenBefore = page * pageInfo.limit;
    if (seenBefore > pageInfo.total || (seenBefore === pageInfo.total && (pageInfo.total > 0 || page > 0))) {
      throw new Error(`trudvsem API page ${page} is beyond declared total ${pageInfo.total}`);
    }
    const expectedItems = Math.min(pageInfo.limit, Math.max(pageInfo.total - seenBefore, 0));
    if (items.length !== expectedItems) {
      const direction = items.length < expectedItems ? 'short' : 'oversize';
      throw new Error(`trudvsem API returned ${direction} page ${page}: expected ${expectedItems}, got ${items.length}`);
    }
    const currentIds = this.trudvsemNativeIds(items);
    if (current.lastPageExternalIds.length > 0 && currentIds.length > 0 && currentIds.every((id) => current.lastPageExternalIds.includes(id))) {
      throw new Error(`trudvsem API repeated all vacancy ids on continuation page ${page}`);
    }
  }

  private trudvsemUrl(item: Record<string, unknown>, id: string, companyCode: string | undefined): string {
    const nativeUrl = stringValue(item.vac_url);
    const parsed = nativeUrl ? this.trudvsemParsedNativeUrl(nativeUrl, id) : undefined;
    if (parsed) return parsed;
    if (companyCode && this.trudvsemSafeCompanyCode(companyCode) && this.trudvsemSafePathComponent(id)) return `https://trudvsem.ru/vacancy/card/${companyCode}/${id}`;
    throw new Error(`trudvsem vacancy ${id} is missing valid vac_url and companycode`);
  }

  private trudvsemParsedNativeUrl(nativeUrl: string, id: string): string | undefined {
    try {
      const parsed = new URL(nativeUrl);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'trudvsem.ru' || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
      const parts = parsed.pathname.split('/');
      if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'vacancy' || parts[2] !== 'card') return undefined;
      const companyCode = decodeURIComponent(parts[3]);
      const urlId = decodeURIComponent(parts[4]);
      if (urlId !== id || !this.trudvsemSafeCompanyCode(companyCode) || !this.trudvsemSafePathComponent(urlId)) return undefined;
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private trudvsemSafeCompanyCode(value: string): boolean {
    return /^(?:\d+|[0-9a-fA-F]+(?:-[0-9a-fA-F]+)+)$/.test(value);
  }

  private trudvsemSafePathComponent(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value);
  }

  private trudvsemLocations(item: Record<string, unknown>): Record<string, unknown>[] {
    const address = this.recordValue(item.addresses)?.address;
    if (!Array.isArray(address)) return [];
    return address.filter(this.isRecord);
  }

  private trudvsemSkills(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const skills = value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item));
    return skills.length > 0 ? Array.from(new Set(skills)) : undefined;
  }

  private trudvsemNativeIds(items: Record<string, unknown>[]): string[] {
    return items.map((item) => this.requiredText(item.id ?? item['vacancy_id'] ?? item.source_id, 'trudvsem vacancy id'));
  }

  private trudvsemCheckpointIds(value: unknown, name: string): string[] {
    if (!Array.isArray(value) || value.length > TRUDVSEM_RESULT_DEPTH || value.some((item) => typeof item !== 'string' || item.length === 0) || new Set(value).size !== value.length) {
      throw new Error(`trudvsem checkpoint ${name} is malformed`);
    }
    return value as string[];
  }

  private trudvsemCurrency(value: unknown): string | undefined {
    const text = stringValue(value);
    if (!text) return undefined;
    if (/(?:руб|₽|rub|rur)/i.test(text)) return 'RUB';
    if (/(?:доллар|usd|\$)/i.test(text)) return 'USD';
    if (/(?:евро|eur|€)/i.test(text)) return 'EUR';
    return undefined;
  }

  private dedup(values: string[]): string[] {
    return Array.from(new Set(values));
  }


  private withinBackfill(record: RawOpportunityRecord, cutoff: number): boolean {
    const relevantDate = record.updatedAt ?? record.publishedAt;
    return !relevantDate || relevantDate.getTime() >= cutoff;
  }

  private withinFeedWindow(record: RawOpportunityRecord, window: FeedWindow): boolean {
    const relevantDate = record.updatedAt ?? record.publishedAt;
    return !relevantDate || (relevantDate >= window.from && relevantDate <= window.to);
  }

  private date(value: unknown): Date | undefined {
    const text = stringValue(value);
    if (!text) return undefined;
    const timestamp = Date.parse(text);
    return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
  }

  private zonedDate(value: unknown): Date | undefined {
    const text = stringValue(value);
    if (!text || !/(?:z|[+-]\d{2}:?\d{2})$/i.test(text)) return undefined;
    return this.date(text);
  }

  private unixDate(value: unknown): Date | undefined {
    const number = numberValue(value);
    return number ? new Date(number * 1000) : undefined;
  }

  private cutoff(ctx: FetchContext): number {
    return this.backfillSince(ctx).getTime();
  }

  private feedWindow(ctx: FetchContext): FeedWindow {
    const from = this.backfillSince(ctx);
    const to = this.upperBound(ctx);
    return { from, to, fromIso: from.toISOString(), toIso: to.toISOString() };
  }

  private backfillSince(ctx: FetchContext): Date {
    const timestamp = typeof ctx.backfillSince === 'string' ? Date.parse(ctx.backfillSince) : NaN;
    if (Number.isFinite(timestamp)) return new Date(timestamp);
    return new Date(Date.now() - Math.min(Math.max(ctx.backfillDays, 1), 30) * 86_400_000);
  }

  private upperBound(ctx: FetchContext): Date {
    const checkpoint = typeof ctx.checkpoint.modifiedTo === 'string' ? Date.parse(ctx.checkpoint.modifiedTo) : NaN;
    if (ctx.checkpoint.hasMore === true && Number.isFinite(checkpoint)) return new Date(checkpoint);
    return new Date();
  }

  private isoSeconds(value: Date): string {
    return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private hashFallback(value: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(value).slice(0, 128)).toString('base64url');
  }

  private omitUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
  }

  private htmlToText(value: string): string {
    const $ = load(value, null, false);
    const root = $.root();
    root.find('script,style').remove();
    root.find('br').replaceWith('\n');
    root.find('p,div,li,ul,ol,pre,blockquote,h1,h2,h3,h4,h5,h6').each((_, element) => {
      const node = $(element);
      node.before('\n');
      node.after('\n');
    });
    return root.text()
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }
}
