import { createHash } from 'node:crypto';

import type { Opportunity, SourceOccurrence } from './schemas/opportunity.schema';

export type DuplicateOpportunityFacts = Omit<
  Partial<Pick<Opportunity, '_id' | 'type' | 'title' | 'companyOrClient' | 'description' | 'location' | 'publishedAt' | 'sourceOccurrences' | 'tenderData'>>,
  'publishedAt' | 'sourceOccurrences'
> & {
  publishedAt?: Date | string | null;
  sourceOccurrences?: ReadonlyArray<Partial<Pick<SourceOccurrence, 'sourceId' | 'externalId' | 'url'>>> | null;
};

export type DuplicateDecision = {
  verdict: 'duplicate' | 'ambiguous' | 'distinct';
  level: 'source_identity' | 'canonical_url' | 'fingerprint' | 'fuzzy' | null;
  /** Strength of the evidence for this verdict, between zero and one. */
  confidence: number;
  reasons: string[];
};

// Conservative v1 thresholds: publication days are UTC, never inferred from
// firstSeen/updated. A gap > 7 days identifies separate postings unless native
// source identity agrees. Fuzzy auto-merge needs dates within 2 days, equal
// counterpart/location, title >= .92 and a reliable body >= .94. A fingerprint
// needs body >= .92 too; a name/date coincidence alone is only a candidate.
const DAY_MS = 86_400_000;
const FAR_PUBLICATION_DAYS = 7;
const FUZZY_PUBLICATION_DAYS = 2;
const SECRET_PARAMETERS = new Set([
  'token', 'access_token', 'accesstoken', 'refresh_token', 'refreshtoken',
  'auth', 'authorization', 'auth_token', 'authtoken', 'jwt', 'api_key', 'apikey',
  'password', 'passwd', 'secret', 'client_secret', 'clientsecret', 'session',
  'sessionid', 'session_id', 'signature', 'sig', 'x-goog-signature',
]);
const NOTICE_FIELDS = ['noticeNumber', 'officialNoticeNumber', 'nativeNoticeNumber', 'eisNumber', 'purchaseNoticeNumber'];
const LOT_QUERY_KEYS = new Set(['lot', 'lotid', 'lot_id', 'lotnumber', 'lot_number']);
const NOTICE_QUERY_KEYS = new Set(['notice', 'noticeid', 'notice_id', 'noticenumber', 'notice_number']);
const TECHNOLOGY_ALIASES: Record<string, string> = {
  'c++': 'c++', 'c#': 'c#', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript',
  typescript: 'typescript', ts: 'typescript', golang: 'golang', rust: 'rust', ruby: 'ruby', php: 'php',
  kotlin: 'kotlin', swift: 'swift', scala: 'scala', dart: 'dart',
  postgresql: 'postgresql', postgres: 'postgresql', mysql: 'mysql', oracle: 'oracle',
  mongodb: 'mongodb', redis: 'redis', cassandra: 'cassandra', elasticsearch: 'elasticsearch',
  react: 'react', angular: 'angular', vue: 'vue', svelte: 'svelte', aws: 'aws', azure: 'azure',
  gcp: 'gcp', docker: 'docker', kubernetes: 'kubernetes', kafka: 'kafka',
};

export function normalizeDuplicateText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function normalizeDuplicateUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    for (const key of url.searchParams.keys()) {
      const normalizedKey = key.toLowerCase();
      if (SECRET_PARAMETERS.has(normalizedKey) || normalizedKey.startsWith('x-amz-')) return null;
    }
    for (const key of [...url.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.startsWith('utm') || ['gclid', 'fbclid'].includes(normalizedKey)) url.searchParams.delete(key);
    }
    url.hash = '';
    // Stable key order; repeated parameter values retain their native order.
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

