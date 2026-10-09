import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Actor } from '../../common/access';
import { newId } from '../../common/schema';
import { AuditService } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { OpportunitiesRepository, SourceSampleCandidate } from '../opportunities/opportunities.repository';
import { sourceOccurrenceRevision } from '../opportunities/source-occurrence-revision';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { OpportunityDeduplicationService } from '../opportunities/opportunity-deduplication.service';
import { B2bCenterConnector } from './connectors/b2b-center.connector';
import { RawOpportunityRecord } from './connectors/connector.types';
import { fabrikantDetailUrl, fabrikantPublished, fabrikantStoredCard, fabrikantTenderMetadata } from './connectors/fabrikant-native';
import { PublicApiFeedConnector } from './connectors/public-api-feed.connector';
import { WebExtractionService } from './extraction/web-extraction.service';
import { SourceNormalizerService } from './normalization/source-normalizer.service';
import { Source } from './schemas/source.schema';
import { SourcesRepository } from './sources.repository';

export type SourceInspectorToolAction = 'reindex' | 'reprocess' | 'normalize' | 'deduplicate';

type SourceInspectorUnsupportedReasonCode =
  | 'select_opportunity'
  | 'opportunity_not_found'
  | 'missing_external_id'
  | 'missing_url'
  | 'missing_retained_raw'
  | 'missing_source_metadata'
  | 'unsupported_source_mapper'
  | 'missing_retained_native_payload'
  | 'identity_mismatch'
  | 'invalid_native_url'
  | 'removed_source_occurrence'
  | 'dedup_unsupported';

type ToolCapability = {
  supported: boolean;
  reason?: string;
  reasonCode?: SourceInspectorUnsupportedReasonCode;
  requiresOpportunity: boolean;
};

type ToolCapabilities = {
  sourceId: string;
  supportedActions: SourceInspectorToolAction[];
  unavailableActions: Array<{ action: SourceInspectorToolAction; reason: string; reasonCode?: SourceInspectorUnsupportedReasonCode }>; 
  actions: Record<SourceInspectorToolAction, ToolCapability>;
};

const ACTION_JOB: Record<Exclude<SourceInspectorToolAction, 'reindex'>, string> = {
  reprocess: 'source-inspector.reprocess',
  normalize: 'source-inspector.normalize',
  deduplicate: 'source-inspector.deduplicate',
};

@Injectable()
export class SourceInspectorToolsService implements OnModuleInit {
  constructor(
    private readonly sourcesRepository: SourcesRepository,
    private readonly opportunitiesRepository: OpportunitiesRepository,
    private readonly jobsService: JobsService,
    private readonly auditService: AuditService,
    private readonly normalizer: SourceNormalizerService,
    private readonly opportunitiesService: OpportunitiesService,
    private readonly deduplicationService: OpportunityDeduplicationService,
  ) {}

  onModuleInit(): void {
    this.jobsService.registerHandler('ingestion', ACTION_JOB.reprocess, async (data) => this.handleRetainedRawJob('reprocess', data));
    this.jobsService.registerHandler('ingestion', ACTION_JOB.normalize, async (data) => this.handleRetainedRawJob('normalize', data));
    this.jobsService.registerHandler('ingestion', ACTION_JOB.deduplicate, async (data) => this.handleRetainedRawJob('deduplicate', data));
  }

  async capabilities(sourceId: string, opportunityId?: string): Promise<{ source: ReturnType<SourceInspectorToolsService['sourceSummary']>; capabilities: ToolCapabilities }> {
    const source = await this.sourcesRepository.get(sourceId);
    const sample = opportunityId ? await this.opportunitiesRepository.getSourceSample(sourceId, opportunityId) : null;
    if (opportunityId && !sample) throw new NotFoundException('Opportunity sample not found for source');
    return { source: this.sourceSummary(source), capabilities: this.capabilitySet(source, sample, Boolean(opportunityId)) };
  }

