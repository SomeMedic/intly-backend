import { createHash } from 'node:crypto';

import type { BuiltinListingCriteria, BuiltinTaxonomy } from './builtin-listing-contract';
import { assertBuiltinCriteriaContinuation, validatedBuiltinCriteria } from './builtin-listing-contract';

const FRONTIER_VERSION = 1;
const BUILTIN_ORIGIN = 'https://builtin.com';
const BASE_QUERY = 'city=&state=&country=USA&allLocations=true';
const MAX_PARTITIONS = 4096;
const LEGACY_PARTITION_ID = 'legacy';

export type BuiltinFrontierPartitionStatus = 'Pending' | 'Complete' | 'Unresolved';
export type BuiltinFrontierPartitionKind =
  | 'baseline'
  | 'category'
  | 'subcategory'
  | 'category_experience'
  | 'subcategory_experience'
  | 'category_experience_remote'
  | 'subcategory_experience_remote'
  | 'legacy';

export type BuiltinTaxonomySnapshot = {
  categories: { id: number; alias: string }[];
  subCategories: { id: number; categoryId: number; alias: string }[];
  experiences: { alias: string; filterValue: string }[];
  remotePreferences?: { id: number; alias: string }[];
};

export type BuiltinFrontierPartition = {
  id: string;
  kind: BuiltinFrontierPartitionKind;
  status: BuiltinFrontierPartitionStatus;
  currentListUrl: string | null;
  nextListUrl: string | null;
  parentId: string | null;
  expectedCriteria: BuiltinListingCriteria;
  observedCriteria: BuiltinListingCriteria | null;
  lastFinalUrl: string | null;
  lastPageNumber: number;
  maxObservedPage: number;
  observedPages: number;
  observedNativeIds: number;
  capObserved: boolean;
  childrenCreated: boolean;
  unresolvedLeafCap: boolean;
  lastNativeIdsFingerprint: string | null;
  lastPageFingerprint: string | null;
  suspendedReason: string | null;
};

export type BuiltinFrontier = {
  version: 1;
  nativeContractRevision?: 1;
  taxonomySha256: string;
  taxonomy: BuiltinTaxonomySnapshot;
  order: string[];
  cursor: number;
  partitions: Record<string, BuiltinFrontierPartition>;
};

export type BuiltinFrontierLegacyInput = {
  baseUrl?: string;
  currentListUrl?: string;
  nextListUrl?: string | null;
  listingCriteria?: BuiltinListingCriteria | null;
  maxObservedPage?: number | null;
  criteriaVerifiedFromStart?: boolean;
};

export type BuiltinFrontierObservation = {
  requestedUrl: string;
  finalUrl: string;
  criteria: BuiltinListingCriteria;
  nativeIds: string[];
  nextListUrl?: string | null;
  maxObservedPage?: number | null;
  terminal?: boolean;
  verifiedEmpty?: boolean;
};

export type BuiltinFrontierSummary = {
  total: number;
  pending: number;
  complete: number;
  unresolved: number;
  capped: number;
  unresolvedLeafCaps: number;
  observedPages: number;
  observedNativeIds: number;
  coverageComplete: boolean;
  scopedTraversalExhausted: boolean;
};

export function createBuiltinFrontier(taxonomy: BuiltinTaxonomy, legacy?: BuiltinFrontierLegacyInput | null): BuiltinFrontier {
  const snapshot = validatedTaxonomySnapshot(taxonomy);
  const partitions: Record<string, BuiltinFrontierPartition> = {};
  const order: string[] = [];

  const add = (partition: BuiltinFrontierPartition): void => {
    addPartition(partitions, order, partition);
  };

  add(makePartition({
    id: 'baseline',
    kind: 'baseline',
    currentListUrl: canonicalJobsUrl(),
    parentId: null,
    expectedCriteria: expectedCriteria({ categoryId: null }),
  }));

  for (const category of snapshot.categories) {
    add(makePartition({
      id: categoryPartitionId(category.id),
      kind: 'category',
      currentListUrl: canonicalJobsUrl(category.alias),
      parentId: 'baseline',
      expectedCriteria: expectedCriteria({ categoryId: category.id }),
    }));
  }

  if (legacy?.currentListUrl || legacy?.nextListUrl) {
    const currentListUrl = legacy.nextListUrl || legacy.currentListUrl || canonicalUrl(legacy.baseUrl || canonicalJobsUrl());
    const observedCriteria = legacy.listingCriteria ? validatedBuiltinCriteria(legacy.listingCriteria) : null;
    const partition = makePartition({
      id: LEGACY_PARTITION_ID,
      kind: 'legacy',
      currentListUrl: canonicalUrl(currentListUrl),
      nextListUrl: legacy.nextListUrl ? canonicalUrl(legacy.nextListUrl) : null,
      parentId: null,
      expectedCriteria: observedCriteria || expectedCriteria({ categoryId: null }),
      observedCriteria,
      lastPageNumber: legacy.nextListUrl ? Math.max(0, urlPage(legacy.nextListUrl) - 1) : (observedCriteria ? criteriaPage(observedCriteria) : urlPage(currentListUrl)),
      maxObservedPage: positiveIntegerOrZero(legacy.maxObservedPage),
    });
    if (!legacy.nextListUrl) {
      partition.status = 'Complete';
      partition.currentListUrl = null;
    }
    add(partition);
  }

  return {
    version: FRONTIER_VERSION,
    nativeContractRevision: 1,
    taxonomySha256: taxonomySha256(snapshot),
    taxonomy: snapshot,
    order,
    cursor: 0,
    partitions,
  };
}