export function duplicateFingerprint(input: DuplicateOpportunityFacts): string | null {
  const title = text(input.title);
  const counterpart = text(input.companyOrClient);
  const location = text(input.location);
  const publicationDay = publishedDay(input.publishedAt);
  if (!validType(input.type) || !title || !counterpart || !location || publicationDay === null) return null;
  return createHash('sha256').update(JSON.stringify([
    input.type, title, counterpart, location, publicationDay,
  ])).digest('hex');
}

export function compareDuplicateOpportunities(left: DuplicateOpportunityFacts, right: DuplicateOpportunityFacts): DuplicateDecision {
  const decision = (verdict: DuplicateDecision['verdict'], level: DuplicateDecision['level'], confidence: number, ...reasons: string[]): DuplicateDecision => ({ verdict, level, confidence, reasons });
  if (validType(left.type) && validType(right.type) && left.type !== right.type) {
    return decision('distinct', null, 1, 'different_opportunity_types');
  }
  const leftSources = identities(left);
  const rightSources = identities(right);
  const sameNativeIdentity = [...leftSources].some(([source, ids]) => intersects(ids, rightSources.get(source) ?? new Set()));
  const differentNativeIdentity = [...leftSources].some(([source, ids]) => {
    const otherIds = rightSources.get(source);
    return ids.size > 0 && !!otherIds?.size && !intersects(ids, otherIds);
  });
  const leftUrls = urls(left);
  const rightUrls = urls(right);
  const tender = left.type === 'tender' || right.type === 'tender';
  if (tender) {
    const conflict = tenderConflict(left, right, leftUrls, rightUrls);
    if (conflict) return decision('distinct', null, 1, conflict);
  }
  if (differentNativeIdentity) return decision('distinct', 'source_identity', 1, 'different_native_ids_in_same_source');
  if (sameNativeIdentity) return decision('duplicate', 'source_identity', 0.995, 'exact_source_and_external_id');

  const leftDay = publishedDay(left.publishedAt);
  const rightDay = publishedDay(right.publishedAt);
  const dateGap = leftDay !== null && rightDay !== null ? Math.abs(leftDay - rightDay) : null;
  if (dateGap !== null && dateGap > FAR_PUBLICATION_DAYS) {
    return decision('distinct', null, 0.99, 'publication_dates_far_apart');
  }

  const leftTitle = text(left.title);
  const rightTitle = text(right.title);
  const titleSimilarity = similarity(leftTitle, rightTitle);
  const leftCounterpart = text(left.companyOrClient);
  const rightCounterpart = text(right.companyOrClient);
  const leftLocation = text(left.location);
  const rightLocation = text(right.location);
  const leftBody = text(left.description);
  const rightBody = text(right.description);
  const reliableBodies = reliableBody(leftBody) && reliableBody(rightBody);
  const bodySimilarity = reliableBodies ? similarity(leftBody, rightBody) : 0;
  const counterpartConflict = !!leftCounterpart && !!rightCounterpart && leftCounterpart !== rightCounterpart;
  const locationConflict = !!leftLocation && !!rightLocation && leftLocation !== rightLocation;
  const titleConflict = incompatibleTitleFacts(leftTitle, rightTitle);
  const bodyConflict = reliableBodies && incompatibleBodyFacts(leftBody, rightBody);
  const sharedUrls = [...leftUrls].filter((url) => rightUrls.has(url));
  if (sharedUrls.length) {
    const conflicts = [
      ...(!leftTitle || !rightTitle ? ['title_missing'] : titleSimilarity < 0.8 ? ['titles_incompatible'] : []),
      ...(counterpartConflict ? ['counterparts_incompatible'] : []),
      ...(locationConflict ? ['locations_incompatible'] : []),
      ...(titleConflict ? [titleConflict] : []),
      ...(bodyConflict || (reliableBodies && bodySimilarity < 0.7) ? ['descriptions_incompatible'] : []),
      ...(tender && !knownSameLot(left, right, sharedUrls) ? ['tender_lot_identity_unverified'] : []),
      ...(sharedUrls.every(isBareHomepage) ? ['url_is_only_homepage'] : []),
    ];
    if (conflicts.length) return decision('ambiguous', 'canonical_url', 0.8, 'exact_normalized_url', ...conflicts);
    return decision('duplicate', 'canonical_url', 0.98, 'exact_normalized_url');
  }

  if (titleConflict) return decision('distinct', 'fuzzy', 0.98, titleConflict);
  const fingerprint = duplicateFingerprint(left);
  if (fingerprint && fingerprint === duplicateFingerprint(right)) {
    const blockers = automaticMergeBlockers(left, right, reliableBodies, bodyConflict, tender, []);
    if (bodySimilarity < 0.92) blockers.push(reliableBodies ? 'descriptions_not_similar_enough' : 'reliable_description_missing');
    if (blockers.length) return decision('ambiguous', 'fingerprint', 0.86, 'exact_fingerprint', ...unique(blockers));
    return decision('duplicate', 'fingerprint', 0.97, 'exact_fingerprint', 'reliable_description_agrees', 'different_sources');
  }

  if (titleSimilarity < 0.68 && bodySimilarity < 0.85) return decision('distinct', 'fuzzy', 0.95, 'texts_not_similar');
  if (counterpartConflict && bodySimilarity < 0.85) return decision('distinct', 'fuzzy', 0.96, 'counterparts_incompatible');
  if (locationConflict && bodySimilarity < 0.85) return decision('distinct', 'fuzzy', 0.94, 'locations_incompatible');
  const blockers = automaticMergeBlockers(left, right, reliableBodies, bodyConflict, tender, []);
  if (!validType(left.type) || !validType(right.type)) blockers.push('opportunity_type_missing');
  if (!leftCounterpart || !rightCounterpart) blockers.push('counterpart_missing');
  else if (counterpartConflict) blockers.push('counterparts_incompatible');
  if (!leftLocation || !rightLocation) blockers.push('location_missing');
  else if (locationConflict) blockers.push('locations_incompatible');
  if (dateGap === null) blockers.push('publication_date_missing');
  else if (dateGap > FUZZY_PUBLICATION_DAYS) blockers.push('publication_dates_not_close');
  if (titleSimilarity < 0.92) blockers.push('titles_not_similar_enough');
  if (bodySimilarity < 0.94) blockers.push(reliableBodies ? 'descriptions_not_similar_enough' : 'reliable_description_missing');
  if (!blockers.length) return decision('duplicate', 'fuzzy', 0.94, 'title_and_reliable_description_agree', 'counterpart_location_and_publication_agree', 'different_sources');
  return decision('ambiguous', 'fuzzy', Math.min(0.89, 0.45 + titleSimilarity * 0.2 + bodySimilarity * 0.24), 'text_candidate_requires_review', ...unique(blockers));
}