  async reindex(actor: Actor, sourceId: string, opportunityId: string) {
    const source = await this.sourcesRepository.get(sourceId);
    const sample = await this.opportunitiesRepository.getSourceSample(sourceId, opportunityId);
    if (!sample) throw new NotFoundException('Opportunity sample not found for source');
    const requestId = newId();
    const job = await this.jobsService.enqueue(
      'search',
      'index-opportunity',
      { opportunityId, sourceId, requestId, requestedByUserId: actor.id },
      { jobId: `source-inspector:${sourceId}:reindex:${opportunityId}:${requestId}` },
    );
    await this.auditService.record(actor, 'source.sample.reindex', 'source', sourceId, ['opportunityId', 'requestId']);
    return this.queuedReceipt('reindex', sourceId, opportunityId, job, requestId, this.capabilitySet(source, sample, true));
  }

  async enqueueRetainedRaw(actor: Actor, sourceId: string, opportunityId: string, action: Exclude<SourceInspectorToolAction, 'reindex'>) {
    const source = await this.sourcesRepository.get(sourceId);
    const sample = await this.opportunitiesRepository.getSourceSample(sourceId, opportunityId);
    if (!sample) throw new NotFoundException('Opportunity sample not found for source');
    const capability = this.actionCapability(action, source, sample, true);
    const capabilities = this.capabilitySet(source, sample, true);
    if (!capability.supported) return this.unsupportedReceipt(action, sourceId, opportunityId, capability.reason ?? 'Unsupported', capabilities);
    const requestId = newId();
    const expectedOccurrenceRevision = sourceOccurrenceRevision(sample._id, sample.sourceOccurrence);
    const job = await this.jobsService.enqueue(
      'ingestion',
      ACTION_JOB[action],
      {
        sourceId,
        opportunityId,
        requestId,
        requestedByUserId: actor.id,
        action,
        expectedOccurrenceRevision,
        externalId: sample.sourceOccurrence.externalId,
        url: sample.sourceOccurrence.url,
      },
      { jobId: `source-inspector:${sourceId}:${action}:${opportunityId}:${requestId}` },
    );
    await this.auditService.record(actor, this.auditAction(action), 'source', sourceId, ['opportunityId', 'requestId']);
    return this.queuedReceipt(action, sourceId, opportunityId, job, requestId, capabilities);
  }

  async handleRetainedRawJob(action: Exclude<SourceInspectorToolAction, 'reindex'>, data: Record<string, unknown>) {
    const sourceId = this.requiredString(data.sourceId, 'sourceId');
    const opportunityId = this.requiredString(data.opportunityId, 'opportunityId');
    const requestId = this.requiredString(data.requestId, 'requestId');
    const expectedOccurrenceRevision = this.requiredString(data.expectedOccurrenceRevision, 'expectedOccurrenceRevision');
    const [source, sample] = await Promise.all([
      this.sourcesRepository.get(sourceId),
      this.opportunitiesRepository.getSourceSample(sourceId, opportunityId),
    ]);
    if (!sample) throw new ConflictException('Opportunity sample no longer belongs to source or was merged');
    if (sourceOccurrenceRevision(sample._id, sample.sourceOccurrence) !== expectedOccurrenceRevision) throw new ConflictException('Source occurrence changed after tool request was queued');
    if (data.externalId !== sample.sourceOccurrence.externalId || data.url !== sample.sourceOccurrence.url) throw new ConflictException('Source occurrence identity changed after tool request was queued');
    if (action === 'deduplicate') {
      const result = await this.deduplicationService.deduplicate(opportunityId, this.requiredString(data.requestedByUserId, 'requestedByUserId'));
      return { status: 'completed' as const, action, sourceId, opportunityId, requestId, result };
    }
    const capability = this.actionCapability(action, source, sample, true);
    if (!capability.supported) throw new BadRequestException(capability.reason ?? 'Unsupported retained raw repair');
    const raw = this.retainedRawRecord(source, sample);
    const normalized = this.normalizer.normalize(source, raw);
    const result = await this.opportunitiesService.repairRetainedSourceOccurrence({
      opportunityId,
      sourceId,
      sourceRunId: this.previousRunId(sample),
      externalId: raw.externalId,
      url: raw.url,
      expectedOccurrenceRevision,
      normalized,
    });
    return {
      status: 'completed' as const,
      action,
      sourceId,
      opportunityId,
      requestId,
      result: { repaired: result.repaired, opportunityId: result.opportunity._id },
    };
  }

