import { createHash } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { Injectable } from '@nestjs/common';

import { OpportunityType } from '../../opportunities/schemas/opportunity.schema';
import { RawOpportunityRecord } from '../connectors/connector.types';
import { stringValue } from '../connectors/connector-utils';
import { createPinnedDispatcher, resolvePublicAddresses } from './pinned-fetch';
import { assertAllowedHost, assertPublicHttpUrl, parseHttpUrl } from './url-safety';

type ExtractedDocument = {
  finalUrl: string;
  html: string;
  markdown?: string;
  title?: string;
  metadata: Record<string, unknown>;
};

type ExtractUrlOptions = {
  allowedHosts?: string[];
  timeoutMs?: number;
  maxBytes?: number;
  ajaxHtmlField?: 'tender';
  signal?: AbortSignal;
};

export class WebExtractionHttpError extends Error {
  readonly accessReason?: 'access_denied' | 'bot_challenge' | 'rate_limited';
  readonly retryAfter?: string;

  constructor(
    readonly status: number,
    readonly url: string,
    input: {
      accessReason?: 'access_denied' | 'bot_challenge' | 'rate_limited';
      retryAfter?: string;
      cause?: unknown;
    } = {},
  ) {
    super(WebExtractionHttpError.message(status, url, input.accessReason, input.retryAfter));
    this.name = 'WebExtractionHttpError';
    this.accessReason = input.accessReason;
    this.retryAfter = input.retryAfter;
    if (input.cause) (this as Error & { cause?: unknown }).cause = input.cause;
  }

  private static message(status: number, url: string, accessReason?: 'access_denied' | 'bot_challenge' | 'rate_limited', retryAfter?: string): string {
    if (accessReason === 'bot_challenge') {
      return `URL returned HTTP ${status}: public-site bot challenge blocked the extraction client for ${url}. Verify source access or use an approved public/credentialed integration; parser success was not established.`;
    }
    if (accessReason === 'rate_limited') {
      return `URL returned HTTP ${status}: public-site rate limit for ${url}${retryAfter ? `; retry-after=${retryAfter}` : ''}.`;
    }
    if (accessReason === 'access_denied') {
      return `URL returned HTTP ${status}: public-site access denied for ${url}.`;
    }
    return `URL returned HTTP ${status}`;
  }
}

@Injectable()
export class WebExtractionService {
  async extractUrl(inputUrl: string, options: ExtractUrlOptions = {}): Promise<ExtractedDocument> {
    const url = parseHttpUrl(inputUrl);
    await resolvePublicAddresses(url);
    if (options.allowedHosts?.length) assertAllowedHost(url, options.allowedHosts);
    if (options.ajaxHtmlField) return this.fetchAjaxHtml(url, options);
    const firecrawl = await this.tryFirecrawl(url, options);
    if (firecrawl) return firecrawl;
    return this.fetchHtml(url, options);
  }

  async extractOpportunityFromUrl(inputUrl: string, input: { sourceId: string; sourceName: string; type?: OpportunityType; allowedHosts?: string[]; requireOpportunitySignal?: boolean; signal?: AbortSignal }): Promise<RawOpportunityRecord> {
    const document = await this.extractUrl(inputUrl, { allowedHosts: input.allowedHosts, timeoutMs: 20_000, maxBytes: 2_000_000, signal: input.signal });
    return this.documentToRecord(document, {
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      type: input.type ?? 'vacancy',
      requireOpportunitySignal: input.requireOpportunitySignal,
    });
  }

