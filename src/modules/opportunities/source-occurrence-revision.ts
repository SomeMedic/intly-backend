import { createHash } from 'node:crypto';

import { SourceOccurrence } from './schemas/opportunity.schema';

export function sourceOccurrenceRevision(opportunityId: string, occurrence: SourceOccurrence): string {
  return createHash('sha256').update(JSON.stringify({
    opportunityId,
    sourceId: occurrence.sourceId,
    externalId: occurrence.externalId,
    url: occurrence.url,
    checksum: occurrence.checksum,
    rawPayload: occurrence.rawPayload,
    sourceMetadata: occurrence.sourceMetadata,
    status: occurrence.status,
    publishedAt: occurrence.publishedAt,
    normalizedSnapshot: occurrence.normalizedSnapshot,
    firstSeenAt: occurrence.firstSeenAt,
    lastSeenAt: occurrence.lastSeenAt,
  })).digest('hex');
}