  private retainedRawRecord(source: Source, sample: SourceSampleCandidate): RawOpportunityRecord {
    if (source._id === 'fabrikant') return this.fabrikantRawRecord(sample);
    if (this.supportsB2bRetainedSource(source._id)) return this.b2bCenterRawRecord(sample);
    if (this.supportsPublicRetainedSource(source._id)) {
      const rawPayload = this.cloneRecord(sample.sourceOccurrence.rawPayload);
      const record = new PublicApiFeedConnector(source._id).mapRetainedPayload(rawPayload);
      return {
        ...record,
        rawPayload,
        publishedAt: sample.sourceOccurrence.publishedAt ?? record.publishedAt,
        sourceStatus: sample.sourceOccurrence.status,
        sourceMetadata: record.sourceMetadata,
      };
    }
    throw new BadRequestException('Source has no retained native raw mapper');
  }

  private b2bCenterRawRecord(sample: SourceSampleCandidate, validateOccurrence = true): RawOpportunityRecord {
    const rawPayload = this.cloneRecord(sample.sourceOccurrence.rawPayload);
    const sourceMetadata = this.cloneRecord(sample.sourceOccurrence.sourceMetadata);
    const record = new B2bCenterConnector(new WebExtractionService()).mapRetainedPayload(rawPayload, sourceMetadata);
    if (validateOccurrence && sample.sourceOccurrence.externalId !== record.externalId) throw new BadRequestException('B2B-Center retained native key does not match source occurrence');
    if (validateOccurrence && this.retainedUrl(record.url) !== this.retainedUrl(sample.sourceOccurrence.url!)) throw new BadRequestException('B2B-Center retained URL does not match source occurrence');
    return {
      ...record,
      rawPayload,
      publishedAt: sample.sourceOccurrence.publishedAt ?? record.publishedAt,
      sourceStatus: sample.sourceOccurrence.status,
      sourceMetadata: record.sourceMetadata,
    };
  }

  private fabrikantRawRecord(sample: SourceSampleCandidate): RawOpportunityRecord {
    const rawPayload = this.cloneRecord(sample.sourceOccurrence.rawPayload);
    const sourceMetadata = this.cloneRecord(sample.sourceOccurrence.sourceMetadata);
    const card = this.storedFabrikantCard(rawPayload.nativeCatalogCard);
    if (sample.sourceOccurrence.externalId !== card.id) throw new BadRequestException('Fabrikant retained card identity does not match source occurrence');
    if (fabrikantDetailUrl(sample.sourceOccurrence.url!) !== fabrikantDetailUrl(card.url)) throw new BadRequestException('Fabrikant retained card URL does not match source occurrence');
    const nativeStatus = this.optionalString(sourceMetadata.nativeStatus) ?? card.nativeStatus ?? '';
    const detailText = this.optionalString(rawPayload.nativeDetailText);
    const tenderMetadata = fabrikantTenderMetadata({ ...card, nativeStatus, publishedText: this.optionalString(sourceMetadata.publishedText) ?? card.publishedText }, detailText);
    const publishedAt = sample.sourceOccurrence.publishedAt ?? sample.publishedAt ?? fabrikantPublished(card.publishedText);
    return {
      externalId: card.id,
      url: card.url,
      type: 'tender',
      title: card.title,
      companyOrClient: card.organizer,
      description: detailText ? `${card.text}\n\n${detailText}` : card.text,
      publishedAt,
      sourceStatus: this.fabrikantSourceStatus(nativeStatus),
      rawPayload,
      sourceMetadata: {
        ...sourceMetadata,
        ...tenderMetadata,
        extraction: sourceMetadata.extraction ?? 'http-native-public-html',
        nativeLotId: card.id,
        procedureNumber: tenderMetadata.tenderData.procedureNumber ?? card.procedureNumber,
        lotNumber: tenderMetadata.tenderData.lotNumber ?? card.lotNumber,
        section: card.section,
        nativeStatus,
        nativePriceText: card.priceText,
        nativeDeadlineText: card.deadlineText,
        participationText: card.participationText,
        participationPayment: sourceMetadata.participationPayment ?? 'unknown',
        publicViewing: sourceMetadata.publicViewing ?? true,
      },
    };
  }