export function validatedBuiltinFrontier(raw: unknown): BuiltinFrontier {
  if (!isPlainRecord(raw)) throw new Error('Built In frontier is not an object');
  if (raw.version !== FRONTIER_VERSION) throw new Error(`Built In frontier has unsupported version ${String(raw.version)}`);
  if (raw.nativeContractRevision !== undefined && raw.nativeContractRevision !== 1) throw new Error('Built In frontier has unsupported native contract revision');
  const taxonomy = validatedTaxonomySnapshot(raw.taxonomy);
  const taxonomyHash = stringField(raw.taxonomySha256, 'taxonomySha256');
  const actualHash = taxonomySha256(taxonomy);
  if (taxonomyHash !== actualHash) throw new Error('Built In frontier taxonomy hash does not match state taxonomy');
  if (!Array.isArray(raw.order)) throw new Error('Built In frontier order is not an array');
  if (!isPlainRecord(raw.partitions)) throw new Error('Built In frontier partitions is not an object');
  const order = raw.order.map((id, index) => stringField(id, `order[${index}]`));
  assertUnique(order, 'frontier order id');
  if (order.length > MAX_PARTITIONS) throw new Error(`Built In frontier exceeds ${MAX_PARTITIONS} partitions`);
  const partitions: Record<string, BuiltinFrontierPartition> = {};
  for (const [id, value] of Object.entries(raw.partitions)) {
    partitions[id] = validatedPartition(id, value);
  }
  if (Object.keys(partitions).length !== order.length) throw new Error('Built In frontier order does not cover every partition');
  for (const id of order) {
    if (!Object.hasOwn(partitions, id)) throw new Error(`Built In frontier order references missing partition ${id}`);
  }
  validatePartitionGraph(taxonomy, order, partitions);
  const cursor = integerField(raw.cursor, 'cursor');
  if (cursor < 0 || cursor > Math.max(order.length, 1)) throw new Error('Built In frontier cursor is out of range');
  return deepClone({ version: FRONTIER_VERSION, ...(raw.nativeContractRevision === 1 ? { nativeContractRevision: 1 as const } : {}), taxonomySha256: taxonomyHash, taxonomy, order, cursor, partitions });
}

export function refineBuiltinFrontier(frontier: BuiltinFrontier, taxonomy: BuiltinTaxonomy): BuiltinFrontier {
  const state = validatedBuiltinFrontier(frontier);
  const native = validatedTaxonomySnapshot(taxonomy);
  const core = ({ categories, subCategories, experiences }: BuiltinTaxonomySnapshot): BuiltinTaxonomySnapshot => ({ categories, subCategories, experiences });
  if (taxonomySha256(core(state.taxonomy)) !== taxonomySha256(core(native))) throw new Error('Built In frontier taxonomy changed since the frontier was created');
  if (state.taxonomy.remotePreferences && taxonomySha256(state.taxonomy) !== taxonomySha256(native)) throw new Error('Built In frontier remote taxonomy changed since the frontier was created');
  const originalNextId = nextBuiltinPartition(state)?.id;
  const originalOrder = [...state.order];
  const retryIds = state.nativeContractRevision === 1 ? [] : originalOrder.filter((id) => state.partitions[id].status === 'Unresolved' && state.partitions[id].suspendedReason === 'unverified-native-empty');
  state.taxonomy = native;
  state.taxonomySha256 = taxonomySha256(native);
  for (const id of originalOrder) {
    const partition = state.partitions[id];
    if (partition.capObserved && (partition.kind === 'category_experience' || partition.kind === 'subcategory_experience')) expandRemotePartitions(state, partition);
  }
  if (state.nativeContractRevision !== 1) {
    for (const id of retryIds) {
      state.partitions[id].status = 'Pending';
      state.partitions[id].suspendedReason = null;
    }
    // Keep the prior next pointer and the cyclic order of all existing pending work.
    // Previously unresolved first pages are retried after that round and new remote seeds.
    const anchor = originalNextId ? originalOrder.indexOf(originalNextId) : 0;
    const orderedExisting = [...originalOrder.slice(anchor), ...originalOrder.slice(0, anchor)].filter((id) => !retryIds.includes(id));
    const addedIds = state.order.filter((id) => !originalOrder.includes(id));
    state.order = [...orderedExisting, ...addedIds, ...retryIds];
    state.cursor = 0;
    state.nativeContractRevision = 1;
  }
  return validatedBuiltinFrontier(state);
}

export function assertBuiltinFrontierTaxonomy(frontier: BuiltinFrontier, taxonomy: BuiltinTaxonomy): void {
  const restored = validatedBuiltinFrontier(frontier);
  const expected = taxonomySha256(validatedTaxonomySnapshot(taxonomy));
  if (restored.taxonomySha256 !== expected) throw new Error('Built In frontier taxonomy changed since the frontier was created');
}

export function nextBuiltinPartition(frontier: BuiltinFrontier): BuiltinFrontierPartition | null {
  const state = validatedBuiltinFrontier(frontier);
  if (state.order.length === 0) return null;
  for (let offset = 0; offset < state.order.length; offset += 1) {
    const index = (state.cursor + offset) % state.order.length;
    const partition = state.partitions[state.order[index]];
    if (partition?.status === 'Pending' && partition.currentListUrl) return deepClone(partition);
  }
  return null;
}

