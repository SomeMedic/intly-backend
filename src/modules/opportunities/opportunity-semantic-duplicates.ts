import { createHash } from 'node:crypto';

import {
  compareDuplicateOpportunities,
  duplicateAutomaticMergeBlockers,
  duplicateBodyConflict,
  duplicatePublicationDay,
  duplicateReliableBody,
  duplicateTitleConflict,
  normalizeDuplicateText,
} from './opportunity-deduplication';
import type { DuplicateDecision, DuplicateOpportunityFacts } from './opportunity-deduplication';

/**
 * Conservative, uncalibrated v1 cosine thresholds, not model probabilities.
 * Full title/body coverage is mandatory in BOTH directions: averaging a prefix
 * or hiding an unmatched tail cannot authorize a merge. Byte bounds prevent
 * the service's 8000-character cut, but tokenizer attestation is also required.
 * Guards, missing facts, stale hashes or incomplete evidence remain review.
 */
export const SEMANTIC_DUPLICATE_POLICY = Object.freeze({
  version: 'semantic-full-text-v1',
  planVersion: 'semantic-utf8-chunks-v1',
  chunkBytes: 512,
  maxChunksPerField: 128,
  maxDimension: 8192,
  maxPublicationGapDays: 2,
  duplicateTitleMinimum: 0.985,
  duplicateBodyMinimum: 0.97,
  duplicateBodyMean: 0.98,
  distinctTitleMaximum: 0.6,
  distinctBodyMaximum: 0.7,
});

