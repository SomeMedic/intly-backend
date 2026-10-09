import { Injectable } from '@nestjs/common';

import { Actor } from '../../../common/access';
import { IngestOpportunityInput, OpportunitiesService } from '../../opportunities/opportunities.service';
import { IngestBatchInput, IngestBatchResult, IngestRecordFailure, MarkSourceOccurrenceRemovedInput, MarkSourceOccurrenceRemovedResult, OpportunitiesIngestServiceLike } from './source-ingestion.types';

const SYSTEM_ACTOR: Actor = {
  id: 'system:ingestion',
  email: 'system@intly.local',
  role: 'Admin',
  scopes: ['ingestion'],
};

@Injectable()
export class OpportunitiesIngestAdapter implements OpportunitiesIngestServiceLike {
  constructor(private readonly opportunitiesService: OpportunitiesService) {}

  async markSourceOccurrenceRemoved(input: MarkSourceOccurrenceRemovedInput): Promise<MarkSourceOccurrenceRemovedResult> {
    const service = this.opportunitiesService as unknown as {
      markSourceOccurrenceRemoved?: (input: MarkSourceOccurrenceRemovedInput) => Promise<MarkSourceOccurrenceRemovedResult>;
    };
    if (typeof service.markSourceOccurrenceRemoved !== 'function') {
      throw new Error('Opportunity source occurrence removal service is not available');
    }
    return service.markSourceOccurrenceRemoved(input);
  }

  async ingestFromSource(input: IngestBatchInput): Promise<IngestBatchResult> {
    let created = 0;
    let updated = 0;
    let failed = 0;
    const opportunityIds: string[] = [];
    const failures: IngestRecordFailure[] = [];

    for (const [index, record] of input.records.entries()) {
      const occurrence = record.sourceOccurrences[0];
      if (!occurrence) {
        failed += 1;
        failures.push(this.failureForRecord(index, record, 'Normalized record is missing a source occurrence', false));
        continue;
      }
      try {
        const result = await this.opportunitiesService.ingestOrUpsert(this.toIngestInput(record, input.sourceId, input.runId, input.effectMode), SYSTEM_ACTOR);
        opportunityIds.push(result.opportunity._id);
        if (result.created) created += 1;
        else updated += 1;
      } catch (error) {
        failed += 1;
        failures.push(this.failureForRecord(index, record, this.errorReason(error), this.isTransientBackpressure(error), this.errorCode(error)));
      }
    }

    const upserted = created + updated;
    return {
      seen: input.records.length,
      normalized: input.records.length,
      upserted,
      created,
      updated,
      duplicates: Math.max(0, input.records.length - upserted - failed),
      failed,
      opportunityIds,
      failures,
    };
  }

  private failureForRecord(index: number, record: IngestBatchInput['records'][number], reason: string, transient: boolean, code?: string): IngestRecordFailure {
    const occurrence = record.sourceOccurrences[0];
    return {
      index,
      externalId: occurrence?.externalId,
      url: occurrence?.url,
      title: record.title,
      code,
      reason,
      transient,
    };
  }

  private isTransientBackpressure(error: unknown): boolean {
    return this.errorCode(error) === 'QUEUE_BACKPRESSURE';
  }

  private errorCode(error: unknown): string | undefined {
    const response = this.errorResponse(error);
    if (response && typeof response.code === 'string') return response.code;
    if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
    return undefined;
  }

  private errorReason(error: unknown): string {
    const response = this.errorResponse(error);
    if (response && typeof response.message === 'string') return response.message;
    if (error instanceof Error) return error.message;
    return 'Opportunity ingestion failed';
  }

  private errorResponse(error: unknown): Record<string, unknown> | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const getResponse = (error as { getResponse?: unknown }).getResponse;
    if (typeof getResponse !== 'function') return undefined;
    const response = getResponse.call(error) as unknown;
    return response && typeof response === 'object' && !Array.isArray(response) ? response as Record<string, unknown> : undefined;
  }

  private toIngestInput(record: IngestBatchInput['records'][number], sourceId: string, runId: string, effectMode?: IngestBatchInput['effectMode']): IngestOpportunityInput {
    const occurrence = record.sourceOccurrences[0];
    return {
      type: record.type,
      title: record.title,
      companyOrClient: record.companyOrClient,
      description: record.description,
      language: record.language,
      skills: record.skills,
      technologies: record.technologies,
      seniority: record.seniority,
      employmentType: record.employmentType,
      location: record.location,
      remoteType: record.remoteType,
      money: record.money,
      deadline: record.deadline,
      publishedAt: record.publishedAt,
      sourceStatus: record.sourceStatus,
      sourceId,
      sourceRunId: runId,
      sourceRunEffectMode: effectMode,
      externalId: occurrence.externalId,
      url: occurrence.url,
      checksum: occurrence.checksum,
      rawPayload: occurrence.rawPayload,
      sourceMetadata: occurrence.sourceMetadata,
      vacancyData: record.vacancyData,
      freelanceData: record.freelanceData,
      tenderData: record.tenderData,
      canonicalTags: record.canonicalTags,
    };
  }
}