function text(value: unknown): string {
  return typeof value === 'string' ? normalizeDuplicateText(value) : '';
}

function validType(value: unknown): value is Opportunity['type'] {
  return value === 'vacancy' || value === 'freelance' || value === 'tender';
}

function publishedDay(value: unknown): number | null {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string') {
    // Only explicit ISO calendar dates or timestamps with a timezone. Reject
    // ambiguous local formats and Date.parse's silent calendar rollovers.
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
    if (!match) return null;
    const [, year, month, day] = match;
    const calendar = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return null;
    if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59)) return null;
    date = new Date(value);
  } else return null;
  return Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / DAY_MS) : null;
}

function identities(input: DuplicateOpportunityFacts): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const occurrence of input.sourceOccurrences ?? []) {
    const source = typeof occurrence.sourceId === 'string' ? occurrence.sourceId.trim() : '';
    if (!source) continue;
    const ids = result.get(source) ?? new Set<string>();
    if (typeof occurrence.externalId === 'string' && occurrence.externalId.trim()) ids.add(occurrence.externalId.trim());
    result.set(source, ids);
  }
  return result;
}

function urls(input: DuplicateOpportunityFacts): Set<string> {
  return new Set((input.sourceOccurrences ?? []).flatMap((occurrence) => {
    const url = typeof occurrence.url === 'string' ? normalizeDuplicateUrl(occurrence.url) : null;
    return url ? [url] : [];
  }));
}