  private capabilitySet(source: Source, sample: SourceSampleCandidate | null, opportunityScoped: boolean): ToolCapabilities {
    const actions: Record<SourceInspectorToolAction, ToolCapability> = {
      reindex: { supported: true, requiresOpportunity: true },
      reprocess: this.actionCapability('reprocess', source, sample, opportunityScoped),
      normalize: this.actionCapability('normalize', source, sample, opportunityScoped),
      deduplicate: this.actionCapability('deduplicate', source, sample, opportunityScoped),
    };
    return {
      sourceId: source._id,
      supportedActions: (Object.entries(actions) as Array<[SourceInspectorToolAction, ToolCapability]>).filter(([, value]) => value.supported).map(([item]) => item),
      unavailableActions: (Object.entries(actions) as Array<[SourceInspectorToolAction, ToolCapability]>).filter(([, value]) => !value.supported).map(([item, value]) => ({ action: item, reason: value.reason ?? 'Unsupported', ...(value.reasonCode ? { reasonCode: value.reasonCode } : {}) })),
      actions,
    };
  }

  private actionCapability(action: Exclude<SourceInspectorToolAction, 'reindex'>, source: Source, sample: SourceSampleCandidate | null, opportunityScoped: boolean): ToolCapability {
    if (!opportunityScoped) return { supported: false, requiresOpportunity: true, reason: 'Select an opportunity sample to replay retained native raw payload', reasonCode: 'select_opportunity' };
    if (!sample) return { supported: false, requiresOpportunity: true, reason: 'Opportunity sample not found for source', reasonCode: 'opportunity_not_found' };
    if (action === 'deduplicate') return { supported: true, requiresOpportunity: true };
    if (!sample.sourceOccurrence.externalId?.trim()) return { supported: false, requiresOpportunity: true, reason: 'Source occurrence is missing externalId', reasonCode: 'missing_external_id' };
    if (!sample.sourceOccurrence.url?.trim()) return { supported: false, requiresOpportunity: true, reason: 'Source occurrence is missing url', reasonCode: 'missing_url' };
    if (sample.sourceOccurrence.status === 'Removed') return { supported: false, requiresOpportunity: true, reason: 'Source occurrence was confirmed removed and cannot be repaired from historical retained raw', reasonCode: 'removed_source_occurrence' };
    if (!this.isNonEmptyRecord(sample.sourceOccurrence.rawPayload)) return { supported: false, requiresOpportunity: true, reason: 'Source occurrence has no retained raw payload', reasonCode: 'missing_retained_raw' };
    if (!this.isNonEmptyRecord(sample.sourceOccurrence.sourceMetadata)) return { supported: false, requiresOpportunity: true, reason: 'Source occurrence has no retained source metadata', reasonCode: 'missing_source_metadata' };
    if (this.supportsPublicRetainedSource(source._id) || this.supportsB2bRetainedSource(source._id)) {
      let record: RawOpportunityRecord;
      try { record = this.supportsB2bRetainedSource(source._id) ? this.b2bCenterRawRecord(sample, false) : this.retainedRawRecord(source, sample); }
      catch { return { supported: false, requiresOpportunity: true, reason: 'Source retained raw payload cannot be mapped to a native record', reasonCode: 'missing_retained_native_payload' }; }
      if (record.externalId !== sample.sourceOccurrence.externalId) return { supported: false, requiresOpportunity: true, reason: 'Retained native record identity does not match source occurrence', reasonCode: 'identity_mismatch' };
      try {
        if (this.retainedUrl(record.url) !== this.retainedUrl(sample.sourceOccurrence.url)) return { supported: false, requiresOpportunity: true, reason: 'Retained native record URL does not match source occurrence', reasonCode: 'identity_mismatch' };
      } catch { return { supported: false, requiresOpportunity: true, reason: 'Retained native record URL is invalid', reasonCode: 'invalid_native_url' }; }
      return { supported: true, requiresOpportunity: true };
    }
    if (source._id !== 'fabrikant') return { supported: false, requiresOpportunity: true, reason: 'Source has no retained native raw mapper', reasonCode: 'unsupported_source_mapper' };
    const card = this.supportedFabrikantCard(sample.sourceOccurrence.rawPayload.nativeCatalogCard);
    if (!card) return { supported: false, requiresOpportunity: true, reason: 'Fabrikant retained raw payload has no native catalog card', reasonCode: 'missing_retained_native_payload' };
    if (card.id !== sample.sourceOccurrence.externalId) return { supported: false, requiresOpportunity: true, reason: 'Fabrikant retained card identity does not match source occurrence', reasonCode: 'identity_mismatch' };
    try { if (fabrikantDetailUrl(sample.sourceOccurrence.url) !== fabrikantDetailUrl(card.url)) return { supported: false, requiresOpportunity: true, reason: 'Fabrikant retained card URL does not match source occurrence', reasonCode: 'identity_mismatch' }; }
    catch { return { supported: false, requiresOpportunity: true, reason: 'Fabrikant retained card URL is invalid', reasonCode: 'invalid_native_url' }; }
    return { supported: true, requiresOpportunity: true };
  }

