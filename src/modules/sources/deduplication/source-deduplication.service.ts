import { Injectable } from '@nestjs/common';

import { NormalizedOpportunityInput } from '../ingestion/source-ingestion.types';

@Injectable()
export class SourceDeduplicationService {
  collapseBatch(records: NormalizedOpportunityInput[]): { records: NormalizedOpportunityInput[]; duplicates: number } {
    const byIdentity = new Map<string, NormalizedOpportunityInput>();
    let duplicates = 0;
    for (const record of records) {
      const occurrence = record.sourceOccurrences[0];
      const key = occurrence ? `${occurrence.sourceId}:${occurrence.externalId}` : record.fingerprint;
      if (byIdentity.has(key)) {
        duplicates += 1;
        continue;
      }
      byIdentity.set(key, record);
    }
    return { records: [...byIdentity.values()], duplicates };
  }
}