function tenderValue(input: DuplicateOpportunityFacts, field: string): string {
  const value = input.tenderData?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
}

function noticeNumbers(input: DuplicateOpportunityFacts): Set<string> {
  // Source-local contractNumber/procedureNumber are not universal notice IDs.
  return new Set(NOTICE_FIELDS.map((field) => tenderValue(input, field)).filter(Boolean));
}

function queryValues(url: URL, keys: Set<string>): Set<string> {
  return new Set([...url.searchParams].filter(([key]) => keys.has(key.toLowerCase())).map(([, value]) => text(value)).filter(Boolean));
}

function tenderConflict(left: DuplicateOpportunityFacts, right: DuplicateOpportunityFacts, leftUrls: Set<string>, rightUrls: Set<string>): string | null {
  const leftLot = tenderValue(left, 'lotNumber');
  const rightLot = tenderValue(right, 'lotNumber');
  if (leftLot && rightLot && leftLot !== rightLot) return 'different_tender_lot_numbers';
  const leftNotices = noticeNumbers(left);
  const rightNotices = noticeNumbers(right);
  if (leftNotices.size && rightNotices.size && !intersects(leftNotices, rightNotices)) return 'different_tender_notice_numbers';
  const leftProcedures = new Set(['procedureNumber', 'contractNumber'].map((field) => tenderValue(left, field)).filter(Boolean));
  const rightProcedures = new Set(['procedureNumber', 'contractNumber'].map((field) => tenderValue(right, field)).filter(Boolean));
  const platform = tenderValue(left, 'platform');
  const samePlatform = !!platform && platform === tenderValue(right, 'platform');
  if ((samePlatform || intersects(leftUrls, rightUrls)) && leftProcedures.size && rightProcedures.size && !intersects(leftProcedures, rightProcedures)) return 'different_tender_procedure_numbers';
  for (const [keys, reason] of [[LOT_QUERY_KEYS, 'different_tender_lot_url_values'], [NOTICE_QUERY_KEYS, 'different_tender_notice_url_values']] as const) {
    for (const leftUrl of leftUrls) for (const rightUrl of rightUrls) {
      const a = new URL(leftUrl);
      const b = new URL(rightUrl);
      if (a.origin !== b.origin || a.pathname !== b.pathname) continue;
      // A native lot ID and a displayed lot number need not be the same value.
      // Compare only the same explicit query key, never invent that relation.
      for (const key of new Set([...a.searchParams.keys(), ...b.searchParams.keys()])) {
        if (!keys.has(key.toLowerCase())) continue;
        const valuesA = new Set(a.searchParams.getAll(key).map(text).filter(Boolean));
        const valuesB = new Set(b.searchParams.getAll(key).map(text).filter(Boolean));
        if (valuesA.size && valuesB.size && !intersects(valuesA, valuesB)) return reason;
      }
    }
  }
  return null;
}

function knownSameLot(left: DuplicateOpportunityFacts, right: DuplicateOpportunityFacts, sharedUrls: string[]): boolean {
  const lot = tenderValue(left, 'lotNumber');
  if (lot && lot === tenderValue(right, 'lotNumber')) return true;
  return sharedUrls.some((url) => queryValues(new URL(url), LOT_QUERY_KEYS).size > 0);
}

function automaticMergeBlockers(left: DuplicateOpportunityFacts, right: DuplicateOpportunityFacts, reliableBodies: boolean, bodyConflict: boolean, tender: boolean, sharedUrls: string[]): string[] {
  const blockers: string[] = [];
  const sourcesA = identities(left);
  const sourcesB = identities(right);
  if (!sourcesA.size || !sourcesB.size || ![...sourcesA.keys()].some((source) => !sourcesB.has(source)) && ![...sourcesB.keys()].some((source) => !sourcesA.has(source))) blockers.push('different_sources_unverified');
  if ([...sourcesA.keys()].some((source) => sourcesB.has(source))) blockers.push('shared_source_identity_unverified');
  if (!reliableBodies) blockers.push('reliable_description_missing');
  if (bodyConflict) blockers.push('descriptions_incompatible');
  // Text alone cannot prove which lot of a procedure is being mirrored.
  if (tender && (!knownSameLot(left, right, sharedUrls) || !intersects(noticeNumbers(left), noticeNumbers(right)))) blockers.push('tender_notice_and_lot_identity_unverified');
  return blockers;
}

