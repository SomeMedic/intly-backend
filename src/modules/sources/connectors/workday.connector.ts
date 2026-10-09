import { load } from 'cheerio';

import {
  Connector,
  ConnectorCapabilities,
  ConnectorCheckpoint,
  ConnectorContext,
  ConnectorHealth,
  ConnectorRateLimitError,
  FetchContext,
  FetchPage,
  RawOpportunityRecord,
  ValidationResult,
} from './connector.types';
import { WebExtractionService } from '../extraction/web-extraction.service';
import { numberValue, stringValue } from './connector-utils';

const MAX_BACKFILL_DAYS = 30;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 20;
const MAX_JSON_BYTES = 5_000_000;
const WORKDAY_HOST_PATTERN = /^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/i;
const SAFE_SITE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/;
const SAFE_LOCALE_PATTERN = /^[a-z]{2}-[A-Z]{2}$/;

function jobsCanIgnoreContinuationTotal(total: number, offset: number): boolean {
  return offset > 0 && total === 0;
}

type WorkdayBoard = {
  inputUrl: string;
  origin: string;
  host: string;
  tenant: string;
  site: string;
  locale?: string;
  boardUrl: string;
  jobsApiUrl: string;
  key: string;
};

type WorkdayListingJob = Record<string, unknown> & {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  remoteType?: string;
  bulletFields?: unknown[];
};

type WorkdayListingPayload = {
  total?: unknown;
  jobPostings?: unknown;
  facets?: unknown;
  userAuthenticated?: unknown;
};

type WorkdayDetailPayload = {
  jobPostingInfo?: unknown;
  hiringOrganization?: unknown;
  similarJobs?: unknown;
  userAuthenticated?: unknown;
};

type WorkdayWindow = { since: Date; to: Date; sinceIso: string; toIso: string };

type WorkdayCheckpoint = ConnectorCheckpoint & {
  hasMore?: boolean;
  boards?: WorkdayBoard[];
  boardKeys?: string[];
  boardIndex?: number;
  offset?: number;
  limit?: number;
  seenExternalIds?: string[];
  visitedOffsets?: string[];
  backfillSince?: string;
  windowTo?: string;
  totals?: Record<string, number>;
};

type WorkdayRawConfig = Record<string, unknown>;

export class WorkdayConnector implements Connector<WorkdayRawConfig> {
  readonly id = 'workday';
  readonly family = 'AtsPublicBoard' as const;