// An explicit named stack disagreement remains review; vector proximity cannot
// decide that Java/Python, React/Angular or AWS/Azure facts are interchangeable.
const EXPLICIT_TECHNOLOGIES = [
  'c++', 'c#', 'java', 'javascript', 'typescript', 'python', 'ruby', 'php',
  'rust', 'golang', 'scala', 'swift', 'kotlin', 'objective-c', '.net',
  'react', 'angular', 'vue', 'django', 'rails', 'laravel', 'spring', 'node.js',
  'docker', 'kubernetes', 'terraform', 'postgresql', 'mysql', 'oracle', 'aws', 'azure', 'gcp',
].map((technology) => [technology, new RegExp(`(?:^|[^\\p{L}\\p{N}])${technology.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'u')] as const);

export type SemanticEmbeddingPlanOptions = {
  chunkBytes?: number;
  /** Must equal the actual EmbeddingsService passage prefix. */
  passagePrefix?: string;
};

export type SemanticTextChunk = {
  index: number;
  startByte: number;
  endByte: number;
  text: string;
  textHash: string;
  input: string;
  inputHash: string;
  inputUtf8Bytes: number;
};

export type SemanticEmbeddingPlan = {
  planVersion: string;
  factsHash: string;
  titleHash: string;
  descriptionHash: string;
  chunkBytes: number;
  passagePrefix: string;
  title: SemanticTextChunk[];
  description: SemanticTextChunk[];
};

export type SemanticEmbeddingMetadata = {
  model: string;
  version: string;
  dimension: number;
  inputHash: string;
  inputKind: 'passage';
  /** Actual tokenizer count including the prefix and special tokens. */
  inputTokenCount: number;
  /** Effective runtime token limit, not a guessed advertised context size. */
  maxInputTokens: number;
  /** Bytes of the entire effective prefixed input actually processed. */
  consumedInputUtf8Bytes: number;
  truncated: false;
  tokenizer: string;
  tokenizerVersion: string;
};

export type SemanticChunkEmbedding = Pick<SemanticTextChunk, 'index' | 'startByte' | 'endByte' | 'textHash'> & {
  vector: readonly number[];
  metadata: SemanticEmbeddingMetadata;
};

export type SemanticOpportunityEmbeddingEvidence = Pick<
  SemanticEmbeddingPlan,
  'planVersion' | 'factsHash' | 'titleHash' | 'descriptionHash' | 'chunkBytes' | 'passagePrefix'
> & {
  title: readonly SemanticChunkEmbedding[];
  description: readonly SemanticChunkEmbedding[];
};

export type SemanticDuplicateEvidence = {
  left: SemanticOpportunityEmbeddingEvidence;
  right: SemanticOpportunityEmbeddingEvidence;
};

export type SemanticDuplicateEligibility = {
  eligible: boolean;
  baseDecision: DuplicateDecision;
  factsHashes: { left: string | null; right: string | null };
  reasons: string[];
};

export type SemanticChunkMatch = { index: number; matchedIndex: number; cosine: number; bytes: number };
export type SemanticFieldComparison = {
  minimum: number;
  maximum: number;
  weightedMean: number;
  left: SemanticChunkMatch[];
  right: SemanticChunkMatch[];
};

export type SemanticComparisonAudit = {
  policyVersion: string;
  thresholds: typeof SEMANTIC_DUPLICATE_POLICY;
  model: string;
  version: string;
  dimension: number;
  tokenizer: string;
  tokenizerVersion: string;
  maxInputTokens: number;
  left: Omit<SemanticOpportunityEmbeddingEvidence, 'title' | 'description'> & {
    title: Array<Omit<SemanticChunkEmbedding, 'vector'>>;
    description: Array<Omit<SemanticChunkEmbedding, 'vector'>>;
  };
  right: Omit<SemanticOpportunityEmbeddingEvidence, 'title' | 'description'> & {
    title: Array<Omit<SemanticChunkEmbedding, 'vector'>>;
    description: Array<Omit<SemanticChunkEmbedding, 'vector'>>;
  };
  title: SemanticFieldComparison;
  description: SemanticFieldComparison;
};

export type SemanticDuplicateDecision = Omit<DuplicateDecision, 'level'> & {
  level: DuplicateDecision['level'] | 'semantic';
  semanticApplied: boolean;
  baseDecision: DuplicateDecision;
  factsHashes: SemanticDuplicateEligibility['factsHashes'];
  evidence: SemanticComparisonAudit | null;
};

/** One shared snapshot for candidate projections and transaction revalidation. */
export function semanticOpportunityFacts(input: DuplicateOpportunityFacts): DuplicateOpportunityFacts {
  const facts: Record<string, unknown> = {};
  for (const field of ['_id', 'type', 'title', 'companyOrClient', 'description', 'location'] as const) {
    if (input[field] !== null && input[field] !== undefined) facts[field] = input[field];
  }
  if (input.publishedAt !== null && input.publishedAt !== undefined) {
    facts.publishedAt = duplicatePublicationDay(input.publishedAt) !== null
      ? new Date(input.publishedAt instanceof Date ? input.publishedAt.getTime() : input.publishedAt)
      : input.publishedAt;
  }
  facts.tenderData = input.tenderData ?? {};
  facts.sourceOccurrences = (input.sourceOccurrences ?? []).map((occurrence) => Object.fromEntries(
    ['sourceId', 'externalId', 'url'].flatMap((field) => {
      const value = occurrence[field as 'sourceId' | 'externalId' | 'url'];
      return value !== null && value !== undefined ? [[field, value]] : [];
    }),
  ));
  return facts as DuplicateOpportunityFacts;
}

/** Complete relevant facts: no clipped body, raw credentials or unrelated state. */
export function semanticDuplicateFactHash(facts: DuplicateOpportunityFacts): string | null {
  try {
    return hash(JSON.stringify(stableValue(semanticOpportunityFacts(facts), new Set())));
  } catch {
    // Class instances, cycles and unsupported values are not silently omitted.
    return null;
  }
}

/** No tokenization/inference: the adapter must attest every planned segment. */
export function buildSemanticEmbeddingPlan(
  facts: DuplicateOpportunityFacts,
  options: SemanticEmbeddingPlanOptions = {},
): SemanticEmbeddingPlan | null {
  facts = semanticOpportunityFacts(facts);
  const factsHash = semanticDuplicateFactHash(facts);
  const chunkBytes = options.chunkBytes ?? SEMANTIC_DUPLICATE_POLICY.chunkBytes;
  const passagePrefix = options.passagePrefix ?? 'passage: ';
  if (!factsHash || !Number.isInteger(chunkBytes) || chunkBytes < 32 || chunkBytes > 2048) return null;
  if (typeof passagePrefix !== 'string' || Buffer.byteLength(passagePrefix) > 256 || !validUtf8(passagePrefix)) return null;
  const title = typeof facts.title === 'string' ? facts.title : '';
  const description = typeof facts.description === 'string' ? facts.description : '';
  if (!validUtf8(title) || !validUtf8(description)) return null;
  if (Buffer.byteLength(title) > chunkBytes * SEMANTIC_DUPLICATE_POLICY.maxChunksPerField || Buffer.byteLength(description) > chunkBytes * SEMANTIC_DUPLICATE_POLICY.maxChunksPerField) return null;
  const titleChunks = chunks(title, chunkBytes, passagePrefix);
  const bodyChunks = chunks(description, chunkBytes, passagePrefix);
  if (titleChunks.length > SEMANTIC_DUPLICATE_POLICY.maxChunksPerField || bodyChunks.length > SEMANTIC_DUPLICATE_POLICY.maxChunksPerField) return null;
  return {
    planVersion: SEMANTIC_DUPLICATE_POLICY.planVersion,
    factsHash, titleHash: hash(title), descriptionHash: hash(description),
    chunkBytes, passagePrefix, title: titleChunks, description: bodyChunks,
  };
}

export function semanticDuplicateEligibility(
  left: DuplicateOpportunityFacts,
  right: DuplicateOpportunityFacts,
  options: SemanticEmbeddingPlanOptions = {},
): SemanticDuplicateEligibility {
  left = semanticOpportunityFacts(left);
  right = semanticOpportunityFacts(right);
  const baseDecision = compareDuplicateOpportunities(left, right);
  const factsHashes = { left: semanticDuplicateFactHash(left), right: semanticDuplicateFactHash(right) };
  if (baseDecision.verdict !== 'ambiguous') return { eligible: false, baseDecision, factsHashes, reasons: ['semantic_only_for_ambiguous_candidates'] };
  const reasons: string[] = [];
  if (!factsHashes.left || !factsHashes.right) reasons.push('full_facts_not_serializable');
  if (!left.type || left.type !== right.type) reasons.push('opportunity_type_missing_or_incompatible');
  const leftTitle = normalized(left.title);
  const rightTitle = normalized(right.title);
  if (!leftTitle || !rightTitle) reasons.push('title_missing');
  const titleConflict = duplicateTitleConflict(leftTitle, rightTitle);
  if (titleConflict) reasons.push(titleConflict);
  if (technologyConflict(leftTitle, rightTitle)) reasons.push('explicit_title_technologies_incompatible');
  for (const [field, missing, conflict] of [
    ['companyOrClient', 'counterpart_missing', 'counterparts_incompatible'],
    ['location', 'location_missing', 'locations_incompatible'],
  ] as const) {
    const a = normalized(left[field]);
    const b = normalized(right[field]);
    if (!a || !b) reasons.push(missing);
    else if (a !== b) reasons.push(conflict);
  }
  const leftDay = duplicatePublicationDay(left.publishedAt);
  const rightDay = duplicatePublicationDay(right.publishedAt);
  if (leftDay === null || rightDay === null) reasons.push('publication_date_missing');
  else if (Math.abs(leftDay - rightDay) > SEMANTIC_DUPLICATE_POLICY.maxPublicationGapDays) reasons.push('publication_dates_not_close');
  const leftBody = normalized(left.description);
  const rightBody = normalized(right.description);
  const reliableBodies = duplicateReliableBody(leftBody) && duplicateReliableBody(rightBody);
  if (technologyConflict(leftBody, rightBody)) reasons.push('explicit_body_technologies_incompatible');
  reasons.push(...duplicateAutomaticMergeBlockers(
    left, right, reliableBodies, duplicateBodyConflict(leftBody, rightBody),
    left.type === 'tender' || right.type === 'tender', [],
  ));
  // Reuse all native/type/lot/date conflicts even if another earlier base reason
  // was chosen. Lexical similarity can change; explicit facts cannot.
  const lexicalReasons = new Set([
    'exact_fingerprint', 'exact_normalized_url', 'text_candidate_requires_review',
    'titles_not_similar_enough', 'descriptions_not_similar_enough', 'titles_incompatible',
  ]);
  reasons.push(...baseDecision.reasons.filter((reason) => !lexicalReasons.has(reason)));
  if (!buildSemanticEmbeddingPlan(left, options) || !buildSemanticEmbeddingPlan(right, options)) reasons.push('full_embedding_plan_unavailable');
  return { eligible: reasons.length === 0, baseDecision, factsHashes, reasons: [...new Set(reasons)] };
}

export function compareSemanticDuplicateOpportunities(
  left: DuplicateOpportunityFacts,
  right: DuplicateOpportunityFacts,
  evidence?: SemanticDuplicateEvidence | null,
): SemanticDuplicateDecision {
  left = semanticOpportunityFacts(left);
  right = semanticOpportunityFacts(right);
  const options = evidence?.left ? { chunkBytes: evidence.left.chunkBytes, passagePrefix: evidence.left.passagePrefix } : {};
  const eligibility = semanticDuplicateEligibility(left, right, options);
  const unchanged = (reasons: string[]): SemanticDuplicateDecision => ({
    ...eligibility.baseDecision, semanticApplied: false, baseDecision: eligibility.baseDecision,
    factsHashes: eligibility.factsHashes, evidence: null,
    reasons: [...new Set([...eligibility.baseDecision.reasons, ...reasons])],
  });
  if (!eligibility.eligible) return unchanged(eligibility.reasons);
  if (!evidence) return unchanged(['semantic_evidence_missing']);
  const leftPlan = buildSemanticEmbeddingPlan(left, options);
  const rightPlan = buildSemanticEmbeddingPlan(right, options);
  if (!leftPlan || !rightPlan) return unchanged(['full_embedding_plan_unavailable']);
  const errors = [
    ...validateEvidence(leftPlan, evidence.left),
    ...validateEvidence(rightPlan, evidence.right),
  ];
  if (errors.length) return unchanged([...new Set(errors)]);
  const embeddings = [...evidence.left.title, ...evidence.left.description, ...evidence.right.title, ...evidence.right.description];
  const metadata = embeddings[0].metadata;
  if (embeddings.some((entry) => modelIdentity(entry.metadata) !== modelIdentity(metadata))) return unchanged(['embedding_models_or_tokenizers_incompatible']);
  const title = compareField(evidence.left.title, evidence.right.title);
  const description = compareField(evidence.left.description, evidence.right.description);
  const audit: SemanticComparisonAudit = {
    policyVersion: SEMANTIC_DUPLICATE_POLICY.version, thresholds: SEMANTIC_DUPLICATE_POLICY,
    model: metadata.model, version: metadata.version, dimension: metadata.dimension,
    tokenizer: metadata.tokenizer, tokenizerVersion: metadata.tokenizerVersion,
    maxInputTokens: metadata.maxInputTokens, left: auditEvidence(evidence.left), right: auditEvidence(evidence.right),
    title, description,
  };
  const result = (verdict: DuplicateDecision['verdict'], confidence: number, reason: string): SemanticDuplicateDecision => ({
    verdict, level: 'semantic', confidence, reasons: [reason], semanticApplied: true,
    baseDecision: eligibility.baseDecision, factsHashes: eligibility.factsHashes, evidence: audit,
  });
  if (title.minimum >= SEMANTIC_DUPLICATE_POLICY.duplicateTitleMinimum && description.minimum >= SEMANTIC_DUPLICATE_POLICY.duplicateBodyMinimum && description.weightedMean >= SEMANTIC_DUPLICATE_POLICY.duplicateBodyMean) {
    return result('duplicate', Math.min(title.minimum, description.minimum, description.weightedMean), 'full_title_and_description_semantically_agree');
  }
  // Negative evidence is also full and bidirectional, never one bad prefix.
  if (title.maximum <= SEMANTIC_DUPLICATE_POLICY.distinctTitleMaximum && description.maximum <= SEMANTIC_DUPLICATE_POLICY.distinctBodyMaximum) {
    return result('distinct', 0.95, 'full_title_and_description_semantically_distinct');
  }
  return result('ambiguous', 0.85, 'semantic_evidence_requires_review');
}

/** Strict equal dimensions and finite, nonzero vectors; no common-prefix cosine. */
export function semanticCosineSimilarity(left: readonly number[], right: readonly number[]): number | null {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length || left.length > SEMANTIC_DUPLICATE_POLICY.maxDimension) return null;
  const unit = (vector: readonly number[]): number[] | null => {
    if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
    const scale = vector.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
    if (!scale) return null;
    const scaled = vector.map((value) => value / scale);
    const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
    return scaled.map((value) => value / norm);
  };
  const a = unit(left);
  const b = unit(right);
  if (!a || !b) return null;
  return Math.max(-1, Math.min(1, a.reduce((sum, value, index) => sum + value * b[index], 0)));
}

function validateEvidence(plan: SemanticEmbeddingPlan, evidence: SemanticOpportunityEmbeddingEvidence): string[] {
  if (!evidence || evidence.factsHash !== plan.factsHash) return ['semantic_facts_hash_stale'];
  if (evidence.planVersion !== plan.planVersion || evidence.chunkBytes !== plan.chunkBytes || evidence.passagePrefix !== plan.passagePrefix || evidence.titleHash !== plan.titleHash || evidence.descriptionHash !== plan.descriptionHash) return ['semantic_full_text_plan_mismatch'];
  const errors: string[] = [];
  for (const field of ['title', 'description'] as const) {
    const expected = plan[field];
    const actual = evidence[field];
    if (!Array.isArray(actual) || !actual.length || actual.length !== expected.length) {
      errors.push('semantic_full_text_coverage_incomplete');
      continue;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const chunk = expected[index];
      const entry = actual[index];
      if (!entry || entry.index !== chunk.index || entry.startByte !== chunk.startByte || entry.endByte !== chunk.endByte || entry.textHash !== chunk.textHash) {
        errors.push('semantic_chunk_layout_mismatch');
        continue;
      }
      const metadata = entry.metadata;
      if (!metadata || metadata.inputHash !== chunk.inputHash || metadata.inputKind !== 'passage') {
        errors.push('semantic_embedding_input_mismatch');
        continue;
      }
      if (!nonempty(metadata.model) || !nonempty(metadata.version) || !nonempty(metadata.tokenizer) || !nonempty(metadata.tokenizerVersion)) errors.push('semantic_model_metadata_incomplete');
      if (metadata.truncated !== false || !Number.isInteger(metadata.inputTokenCount) || metadata.inputTokenCount <= 0 || !Number.isInteger(metadata.maxInputTokens) || metadata.maxInputTokens <= 0 || metadata.inputTokenCount > metadata.maxInputTokens || metadata.consumedInputUtf8Bytes !== chunk.inputUtf8Bytes) errors.push('semantic_tokenizer_coverage_unverified');
      if (!Number.isInteger(metadata.dimension) || metadata.dimension !== entry.vector?.length || semanticCosineSimilarity(entry.vector, entry.vector) === null) errors.push('semantic_embedding_vector_invalid');
    }
  }
  return errors;
}

function compareField(left: readonly SemanticChunkEmbedding[], right: readonly SemanticChunkEmbedding[]): SemanticFieldComparison {
  const matrix = left.map((a) => right.map((b) => semanticCosineSimilarity(a.vector, b.vector) as number));
  const best = (values: number[]): number => values.reduce((index, value, candidate) => value > values[index] ? candidate : index, 0);
  const leftMatches = left.map((chunk, index) => {
    const match = best(matrix[index]);
    return { index: chunk.index, matchedIndex: right[match].index, cosine: matrix[index][match], bytes: chunk.endByte - chunk.startByte };
  });
  const rightMatches = right.map((chunk, index) => {
    const values = matrix.map((row) => row[index]);
    const match = best(values);
    return { index: chunk.index, matchedIndex: left[match].index, cosine: values[match], bytes: chunk.endByte - chunk.startByte };
  });
  const matches = [...leftMatches, ...rightMatches];
  const totalBytes = matches.reduce((sum, match) => sum + match.bytes, 0);
  return {
    minimum: Math.min(...matches.map((match) => match.cosine)),
    maximum: Math.max(...matches.map((match) => match.cosine)),
    weightedMean: matches.reduce((sum, match) => sum + match.cosine * match.bytes, 0) / totalBytes,
    left: leftMatches, right: rightMatches,
  };
}

function chunks(text: string, maxBytes: number, prefix: string): SemanticTextChunk[] {
  const result: SemanticTextChunk[] = [];
  let current = '';
  let bytes = 0;
  let startByte = 0;
  const flush = (): void => {
    if (!current) return;
    const trimmed = current.trim();
    const input = !prefix || trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed}`;
    result.push({ index: result.length, startByte, endByte: startByte + bytes, text: current, textHash: hash(current), input, inputHash: hash(input), inputUtf8Bytes: Buffer.byteLength(input) });
    startByte += bytes;
    current = '';
    bytes = 0;
  };
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (bytes + size > maxBytes) flush();
    current += point;
    bytes += size;
  }
  flush();
  return result;
}

function stableValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (value instanceof Date) return ['date', Number.isFinite(value.getTime()) ? value.toISOString() : 'invalid'];
  if (['string', 'boolean', 'number'].includes(typeof value)) return [typeof value, typeof value === 'number' && !Number.isFinite(value) ? String(value) : value];
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Facts must be acyclic plain data');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError('Facts must be plain data');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Symbol facts cannot be omitted');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? ['array', value.map((item) => stableValue(item, ancestors))]
    : ['object', Object.keys(value).sort().map((key) => [key, stableValue((value as Record<string, unknown>)[key], ancestors)])];
  ancestors.delete(value);
  return result;
}

function auditEvidence(evidence: SemanticOpportunityEmbeddingEvidence): SemanticComparisonAudit['left'] {
  const receipt = ({ vector: _vector, ...entry }: SemanticChunkEmbedding): Omit<SemanticChunkEmbedding, 'vector'> => ({ ...entry, metadata: { ...entry.metadata } });
  return {
    planVersion: evidence.planVersion, factsHash: evidence.factsHash,
    titleHash: evidence.titleHash, descriptionHash: evidence.descriptionHash,
    chunkBytes: evidence.chunkBytes, passagePrefix: evidence.passagePrefix,
    title: evidence.title.map(receipt), description: evidence.description.map(receipt),
  };
}

function modelIdentity(metadata: SemanticEmbeddingMetadata): string {
  return JSON.stringify([metadata.model, metadata.version, metadata.dimension, metadata.inputKind, metadata.tokenizer, metadata.tokenizerVersion, metadata.maxInputTokens]);
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? normalizeDuplicateText(value) : '';
}

function technologyConflict(left: string, right: string): boolean {
  const technologies = (value: string): Set<string> => new Set(EXPLICIT_TECHNOLOGIES.flatMap(([technology, pattern]) => pattern.test(value) ? [technology] : []));
  const a = technologies(left);
  const b = technologies(right);
  return a.size > 0 && b.size > 0 && ![...a].some((technology) => b.has(technology));
}

function nonempty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validUtf8(value: string): boolean {
  return Buffer.from(value).toString('utf8') === value;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