function tokens(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+(?:[+#]+)?/gu) ?? [];
}

function reliableBody(value: string): boolean {
  const words = tokens(value);
  return value.length >= 160 && words.length >= 20 && new Set(words).size >= 12;
}

function similarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (value: string): Set<string> => new Set(Array.from({ length: Math.max(0, value.length - 2) }, (_, index) => value.slice(index, index + 3)));
  return 0.65 * dice(new Set(tokens(left)), new Set(tokens(right))) + 0.35 * dice(grams(left), grams(right));
}

function dice(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  return 2 * [...left].filter((value) => right.has(value)).length / (left.size + right.size);
}

function incompatibleTitleFacts(left: string, right: string): string | null {
  const wordsA = new Set(tokens(left));
  const wordsB = new Set(tokens(right));
  for (const [predicate, reason] of [
    [(word: string) => /\d/u.test(word), 'different_title_numbers'],
  ] as const) {
    const a = new Set([...wordsA].filter(predicate));
    const b = new Set([...wordsB].filter(predicate));
    if (a.size && b.size && !intersects(a, b)) return reason;
  }
  const techA = technologies(left);
  const techB = technologies(right);
  if (techA.size && techB.size && !intersects(techA, techB)) return 'different_title_technologies';
  const seniority = (words: Set<string>): Set<string> => new Set([
    ['junior', 'младший'], ['middle', 'mid', 'средний'], ['senior', 'старший'], ['lead', 'ведущий'],
  ].flatMap((group) => group.some((word) => words.has(word)) ? [group[0]] : []));
  const a = seniority(wordsA);
  const b = seniority(wordsB);
  return a.size && b.size && !intersects(a, b) ? 'different_title_seniority' : null;
}

function incompatibleBodyFacts(left: string, right: string): boolean {
  const techA = technologies(left);
  const techB = technologies(right);
  if (techA.size && techB.size && (techA.size !== techB.size || ![...techA].every(fact => techB.has(fact)))) return true;
  const facts = (value: string): Set<string> => new Set(tokens(value).filter((word) => /\d/u.test(word) || ['c++', 'c#'].includes(word)));
  const a = facts(left);
  const b = facts(right);
  if (a.size && b.size && (a.size !== b.size || ![...a].every((fact) => b.has(fact)))) return true;
  const negations = (value: string): Set<string> => {
    const words = tokens(value);
    return new Set(words.flatMap((word, index) => ['not', 'no', 'never', 'не', 'нет', 'без'].includes(word) ? [words.slice(index, index + 4).join(' ')] : []));
  };
  const negationsA = negations(left);
  const negationsB = negations(right);
  return negationsA.size !== negationsB.size || ![...negationsA].every((fact) => negationsB.has(fact));
}

function technologies(value: string): Set<string> {
  return new Set(tokens(value).flatMap(word => TECHNOLOGY_ALIASES[word] ? [TECHNOLOGY_ALIASES[word]] : []));
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((value) => right.has(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isBareHomepage(value: string): boolean {
  const url = new URL(value);
  return url.pathname === '/' && !url.search;
}

// L4 reuses these exact deterministic guards; embeddings cannot relax them.
export {
  publishedDay as duplicatePublicationDay,
  reliableBody as duplicateReliableBody,
  incompatibleTitleFacts as duplicateTitleConflict,
  incompatibleBodyFacts as duplicateBodyConflict,
  automaticMergeBlockers as duplicateAutomaticMergeBlockers,
};
