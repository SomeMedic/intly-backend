import { load } from 'cheerio';

import { WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { numberValue, stringValue } from './connector-utils';

const ORIGIN = 'https://kwork.ru';
const LIST_URL = `${ORIGIN}/projects`;
const MAX_BACKFILL_DAYS = 30;
const MAX_HTML_BYTES = 2_000_000;
const DAY_MS = 86_400_000;

type CollectionWindow = { since: string; until: string };
type KworkState = Record<string, unknown> & {
  wantsListData?: {
    pagination?: {
      current_page?: unknown;
      data?: unknown;
      last_page?: unknown;
      next_page_url?: unknown;
      total?: unknown;
    };
  };
  categories?: unknown;
};

type KworkProject = Record<string, unknown> & {
  id?: unknown;
  status?: unknown;
  name?: unknown;
  description?: unknown;
  category_id?: unknown;
  files?: unknown;
  kwork_count?: unknown;
  priceLimit?: unknown;
  possiblePriceLimit?: unknown;
  date_create?: unknown;
  date_active?: unknown;
  date_expire?: unknown;
  user?: unknown;
};

type KworkDocument = {
  finalUrl: string;
  state: KworkState;
  projects: KworkProject[];
  pagination: NonNullable<NonNullable<KworkState['wantsListData']>['pagination']>;
};

type KworkDocumentAttachment = {
  label: string;
  url: string;
};

export class KworkConnector implements Connector {
  readonly id = 'kwork';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly extraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: MAX_BACKFILL_DAYS };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    try {
      const url = this.configuredListUrl(config);
      return { ok: true, message: 'Kwork public project catalog configured', details: { url } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Kwork public project catalog is not configured' };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const document = await this.extractStage('health-listing', LIST_URL, ctx);
      if (document.finalUrl !== LIST_URL || this.pageNumber(document.finalUrl) !== 1 || numberValue(document.pagination.current_page) !== 1) {
        throw new Error('Kwork health listing did not return the first public project page');
      }
      for (const project of document.projects) this.record(project, document.state.categories, document.finalUrl);
      return { state: document.projects.length > 0 ? 'Healthy' : 'Failed', message: `Kwork returned ${document.projects.length} public project cards`, checkedAt: new Date(), details: { cards: document.projects.length, page: this.pageNumber(document.finalUrl) } };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'Kwork health failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    this.configuredListUrl({ ...(ctx.source.endpoint ?? {}), ...(ctx.source.config ?? {}) });
    const window = this.collectionWindow(ctx);
    const continuing = ctx.checkpoint.hasMore === true;
    const requestedUrl = this.nextListUrl(ctx);
    const previousVisited = continuing ? this.checkpointStrings(ctx.checkpoint.visitedListUrls, 'visited listing URLs') : [];
    if (previousVisited.includes(requestedUrl)) throw new Error(`Kwork continuation repeats a previously visited page: ${requestedUrl}`);

    const document = await this.extractStage('listing', requestedUrl, ctx);
    const finalUrl = this.assertListUrl(document.finalUrl);
    if (finalUrl !== requestedUrl) throw new Error('Kwork catalog redirected to a different page or filter');

    const priorSeen = new Set(continuing ? this.checkpointStrings(ctx.checkpoint.seenNativeIds, 'seen native IDs') : []);
    const pageSeen = new Set<string>();
    const records: RawOpportunityRecord[] = [];
    for (const project of document.projects) {
      const externalId = this.projectId(project);
      if (pageSeen.has(externalId)) throw new Error(`Kwork listing repeats native project ID ${externalId}`);
      pageSeen.add(externalId);
      if (priorSeen.has(externalId)) continue;
      const record = this.record(project, document.state.categories, finalUrl);
      if (this.withinWindow(record.publishedAt, window)) records.push(record);
    }

    const visitedListUrls = Array.from(new Set([...previousVisited, finalUrl]));
    const nextUrl = this.nextPageUrl(document.pagination.next_page_url, finalUrl);
    if (nextUrl && visitedListUrls.includes(nextUrl)) throw new Error(`Kwork pagination cycle detected at ${nextUrl}`);
    const seenNativeIds = Array.from(new Set([...priorSeen, ...pageSeen]));
    const checkpoint = nextUrl
      ? { hasMore: true, nextUrl, nextPage: this.pageNumber(nextUrl), visitedListUrls, seenNativeIds, windowSince: window.since, windowUntil: window.until, coverage: 'native-public-project-catalog', lastFetchedAt: new Date().toISOString(), seen: document.projects.length, emitted: records.length }
      : { hasMore: false, visitedListUrls, seenNativeIds, terminalReason: 'observed-pagination-exhausted', windowSince: window.since, windowUntil: window.until, coverage: 'native-public-project-catalog', lastFetchedAt: new Date().toISOString(), seen: document.projects.length, emitted: records.length };

    return { records, hasMore: Boolean(nextUrl), nextPage: nextUrl ? this.pageNumber(nextUrl) : undefined, checkpoint, stats: { seen: document.projects.length } };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private record(project: KworkProject, categories: unknown, listUrl: string): RawOpportunityRecord {
    const externalId = this.projectId(project);
    const title = stringValue(project.name);
    if (!title) throw new Error(`Kwork project ${externalId} has no public title`);
    const description = this.description(project.description);
    if (!description) throw new Error(`Kwork project ${externalId} has no public description`);
    const publishedAt = this.moscowDate(project.date_create, `Kwork project ${externalId} creation date`);
    const updatedAt = this.optionalMoscowDate(project.date_active, `Kwork project ${externalId} active date`);
    const deadlineAt = this.optionalMoscowDate(project.date_expire, `Kwork project ${externalId} expiry date`);
    const desiredBudget = this.money(project.priceLimit, 'desired-upper-bound');
    const allowableBudget = this.money(project.possiblePriceLimit, 'allowable-upper-bound');
    const attachments = this.attachments(project.files);
    const categoryTags = this.categoryTags(categories, project.category_id);
    const user = this.recordValue(project.user);
    const clientUsername = stringValue(user?.username);
    const bids = numberValue(project.kwork_count);
    const statusText = stringValue(project.status);
    const sourceDocuments = attachments.map(({ label, url }) => ({ label, url }));
    const url = `${ORIGIN}/projects/${externalId}/view`;
    const freelanceData = {
      desiredBudget,
      allowableBudget,
      bids,
      attachments,
      maxDays: stringValue(project.max_days),
      categoryId: stringValue(project.category_id),
      clientUsername,
      statusText,
    };

    return {
      externalId,
      url,
      type: 'freelance',
      title,
      companyOrClient: clientUsername,
      description,
      publishedAt,
      updatedAt,
      sourceStatus: this.sourceStatus(project),
      rawPayload: { listUrl, project },
      sourceMetadata: {
        extraction: 'kwork-native-state-v1',
        sourceUrl: listUrl,
        detailUrl: url,
        descriptionCoverage: 'list-native-full',
        datePrecision: 'second',
        dateTimezone: 'Europe/Moscow',
        publishedText: stringValue(project.date_create),
        updatedText: stringValue(project.date_active),
        deadlineAt: deadlineAt?.toISOString(),
        deadlineText: stringValue(project.date_expire),
        deadlinePrecision: deadlineAt ? 'second' : undefined,
        deadlineTimezone: deadlineAt ? 'Europe/Moscow' : undefined,
        budget: desiredBudget,
        price: desiredBudget,
        allowableBudget,
        priceText: stringValue(project.priceLimit),
        categoryTags,
        skills: categoryTags,
        bids,
        clientPublicName: clientUsername,
        sourceDocuments,
        freelanceData,
      },
    };
  }

  private configuredListUrl(config: Record<string, unknown>): string {
    const configured = stringValue(config.baseUrl) ?? stringValue(config.url) ?? LIST_URL;
    const url = new URL(configured);
    if (url.origin !== ORIGIN || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/projects') {
      throw new Error('Kwork connector only supports https://kwork.ru/projects');
    }
    return LIST_URL;
  }

  private async extractStage(stage: 'health-listing' | 'listing', url: string, ctx: FetchContext | ConnectorContext): Promise<KworkDocument> {
    try {
      const document = await this.extraction.extractUrl(url, { allowedHosts: ['kwork.ru'], timeoutMs: ctx.source.timeoutMs ?? 30_000, maxBytes: MAX_HTML_BYTES, signal: ctx.signal });
      const finalUrl = this.assertListUrl(document.finalUrl);
      const state = this.stateData(document.html);
      const pagination = this.pagination(state);
      if (numberValue(pagination.current_page) !== this.pageNumber(finalUrl)) throw new Error('Kwork native page number contradicts the requested listing page');
      if (numberValue(pagination.current_page)! < numberValue(pagination.last_page)! && !pagination.next_page_url) throw new Error('Kwork native pagination is missing the next page before its declared last page');
      const projects = this.projects(pagination);
      return { finalUrl, state, projects, pagination };
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error);
      const annotated = new Error(`Kwork ${stage} fetch failed for ${url}: ${message}`);
      (annotated as Error & { cause?: unknown }).cause = error;
      throw annotated;
    }
  }

  private nextListUrl(ctx: FetchContext): string {
    if (ctx.checkpoint.hasMore !== true) return LIST_URL;
    const nextUrl = typeof ctx.checkpoint.nextUrl === 'string' ? this.listUrl(ctx.checkpoint.nextUrl) : undefined;
    if (!nextUrl) throw new Error('Kwork continuation has an invalid listing URL');
    const checkpoint = this.fixedCheckpointWindow(ctx.checkpoint);
    if (ctx.backfillSince && ctx.backfillSince !== checkpoint.since) throw new Error('Kwork continuation cannot change its fixed publication window');
    return nextUrl;
  }

  private assertListUrl(value: string): string {
    const url = this.listUrl(value);
    if (!url) throw new Error('Kwork catalog redirected outside its public project listing');
    return url;
  }

  private listUrl(value: string): string | undefined {
    try {
      const url = new URL(value, LIST_URL);
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname !== 'kwork.ru' || url.port || url.username || url.password || url.hash || url.pathname !== '/projects') return undefined;
      if ([...url.searchParams.keys()].some((key) => key !== 'page')) return undefined;
      if (url.searchParams.getAll('page').length > 1) return undefined;
      const page = url.searchParams.get('page');
      if (page !== null && (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)))) return undefined;
      const normalized = new URL(LIST_URL);
      if (page && page !== '1') normalized.searchParams.set('page', page);
      return normalized.toString();
    } catch {
      return undefined;
    }
  }

  private nextPageUrl(value: unknown, finalUrl: string): string | undefined {
    if (value === null || value === undefined || value === false || value === '') return undefined;
    const url = typeof value === 'string' ? this.listUrl(value) : undefined;
    if (!url) throw new Error('Kwork pagination returned an unsafe next page URL');
    if (this.pageNumber(url) !== this.pageNumber(finalUrl) + 1) throw new Error('Kwork pagination skipped or reversed a page');
    return url;
  }

  private pageNumber(value: string): number {
    return Number.parseInt(new URL(value, LIST_URL).searchParams.get('page') ?? '1', 10);
  }

  private stateData(html: string): KworkState {
    const marker = /window\.stateData\s*=\s*/.exec(html);
    if (!marker) throw new Error('Kwork page does not expose window.stateData');
    const objectStart = marker.index + marker[0].length;
    if (html[objectStart] !== '{') throw new Error('Kwork stateData assignment is not an immediate JSON object');
    const objectEnd = this.balancedJsonEnd(html, objectStart);
    const text = html.slice(objectStart, objectEnd + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Kwork stateData is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Kwork stateData shape is not an object');
    return parsed as KworkState;
  }

  private balancedJsonEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    throw new Error('Kwork stateData JSON object is not closed');
  }

  private pagination(state: KworkState): NonNullable<NonNullable<KworkState['wantsListData']>['pagination']> {
    const pagination = this.recordValue(state.wantsListData)?.pagination;
    if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) throw new Error('Kwork stateData is missing wantsListData.pagination');
    const current = numberValue((pagination as Record<string, unknown>).current_page);
    const last = numberValue((pagination as Record<string, unknown>).last_page);
    if (current === undefined || last === undefined || !Number.isSafeInteger(current) || current < 1 || !Number.isSafeInteger(last) || last < current) throw new Error('Kwork pagination identity is invalid');
    return pagination as NonNullable<NonNullable<KworkState['wantsListData']>['pagination']>;
  }

  private projects(pagination: NonNullable<NonNullable<KworkState['wantsListData']>['pagination']>): KworkProject[] {
    if (!Array.isArray(pagination.data)) throw new Error('Kwork pagination has no project data array');
    const projects = pagination.data.filter((item): item is KworkProject => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
    if (projects.length !== pagination.data.length) throw new Error('Kwork pagination contains malformed project records');
    if (!projects.length) return [];
    for (const project of projects) this.projectId(project);
    return projects;
  }

  private projectId(project: KworkProject): string {
    const id = numberValue(project.id);
    if (id === undefined || !Number.isSafeInteger(id) || id <= 0) throw new Error('Kwork project has an invalid native ID');
    return String(id);
  }

  private description(value: unknown): string | undefined {
    const raw = stringValue(value);
    if (!raw) return undefined;
    const $ = load(`<main>${raw.replace(/\r\n?/g, '\n').replace(/\n/g, '<br>')}</main>`);
    $('br').replaceWith('\n');
    return stringValue(($('main').text() ?? '').replace(/\n{3,}/g, '\n\n'));
  }

  private money(value: unknown, kind: string): { max?: number; currency?: 'RUB'; originalText?: string; kind: string } {
    const amount = numberValue(value);
    return {
      max: Number.isFinite(amount) && amount! > 0 ? amount : undefined,
      currency: Number.isFinite(amount) && amount! > 0 ? 'RUB' : undefined,
      originalText: value === undefined || value === null ? undefined : String(value),
      kind,
    };
  }

  private sourceStatus(project: KworkProject): RawOpportunityRecord['sourceStatus'] {
    const status = stringValue(project.status)?.toLowerCase();
    if (status === 'active' || project.isWantActive === true) return 'Active';
    if (status === 'archived' || project.isWantArchive === true) return 'Closed';
    if (status === 'cancel' || status === 'delete' || status === 'stop' || status === 'user_stop') return 'Removed';
    return 'Unknown';
  }

  private attachments(value: unknown): KworkDocumentAttachment[] {
    if (!Array.isArray(value)) return [];
    const attachments: KworkDocumentAttachment[] = [];
    for (const item of value) {
      const file = this.recordValue(item);
      const label = stringValue(file?.fname);
      const url = this.fileUrl(file?.url);
      if (label && url) attachments.push({ label, url });
    }
    return attachments;
  }

  private fileUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    try {
      const url = new URL(value, ORIGIN);
      if (url.origin !== ORIGIN || url.username || url.password || url.hash || !url.pathname.startsWith('/files/uploaded/')) return undefined;
      return url.toString();
    } catch {
      return undefined;
    }
  }

  private categoryTags(categories: unknown, categoryId: unknown): string[] {
    const id = stringValue(categoryId);
    if (!id) return [];
    const path = this.findCategoryPath(categories, id, []);
    return path ? Array.from(new Set(path)) : [];
  }

  private findCategoryPath(value: unknown, categoryId: string, parentPath: string[]): string[] | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findCategoryPath(item, categoryId, parentPath);
        if (found) return found;
      }
      return undefined;
    }
    const record = this.recordValue(value);
    if (!record) return undefined;
    const id = stringValue(record.CATID) ?? stringValue(record.id);
    const name = stringValue(record.name);
    const path = name ? [...parentPath, name] : parentPath;
    if (id === categoryId) return path;
    const nested = record.cats;
    if (nested) return this.findCategoryPath(nested, categoryId, path);
    for (const child of Object.values(record)) {
      const found = this.findCategoryPath(child, categoryId, parentPath);
      if (found) return found;
    }
    return undefined;
  }

  private moscowDate(value: unknown, label: string): Date {
    const parsed = this.optionalMoscowDate(value, label);
    if (!parsed) throw new Error(`${label} is invalid`);
    return parsed;
  }

  private optionalMoscowDate(value: unknown, label: string): Date | undefined {
    const text = stringValue(value);
    if (!text) return undefined;
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
    if (!match) throw new Error(`${label} is invalid`);
    const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+03:00`);
    if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid`);
    const moscow = new Date(parsed.getTime() + 3 * 60 * 60 * 1000);
    const roundTrip = [
      moscow.getUTCFullYear(),
      moscow.getUTCMonth() + 1,
      moscow.getUTCDate(),
      moscow.getUTCHours(),
      moscow.getUTCMinutes(),
      moscow.getUTCSeconds(),
    ];
    const parts = match.slice(1).map((part) => Number(part));
    if (roundTrip.some((value, index) => value !== parts[index])) throw new Error(`${label} is invalid`);
    return parsed;
  }

  private collectionWindow(ctx: FetchContext): CollectionWindow {
    const continuingSameWindow = ctx.checkpoint.hasMore === true && (!ctx.backfillSince || ctx.backfillSince === ctx.checkpoint.windowSince);
    if (ctx.checkpoint.hasMore === true) {
      const checkpoint = this.fixedCheckpointWindow(ctx.checkpoint);
      if (!continuingSameWindow) throw new Error('Kwork continuation cannot change its fixed publication window');
      return checkpoint;
    }
    const backfillDays = Math.min(Math.max(ctx.backfillDays || 1, 1), MAX_BACKFILL_DAYS);
    const now = new Date();
    if (ctx.backfillSince) {
      const explicitSince = Date.parse(ctx.backfillSince);
      if (!Number.isFinite(explicitSince) || explicitSince > now.getTime()) throw new Error('Kwork initial publication boundary is invalid or in the future');
      const until = new Date(Math.min(now.getTime(), explicitSince + backfillDays * DAY_MS));
      return { since: new Date(explicitSince).toISOString(), until: until.toISOString() };
    }
    return { since: new Date(now.getTime() - backfillDays * DAY_MS).toISOString(), until: now.toISOString() };
  }

  private fixedCheckpointWindow(checkpoint: Record<string, unknown>): CollectionWindow {
    const since = typeof checkpoint.windowSince === 'string' ? Date.parse(checkpoint.windowSince) : NaN;
    const until = typeof checkpoint.windowUntil === 'string' ? Date.parse(checkpoint.windowUntil) : NaN;
    if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error('Kwork continuation has invalid fixed publication boundaries');
    return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
  }

  private withinWindow(date: Date | undefined, window: CollectionWindow): boolean {
    if (!date) return true;
    return date.getTime() >= Date.parse(window.since) && date.getTime() <= Date.parse(window.until);
  }

  private checkpointStrings(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) throw new Error(`Kwork continuation has invalid ${label}`);
    const strings = value.filter((item): item is string => typeof item === 'string');
    if (strings.length !== value.length) throw new Error(`Kwork continuation has invalid ${label}`);
    return strings;
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }
}
