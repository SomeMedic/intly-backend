import { load } from 'cheerio';

export type BuiltinListingCriteria = Record<string, string | number | boolean | null>;
export type BuiltinTaxonomy = {
  categories: { id: number; alias: string }[];
  subCategories: { id: number; categoryId: number; alias: string }[];
  experiences: { alias: string; filterValue: string }[];
  remotePreferences?: { id: number; alias: string }[];
};

const BUILTIN_ORIGIN = 'https://builtin.com';
const INIT_CALL = 'Builtin.jobBoardInit(';
const SUPPORTED_DAYS = new Set([1, 3, 7, 30]);
const SUPPORTED_QUERY_KEYS = new Set(['page', 'daysSinceUpdated', 'city', 'state', 'country', 'allLocations']);
const REQUIRED_CRITERIA_KEYS = [
  'remotePreferences',
  'companySizes',
  'categories',
  'subCategories',
  'experiences',
  'industry',
  'pageSize',
  'pageNumber',
  'search',
  'isNational',
  'isElite',
  'isJobsBoard',
  'searchArea',
  'companyId',
  'siteId',
  'daysSinceUpdated',
  'earlyApplicant',
  'skills',
  'city',
  'state',
  'country',
  'longitude',
  'latitude',
  'allLocations',
  'industryCategoryIds',
] as const;

type BuiltinInitPayload = {
  criteria?: unknown;
  categoriesFilterOptions?: unknown;
  subCategoriesFilterOptions?: unknown;
  experiencesFilterOptions?: unknown;
  remotePreferenceFilterOptions?: unknown;
};

export function builtinListingCriteria(html: string, finalUrl: string): BuiltinListingCriteria {
  const payload = parseSingleJobBoardInit(html);
  const criteria = normalizeCriteria(payload.criteria, 'Built In listing criteria');
  validateCriteriaShape(criteria);
  validateUrlContract(criteria, payload, finalUrl);
  return criteria;
}

export function builtinListingTaxonomy(html: string): BuiltinTaxonomy | undefined {
  return taxonomyFromPayload(parseSingleJobBoardInit(html));
}

export function builtinListingIsVerifiedEmpty(html: string, finalUrl: string): boolean {
  // This positive server template was observed on a native first-page zero-result response.
  // Missing cards, facet counts, or a generic error message do not establish emptiness.
  let criteria: BuiltinListingCriteria;
  try {
    criteria = builtinListingCriteria(html, finalUrl);
  } catch {
    return false;
  }
  if (criteria.pageNumber !== 1) return false;
  const $ = load(html);
  const list = $('#jobs-list');
  if (list.length !== 1 || $('[id^="job-card-"]').length > 0 || list.find('a[href*="/job/"]').length > 0) return false;
  const headings = list.find('h1');
  if (headings.length !== 1 || headings.text().replace(/\s+/g, ' ').trim() !== 'No job results. To see more jobs, try:') return false;
  if (list.find('#expand-area-link').length !== 1) return false;
  if (!list.find('span').toArray().some((element) => $(element).text().trim() === 'Adjusting other filters')) return false;
  if (!list.find('a[href="/jobs"]').toArray().some((element) => $(element).text().trim() === 'Reset all')) return false;
  if ($('a[href]').toArray().some((element) => {
    try {
      const url = new URL($(element).attr('href') ?? '', finalUrl);
      return url.origin === BUILTIN_ORIGIN && url.pathname.startsWith('/jobs') && url.searchParams.has('page');
    } catch {
      return false;
    }
  })) return false;
  const facets = list.find('script#jobsListServerData[type="application/json"]');
  if (facets.length !== 1) return false;
  try {
    const data: unknown = JSON.parse(facets.text());
    return Array.isArray(data) && data.every((item) => isPlainRecord(item) && typeof item.skill === 'string' && typeof item.count === 'number' && Number.isFinite(item.count) && item.count >= 0);
  } catch {
    return false;
  }
}