  constructor(private readonly extraction?: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(config: WorkdayRawConfig): Promise<ValidationResult> {
    try {
      const boards = this.configuredBoards({ source: { config, endpoint: {} } } as ConnectorContext);
      if (boards.length === 0) return { ok: false, message: 'Workday requires config.tenants with public myworkdayjobs.com board URLs' };
      return { ok: true, message: 'Workday public CXS boards configured', details: { tenants: boards.map((board) => board.boardUrl), boardKeys: boards.map((board) => board.key) } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Invalid Workday config' };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1 });
      return { state: 'Healthy', message: `Workday returned ${page.records.length} public jobs`, checkedAt: new Date(), details: { seen: page.stats.seen, hasMore: page.hasMore } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Workday fetch failed', checkedAt: new Date() };
    }
  }

  async discover(ctx: ConnectorContext): Promise<ValidationResult> {
    const seeds = this.discoverySeeds(ctx);
    if (seeds.length === 0) return { ok: false, message: 'Workday discovery requires explicit discoveryUrls or discoveryHosts seeds' };
    const found = new Map<string, WorkdayBoard>();
    const errors: string[] = [];
    for (const seed of seeds) {
      ctx.signal?.throwIfAborted();
      try {
        const html = await this.fetchText(seed, { method: 'GET', signal: ctx.signal, timeoutMs: ctx.source.timeoutMs ?? 30_000, accept: 'text/html,application/xhtml+xml' });
        for (const candidate of this.extractBoardLinks(html, seed)) {
          const board = this.parseBoardUrl(candidate);
          if (board) found.set(board.key, board);
        }
      } catch (error) {
        errors.push(`${seed}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const valid: WorkdayBoard[] = [];
    for (const board of found.values()) {
      ctx.signal?.throwIfAborted();
      try {
        const payload = await this.postListing(board, 0, 1, ctx.source.timeoutMs ?? 30_000, ctx.signal);
        if (Number.isInteger(payload.total) && Array.isArray(payload.jobPostings)) valid.push(board);
      } catch (error) {
        errors.push(`${board.boardUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return valid.length > 0
      ? { ok: true, message: `Discovered ${valid.length} public Workday board(s)`, details: { tenants: valid.map((board) => board.boardUrl), errors } }
      : { ok: false, message: 'No public Workday CXS boards discovered from explicit seeds', details: { errors } };
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const continuing = ctx.checkpoint.hasMore === true;
    const configuredBoards = this.configuredBoards(ctx);
    if (configuredBoards.length === 0) throw new Error('Workday source has no configured public board URLs');
    const checkpoint = ctx.checkpoint as WorkdayCheckpoint;
    const boards = continuing ? this.boardsFromCheckpoint(checkpoint, configuredBoards) : configuredBoards;
    const boardIndex = continuing ? this.integerInRange(checkpoint.boardIndex, 0, boards.length - 1, 'Workday continuation boardIndex') : 0;
    const limit = this.pageLimit(ctx, checkpoint);
    const offset = continuing ? this.nonNegativeInteger(checkpoint.offset, 'Workday continuation offset') : 0;
    const board = boards[boardIndex];
    const window = this.window(ctx, continuing, checkpoint);
    const seenExternalIds = new Set(this.stringArray(continuing ? checkpoint.seenExternalIds : undefined));
    const visitedOffsets = new Set(this.stringArray(continuing ? checkpoint.visitedOffsets : undefined));
    const offsetKey = `${board.key}:${offset}`;
    if (visitedOffsets.has(offsetKey)) throw new Error(`Workday pagination cycle detected at ${offsetKey}`);

    const listing = await this.postListing(board, offset, limit, ctx.source.timeoutMs ?? 30_000, ctx.signal);
    const observedTotal = this.requiredTotal(listing.total, board);
    const frozenTotal = continuing ? this.frozenTotal(checkpoint, board) : undefined;
    const total = continuing && frozenTotal !== undefined && jobsCanIgnoreContinuationTotal(observedTotal, offset)
      ? frozenTotal
      : (frozenTotal ?? observedTotal);
    const jobs = this.requiredJobPostings(listing.jobPostings, board);
    if (!continuing && observedTotal <= 0 && jobs.length > 0) throw new Error(`Workday ${board.key} first page returned records without a usable total`);
    if (continuing && frozenTotal !== undefined && observedTotal > 0 && observedTotal !== frozenTotal && offset < frozenTotal) {
      throw new Error(`Workday ${board.key} changed total during continuation from ${frozenTotal} to ${observedTotal}`);
    }
    if (total > 0 && jobs.length === 0 && offset < total) throw new Error(`Workday ${board.key} returned an empty page before total ${total}`);

    const records: RawOpportunityRecord[] = [];
    const observedAt = new Date().toISOString();
    let newSeenOnPage = 0;
    for (const job of jobs) {
      ctx.signal?.throwIfAborted();
      const detailUrl = this.detailApiUrl(board, job.externalPath);
      const detail = await this.fetchJson<WorkdayDetailPayload>(detailUrl, { method: 'GET', signal: ctx.signal, timeoutMs: ctx.source.timeoutMs ?? 30_000, accept: 'application/json' });
      const record = this.mapRecord(board, job, detail, detailUrl, observedAt);
      if (seenExternalIds.has(record.externalId)) continue;
      newSeenOnPage += 1;
      seenExternalIds.add(record.externalId);
      if (!this.recordWithinWindow(record, window)) continue;
      records.push(record);
    }

    visitedOffsets.add(offsetKey);
    const nextOffset = offset + jobs.length;
    const hasNextOffset = nextOffset < total;
    if (continuing && jobs.length > 0 && newSeenOnPage === 0) {
      throw new Error(`Workday ${board.key} returned a repeated listing page at offset ${offset}`);
    }
    const hasNextBoard = !hasNextOffset && boardIndex + 1 < boards.length;
    const hasMore = hasNextOffset || hasNextBoard;
    const nextBoardIndex = hasNextOffset ? boardIndex : boardIndex + 1;
    const nextCheckpoint = this.omitUndefined({
      hasMore,
      boards,
      boardKeys: boards.map((entry) => entry.key),
      boardIndex: hasMore ? nextBoardIndex : boardIndex,
      offset: hasMore ? (hasNextOffset ? nextOffset : 0) : undefined,
      limit,
      seenExternalIds: [...seenExternalIds],
      visitedOffsets: [...visitedOffsets],
      backfillSince: window.sinceIso,
      windowTo: window.toIso,
      totals: { ...(this.recordValue(checkpoint.totals) as Record<string, number> | undefined), [board.key]: total },
      nextPage: hasMore ? (numberValue(checkpoint.nextPage) ?? 0) + 1 : undefined,
    });

    return { records, hasMore, nextPage: hasMore ? (numberValue(checkpoint.nextPage) ?? 0) + 1 : undefined, checkpoint: nextCheckpoint, stats: { seen: jobs.length } };
  }

  checkpoint(result: FetchPage): ConnectorCheckpoint {
    return result.checkpoint;
  }

  private configuredBoards(ctx: Pick<ConnectorContext, 'source'>): WorkdayBoard[] {
    const config = this.recordValue(ctx.source.config) ?? {};
    const endpoint = this.recordValue(ctx.source.endpoint) ?? {};
    const explicit = [
      ...this.stringArray(config.tenants),
      ...this.stringArray(config.tenantUrls),
    ];
    const fallback = [
      ...this.stringArray(endpoint.baseUrls),
      ...this.stringArray(endpoint.tenants),
      ...this.singleString(endpoint.baseUrl),
    ];
    const boards = new Map<string, WorkdayBoard>();
    for (const value of explicit.length > 0 ? explicit : fallback) {
      const board = this.parseBoardUrl(value);
      if (!board) {
        if (explicit.length > 0) throw new Error(`Unsafe or unsupported Workday board URL: ${value}`);
        continue;
      }
      boards.set(board.key, board);
    }
    return [...boards.values()];
  }

  private boardsFromCheckpoint(checkpoint: WorkdayCheckpoint, configuredBoards: WorkdayBoard[]): WorkdayBoard[] {
    const rawBoards = Array.isArray(checkpoint.boards) ? checkpoint.boards : undefined;
    if (!rawBoards) throw new Error('Workday continuation is missing frozen board list');
    const boards = rawBoards.map((raw) => this.parseCheckpointBoard(raw));
    const configuredKeys = configuredBoards.map((board) => board.key);
    const frozenKeys = boards.map((board) => board.key);
    if (configuredKeys.length !== frozenKeys.length || configuredKeys.some((key, index) => key !== frozenKeys[index])) {
      throw new Error('Workday configured board set changed during continuation');
    }
    return boards;
  }

  private parseCheckpointBoard(raw: unknown): WorkdayBoard {
    const board = this.recordValue(raw);
    const inputUrl = stringValue(board?.boardUrl ?? board?.inputUrl);
    const parsed = inputUrl ? this.parseBoardUrl(inputUrl) : undefined;
    if (!parsed) throw new Error('Workday continuation contains an invalid frozen board URL');
    return parsed;
  }

  private parseBoardUrl(value: string): WorkdayBoard | undefined {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    if (!WORKDAY_HOST_PATTERN.test(url.hostname)) return undefined;
    const [, tenant] = url.hostname.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i) ?? [];
    if (!tenant) return undefined;
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    let locale: string | undefined;
    let site: string | undefined;
    if (parts.length === 1) {
      [site] = parts;
    } else if (parts.length === 2 && SAFE_LOCALE_PATTERN.test(parts[0])) {
      [locale, site] = parts;
    } else {
      return undefined;
    }
    if (!site || !SAFE_SITE_PATTERN.test(site)) return undefined;
    const origin = url.origin;
    const boardPath = `/${locale ? `${locale}/` : ''}${encodeURIComponent(site)}`;
    const boardUrl = `${origin}${boardPath}`;
    const jobsApiUrl = `${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`;
    const key = `${url.hostname.toLowerCase()}/${tenant.toLowerCase()}/${site}`;
    return { inputUrl: value, origin, host: url.hostname.toLowerCase(), tenant, site, locale, boardUrl, jobsApiUrl, key };
  }

  private detailApiUrl(board: WorkdayBoard, externalPath: unknown): string {
    const path = stringValue(externalPath);
    if (!path || !path.startsWith('/job/') || path.includes('..') || path.startsWith('//') || /[\u0000-\u001f]/.test(path)) {
      throw new Error(`Workday ${board.key} returned an unsafe externalPath`);
    }
    const encodedTenant = encodeURIComponent(board.tenant);
    const encodedSite = encodeURIComponent(board.site);
    return `${board.origin}/wday/cxs/${encodedTenant}/${encodedSite}${path}`;
  }

  private publicJobUrl(board: WorkdayBoard, externalPath: unknown, detail: WorkdayDetailPayload): string {
    const info = this.recordValue(detail.jobPostingInfo) ?? {};
    const externalUrl = stringValue(info.externalUrl);
    if (externalUrl) {
      const parsed = this.safePublicJobUrl(board, externalUrl);
      if (parsed) return parsed;
      throw new Error(`Workday ${board.key} detail returned an unsafe externalUrl`);
    }
    const path = stringValue(externalPath);
    if (!path || !path.startsWith('/job/')) throw new Error(`Workday ${board.key} cannot build a safe public job URL`);
    const sitePrefix = `/${board.locale ? `${board.locale}/` : ''}${encodeURIComponent(board.site)}`;
    return `${board.origin}${sitePrefix}${path}`;
  }

  private safePublicJobUrl(board: WorkdayBoard, value: string): string | undefined {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (url.origin !== board.origin || url.username || url.password || url.port) return undefined;
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const siteIndex = parts[0] && SAFE_LOCALE_PATTERN.test(parts[0]) ? 1 : 0;
    if (parts[siteIndex] !== board.site || parts[siteIndex + 1] !== 'job') return undefined;
    return url.toString();
  }

  private async postListing(board: WorkdayBoard, offset: number, limit: number, timeoutMs: number, signal?: AbortSignal): Promise<WorkdayListingPayload> {
    return this.fetchJson<WorkdayListingPayload>(board.jobsApiUrl, {
      method: 'POST',
      timeoutMs,
      signal,
      accept: 'application/json',
      body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: '' }),
      contentType: 'application/json',
    });
  }

  private async fetchJson<T>(url: string, options: { method: 'GET' | 'POST'; timeoutMs: number; signal?: AbortSignal; accept: string; body?: string; contentType?: string }): Promise<T> {
    const response = await fetch(url, {
      method: options.method,
      body: options.body,
      redirect: 'manual',
      headers: this.omitUndefined({ Accept: options.accept, 'Accept-Encoding': 'identity', 'Content-Type': options.contentType, 'User-Agent': 'Mozilla/5.0' }) as Record<string, string>,
      signal: this.combinedSignal(options.signal, options.timeoutMs),
    });
    if (response.status === 429) throw new ConnectorRateLimitError(`Workday ${url} returned 429`, this.retryAfterSeconds(response.headers.get('retry-after')));
    if (!response.ok) throw new Error(`Workday ${url} returned ${response.status}`);
    const text = await this.readLimited(response, MAX_JSON_BYTES);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`Workday ${url} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async fetchText(url: string, options: { method: 'GET'; timeoutMs: number; signal?: AbortSignal; accept: string }): Promise<string> {
    const response = await fetch(url, {
      method: options.method,
      redirect: 'manual',
      headers: { Accept: options.accept, 'Accept-Encoding': 'identity', 'User-Agent': 'Mozilla/5.0' },
      signal: this.combinedSignal(options.signal, options.timeoutMs),
    });
    if (response.status === 429) throw new ConnectorRateLimitError(`Workday ${url} returned 429`, this.retryAfterSeconds(response.headers.get('retry-after')));
    if (!response.ok) throw new Error(`Workday ${url} returned ${response.status}`);
    return this.readLimited(response, MAX_JSON_BYTES);
  }

  private async readLimited(response: Response, maxBytes: number): Promise<string> {
    const body = response.body;
    if (!body) return response.text();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`Workday response exceeded ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private mapRecord(board: WorkdayBoard, listing: WorkdayListingJob, detail: WorkdayDetailPayload, detailApiUrl: string, observedAt: string): RawOpportunityRecord {
    const info = this.recordValue(detail.jobPostingInfo);
    if (!info) throw new Error(`Workday ${board.key} detail missing jobPostingInfo`);
    const id = stringValue(info.jobReqId) ?? stringValue(info.id) ?? stringValue(info.jobPostingId) ?? this.externalIdFromListing(listing);
    if (!id) throw new Error(`Workday ${board.key} detail missing stable job id`);
    const title = stringValue(info.title) ?? stringValue(listing.title);
    if (!title) throw new Error(`Workday ${board.key}:${id} missing title`);
    const rawDescription = stringValue(info.jobDescription);
    if (!rawDescription) throw new Error(`Workday ${board.key}:${id} missing public jobDescription`);
    const description = this.htmlToText(rawDescription);
    if (!description) throw new Error(`Workday ${board.key}:${id} has empty public jobDescription`);
    const url = this.publicJobUrl(board, listing.externalPath, detail);
    const startDateText = stringValue(info.startDate);
    const startDate = this.zonedDate(startDateText);
    const datePrecision = this.datePrecision(startDateText);
    const organization = this.recordValue(detail.hiringOrganization);
    const company = stringValue(organization?.name) ?? board.tenant;
    const locations = this.locations(info, listing);
    const salary = this.salaryMetadata(info, rawDescription);
    const sourceMetadata = this.omitUndefined({
      ats: 'workday',
      extraction: 'workday-cxs-v1',
      tenant: board.tenant,
      site: board.site,
      host: board.host,
      boardKey: board.key,
      boardUrl: board.boardUrl,
      detailApiUrl,
      observedAt,
      jobReqId: stringValue(info.jobReqId),
      jobPostingId: stringValue(info.jobPostingId),
      workdayId: stringValue(info.id),
      postedOn: stringValue(info.postedOn) ?? stringValue(listing.postedOn),
      startDate: startDateText,
      sourceDateField: startDateText ? 'startDate' : undefined,
      datePrecision,
      location: stringValue(info.location) ?? stringValue(listing.locationsText),
      locations,
      country: stringValue(this.recordValue(info.country)?.descriptor),
      timeType: stringValue(info.timeType),
      employment: stringValue(info.timeType),
      remoteType: stringValue(info.remoteType) ?? stringValue(listing.remoteType),
      schedule: stringValue(info.jobSchedule) ?? stringValue(info.workShift),
      salary,
    });
    return {
      externalId: `${board.key}:${id}`,
      url,
      type: 'vacancy',
      title,
      companyOrClient: company,
      description,
      publishedAt: startDate,
      sourceStatus: 'Active',
      rawPayload: { listing, detail, board, detailApiUrl, rawDescription },
      sourceMetadata,
    };
  }

  private salaryMetadata(info: Record<string, unknown>, rawDescription: string): Record<string, unknown> | undefined {
    const direct = this.recordValue(info.salary) ?? this.recordValue(info.compensation) ?? this.recordValue(info.payRange);
    if (direct) return direct;
    const text = this.htmlToText(rawDescription);
    const labeled = text.match(/Primary Location Base Pay Range:\s*(\$\s*[0-9][0-9,]{2,})(?:\.\d+)?\s*(USD)?\s*(?:-|–|—|to)\s*(\$\s*[0-9][0-9,]{2,})(?:\.\d+)?\s*(USD)?/i);
    const generic = text.match(/(\$\s*[0-9][0-9,]{2,})(?:\.\d+)?\s*(USD)?\s*(?:-|–|—|to)\s*(\$\s*[0-9][0-9,]{2,})(?:\.\d+)?\s*(USD)/i);
    const rangeMatch = labeled ?? generic;
    if (!rangeMatch) return undefined;
    const min = Number(rangeMatch[1].replace(/[$,\s]/g, ''));
    const max = Number(rangeMatch[3].replace(/[$,\s]/g, ''));
    const currency = stringValue(rangeMatch[2]) ?? stringValue(rangeMatch[4]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !currency) return undefined;
    const matchStart = rangeMatch.index ?? 0;
    const context = text.slice(Math.max(0, matchStart - 1_500), matchStart + rangeMatch[0].length + 600);
    const period = /annualized|annual/i.test(context) ? 'YEAR' : undefined;
    const otherRanges = this.otherLocationPayRanges(text, rangeMatch[0]);
    return this.omitUndefined({ min, max, currency: currency.toUpperCase(), period, originalText: rangeMatch[0].trim(), otherRanges });
  }

  private otherLocationPayRanges(text: string, primaryText: string): string[] | undefined {
    const payRangePattern = new RegExp('(?:[^:\\n]{2,120}:\\s*)?\\$\\s*[0-9][0-9,]{2,}(?:\\.\\d+)?\\s*USD\\s*(?:-|–|—|to)\\s*\\$\\s*[0-9][0-9,]{2,}(?:\\.\\d+)?\\s*USD', 'gi');
    const ranges = [...text.matchAll(payRangePattern)]
      .map((match) => match[0].trim())
      .filter((range) => range !== primaryText.trim());
    return ranges.length > 0 ? [...new Set(ranges)] : undefined;
  }

  private locations(info: Record<string, unknown>, listing: WorkdayListingJob): string[] {
    const values = [
      stringValue(info.location),
      ...this.stringArray(info.additionalLocations),
      stringValue(this.recordValue(info.jobRequisitionLocation)?.descriptor),
      stringValue(listing.locationsText),
    ];
    return [...new Set(values.filter((value): value is string => Boolean(value)))];
  }

  private htmlToText(html: string): string {
    const $ = load(html);
    $('script,style,noscript').remove();
    const blockTags = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul']);
    const render = (node: unknown): string => {
      const current = node as { type?: string; name?: string; data?: string; children?: unknown[] };
      if (current.type === 'text') return current.data ?? '';
      if (current.type !== 'tag' && current.type !== 'root') return '';
      const name = (current.name ?? '').toLowerCase();
      if (name === 'script' || name === 'style' || name === 'noscript') return '';
      if (name === 'br') return '\n';
      const children = (current.children ?? []).map(render).join('');
      if (name === 'li') return `\n- ${children.trim()}\n`;
      if (blockTags.has(name)) return `\n${children.trim()}\n`;
      return children;
    };
    const rendered = $.root()
      .contents()
      .toArray()
      .map(render)
      .join('')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (rendered || !this.extraction) return rendered;
    try {
      return this.extraction.documentToRecord({ finalUrl: 'https://workday.wd5.myworkdayjobs.com/Workday/job/local', html, metadata: { firecrawl: false } }, { sourceId: 'workday', sourceName: 'Workday', type: 'vacancy' }).description ?? '';
    } catch {
      return rendered;
    }
  }


  private frozenTotal(checkpoint: WorkdayCheckpoint, board: WorkdayBoard): number | undefined {
    const total = numberValue(this.recordValue(checkpoint.totals)?.[board.key]);
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return undefined;
    return total;
  }

  private requiredTotal(value: unknown, board: WorkdayBoard): number {
    const total = numberValue(value);
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) throw new Error(`Workday ${board.key} listing missing numeric total`);
    return total;
  }

  private requiredJobPostings(value: unknown, board: WorkdayBoard): WorkdayListingJob[] {
    if (!Array.isArray(value)) throw new Error(`Workday ${board.key} listing missing jobPostings array`);
    return value.map((entry, index) => {
      const job = this.recordValue(entry);
      if (!job) throw new Error(`Workday ${board.key} listing job ${index} is not an object`);
      const externalPath = stringValue(job.externalPath);
      if (!externalPath) throw new Error(`Workday ${board.key} listing job ${index} missing externalPath`);
      this.detailApiUrl(board, externalPath);
      return job as WorkdayListingJob;
    });
  }

  private externalIdFromListing(listing: WorkdayListingJob): string | undefined {
    const bullet = Array.isArray(listing.bulletFields) ? listing.bulletFields.map((value) => stringValue(value)).find(Boolean) : undefined;
    const pathId = stringValue(listing.externalPath)?.split('_').pop();
    return bullet ?? pathId;
  }

  private window(ctx: FetchContext, continuing: boolean, checkpoint: WorkdayCheckpoint): WorkdayWindow {
    const since = continuing && stringValue(checkpoint.backfillSince) ? new Date(stringValue(checkpoint.backfillSince) as string) : new Date(ctx.backfillSince ?? Date.now() - Math.min(ctx.backfillDays || MAX_BACKFILL_DAYS, MAX_BACKFILL_DAYS) * 86_400_000);
    const to = continuing && stringValue(checkpoint.windowTo) ? new Date(stringValue(checkpoint.windowTo) as string) : new Date();
    if (!Number.isFinite(since.getTime()) || !Number.isFinite(to.getTime())) throw new Error('Workday checkpoint contains invalid collection window');
    return { since, to, sinceIso: since.toISOString(), toIso: to.toISOString() };
  }

  private pageLimit(ctx: FetchContext, checkpoint: WorkdayCheckpoint): number {
    const existing = numberValue(checkpoint.limit);
    if (existing && Number.isInteger(existing) && existing > 0 && existing <= MAX_LIMIT) return existing;
    const configured = numberValue(this.recordValue(ctx.source.limits)?.perPage) ?? DEFAULT_LIMIT;
    return Math.max(1, Math.min(MAX_LIMIT, Math.floor(configured)));
  }

  private integerInRange(value: unknown, min: number, max: number, label: string): number {
    const parsed = this.nonNegativeInteger(value, label);
    if (parsed < min || parsed > max) throw new Error(`${label} is outside the board list`);
    return parsed;
  }

  private nonNegativeInteger(value: unknown, label: string): number {
    const parsed = numberValue(value);
    if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
    return parsed;
  }

  private zonedDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : undefined;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    return undefined;
  }

  private datePrecision(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'day';
    if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return 'instant';
    return undefined;
  }

  private recordWithinWindow(record: RawOpportunityRecord, window: WorkdayWindow): boolean {
    if (record.publishedAt) return record.publishedAt >= window.since && record.publishedAt <= window.to;
    const startDate = stringValue(record.sourceMetadata.startDate);
    if (!startDate || record.sourceMetadata.datePrecision !== 'day' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return true;
    const dayStart = new Date(`${startDate}T00:00:00.000Z`).getTime() - 14 * 60 * 60 * 1000;
    const dayEnd = new Date(`${startDate}T00:00:00.000Z`).getTime() + 38 * 60 * 60 * 1000;
    if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd)) return true;
    return dayEnd >= window.since.getTime() && dayStart <= window.to.getTime();
  }

  private discoverySeeds(ctx: ConnectorContext): string[] {
    const config = this.recordValue(ctx.source.config) ?? {};
    const urls = [...this.stringArray(config.discoveryUrls)];
    for (const host of this.stringArray(config.discoveryHosts)) {
      if (!/^[a-z0-9.-]+$/i.test(host) || host.includes('..')) throw new Error(`Unsafe Workday discovery host: ${host}`);
      urls.push(`https://${host}`);
    }
    return [...new Set(urls)].filter((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port;
      } catch {
        return false;
      }
    });
  }

  private extractBoardLinks(html: string, seed: string): string[] {
    const links = new Set<string>();
    const $ = load(html);
    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;
      try {
        const resolved = new URL(href, seed).toString();
        if (this.parseBoardUrl(resolved)) links.add(resolved);
      } catch {
        // ignore malformed page links
      }
    });
    const regex = /https:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/[A-Za-z0-9_\/-]+/gi;
    for (const match of html.matchAll(regex)) {
      const parsed = this.parseBoardUrl(match[0]);
      if (parsed) links.add(parsed.boardUrl);
    }
    return [...links];
  }

  private combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) return timeout;
    return AbortSignal.any([signal, timeout]);
  }

  private retryAfterSeconds(value: string | null): number {
    if (!value) return 60;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.ceil(numeric);
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return Math.max(1, Math.ceil((date.getTime() - Date.now()) / 1000));
    return 60;
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private stringArray(value: unknown): string[] {
    if (!value) return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw.map((entry) => stringValue(entry)).filter((entry): entry is string => Boolean(entry));
  }

  private singleString(value: unknown): string[] {
    const string = stringValue(value);
    return string ? [string] : [];
  }

  private omitUndefined<T extends Record<string, unknown>>(input: T): T {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
  }
}