  extractOpportunityLinks(document: ExtractedDocument, allowedHosts: string[], limit = Number.POSITIVE_INFINITY): string[] {
    const links = new Set<string>();
    const pattern = /<a\b([^>]*)>/gi;
    for (const match of document.html.matchAll(pattern)) {
      const attrs = match[1] ?? '';
      const href = /\bhref=["']([^"']+)["']/i.exec(attrs)?.[1];
      if (!href || this.looksLikePaginationAnchor(attrs)) continue;
      try {
        const url = new URL(href, document.finalUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        assertAllowedHost(url, allowedHosts);
        if (this.looksLikeOpportunityUrl(url)) links.add(url.toString());
      } catch {
        continue;
      }
      if (links.size >= limit) break;
    }
    return [...links];
  }

  documentToRecord(document: ExtractedDocument, input: { sourceId: string; sourceName: string; type: OpportunityType; requireOpportunitySignal?: boolean }): RawOpportunityRecord {
    const jsonLd = this.extractJsonLd(document.html);
    const structured = this.jobPostingMetadata(jsonLd);
    if (input.requireOpportunitySignal && !this.hasOpportunityDetailSignal(document, jsonLd)) {
      throw new Error(`No concrete opportunity detail found at ${document.finalUrl}`);
    }
    const title = stringValue(jsonLd.title ?? jsonLd.name) ?? this.meta(document.html, 'og:title') ?? this.h1(document.html) ?? document.title ?? 'Untitled';
    const rawDescription = stringValue(jsonLd.description) ?? this.meta(document.html, 'description') ?? document.markdown ?? document.html;
    const description = this.readableDescription(rawDescription) ?? this.mainText(document.markdown ?? document.html);
    const organization = this.organization(jsonLd) ?? this.meta(document.html, 'og:site_name') ?? input.sourceName;
    const publishedAt = this.date(stringValue(jsonLd.datePosted ?? jsonLd.datePublished));
    return {
      externalId: createHash('sha256').update(document.finalUrl).digest('hex'),
      url: document.finalUrl,
      type: input.type,
      title,
      companyOrClient: organization,
      description,
      publishedAt,
      sourceStatus: 'Unknown',
      rawPayload: {
        url: document.finalUrl,
        title,
        description,
        rawDescription,
        jsonLd,
        metadata: document.metadata,
      },
      sourceMetadata: {
        extraction: document.metadata.firecrawl ? 'firecrawl' : 'http-html',
        contentHash: createHash('sha256').update(document.html).digest('hex'),
        ...structured,
      },
    };
  }

  private async tryFirecrawl(url: URL, options: ExtractUrlOptions): Promise<ExtractedDocument | null> {
    const endpoint = process.env.FIRECRAWL_API_URL;
    if (!endpoint) return null;
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.FIRECRAWL_API_KEY ? { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` } : {}),
      },
      body: JSON.stringify({ url: url.toString(), formats: ['html', 'markdown'], onlyMainContent: true, waitFor: 0 }),
      signal: this.requestSignal(options),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    const data = this.record(payload.data) ?? payload;
    const metadata = this.record(data.metadata) ?? {};
    const html = stringValue(data.html) ?? '';
    if (!html || html.length > (options.maxBytes ?? 2_000_000)) return null;
    const finalUrl = stringValue(metadata.sourceURL ?? metadata.url) ?? url.toString();
    const final = parseHttpUrl(finalUrl);
    this.assertAllowedFinalUrl(final, options);
    await resolvePublicAddresses(final);
    return {
      finalUrl: final.toString(),
      html,
      markdown: stringValue(data.markdown),
      title: stringValue(metadata.title),
      metadata: { firecrawl: true, ...metadata },
    };
  }

  private async fetchHtml(url: URL, options: ExtractUrlOptions, redirects = 0): Promise<ExtractedDocument> {
    if (redirects > 3) throw new Error('Too many redirects while fetching URL');
    const dispatcher = await createPinnedDispatcher(url);
    try {
      const response = await undiciFetch(url, {
        dispatcher,
        redirect: 'manual',
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': process.env.INTLY_CRAWLER_USER_AGENT ?? 'INTLY/1.0' },
        signal: this.requestSignal(options),
      } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirect without location is not allowed');
        const redirected = new URL(location, url);
        await assertPublicHttpUrl(redirected);
        this.assertAllowedFinalUrl(redirected, options);
        return this.fetchHtml(redirected, options, redirects + 1);
      }
      if (!response.ok) throw await this.httpError(response, url.toString(), options);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
      }
      const html = await this.readLimited(response, options.maxBytes ?? 2_000_000);
      return { finalUrl: url.toString(), html, title: this.title(html), metadata: { firecrawl: false, contentType } };
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }

  private async fetchAjaxHtml(url: URL, options: ExtractUrlOptions, redirects = 0): Promise<ExtractedDocument> {
    if (redirects > 3) throw new Error('Too many redirects while fetching AJAX URL');
    if (options.ajaxHtmlField !== 'tender') throw new Error('Unsupported AJAX HTML field');
    const dispatcher = await createPinnedDispatcher(url);
    try {
      const response = await undiciFetch(url, {
        dispatcher,
        redirect: 'manual',
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'User-Agent': process.env.INTLY_CRAWLER_USER_AGENT ?? 'INTLY/1.0',
          'X-Requested-With': 'XMLHttpRequest',
        },
        signal: this.requestSignal(options),
      } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirect without location is not allowed');
        const redirected = new URL(location, url);
        await assertPublicHttpUrl(redirected);
        this.assertAllowedFinalUrl(redirected, options);
        return this.fetchAjaxHtml(redirected, options, redirects + 1);
      }
      if (!response.ok) throw new Error(`AJAX URL returned HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) throw new Error(`Unsupported AJAX content type: ${contentType || 'unknown'}`);
      const text = await this.readLimited(response, options.maxBytes ?? 2_000_000);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error('AJAX response is not valid JSON');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('AJAX response shape is not an object');
      const html = stringValue((payload as Record<string, unknown>)[options.ajaxHtmlField]);
      if (!html || !/<[a-z][\s\S]*>/i.test(html)) throw new Error(`AJAX response missing HTML field: ${options.ajaxHtmlField}`);
      if (Buffer.byteLength(html, 'utf8') > (options.maxBytes ?? 2_000_000)) throw new Error('AJAX HTML field exceeds v1 size limit');
      return { finalUrl: url.toString(), html, title: this.title(html), metadata: { firecrawl: false, ajax: true, ajaxHtmlField: options.ajaxHtmlField, contentType } };
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }

  private async readLimited(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) return response.text();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error('Response exceeds v1 size limit');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return new TextDecoder().decode(Buffer.concat(chunks, bytes));
  }