export function recordBuiltinPartition(frontier: BuiltinFrontier, partitionId: string, observation: BuiltinFrontierObservation): BuiltinFrontier {
  const state = validatedBuiltinFrontier(frontier);
  const partition = state.partitions[partitionId];
  if (!partition) throw new Error(`Built In frontier partition is missing: ${partitionId}`);
  if (partition.status !== 'Pending') throw new Error(`Built In frontier partition ${partitionId} is ${partition.status}`);
  if (!partition.currentListUrl) throw new Error(`Built In frontier partition ${partitionId} has no current URL`);
  const requestedUrl = canonicalUrl(observation.requestedUrl);
  if (requestedUrl !== partition.currentListUrl) {
    throw new Error(`Built In frontier requested URL drifted for ${partitionId}: ${requestedUrl} !== ${partition.currentListUrl}`);
  }

  const criteria = validatedBuiltinCriteria(observation.criteria);
  assertExpectedCriteria(partition, criteria);
  if (partition.observedCriteria) {
    assertBuiltinCriteriaContinuation(partition.observedCriteria, criteria);
  }
  const pageNumber = criteriaPage(criteria);
  if (urlPage(requestedUrl) !== pageNumber) {
    throw new Error(`Built In frontier requested URL page drifted for ${partitionId}`);
  }
  const expectedPage = partition.lastPageNumber + 1;
  if (pageNumber !== expectedPage) {
    throw new Error(`Built In frontier page drifted for ${partitionId}: expected ${expectedPage}, got ${pageNumber}`);
  }

  const ids = validatedNativeIds(observation.nativeIds);
  if (ids.length === 0 && !(observation.verifiedEmpty === true && observation.terminal === true && !observation.nextListUrl && pageNumber === 1 && partition.observedPages === 0 && !partition.capObserved && positiveIntegerOrZero(observation.maxObservedPage) <= 1)) {
    throw new Error(`Built In frontier partition ${partitionId} has an empty native ID page without verified first-page terminal evidence`);
  }
  const nativeIdsFingerprint = stableSha256([...ids].sort());
  const finalUrl = canonicalUrl(observation.finalUrl);
  const finalScope = listingScopeKey(finalUrl);
  if (finalScope !== listingScopeKey(partition.currentListUrl)) {
    throw new Error(`Built In frontier final URL scope drifted for ${partitionId}`);
  }
  if (urlPage(finalUrl) !== pageNumber) {
    throw new Error(`Built In frontier final URL page drifted for ${partitionId}`);
  }
  const nextListUrl = observation.nextListUrl ? canonicalUrl(observation.nextListUrl) : null;
  if (observation.terminal && nextListUrl) throw new Error(`Built In frontier terminal observation still has a next URL for ${partitionId}`);
  if (nextListUrl && listingScopeKey(nextListUrl) !== finalScope) {
    throw new Error(`Built In frontier next URL scope drifted for ${partitionId}`);
  }
  if (nextListUrl && urlPage(nextListUrl) !== pageNumber + 1) {
    throw new Error(`Built In frontier next URL page drifted for ${partitionId}`);
  }
  if (partition.lastNativeIdsFingerprint && partition.lastNativeIdsFingerprint === nativeIdsFingerprint) {
    partition.status = 'Unresolved';
    partition.suspendedReason = 'repeated-native-page-fingerprint';
    advanceCursor(state, partitionId);
    return deepClone(state);
  }

  const observedMaxPage = positiveIntegerOrZero(observation.maxObservedPage);
  const maxObservedPage = Math.max(partition.maxObservedPage, observedMaxPage, pageNumber);
  const capObserved = partition.capObserved || maxObservedPage >= 1000;
  partition.observedCriteria = deepClone(criteria);
  partition.lastFinalUrl = finalUrl;
  partition.lastPageNumber = pageNumber;
  partition.maxObservedPage = maxObservedPage;
  partition.observedPages += 1;
  partition.observedNativeIds += ids.length;
  partition.capObserved = capObserved;
  partition.lastNativeIdsFingerprint = nativeIdsFingerprint;
  partition.lastPageFingerprint = pageFingerprint(finalUrl, criteria, ids);
  partition.nextListUrl = nextListUrl;
  partition.currentListUrl = nextListUrl;

  if (capObserved) expandCappedPartition(state, partition);

  if (observation.terminal || !nextListUrl) {
    partition.status = 'Complete';
    partition.currentListUrl = null;
  }

  advanceCursor(state, partitionId);
  return deepClone(state);
}

export function suspendBuiltinPartition(frontier: BuiltinFrontier, partitionId: string, reason: string): BuiltinFrontier {
  const state = validatedBuiltinFrontier(frontier);
  const partition = state.partitions[partitionId];
  if (!partition) throw new Error(`Built In frontier partition is missing: ${partitionId}`);
  if (partition.status !== 'Pending') throw new Error(`Built In frontier partition ${partitionId} is ${partition.status}`);
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('Built In frontier suspend reason is empty');
  partition.status = 'Unresolved';
  partition.suspendedReason = trimmed;
  advanceCursor(state, partitionId);
  return deepClone(state);
}

export function builtinFrontierSummary(frontier: BuiltinFrontier): BuiltinFrontierSummary {
  const state = validatedBuiltinFrontier(frontier);
  const partitions = Object.values(state.partitions);
  const unresolved = partitions.filter((partition) => partition.status === 'Unresolved').length;
  const pending = partitions.filter((partition) => partition.status === 'Pending').length;
  return {
    total: partitions.length,
    pending,
    complete: partitions.filter((partition) => partition.status === 'Complete').length,
    unresolved,
    capped: partitions.filter((partition) => partition.capObserved).length,
    unresolvedLeafCaps: partitions.filter((partition) => partition.unresolvedLeafCap).length,
    observedPages: partitions.reduce((sum, partition) => sum + partition.observedPages, 0),
    observedNativeIds: partitions.reduce((sum, partition) => sum + partition.observedNativeIds, 0),
    coverageComplete: false,
    scopedTraversalExhausted: pending === 0 && unresolved === 0 && partitions.every((partition) => !partition.unresolvedLeafCap && !partition.capObserved),
  };
}