export function validatedBuiltinCriteria(value: unknown): BuiltinListingCriteria {
  const criteria = normalizeCriteria(value, 'Built In checkpoint listing criteria');
  validateCriteriaShape(criteria);
  return criteria;
}

export function assertBuiltinCriteriaContinuation(before: BuiltinListingCriteria, after: BuiltinListingCriteria): void {
  const left = validatedBuiltinCriteria(before);
  const right = validatedBuiltinCriteria(after);
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.join('\u0000') !== rightKeys.join('\u0000')) {
    throw new Error(`Built In listing criteria drifted: key set changed from ${leftKeys.join(',')} to ${rightKeys.join(',')}`);
  }
  for (const key of leftKeys) {
    if (key === 'pageNumber') continue;
    if (left[key] !== right[key]) {
      throw new Error(`Built In listing criteria drifted at ${key}: ${String(left[key])} -> ${String(right[key])}`);
    }
  }
}

function parseSingleJobBoardInit(html: string): BuiltinInitPayload {
  const matches: unknown[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const callIndex = html.indexOf(INIT_CALL, cursor);
    if (callIndex === -1) break;
    let objectStart = callIndex + INIT_CALL.length;
    while (/\s/.test(html[objectStart] ?? '')) objectStart += 1;
    const objectText = balancedJsonObject(html, objectStart);
    try {
      matches.push(JSON.parse(objectText));
    } catch {
      throw new Error('Built In listing has malformed jobBoardInit JSON');
    }
    cursor = objectStart + objectText.length;
  }
  if (matches.length === 0) throw new Error('Built In listing has no jobBoardInit contract');
  if (matches.length > 1) throw new Error('Built In listing has ambiguous jobBoardInit contracts');
  const payload = matches[0];
  if (!isPlainRecord(payload)) throw new Error('Built In jobBoardInit payload is not an object');
  return payload as BuiltinInitPayload;
}

function balancedJsonObject(text: string, start: number): string {
  if (text[start] !== '{') throw new Error('Built In jobBoardInit argument is not a JSON object');
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
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) break;
    }
  }
  throw new Error('Built In jobBoardInit JSON object is not balanced');
}

function normalizeCriteria(value: unknown, label: string): BuiltinListingCriteria {
  if (!isPlainRecord(value)) throw new Error(`${label} is not an object`);
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    if (raw === '') {
      return [key, null];
    } else if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') {
      return [key, raw];
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      return [key, raw];
    } else {
      throw new Error(`${label} has non-scalar field ${key}`);
    }
  }));
}

function validateCriteriaShape(criteria: BuiltinListingCriteria): void {
  for (const key of REQUIRED_CRITERIA_KEYS) {
    if (!Object.hasOwn(criteria, key)) throw new Error(`Built In listing criteria is missing ${key}`);
  }
  if (!positiveInteger(criteria.pageSize)) throw new Error('Built In listing criteria has invalid pageSize');
  if (!positiveInteger(criteria.pageNumber)) throw new Error('Built In listing criteria has invalid pageNumber');
  if (typeof criteria.country !== 'string' || criteria.country.length === 0) throw new Error('Built In listing criteria has invalid country');
  if (criteria.search !== null && typeof criteria.search !== 'string') throw new Error('Built In listing criteria has invalid search');
  if (criteria.categories !== null && !positiveInteger(criteria.categories)) throw new Error('Built In listing criteria has invalid categories');
  validateSingleCsv(criteria.subCategories, 'subCategories', /^\d+$/);
  validateSingleCsv(criteria.experiences, 'experiences');
  validateSingleCsv(criteria.remotePreferences, 'remotePreferences', /^\d+$/);
  if (criteria.daysSinceUpdated !== null && (!positiveInteger(criteria.daysSinceUpdated) || !SUPPORTED_DAYS.has(criteria.daysSinceUpdated as number))) {
    throw new Error('Built In listing criteria has unsupported daysSinceUpdated');
  }
}