  private async httpError(response: Response, url: string, options: ExtractUrlOptions): Promise<WebExtractionHttpError> {
    let body = '';
    let cause: unknown;
    try {
      body = await this.readLimited(response, Math.min(options.maxBytes ?? 2_000_000, 65_536));
    } catch (error) {
      if (isAbortError(error)) throw error;
      cause = error;
    }
    return new WebExtractionHttpError(response.status, url, {
      accessReason: this.httpAccessReason(response.status, body),
      retryAfter: response.headers.get('retry-after') ?? undefined,
      cause,
    });
  }

  private httpAccessReason(status: number, body: string): 'access_denied' | 'bot_challenge' | 'rate_limited' | undefined {
    if (status === 429) return 'rate_limited';
    if (status === 403 && this.isBotChallengeBody(body)) return 'bot_challenge';
    if (status === 403) return 'access_denied';
    return undefined;
  }

  private isBotChallengeBody(body: string): boolean {
    if (!body) return false;
    const sample = body.slice(0, 65_536).toLowerCase();
    return /<title>\s*just a moment/i.test(sample)
      || sample.includes('cf-browser-verification')
      || sample.includes('cf-challenge')
      || sample.includes('cdn-cgi/challenge-platform')
      || sample.includes('checking your browser before accessing')
      || sample.includes('enable javascript and cookies to continue');
  }

  private requestSignal(options: ExtractUrlOptions): AbortSignal {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  }

  private assertAllowedFinalUrl(url: URL, options: ExtractUrlOptions): void {
    if (options.allowedHosts?.length) assertAllowedHost(url, options.allowedHosts);
  }

  private extractJsonLd(html: string): Record<string, unknown> {
    const matches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    const candidates: Array<Record<string, unknown>> = [];
    for (const match of matches) {
      try {
        const parsed = JSON.parse(match[1].trim()) as unknown;
        candidates.push(...this.jsonLdCandidates(parsed));
      } catch {
        continue;
      }
    }
    const job = candidates.find((item) => this.hasSchemaType(item, 'JobPosting'));
    if (job) return job;
    return candidates.find((item) => typeof item === 'object') ?? {};
  }