function expandCappedPartition(state: BuiltinFrontier, partition: BuiltinFrontierPartition): void {
  if (partition.kind === 'category_experience' || partition.kind === 'subcategory_experience') {
    expandRemotePartitions(state, partition);
    return;
  }
  if (partition.childrenCreated) return;
  partition.childrenCreated = true;

  if (partition.kind === 'category') {
    const categoryId = numberCriteria(partition.expectedCriteria.categories, 'categories');
    const category = state.taxonomy.categories.find((item) => item.id === categoryId);
    if (!category) throw new Error(`Built In frontier category ${categoryId} missing from taxonomy`);
    const childrenBefore = state.order.length;
    for (const subCategory of state.taxonomy.subCategories.filter((item) => item.categoryId === categoryId)) {
      addPartition(state.partitions, state.order, makePartition({
        id: subCategoryPartitionId(categoryId, subCategory.id),
        kind: 'subcategory',
        currentListUrl: canonicalJobsUrl(category.alias, subCategory.alias),
        parentId: partition.id,
        expectedCriteria: expectedCriteria({ categoryId, subCategoryId: String(subCategory.id) }),
      }));
    }
    for (const experience of state.taxonomy.experiences) {
      addPartition(state.partitions, state.order, makePartition({
        id: categoryExperiencePartitionId(categoryId, experience.alias),
        kind: 'category_experience',
        currentListUrl: canonicalJobsUrl(category.alias, experience.alias),
        parentId: partition.id,
        expectedCriteria: expectedCriteria({ categoryId, experience: experience.filterValue }),
      }));
    }
    if (state.order.length === childrenBefore) partition.unresolvedLeafCap = true;
    return;
  }

  if (partition.kind === 'subcategory') {
    const categoryId = numberCriteria(partition.expectedCriteria.categories, 'categories');
    const subCategoryId = numericCriteria(partition.expectedCriteria.subCategories, 'subCategories');
    const category = state.taxonomy.categories.find((item) => item.id === categoryId);
    const subCategory = state.taxonomy.subCategories.find((item) => item.id === subCategoryId && item.categoryId === categoryId);
    if (!category || !subCategory) throw new Error(`Built In frontier subcategory ${categoryId}/${subCategoryId} missing from taxonomy`);
    const childrenBefore = state.order.length;
    for (const experience of state.taxonomy.experiences) {
      addPartition(state.partitions, state.order, makePartition({
        id: subCategoryExperiencePartitionId(categoryId, subCategoryId, experience.alias),
        kind: 'subcategory_experience',
        currentListUrl: canonicalJobsUrl(category.alias, subCategory.alias, experience.alias),
        parentId: partition.id,
        expectedCriteria: expectedCriteria({ categoryId, subCategoryId: String(subCategoryId), experience: experience.filterValue }),
      }));
    }
    if (state.order.length === childrenBefore) partition.unresolvedLeafCap = true;
    return;
  }

  if (partition.kind === 'category_experience_remote' || partition.kind === 'subcategory_experience_remote') {
    partition.unresolvedLeafCap = true;
  }
}

function expandRemotePartitions(state: BuiltinFrontier, partition: BuiltinFrontierPartition): void {
  const categoryId = numericCriteria(partition.expectedCriteria.categories, 'categories');
  const category = state.taxonomy.categories.find((item) => item.id === categoryId);
  const experience = state.taxonomy.experiences.find((item) => item.filterValue === partition.expectedCriteria.experiences);
  if (!category || !experience) throw new Error(`Built In frontier capped experience ${partition.id} missing from taxonomy`);
  const subCategory = partition.kind === 'subcategory_experience'
    ? state.taxonomy.subCategories.find((item) => item.categoryId === categoryId && String(item.id) === partition.expectedCriteria.subCategories)
    : undefined;
  if (partition.kind === 'subcategory_experience' && !subCategory) throw new Error(`Built In frontier capped subcategory ${partition.id} missing from taxonomy`);
  for (const remote of state.taxonomy.remotePreferences ?? []) {
    const id = remoteExperiencePartitionId(categoryId, subCategory?.id, experience.alias, remote.id);
    if (Object.hasOwn(state.partitions, id)) continue;
    addPartition(state.partitions, state.order, makePartition({
      id,
      kind: subCategory ? 'subcategory_experience_remote' : 'category_experience_remote',
      currentListUrl: canonicalJobsUrl(remote.alias, category.alias, ...(subCategory ? [subCategory.alias] : []), experience.alias),
      parentId: partition.id,
      expectedCriteria: expectedCriteria({ categoryId, subCategoryId: subCategory ? String(subCategory.id) : undefined, experience: experience.filterValue, remotePreferenceId: String(remote.id) }),
    }));
  }
  partition.childrenCreated = true;
  // The public UI exposes no separate missing-work-mode filter. Keep that residual
  // and the capped parent explicit even when every observed remote child finishes.
  partition.unresolvedLeafCap = true;
}

function addPartition(
  partitions: Record<string, BuiltinFrontierPartition>,
  order: string[],
  partition: BuiltinFrontierPartition,
): void {
  if (Object.hasOwn(partitions, partition.id)) throw new Error(`Built In frontier duplicate partition ${partition.id}`);
  if (order.length >= MAX_PARTITIONS) throw new Error(`Built In frontier exceeds ${MAX_PARTITIONS} partitions`);
  partitions[partition.id] = partition;
  order.push(partition.id);
}

