import { load } from 'cheerio';

import { WebExtractionService } from '../extraction/web-extraction.service';
import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';

const ORIGIN = 'https://arc.dev';
const LIST_URL = `${ORIGIN}/remote-jobs`;
const OBSERVED_CATEGORY_REDIRECT = `${ORIGIN}/remote-jobs/full-stack`;
const VERSION = 'arc-native-public-v1';
const DAY_MS = 86_400_000;
const BATCH_SIZE = 10;
const MAX_BYTES = 3_000_000;
const ID = /^[a-z0-9]{10}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIMITATION = 'Only the anonymous server-rendered job snapshot is collected. Observed SSR embeds 30 Arc and 30 external cards; the public UI shows 6 featured and 4 external cards, then links to registration to find 8,200+ jobs. The native public UI registration boundary is verified; authenticated pagination/API and full 30-day coverage remain unproved.';
const PUBLIC_CATALOG_ACCESS = {
  boundary: 'registration-required-by-native-public-ui',
  signupUrl: `${ORIGIN}/signup?userType=developer`,
  publicUiRegistrationGateObserved: true,
  observedPublicUiFeaturedCards: 6,
  observedPublicUiExternalCards: 4,
  authenticatedPaginationVerified: false,
} as const;
const PUBLIC_ACCESS_METADATA = { publicAccess: 'registration-required-for-full-catalog', fullCatalogRequiresCredentials: true } as const;

type NativeObject = Record<string, unknown>;
type NativeCard = { kind: 'exclusive' | 'external'; id: string; url: string; job: NativeObject };
type Listing = { cards: NativeCard[]; buildId: string; arcLoaded: number; externalLoaded: number; externalTotal: number };
type State = Omit<Listing, 'cards'> & { catalogIds: string[]; pending: NativeCard[]; processedIds: string[]; excludedIds: string[]; windowSince: string; windowUntil: string; batches: number };

/** Anonymous native SSR snapshot and full details. Pagination beyond that snapshot is explicitly incomplete. */
export class ArcConnector implements Connector {
  readonly id = 'arc';
  readonly family = 'PublicHtml' as const;

  constructor(private readonly extraction: WebExtractionService) {}