function validateUrlContract(criteria: BuiltinListingCriteria, payload: BuiltinInitPayload, finalUrl: string): void {
  const url = builtinUrl(finalUrl);
  const taxonomy = taxonomyFromPayload(payload);
  for (const key of url.searchParams.keys()) {
    if (!SUPPORTED_QUERY_KEYS.has(key)) throw new Error(`Built In listing URL filter ${key} is not supported by the guarded contract`);
    if (url.searchParams.getAll(key).length > 1) throw new Error('Built In listing URL has ambiguous repeated filters');
  }
  if (url.searchParams.has('page') && !positiveInteger(Number(url.searchParams.get('page')))) throw new Error('Built In listing URL has invalid page');
  const urlPage = Number(url.searchParams.get('page') ?? 1);
  if (criteria.pageNumber !== urlPage) throw new Error(`Built In listing pageNumber ${criteria.pageNumber} does not match URL page ${urlPage}`);

  const daysParam = url.searchParams.get('daysSinceUpdated');
  if (daysParam === null) {
    if (criteria.daysSinceUpdated !== null) throw new Error('Built In listing reflected daysSinceUpdated without a supported URL filter');
  } else {
    const days = Number(daysParam);
    if (!SUPPORTED_DAYS.has(days)) throw new Error(`Built In listing URL uses unsupported daysSinceUpdated ${daysParam}`);
    if (criteria.daysSinceUpdated !== days) throw new Error(`Built In listing daysSinceUpdated ${criteria.daysSinceUpdated} does not match URL ${days}`);
  }

  for (const key of ['city', 'state', 'country']) {
    const requested = url.searchParams.get(key);
    if (requested !== null && criteria[key] !== (requested || null)) throw new Error(`Built In listing ${key} does not match URL filter`);
  }
  const allLocations = url.searchParams.get('allLocations');
  if (allLocations !== null && (allLocations !== 'true' || criteria.allLocations !== true)) throw new Error('Built In listing allLocations does not match the confirmed URL filter');

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'jobs') throw new Error(`Built In listing path is unsupported: ${url.pathname}`);
  const remote = taxonomy?.remotePreferences?.find((option) => option.alias === parts[1]);
  if (remote) {
    if (categoryForSlug(payload, parts[1], taxonomy)) throw new Error(`Built In listing remote path is ambiguous: ${parts[1]}`);
    if (criteria.remotePreferences !== String(remote.id)) throw new Error('Built In listing remotePreferences does not match path');
    parts.splice(1, 1);
  } else if (criteria.remotePreferences !== null) {
    throw new Error('Built In listing reflected unexpected remotePreferences without a native path');
  }
  if (parts.length === 1) {
    if (criteria.categories !== null) throw new Error('Built In bare /jobs reflected a category');
    assertReflectedSubCategory(criteria, null);
    assertReflectedExperience(criteria, null);
    if (criteria.city !== null && !url.searchParams.has('city')) throw new Error('Built In bare /jobs reflected a city');
    return;
  }
  if (parts.length === 2) {
    assertCategoryPath(criteria, payload, parts[1], taxonomy);
    assertReflectedSubCategory(criteria, null);
    assertReflectedExperience(criteria, null);
    if (criteria.city !== null && !url.searchParams.has('city')) throw new Error('Built In category listing reflected an unexpected city');
    return;
  }
  if (parts.length === 3) {
    const category = categoryForSlug(payload, parts[1], taxonomy);
    if (category !== undefined) {
      assertCategoryPath(criteria, payload, parts[1], taxonomy);
      assertPartitionPath(criteria, taxonomy, category.id, parts[2], undefined);
      if (criteria.city !== null && !url.searchParams.has('city')) throw new Error('Built In partition listing reflected an unexpected city');
      return;
    }
    assertCategoryPath(criteria, payload, parts[2], taxonomy);
    assertReflectedSubCategory(criteria, null);
    assertReflectedExperience(criteria, null);
    if (typeof criteria.city !== 'string' || slug(criteria.city) !== parts[1]) {
      throw new Error(`Built In city category listing city does not match path ${parts[1]}`);
    }
    return;
  }
  if (parts.length === 4) {
    const category = assertCategoryPath(criteria, payload, parts[1], taxonomy);
    assertPartitionPath(criteria, taxonomy, category.id, parts[2], parts[3]);
    if (criteria.city !== null && !url.searchParams.has('city')) throw new Error('Built In partition listing reflected an unexpected city');
    return;
  }
  throw new Error(`Built In listing path is unsupported: ${url.pathname}`);
}

