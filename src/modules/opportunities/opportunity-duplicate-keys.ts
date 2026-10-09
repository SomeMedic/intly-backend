import { createHash } from 'node:crypto';
import { duplicateFingerprint, normalizeDuplicateText, normalizeDuplicateUrl } from './opportunity-deduplication';
import type { DuplicateOpportunityFacts } from './opportunity-deduplication';

export const DUPLICATE_INDEX_VERSION = 1;

export function opportunityDuplicateKeys(opportunity: DuplicateOpportunityFacts): string[] {
  const keys = new Set<string>();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const fingerprint = duplicateFingerprint(opportunity);
  if (fingerprint) keys.add(`fingerprint:${fingerprint}`);
  const company = normalizeDuplicateText(opportunity.companyOrClient ?? '');
  if (company && opportunity.type) keys.add(`company:${digest(`${opportunity.type}:${company}`)}`);
  for (const occurrence of opportunity.sourceOccurrences ?? []) {
    const url = normalizeDuplicateUrl(occurrence.url ?? '');
    if (url) keys.add(`url:${digest(url)}`);
    if (occurrence.sourceId?.trim() && occurrence.externalId?.trim()) {
      keys.add(`native:${digest(JSON.stringify([occurrence.sourceId.trim(), occurrence.externalId.trim()]))}`);
    }
  }
  return [...keys].sort();
}
