import { load } from 'cheerio';

import { OpportunityType } from '../../opportunities/schemas/opportunity.schema';
import { WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { stringValue } from './connector-utils';

const ORIGIN = 'https://www.ycombinator.com';
const START_URL = `${ORIGIN}/jobs`;
const ALLOWED_HOSTS = ['www.ycombinator.com'];
const MAX_HTML_BYTES = 2_500_000;
const MAX_COVERAGE_ISSUES = 200;

type ExtractedDocument = {
  finalUrl: string;
  html: string;
  markdown?: string;
  title?: string;
  metadata: Record<string, unknown>;
};

type YcJobPosting = {
  id?: number | string;
  title?: string;
  url?: string;
  applyUrl?: string;
  location?: string;
  type?: string;
  role?: string;
  roleSpecificType?: string;
  prettyRole?: string;
  salaryRange?: string;
  equityRange?: string;
  minExperience?: string | null;
  minSchoolYear?: string | null;
  visa?: string;
  skills?: unknown[];
  isIncomplete?: boolean;
  companyUrl?: string;
  companyLogoUrl?: string;
  companyName?: string;
  companyBatchName?: string | null;
  companyOneLiner?: string;
  hiringManager?: unknown;
  createdAt?: string;
  lastActive?: string;
  ctaText?: string;
  ctaUrl?: string;
};

type YcPageProps = {
  component?: string;
  props?: {
    jobPostings?: YcJobPosting[];
    sidebarLinks?: unknown[];
    jobRoles?: Array<{ slug?: string; name?: string }>;
    jobLocations?: Array<{ slug?: string; name?: string }>;
    createProfileUrl?: string;
    jobsCount?: string;
    debugInfo?: unknown;
  };
};

type CoverageIssue = {
  kind: 'stale-listing-404' | 'stale-detail-404';
  url: string;
  listingUrl?: string;
  jobId?: string;
  title?: string;
  observedAt: string;
};

type JobPostingLd = {
  '@type'?: string;
  title?: string;
  url?: string;
  description?: string;
  datePosted?: string;
  employmentType?: string;
  hiringOrganization?: { name?: string; sameAs?: string; logo?: string };
  baseSalary?: unknown;
  jobLocation?: unknown;
  applicantLocationRequirements?: unknown;
  jobLocationType?: unknown;
};

export class YcJobsConnector implements Connector {
  readonly id = 'yc-jobs';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly extraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: 30 };
  }

  async validateConfig(config: Record<string, unknown> = {}): Promise<ValidationResult> {
    if (stringValue(config.searchText)) {
      return { ok: false, message: 'YC Jobs public connector does not support unauthenticated searchText; only confirmed public SEO listing pages are collected' };
    }
    return { ok: true, message: 'YC Jobs public SEO listings configured', details: this.endpointMetadata() };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1 });
      return { state: 'Healthy', message: `YC Jobs public listing returned ${page.stats.seen} postings`, checkedAt: new Date(), details: { records: page.records.length, ...this.endpointMetadata() } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'YC Jobs fetch failed', checkedAt: new Date(), details: this.endpointMetadata() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const validation = await this.validateConfig(ctx.source.config ?? {});
    if (!validation.ok) throw new Error(validation.message ?? 'YC Jobs source configuration is invalid');

    const continuing = ctx.checkpoint.hasMore === true;
    const backfillSince = this.backfillSince(ctx);
    const windowTo = this.windowTo(ctx);
    const listingQueue = continuing ? this.stringArray(ctx.checkpoint.listingQueue) : [START_URL];
    const visitedListings = new Set(continuing ? this.stringArray(ctx.checkpoint.visitedListingUrls) : []);
    const seenJobIds = new Set(continuing ? this.stringArray(ctx.checkpoint.seenJobIds) : []);
    const coverageIssues = continuing ? this.coverageIssues(ctx.checkpoint.coverageIssues) : [];
    const currentUrl = listingQueue.shift() ?? START_URL;
    const listingUrl = this.safeListingUrl(currentUrl, START_URL);
    if (!listingUrl) throw new Error(`YC Jobs listing URL is unsafe: ${currentUrl}`);
    if (visitedListings.has(listingUrl)) throw new Error(`YC Jobs listing loop detected before fetching ${listingUrl}`);

    let listing: ExtractedDocument;
    try {
      listing = await this.extraction.extractUrl(listingUrl, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal }) as ExtractedDocument;
    } catch (error) {
      if (!this.isHttp404(error)) throw error;
      visitedListings.add(listingUrl);
      this.addCoverageIssue(coverageIssues, { kind: 'stale-listing-404', url: listingUrl, observedAt: new Date().toISOString() });
      return this.emptyContinuationResult(ctx, listingQueue, visitedListings, seenJobIds, coverageIssues, backfillSince, windowTo);
    }
    const finalListingUrl = this.safeListingUrl(listing.finalUrl, listingUrl);
    if (!finalListingUrl) throw new Error(`YC Jobs listing redirected outside the public /jobs surface: ${listingUrl}`);
    if (finalListingUrl !== listingUrl && visitedListings.has(finalListingUrl)) throw new Error(`YC Jobs listing redirected to an already visited page: ${finalListingUrl}`);

    const pageData = this.parsePageData(listing.html);
    const postings = pageData.props?.jobPostings ?? [];
    if (postings.length === 0) throw new Error(`YC Jobs listing contains no concrete jobPostings: ${finalListingUrl}`);

    const discoveredListings = this.discoverListingUrls(listing.html, finalListingUrl, pageData);
    const records: RawOpportunityRecord[] = [];
    for (const posting of postings) {
      ctx.signal?.throwIfAborted();
      const jobId = this.jobId(posting);
      const detailUrl = this.safeDetailUrl(posting.url, finalListingUrl);
      if (!jobId || !detailUrl) throw new Error(`YC Jobs listing has malformed concrete posting at ${finalListingUrl}`);
      if (seenJobIds.has(jobId)) continue;
      let detail: ExtractedDocument;
      try {
        detail = await this.extraction.extractUrl(detailUrl, { allowedHosts: ALLOWED_HOSTS, timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal }) as ExtractedDocument;
      } catch (error) {
        if (!this.isHttp404(error)) throw error;
        seenJobIds.add(jobId);
        this.addCoverageIssue(coverageIssues, { kind: 'stale-detail-404', url: detailUrl, listingUrl: finalListingUrl, jobId, title: posting.title, observedAt: new Date().toISOString() });
        continue;
      }
      const finalDetailUrl = this.safeDetailUrl(detail.finalUrl, detailUrl);
      if (!finalDetailUrl) throw new Error(`YC Jobs detail ${jobId} redirected outside its public job page`);
      if (new URL(finalDetailUrl).pathname !== new URL(detailUrl).pathname) throw new Error(`YC Jobs detail ${jobId} redirected to a different job slug`);
      const jsonLd = this.jobPostingJsonLd(detail.html, finalDetailUrl);
      if (!jsonLd?.description || !jsonLd.title || !this.htmlText(jsonLd.description)) throw new Error(`YC Jobs detail ${jobId} does not expose a usable public JobPosting body`);
      const publishedAt = this.parseDate(jsonLd.datePosted);
      if (publishedAt && (publishedAt.getTime() < backfillSince.getTime() || publishedAt.getTime() > windowTo.getTime())) {
        seenJobIds.add(jobId);
        continue;
      }
      records.push(this.toRecord(ctx, posting, jobId, finalDetailUrl, jsonLd, detail, publishedAt, finalListingUrl, backfillSince, windowTo));
      seenJobIds.add(jobId);
    }

    visitedListings.add(finalListingUrl);
    for (const url of discoveredListings) {
      if (!visitedListings.has(url) && !listingQueue.includes(url)) listingQueue.push(url);
    }


    const hasMore = listingQueue.length > 0;
    const page = Number(ctx.checkpoint.nextPage ?? ctx.page ?? 0);
    return {
      records,
      hasMore,
      nextPage: hasMore ? page + 1 : undefined,
      checkpoint: hasMore ? {
        hasMore: true,
        nextPage: page + 1,
        listingQueue,
        visitedListingUrls: [...visitedListings],
        seenJobIds: [...seenJobIds],
        backfillSince: backfillSince.toISOString(),
        windowTo: windowTo.toISOString(),
        coverageIssues,
        endpoint: this.endpointMetadata(),
        lastFetchedAt: new Date().toISOString(),
      } : {
        hasMore: false,
        backfillSince: backfillSince.toISOString(),
        windowTo: windowTo.toISOString(),
        visitedListingUrls: [...visitedListings],
        seenJobIds: [...seenJobIds],
        coverageIssues,
        endpoint: this.endpointMetadata(),
        lastFetchedAt: new Date().toISOString(),
      },
      stats: { seen: postings.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> { return result.checkpoint; }


  private emptyContinuationResult(ctx: FetchContext, listingQueue: string[], visitedListings: Set<string>, seenJobIds: Set<string>, coverageIssues: CoverageIssue[], backfillSince: Date, windowTo: Date): FetchPage {
    const hasMore = listingQueue.length > 0;
    const page = Number(ctx.checkpoint.nextPage ?? ctx.page ?? 0);
    return {
      records: [],
      hasMore,
      nextPage: hasMore ? page + 1 : undefined,
      checkpoint: hasMore ? {
        hasMore: true,
        nextPage: page + 1,
        listingQueue,
        visitedListingUrls: [...visitedListings],
        seenJobIds: [...seenJobIds],
        backfillSince: backfillSince.toISOString(),
        windowTo: windowTo.toISOString(),
        coverageIssues,
        endpoint: this.endpointMetadata(),
        lastFetchedAt: new Date().toISOString(),
      } : {
        hasMore: false,
        backfillSince: backfillSince.toISOString(),
        windowTo: windowTo.toISOString(),
        visitedListingUrls: [...visitedListings],
        seenJobIds: [...seenJobIds],
        coverageIssues,
        endpoint: this.endpointMetadata(),
        lastFetchedAt: new Date().toISOString(),
      },
      stats: { seen: 0 },
    };
  }


  private parsePageData(html: string): YcPageProps {
    const $ = load(html);
    for (const element of $('[data-page]').toArray()) {
      const raw = $(element).attr('data-page');
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as YcPageProps;
        if (Array.isArray(parsed.props?.jobPostings)) return parsed;
      } catch {
        continue;
      }
    }
    throw new Error('YC Jobs public page did not expose parseable SSR data-page jobPostings');
  }

  private discoverListingUrls(html: string, finalUrl: string, pageData: YcPageProps): string[] {
    const urls = new Set<string>();
    const add = (value: unknown) => {
      const safe = this.safeListingUrl(typeof value === 'string' ? value : undefined, finalUrl);
      if (safe) urls.add(safe);
    };
    const props = pageData.props;
    for (const link of props?.sidebarLinks ?? []) {
      if (Array.isArray(link)) add(link[1]);
    }
    for (const role of props?.jobRoles ?? []) {
      if (role.slug) add(`/jobs/role/${role.slug}`);
    }
    for (const location of props?.jobLocations ?? []) {
      if (location.slug) add(`/jobs/location/${location.slug}`);
    }
    const $ = load(html);
    $('a[href]').each((_, anchor) => add($(anchor).attr('href')));
    urls.delete(finalUrl);
    return [...urls].sort();
  }

  private jobPostingJsonLd(html: string, detailUrl: string): JobPostingLd | undefined {
    const $ = load(html);
    const jobs: JobPostingLd[] = [];
    for (const element of $('script[type="application/ld+json"]').toArray()) {
      const raw = $(element).text();
      if (!raw.trim()) continue;
      try {
        jobs.push(...this.jsonLdCandidates(JSON.parse(raw)).filter((item) => this.hasSchemaType(item, 'JobPosting')));
      } catch {
        continue;
      }
    }
    if (jobs.length === 0) return undefined;
    const detailPath = new URL(detailUrl).pathname;
    return jobs.find((job) => {
      const url = typeof job.url === 'string' ? this.safeDetailUrl(job.url, detailUrl) : undefined;
      return url ? new URL(url).pathname === detailPath : false;
    }) ?? (jobs.length === 1 ? jobs[0] : undefined);
  }

  private jsonLdCandidates(value: unknown): JobPostingLd[] {
    if (Array.isArray(value)) return value.flatMap((item) => this.jsonLdCandidates(item));
    if (!value || typeof value !== 'object') return [];
    const record = value as JobPostingLd & { '@graph'?: unknown };
    const graph = record['@graph'];
    return [record, ...(Array.isArray(graph) ? graph.flatMap((item) => this.jsonLdCandidates(item)) : [])];
  }

  private hasSchemaType(value: JobPostingLd, type: string): boolean {
    const schemaType = value['@type'];
    return Array.isArray(schemaType) ? schemaType.includes(type) : schemaType === type;
  }

  private toRecord(ctx: FetchContext, posting: YcJobPosting, jobId: string, url: string, jsonLd: JobPostingLd, detail: ExtractedDocument, publishedAt: Date | undefined, listingUrl: string, backfillSince: Date, windowTo: Date): RawOpportunityRecord {
    const descriptionHtml = jsonLd.description ?? '';
    const descriptionText = this.htmlText(descriptionHtml);
    const company = jsonLd.hiringOrganization?.name ?? posting.companyName;
    const locations = this.locations(jsonLd.jobLocation, jsonLd.applicantLocationRequirements);
    const salary = this.salary(jsonLd.baseSalary) ?? this.salaryRangeFallback(posting.salaryRange);
    const remoteType = this.remoteType(jsonLd.jobLocationType, posting.location);
    return {
      externalId: jobId,
      url,
      type: (ctx.source.opportunityTypes[0] as OpportunityType | undefined) ?? 'vacancy',
      title: jsonLd.title ?? posting.title ?? `YC job ${jobId}`,
      companyOrClient: company,
      description: descriptionText,
      publishedAt,
      sourceStatus: 'Active',
      rawPayload: {
        listing: posting as Record<string, unknown>,
        jobPosting: jsonLd as Record<string, unknown>,
        detailTitle: detail.title,
        detailMetadata: detail.metadata,
      },
      sourceMetadata: {
        ...this.endpointMetadata(),
        extraction: 'yc-jobs-public-html-jsonld-v1',
        listingUrl,
        descriptionHtml,
        applyUrl: posting.applyUrl,
        ctaText: posting.ctaText,
        ctaUrl: posting.ctaUrl,
        companyUrl: posting.companyUrl ? this.safeCompanyUrl(posting.companyUrl, ORIGIN) : undefined,
        companyLogoUrl: posting.companyLogoUrl,
        companyWebsite: jsonLd.hiringOrganization?.sameAs,
        salary,
        area: locations[0] ?? posting.location,
        locations: locations.length > 0 ? locations : undefined,
        location: posting.location,
        remoteType,
        jobLocation: jsonLd.jobLocation,
        employmentType: jsonLd.employmentType ?? posting.type,
        role: posting.role,
        roleSpecificType: posting.roleSpecificType,
        prettyRole: posting.prettyRole,
        salaryRange: posting.salaryRange,
        equityRange: posting.equityRange,
        baseSalary: jsonLd.baseSalary,
        minExperience: posting.minExperience,
        minSchoolYear: posting.minSchoolYear,
        visa: posting.visa,
        skills: (posting.skills ?? []).filter((skill): skill is string => typeof skill === 'string'),
        companyBatchName: posting.companyBatchName,
        companyOneLiner: posting.companyOneLiner,
        createdAtRaw: posting.createdAt,
        lastActiveRaw: posting.lastActive,
        publicationWindow: {
          backfillSince: backfillSince.toISOString(),
          windowTo: windowTo.toISOString(),
          unknownDatesRetained: true,
          exactDatePostedFiltered: true,
        },
      },
    };
  }

  private safeListingUrl(value: string | undefined, base: string): string | undefined {
    const url = this.safeUrl(value, base);
    if (!url) return undefined;
    if (!/^\/jobs(?:$|\/(?:role|location)(?:\/[a-z0-9-]+){1,2}$)/.test(url.pathname)) return undefined;
    return url.toString();
  }

  private safeDetailUrl(value: string | undefined, base: string): string | undefined {
    const url = this.safeUrl(value, base);
    if (!url) return undefined;
    if (!/^\/companies\/[a-z0-9-]+\/jobs\/[A-Za-z0-9]+-[A-Za-z0-9-]+$/.test(url.pathname)) return undefined;
    return url.toString();
  }

  private safeCompanyUrl(value: string, base: string): string | undefined {
    const url = this.safeUrl(value, base);
    if (!url) return undefined;
    if (!/^\/companies\/[a-z0-9-]+$/.test(url.pathname)) return undefined;
    return url.toString();
  }

  private safeUrl(value: string | undefined, base: string): URL | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, base);
      if (url.protocol !== 'https:') return undefined;
      if (url.hostname !== 'www.ycombinator.com') return undefined;
      if (url.port || url.username || url.password || url.hash || url.search) return undefined;
      return url;
    } catch {
      return undefined;
    }
  }

  private jobId(posting: YcJobPosting): string | undefined {
    if (typeof posting.id === 'number' && Number.isSafeInteger(posting.id) && posting.id > 0) return String(posting.id);
    if (typeof posting.id === 'string' && /^\d+$/.test(posting.id)) return posting.id;
    return undefined;
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

  private salaryRangeFallback(value: unknown): Record<string, unknown> | undefined {
    const originalText = stringValue(value);
    return originalText ? { originalText } : undefined;
  }

  private salaryText(min?: number, max?: number, currency?: string, period?: string): string | undefined {
    const amounts = [min, max].filter((value, index, array): value is number => typeof value === 'number' && array.indexOf(value) === index);
    if (amounts.length === 0 && !currency && !period) return undefined;
    const amount = amounts.length === 2 ? `${amounts[0]} – ${amounts[1]}` : amounts[0]?.toString();
    return [amount, currency, period].filter(Boolean).join(' ') || undefined;
  }

  private locations(jobLocation: unknown, applicantLocationRequirements: unknown): string[] {
    return Array.from(new Set([...this.locationNames(jobLocation), ...this.locationNames(applicantLocationRequirements)]));
  }

  private locationNames(value: unknown): string[] {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return values.flatMap((item) => {
      const record = this.recordValue(item);
      if (!record) return [];
      const address = this.recordValue(record.address);
      const direct = stringValue(record.name) ?? stringValue(record.address);
      const parts = [
        stringValue(address?.addressLocality),
        stringValue(address?.addressRegion),
        stringValue(address?.addressCountry) ?? stringValue(this.recordValue(address?.addressCountry)?.name),
      ].filter((part): part is string => Boolean(part));
      const label = parts.length > 0 ? parts.join(', ') : direct;
      return label ? [label] : [];
    });
  }

  private remoteType(jobLocationType: unknown, listingLocation: unknown): string | undefined {
    const type = Array.isArray(jobLocationType) ? jobLocationType.find((item) => typeof item === 'string') : jobLocationType;
    if (typeof type === 'string' && type.trim()) return type.trim();
    const location = stringValue(listingLocation);
    return location && /\bremote\b/i.test(location) ? 'Remote' : undefined;
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private positiveNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  private omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
  }

  private parseDate(value: unknown): Date | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }

  private htmlText(html: string): string {
    return load(`<main>${html.replace(/<\/(p|div|li|h[1-6])>/gi, '</$1> ')}</main>`)('main').text().replace(/\s+/g, ' ').trim();
  }

  private backfillSince(ctx: FetchContext): Date {
    const checkpointValue = stringValue(ctx.checkpoint.backfillSince);
    const value = ctx.checkpoint.hasMore === true && checkpointValue ? checkpointValue : ctx.backfillSince;
    const parsed = value ? new Date(value) : new Date(Date.now() - Math.min(ctx.backfillDays || 30, 30) * 86_400_000);
    return Number.isFinite(parsed.getTime()) ? parsed : new Date(Date.now() - 30 * 86_400_000);
  }

  private windowTo(ctx: FetchContext): Date {
    const checkpointValue = stringValue(ctx.checkpoint.windowTo);
    if (ctx.checkpoint.hasMore === true && checkpointValue) {
      const parsed = new Date(checkpointValue);
      if (Number.isFinite(parsed.getTime())) return parsed;
    }
    return new Date();
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  }


  private coverageIssues(value: unknown): CoverageIssue[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): CoverageIssue[] => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Partial<CoverageIssue>;
      if ((record.kind !== 'stale-listing-404' && record.kind !== 'stale-detail-404') || typeof record.url !== 'string' || typeof record.observedAt !== 'string') return [];
      return [{ kind: record.kind, url: record.url, listingUrl: stringValue(record.listingUrl), jobId: stringValue(record.jobId), title: stringValue(record.title), observedAt: record.observedAt }];
    }).slice(-MAX_COVERAGE_ISSUES);
  }

  private addCoverageIssue(issues: CoverageIssue[], issue: CoverageIssue): void {
    if (!issues.some((item) => item.kind === issue.kind && item.url === issue.url && item.jobId === issue.jobId)) issues.push(issue);
    while (issues.length > MAX_COVERAGE_ISSUES) issues.shift();
  }

  private isHttp404(error: unknown): boolean {
    return error instanceof Error && /\bHTTP 404\b/i.test(error.message);
  }

  private endpointMetadata(): Record<string, unknown> {
    return {
      parser: 'yc-jobs-public-html-v1',
      baseUrl: START_URL,
      allowedHosts: ALLOWED_HOSTS,
      observedPublicContract: 'Rails SSR data-page jobPostings on /jobs and public SEO /jobs/role|location listing pages; detail pages expose schema.org JobPosting JSON-LD',
      observedScope: 'public-yc-jobs-seo-listings',
      scopeLimitation: 'The public /jobs landing CTA for more jobs points to account.ycombinator.com/workatastartup application flow; unauthenticated connector does not access gated search/application endpoints.',
    };
  }
}