function assertCategoryPath(criteria: BuiltinListingCriteria, payload: BuiltinInitPayload, pathSlug: string, taxonomy?: BuiltinTaxonomy): { id: number; alias: string } {
  const category = categoryForSlug(payload, pathSlug, taxonomy);
  if (category === undefined) throw new Error(`Built In listing category path is not reflected in filter options: ${pathSlug}`);
  if (criteria.categories !== category.id) throw new Error(`Built In listing category ${criteria.categories} does not match path ${pathSlug}`);
  return category;
}

function assertPartitionPath(criteria: BuiltinListingCriteria, taxonomy: BuiltinTaxonomy | undefined, categoryId: number, firstSlug: string, secondSlug: string | undefined): void {
  if (taxonomy === undefined) throw new Error('Built In listing partition path has no native taxonomy contract');
  assertUnsupportedNativeFiltersEmpty(criteria);
  const subCategory = subCategoryForSlug(taxonomy, categoryId, firstSlug);
  const experience = experienceForSlug(taxonomy, firstSlug);
  if (secondSlug === undefined) {
    if (subCategory !== undefined && experience !== undefined) throw new Error(`Built In listing partition path is ambiguous: ${firstSlug}`);
    if (subCategory !== undefined) {
      assertReflectedSubCategory(criteria, String(subCategory.id));
      assertReflectedExperience(criteria, null);
      return;
    }
    if (experience !== undefined) {
      assertReflectedSubCategory(criteria, null);
      assertReflectedExperience(criteria, experience.filterValue);
      return;
    }
    throw new Error(`Built In listing partition path is not reflected in taxonomy: ${firstSlug}`);
  }
  if (subCategory === undefined) throw new Error(`Built In listing subCategory path is not reflected in taxonomy: ${firstSlug}`);
  const selectedExperience = experienceForSlug(taxonomy, secondSlug);
  if (selectedExperience === undefined) throw new Error(`Built In listing experience path is not reflected in taxonomy: ${secondSlug}`);
  assertReflectedSubCategory(criteria, String(subCategory.id));
  assertReflectedExperience(criteria, selectedExperience.filterValue);
}

function assertReflectedSubCategory(criteria: BuiltinListingCriteria, expected: string | null): void {
  if (criteria.subCategories !== expected) {
    throw new Error(`Built In listing subCategories ${String(criteria.subCategories)} does not match path ${String(expected)}`);
  }
}

function assertReflectedExperience(criteria: BuiltinListingCriteria, expected: string | null): void {
  if (criteria.experiences !== expected) {
    throw new Error(`Built In listing experiences ${String(criteria.experiences)} does not match path ${String(expected)}`);
  }
}

function assertUnsupportedNativeFiltersEmpty(criteria: BuiltinListingCriteria): void {
  for (const key of ['companySizes', 'industry', 'industryCategoryIds', 'skills', 'search', 'searchArea']) {
    if (criteria[key] !== null) throw new Error(`Built In listing partition reflected unsupported ${key} filter`);
  }
  if (criteria.earlyApplicant !== false) throw new Error('Built In listing partition reflected unsupported earlyApplicant filter');
  if (criteria.companyId !== null) throw new Error('Built In listing partition reflected unsupported companyId filter');
  if (criteria.siteId !== null) throw new Error('Built In listing partition reflected unsupported siteId filter');
}

