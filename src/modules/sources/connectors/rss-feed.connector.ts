import { fetch as undiciFetch } from 'undici';

import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { WebExtractionService } from '../extraction/web-extraction.service';
import { loadRuntimePackage, stringValue } from './connector-utils';
import { createPinnedDispatcher } from '../extraction/pinned-fetch';
import { parseHttpUrl } from '../extraction/url-safety';

type RssResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};

type RssFetcher = (url: string, ctx: FetchContext) => Promise<RssResponse>;

const MAX_FEED_BYTES = 2_000_000;
const DETAIL_CONCURRENCY = 4;
const FEED_WINDOW = 'finite_current_feed';
const XML_ROOT_RE = /^\s*(?:\uFEFF\s*)?(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<([A-Za-z_][\w:.-]*)(?:\s|>|\/)/;
const XML_CONTENT_TYPE_RE = /(?:^|[/+;\s-])(xml|rss|atom)(?:$|[/+;\s-])/i;
const TEXT_CONTENT_TYPE_RE = /^\s*text\/(?:plain|xml)\b/i;
const HTML_CONTENT_TYPE_RE = /^\s*text\/html\b/i;

export class RssFeedConnector implements Connector {
  readonly family = 'OfficialFeed' as const;

  constructor(
    readonly id: 'habr' | 'weworkremotely',
    private readonly feedUrl: string,
    private readonly fetcher: RssFetcher = fetchPinnedRss,
    private readonly webExtraction?: WebExtractionService,
  ) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: 30 };
  }

  async validateConfig(): Promise<ValidationResult> {
    return { ok: true, message: `${this.id} RSS feed configured` };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const page = await this.fetchPage({ ...ctx, checkpoint: {}, backfillDays: 1 });
      return { state: 'Healthy', message: `${this.id} RSS returned ${page.records.length} records`, checkedAt: new Date() };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : `${this.id} RSS health failed`, checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const response = await this.fetcher(this.feedUrl, ctx);
    if (response.status === 429) {
      throw new ConnectorRateLimitError(`${this.id} RSS rate limited`, retryAfterSeconds(response.headers.get('retry-after')));
    }
    if (!response.ok) throw new Error(`${this.id} RSS returned ${response.status}`);

    const contentType = response.headers.get('content-type') ?? '';
    const xml = decodeFeed(await response.arrayBuffer(), this.id);
    assertXmlFeed(this.id, contentType, xml);

    const { XMLParser } = await loadRuntimePackage<{ XMLParser: new (options: Record<string, unknown>) => { parse(xml: string): Record<string, unknown> } }>('fast-xml-parser');
    const parser = new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
      htmlEntities: false,
      parseTagValue: false,
      trimValues: true,
      stopNodes: ['*.description', '*.content:encoded', '*.summary'],
    });
    const parsed = parser.parse(xml);
    const items = this.feedItems(parsed);
    const defaultCutoff = this.cutoff(ctx);
    const wwrWindow = this.id === 'weworkremotely' ? this.weWorkRemotelyWindow(ctx, defaultCutoff) : undefined;
    const cutoff = wwrWindow?.cutoff ?? defaultCutoff;
    const windowUntil = wwrWindow?.windowUntil;
    const backfillSince = wwrWindow?.backfillSince ?? defaultCutoff.toISOString();
    const seenIds = new Set<string>();
    const records: RawOpportunityRecord[] = [];
    let seen = 0;

    for (const value of items) {
      if (!value || typeof value !== 'object') continue;
      const record = this.toRecord(value as Record<string, unknown>, ctx.source.name);
      if (!record) continue;
      if (seenIds.has(record.externalId)) continue;
      seenIds.add(record.externalId);
      seen += 1;
      if (record.publishedAt && record.publishedAt < cutoff) continue;
      if (windowUntil && record.publishedAt && record.publishedAt > windowUntil) continue;
      records.push(record);
    }

    const enriched = this.webExtraction ? await this.enrichRecords(records, ctx) : records;
    const checkpoint = this.id === 'weworkremotely'
      ? {
        lastFetchedAt: new Date().toISOString(),
        feedWindow: FEED_WINDOW,
        backfillSince,
        windowUntil: windowUntil?.toISOString(),
        hasMore: false,
        terminalReason: 'finite-feed-exhausted',
        seen,
        retained: enriched.length,
      }
      : { lastFetchedAt: new Date().toISOString(), feedWindow: FEED_WINDOW, backfillSince };

    return {
      records: enriched,
      checkpoint,
      hasMore: false,
      stats: { seen: enriched.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private feedItems(parsed: Record<string, unknown>): unknown[] {
    const rss = parsed.rss as Record<string, unknown> | undefined;
    const channel = rss?.channel as Record<string, unknown> | undefined;
    const atom = parsed.feed as Record<string, unknown> | undefined;
    const rdf = parsed['rdf:RDF'] as Record<string, unknown> | undefined;
    return [
      ...this.toArray(channel?.item),
      ...this.toArray(atom?.entry),
      ...this.toArray(rdf?.item),
    ];
  }

  private toRecord(item: Record<string, unknown>, sourceName: string): RawOpportunityRecord | null {
    const externalId = this.text(item.guid) ?? this.text(item.id) ?? this.text(item.link);
    const title = this.text(item.title);
    if (!externalId || !title) return null;
    if (this.id === 'weworkremotely') return this.toWeWorkRemotelyRecord(item, externalId, title);
    return {
      externalId,
      url: this.text(item.link) ?? this.feedUrl,
      type: 'vacancy',
      title,
      companyOrClient: sourceName,
      description: this.text(item['content:encoded']) ?? this.text(item.description) ?? this.text(item.summary),
      publishedAt: this.date(this.text(item.pubDate) ?? this.text(item.published) ?? this.text(item.updated)),
      sourceStatus: 'Unknown',
      rawPayload: item,
      sourceMetadata: { feedUrl: this.feedUrl, feedWindow: FEED_WINDOW, descriptionCoverage: 'feed-content' },
    };
  }

  private toWeWorkRemotelyRecord(item: Record<string, unknown>, externalId: string, rawTitle: string): RawOpportunityRecord {
    const titleParts = splitWeWorkRemotelyTitle(decodeXmlEntities(rawTitle));
    const region = this.text(item.region);
    const country = this.text(item.country);
    const state = this.text(item.state);
    const category = this.text(item.category);
    const nativeType = this.text(item.type);
    const nativeSkillsText = this.text(item.skills);
    const skills = splitWeWorkRemotelySkills(nativeSkillsText);
    const expiresAt = this.date(this.text(item.expires_at));
    const sourceMetadata = {
      feedUrl: this.feedUrl,
      feedWindow: FEED_WINDOW,
      descriptionCoverage: 'feed-content',
      remoteType: 'remote',
      ...(region ? { area: region, region, nativeRegion: region } : {}),
      ...(country ? { country, nativeCountry: country } : {}),
      ...(state ? { state, nativeState: state } : {}),
      ...(category ? { category, nativeCategory: category } : {}),
      ...(nativeType ? { employment: nativeType, nativeType } : {}),
      ...(skills.length ? { skills, nativeSkills: skills, nativeSkillsText } : {}),
      ...(expiresAt ? { deadlineAt: expiresAt.toISOString(), nativeExpiresAt: expiresAt.toISOString() } : {}),
    };
    return {
      externalId,
      url: this.text(item.link) ?? this.feedUrl,
      type: 'vacancy',
      title: titleParts.title,
      companyOrClient: titleParts.companyOrClient,
      description: decodeXmlEntities(this.text(item['content:encoded']) ?? this.text(item.description) ?? this.text(item.summary) ?? ''),
      publishedAt: this.date(this.text(item.pubDate) ?? this.text(item.published) ?? this.text(item.updated)),
      sourceStatus: 'Unknown',
      rawPayload: item,
      sourceMetadata,
    };
  }


  private async enrichRecords(records: RawOpportunityRecord[], ctx: FetchContext): Promise<RawOpportunityRecord[]> {
    return mapWithConcurrency(records, DETAIL_CONCURRENCY, async (record) => {
      throwIfAborted(ctx.signal);
      const detailUrl = this.verifiedDetailUrl(record.url);
      const detail = await this.webExtraction!.extractOpportunityFromUrl(detailUrl, {
        sourceId: ctx.source._id,
        sourceName: ctx.source.name,
        type: 'vacancy',
        allowedHosts: [new URL(this.feedUrl).hostname],
        requireOpportunitySignal: true,
        signal: ctx.signal,
      });
      throwIfAborted(ctx.signal);
      if (this.verifiedDetailUrl(detail.url) !== detailUrl) throw new Error(`${this.id} RSS detail redirected to a different vacancy`);
      return this.mergeDetailRecord(record, detail, detailUrl);
    });
  }

  private mergeDetailRecord(feedRecord: RawOpportunityRecord, detail: RawOpportunityRecord, detailUrl: string): RawOpportunityRecord {
    return {
      ...detail,
      externalId: feedRecord.externalId,
      url: detail.url || detailUrl,
      type: 'vacancy',
      publishedAt: feedRecord.publishedAt,
      rawPayload: {
        feed: feedRecord.rawPayload,
        detail: detail.rawPayload,
        feedUrl: this.feedUrl,
        detailUrl,
        originalFeedExternalId: feedRecord.externalId,
        originalFeedPublishedAt: feedRecord.publishedAt?.toISOString(),
        feedDescription: feedRecord.description,
        descriptionCoverage: 'detail-full',
      },
      sourceMetadata: {
        ...detail.sourceMetadata,
        ...(this.id === 'habr' ? this.habrDeclaredFacts(detail.description) : {}),
        feedUrl: this.feedUrl,
        feedWindow: FEED_WINDOW,
        detailUrl,
        detailSourceUrl: detail.url,
        originalFeedExternalId: feedRecord.externalId,
        originalFeedPublishedAt: feedRecord.publishedAt?.toISOString(),
        feedDescription: feedRecord.description,
        descriptionCoverage: 'detail-full',
      },
    };
  }

  private habrDeclaredFacts(description?: string): Record<string, unknown> {
    const declared = /^Навыки:\s*([\s\S]*?)\.\s*(?:Квалификация:\s*(.*?)\.\s*)?Специализации:/i.exec(description ?? '');
    if (!declared) return {};
    const skills = [...new Set(declared[1].split(',').map((value) => value.trim()).filter(Boolean))];
    const seniority = declared[2]?.trim();
    return { ...(skills.length ? { skills } : {}), ...(seniority ? { seniority } : {}) };
  }

  private verifiedDetailUrl(inputUrl: string): string {
    let url: URL;
    try {
      url = new URL(inputUrl, this.feedUrl);
    } catch {
      throw new Error(`${this.id} RSS item has an invalid detail URL`);
    }
    const feedOrigin = new URL(this.feedUrl).origin;
    if (url.origin !== feedOrigin || url.protocol !== 'https:' || url.port || url.username || url.password) {
      throw new Error(`${this.id} RSS item detail URL is outside the allowed feed host`);
    }
    if (url.search || url.hash) throw new Error(`${this.id} RSS item detail URL is not a canonical vacancy URL`);
    if (this.id === 'habr' && !/^\/vacancies\/\d+\/?$/.test(url.pathname)) {
      throw new Error(`${this.id} RSS item detail URL is not a canonical Habr vacancy URL`);
    }
    if (this.id === 'weworkremotely' && !/^\/remote-jobs\/[a-z0-9][a-z0-9-]*\/?$/i.test(url.pathname)) {
      throw new Error(`${this.id} RSS item detail URL is not a canonical We Work Remotely job URL`);
    }
    return url.toString();
  }

  private cutoff(ctx: FetchContext): Date {
    const backfillDays = Math.min(Math.max(ctx.backfillDays || 1, 1), 30);
    const byDays = Date.now() - backfillDays * 86_400_000;
    const explicitSince = ctx.backfillSince ? Date.parse(ctx.backfillSince) : NaN;
    return new Date(Number.isFinite(explicitSince) ? explicitSince : byDays);
  }

  private weWorkRemotelyWindow(ctx: FetchContext, fallbackCutoff: Date): { backfillSince: string; cutoff: Date; windowUntil: Date } {
    const requestedLower = this.isoDateString(ctx.backfillSince) ?? fallbackCutoff.toISOString();
    const checkpointLower = this.isoDateString(typeof ctx.checkpoint.backfillSince === 'string' ? ctx.checkpoint.backfillSince : undefined);
    const sameWindow = checkpointLower === requestedLower;
    const checkpointUpper = sameWindow && typeof ctx.checkpoint.windowUntil === 'string' ? Date.parse(ctx.checkpoint.windowUntil) : NaN;
    return {
      backfillSince: sameWindow && checkpointLower ? checkpointLower : requestedLower,
      cutoff: new Date(sameWindow && checkpointLower ? checkpointLower : requestedLower),
      windowUntil: Number.isFinite(checkpointUpper) ? new Date(checkpointUpper) : new Date(Date.now()),
    };
  }

  private isoDateString(value?: string): string | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
  }

  private toArray(value: unknown): unknown[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  private text(value: unknown): string | undefined {
    if (typeof value === 'string') return stringValue(unwrapCdata(value));
    if (value && typeof value === 'object') return stringValue(unwrapCdata((value as Record<string, unknown>)['#text']));
    return undefined;
  }

  private date(value?: string): Date | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
  }
}