  private auditAction(action: Exclude<SourceInspectorToolAction, 'reindex'>): string {
    if (action === 'normalize') return 'source.sample.rerun-normalization';
    if (action === 'deduplicate') return 'source.sample.rerun-deduplication';
    return 'source.sample.reprocess';
  }

  private queuedReceipt(action: SourceInspectorToolAction, sourceId: string, opportunityId: string, job: { id: string; queue: string }, requestId: string, capabilities: ToolCapabilities) {
    return {
      status: 'queued' as const,
      action,
      sourceId,
      opportunityId,
      requestId,
      job,
      supportedActions: capabilities.supportedActions,
      unavailableActions: capabilities.unavailableActions,
      capabilities: capabilities.actions,
    };
  }

  private unsupportedReceipt(action: SourceInspectorToolAction, sourceId: string, opportunityId: string, reason: string, capabilities: ToolCapabilities) {
    return {
      status: 'unsupported' as const,
      action,
      sourceId,
      opportunityId,
      reason,
      ...(capabilities.actions[action].reasonCode ? { reasonCode: capabilities.actions[action].reasonCode } : {}),
      supportedActions: capabilities.supportedActions,
      unavailableActions: capabilities.unavailableActions,
      capabilities: capabilities.actions,
    };
  }

  private sourceSummary(source: Source) {
    return {
      id: source._id,
      name: source.name,
      group: source.group,
      connectorFamily: source.connectorFamily,
      healthState: source.healthState,
      runtimeState: source.runtimeState,
      enabled: source.enabled,
    };
  }

  private supportsPublicRetainedSource(sourceId: string): sourceId is 'remoteok' | 'remotive' | 'trudvsem' {
    return sourceId === 'remoteok' || sourceId === 'remotive' || sourceId === 'trudvsem';
  }

  private supportsB2bRetainedSource(sourceId: string): sourceId is 'b2b_center' {
    return sourceId === 'b2b_center';
  }

  private retainedUrl(value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BadRequestException('Invalid retained record URL');
    return url.toString();
  }

  private previousRunId(sample: SourceSampleCandidate): string | undefined {
    const value = sample.sourceOccurrence.sourceMetadata?.sourceRunId;
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private fabrikantSourceStatus(nativeStatus: string) {
    return /(?:заверш|отмен|закрыт)/i.test(nativeStatus) ? 'Closed' : /(?:прием|приём|ожидается|опубликован|подведени|рассмотрени)/i.test(nativeStatus) ? 'Active' : 'Unknown';
  }

  private requiredString(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${name} is required`);
    return value;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private storedFabrikantCard(value: unknown) {
    try { return fabrikantStoredCard(value); }
    catch { throw new BadRequestException('Fabrikant retained raw payload has no native catalog card'); }
  }

  private supportedFabrikantCard(value: unknown) {
    try { return fabrikantStoredCard(value); }
    catch { return null; }
  }

  private isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
    return this.isRecord(value) && Object.keys(value).length > 0;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  private cloneRecord(value: unknown): Record<string, unknown> {
    if (!this.isRecord(value)) return {};
    return this.cloneValue(value) as Record<string, unknown>;
  }

  private cloneValue(value: unknown): unknown {
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map((item) => this.cloneValue(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.cloneValue(item)]));
  }

}