function categoryForSlug(payload: BuiltinInitPayload, pathSlug: string, taxonomy?: BuiltinTaxonomy): { id: number; alias: string } | undefined {
  if (taxonomy !== undefined) {
    const matches = taxonomy.categories.filter((option) => option.alias === pathSlug);
    if (matches.length > 1) throw new Error(`Built In listing category path is ambiguous: ${pathSlug}`);
    if (matches.length === 1) return matches[0];
  }
  const categoryId = categoryIdForSlug(payload.categoriesFilterOptions, pathSlug);
  return categoryId === undefined ? undefined : { id: categoryId, alias: pathSlug };
}

function categoryIdForSlug(value: unknown, pathSlug: string): number | undefined {
  if (!Array.isArray(value)) throw new Error('Built In listing has no category filter options');
  let matched: number | undefined;
  for (const option of value) {
    if (!isPlainRecord(option)) continue;
    const id = option.id;
    if (!positiveInteger(id)) continue;
    const aliases = [option.urlName, option.alias].filter((item): item is string => typeof item === 'string');
    if (!aliases.includes(pathSlug)) continue;
    if (matched !== undefined && matched !== id) throw new Error(`Built In listing category path is ambiguous: ${pathSlug}`);
    matched = id;
  }
  return matched;
}

function subCategoryForSlug(taxonomy: BuiltinTaxonomy, categoryId: number, pathSlug: string): { id: number; categoryId: number; alias: string } | undefined {
  const matches = taxonomy.subCategories.filter((option) => option.categoryId === categoryId && option.alias === pathSlug);
  if (matches.length > 1) throw new Error(`Built In listing subCategory path is ambiguous: ${pathSlug}`);
  return matches[0];
}

function experienceForSlug(taxonomy: BuiltinTaxonomy, pathSlug: string): { alias: string; filterValue: string } | undefined {
  const matches = taxonomy.experiences.filter((option) => option.alias === pathSlug);
  if (matches.length > 1) throw new Error(`Built In listing experience path is ambiguous: ${pathSlug}`);
  return matches[0];
}

function taxonomyFromPayload(payload: BuiltinInitPayload): BuiltinTaxonomy | undefined {
  const hasSubCategories = Object.hasOwn(payload, 'subCategoriesFilterOptions');
  const hasExperiences = Object.hasOwn(payload, 'experiencesFilterOptions');
  if (!hasSubCategories && !hasExperiences) return undefined;
  if (!hasSubCategories || !hasExperiences) throw new Error('Built In listing taxonomy contract is incomplete');
  const categories = taxonomyCategories(payload.categoriesFilterOptions);
  const subCategories = taxonomySubCategories(payload.subCategoriesFilterOptions, categories);
  const experiences = taxonomyExperiences(payload.experiencesFilterOptions);
  const remotePreferences = payload.remotePreferenceFilterOptions === undefined ? undefined : taxonomyCategories(payload.remotePreferenceFilterOptions);
  return { categories, subCategories, experiences, ...(remotePreferences === undefined ? {} : { remotePreferences }) };
}

function taxonomyCategories(value: unknown): BuiltinTaxonomy['categories'] {
  if (!Array.isArray(value)) throw new Error('Built In listing taxonomy has no category filter options');
  const seenIds = new Set<number>();
  const seenAliases = new Set<string>();
  return value.map((option) => {
    if (!isPlainRecord(option)) throw new Error('Built In listing taxonomy has malformed category option');
    const { id, alias } = option;
    if (!positiveInteger(id)) throw new Error('Built In listing taxonomy has invalid category id');
    if (typeof alias !== 'string' || alias.length === 0) throw new Error('Built In listing taxonomy has invalid category alias');
    if (seenIds.has(id)) throw new Error(`Built In listing taxonomy has duplicate category id ${id}`);
    if (seenAliases.has(alias)) throw new Error(`Built In listing taxonomy has duplicate category alias ${alias}`);
    seenIds.add(id);
    seenAliases.add(alias);
    return { id, alias };
  });
}