  private jsonLdCandidates(value: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(value)) return value.flatMap((item) => this.jsonLdCandidates(item));
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const graph = record['@graph'];
    const nested = Array.isArray(graph) ? graph.flatMap((item) => this.jsonLdCandidates(item)) : [];
    return [record, ...nested];
  }

  private hasSchemaType(value: unknown, type: string): boolean {
    if (!value || typeof value !== 'object') return false;
    const schemaType = (value as Record<string, unknown>)['@type'];
    return Array.isArray(schemaType) ? schemaType.includes(type) : schemaType === type;
  }

  private jobPostingMetadata(jsonLd: Record<string, unknown>): Record<string, unknown> {
    if (!this.hasSchemaType(jsonLd, 'JobPosting')) return {};
    return this.omitUndefined({
      salary: this.jobPostingSalary(jsonLd.baseSalary),
      area: this.jobPostingLocation(jsonLd.jobLocation, jsonLd.applicantLocationRequirements),
      locations: this.jobPostingLocations(jsonLd.jobLocation, jsonLd.applicantLocationRequirements),
      employment: this.joinStrings(jsonLd.employmentType),
      schedule: this.jobPostingRemoteType(jsonLd.jobLocationType),
      skills: this.jobPostingSkills(jsonLd.skills ?? jsonLd.skillRequirements),
      deadlineAt: this.strictTimestamp(stringValue(jsonLd.validThrough)),
    });
  }

  private jobPostingSalary(value: unknown): Record<string, unknown> | undefined {
    const record = this.record(value);
    if (!record) return undefined;
    const currency = stringValue(record.currency);
    const valueRecord = this.record(record.value);
    const numeric = this.numberValue(record.value) ?? this.numberValue(valueRecord?.value);
    const min = this.numberValue(valueRecord?.minValue) ?? numeric;
    const max = this.numberValue(valueRecord?.maxValue) ?? numeric;
    const unitText = stringValue(valueRecord?.unitText) ?? stringValue(record.unitText);
    const salary = this.omitUndefined({ min, max, currency, period: unitText, originalText: this.salaryOriginalText(min, max, currency, unitText) });
    return Object.keys(salary).length > 0 ? salary : undefined;
  }

  private salaryOriginalText(min?: number, max?: number, currency?: string, unitText?: string): string | undefined {
    const numbers = [min, max].filter((item, index, array): item is number => typeof item === 'number' && array.indexOf(item) === index);
    if (numbers.length === 0 && !currency && !unitText) return undefined;
    const amount = numbers.length === 2 ? `${numbers[0]} – ${numbers[1]}` : numbers[0]?.toString();
    return [amount, currency, unitText].filter(Boolean).join(' ') || undefined;
  }

  private jobPostingLocation(jobLocation: unknown, applicantLocationRequirements: unknown): string | undefined {
    const locations = this.jobPostingLocations(jobLocation, applicantLocationRequirements);
    return locations.length > 0 ? locations.join(', ') : undefined;
  }

  private jobPostingLocations(jobLocation: unknown, applicantLocationRequirements: unknown): string[] {
    return Array.from(new Set([...this.locationNames(jobLocation), ...this.locationNames(applicantLocationRequirements)]));
  }

  private locationNames(value: unknown): string[] {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return values.flatMap((item) => {
      const record = this.record(item);
      if (!record) return [];
      const address = this.record(record.address);
      const direct = stringValue(record.name) ?? stringValue(record.address);
      const parts = [
        stringValue(address?.addressLocality),
        stringValue(address?.addressRegion),
        stringValue(address?.addressCountry) ?? stringValue(this.record(address?.addressCountry)?.name),
      ].filter((part): part is string => typeof part === 'string' && part.length > 0 && !this.isPlaceholderLocationPart(part));
      const label = parts.length > 0 ? parts.join(', ') : this.cleanLocationPart(direct);
      return label ? [label] : [];
    });
  }

  private cleanLocationPart(value?: string): string | undefined {
    const cleaned = this.clean(value);
    return cleaned && !this.isPlaceholderLocationPart(cleaned) ? cleaned : undefined;
  }

  private isPlaceholderLocationPart(value: string): boolean {
    return /^(?:[-–—]+|n\/?a|none|null|undefined|unknown|не\s*указано|не\s*важно|любой|любая)$/i.test(value.trim());
  }

  private jobPostingRemoteType(value: unknown): string | undefined {
    const text = this.joinStrings(value);
    return text && /TELECOMMUTE/i.test(text) ? 'TELECOMMUTE' : text;
  }

  private jobPostingSkills(value: unknown): string[] | undefined {
    const skills = this.stringList(value);
    return skills.length > 0 ? Array.from(new Set(skills)) : undefined;
  }

  private joinStrings(value: unknown): string | undefined {
    const values = this.stringList(value);
    return values.length > 0 ? values.join(', ') : undefined;
  }

  private stringList(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => this.stringList(item));
    const record = this.record(value);
    const text = stringValue(record?.name) ?? stringValue(value);
    if (!text) return [];
    return text.split(/[,;]+/).map((item) => item.trim()).filter(Boolean);
  }

  private strictTimestamp(value?: string): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) return undefined;
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }

  private numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  }

  private omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
  }

  private title(html: string): string | undefined {
    return this.matchText(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  }

  private h1(html: string): string | undefined {
    return this.matchText(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  }

  private meta(html: string, name: string): string | undefined {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.unescape(
      new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i').exec(html)?.[1],
    );
  }

  private matchText(html: string, pattern: RegExp): string | undefined {
    return this.clean(pattern.exec(html)?.[1]);
  }

  private mainText(value: string): string {
    return this.readableDescription(value.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '))?.slice(0, 8000) ?? '';
  }

  private organization(jsonLd: Record<string, unknown>): string | undefined {
    const hiringOrganization = jsonLd.hiringOrganization;
    if (typeof hiringOrganization === 'string') return hiringOrganization;
    if (hiringOrganization && typeof hiringOrganization === 'object') {
      return stringValue((hiringOrganization as Record<string, unknown>).name);
    }
    return undefined;
  }

  private date(value?: string): Date | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
  }

  private looksLikeOpportunityUrl(url: URL): boolean {
    if (/\.(?:avif|css|gif|ico|jpe?g|js|map|png|svg|ttf|webp|woff2?)$/i.test(url.pathname)) return false;
    if (this.looksLikeNonOpportunityUrl(url)) return false;
    if (this.looksLikeListingPageUrl(url)) return false;
    return /(vacanc|job|career|project|tender|order|zakup|rabot|freelance|work)/i.test(url.pathname);
  }

  private looksLikeNonOpportunityUrl(url: URL): boolean {
    return /(?:^|\/)(?:about|account|auth|blog|catalog|category|categories|company|companies|contacts?|help|login|marketing|news|password|pricing|register|registration|signin|signup|tag|tags|users?)(?:\/|$)/i.test(url.pathname);
  }

  private looksLikeListingPageUrl(url: URL): boolean {
    if (url.searchParams.has('page') || url.searchParams.has('p')) return true;
    return /(?:^|\/)(?:vacancies|jobs|projects|tenders|orders|tasks|works|freelance)\/?$/i.test(url.pathname) || /(?:^|\/)(?:(?:page|pages|p)\/\d+|page-\d+|vacancies\/\d+)\/?$/i.test(url.pathname);
  }

  private looksLikePaginationAnchor(attrs: string): boolean {
    const rel = /\brel=["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
    const className = /\bclass=["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
    const ariaLabel = /\baria-label=["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
    return /\bnext\b/i.test(rel) || /\b(next|pagination|pager)\b/i.test(className) || /\b(next|след|дальше|впер[её]д)\b/i.test(ariaLabel);
  }

  private hasOpportunityDetailSignal(document: ExtractedDocument, jsonLd: Record<string, unknown>): boolean {
    if (this.hasSchemaType(jsonLd, 'JobPosting')) {
      return Boolean(stringValue(jsonLd.title ?? jsonLd.name) && stringValue(jsonLd.description));
    }
    const url = new URL(document.finalUrl);
    if (!this.looksLikeConcreteOpportunityRoute(url)) return false;
    const title = stringValue(jsonLd.title ?? jsonLd.name) ?? this.meta(document.html, 'og:title') ?? this.h1(document.html) ?? document.title;
    if (!title || /^(jobs?|careers?|projects?|tenders?|orders?|freelance|work|catalog|login|sign in)$/i.test(title.trim())) return false;
    const text = this.mainText(document.markdown ?? document.html).slice(0, 4000);
    const bodySignals = [
      /(?:apply|отклик|откликнуться|ставк|заявк|budget|бюджет|salary|зарплат|deadline|дедлайн|тз|обязанности|requirements|требован)/i,
      /(?:company|client|работодатель|заказчик|компания|skills?|навык|remote|удален|офис)/i,
    ];
    return bodySignals.every((pattern) => pattern.test(`${title} ${text}`));
  }

  private looksLikeConcreteOpportunityRoute(url: URL): boolean {
    const path = url.pathname.replace(/\/+$/, '');
    if (this.looksLikeListingPageUrl(url) || this.looksLikeNonOpportunityUrl(url)) return false;
    return /(?:^|\/)(?:vacanc(?:y|ies)|jobs?|career|project|tender|order|zakup|rabot|freelance|work|task)(?:\/|[-_])/i.test(path) && /(?:[a-f0-9]{12,}|\d{2,}|[a-zа-яё0-9]+-[a-zа-яё0-9-]{3,})/i.test(path);
  }

  private readableDescription(value?: string): string | undefined {
    if (!value) return undefined;
    const withoutBoilerplate = value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(?:nav|header|footer|aside)\b[\s\S]*?<\/(?:nav|header|footer|aside)>/gi, ' ');
    const withBreaks = withoutBoilerplate
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\s*\/(?:p|div|section|article|h[1-6]|ul|ol)\s*>/gi, '\n\n')
      .replace(/<\s*li\b[^>]*>/gi, '\n- ')
      .replace(/<\s*\/li\s*>/gi, '\n');
    return this.clean(withBreaks.replace(/<\/?[a-z][a-z0-9-]*\b[^<>]*>/gi, ' ').replace(/<\/[a-z][a-z0-9-]*\s*$/gi, ' '));
  }

  private clean(value?: string): string | undefined {
    return this.unescape(value?.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n+ */g, '\n').replace(/\n{3,}/g, '\n\n').trim());
  }

  private unescape(value?: string): string | undefined {
    return value
      ?.replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
      .trim();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}