async function fetchPinnedRss(urlText: string, ctx: FetchContext): Promise<RssResponse> {
  const url = parseHttpUrl(urlText);
  const dispatcher = await createPinnedDispatcher(url);
  try {
    const response = await undiciFetch(url, {
      dispatcher,
      redirect: 'manual',
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.1',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'INTLY RSS collector/1.0',
      },
    } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    const body = await readBoundedBody(response, urlText);
    return bufferedResponse(response, body);
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

async function readBoundedBody(response: Response, id: string): Promise<ArrayBuffer> {
  const body = response.body;
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_FEED_BYTES) {
        await reader.cancel(`${id} RSS feed is larger than the v1 safety limit`).catch(() => undefined);
        throw new Error(`${id} RSS feed is larger than the v1 safety limit`);
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
  return output.buffer;
}

function bufferedResponse(response: Response, body: ArrayBuffer): RssResponse {
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    async arrayBuffer() {
      return body.slice(0);
    },
  };
}

function decodeFeed(buffer: ArrayBuffer, id: string): string {
  if (buffer.byteLength > MAX_FEED_BYTES) throw new Error(`${id} RSS feed is larger than the v1 safety limit`);
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer).replace(/^\uFEFF/, '');
}

function assertXmlFeed(id: string, contentType: string, xml: string): void {
  if (HTML_CONTENT_TYPE_RE.test(contentType)) throw new Error(`${id} RSS returned HTML instead of XML`);
  if (contentType && !XML_CONTENT_TYPE_RE.test(contentType) && !TEXT_CONTENT_TYPE_RE.test(contentType) && !/^\s*application\/octet-stream\b/i.test(contentType)) {
    throw new Error(`${id} RSS returned unsupported content type ${contentType}`);
  }
  const root = XML_ROOT_RE.exec(xml)?.[1]?.toLowerCase();
  if (!root || !['rss', 'feed', 'rdf:rdf'].includes(root)) throw new Error(`${id} RSS did not return an RSS/Atom XML document`);
}

function retryAfterSeconds(value: string | null): number {
  if (!value) return 60;
  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return Math.max(1, Math.ceil((timestamp - Date.now()) / 1000));
  return 60;
}


async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const rejection = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejection) throw rejection.reason;
  return results;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('RSS detail enrichment aborted');
}

function unwrapCdata(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/i, '$1');
}

function splitWeWorkRemotelyTitle(title: string): { title: string; companyOrClient?: string } {
  const separator = title.indexOf(':');
  if (separator <= 0 || separator === title.length - 1) return { title, companyOrClient: undefined };
  const companyOrClient = stringValue(title.slice(0, separator));
  const roleTitle = stringValue(title.slice(separator + 1));
  return companyOrClient && roleTitle ? { title: roleTitle, companyOrClient } : { title, companyOrClient: undefined };
}

function splitWeWorkRemotelySkills(value?: string): string[] {
  if (!value) return [];
  return Array.from(new Set(value
    .split(',')
    .map((item) => item.trim().replace(/^and\s+/i, '').trim())
    .filter(Boolean)));
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized === 'nbsp') return '\u00A0';
    const codePoint = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return match;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}