  capabilities(): ConnectorCapabilities {
    return { supportsBackfill: true, supportsIncremental: true, supportsRefresh: false, requiresCredentials: false, maxBackfillDays: 30 };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    try {
      configuredUrl(config.baseUrl);
      return { ok: true, message: 'Arc anonymous native jobs snapshot configured', details: { parserVersion: VERSION, fullCatalogPaginationVerified: false } };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    try {
      this.validateSource(ctx);
      const document = await this.extract(LIST_URL, ctx);
      const listing = parseListing(document.html, document.finalUrl);
      return { state: 'Degraded', checkedAt: new Date(), message: 'Arc native snapshot is readable; the public UI requires registration for the larger catalog', details: { cards: listing.cards.length, externalTotal: listing.externalTotal, ...PUBLIC_ACCESS_METADATA, publicCatalogAccess: { ...PUBLIC_CATALOG_ACCESS }, limitation: LIMITATION } };
    } catch (error) {
      return { state: 'Failed', checkedAt: new Date(), message: errorMessage(error) };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    ctx.signal?.throwIfAborted();
    this.validateSource(ctx);
    let state: State;
    if (Object.keys(ctx.checkpoint).length) {
      state = storedState(ctx.checkpoint);
    } else {
      const window = initialWindow(ctx);
      const document = await this.extract(LIST_URL, ctx);
      const listing = parseListing(document.html, document.finalUrl);
      state = { ...listing, ...window, catalogIds: listing.cards.map(card => card.id), pending: listing.cards, processedIds: [], excludedIds: [], batches: 0 };
    }
    const batch = state.pending.slice(0, BATCH_SIZE);
    const records: RawOpportunityRecord[] = [];
    const processedIds = [...state.processedIds];
    const excludedIds = [...state.excludedIds];
    for (const card of batch) {
      const catalogDate = nativeDate(card.job.postedAt, 'catalog postedAt');
      if (catalogDate && !withinWindow(catalogDate, state)) {
        excludedIds.push(card.id);
      } else {
        const document = await this.extract(card.url, ctx);
        const record = document.finalUrl === OBSERVED_CATEGORY_REDIRECT
          ? catalogOnlyRecord(card, document.html, document.finalUrl)
          : nativeRecord(card, document.html, document.finalUrl);
        if (!record.publishedAt || withinWindow(record.publishedAt, state)) records.push(record);
        else excludedIds.push(card.id);
      }
      processedIds.push(card.id);
    }
    const pending = state.pending.slice(batch.length);
    const hasMore = pending.length > 0;
    const batches = state.batches + (batch.length ? 1 : 0);
    return {
      records,
      hasMore,
      nextPage: hasMore ? batches : undefined,
      stats: { seen: batch.length },
      checkpoint: {
        parserVersion: VERSION,
        listingUrl: LIST_URL,
        listingBuildId: state.buildId,
        windowSince: state.windowSince,
        windowUntil: state.windowUntil,
        arcLoaded: state.arcLoaded,
        externalLoaded: state.externalLoaded,
        externalTotalObserved: state.externalTotal,
        catalogIds: state.catalogIds,
        processedIds,
        excludedIds,
        pending,
        batches,
        hasMore,
        incomplete: !hasMore,
        catalogComplete: false,
        coverageScope: 'anonymous-public-SSR-snapshot',
        ...PUBLIC_ACCESS_METADATA,
        publicCatalogAccess: { ...PUBLIC_CATALOG_ACCESS },
        limitation: LIMITATION,
        terminalReason: hasMore ? undefined : 'native-public-registration-boundary',
      },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> { return result.checkpoint; }

  private validateSource(ctx: ConnectorContext): void {
    if (ctx.source._id !== this.id) throw new Error('Arc connector requires the Arc source identity');
    configuredUrl(ctx.source.config?.baseUrl ?? ctx.source.endpoint?.baseUrl);
  }

  private async extract(url: string, ctx: ConnectorContext) {
    safeUrl(url);
    const document = await this.extraction.extractUrl(url, { allowedHosts: ['arc.dev'], timeoutMs: ctx.source.timeoutMs ?? 20_000, maxBytes: MAX_BYTES, signal: ctx.signal });
    const categoryFallback = url !== LIST_URL && document.finalUrl === OBSERVED_CATEGORY_REDIRECT;
    if (!categoryFallback && safeUrl(document.finalUrl) !== url) throw new Error('Arc public document redirected away from the requested native URL');
    if (Buffer.byteLength(document.html, 'utf8') > MAX_BYTES) throw new Error('Arc public document exceeds the parser safety limit');
    return document;
  }
}

function catalogOnlyRecord(card: NativeCard, html: string, finalUrl: string): RawOpportunityRecord {
  if (finalUrl !== OBSERVED_CATEGORY_REDIRECT) throw new Error('Arc detail has an unverified category redirect');
  const { data, props, $ } = nextData(html, '/remote-jobs/[urlSearchQuery]');
  const query = object(data.query, 'category redirect query');
  if (Object.keys(query).length !== 1 || query.urlSearchQuery !== 'full-stack' || props.job != null || !Array.isArray(props.arcJobs) || !Array.isArray(props.externalJobs)) throw new Error('Arc detail redirect does not contain the verified native category state');
  integer(props.totalExternalJobCount, 'category external total');
  const canonical = $('link[rel="canonical"]');
  if (canonical.length !== 1 || canonical.attr('href') !== OBSERVED_CATEGORY_REDIRECT) throw new Error('Arc category redirect canonical does not match the observed native target');
  const job = card.job;
  const company = optionalObject(job.company);
  const publishedAt = nativeDate(job.postedAt, 'catalog postedAt');
  const catalogDescription = optionalString(job.description);
  const locations = [...new Set([...nativeStrings(job.requiredLocations, 'required locations'), ...nativeStrings(job.requiredCountries, 'required countries')])];
  return {
    externalId: card.id,
    url: card.url,
    type: nativeType(job.jobType),
    title: requiredString(job.title, 'catalog title'),
    companyOrClient: optionalString(company?.name),
    description: catalogDescription ? descriptionText(catalogDescription) : undefined,
    publishedAt,
    sourceStatus: 'Unknown',
    rawPayload: { parserVersion: VERSION, nativeCatalogUrl: LIST_URL, nativeDetailUrl: card.url, nativeFeed: card.kind, nativeCard: job, nativeUnavailableDetail: { reason: 'native-category-redirect', finalUrl, nativeRoute: data.page, nativeQuery: query } },
    sourceMetadata: {
      parserVersion: VERSION, nativeFeed: card.kind, nativeJobType: job.jobType, nativeCatalogJobType: job.jobType,
      opportunityTypeBasis: 'catalog-native-job-type-detail-unavailable',
      publicationDateKnown: Boolean(publishedAt), publicationDateBasis: publishedAt ? 'catalog.postedAt-unix-seconds' : 'unknown',
      detailCompleteness: 'catalog-only-native-category-redirect', nativeDetailAvailability: 'unavailable-redirected-to-native-category',
      nativeDetailRedirectUrl: finalUrl, fullDescriptionAvailable: false, descriptionBasis: catalogDescription ? 'native-catalog-description' : 'unavailable',
      coverageScope: 'anonymous-public-SSR-snapshot', catalogComplete: false, ...PUBLIC_ACCESS_METADATA, publicCatalogAccess: { ...PUBLIC_CATALOG_ACCESS },
      location: locations.length ? locations.join(', ') : undefined, locations, locationBasis: 'native-job-required-locations-and-country-codes',
      remoteType: 'Remote', remoteTypeBasis: 'Arc public remote-jobs catalog classification',
      employmentType: job.jobType === 'fulltime' ? 'permanent' : optionalString(job.jobType), employmentTypeKnown: true,
      seniority: optionalString(job.experienceLevel) ?? (nativeStrings(job.experienceLevels, 'experience levels').join(', ') || undefined),
      skills: nativeCategories(job.categories), salary: nativeSalary(job, {}),
    },
  };
}

function parseListing(html: string, url: string): Listing {
  if (safeUrl(url) !== LIST_URL) throw new Error('Arc listing URL does not match the native unfiltered catalog');
  const { data, props, $ } = nextData(html, '/remote-jobs');
  if (Object.keys(object(data.query, 'listing query')).length) throw new Error('Arc listing reflected unexpected native filters');
  const buildId = requiredString(data.buildId, 'listing build ID');
  if (!Array.isArray(props.arcJobs) || !Array.isArray(props.externalJobs)) throw new Error('Arc listing is missing its native job arrays');
  const externalTotal = integer(props.totalExternalJobCount, 'external catalog total');
  if (externalTotal < props.externalJobs.length) throw new Error('Arc native external total is smaller than the embedded job array');
  const cards = [
    ...props.arcJobs.map(job => cardFrom(job, 'exclusive')),
    ...props.externalJobs.map(job => cardFrom(job, 'external')),
  ];
  if (!cards.length) throw new Error('Arc native empty catalog has not been independently verified');
  if (new Set(cards.map(card => card.id)).size !== cards.length) throw new Error('Arc listing repeats a native job ID');
  // Native SSR renders only a prefix. Its real links attest each feed's URL builder for embedded cards.
  for (const kind of ['exclusive', 'external'] as const) {
    const feed = cards.filter(card => card.kind === kind);
    if (!feed.length) continue;
    const prefix = kind === 'exclusive' ? '/remote-jobs/details/' : '/remote-jobs/j/';
    const anchors = $(`a[href^="${prefix}"]`).map((_, element) => new URL($(element).attr('href')!, ORIGIN).toString()).get();
    if (!anchors.length || anchors.some(anchor => !feed.some(card => card.url === anchor))) throw new Error('Arc native job links do not attest the embedded feed URL contract');
  }
  assertCanonical($, LIST_URL);
  return { cards, buildId, arcLoaded: props.arcJobs.length, externalLoaded: props.externalJobs.length, externalTotal };
}

function cardFrom(value: unknown, kind: NativeCard['kind']): NativeCard {
  const job = object(value, 'catalog job');
  const id = requiredString(job.randomKey, 'native job ID');
  const slug = requiredString(job.urlString, 'native job slug');
  if (!ID.test(id) || !SLUG.test(slug)) throw new Error('Arc job has an unsupported native identity or slug');
  requiredString(job.title, 'native job title');
  nativeType(job.jobType);
  nativeDate(job.postedAt, 'catalog postedAt');
  const url = `${ORIGIN}/remote-jobs/${kind === 'exclusive' ? 'details' : 'j'}/${slug}-${id}`;
  return { kind, id, url, job };
}

function nativeRecord(card: NativeCard, html: string, url: string): RawOpportunityRecord {
  if (safeUrl(url) !== card.url) throw new Error('Arc detail URL does not match the retained catalog identity');
  const route = card.kind === 'exclusive' ? 'details' : 'j';
  const { data, props, $ } = nextData(html, `/remote-jobs/${route}/[urlString]`);
  const query = object(data.query, 'detail query');
  if (Object.keys(query).length !== 1 || query.urlString !== `${card.job.urlString}-${card.id}`) throw new Error('Arc detail route query does not match the catalog identity');
  const job = object(props.job, 'detail job');
  if (job.randomKey !== card.id || job.urlString !== card.job.urlString) throw new Error('Arc detail native identity differs from the catalog card');
  assertCanonical($, card.url);
  const detailJobType = job.jobType ?? job.contractType;
  const detailType = recognizedNativeType(detailJobType);
  const catalogType = nativeType(card.job.jobType);
  if (detailType && detailType !== catalogType) throw new Error('Arc detail native job type differs from its catalog card');
  // A valid detail may expose a new employment label. Its retained catalog still proves the opportunity category.
  const type = detailType ?? catalogType;
  const title = requiredString(job.title, 'detail title');
  const nativeDescription = requiredString(job.description, 'native detail description');
  const description = descriptionText(nativeDescription);
  if (!description) throw new Error('Arc detail has no readable native job description');
  const publishedAt = nativeDate(job.postedAt, 'detail postedAt') ?? nativeDate(card.job.postedAt, 'catalog postedAt');
  const updatedAt = nativeDate(job.updatedAt, 'detail updatedAt');
  const company = optionalObject(job.company) ?? optionalObject(card.job.company);
  const companyOrClient = optionalString(job.companyName) ?? optionalString(company?.name);
  const locations = [...new Set([...nativeStrings(job.requiredLocations ?? card.job.requiredLocations, 'required locations'), ...nativeStrings(job.requiredCountries ?? card.job.requiredCountries, 'required countries')])];
  const skills = nativeCategories(job.categories ?? job.techStackDetails ?? card.job.categories);
  const salary = nativeSalary(job, card.job);
  return {
    externalId: card.id,
    url: card.url,
    type,
    title,
    companyOrClient,
    description,
    publishedAt,
    updatedAt,
    sourceStatus: job.closed === true ? 'Closed' : job.closed === false || job.state === 'opened' || job.aasmState === 'open' ? 'Active' : 'Unknown',
    rawPayload: { parserVersion: VERSION, nativeCatalogUrl: LIST_URL, nativeDetailUrl: card.url, nativeFeed: card.kind, nativeCard: card.job, nativeJob: job },
    sourceMetadata: {
      parserVersion: VERSION,
      nativeFeed: card.kind,
      nativeJobType: detailJobType,
      nativeCatalogJobType: card.job.jobType,
      nativeDetailJobTypeKnown: Boolean(detailType),
      opportunityTypeBasis: detailType ? 'detail-native-job-type' : 'catalog-native-job-type-detail-employment-unspecified',
      publicationDateKnown: Boolean(publishedAt),
      publicationDateBasis: publishedAt ? (job.postedAt == null ? 'catalog.postedAt-unix-seconds' : 'detail.postedAt-unix-seconds') : 'unknown',
      detailCompleteness: 'native-full-job-description',
      coverageScope: 'anonymous-public-SSR-snapshot',
      catalogComplete: false,
      ...PUBLIC_ACCESS_METADATA,
      publicCatalogAccess: { ...PUBLIC_CATALOG_ACCESS },
      location: locations.length ? locations.join(', ') : undefined,
      locations,
      locationBasis: 'native-job-required-locations-and-country-codes',
      remoteType: 'Remote',
      remoteTypeBasis: 'Arc public remote-jobs catalog classification',
      employmentType: detailType ? (detailJobType === 'fulltime' ? 'permanent' : optionalString(detailJobType)) : undefined,
      employmentTypeKnown: Boolean(detailType),
      seniority: optionalString(job.experienceLevel) ?? (nativeStrings(job.experienceLevels, 'experience levels').join(', ') || undefined),
      skills,
      optionalSkills: nativeCategories(job.optionalCategories),
      salary,
      timezone: job.timezone ?? card.job.timeZone,
      timezoneOffset: job.timezoneOffset ?? card.job.timeZoneOffset,
      timezoneRestriction: job.clientTimezoneRestriction ?? card.job.clientTimeZoneRestriction,
      availableHoursPerWeek: optionalNumber(job.availableHoursPerWeek),
      estimatedWeeks: optionalNumber(job.estimatedWeeks),
      nativeApplyUrl: optionalString(job.url ?? job.jobLink),
    },
  };
}

function storedState(checkpoint: Record<string, unknown>): State {
  if (checkpoint.parserVersion !== VERSION || checkpoint.listingUrl !== LIST_URL) throw new Error('Arc continuation has an unsupported native checkpoint');
  const windowSince = iso(checkpoint.windowSince, 'checkpoint windowSince');
  const windowUntil = iso(checkpoint.windowUntil, 'checkpoint windowUntil');
  if (Date.parse(windowSince) > Date.parse(windowUntil) || Date.parse(windowUntil) - Date.parse(windowSince) > 30 * DAY_MS) throw new Error('Arc checkpoint window exceeds its fixed 30-day scope');
  const catalogIds = idArray(checkpoint.catalogIds, 'catalog IDs');
  const processedIds = idArray(checkpoint.processedIds, 'processed IDs');
  const excludedIds = idArray(checkpoint.excludedIds, 'excluded IDs');
  if (!Array.isArray(checkpoint.pending)) throw new Error('Arc continuation is missing pending native cards');
  const pending = checkpoint.pending.map(value => {
    const retained = object(value, 'pending native card');
    if (retained.kind !== 'exclusive' && retained.kind !== 'external') throw new Error('Arc pending card has an unsupported native feed');
    const card = cardFrom(retained.job, retained.kind);
    if (retained.id !== card.id || retained.url !== card.url) throw new Error('Arc pending card URL or identity changed');
    return card;
  });
  const combined = [...processedIds, ...pending.map(card => card.id)];
  if (new Set(combined).size !== combined.length || combined.length !== catalogIds.length || combined.some(id => !catalogIds.includes(id)) || excludedIds.some(id => !processedIds.includes(id))) throw new Error('Arc continuation native history or pending partition is inconsistent');
  if (checkpoint.hasMore !== (pending.length > 0)) throw new Error('Arc continuation pending cards disagree with hasMore');
  const arcLoaded = integer(checkpoint.arcLoaded, 'checkpoint Arc loaded count');
  const externalLoaded = integer(checkpoint.externalLoaded, 'checkpoint external loaded count');
  const externalTotal = integer(checkpoint.externalTotalObserved, 'checkpoint external total');
  if (arcLoaded + externalLoaded !== catalogIds.length || externalTotal < externalLoaded) throw new Error('Arc checkpoint catalog cardinality changed');
  return { catalogIds, pending, processedIds, excludedIds, arcLoaded, externalLoaded, externalTotal, buildId: requiredString(checkpoint.listingBuildId, 'checkpoint build ID'), windowSince, windowUntil, batches: integer(checkpoint.batches, 'checkpoint batch count') };
}

function nextData(html: string, page: string) {
  const $ = load(html);
  if ($('#__NEXT_DATA__').length !== 1) throw new Error('Arc public page is missing its native Next.js state');
  let parsed: unknown;
  try { parsed = JSON.parse($('#__NEXT_DATA__').text()); } catch { throw new Error('Arc native page state is malformed JSON'); }
  const data = object(parsed, 'Next.js state');
  if (data.page !== page) throw new Error('Arc native page route does not match the expected catalog or detail');
  const props = object(object(data.props, 'Next.js props').pageProps, 'native page props');
  if (props.error || props.notFound || data.isFallback === true) throw new Error('Arc native page returned an error or fallback state');
  return { data, props, $ };
}

function assertCanonical($: ReturnType<typeof load>, url: string): void {
  const links = $('link[rel="canonical"]');
  if (links.length !== 1 || safeUrl(links.attr('href')) !== url) throw new Error('Arc canonical URL does not match the native requested identity');
}

function configuredUrl(value: unknown): string {
  if (value == null) return LIST_URL;
  if (safeUrl(value) !== LIST_URL) throw new Error('Arc baseUrl must be its native unfiltered remote-jobs catalog');
  return LIST_URL;
}

function safeUrl(value: unknown): string {
  const text = requiredString(value, 'public URL');
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('Arc public URL is invalid'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !/^\/remote-jobs(?:\/(?:details|j)\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(url.pathname)) throw new Error('Arc public URL is outside the supported native catalog/detail scope');
  return url.toString();
}

function initialWindow(ctx: FetchContext): { windowSince: string; windowUntil: string } {
  if (!Number.isSafeInteger(ctx.backfillDays) || ctx.backfillDays < 1) throw new Error('Arc effective backfill must be a positive integer');
  // The source API validates requested scope; elapsed-day rounding can make an approved 30-day run arrive as 31.
  const days = Math.min(ctx.backfillDays, 30);
  const now = Date.now();
  const windowSince = ctx.backfillSince ? iso(ctx.backfillSince, 'backfillSince') : new Date(now - days * DAY_MS).toISOString();
  if (Date.parse(windowSince) > now) throw new Error('Arc backfillSince must not be in the future');
  // backfillSince belongs to the original run. Delayed first execution must not extend its window.
  const windowUntil = new Date(Math.min(now, Date.parse(windowSince) + days * DAY_MS)).toISOString();
  return { windowSince, windowUntil };
}

function nativeSalary(job: NativeObject, card: NativeObject): NativeObject | undefined {
  for (const [low, high, period] of [['minHourlyRate', 'maxHourlyRate', 'hour'], ['minAnnualSalary', 'maxAnnualSalary', 'year']] as const) {
    const from = optionalNumber(job[low] ?? card[low]);
    const to = optionalNumber(job[high] ?? card[high]);
    if (from === undefined && to === undefined) continue;
    if ((from !== undefined && from < 0) || (to !== undefined && to < 0) || (from !== undefined && to !== undefined && from > to)) throw new Error('Arc native salary range is invalid');
    // These native fields prove rate/period, but neither observed JSON nor rendered rate label states currency.
    return { from, to, period, kind: 'range', originalText: `${from ?? ''}${from !== undefined && to !== undefined ? '–' : ''}${to ?? ''} / ${period}; currency unspecified`, currencyKnown: false, nativeFields: [low, high] };
  }
  return undefined;
}

function descriptionText(value: string): string {
  if (!/<\/?[a-z][\s\S]*>/i.test(value)) return value.trim();
  const $ = load(value);
  $('script,style').remove();
  $('br').replaceWith('\n');
  $('p,li,h1,h2,h3,h4,h5,h6,div,section').each((_, element) => { $(element).append('\n'); });
  return $.root().text().replace(/[\t ]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function nativeCategories(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('Arc native categories must be an array');
  return [...new Set(value.map(item => requiredString(object(item, 'native category').name, 'native category name')))];
}

function nativeStrings(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`Arc ${label} must be an array`);
  return value.map(item => requiredString(item, label));
}

function nativeDate(value: unknown, label: string): Date | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 253_402_300_799) throw new Error(`Arc ${label} must be a genuine native Unix-second timestamp`);
  return new Date(value * 1_000);
}

function nativeType(value: unknown): RawOpportunityRecord['type'] {
  const type = recognizedNativeType(value);
  if (type) return type;
  throw new Error('Arc job type is outside the observed permanent/contract native contract');
}

function recognizedNativeType(value: unknown): RawOpportunityRecord['type'] | undefined {
  // Observed pnbwza8npq: catalog permanent, detail fulltime, public UI "Full-time role".
  if (value === 'permanent' || value === 'fulltime') return 'vacancy';
  if (value === 'contract') return 'freelance';
  if (value != null && typeof value !== 'string') throw new Error('Arc native job type must be a scalar string or unspecified');
  return undefined;
}

function withinWindow(date: Date, state: { windowSince: string; windowUntil: string }): boolean { return date.getTime() >= Date.parse(state.windowSince) && date.getTime() <= Date.parse(state.windowUntil); }
function iso(value: unknown, label: string): string { const text = requiredString(value, label); const date = new Date(text); if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) throw new Error(`Arc ${label} must be a canonical ISO timestamp`); return text; }
function idArray(value: unknown, label: string): string[] { const ids = nativeStrings(value, label); if (ids.some(id => !ID.test(id)) || new Set(ids).size !== ids.length) throw new Error(`Arc ${label} contain invalid or repeated native identities`); return ids; }
function integer(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Arc ${label} must be a nonnegative integer`); return value; }
function object(value: unknown, label: string): NativeObject { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Arc ${label} must be an object`); return value as NativeObject; }
function optionalObject(value: unknown): NativeObject | undefined { return value == null ? undefined : object(value, 'optional native object'); }
function requiredString(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`Arc ${label} is required`); return value.trim(); }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function optionalNumber(value: unknown): number | undefined { if (value == null) return undefined; if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Arc optional numeric fact is malformed'); return value; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Arc public native document failed'; }
