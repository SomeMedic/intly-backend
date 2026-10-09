import { load } from 'cheerio';

import { AtsBoardDiscovery, AtsDiscoveryCandidate } from './ats-board-discovery';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { loadRuntimePackage, numberValue, safePublicHostOrSlug, stringValue } from './connector-utils';
import { WebExtractionService } from '../extraction/web-extraction.service';

type AtsId = 'greenhouse' | 'lever' | 'ashby' | 'personio';
type TenantFetchResult = {
  records: RawOpportunityRecord[];
  hasMore?: boolean;
  checkpointPatch?: Record<string, unknown>;
};

type DiscoveryProbe = {
  ok: boolean;
  status?: number;
  records?: number;
  error?: string;
};

export class AtsPublicBoardConnector implements Connector {
  readonly family = 'AtsPublicBoard' as const;
  private readonly discovery: AtsBoardDiscovery;

  constructor(readonly id: AtsId, private readonly webExtraction = new WebExtractionService()) {
    this.discovery = new AtsBoardDiscovery(id);
  }

  capabilities(): ConnectorCapabilities {
    return {
      supportsBackfill: true,
      supportsIncremental: true,
      supportsRefresh: false,
      requiresCredentials: false,
      maxBackfillDays: 30,
    };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    const tenants = this.readTenants(config);
    if (tenants.length === 0) {
      return { ok: false, message: `${this.id} requires discovered/configured tenant slugs or feed hosts` };
    }
    if (tenants.some((tenant) => !safePublicHostOrSlug(tenant))) {
      return { ok: false, message: `${this.id} tenant values must be public slugs/hosts, not URLs or private hosts` };
    }
    if (this.id === 'personio' && tenants.some((tenant) => !this.personioHost(tenant))) {
      return { ok: false, message: 'Personio tenants must be public company.jobs.personio.de or company.jobs.personio.com feed hosts' };
    }
    return { ok: true, message: `${this.id} tenants configured`, details: { tenants: tenants.length } };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    if (this.id === 'personio') {
      const validation = await this.validateConfig(ctx.source.config ?? {});
      if (!validation.ok) return { state: 'Failed', message: validation.message, checkedAt: new Date() };
      const probes = await Promise.all(this.readTenants(ctx.source.config ?? {}).map(async (tenant) => ({
        tenant, ...await this.probeTenant(tenant, ctx.source.timeoutMs ?? 30_000, ctx.signal),
      })));
      const failed = probes.filter(probe => !probe.ok);
      return {
        state: failed.length === 0 ? 'Healthy' : failed.length === probes.length ? 'Failed' : 'Degraded',
        message: failed.length === 0 ? `Personio validated ${probes.length} public XML feed(s)` : `Personio could not validate ${failed.length} of ${probes.length} configured feed(s)`,
        checkedAt: new Date(), details: { probes },
      };
    }
    return {
      state: 'Unknown',
      message: 'ATS family connector is implemented for discovered/configured tenants; discovery validates candidates with public board endpoints.',
      checkedAt: new Date(),
    };
  }