function makePartition(input: {
  id: string;
  kind: BuiltinFrontierPartitionKind;
  currentListUrl: string;
  parentId: string | null;
  expectedCriteria: BuiltinListingCriteria;
  nextListUrl?: string | null;
  observedCriteria?: BuiltinListingCriteria | null;
  lastPageNumber?: number;
  maxObservedPage?: number;
}): BuiltinFrontierPartition {
  return {
    id: input.id,
    kind: input.kind,
    status: 'Pending',
    currentListUrl: canonicalUrl(input.currentListUrl),
    nextListUrl: input.nextListUrl ? canonicalUrl(input.nextListUrl) : null,
    parentId: input.parentId,
    expectedCriteria: deepClone(input.expectedCriteria),
    observedCriteria: input.observedCriteria ? deepClone(input.observedCriteria) : null,
    lastFinalUrl: null,
    lastPageNumber: input.lastPageNumber ?? 0,
    maxObservedPage: input.maxObservedPage ?? 0,
    observedPages: 0,
    observedNativeIds: 0,
    capObserved: false,
    childrenCreated: false,
    unresolvedLeafCap: false,
    lastNativeIdsFingerprint: null,
    lastPageFingerprint: null,
    suspendedReason: null,
  };
}

function validatedPartition(id: string, value: unknown): BuiltinFrontierPartition {
  if (!isPlainRecord(value)) throw new Error(`Built In frontier partition ${id} is not an object`);
  if (value.id !== id) throw new Error(`Built In frontier partition key ${id} does not match its id`);
  const status = enumField(value.status, ['Pending', 'Complete', 'Unresolved'], `partition ${id} status`);
  const kind = enumField(value.kind, ['baseline', 'category', 'subcategory', 'category_experience', 'subcategory_experience', 'category_experience_remote', 'subcategory_experience_remote', 'legacy'], `partition ${id} kind`);
  const partition: BuiltinFrontierPartition = {
    id,
    kind,
    status,
    currentListUrl: nullableUrl(value.currentListUrl, `partition ${id} currentListUrl`),
    nextListUrl: nullableUrl(value.nextListUrl, `partition ${id} nextListUrl`),
    parentId: nullableString(value.parentId, `partition ${id} parentId`),
    expectedCriteria: validatedBuiltinCriteria(value.expectedCriteria),
    observedCriteria: value.observedCriteria === null ? null : validatedBuiltinCriteria(value.observedCriteria),
    lastFinalUrl: nullableUrl(value.lastFinalUrl, `partition ${id} lastFinalUrl`),
    lastPageNumber: nonNegativeIntegerField(value.lastPageNumber, `partition ${id} lastPageNumber`),
    maxObservedPage: nonNegativeIntegerField(value.maxObservedPage, `partition ${id} maxObservedPage`),
    observedPages: nonNegativeIntegerField(value.observedPages, `partition ${id} observedPages`),
    observedNativeIds: nonNegativeIntegerField(value.observedNativeIds, `partition ${id} observedNativeIds`),
    capObserved: booleanField(value.capObserved, `partition ${id} capObserved`),
    childrenCreated: booleanField(value.childrenCreated, `partition ${id} childrenCreated`),
    unresolvedLeafCap: booleanField(value.unresolvedLeafCap, `partition ${id} unresolvedLeafCap`),
    lastNativeIdsFingerprint: nullableString(value.lastNativeIdsFingerprint, `partition ${id} lastNativeIdsFingerprint`),
    lastPageFingerprint: nullableString(value.lastPageFingerprint, `partition ${id} lastPageFingerprint`),
    suspendedReason: nullableString(value.suspendedReason, `partition ${id} suspendedReason`),
  };
  if (partition.status === 'Pending' && !partition.currentListUrl) throw new Error(`Built In frontier pending partition ${id} has no current URL`);
  if (partition.status === 'Complete' && partition.currentListUrl !== null) throw new Error(`Built In frontier complete partition ${id} still has current URL`);
  if (partition.status === 'Complete' && partition.nextListUrl !== null) throw new Error(`Built In frontier complete partition ${id} still has next URL`);
  if (partition.status === 'Unresolved' && !partition.suspendedReason) throw new Error(`Built In frontier unresolved partition ${id} has no reason`);
  return partition;
}

function assertExpectedCriteria(partition: BuiltinFrontierPartition, criteria: BuiltinListingCriteria): void {
  if (partition.kind === 'legacy') {
    if (partition.observedCriteria) assertBuiltinCriteriaContinuation(partition.observedCriteria, criteria);
    return;
  }
  const expected = partition.expectedCriteria;
  for (const key of Object.keys(expected)) {
    if (key === 'pageNumber') continue;
    if (criteria[key] !== expected[key]) {
      throw new Error(`Built In frontier criteria drifted for ${partition.id} at ${key}: ${String(criteria[key])} !== ${String(expected[key])}`);
    }
  }
}

function expectedCriteria(input: { categoryId: number | null; subCategoryId?: string; experience?: string; remotePreferenceId?: string }): BuiltinListingCriteria {
  return {
    remotePreferences: input.remotePreferenceId ?? null,
    companySizes: null,
    categories: input.categoryId,
    subCategories: input.subCategoryId ?? null,
    experiences: input.experience ?? null,
    industry: null,
    pageSize: 10,
    pageNumber: 1,
    search: null,
    isNational: true,
    isElite: false,
    isJobsBoard: true,
    searchArea: null,
    companyId: null,
    siteId: null,
    daysSinceUpdated: null,
    earlyApplicant: false,
    skills: null,
    city: null,
    state: null,
    country: 'USA',
    longitude: null,
    latitude: null,
    allLocations: true,
    industryCategoryIds: null,
  };
}

