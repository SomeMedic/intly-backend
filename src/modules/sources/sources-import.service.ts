import { Inject, Injectable } from '@nestjs/common';

import { Actor } from '../../common/access';
import { OpportunityType } from '../opportunities/schemas/opportunity.schema';
import { OPPORTUNITIES_INGEST_SERVICE, OpportunitiesIngestServiceLike } from './ingestion/source-ingestion.types';
import { SourceDeduplicationService } from './deduplication/source-deduplication.service';
import { WebExtractionService } from './extraction/web-extraction.service';
import { SourceNormalizerService } from './normalization/source-normalizer.service';
import { Source } from './schemas/source.schema';
import { SourcesRepository } from './sources.repository';

export type ImportUrlInput = {
  url: string;
  type?: OpportunityType;
  profileId?: string;
};

@Injectable()
export class SourcesImportService {
  constructor(
    private readonly sourcesRepository: SourcesRepository,
    private readonly webExtraction: WebExtractionService,
    private readonly normalizer: SourceNormalizerService,
    private readonly deduplication: SourceDeduplicationService,
    @Inject(OPPORTUNITIES_INGEST_SERVICE) private readonly opportunitiesIngest: OpportunitiesIngestServiceLike,
  ) {}

  async importUrl(actor: Actor, input: ImportUrlInput) {
    const manualSource = await this.sourcesRepository.get('manual').catch(() => null);
    const source = manualSource ?? {
      _id: 'manual',
      name: 'Manual URL import',
      group: 'web',
      connectorFamily: 'PublicHtml',
      opportunityTypes: [input.type ?? 'vacancy'],
      endpoint: {},
      config: {},
      limits: {},
      timeoutMs: 20_000,
    };
    const raw = await this.webExtraction.extractOpportunityFromUrl(input.url, {
      sourceId: 'manual',
      sourceName: 'Manual URL import',
      type: input.type,
    });
    const normalized = this.normalizer.normalize(source as Source, raw);
    const collapsed = this.deduplication.collapseBatch([normalized]);
    const result = await this.opportunitiesIngest.ingestFromSource({
      sourceId: 'manual',
      runId: `manual:${actor.id}:${Date.now()}`,
      records: collapsed.records,
    });
    return {
      sourceId: 'manual',
      url: raw.url,
      persistedOpportunityIds: result.opportunityIds,
      stats: result,
    };
  }
}