  async discover(ctx: ConnectorContext): Promise<ValidationResult> {
    const seeds = this.discovery.seedsFromConfig(ctx.source.config ?? {});
    if (seeds.length === 0) {
      return { ok: false, message: `${this.id} discovery requires public discoveryHosts or discoveryUrls` };
    }

    const candidates = new Map<string, AtsDiscoveryCandidate>();
    const rejected: Array<{ tenant: string; evidenceUrl: string; reason: string }> = [];
    const checkedUrls: string[] = [];
    const timeoutMs = ctx.source.timeoutMs ?? 30_000;

    for (const seed of seeds) {
      checkedUrls.push(seed.url);
      for (const candidate of this.discovery.candidatesFromUrl(seed.url)) candidates.set(candidate.tenant, candidate);
      const html = await this.fetchDiscoveryHtml(seed.url, timeoutMs, ctx.signal).catch(() => '');
      if (!html) continue;
      for (const candidate of this.discovery.candidatesFromHtml(html, seed.url)) candidates.set(candidate.tenant, candidate);
    }

    const discovered: string[] = [];
    const details: Array<AtsDiscoveryCandidate & { probe: DiscoveryProbe }> = [];
    for (const candidate of candidates.values()) {
      const probe = await this.probeTenant(candidate.tenant, timeoutMs, ctx.signal);
      if (probe.ok) {
        discovered.push(candidate.tenant);
        details.push({ ...candidate, probe });
      } else {
        rejected.push({ tenant: candidate.tenant, evidenceUrl: candidate.evidenceUrl, reason: probe.error ?? `HTTP ${probe.status ?? 'unknown'}` });
      }
    }

    return {
      ok: discovered.length > 0,
      message: discovered.length > 0 ? `${this.id} discovered and validated ${discovered.length} public boards` : `${this.id} found no validated public board tenants`,
      details: {
        tenants: discovered,
        candidatesChecked: candidates.size,
        checkedUrls,
        discovered: details,
        rejected,
      },
    };
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const tenants = this.readTenants(ctx.source.config ?? {});
    if (tenants.length === 0) {
      throw new Error(`${this.id} requires discovered/configured tenant slugs or feed hosts`);
    }
    if (this.id === 'personio') {
      const validation = await this.validateConfig(ctx.source.config ?? {});
      if (!validation.ok) throw new Error(validation.message);
    }
    const windowTo = ctx.checkpoint.hasMore === true && typeof ctx.checkpoint.windowTo === 'string'
      ? ctx.checkpoint.windowTo : new Date().toISOString();
    if (!Number.isFinite(Date.parse(windowTo))) throw new Error('Invalid ATS publication window checkpoint');
    if (ctx.checkpoint.hasMore === true && Array.isArray(ctx.checkpoint.tenantCatalog)
      && JSON.stringify(ctx.checkpoint.tenantCatalog) !== JSON.stringify(tenants)) {
      throw new Error('ATS tenant catalog changed during collection; restore its configured hosts to resume the original run');
    }
    const maxTenants = this.maxTenantsPerRun(ctx.source.limits ?? {}, ctx.source.config ?? {});
    const startIndex = this.tenantCursor(ctx.checkpoint, tenants.length);
    const processedCount = this.tenantCycleProcessed(ctx.checkpoint, tenants.length);
    const selectedTenants = this.rotateTenants(tenants, startIndex, Math.min(maxTenants, tenants.length - processedCount));
    const records: RawOpportunityRecord[] = [];
    const errors: Array<{ tenant: string; error: string }> = [];

    let fullyProcessedTenants = 0;
    let partialTenant: TenantFetchResult | undefined;
    for (const tenant of selectedTenants) {
      try {
        const result = await this.fetchTenant(tenant, ctx);
        records.push(...result.records);
        if (result.hasMore) {
          partialTenant = result;
          break;
        }
        fullyProcessedTenants += 1;
      } catch (error) {
        errors.push({ tenant, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (errors.length > 0) {
      throw new Error(`${this.id} tenant fetch failed for ${errors.length} tenant(s): ${errors[0]?.error ?? 'unknown error'}`);
    }
    const nextProcessedCount = processedCount + fullyProcessedTenants;
    const hasMore = Boolean(partialTenant?.hasMore) || nextProcessedCount < tenants.length;
    const nextTenantCursor = tenants.length > 0 ? (startIndex + fullyProcessedTenants) % tenants.length : 0;
    return {
      records: records.filter((record) => !record.publishedAt || record.publishedAt.getTime() <= Date.parse(windowTo)),
      checkpoint: {
        backfillSince: ctx.checkpoint.hasMore === true && typeof ctx.checkpoint.backfillSince === 'string'
          ? ctx.checkpoint.backfillSince : ctx.backfillSince,
        windowTo,
        tenantCatalog: tenants,
        tenants: selectedTenants.slice(0, fullyProcessedTenants + (partialTenant ? 1 : 0)),
        tenantCursor: nextTenantCursor,
        tenantCycleProcessed: hasMore ? nextProcessedCount : undefined,
        ...(partialTenant?.checkpointPatch ?? {}),
        hasMore,
        fetchedAt: new Date().toISOString(),
        errors,
      },
      hasMore,
      nextPage: hasMore ? (ctx.page ?? 0) + 1 : undefined,
      stats: { seen: records.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private readTenants(config: Record<string, unknown>): string[] {
    const value = config.tenants;
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim().toLowerCase()))];
  }

  private maxTenantsPerRun(limits: Record<string, unknown>, config: Record<string, unknown>): number {
    const value = Number(limits.maxTenantsPerRun ?? config.maxTenantsPerRun ?? 10);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 25) : 10;
  }


  private tenantCursor(checkpoint: Record<string, unknown>, total: number): number {
    if (total <= 0) return 0;
    const value = Number(checkpoint.tenantCursor ?? 0);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) % total : 0;
  }

  private tenantCycleProcessed(checkpoint: Record<string, unknown>, total: number): number {
    if (checkpoint.hasMore !== true) return 0;
    const value = Number(checkpoint.tenantCycleProcessed ?? 0);
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.min(Math.floor(value), total);
  }

  private rotateTenants(tenants: string[], startIndex: number, maxTenants: number): string[] {
    const count = Math.min(maxTenants, tenants.length);
    return Array.from({ length: count }, (_unused, index) => tenants[(startIndex + index) % tenants.length]);
  }

  private async fetchDiscoveryHtml(url: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const response = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return '';
    const text = await response.text();
    return text.slice(0, 1_000_000);
  }

  private async probeTenant(tenant: string, timeoutMs: number, signal?: AbortSignal): Promise<DiscoveryProbe> {
    if (!safePublicHostOrSlug(tenant)) return { ok: false, error: 'unsafe tenant' };
    try {
      if (this.id === 'greenhouse') return this.probeJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(tenant)}/jobs`, timeoutMs, signal, (payload) => Array.isArray(this.recordPayload(payload, 'jobs')));
      if (this.id === 'lever') return this.probeJson(`https://api.lever.co/v0/postings/${encodeURIComponent(tenant)}?mode=json`, timeoutMs, signal, (payload) => Array.isArray(payload));
      if (this.id === 'ashby') return this.probeJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(tenant)}`, timeoutMs, signal, (payload) => Array.isArray(this.recordPayload(payload, 'jobs')));
      const records = await this.readPersonioPositions(tenant, timeoutMs, signal);
      return { ok: true, status: 200, records: records.length };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async probeJson(url: string, timeoutMs: number, signal: AbortSignal | undefined, acceptsPayload: (payload: unknown) => boolean): Promise<DiscoveryProbe> {
    const response = await fetch(url, { headers: this.jsonHeaders(), signal: signal ?? AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, status: response.status };
    const payload = await response.json();
    if (!acceptsPayload(payload)) return { ok: false, status: response.status, error: 'unexpected payload shape' };
    return { ok: true, status: response.status, records: this.countRecords(payload) };
  }

  private recordPayload(payload: unknown, key: string): unknown {
    return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)[key] : undefined;
  }

  private countRecords(payload: unknown): number {
    if (Array.isArray(payload)) return payload.length;
    const jobs = this.recordPayload(payload, 'jobs');
    return Array.isArray(jobs) ? jobs.length : 0;
  }

  private async fetchTenant(tenant: string, ctx: FetchContext): Promise<TenantFetchResult> {
    if (this.id === 'greenhouse') return this.fetchGreenhouse(tenant, ctx);
    if (this.id === 'lever') return { records: await this.fetchLever(tenant, ctx) };
    if (this.id === 'ashby') return { records: await this.fetchAshby(tenant, ctx) };
    return { records: await this.fetchPersonio(tenant, ctx) };
  }

  private async fetchGreenhouse(board: string, ctx: FetchContext): Promise<TenantFetchResult> {
    const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`, {
      headers: this.jsonHeaders(),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    if (!response.ok) throw new Error(`Greenhouse ${board} returned ${response.status}`);
    const payload = (await response.json()) as { jobs?: Array<Record<string, unknown>> };
    if (!Array.isArray(payload.jobs)) throw new Error(`Greenhouse ${board} returned an unexpected jobs payload`);
    const offset = this.greenhouseOffset(ctx.checkpoint, board);
    const limit = this.greenhouseDetailLimit(ctx.source.limits ?? {}, ctx.source.config ?? {});
    const slice = payload.jobs.slice(offset, offset + limit);
    const windowFrom = this.windowFrom(ctx);
    const windowTo = typeof ctx.checkpoint.windowTo === 'string' ? Date.parse(ctx.checkpoint.windowTo) : Date.now();
    const records: RawOpportunityRecord[] = [];
    for (const job of slice) {
      const id = this.requiredString(job.id, `Greenhouse ${board} job is missing its stable id`);
      const title = this.requiredString(job.title, `Greenhouse ${board}:${id} job is missing its title`);
      const listPublishedAt = this.dateValue(job.first_published);
      const detail = listPublishedAt && (listPublishedAt.getTime() < windowFrom || listPublishedAt.getTime() > windowTo)
        ? undefined : await this.fetchGreenhouseDetail(board, id, ctx);
      records.push(this.mapGreenhouse({ ...job, ...(detail ?? {}) }, board, id, title));
    }
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < payload.jobs.length;
    return {
      records,
      hasMore,
      checkpointPatch: hasMore
        ? { greenhouseTenant: board, greenhouseOffset: nextOffset, greenhouseTotal: payload.jobs.length, greenhouseDetailLimit: limit }
        : { greenhouseTenant: undefined, greenhouseOffset: undefined, greenhouseTotal: undefined, greenhouseDetailLimit: undefined },
    };
  }

  private async fetchLever(company: string, ctx: FetchContext): Promise<RawOpportunityRecord[]> {
    const response = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`, {
      headers: this.jsonHeaders(),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    if (!response.ok) throw new Error(`Lever ${company} returned ${response.status}`);
    const payload = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(payload)) throw new Error(`Lever ${company} returned an unexpected postings payload`);
    return payload.map((job) => this.mapLever(job, company));
  }

  private async fetchAshby(org: string, ctx: FetchContext): Promise<RawOpportunityRecord[]> {
    const response = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`, {
      headers: this.jsonHeaders(),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    if (!response.ok) throw new Error(`Ashby ${org} returned ${response.status}`);
    const payload = (await response.json()) as { jobs?: Array<Record<string, unknown>> };
    if (!Array.isArray(payload.jobs)) throw new Error(`Ashby ${org} returned an unexpected jobs payload`);
    return payload.jobs.map((job) => this.mapAshby(job, org));
  }

  private async fetchPersonio(host: string, _ctx: FetchContext): Promise<RawOpportunityRecord[]> {
    const positions = await this.readPersonioPositions(host, _ctx.source.timeoutMs ?? 30_000, _ctx.signal);
    return positions.map((raw) => this.mapPersonio(raw, host));
  }

  private personioHost(host: string): boolean {
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.jobs\.personio\.(?:de|com)$/.test(host);
  }

  private async readPersonioPositions(host: string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    if (!this.personioHost(host)) throw new Error(`Unsafe Personio feed host: ${host}`);
    let url = new URL(`https://${host}/xml`);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let xml: string | undefined;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(url, {
        redirect: 'manual', signal: requestSignal,
        headers: { Accept: 'application/xml,text/xml', 'Accept-Encoding': 'identity' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`Personio ${host} redirected without a location`);
        const next = new URL(location, url);
        if (next.protocol !== 'https:' || next.username || next.password || next.port
          || !this.personioHost(next.hostname) || next.hostname.split('.')[0] !== host.split('.')[0]
          || next.pathname !== '/xml') throw new Error(`Personio ${host} redirected outside its public XML feed`);
        url = next;
        continue;
      }
      if (!response.ok) throw new Error(`Personio ${host} returned ${response.status}`);
      xml = await response.text();
      break;
    }
    if (xml === undefined) throw new Error(`Personio ${host} exceeded the XML redirect limit`);
    if (Buffer.byteLength(xml, 'utf8') > 16_000_000) throw new Error(`Personio ${host} XML feed exceeds the supported response size`);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(`Personio ${host} XML declarations are unsupported`);
    const { XMLParser, XMLValidator } = await loadRuntimePackage<{
      XMLParser: new (options: Record<string, unknown>) => { parse(xml: string): Record<string, unknown> };
      XMLValidator: { validate(xml: string): true | unknown };
    }>('fast-xml-parser');
    if (XMLValidator.validate(xml) !== true) throw new Error(`Personio ${host} returned malformed XML`);
    const parser = new XMLParser({
      ignoreAttributes: false,
      processEntities: true,
      htmlEntities: false,
      parseTagValue: false,
      trimValues: true,
    });
    const parsed = parser.parse(xml);
    const root = parsed['workzag-jobs'] ?? parsed.workzag;
    if (root === undefined) throw new Error(`Personio ${host} returned an unexpected XML document`);
    const workzag = typeof root === 'object' && root !== null ? root as Record<string, unknown> : {};
    const positionsContainer = typeof workzag.positions === 'object' && workzag.positions !== null ? workzag.positions as Record<string, unknown> : {};
    const positions = this.toArray(workzag.position ?? positionsContainer.position);
    return positions.map((job) => {
      if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error(`Personio ${host} returned an invalid position`);
      return job as Record<string, unknown>;
    });
  }

  private mapPersonio(raw: Record<string, unknown>, host: string): RawOpportunityRecord {
    const id = stringValue(raw.id);
    const title = stringValue(raw.name ?? raw.title ?? raw.jobTitle);
    if (!id || !/^\d+$/.test(id) || !title) throw new Error(`Personio ${host} position is missing its stable id or title`);
    const url = new URL(stringValue(raw.jobUrl ?? raw.url) ?? `https://${host}/job/${id}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !this.personioHost(url.hostname) || url.hostname.split('.')[0] !== host.split('.')[0]
      || !new RegExp(`^/job/${id}/?$`).test(url.pathname)) throw new Error(`Personio ${host} position has an unexpected job URL`);
    const descriptions = raw.jobDescriptions && typeof raw.jobDescriptions === 'object'
      ? (raw.jobDescriptions as Record<string, unknown>).jobDescription : undefined;
    const html = this.toArray(descriptions).map((value) => {
      if (!value || typeof value !== 'object') return '';
      const section = value as Record<string, unknown>;
      const body = stringValue(section.value);
      if (!body) return '';
      return [stringValue(section.name), body].filter(Boolean).join('\n\n');
    }).filter(Boolean).join('\n\n');
    const company = stringValue(raw.subcompany ?? raw.company) ?? host;
    const jobPosting = { '@type': 'JobPosting', title, description: html, hiringOrganization: { name: company } };
    const cleaned = this.webExtraction.documentToRecord({
      finalUrl: url.toString(), html: `<script type="application/ld+json">${JSON.stringify(jobPosting).replace(/</g, '\\u003c')}</script>`, metadata: { personio: true },
    }, { sourceId: this.id, sourceName: company, type: 'vacancy' });
    const additional = raw.additionalOffices && typeof raw.additionalOffices === 'object'
      ? (raw.additionalOffices as Record<string, unknown>).office : undefined;
    const locations = [...new Set([raw.office, ...this.toArray(additional)].map(stringValue).filter((value): value is string => Boolean(value)))];
    const schedule = stringValue(raw.schedule);
    const employment = [schedule, stringValue(raw.employmentType)].filter(Boolean).join(', ');
    const keywords = stringValue(raw.keywords)?.split(/[,;]/).map((value) => value.trim()).filter(Boolean) ?? [];
    const nativeDate = stringValue(raw.createdAt);
    const publishedAt = nativeDate && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(nativeDate)
      && Number.isFinite(Date.parse(nativeDate)) ? new Date(nativeDate) : undefined;
    const workFormat = locations.find((value) => /^(?:remote|hybrid|on.?site)$/i.test(value));
    return {
      ...cleaned, externalId: `${host}:${id}`, publishedAt, sourceStatus: 'Active',
      rawPayload: raw,
      sourceMetadata: {
        tenant: host, ats: this.id, rawDescription: html, locations, employment,
        schedule: workFormat, seniority: stringValue(raw.seniority), skills: [...new Set(keywords)],
        department: raw.department, recruitingCategory: raw.recruitingCategory,
        occupation: raw.occupation, occupationCategory: raw.occupationCategory, yearsOfExperience: raw.yearsOfExperience,
        sourceDateField: publishedAt ? 'createdAt' : undefined, descriptionAvailable: Boolean(html),
      },
    };
  }

  private toArray(value: unknown): unknown[] {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  private greenhouseOffset(checkpoint: Record<string, unknown>, board: string): number {
    if (checkpoint.greenhouseTenant !== board) return 0;
    const value = Number(checkpoint.greenhouseOffset ?? 0);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }

  private greenhouseDetailLimit(limits: Record<string, unknown>, config: Record<string, unknown>): number {
    const value = Number(limits.greenhouseDetailLimit ?? config.greenhouseDetailLimit ?? 20);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 20) : 20;
  }

  private async fetchGreenhouseDetail(board: string, id: string, ctx: FetchContext): Promise<Record<string, unknown> | undefined> {
    const response = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}?pay_transparency=true`, {
      headers: this.jsonHeaders(),
      signal: ctx.signal ?? AbortSignal.timeout(ctx.source.timeoutMs ?? 30_000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Greenhouse ${board}:${id} detail returned ${response.status}`);
    const detail = await response.json();
    return detail && typeof detail === 'object' && !Array.isArray(detail) ? detail as Record<string, unknown> : undefined;
  }

  private mapGreenhouse(rawPayload: Record<string, unknown>, board: string, id: string, title: string): RawOpportunityRecord {
    const url = this.requiredString(rawPayload.absolute_url, `Greenhouse ${board}:${id} job is missing its absolute_url`);
    const company = stringValue(rawPayload.company_name) ?? board;
    const content = stringValue(rawPayload.content);
    const description = this.htmlToText(content);
    const publishedAt = this.dateValue(rawPayload.first_published);
    const deadlineAt = this.strictDateIso(rawPayload.application_deadline);
    const salary = this.greenhouseSalary(rawPayload.pay_input_ranges);
    const locations = this.greenhouseLocations(rawPayload);
    const metadata = this.greenhouseMetadata(rawPayload.metadata);
    return {
      externalId: `${board}:${id}`,
      url,
      type: 'vacancy',
      title,
      companyOrClient: company,
      description,
      publishedAt,
      sourceStatus: 'Active',
      rawPayload,
      sourceMetadata: this.omitUndefined({
        tenant: board, ats: this.id, rawDescription: content, locations, location: locations[0],
        departments: this.nameList(rawPayload.departments), offices: this.nameList(rawPayload.offices),
        employment: stringValue(metadata['Employment Type']) ?? stringValue(metadata.Employment),
        schedule: stringValue(metadata['Workplace Type']), remoteType: stringValue(metadata['Workplace Type']),
        salary, nativeSalaryText: this.greenhouseNativeSalaryText(rawPayload.pay_input_ranges), payInputRanges: rawPayload.pay_input_ranges,
        deadlineAt, sourceDateField: publishedAt ? 'first_published' : undefined,
        updatedAtRaw: stringValue(rawPayload.updated_at), requisitionId: stringValue(rawPayload.requisition_id),
        descriptionAvailable: Boolean(description),
      }),
    };
  }

  private mapLever(rawPayload: Record<string, unknown>, company: string): RawOpportunityRecord {
    const id = this.requiredString(rawPayload.id, `Lever ${company} posting is missing its stable id`);
    const title = this.requiredString(rawPayload.text, `Lever ${company}:${id} posting is missing its title`);
    const url = this.requiredString(rawPayload.hostedUrl ?? rawPayload.applyUrl, `Lever ${company}:${id} posting is missing its hosted URL`);
    const categories = this.recordValue(rawPayload.categories) ?? {};
    const lists = this.toArray(rawPayload.lists).map((item) => this.recordValue(item)).filter((item): item is Record<string, unknown> => Boolean(item));
    const listBody = lists.map((item) => [stringValue(item.text), this.htmlToText(stringValue(item.content))].filter(Boolean).join('\n\n')).filter(Boolean).join('\n\n');
    const description = stringValue(rawPayload.description) ?? stringValue(rawPayload.descriptionPlain);
    const additional = stringValue(rawPayload.additional) ?? stringValue(rawPayload.additionalPlain);
    const body = [description, listBody, additional, rawPayload.salaryDescription]
      .map((item) => this.htmlToText(stringValue(item)))
      .filter(Boolean)
      .join('\n\n');
    const locations = [...new Set([categories.location, ...this.toArray(categories.allLocations)].map(stringValue).filter((item): item is string => Boolean(item)))];
    const salary = this.leverSalary(rawPayload.salaryRange, rawPayload.salaryDescription);
    const salaryIntervalRaw = stringValue(this.recordValue(rawPayload.salaryRange)?.interval);
    return {
      externalId: `${company}:${id}`,
      url,
      type: 'vacancy',
      title,
      companyOrClient: company,
      description: body,
      sourceStatus: 'Active',
      rawPayload,
      sourceMetadata: this.omitUndefined({
        tenant: company, ats: this.id, rawDescription: body, locations, location: locations[0],
        department: stringValue(categories.department), team: stringValue(categories.team), createdAtRaw: rawPayload.createdAt,
        employment: stringValue(categories.commitment), remoteType: stringValue(rawPayload.workplaceType),
        schedule: stringValue(rawPayload.workplaceType), salary, nativeSalaryText: this.htmlToText(stringValue(rawPayload.salaryDescription)), salaryIntervalRaw,
        descriptionAvailable: Boolean(body),
      }),
    };
  }

  private mapAshby(rawPayload: Record<string, unknown>, org: string): RawOpportunityRecord {
    const id = this.requiredString(rawPayload.id, `Ashby ${org} job is missing its stable id`);
    const title = this.requiredString(rawPayload.title, `Ashby ${org}:${id} job is missing its title`);
    const url = this.requiredString(rawPayload.jobUrl ?? rawPayload.applyUrl, `Ashby ${org}:${id} job is missing its job URL`);
    const body = this.htmlToText(stringValue(rawPayload.descriptionPlain) ?? stringValue(rawPayload.descriptionHtml));
    const locations = [...new Set([rawPayload.location, ...this.toArray(rawPayload.secondaryLocations)]
      .map((item) => typeof item === 'string' ? item : stringValue(this.recordValue(item)?.location ?? this.recordValue(item)?.name))
      .filter((item): item is string => Boolean(item)))];
    const publishedAt = this.dateValue(rawPayload.publishedAt);
    const compensation = this.ashbyCompensation(rawPayload.compensation);
    return {
      externalId: `${org}:${id}`,
      url,
      type: 'vacancy',
      title,
      companyOrClient: org,
      description: body,
      publishedAt,
      sourceStatus: rawPayload.isListed === false ? 'Unknown' : 'Active',
      rawPayload,
      sourceMetadata: this.omitUndefined({
        tenant: org, ats: this.id, rawDescription: stringValue(rawPayload.descriptionHtml), locations, location: locations[0],
        department: stringValue(rawPayload.department), team: stringValue(rawPayload.team),
        employment: stringValue(rawPayload.employmentType), schedule: stringValue(rawPayload.workplaceType),
        remoteType: typeof rawPayload.isRemote === 'boolean' && rawPayload.isRemote ? 'Remote' : stringValue(rawPayload.workplaceType),
        salary: compensation.salary, nativeSalaryText: compensation.nativeSalaryText,
        compensationTiers: compensation.tiers, compensationSummaryComponents: compensation.summaryComponents, nativeCompensationSummary: compensation.nativeSummary,
        sourceDateField: publishedAt ? 'publishedAt' : undefined, descriptionAvailable: Boolean(body),
      }),
    };
  }

  private requiredString(value: unknown, message: string): string {
    const text = stringValue(value) ?? (typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined);
    if (!text) throw new Error(message);
    return text;
  }

  private dateValue(value: unknown): Date | undefined {
    const text = stringValue(value);
    if (!text) return undefined;
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
  }

  private windowFrom(ctx: FetchContext): number {
    const frozen = typeof ctx.checkpoint.backfillSince === 'string' ? Date.parse(ctx.checkpoint.backfillSince) : NaN;
    if (Number.isFinite(frozen)) return frozen;
    const explicit = typeof ctx.backfillSince === 'string' ? Date.parse(ctx.backfillSince) : NaN;
    if (Number.isFinite(explicit)) return explicit;
    return Date.now() - Math.min(Math.max(ctx.backfillDays, 1), 30) * 86_400_000;
  }

  private strictDateIso(value: unknown): string | undefined {
    const parsed = this.dateValue(value);
    return parsed?.toISOString();
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private nameList(value: unknown): string[] {
    return [...new Set(this.toArray(value).map((item) => stringValue(this.recordValue(item)?.name)).filter((item): item is string => Boolean(item)))];
  }

  private greenhouseLocations(rawPayload: Record<string, unknown>): string[] {
    return [...new Set([
      stringValue(this.recordValue(rawPayload.location)?.name),
      ...this.toArray(rawPayload.offices).flatMap((item) => {
        const record = this.recordValue(item);
        return [stringValue(record?.location), stringValue(record?.name)];
      }),
    ].filter((item): item is string => Boolean(item)))];
  }

  private greenhouseMetadata(value: unknown): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    for (const item of this.toArray(value)) {
      const record = this.recordValue(item);
      const name = stringValue(record?.name);
      if (name) metadata[name] = record?.value;
    }
    return metadata;
  }

  private greenhouseSalary(value: unknown): Record<string, unknown> | undefined {
    const first = this.toArray(value).map((item) => this.recordValue(item)).find((item): item is Record<string, unknown> => Boolean(item));
    if (!first) return undefined;
    const min = this.centsToUnits(first.min_cents);
    const max = this.centsToUnits(first.max_cents);
    const currency = stringValue(first.currency_type);
    const period = this.compactPeriod([first.title, first.blurb]);
    const originalText = this.salaryText(min, max, currency, period) ?? this.greenhouseNativeSalaryText(value);
    const salary = this.omitUndefined({ min, max, currency, period, originalText });
    return Object.keys(salary).length > 0 ? salary : undefined;
  }

  private greenhouseNativeSalaryText(value: unknown): string | undefined {
    const first = this.toArray(value).map((item) => this.recordValue(item)).find((item): item is Record<string, unknown> => Boolean(item));
    if (!first) return undefined;
    const min = this.centsToUnits(first.min_cents);
    const max = this.centsToUnits(first.max_cents);
    const currency = stringValue(first.currency_type);
    const title = stringValue(first.title);
    const blurb = this.htmlToText(stringValue(first.blurb));
    return [title, this.salaryText(min, max, currency, this.compactPeriod([first.title, first.blurb])), blurb].filter(Boolean).join('\n\n') || undefined;
  }

  private leverSalary(range: unknown, description: unknown): Record<string, unknown> | undefined {
    const record = this.recordValue(range);
    const min = numberValue(record?.min);
    const max = numberValue(record?.max);
    const currency = stringValue(record?.currency);
    const period = this.compactPeriod([record?.interval]);
    const text = this.htmlToText(stringValue(description));
    const originalText = this.salaryText(min, max, currency, period) ?? text;
    const salary = this.omitUndefined({ min, max, currency, period, originalText });
    return Object.keys(salary).length > 0 ? salary : undefined;
  }

  private ashbyCompensation(value: unknown): { salary?: Record<string, unknown>; tiers?: unknown; summaryComponents?: unknown; nativeSalaryText?: string; nativeSummary?: string } {
    const record = this.recordValue(value);
    const components = this.toArray(record?.summaryComponents);
    const salaryComponent = components.map((item) => this.recordValue(item)).find((item) => /salary/i.test(stringValue(item?.compensationType) ?? stringValue(item?.type) ?? stringValue(item?.label) ?? stringValue(item?.name) ?? ''));
    const min = numberValue(salaryComponent?.minValue);
    const max = numberValue(salaryComponent?.maxValue);
    const currency = stringValue(salaryComponent?.currencyCode);
    const period = this.compactPeriod([salaryComponent?.interval]);
    const salarySummary = stringValue(record?.scrapeableCompensationSalarySummary);
    const nativeSummary = stringValue(record?.scrapeableCompensationSalarySummary ?? record?.compensationTierSummary);
    const originalText = this.salaryText(min, max, currency, period) ?? salarySummary;
    const salary = this.omitUndefined({ min, max, currency, period, originalText });
    return {
      salary: Object.keys(salary).length > 0 ? salary : undefined,
      tiers: record?.compensationTiers,
      summaryComponents: record?.summaryComponents,
      nativeSalaryText: salarySummary,
      nativeSummary,
    };
  }

  private compactPeriod(values: unknown[]): string | undefined {
    const text = values.map((value) => this.htmlToText(stringValue(value)) ?? stringValue(value)).filter(Boolean).join(' ').toLowerCase();
    if (!text) return undefined;
    if (/(?:per[-_\s]?year|yearly|annual|annually|year|yr\b)/i.test(text)) return 'YEAR';
    if (/(?:per[-_\s]?month|monthly|month|mo\b)/i.test(text)) return 'MONTH';
    if (/(?:per[-_\s]?hour|hourly|hour|hr\b)/i.test(text)) return 'HOUR';
    return undefined;
  }

  private centsToUnits(value: unknown): number | undefined {
    const cents = numberValue(value);
    return typeof cents === 'number' ? cents / 100 : undefined;
  }

  private salaryText(min?: number, max?: number, currency?: string, period?: string): string | undefined {
    const numbers = [min, max].filter((item, index, array): item is number => typeof item === 'number' && array.indexOf(item) === index);
    if (numbers.length === 0) return undefined;
    const amount = numbers.length === 2 ? `${numbers[0]} – ${numbers[1]}` : numbers[0]?.toString();
    return [amount, currency, period].filter(Boolean).join(' ') || undefined;
  }

  private htmlToText(value?: string): string | undefined {
    if (!value) return undefined;
    let html = value;
    if (/&lt;[a-z!/]/i.test(html)) {
      const decoded = load(html, null, false).root().text();
      if (/<[a-z!/]/i.test(decoded)) html = decoded;
    }
    const $ = load(html, null, false);
    const root = $.root();
    root.find('script,style,noscript').remove();
    root.find('br').replaceWith('\n');
    root.find('li').each((_index, element) => {
      const item = $(element);
      item.prepend('\n- ');
      item.append('\n');
    });
    root.find('p,div,section,article,header,footer,h1,h2,h3,h4,h5,h6,ul,ol,table,tr,blockquote').each((_index, element) => {
      const node = $(element);
      node.before('\n');
      node.after('\n');
    });
    const text = root.text()
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n+ */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text || undefined;
  }

  private omitUndefined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T;
  }

  private mapGeneric(rawPayload: Record<string, unknown>, tenant: string, externalId: string, url: string, title: string): RawOpportunityRecord {
    return {
      externalId: `${tenant}:${externalId}`,
      url,
      type: 'vacancy',
      title,
      companyOrClient: tenant,
      description: typeof rawPayload.content === 'string' ? rawPayload.content : undefined,
      sourceStatus: 'Active',
      rawPayload,
      sourceMetadata: { tenant, ats: this.id },
    };
  }

  private jsonHeaders(): HeadersInit {
    return { Accept: 'application/json', 'Accept-Encoding': 'identity' };
  }
}