function canonicalJobsUrl(...pathParts: string[]): string {
  const path = ['jobs', ...pathParts.map((part) => encodeURIComponent(part))].join('/');
  return `${BUILTIN_ORIGIN}/${path}?${BASE_QUERY}`;
}

function canonicalUrl(value: string): string {
  const url = new URL(value, BUILTIN_ORIGIN);
  if (url.origin !== BUILTIN_ORIGIN) throw new Error(`Built In frontier URL is outside builtin.com: ${value}`);
  if (!url.pathname.startsWith('/jobs')) throw new Error(`Built In frontier URL is not a jobs listing: ${value}`);
  return url.toString();
}

function listingScopeKey(value: string): string {
  const url = new URL(canonicalUrl(value));
  url.searchParams.delete('page');
  const params = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
  return `${url.pathname}?${new URLSearchParams(params).toString()}`;
}

function urlPage(value: string): number {
  const raw = new URL(canonicalUrl(value)).searchParams.get('page');
  if (raw === null) return 1;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1) throw new Error(`Built In frontier URL has invalid page ${raw}`);
  return page;
}

function criteriaPage(criteria: BuiltinListingCriteria): number {
  return numberCriteria(criteria.pageNumber, 'pageNumber');
}

function validatedNativeIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Built In frontier native IDs is not an array');
  const ids = value.map((item, index) => {
    if (typeof item !== 'string' || !/^\d+$/.test(item)) throw new Error(`Built In frontier native ID ${index} is invalid`);
    return item;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Built In frontier page has duplicate native IDs');
  return ids;
}

function pageFingerprint(finalUrl: string, criteria: BuiltinListingCriteria, nativeIds: string[]): string {
  return stableSha256([listingScopeKey(finalUrl), criteria.pageNumber, [...nativeIds].sort()]);
}

function stableSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function taxonomySha256(taxonomy: BuiltinTaxonomySnapshot): string {
  return stableSha256(taxonomy);
}

function validatedTaxonomySnapshot(value: unknown): BuiltinTaxonomySnapshot {
  if (!isPlainRecord(value)) throw new Error('Built In taxonomy is not an object');
  const categories = arrayField(value.categories, 'categories').map((item, index) => {
    if (!isPlainRecord(item)) throw new Error(`Built In taxonomy category ${index} is not an object`);
    return { id: positiveIntegerField(item.id, `category ${index} id`), alias: slugField(item.alias, `category ${index} alias`) };
  });
  const subCategories = arrayField(value.subCategories, 'subCategories').map((item, index) => {
    if (!isPlainRecord(item)) throw new Error(`Built In taxonomy subCategory ${index} is not an object`);
    return {
      id: positiveIntegerField(item.id, `subCategory ${index} id`),
      categoryId: positiveIntegerField(item.categoryId, `subCategory ${index} categoryId`),
      alias: slugField(item.alias, `subCategory ${index} alias`),
    };
  });
  const experiences = arrayField(value.experiences, 'experiences').map((item, index) => {
    if (!isPlainRecord(item)) throw new Error(`Built In taxonomy experience ${index} is not an object`);
    return {
      alias: slugField(item.alias, `experience ${index} alias`),
      filterValue: stringField(item.filterValue, `experience ${index} filterValue`),
    };
  });
  const remotePreferences = value.remotePreferences === undefined ? undefined : arrayField(value.remotePreferences, 'remotePreferences').map((item, index) => {
    if (!isPlainRecord(item)) throw new Error(`Built In taxonomy remotePreference ${index} is not an object`);
    return { id: positiveIntegerField(item.id, `remotePreference ${index} id`), alias: slugField(item.alias, `remotePreference ${index} alias`) };
  });

  if (categories.length === 0) throw new Error('Built In taxonomy has no categories');
  if (experiences.length === 0) throw new Error('Built In taxonomy has no experiences');
  assertUnique(categories.map((item) => String(item.id)), 'category id');
  assertUnique(categories.map((item) => item.alias), 'category alias');
  assertUnique(subCategories.map((item) => String(item.id)), 'subCategory id');
  assertUnique(subCategories.map((item) => `${item.categoryId}:${item.alias}`), 'subCategory alias');
  assertUnique(experiences.map((item) => item.alias), 'experience alias');
  assertUnique(experiences.map((item) => item.filterValue), 'experience filterValue');
  assertUnique((remotePreferences ?? []).map((item) => String(item.id)), 'remotePreference id');
  assertUnique((remotePreferences ?? []).map((item) => item.alias), 'remotePreference alias');
  const categoryIds = new Set(categories.map((item) => item.id));
  for (const subCategory of subCategories) {
    if (!categoryIds.has(subCategory.categoryId)) throw new Error(`Built In taxonomy subCategory ${subCategory.id} references missing category ${subCategory.categoryId}`);
  }
  return { categories, subCategories, experiences, ...(remotePreferences === undefined ? {} : { remotePreferences }) };
}

function validatePartitionGraph(
  taxonomy: BuiltinTaxonomySnapshot,
  order: string[],
  partitions: Record<string, BuiltinFrontierPartition>,
): void {
  const categoryById = new Map(taxonomy.categories.map((category) => [category.id, category]));
  const subCategoryByKey = new Map(taxonomy.subCategories.map((subCategory) => [`${subCategory.categoryId}:${subCategory.id}`, subCategory]));
  const experienceByFilterValue = new Map(taxonomy.experiences.map((experience) => [experience.filterValue, experience]));
  const remoteById = new Map((taxonomy.remotePreferences ?? []).map((remote) => [remote.id, remote]));
  if (!Object.hasOwn(partitions, 'baseline')) throw new Error('Built In frontier is missing baseline partition');
  for (const category of taxonomy.categories) {
    if (!Object.hasOwn(partitions, categoryPartitionId(category.id))) {
      throw new Error(`Built In frontier is missing category seed ${category.id}`);
    }
  }
  for (const id of order) {
    const partition = partitions[id];
    if (!partition) throw new Error(`Built In frontier missing ordered partition ${id}`);
    if (partition.kind !== 'legacy' && !expectedPartitionId(partition, categoryById, subCategoryByKey, experienceByFilterValue, remoteById)) {
      throw new Error(`Built In frontier partition ${id} does not match taxonomy or expected criteria`);
    }
    if (partition.parentId !== null && !Object.hasOwn(partitions, partition.parentId)) {
      throw new Error(`Built In frontier partition ${id} references missing parent ${partition.parentId}`);
    }
    if (partition.kind === 'baseline' && partition.parentId !== null) throw new Error('Built In frontier baseline has a parent');
    if (partition.kind === 'category' && partition.parentId !== 'baseline') throw new Error(`Built In frontier category ${id} has invalid parent`);
    if ((partition.kind === 'subcategory' || partition.kind === 'category_experience') && !/^category:\d+$/.test(partition.parentId ?? '')) {
      throw new Error(`Built In frontier partition ${id} has invalid category parent`);
    }
    if (partition.kind === 'subcategory_experience' && !/^subcategory:\d+:\d+$/.test(partition.parentId ?? '')) {
      throw new Error(`Built In frontier partition ${id} has invalid subcategory parent`);
    }
    if (partition.kind === 'category_experience_remote' || partition.kind === 'subcategory_experience_remote') {
      const categoryId = numericCriteria(partition.expectedCriteria.categories, 'categories');
      const experienceAlias = experienceAliasByFilterValue(partition, stringField(partition.expectedCriteria.experiences, 'experiences'), experienceByFilterValue);
      const expectedParent = partition.kind === 'category_experience_remote'
        ? categoryExperiencePartitionId(categoryId, experienceAlias)
        : subCategoryExperiencePartitionId(categoryId, numericCriteria(partition.expectedCriteria.subCategories, 'subCategories'), experienceAlias);
      if (partition.parentId !== expectedParent) throw new Error(`Built In frontier partition ${id} has invalid remote parent`);
    }
    if (partition.currentListUrl && partition.kind !== 'legacy' && listingScopeKey(partition.currentListUrl) !== listingScopeKey(expectedUrlForPartition(partition, categoryById, subCategoryByKey, experienceByFilterValue, remoteById))) {
      throw new Error(`Built In frontier partition ${id} URL does not match taxonomy`);
    }
  }
}

function expectedPartitionId(
  partition: BuiltinFrontierPartition,
  categoryById: Map<number, { id: number; alias: string }>,
  subCategoryByKey: Map<string, { id: number; categoryId: number; alias: string }>,
  experienceByFilterValue: Map<string, { alias: string; filterValue: string }>,
  remoteById: Map<number, { id: number; alias: string }>,
): boolean {
  const remoteKind = partition.kind === 'category_experience_remote' || partition.kind === 'subcategory_experience_remote';
  if (!remoteKind && partition.expectedCriteria.remotePreferences !== null) return false;
  if (partition.kind === 'baseline') return partition.id === 'baseline' && partition.expectedCriteria.categories === null;
  const categoryId = numericCriteria(partition.expectedCriteria.categories, 'categories');
  if (!categoryById.has(categoryId)) return false;
  if (partition.kind === 'category') return partition.id === categoryPartitionId(categoryId) && partition.expectedCriteria.subCategories === null && partition.expectedCriteria.experiences === null;
  if (partition.kind === 'subcategory') {
    const subCategoryId = numericCriteria(partition.expectedCriteria.subCategories, 'subCategories');
    return partition.id === subCategoryPartitionId(categoryId, subCategoryId) && subCategoryByKey.has(`${categoryId}:${subCategoryId}`) && partition.expectedCriteria.experiences === null;
  }
  const experience = partition.expectedCriteria.experiences;
  if (typeof experience !== 'string') return false;
  const experienceAlias = experienceAliasByFilterValue(partition, experience, experienceByFilterValue);
  if (partition.kind === 'category_experience') return partition.id === categoryExperiencePartitionId(categoryId, experienceAlias);
  if (remoteKind) {
    const remoteId = numericCriteria(partition.expectedCriteria.remotePreferences, 'remotePreferences');
    if (!remoteById.has(remoteId)) return false;
    const subCategoryId = partition.kind === 'subcategory_experience_remote' ? numericCriteria(partition.expectedCriteria.subCategories, 'subCategories') : undefined;
    return partition.id === remoteExperiencePartitionId(categoryId, subCategoryId, experienceAlias, remoteId)
      && (subCategoryId === undefined ? partition.expectedCriteria.subCategories === null : subCategoryByKey.has(`${categoryId}:${subCategoryId}`));
  }
  const subCategoryId = numericCriteria(partition.expectedCriteria.subCategories, 'subCategories');
  return partition.id === subCategoryExperiencePartitionId(categoryId, subCategoryId, experienceAlias) && subCategoryByKey.has(`${categoryId}:${subCategoryId}`);
}

function expectedUrlForPartition(
  partition: BuiltinFrontierPartition,
  categoryById: Map<number, { id: number; alias: string }>,
  subCategoryByKey: Map<string, { id: number; categoryId: number; alias: string }>,
  experienceByFilterValue: Map<string, { alias: string; filterValue: string }>,
  remoteById: Map<number, { id: number; alias: string }>,
): string {
  if (partition.kind === 'baseline') return canonicalJobsUrl();
  const categoryId = numericCriteria(partition.expectedCriteria.categories, 'categories');
  const category = categoryById.get(categoryId);
  if (!category) throw new Error(`Built In frontier category ${categoryId} missing from taxonomy`);
  if (partition.kind === 'category') return canonicalJobsUrl(category.alias);
  if (partition.kind === 'subcategory') {
    const subCategoryId = numericCriteria(partition.expectedCriteria.subCategories, 'subCategories');
    const subCategory = subCategoryByKey.get(`${categoryId}:${subCategoryId}`);
    if (!subCategory) throw new Error(`Built In frontier subcategory ${categoryId}/${subCategoryId} missing from taxonomy`);
    return canonicalJobsUrl(category.alias, subCategory.alias);
  }
  const experienceAlias = experienceAliasByFilterValue(partition, stringField(partition.expectedCriteria.experiences, 'experiences'), experienceByFilterValue);
  if (partition.kind === 'category_experience') return canonicalJobsUrl(category.alias, experienceAlias);
  const remoteParts: string[] = [];
  if (partition.kind === 'category_experience_remote' || partition.kind === 'subcategory_experience_remote') {
    const remoteId = numericCriteria(partition.expectedCriteria.remotePreferences, 'remotePreferences');
    const remote = remoteById.get(remoteId);
    if (!remote) throw new Error(`Built In frontier remotePreference ${remoteId} missing from taxonomy`);
    remoteParts.push(remote.alias);
    if (partition.kind === 'category_experience_remote') return canonicalJobsUrl(...remoteParts, category.alias, experienceAlias);
  }
  const subCategoryId = numericCriteria(partition.expectedCriteria.subCategories, 'subCategories');
  const subCategory = subCategoryByKey.get(`${categoryId}:${subCategoryId}`);
  if (!subCategory) throw new Error(`Built In frontier subcategory ${categoryId}/${subCategoryId} missing from taxonomy`);
  return canonicalJobsUrl(...remoteParts, category.alias, subCategory.alias, experienceAlias);
}

function experienceAliasByFilterValue(
  partition: BuiltinFrontierPartition,
  filterValue: string,
  experienceByFilterValue: Map<string, { alias: string; filterValue: string }>,
): string {
  const experience = experienceByFilterValue.get(filterValue);
  if (!experience) throw new Error(`Built In frontier partition ${partition.id} has unknown experience ${filterValue}`);
  return experience.alias;
}

function advanceCursor(state: BuiltinFrontier, partitionId: string): void {
  const index = state.order.indexOf(partitionId);
  if (index >= 0) state.cursor = state.order.length === 0 ? 0 : (index + 1) % state.order.length;
}

function categoryPartitionId(categoryId: number): string {
  return `category:${categoryId}`;
}

function subCategoryPartitionId(categoryId: number, subCategoryId: number): string {
  return `subcategory:${categoryId}:${subCategoryId}`;
}

function categoryExperiencePartitionId(categoryId: number, experienceAlias: string): string {
  return `category-experience:${categoryId}:${experienceAlias}`;
}

function subCategoryExperiencePartitionId(categoryId: number, subCategoryId: number, experienceAlias: string): string {
  return `subcategory-experience:${categoryId}:${subCategoryId}:${experienceAlias}`;
}

function remoteExperiencePartitionId(categoryId: number, subCategoryId: number | undefined, experienceAlias: string, remoteId: number): string {
  return subCategoryId === undefined
    ? `category-experience-remote:${categoryId}:${experienceAlias}:${remoteId}`
    : `subcategory-experience-remote:${categoryId}:${subCategoryId}:${experienceAlias}:${remoteId}`;
}

function numberCriteria(value: string | number | boolean | null, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`Built In frontier criteria has invalid ${label}`);
  return value;
}

