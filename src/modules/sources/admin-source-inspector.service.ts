import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Actor } from '../../common/access';
import { readOperationalLogs, redactOperationalValue } from '../../common/operational-logs';
import { AuditService } from '../audit/audit.service';
import { OpportunitiesRepository, SourceSampleCandidate } from '../opportunities/opportunities.repository';
import { SourcesRepository } from './sources.repository';
import { SourceInspectorToolsService } from './source-inspector-tools.service';
import { ListSourceLogsDto, ListSourceSamplesDto, ReindexSourceSampleDto, SourceToolOpportunityDto } from './dto/admin-source-inspector.dto';

@Injectable()
export class AdminSourceInspectorService {
  constructor(
    private readonly sourcesRepository: SourcesRepository,
    private readonly opportunitiesRepository: OpportunitiesRepository,
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
    private readonly tools: SourceInspectorToolsService,
  ) {}

  async logs(sourceId: string, query: ListSourceLogsDto = {}) {
    const source = await this.sourcesRepository.get(sourceId);
    const logs = readOperationalLogs(this.config.get<string>('LOG_DIRECTORY'), {
      ...query,
      sourceId,
      limit: this.logLimit(query.limit),
    });
    return {
      source: this.sourceSummary(source),
      logs,
      filters: {
        sourceId,
        runId: query.runId,
        level: query.level,
        from: query.from,
        to: query.to,
        query: query.query,
        limit: this.logLimit(query.limit),
      },
    };
  }

  async samples(actor: Actor, sourceId: string, query: ListSourceSamplesDto = {}) {
    const source = await this.sourcesRepository.get(sourceId);
    const includeRaw = this.includeRaw(query.includeRaw);
    const page = await this.opportunitiesRepository.listSourceSamples({
      sourceId,
      cursor: query.cursor,
      limit: this.sampleLimit(query.limit),
    });
    if (includeRaw) {
      await this.auditService.record(actor, 'source.sample.raw.read', 'source', sourceId, ['includeRaw']);
    }
    return {
      source: this.sourceSummary(source),
      items: page.items.map((item) => this.toSample(item, includeRaw)),
      nextCursor: page.nextCursor,
    };
  }

  capabilities(sourceId: string, opportunityId?: string) {
    return this.tools.capabilities(sourceId, opportunityId);
  }

  reindex(actor: Actor, sourceId: string, dto: ReindexSourceSampleDto) {
    return this.tools.reindex(actor, sourceId, dto.opportunityId);
  }

  reprocess(actor: Actor, sourceId: string, dto: SourceToolOpportunityDto) {
    return this.tools.enqueueRetainedRaw(actor, sourceId, dto.opportunityId, 'reprocess');
  }

  normalize(actor: Actor, sourceId: string, dto: SourceToolOpportunityDto) {
    return this.tools.enqueueRetainedRaw(actor, sourceId, dto.opportunityId, 'normalize');
  }

  deduplicate(actor: Actor, sourceId: string, dto: SourceToolOpportunityDto) {
    return this.tools.enqueueRetainedRaw(actor, sourceId, dto.opportunityId, 'deduplicate');
  }

  private toSample(item: SourceSampleCandidate, includeRaw: boolean) {
    const baseOccurrence = this.safeOccurrenceBase(item);
    const occurrence = includeRaw
      ? {
          ...baseOccurrence,
          rawPayload: redactOperationalValue(item.sourceOccurrence.rawPayload ?? {}),
          sourceMetadata: redactOperationalValue(item.sourceOccurrence.sourceMetadata ?? {}),
          ...(item.sourceOccurrence.normalizedSnapshot ? { normalizedSnapshot: this.safeNormalizedSnapshot(item.sourceOccurrence.normalizedSnapshot) } : {}),
        }
      : {
          ...baseOccurrence,
          hasRawPayload: Boolean(item.sourceOccurrence.rawPayload && Object.keys(item.sourceOccurrence.rawPayload).length),
          hasSourceMetadata: Boolean(item.sourceOccurrence.sourceMetadata && Object.keys(item.sourceOccurrence.sourceMetadata).length),
        };
    return {
      opportunity: {
        _id: item._id,
        type: item.type,
        title: item.title,
        companyOrClient: item.companyOrClient,
        summary: item.summary,
        sourceStatus: item.sourceStatus,
        firstSeenAt: item.firstSeenAt,
        lastSeenAt: item.lastSeenAt,
        publishedAt: item.publishedAt,
        deadline: item.deadline,
        skills: item.skills ?? [],
        technologies: item.technologies ?? [],
        remoteType: item.remoteType,
        location: item.location,
        money: item.money ?? {},
        canonicalTags: item.canonicalTags ?? [],
      },
      occurrence,
    };
  }


  private safeOccurrenceBase(item: SourceSampleCandidate) {
    return {
      sourceId: item.sourceOccurrence.sourceId,
      externalId: item.sourceOccurrence.externalId,
      url: this.safeText(item.sourceOccurrence.url),
      primary: item.sourceOccurrence.primary,
      firstSeenAt: item.sourceOccurrence.firstSeenAt,
      lastSeenAt: item.sourceOccurrence.lastSeenAt,
      publishedAt: item.sourceOccurrence.publishedAt,
      checksum: item.sourceOccurrence.checksum,
      status: item.sourceOccurrence.status,
    };
  }

  private safeNormalizedSnapshot(snapshot: SourceSampleCandidate['sourceOccurrence']['normalizedSnapshot']) {
    if (!snapshot) return undefined;
    return {
      deadline: snapshot.deadline,
      money: redactOperationalValue(snapshot.money ?? {}),
      sourceStatus: snapshot.sourceStatus,
    };
  }

  private safeText(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return value;
    const redacted = redactOperationalValue(value);
    return typeof redacted === 'string' ? redacted : undefined;
  }

  private sourceSummary(source: { _id: string; name: string; group: string; connectorFamily: string; healthState: string; runtimeState: string; enabled: boolean }) {
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

  private includeRaw(value: unknown): boolean {
    return value === true || value === 'true' || value === '1';
  }

  private logLimit(value: unknown): number {
    return this.clampLimit(value, 50, 100);
  }

  private sampleLimit(value: unknown): number {
    return this.clampLimit(value, 25, 50);
  }

  private clampLimit(value: unknown, fallback: number, max: number): number {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < 1) throw new BadRequestException('limit must be greater than 0');
    return Math.min(parsed, max);
  }
}