function taxonomySubCategories(value: unknown, categories: BuiltinTaxonomy['categories']): BuiltinTaxonomy['subCategories'] {
  if (!isPlainRecord(value)) throw new Error('Built In listing taxonomy has malformed subCategory options');
  const categoryIds = new Set(categories.map((category) => category.id));
  const seenIds = new Set<number>();
  const seenAliases = new Set<string>();
  const output: BuiltinTaxonomy['subCategories'] = [];
  for (const [categoryKey, options] of Object.entries(value)) {
    const categoryId = Number(categoryKey);
    if (!positiveInteger(categoryId) || !categoryIds.has(categoryId)) {
      throw new Error(`Built In listing taxonomy subCategory parent is invalid: ${categoryKey}`);
    }
    if (!Array.isArray(options)) throw new Error(`Built In listing taxonomy subCategory options are malformed for category ${categoryKey}`);
    for (const option of options) {
      if (!isPlainRecord(option)) throw new Error('Built In listing taxonomy has malformed subCategory option');
      const { id, alias } = option;
      if (!positiveInteger(id)) throw new Error('Built In listing taxonomy has invalid subCategory id');
      if (typeof alias !== 'string' || alias.length === 0) throw new Error('Built In listing taxonomy has invalid subCategory alias');
      if (seenIds.has(id)) throw new Error(`Built In listing taxonomy has duplicate subCategory id ${id}`);
      if (seenAliases.has(alias)) throw new Error(`Built In listing taxonomy has duplicate subCategory alias ${alias}`);
      seenIds.add(id);
      seenAliases.add(alias);
      output.push({ id, categoryId, alias });
    }
  }
  return output;
}

function taxonomyExperiences(value: unknown): BuiltinTaxonomy['experiences'] {
  if (!Array.isArray(value)) throw new Error('Built In listing taxonomy has malformed experience options');
  const seenAliases = new Set<string>();
  const seenValues = new Set<string>();
  return value.map((option) => {
    if (!isPlainRecord(option)) throw new Error('Built In listing taxonomy has malformed experience option');
    const { alias, filterValue } = option;
    if (typeof alias !== 'string' || alias.length === 0) throw new Error('Built In listing taxonomy has invalid experience alias');
    if (typeof filterValue !== 'string' || filterValue.length === 0) throw new Error('Built In listing taxonomy has invalid experience filterValue');
    if (seenAliases.has(alias)) throw new Error(`Built In listing taxonomy has duplicate experience alias ${alias}`);
    if (seenValues.has(filterValue)) throw new Error(`Built In listing taxonomy has duplicate experience filterValue ${filterValue}`);
    seenAliases.add(alias);
    seenValues.add(filterValue);
    return { alias, filterValue };
  });
}

function validateSingleCsv(value: BuiltinListingCriteria[string], key: string, pattern?: RegExp): void {
  if (value === null) return;
  if (typeof value !== 'string') throw new Error(`Built In listing criteria has invalid ${key}`);
  const parts = value.split(',').filter((part) => part.length > 0);
  if (parts.length > 1) throw new Error(`Built In listing criteria has unsupported multi-select ${key}`);
  if (pattern !== undefined && parts[0] !== undefined && !pattern.test(parts[0])) {
    throw new Error(`Built In listing criteria has invalid ${key}`);
  }
}

function builtinUrl(value: string): URL {
  const url = new URL(value, BUILTIN_ORIGIN);
  if (url.origin !== BUILTIN_ORIGIN) throw new Error(`Built In listing URL is outside builtin.com: ${value}`);
  return url;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