function numericCriteria(value: string | number | boolean | null, label: string): number {
  if (typeof value === 'number') return numberCriteria(value, label);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new Error(`Built In frontier criteria has invalid ${label}`);
}

function positiveIntegerOrZero(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error('Built In frontier observed page must be a non-negative integer');
  return value as number;
}

function arrayField(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Built In taxonomy ${label} is not an array`);
  return value;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Built In frontier ${label} is invalid`);
  return value;
}

function slugField(value: unknown, label: string): string {
  const slug = stringField(value, label);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`Built In frontier ${label} is not a slug`);
  return slug;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return stringField(value, label);
}

function nullableUrl(value: unknown, label: string): string | null {
  if (value === null) return null;
  return canonicalUrl(stringField(value, label));
}

function integerField(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`Built In frontier ${label} is not an integer`);
  return value as number;
}

function nonNegativeIntegerField(value: unknown, label: string): number {
  const integer = integerField(value, label);
  if (integer < 0) throw new Error(`Built In frontier ${label} is negative`);
  return integer;
}

function positiveIntegerField(value: unknown, label: string): number {
  const integer = integerField(value, label);
  if (integer < 1) throw new Error(`Built In frontier ${label} is not positive`);
  return integer;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Built In frontier ${label} is not boolean`);
  return value;
}

function enumField<const T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`Built In frontier ${label} is invalid`);
  return value as T;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Built In taxonomy has duplicate ${label}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
