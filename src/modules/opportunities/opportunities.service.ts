import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';

import { ModuleRef } from '@nestjs/core';
import { Job, UnrecoverableError } from 'bullmq';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Actor } from '../../common/access';
import { AuditService } from '../audit/audit.service';
import { newId, toPublic } from '../../common/schema';
import { FilesService } from '../files/files.service';
import { JobsService } from '../jobs/jobs.service';
import { MatchingService } from '../matching';
import { NotificationsService } from '../notifications';
import { Profile, ProfilesRepository } from '../profiles';
import { SavedViewsRepository } from '../saved-views';
import { SourcesRepository } from '../sources/sources.repository';
import type { NormalizedOpportunityInput } from '../sources/ingestion/source-ingestion.types';
import { User } from '../users/schemas/user.schema';
import { UsersRepository } from '../users/users.repository';
import {
  BulkAdminReportsDto,
  BulkOpportunityActionDto,
  CreateOpportunityCommentDto,
  ListAdminReportsDto,
  ImportFileDto,
  ManualOpportunityDto,
  OpportunityExportDto,
  OpportunityListQueryDto,
  OpportunitySortDto,
  OpportunitySortField,
  ReportIssueDto,
  ResolveAdminReportDto,
  UpdateAdminReportDto,
  UpdatePersonalStateDto,
} from './dto/opportunity.dto';
import { IssueReportsRepository } from './issue-reports.repository';
import { OpportunityCommentsRepository } from './comments.repository';
import { OpportunityExportsRepository } from './opportunity-exports.repository';
import { OpportunityMergesRepository } from './opportunity-merges.repository';
import { OpportunityDeduplicationService } from './opportunity-deduplication.service';
import { LatestAiProjection, OpportunitiesRepository, OpportunityExportCandidate, OpportunitySortCandidate } from './opportunities.repository';
import { writeOpportunityExport } from './opportunity-export-writer';
import { OpportunityUserStatesRepository } from './opportunity-user-states.repository';
import { Opportunity, OpportunityType, SourceOccurrence, SourceStatus } from './schemas/opportunity.schema';
import { earliestPipelineReachedAtForType, isPipelineStageForType, normalizePipelineStatus, pipelineStatusMatches } from './pipeline-definitions';
import { TENDER_APPLICATION_SECTIONS, TENDER_APPLICATION_SECTION_SET } from './tender-application-sections';
import { IssueReport } from './schemas/issue-report.schema';
import { OpportunityComment } from './schemas/opportunity-comment.schema';
import { OpportunityExport } from './schemas/opportunity-export.schema';
import { OpportunityUserState } from './schemas/opportunity-user-state.schema';
import { opportunityDateMetadata } from './opportunity-date-metadata';

export type IngestOpportunityInput = {
  type: OpportunityType;
  title: string;
  companyOrClient?: string;
  description?: string;
  summary?: string;
  language?: string;
  skills?: string[];
  technologies?: string[];
  seniority?: string;
  employmentType?: string;
  location?: string;
  remoteType?: string;
  relocation?: boolean;
  countriesAllowed?: string[];
  money?: Opportunity['money'];
  deadline?: Date | string;
  publishedAt?: Date | string;
  sourceStatus?: SourceStatus;
  sourceId: string;
  sourceRunId?: string;
  sourceRunEffectMode?: 'fresh' | 'historical';
  externalId?: string;
  url: string;
  checksum?: string;
  rawPayload?: Record<string, unknown>;
  sourceMetadata?: Record<string, unknown>;
  vacancyData?: Record<string, unknown>;
  freelanceData?: Record<string, unknown>;
  tenderData?: Record<string, unknown>;
  canonicalTags?: string[];
};

export type IngestOpportunityResult = {
  opportunity: Opportunity;
  created: boolean;
  occurrenceAdded: boolean;
  matchedProfileIds: string[];
};

export type RetainedSourceOccurrenceRepairServiceInput = {
  opportunityId: string;
  sourceId: string;
  sourceRunId?: string;
  externalId: string;
  url: string;
  expectedOccurrenceRevision: string;
  normalized: NormalizedOpportunityInput;
};

export type RetainedSourceOccurrenceRepairResult = {
  opportunity: Opportunity;
  repaired: true;
};


export type MarkSourceOccurrenceRemovedInput = {
  sourceId: string;
  externalId: string;
  url: string;
  opportunityId: string;
  observedAt: Date | string;
  reason: string;
  runId: string;
};

type WatchlistEvaluationContext = {
  effectMode?: 'fresh' | 'historical';
  sourceRunId?: string;
  sourceId?: string;
};

type WatchlistsEvaluationPort = {
  evaluateOpportunity(opportunity: Opportunity, context?: WatchlistEvaluationContext): Promise<{ evaluated: number; hits: number; autoAiQueued: number }>;
};

type ExportBuildResult = {
  path: string;
  size: number;
  filename: string;
  mimeType: string;
  count: number;
  skipped: number;
};

type ExportResolveResult = {
  opportunityIds: string[];
  profile: Profile | null;
  requestedCount?: number;
};

type ExportRankedCandidate = Pick<PrivateRankedCandidate, 'id' | 'values'> & { firstSeenAt: number | null };

const EXPORT_BATCH_SIZE = 500;
const MAX_INLINE_EXPORT_BYTES = 8 * 1024 * 1024;
const EXPORT_FIELDS = [
  'id', 'type', 'title', 'companyOrClient', 'summary', 'description', 'skills',
  'technologies', 'seniority', 'employmentType', 'location', 'remoteType',
  'moneyMin', 'moneyMax', 'currency', 'sourceStatus', 'sourceIds', 'urls',
  'publishedAt', 'firstSeenAt', 'deadline', 'tags',
];
const PERSONAL_EXPORT_FIELDS = ['matchScore', 'pipelineStatus', 'favorite', 'hidden', 'archived', 'personalTags', 'aiScore', 'aiRunId'];

type PrivateRankedCandidate = {
  id: string;
  values: Array<string | number | null>;
  matchScore: number;
  state?: OpportunityUserState;
  ai?: LatestAiProjection;
};

@Injectable()
export class OpportunitiesService implements OnModuleInit {
  constructor(
    private readonly opportunitiesRepository: OpportunitiesRepository,
    private readonly statesRepository: OpportunityUserStatesRepository,
    private readonly issueReportsRepository: IssueReportsRepository,
    private readonly commentsRepository: OpportunityCommentsRepository,
    private readonly profilesRepository: ProfilesRepository,
    private readonly matchingService: MatchingService,
    @Optional() private readonly jobsService?: JobsService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly filesService?: FilesService,
    @Optional() private readonly savedViewsRepository?: SavedViewsRepository,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly usersRepository?: UsersRepository,
    @Optional() private readonly exportsRepository?: OpportunityExportsRepository,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly mergesRepository?: OpportunityMergesRepository,
    @Optional() private readonly deduplicationService?: OpportunityDeduplicationService,
  ) {}

  onModuleInit(): void {
    this.jobsService?.registerHandler('analytics', 'profile.recalculateMatch', async (data) => this.handleProfileRecalculateMatch(data));
    this.jobsService?.registerHandler('analytics', 'ingestion_match_all', async (data) => this.handleIngestionMatchAll(data));
    this.jobsService?.registerHandler('documents', 'opportunity.export', async (data, job) => this.handleOpportunityExport(data, job));
  }

  async list(actor: Actor, query: OpportunityListQueryDto) {
    query = await this.applySavedView(actor, query);
    const profile = await this.resolveListProfile(actor, query);
    const sortRules = this.sortRules(query);
    const stateRestricted = this.needsStateRestriction(query) && !(profile && !this.hasStateOnlyRestriction(query));
    const restrictedIds = stateRestricted ? await this.stateRestrictedIds(actor, query, profile) : undefined;
    const aiRestricted = await this.aiRestrictedIds(actor, query, profile, sortRules);
    const combinedRestrictedIds = this.intersectOptionalIds(restrictedIds, aiRestricted);

    if (profile && this.needsPrivateSortedPage(sortRules, query)) {
      return this.privateSortedPage(actor, query, profile, combinedRestrictedIds, sortRules);
    }

    const page = await this.opportunitiesRepository.list(query, combinedRestrictedIds);
    const states = await this.statesRepository.findForList(
      actor.id,
      page.items.map((item) => item._id),
      profile?._id,
    );
    const aiByOpportunity = profile ? await this.latestAiMap(actor.id, profile._id, page.items.map((item) => item._id)) : new Map<string, LatestAiProjection>();
    const byOpportunity = new Map(states.map((state) => [state.opportunityId, state]));
    return {
      items: page.items.map((opportunity) => this.toListItem(opportunity, byOpportunity.get(opportunity._id), aiByOpportunity.get(opportunity._id), profile ? this.effectiveMatchScore(opportunity, byOpportunity.get(opportunity._id), profile) : undefined)),
      nextCursor: page.nextCursor,
    };
  }

  async get(actor: Actor, id: string, profileId?: string) {
    const opportunity = await this.opportunitiesRepository.getById(id);
    const profile = profileId
      ? await this.profilesRepository.getOwned(profileId, actor.id)
      : await this.profilesRepository.findActive(actor.id);
    const personalState = profile ? await this.statesRepository.find(actor.id, opportunity._id, profile._id) : null;
    return { ...this.toResponse(opportunity), personalState: personalState ? this.toPersonalResponse(personalState) : null };
  }

  async view(actor: Actor, id: string, profileId?: string) {
    const opportunity = await this.opportunitiesRepository.getById(id);
    const profile = profileId
      ? await this.profilesRepository.getOwned(profileId, actor.id)
      : await this.profilesRepository.findActive(actor.id);
    if (!profile) {
      return { ...this.toResponse(opportunity), personalState: null };
    }
    const personalState = await this.saveReviewedState(actor.id, opportunity, profile);
    return { ...this.toResponse(opportunity), personalState: personalState ? this.toPersonalResponse(personalState) : null };
  }

  async manualCreate(actor: Actor, dto: ManualOpportunityDto): Promise<IngestOpportunityResult> {
    const requiredApplicationSections = this.manualTenderApplicationSections(dto);
    const manualExternalId = dto.externalId ?? newId();
    const opportunityInput = { ...dto };
    delete opportunityInput.requiredApplicationSections;
    return this.ingestOrUpsert(
      {
        ...opportunityInput,
        description: dto.description ?? '',
        sourceId: dto.sourceId ?? 'manual',
        externalId: manualExternalId,
        url: dto.url ?? `manual://${manualExternalId}`,
        rawPayload: dto.rawPayload ?? { ...dto },
        ...(dto.type === 'tender' ? { tenderData: { requiredApplicationSections } } : {}),
      },
      actor,
    );
  }

  private manualTenderApplicationSections(dto: ManualOpportunityDto): string[] {
    if (dto.type !== 'tender') {
      if (dto.requiredApplicationSections !== undefined) {
        throw new BadRequestException({ code: 'TENDER_APPLICATION_SECTIONS_NOT_ALLOWED', message: 'requiredApplicationSections is available only for tender opportunities', details: { allowedTypes: ['tender'] } });
      }
      return [];
    }
    if (dto.requiredApplicationSections === undefined) return [];
    if (!Array.isArray(dto.requiredApplicationSections)) {
      throw new BadRequestException({ code: 'TENDER_APPLICATION_SECTIONS_INVALID', message: 'Tender requiredApplicationSections must be an array', allowed: TENDER_APPLICATION_SECTIONS, details: { allowed: TENDER_APPLICATION_SECTIONS } });
    }
    const normalized = dto.requiredApplicationSections.map((section) => (typeof section === 'string' ? section.trim() : ''));
    const invalid = normalized.filter((section) => !TENDER_APPLICATION_SECTION_SET.has(section));
    if (invalid.length) {
      throw new BadRequestException({ code: 'TENDER_APPLICATION_SECTIONS_INVALID', message: 'Tender requiredApplicationSections contains unsupported sections', invalid, allowed: TENDER_APPLICATION_SECTIONS, details: { invalid, allowed: TENDER_APPLICATION_SECTIONS } });
    }
    return Array.from(new Set(normalized));
  }

  async importFile(actor: Actor, dto: ImportFileDto) {
    if (!this.filesService) throw new BadRequestException('Files service is not available');
    await this.filesService.get(actor, dto.fileId);
    const { file, buffer } = await this.filesService.readForSystem(dto.fileId);
    const rows = this.parseImportRows(buffer, file.mimeType, file.originalName);
    const limit = Math.min(dto.limit ?? 200, 200);
    const errors: Array<{ row: number; error: string }> = [];
    const opportunityIds: string[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const [index, row] of rows.slice(0, limit).entries()) {
      try {
        const input = this.rowToIngest(row, dto, index + 1);
        const result = await this.ingestOrUpsert(input, actor);
        opportunityIds.push(result.opportunity._id);
        if (result.created) created += 1;
        else updated += 1;
      } catch (error) {
        skipped += 1;
        errors.push({ row: index + 1, error: error instanceof Error ? error.message : 'Invalid row' });
      }
    }
    if (rows.length > limit) {
      skipped += rows.length - limit;
      errors.push({ row: limit + 1, error: `Import limit ${limit} reached; remaining rows skipped` });
    }
    return {
      fileId: dto.fileId,
      filename: file.originalName,
      imported: created + updated,
      created,
      updated,
      skipped,
      opportunityIds,
      errors,
    };
  }

  async export(actor: Actor, dto: OpportunityExportDto) {
    const query = await this.applySavedView(actor, dto.query ?? {});
    const explicitLimit = typeof dto.limit === 'number';
    const maxRows = explicitLimit ? Math.min(dto.limit!, 1000) : 1001;
    const resolved = await this.resolveExportOpportunities(actor, query, dto, maxRows);
    if (dto.background === true || (!explicitLimit && resolved.opportunityIds.length > 1000)) {
      return this.enqueueOpportunityExport(actor, { ...dto, query, background: false });
    }
    const directory = await mkdtemp(join(tmpdir(), 'intly-opportunity-export-'));
    try {
      const built = await this.buildExportFile(actor, dto, resolved, directory);
      if (built.size > MAX_INLINE_EXPORT_BYTES) {
        return await this.enqueueOpportunityExport(actor, { ...dto, query, background: false });
      }
      const payload = await readFile(built.path);
      const file = this.filesService
        ? await this.filesService.storeGeneratedFile(actor.id, built.path, built.mimeType, built.filename, {
            kind: 'opportunity_export', format: dto.format, scope: dto.scope,
            count: built.count, includePersonalData: Boolean(dto.includePersonalData),
          })
        : null;
      return {
        ...(file ? { fileId: file._id } : {}), filename: built.filename, name: built.filename,
        mimeType: built.mimeType, encoding: 'base64', contentBase64: payload.toString('base64'),
        count: built.count, skipped: built.skipped, errors: [],
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async exportStatus(actor: Actor, id: string) {
    if (!this.exportsRepository) throw new BadRequestException('Opportunity export status storage is not available');
    const record = await this.exportsRepository.getById(id);
    this.assertExportAccess(actor, record);
    return this.toExportStatus(record);
  }

  private async enqueueOpportunityExport(actor: Actor, dto: OpportunityExportDto & { query: OpportunityListQueryDto }) {
    if (!this.exportsRepository || !this.jobsService) throw new BadRequestException('Background exports are not available');
    const record = await this.exportsRepository.create({
      userId: actor.id,
      requestedByUserId: actor.id,
      status: 'queued',
      progress: 0,
      dto: dto as unknown as Record<string, unknown>,
    });
    try {
      const job = await this.jobsService.enqueue('documents', 'opportunity.export', { exportId: record._id }, { jobId: `opportunity.export:${record._id}` });
      const updated = await this.exportsRepository.update(record._id, { jobId: job.id });
      return { status: 'queued', exportId: updated._id, id: updated._id, jobId: job.id, progress: updated.progress };
    } catch (error) {
      await this.exportsRepository.update(record._id, {
        status: 'failed',
        progress: 100,
        error: error instanceof Error ? error.message : 'Opportunity export enqueue failed',
        failedAt: new Date(),
      });
      throw error;
    }
  }

  private async handleOpportunityExport(data: Record<string, unknown>, job: Job) {
    if (!this.exportsRepository || !this.filesService) throw new BadRequestException('Background export dependencies are not available');
    const exportsRepository = this.exportsRepository;
    const exportId = String(data.exportId ?? '');
    const existing = await exportsRepository.getById(exportId);
    if (existing.status === 'completed') return this.toExportStatus(existing);
    const record = await this.exportsRepository.update(exportId, { status: 'running', progress: 5, startedAt: new Date(), error: undefined });
    await job.updateProgress(5);
    let directory: string | undefined;
    try {
      const dto = record.dto as unknown as OpportunityExportDto;
      const query = await this.applySavedView(this.exportActor(record), dto.query ?? {});
      const resolved = await this.resolveExportOpportunities(this.exportActor(record), query, dto, typeof dto.limit === 'number' ? Math.min(dto.limit, 1000) : undefined);
      await this.exportsRepository.update(exportId, { progress: 20 });
      await job.updateProgress(20);
      directory = await mkdtemp(join(tmpdir(), 'intly-opportunity-export-'));
      let lastProgress = 20;
      const built = await this.buildExportFile(this.exportActor(record), dto, resolved, directory, async (processed) => {
        const progress = Math.min(90, 20 + Math.floor(70 * processed / Math.max(1, resolved.opportunityIds.length)));
        if (progress <= lastProgress) return;
        lastProgress = progress;
        await exportsRepository.update(exportId, { progress });
        await job.updateProgress(progress);
      });
      const file = await this.filesService.storeGeneratedFile(record.userId, built.path, built.mimeType, built.filename, {
        kind: 'opportunity_export',
        exportId,
        format: dto.format,
        scope: dto.scope,
        count: built.count,
        includePersonalData: Boolean(dto.includePersonalData),
      });
      const completed = await this.exportsRepository.update(exportId, {
        status: 'completed',
        progress: 100,
        fileId: file._id,
        filename: built.filename,
        mimeType: built.mimeType,
        count: built.count,
        completedAt: new Date(),
      });
      await job.updateProgress(100).catch(() => undefined);
      await this.notifyExportCompleted(completed);
      return this.toExportStatus(completed);
    } catch (error) {
      if (!this.isTerminalExportFailure(error, job)) throw error;
      const failed = await this.exportsRepository.update(exportId, {
        status: 'failed',
        progress: 100,
        error: error instanceof Error ? error.message : 'Opportunity export failed',
        failedAt: new Date(),
      });
      await this.notifyExportFailed(failed);
      throw error;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  private exportActor(record: OpportunityExport): Actor {
    return { id: record.userId, email: 'export@intly.local', role: 'User' };
  }

  private async resolveExportOpportunities(actor: Actor, query: OpportunityListQueryDto, dto: OpportunityExportDto, maxRows?: number): Promise<ExportResolveResult> {
    const ids = dto.scope === 'selected' ? dto.ids : dto.scope === 'loaded' ? dto.loadedIds : undefined;
    if ((dto.scope === 'selected' || dto.scope === 'loaded') && !ids?.length) {
      throw new BadRequestException(`${dto.scope} export requires ids`);
    }
    const profile = await this.resolveListProfile(actor, query);
    const sortRules = this.sortRules(query);
    const rules: OpportunitySortDto[] = sortRules.length ? sortRules : [{ field: 'firstSeenAt', direction: 'desc' }];
    const stateRestricted = this.needsStateRestriction(query) && !(profile && !this.hasStateOnlyRestriction(query));
    const stateRestrictedIds = stateRestricted ? await this.stateRestrictedIds(actor, query, profile, true) : undefined;
    const restrictedIds = this.intersectOptionalIds(stateRestrictedIds, await this.aiRestrictedIds(actor, query, profile, sortRules));
    const privateSort = !!profile && this.needsPrivateSortedPage(rules, query);
    const baseQuery = { ...query, cursor: undefined, minMatch: undefined };
    const candidateIds = ids ? this.intersectOptionalIds(ids, restrictedIds) : restrictedIds;
    const ranked: ExportRankedCandidate[] = [];
    const selectedIds = new Set<string>();
    const emptyStates = new Map<string, OpportunityUserState>();
    const emptyAi = new Map<string, LatestAiProjection>();
    const emptyScores = new Map<string, number>();
    for await (const batch of this.opportunitiesRepository.iteratePrivateSortCandidates(baseQuery, candidateIds, EXPORT_BATCH_SIZE, Boolean(ids))) {
      const privateRanks = privateSort
        ? await this.rankPrivateCandidates(actor, query, profile!, rules, batch)
        : undefined;
      const ranksById = new Map(privateRanks?.map((rank) => [rank.id, rank]));
      for (const candidate of batch) {
        if (privateSort && !ranksById.has(candidate._id)) continue;
        if (ids) {
          selectedIds.add(candidate._id);
          continue;
        }
        const compact: ExportRankedCandidate = {
          id: candidate._id,
          values: ranksById.get(candidate._id)?.values ?? rules.map((rule) => this.sortValue(candidate, rule.field, emptyStates, emptyAi, emptyScores)),
          firstSeenAt: candidate.firstSeenAt ? +new Date(candidate.firstSeenAt) : null,
        };
        if (maxRows) this.retainExportCandidate(ranked, compact, rules, privateSort, maxRows);
        else ranked.push(compact);
      }
    }
    if (!maxRows && !ids) ranked.sort((left, right) => this.compareExportCandidates(left, right, rules, privateSort));
    const orderedIds = ids ? ids.filter((id) => selectedIds.has(id)) : ranked.map((candidate) => candidate.id);
    return { opportunityIds: maxRows ? orderedIds.slice(0, maxRows) : orderedIds, profile, requestedCount: ids?.length };
  }

  private async buildExportFile(actor: Actor, dto: OpportunityExportDto, resolved: ExportResolveResult, directory: string, onProgress?: (processed: number) => Promise<void>): Promise<ExportBuildResult> {
    const filename = `opportunities-${new Date().toISOString().slice(0, 10)}.${dto.format === 'xlsx' ? 'xlsx' : dto.format}`;
    const mimeType = dto.format === 'json'
      ? 'application/json'
      : dto.format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv';
    const path = join(directory, filename);
    const result = await writeOpportunityExport(path, dto.format, this.exportRows(actor, dto, resolved, onProgress), this.exportHeaders(dto));
    return { path, size: result.size, filename, mimeType, count: result.count, skipped: Math.max(0, (resolved.requestedCount ?? 0) - result.count) };
  }

  private async *exportRows(actor: Actor, dto: OpportunityExportDto, resolved: ExportResolveResult, onProgress?: (processed: number) => Promise<void>): AsyncGenerator<Record<string, unknown>> {
    const { opportunityIds, profile } = resolved;
    for (let offset = 0; offset < opportunityIds.length; offset += EXPORT_BATCH_SIZE) {
      const ids = opportunityIds.slice(offset, offset + EXPORT_BATCH_SIZE);
      const [opportunities, states, ai] = await Promise.all([
        this.opportunitiesRepository.findForExportByIds(ids),
        dto.includePersonalData && profile ? this.statesRepository.findForList(actor.id, ids, profile._id) : [],
        dto.includePersonalData && profile ? this.latestAiMap(actor.id, profile._id, ids) : new Map<string, LatestAiProjection>(),
      ]);
      const byId = new Map(opportunities.map((item) => [item._id, item]));
      const statesById = new Map(states.map((item) => [item.opportunityId, item]));
      for (const id of ids) {
        const opportunity = byId.get(id);
        if (!opportunity) continue;
        const state = statesById.get(id);
        yield this.exportRow(opportunity, state, Boolean(dto.includePersonalData),
          dto.includePersonalData && profile ? this.effectiveMatchScore(opportunity, state, profile) : undefined, ai.get(id));
      }
      await onProgress?.(Math.min(offset + ids.length, opportunityIds.length));
    }
  }

  private exportHeaders(dto: OpportunityExportDto): string[] {
    const allowed = new Set([...EXPORT_FIELDS, ...PERSONAL_EXPORT_FIELDS]);
    const requested = [...new Set(dto.fields?.filter((field) => allowed.has(field)))];
    return requested.length ? requested : [...EXPORT_FIELDS, ...(dto.includePersonalData ? PERSONAL_EXPORT_FIELDS : [])];
  }

  private compareExportCandidates(left: ExportRankedCandidate, right: ExportRankedCandidate, rules: OpportunitySortDto[], privateSort: boolean): number {
    if (privateSort) return this.compareRankedCandidates(left, right, rules);
    for (const [index, rule] of rules.entries()) {
      const compared = this.compareRepositorySortValues(left.values[index], right.values[index], rule.direction);
      if (compared) return compared;
    }
    return this.compareRepositorySortValues(left.firstSeenAt, right.firstSeenAt, 'desc') || left.id.localeCompare(right.id);
  }

  private retainExportCandidate(items: ExportRankedCandidate[], candidate: ExportRankedCandidate, rules: OpportunitySortDto[], privateSort: boolean, limit: number): void {
    let start = 0;
    let end = items.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (this.compareExportCandidates(candidate, items[middle], rules, privateSort) < 0) end = middle;
      else start = middle + 1;
    }
    if (start >= limit) return;
    items.splice(start, 0, candidate);
    if (items.length > limit) items.pop();
  }

  private assertExportAccess(actor: Actor, record: OpportunityExport): void {
    if (actor.role !== 'Admin' && record.userId !== actor.id) throw new ForbiddenException('Opportunity export access denied');
  }

  private toExportStatus(record: OpportunityExport) {
    return {
      id: record._id,
      exportId: record._id,
      status: record.status,
      progress: record.progress,
      jobId: record.jobId,
      ...(record.fileId ? { fileId: record.fileId } : {}),
      ...(record.filename ? { filename: record.filename, name: record.filename } : {}),
      ...(record.mimeType ? { mimeType: record.mimeType } : {}),
      ...(typeof record.count === 'number' ? { count: record.count } : {}),
      ...(record.error ? { error: record.error } : {}),
      createdAt: (record as OpportunityExport & { createdAt?: Date }).createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      failedAt: record.failedAt,
    };
  }

  private async notifyExportCompleted(record: OpportunityExport): Promise<void> {
    await this.notificationsService?.notify({
      userId: record.userId,
      type: 'opportunity_export.completed',
      title: 'Выгрузка возможностей готова',
      body: record.filename ?? 'Файл выгрузки готов к скачиванию.',
      data: { exportId: record._id, fileId: record.fileId, filename: record.filename, count: record.count },
    }).catch(() => undefined);
  }

  private async notifyExportFailed(record: OpportunityExport): Promise<void> {
    await this.notificationsService?.notify({
      userId: record.userId,
      type: 'opportunity_export.failed',
      title: 'Выгрузка возможностей не завершилась',
      body: record.error ?? 'Повторите экспорт позже.',
      data: { exportId: record._id },
    }).catch(() => undefined);
  }

  private isTerminalExportFailure(error: unknown, job: Job): boolean {
    if (error instanceof UnrecoverableError) return true;
    const attempts = typeof job.opts?.attempts === 'number' && job.opts.attempts > 0 ? job.opts.attempts : 1;
    return (job.attemptsMade ?? 0) + 1 >= attempts;
  }

  async getPersonal(actor: Actor, opportunityId: string, profileId?: string) {
    opportunityId = (await this.opportunitiesRepository.getById(opportunityId))._id;
    const profile = profileId
      ? await this.profilesRepository.getOwned(profileId, actor.id)
      : await this.profilesRepository.findActive(actor.id);
    if (!profile) {
      return null;
    }
    const state = await this.statesRepository.find(actor.id, opportunityId, profile._id);
    return state ? this.toPersonalResponse(state) : null;
  }

  async updatePersonal(actor: Actor, opportunityId: string, dto: UpdatePersonalStateDto) {
    const opportunity = await this.opportunitiesRepository.getById(opportunityId);
    opportunityId = opportunity._id;
    const profile = dto.profileId
      ? await this.profilesRepository.getOwned(dto.profileId, actor.id)
      : await this.profilesRepository.findActive(actor.id);
    if (!profile) {
      throw new ForbiddenException('Create or activate a profile before saving personal opportunity state');
    }
    this.assertPipelineStatusAllowed(opportunity.type, dto.pipelineStatus);
    const match = this.matchingService.calculate(opportunity, profile);
    const state = await this.statesRepository.upsert({
      userId: actor.id,
      opportunityId,
      profileId: profile._id,
      favorite: dto.favorite,
      hidden: dto.hidden,
      archived: dto.archived,
      tags: dto.tags,
      notes: dto.notes as OpportunityUserState['notes'] | undefined,
      pipelineStatus: dto.pipelineStatus,
      matchScore: match.score,
      matchComponents: match.components,
      matchCalculatedAt: new Date(),
    });
    return this.toPersonalResponse(state);
  }

  async reportIssue(actor: Actor, opportunityId: string, dto: ReportIssueDto) {
    opportunityId = (await this.opportunitiesRepository.getById(opportunityId))._id;
    const report = await this.issueReportsRepository.create({
      userId: actor.id,
      opportunityId,
      type: dto.type,
      comment: dto.comment ?? '',
      status: 'Open',
    });
    return toPublic(report);
  }

  async getSources(id: string, includeRawPayload = false) {
    const opportunity = await this.opportunitiesRepository.getById(id);
    return opportunity.sourceOccurrences.map((occurrence) =>
      includeRawPayload ? occurrence : this.toSafeSourceOccurrence(occurrence),
    );
  }

  async adminListReports(actor: Actor, query: ListAdminReportsDto) {
    if (actor.role !== 'Admin') throw new ForbiddenException('Admin role required');
    const page = await this.issueReportsRepository.list(query);
    const opportunities = await this.opportunitiesRepository.findByIds(page.items.map((report) => report.opportunityId));
    const byId = new Map(opportunities.map((opportunity) => [opportunity._id, opportunity]));
    const groupedCounts = await this.issueReportsRepository.groupedCounts(page.items.map((report) => report.opportunityId));
    const users = await this.reportUsers(page.items);
    return {
      ...page,
      items: page.items.map((report) => this.toAdminReportResponse(report, byId.get(report.opportunityId), groupedCounts[report.opportunityId] ?? 1, users)),
    };
  }

  async adminGetReport(actor: Actor, id: string) {
    if (actor.role !== 'Admin') throw new ForbiddenException('Admin role required');
    const report = await this.issueReportsRepository.get(id);
    const opportunity = await this.opportunitiesRepository.getById(report.opportunityId);
    const related = await this.issueReportsRepository.related(report.opportunityId, report._id);
    const users = await this.reportUsers([report, ...related]);
    const groupedCounts = await this.issueReportsRepository.groupedCounts([report.opportunityId]);
    return {
      ...this.toAdminReportResponse(report, opportunity, groupedCounts[report.opportunityId] ?? related.length + 1, users),
      relatedReports: related.map((item) => this.toAdminReportResponse(item, undefined, undefined, users)),
      sourceOccurrences: opportunity.sourceOccurrences.map((occurrence) => this.toSafeSourceOccurrence(occurrence)),
      sourceDiagnostics: await this.reportSourceDiagnostics(opportunity),
      currentFields: this.toReportOpportunityFields(opportunity),
    };
  }

  async adminUpdateReport(actor: Actor, id: string, dto: UpdateAdminReportDto) {
    if (actor.role !== 'Admin') throw new ForbiddenException('Admin role required');
    const { assignedAdminId, ...fields } = dto;
    const patch: Partial<IssueReport> = { ...fields };
    if (assignedAdminId != null) {
      const assignee = await this.usersRepository?.findById(assignedAdminId);
      if (!assignee || assignee.role !== 'Admin' || assignee.status !== 'Active') {
        throw new BadRequestException('Assignee must be an active administrator');
      }
      patch.assignedAdminId = assignedAdminId;
    }
    const updated = await this.issueReportsRepository.update(id, patch, assignedAdminId === null ? ['assignedAdminId'] : []);
    await this.auditService?.record(actor, 'report.update', 'issue-report', id, Object.keys(dto));
    return this.adminGetReport(actor, updated._id);
  }

  async adminResolveReport(actor: Actor, id: string, dto: ResolveAdminReportDto) {
    if (actor.role !== 'Admin') throw new ForbiddenException('Admin role required');
    const updated = await this.issueReportsRepository.update(id, {
      status: 'Resolved',
      resolution: { action: dto.action ?? 'resolved', reason: dto.reason ?? '', resolvedByUserId: actor.id, resolvedAt: new Date() },
    });
    await this.auditService?.record(actor, 'report.resolve', 'issue-report', id, ['status', 'resolution']);
    return this.adminGetReport(actor, updated._id);
  }

  async adminDismissReport(actor: Actor, id: string, dto: ResolveAdminReportDto) {
    if (actor.role !== 'Admin') throw new ForbiddenException('Admin role required');
    const updated = await this.issueReportsRepository.update(id, {
      status: 'Dismissed',
      resolution: { action: dto.action ?? 'dismissed', reason: dto.reason ?? '', dismissedByUserId: actor.id, dismissedAt: new Date() },
    });
    await this.auditService?.record(actor, 'report.dismiss', 'issue-report', id, ['status', 'resolution']);
    return this.adminGetReport(actor, updated._id);
  }

  async adminBulkReports(actor: Actor, dto: BulkAdminReportsDto) {
    if (actor.role !== 'Admin') throw new ForbiddenException('Admin role required');
    if (dto.confirmed !== true || !Array.isArray(dto.ids) || !dto.ids.length || dto.ids.length > 100 || !['resolve', 'dismiss'].includes(dto.action)) {
      throw new BadRequestException('Confirm an action on 1 to 100 reports');
    }
    const uniqueIds = [...new Set(dto.ids)];
    const reports = await Promise.all(uniqueIds.map(async (id) => {
      try {
        return await this.issueReportsRepository.get(id);
      } catch (error) {
        if (error instanceof NotFoundException) return null;
        throw error;
      }
    }));
    if (new Set(reports.filter((report): report is IssueReport => report !== null).map((report) => report.type)).size > 1) {
      throw new BadRequestException('Bulk actions require reports of the same category');
    }
    const missingIds = new Set(uniqueIds.filter((_, index) => reports[index] === null));
    const items = await Promise.all(uniqueIds.map(async (id) => {
      try {
        if (missingIds.has(id)) throw new NotFoundException('Issue report not found');
        const result = dto.action === 'resolve'
          ? await this.adminResolveReport(actor, id, { reason: dto.reason, action: 'bulk_resolve' })
          : await this.adminDismissReport(actor, id, { reason: dto.reason, action: 'bulk_dismiss' });
        return { id, success: true as const, status: result.status };
      } catch (error) {
        return { id, success: false as const, error: error instanceof Error ? error.message : 'Report action failed' };
      }
    }));
    await this.auditService?.record(actor, `report.bulk.${dto.action}`, 'issue-report', 'bulk', uniqueIds);
    return { items };
  }


  async listComments(opportunityId: string) {
    opportunityId = (await this.opportunitiesRepository.getById(opportunityId))._id;
    const comments = await this.commentsRepository.list(opportunityId);
    return comments.map((comment) => this.toCommentResponse(comment));
  }

  async createComment(actor: Actor, opportunityId: string, dto: CreateOpportunityCommentDto) {
    opportunityId = (await this.opportunitiesRepository.getById(opportunityId))._id;
    const comment = await this.commentsRepository.create({
      opportunityId,
      authorId: actor.id,
      authorEmail: actor.email,
      body: dto.body,
      mentionUserIds: dto.mentionUserIds ?? [],
    });
    return this.toCommentResponse(comment);
  }

  async deleteComment(actor: Actor, opportunityId: string, commentId: string) {
    opportunityId = (await this.opportunitiesRepository.getById(opportunityId))._id;
    const comment = await this.commentsRepository.findById(commentId);
    if (!comment || comment.opportunityId !== opportunityId) {
      throw new ForbiddenException('Comment does not belong to this opportunity');
    }
    if (actor.role !== 'Admin' && comment.authorId !== actor.id) {
      throw new ForbiddenException('Only the comment owner or Admin can delete this comment');
    }
    await this.commentsRepository.softDelete(commentId, actor.id);
    return { success: true };
  }

  async bulk(actor: Actor, dto: BulkOpportunityActionDto) {
    const results = [];
    for (const id of dto.ids) {
      const update: UpdatePersonalStateDto = this.bulkToPersonalDto(dto);
      results.push(await this.updatePersonal(actor, id, update));
    }
    return { success: true, items: results };
  }

  async adminApplyCorrection(actor: Actor, id: string, field: keyof Opportunity, value: unknown, reason?: string) {
    if (actor.role !== 'Admin') throw new ForbiddenException('Admin role required');
    const opportunity = await this.opportunitiesRepository.getById(id);
    const updated = await this.opportunitiesRepository.update(id, {
      [field]: value,
      adminCorrections: [
        ...(opportunity.adminCorrections ?? []),
        { field: String(field), value, reason, correctedBy: actor.id, correctedAt: new Date(), pinned: true },
      ],
    } as Partial<Opportunity>);
    await this.enqueueSearchIndex(updated._id);
    return updated;
  }

  async adminMerge(actor: Actor, targetId: string, duplicateId: string) {
    if (actor.role !== 'Admin') throw new ForbiddenException('Admin role required');
    if (!this.mergesRepository) throw new ConflictException('Opportunity merge repository is unavailable');
    const merged = await this.mergesRepository.merge(targetId, duplicateId, { actorId: actor.id });
    await this.deduplicationService?.reconcileMergeEffects();
    return merged;
  }

  async ingestOrUpsert(input: IngestOpportunityInput, actor?: Actor): Promise<IngestOpportunityResult> {
    const now = new Date();
    const occurrence = this.toOccurrence(input, now);
    const existing = await this.opportunitiesRepository.findByOccurrence(input.sourceId, input.externalId, input.url);
    const patch = this.toOpportunityPatch(input, now, actor?.id);
    const { firstSeenAt: _firstSeenAt, ...existingPatch } = patch;
    const opportunity = existing
      ? await this.opportunitiesRepository.upsertOccurrence(existing._id, occurrence, existingPatch)
      : await this.opportunitiesRepository.create({ ...patch, sourceOccurrences: [occurrence] });

    const revision = createHash('sha256').update(JSON.stringify(this.canonicalRevisionFacts(opportunity))).digest('hex');
    await Promise.all([this.enqueueIngestionMatch(opportunity._id, revision, {
      effectMode: input.sourceRunEffectMode,
      sourceRunId: input.sourceRunId,
      sourceId: input.sourceId,
    }), this.enqueueSearchIndex(opportunity._id, revision)]);

    if (this.deduplicationService && this.jobsService) await this.jobsService.enqueue('dedup', 'opportunity.deduplicate', { opportunityId: opportunity._id }, { jobId: `duplicate:${opportunity._id}:${revision}` });
    return {
      opportunity,
      created: !existing,
      occurrenceAdded: !existing || !existing.sourceOccurrences.some((item) => this.sameOccurrence(item, occurrence)),
      matchedProfileIds: [],
    };
  }

  async repairRetainedSourceOccurrence(input: RetainedSourceOccurrenceRepairServiceInput): Promise<RetainedSourceOccurrenceRepairResult> {
    const occurrence = input.normalized.sourceOccurrences.find((item) =>
      item.sourceId === input.sourceId &&
      item.externalId === input.externalId &&
      item.url === input.url,
    );
    if (!occurrence) throw new ConflictException('Retained repair normalized occurrence identity no longer matches');
    const updated = await this.opportunitiesRepository.repairRetainedSourceOccurrenceExact({
      opportunityId: input.opportunityId,
      sourceId: input.sourceId,
      externalId: input.externalId,
      url: input.url,
      expectedOccurrenceRevision: input.expectedOccurrenceRevision,
      occurrencePatch: {
        publishedAt: occurrence.publishedAt,
        status: occurrence.status,
        normalizedSnapshot: {
          ...(input.normalized.deadline ? { deadline: input.normalized.deadline } : {}),
          money: input.normalized.money ?? {},
          sourceStatus: input.normalized.sourceStatus,
        },
      },
      canonicalPatch: this.toOpportunityPatchFromNormalized(input.normalized),
    });
    if (!updated) throw new ConflictException('Retained source occurrence identity no longer matches an unmerged opportunity');
    const revision = createHash('sha256').update(JSON.stringify(this.canonicalRevisionFacts(updated))).digest('hex');
    await Promise.all([
      this.enqueueIngestionMatch(updated._id, revision, { effectMode: 'historical', sourceRunId: input.sourceRunId, sourceId: input.sourceId }),
      this.enqueueSearchIndex(updated._id, revision),
    ]);
    return { opportunity: updated, repaired: true };
  }

  async markSourceOccurrenceRemoved(input: MarkSourceOccurrenceRemovedInput): Promise<{ opportunityId: string; sourceStatus: SourceStatus }> {
    const observedAt = new Date(input.observedAt);
    if (!input.sourceId?.trim() || !input.externalId?.trim() || !input.opportunityId?.trim() ||
      !input.runId?.trim() || !input.reason?.trim() || !this.safeUrl(input.url) || !Number.isFinite(observedAt.getTime())) {
      throw new BadRequestException('A confirmed source removal requires an exact identity and observation time');
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.opportunitiesRepository.getById(input.opportunityId);
      const occurrence = current.sourceOccurrences.find((item) => item.sourceId === input.sourceId && item.externalId === input.externalId && item.url === input.url);
      if (current.mergedIntoOpportunityId || !occurrence) throw new ConflictException('Source removal identity no longer matches an unmerged opportunity');
      const updated = occurrence.status === 'Removed'
        ? current
        : await this.opportunitiesRepository.markSourceOccurrenceRemovedExact({ ...input, observedAt });
      if (!updated) continue;
      const revision = createHash('sha256').update(JSON.stringify(this.canonicalRevisionFacts(updated))).digest('hex');
      await Promise.all([this.enqueueIngestionMatch(updated._id, revision, { effectMode: 'fresh', sourceRunId: input.runId, sourceId: input.sourceId }), this.enqueueSearchIndex(updated._id, revision)]);
      return { opportunityId: updated._id, sourceStatus: updated.sourceStatus };
    }
    throw new ConflictException('Opportunity changed while recording confirmed source removal');
  }

  private canonicalRevisionFacts(opportunity: Opportunity): unknown[] {
    return [
      opportunity.type,
      opportunity.title,
      opportunity.companyOrClient,
      opportunity.description,
      opportunity.language,
      this.arrayForRevision(opportunity.skills),
      this.arrayForRevision(opportunity.technologies),
      opportunity.seniority,
      opportunity.employmentType,
      opportunity.location,
      opportunity.remoteType,
      opportunity.relocation,
      this.arrayForRevision(opportunity.countriesAllowed),
      this.moneyForRevision(opportunity.money),
      this.dateForRevision(opportunity.deadline),
      this.dateForRevision(opportunity.publishedAt),
      opportunity.sourceStatus,
      this.arrayForRevision(opportunity.canonicalTags),
    ];
  }

  private arrayForRevision(value: string[] | null | undefined): string[] {
    return Array.isArray(value) ? value : [];
  }

  private moneyForRevision(value: Opportunity['money'] | null | undefined): Opportunity['money'] {
    if (!value) return {};
    return {
      ...(value.originalText ? { originalText: value.originalText } : {}),
      ...(Number.isFinite(value.min) ? { min: value.min } : {}),
      ...(Number.isFinite(value.max) ? { max: value.max } : {}),
      ...(value.currency ? { currency: value.currency } : {}),
      ...(value.period ? { period: value.period } : {}),
      ...(value.kind ? { kind: value.kind } : {}),
    };
  }

  private dateForRevision(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  private parseImportRows(buffer: Buffer, mimeType: string, filename: string): Record<string, unknown>[] {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!text) return [];
    if (mimeType === 'application/json' || filename.toLowerCase().endsWith('.json')) {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
      if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown[] }).items)) {
        return (parsed as { items: unknown[] }).items.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);
      }
      throw new BadRequestException('JSON import expects an array or { items: [] }');
    }
    if (mimeType === 'text/plain' || mimeType === 'text/markdown' || /\.(csv|tsv|txt|md)$/i.test(filename)) {
      return this.parseDelimited(text, filename.toLowerCase().endsWith('.tsv') ? '\t' : ',');
    }
    return [{ unsupportedMimeType: mimeType, originalName: filename }];
  }

  private parseDelimited(text: string, separator: ',' | '\t'): Record<string, unknown>[] {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return [];
    const header = this.parseCsvLine(lines[0], separator).map((item) => item.trim());
    if (!header.some((item) => ['title', 'url', 'description', 'type'].includes(item))) {
      throw new BadRequestException('Delimited import requires header columns');
    }
    return lines.slice(1).map((line) => {
      const cells = this.parseCsvLine(line, separator);
      return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? '']));
    });
  }

  private parseCsvLine(line: string, separator: ',' | '\t'): string[] {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === separator && !quoted) {
        cells.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells.map((cell) => cell.trim());
  }

  private rowToIngest(row: Record<string, unknown>, dto: ImportFileDto, rowNumber: number): IngestOpportunityInput {
    if (row.unsupportedMimeType) throw new Error(`Unsupported file type for direct opportunity import: ${String(row.unsupportedMimeType)}`);
    const title = this.stringField(row, 'title');
    const url = this.stringField(row, 'url') ?? this.stringField(row, 'sourceUrl');
    const type = (this.stringField(row, 'type') ?? dto.type) as OpportunityType | undefined;
    if (!title) throw new Error('title is required');
    if (!url) throw new Error('url is required');
    if (!type || !['vacancy', 'freelance', 'tender'].includes(type)) throw new Error('valid type is required');
    const sourceId = this.stringField(row, 'sourceId') ?? dto.sourceId ?? 'file-import';
    return {
      type,
      title,
      companyOrClient: this.stringField(row, 'companyOrClient') ?? this.stringField(row, 'company') ?? this.stringField(row, 'client'),
      description: this.stringField(row, 'description') ?? '',
      summary: this.stringField(row, 'summary'),
      language: this.stringField(row, 'language'),
      skills: this.arrayField(row, 'skills'),
      technologies: this.arrayField(row, 'technologies'),
      seniority: this.stringField(row, 'seniority'),
      employmentType: this.stringField(row, 'employmentType'),
      location: this.stringField(row, 'location'),
      remoteType: this.stringField(row, 'remoteType'),
      countriesAllowed: this.arrayField(row, 'countriesAllowed'),
      money: this.moneyFromRow(row),
      deadline: this.stringField(row, 'deadline'),
      publishedAt: this.stringField(row, 'publishedAt'),
      sourceId,
      externalId: this.stringField(row, 'externalId') ?? `${dto.fileId}:${rowNumber}`,
      url,
      rawPayload: row,
      sourceMetadata: { importFileId: dto.fileId },
      canonicalTags: this.arrayField(row, 'tags'),
    };
  }

  private stringField(row: Record<string, unknown>, key: string): string | undefined {
    const value = row[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private arrayField(row: Record<string, unknown>, key: string): string[] {
    const value = row[key];
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
    return [];
  }

  private moneyFromRow(row: Record<string, unknown>): Opportunity['money'] {
    const originalText = this.stringField(row, 'money') ?? this.stringField(row, 'moneyText');
    const min = this.numberField(row, 'moneyMin');
    const max = this.numberField(row, 'moneyMax');
    const currency = this.stringField(row, 'currency');
    return { ...(originalText ? { originalText } : {}), ...(typeof min === 'number' ? { min } : {}), ...(typeof max === 'number' ? { max } : {}), ...(currency ? { currency } : {}) };
  }

  private numberField(row: Record<string, unknown>, key: string): number | undefined {
    const value = row[key];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private toOccurrence(input: IngestOpportunityInput, now: Date): SourceOccurrence {
    return {
      sourceId: input.sourceId,
      externalId: input.externalId,
      url: input.url,
      primary: true,
      firstSeenAt: now,
      lastSeenAt: now,
      publishedAt: this.toDate(input.publishedAt),
      checksum: input.checksum,
      status: input.sourceStatus ?? 'Unknown',
      rawPayload: input.rawPayload ?? {},
      sourceMetadata: {
        ...(input.sourceMetadata ?? {}),
        ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
        ...(input.sourceRunEffectMode ? { sourceRunEffectMode: input.sourceRunEffectMode } : {}),
      },
      normalizedSnapshot: {
        ...(this.toDate(input.deadline) ? { deadline: this.toDate(input.deadline) } : {}),
        ...(input.money ? { money: input.money } : {}),
        sourceStatus: input.sourceStatus ?? 'Unknown',
      },
    };
  }

  private toOpportunityPatchFromNormalized(input: NormalizedOpportunityInput): Partial<Opportunity> {
    return {
      type: input.type,
      title: input.title,
      companyOrClient: input.companyOrClient ?? '',
      description: input.description ?? '',
      language: input.language,
      skills: input.skills ?? [],
      technologies: input.technologies ?? [],
      seniority: input.seniority,
      employmentType: input.employmentType,
      location: input.location,
      remoteType: input.remoteType,
      money: input.money ?? {},
      deadline: input.deadline,
      publishedAt: input.publishedAt,
      sourceStatus: input.sourceStatus ?? 'Unknown',
      vacancyData: input.vacancyData ?? {},
      freelanceData: input.freelanceData ?? {},
      tenderData: input.tenderData ?? {},
      canonicalTags: input.canonicalTags ?? [],
    };
  }

  private toOpportunityPatch(input: IngestOpportunityInput, now: Date, importedByUserId?: string): Partial<Opportunity> {
    return {
      type: input.type,
      title: input.title,
      companyOrClient: input.companyOrClient ?? '',
      description: input.description ?? '',
      summary: input.summary,
      language: input.language,
      skills: input.skills ?? [],
      technologies: input.technologies ?? [],
      seniority: input.seniority,
      employmentType: input.employmentType,
      location: input.location,
      remoteType: input.remoteType,
      relocation: input.relocation,
      countriesAllowed: input.countriesAllowed ?? [],
      money: input.money ?? {},
      deadline: this.toDate(input.deadline),
      publishedAt: this.toDate(input.publishedAt),
      firstSeenAt: now,
      lastSeenAt: now,
      sourceStatus: input.sourceStatus ?? 'Unknown',
      vacancyData: input.vacancyData ?? {},
      freelanceData: input.freelanceData ?? {},
      tenderData: input.tenderData ?? {},
      canonicalTags: input.canonicalTags ?? [],
      importedByUserId,
    };
  }

  private exportRow(opportunity: OpportunityExportCandidate, state: OpportunityUserState | undefined, includePersonalData: boolean, matchScore?: number, ai?: LatestAiProjection): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: opportunity._id,
      type: opportunity.type,
      title: opportunity.title,
      companyOrClient: opportunity.companyOrClient,
      summary: opportunity.summary ?? '',
      description: opportunity.description ?? '',
      skills: opportunity.skills.join(', '),
      technologies: opportunity.technologies.join(', '),
      seniority: opportunity.seniority ?? '',
      employmentType: opportunity.employmentType ?? '',
      location: opportunity.location ?? '',
      remoteType: opportunity.remoteType ?? '',
      moneyMin: opportunity.money?.min ?? '',
      moneyMax: opportunity.money?.max ?? '',
      currency: opportunity.money?.currency ?? '',
      sourceStatus: opportunity.sourceStatus,
      sourceIds: opportunity.sourceOccurrences.map((item) => item.sourceId).join(', '),
      urls: opportunity.sourceOccurrences.map((item) => item.url).filter(Boolean).join(', '),
      publishedAt: opportunity.publishedAt?.toISOString?.() ?? '',
      firstSeenAt: opportunity.firstSeenAt?.toISOString?.() ?? '',
      deadline: opportunity.deadline?.toISOString?.() ?? '',
      tags: opportunity.canonicalTags.join(', '),
    };
    if (includePersonalData) {
      base.matchScore = state?.matchScore ?? '';
      base.pipelineStatus = state?.pipelineStatus ?? 'New';
      base.favorite = state?.favorite ?? false;
      base.hidden = state?.hidden ?? false;
      base.archived = state?.archived ?? false;
      base.personalTags = state?.tags.join(', ') ?? '';
      base.aiScore = ai?.aiScore ?? '';
      base.aiRunId = ai?.runId ?? '';
    }
    if (includePersonalData && typeof matchScore === 'number') base.matchScore = matchScore;
    return base;
  }

  private toListItem(opportunity: Opportunity, state?: OpportunityUserState, ai?: LatestAiProjection, matchScore?: number | null) {
    return {
      ...this.toResponse(opportunity),
      matchScore: matchScore ?? state?.matchScore ?? null,
      aiScore: ai?.aiScore ?? null,
      latestAiAnalysis: ai ? this.toSafeAiProjection(ai) : null,
      pipelineStatus: state?.pipelineStatus ? normalizePipelineStatus(opportunity.type, state.pipelineStatus).status : null,
      rawPipelineStatus: state?.pipelineStatus ?? null,
      favorite: state?.favorite ?? false,
      hidden: state?.hidden ?? false,
      archived: state?.archived ?? false,
      tags: state?.tags ?? [],
    };
  }

  private toResponse(opportunity: Opportunity) {
    const { duplicateKeys: _duplicateKeys, duplicateIndexVersion: _duplicateIndexVersion, privateReferenceRevision: _privateReferenceRevision, ...publicOpportunity } = opportunity;
    const response = toPublic(publicOpportunity);
    const safeOccurrences = response.sourceOccurrences?.map((occurrence) => this.toSafeSourceOccurrence(occurrence)) ?? [];
    return {
      ...response,
      sourceOccurrences: safeOccurrences,
      dateMetadata: opportunityDateMetadata(opportunity),
      sourceDocuments: this.sourceDocuments(opportunity),
      criticalConflicts: this.criticalConflicts(opportunity),
      primaryCanonical: this.primaryCanonical(opportunity),
      pinnedAdminAnnotations: (opportunity.adminCorrections ?? []).filter((item) => item.pinned).map((item) => ({ field: item.field, value: item.value, reason: item.reason, correctedAt: item.correctedAt })),
    };
  }

  private toPersonalResponse(state: OpportunityUserState) {
    return toPublic(state);
  }


  private toAdminReportResponse(report: IssueReport, opportunity?: Opportunity, duplicateGroupCount = 1, users = new Map<string, User>()) {
    return {
      ...toPublic(report),
      reporter: this.toReportUser(users.get(report.userId)),
      assignee: report.assignedAdminId ? this.toReportUser(users.get(report.assignedAdminId)) : null,
      duplicateGroupCount,
      opportunity: opportunity
        ? {
            id: opportunity._id,
            title: opportunity.title,
            type: opportunity.type,
            sourceStatus: opportunity.sourceStatus,
            companyOrClient: opportunity.companyOrClient,
            url: opportunity.sourceOccurrences.find((item) => item.primary)?.url ?? opportunity.sourceOccurrences[0]?.url,
            sourcesCount: opportunity.sourceOccurrences.length,
            updatedAt: (opportunity as Opportunity & { updatedAt?: Date }).updatedAt,
          }
        : null,
    };
  }

  private async reportUsers(reports: IssueReport[]): Promise<Map<string, User>> {
    if (!this.usersRepository) return new Map();
    const ids = reports.flatMap((report) => [report.userId, report.assignedAdminId].filter(Boolean) as string[]);
    const users = await this.usersRepository.findByIds(ids);
    return new Map(users.map((user) => [user._id, user]));
  }

  private async reportSourceDiagnostics(opportunity: Opportunity) {
    const sourceIds = [...new Set(opportunity.sourceOccurrences.map((occurrence) => occurrence.sourceId))];
    let repository: SourcesRepository | undefined;
    try {
      repository = this.moduleRef?.get(SourcesRepository, { strict: false });
    } catch {
      // Standalone report consumers may not load the sources module.
    }
    const date = (value: Date | undefined) => value ? value.toISOString() : null;
    return Promise.all(sourceIds.map(async (sourceId) => {
      if (!repository) return { sourceId };
      try {
        const [source, run] = await Promise.all([repository.get(sourceId), repository.latestCollectionRun(sourceId)]);
        const stats = Object.fromEntries(['seen', 'normalized', 'upserted', 'created', 'updated', 'duplicates', 'failed']
          .filter((key) => Number.isFinite(run?.stats?.[key]))
          .map((key) => [key, run!.stats![key]]));
        return {
          sourceId,
          name: source.name,
          runtimeState: source.runtimeState,
          enabled: source.enabled,
          lastSuccessAt: date(source.lastSuccessAt),
          latestRun: run ? {
            id: run._id,
            status: run.status,
            startedAt: date(run.startedAt),
            finishedAt: date(run.finishedAt),
            stats,
          } : undefined,
        };
      } catch {
        // Diagnostics are supplementary; an unavailable source must not turn a saved triage action into a failed one.
        return { sourceId };
      }
    }));
  }

  private toReportUser(user?: User) {
    if (!user) return null;
    return { id: user._id, name: user.name, email: user.email, role: user.role, status: user.status };
  }

  private toReportOpportunityFields(opportunity: Opportunity) {
    return {
      title: opportunity.title,
      type: opportunity.type,
      companyOrClient: opportunity.companyOrClient,
      sourceStatus: opportunity.sourceStatus,
      money: opportunity.money,
      remoteType: opportunity.remoteType,
      location: opportunity.location,
      countriesAllowed: opportunity.countriesAllowed,
      skills: opportunity.skills,
      technologies: opportunity.technologies,
      canonicalTags: opportunity.canonicalTags,
      deadline: opportunity.deadline,
    };
  }

  private toCommentResponse(comment: OpportunityComment) {
    return toPublic(comment);
  }

  private toSafeSourceOccurrence(occurrence: SourceOccurrence) {
    const { rawPayload: _rawPayload, sourceMetadata: _sourceMetadata, ...safe } = occurrence;
    return safe;
  }


  private async resolveListProfile(actor: Actor, query: OpportunityListQueryDto): Promise<Profile | null> {
    if (query.profileScope === 'all' && !query.profileId) return null;
    return query.profileId
      ? this.profilesRepository.getOwned(query.profileId, actor.id)
      : this.profilesRepository.findActive(actor.id);
  }

  private async aiRestrictedIds(actor: Actor, query: OpportunityListQueryDto, profile: Profile | null, sortRules = this.sortRules(query)): Promise<string[] | undefined> {
    if (!profile) return undefined;
    if (typeof query.minAiScore !== 'number' && query.analyzed !== true && query.latestAI !== true && !this.hasSort(sortRules, 'highestAI')) return undefined;
    const rows = await this.opportunitiesRepository.latestCompletedAnalysisByOpportunity({
      userId: actor.id,
      profileId: profile._id,
      minAiScore: query.minAiScore,
    });
    return rows.map((row) => row.opportunityId);
  }

  private intersectOptionalIds(left?: string[], right?: string[]): string[] | undefined {
    if (!left) return right;
    if (!right) return left;
    const rightSet = new Set(right);
    return left.filter((id) => rightSet.has(id));
  }

  private async stateRestrictedIds(actor: Actor, query: OpportunityListQueryDto, profile: Profile | null, exportProjection = false): Promise<string[]> {
    const states = await this.statesRepository.findMatchingStates(actor.id, {
      profileId: profile?._id,
      favorite: query.favorite,
      hidden: query.hidden,
      archived: query.archived,
      minMatch: profile ? undefined : query.minMatch,
      tags: query.tags,
    }, exportProjection ? { opportunityId: 1, pipelineStatus: 1, pipelineEvents: 1 } : undefined);
    if (!states.length) return [];
    const opportunities: Array<Pick<Opportunity, '_id' | 'type'>> = [];
    if (exportProjection) {
      const ids = [...new Set(states.map((state) => state.opportunityId))];
      for (let offset = 0; offset < ids.length; offset += EXPORT_BATCH_SIZE) {
        opportunities.push(...await this.opportunitiesRepository.findTypesByIds(ids.slice(offset, offset + EXPORT_BATCH_SIZE)));
      }
    } else {
      opportunities.push(...await this.opportunitiesRepository.findByIds(states.map((state) => state.opportunityId)));
    }
    const byId = new Map(opportunities.map((opportunity) => [opportunity._id, opportunity]));
    const from = this.pipelineBoundaryDate(query.pipelineReachedFrom, 'from');
    const to = this.pipelineBoundaryDate(query.pipelineReachedTo, 'to');
    const filtered = states.filter((state) => {
      const opportunity = byId.get(state.opportunityId);
      if (!opportunity) return false;
      if (query.pipelineStatuses?.length && !pipelineStatusMatches(opportunity.type, state.pipelineStatus, query.pipelineStatuses)) return false;
      if (query.pipelineReachedStatuses?.length) {
        const reachedAt = earliestPipelineReachedAtForType(opportunity.type, state.pipelineEvents, query.pipelineReachedStatuses);
        if (!reachedAt) return false;
        if (from && +reachedAt < +from) return false;
        if (to && +reachedAt > +to) return false;
      }
      return true;
    });
    return Array.from(new Set(filtered.map((state) => state.opportunityId)));
  }

  private pipelineBoundaryDate(value: string | undefined, edge: 'from' | 'to'): Date | null {
    if (!value) return null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T${edge === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`) : new Date(value);
    return Number.isFinite(+date) ? date : null;
  }

  private async latestAiMap(userId: string, profileId: string, opportunityIds: string[]): Promise<Map<string, LatestAiProjection>> {
    if (!opportunityIds.length) return new Map();
    const rows = await this.opportunitiesRepository.latestCompletedAnalysisByOpportunity({ userId, profileId, opportunityIds });
    return new Map(rows.map((row) => [row.opportunityId, row]));
  }

  private async privateSortedPage(actor: Actor, query: OpportunityListQueryDto, profile: Profile, restrictIds: string[] | undefined, sortRules: OpportunitySortDto[]) {
    const limit = Math.min(query.limit ?? 50, 100);
    const rules: OpportunitySortDto[] = sortRules.length ? sortRules : [{ field: 'firstSeenAt', direction: 'desc' }];
    const baseQuery = { ...query, cursor: undefined, sort: undefined, sorts: undefined, advancedSort: undefined, minMatch: undefined };
    const cursorId = query.cursor ? this.privateCursorId(query.cursor) : undefined;
    let anchor: PrivateRankedCandidate | undefined;
    if (cursorId && (!restrictIds || restrictIds.includes(cursorId))) {
      for await (const batch of this.opportunitiesRepository.iteratePrivateSortCandidates(baseQuery, [cursorId])) {
        [anchor] = await this.rankPrivateCandidates(actor, query, profile, rules, batch);
      }
    }
    const ordered: PrivateRankedCandidate[] = [];
    const firstPage: PrivateRankedCandidate[] = [];
    let anchorSeen = false;
    let total = 0;
    for await (const batch of this.opportunitiesRepository.iteratePrivateSortCandidates(baseQuery, restrictIds)) {
      const ranked = await this.rankPrivateCandidates(actor, query, profile, rules, batch);
      total += ranked.length;
      for (const candidate of ranked) {
        if (anchor) {
          this.retainPageCandidate(firstPage, candidate, rules, limit + 1);
          if (candidate.id === anchor.id) anchorSeen = true;
        }
        if (anchor && this.compareRankedCandidates(candidate, anchor, rules) <= 0) continue;
        this.retainPageCandidate(ordered, candidate, rules, limit + 1);
      }
    }
    const page = anchor && !anchorSeen ? firstPage : ordered;
    const pageRanks = page.slice(0, limit);
    const opportunities = pageRanks.length ? await this.opportunitiesRepository.findByIds(pageRanks.map((item) => item.id)) : [];
    const byId = new Map(opportunities.map((item) => [item._id, item]));
    return {
      items: pageRanks.flatMap((rank) => {
        const opportunity = byId.get(rank.id);
        return opportunity ? [this.toListItem(opportunity, rank.state, rank.ai, rank.matchScore)] : [];
      }),
      nextCursor: page.length > limit ? this.encodePrivateCursor({ _id: pageRanks[pageRanks.length - 1].id }) : null,
      total,
    };
  }

  private async rankPrivateCandidates(actor: Actor, query: OpportunityListQueryDto, profile: Profile, rules: OpportunitySortDto[], candidates: OpportunitySortCandidate[]): Promise<PrivateRankedCandidate[]> {
    const ids = candidates.map((item) => item._id);
    const [states, aiRows] = await Promise.all([
      this.statesRepository.findForList(actor.id, ids, profile._id),
      this.opportunitiesRepository.latestCompletedAnalysisByOpportunity({ userId: actor.id, profileId: profile._id, opportunityIds: ids, minAiScore: query.minAiScore }),
    ]);
    const stateMap = new Map(states.map((state) => [state.opportunityId, state]));
    const aiMap = new Map(aiRows.map((row) => [row.opportunityId, row]));
    const scores = new Map(candidates.map((item) => [item._id, this.effectiveMatchScore(item, stateMap.get(item._id), profile)]));
    return candidates.flatMap((item) => {
      const matchScore = scores.get(item._id)!;
      if (typeof query.minMatch === 'number' && matchScore < query.minMatch) return [];
      return [{ id: item._id, values: rules.map((rule) => this.sortValue(item, rule.field, stateMap, aiMap, scores)), matchScore, state: stateMap.get(item._id), ai: aiMap.get(item._id) }];
    });
  }

  private compareRankedCandidates(left: Pick<PrivateRankedCandidate, 'id' | 'values'>, right: Pick<PrivateRankedCandidate, 'id' | 'values'>, rules: OpportunitySortDto[]): number {
    for (const [index, rule] of rules.entries()) {
      const compared = this.compareSortValues(left.values[index], right.values[index], rule.direction);
      if (compared !== 0) return compared;
    }
    return left.id.localeCompare(right.id);
  }

  private retainPageCandidate(items: PrivateRankedCandidate[], candidate: PrivateRankedCandidate, rules: OpportunitySortDto[], limit: number): void {
    if (items.length === limit && this.compareRankedCandidates(candidate, items[items.length - 1], rules) >= 0) return;
    let start = 0;
    let end = items.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (this.compareRankedCandidates(candidate, items[middle], rules) < 0) end = middle;
      else start = middle + 1;
    }
    items.splice(start, 0, candidate);
    if (items.length > limit) items.pop();
  }

  private effectiveMatchScore(opportunity: OpportunitySortCandidate, state: OpportunityUserState | undefined, profile: Profile): number {
    return state?.matchScore ?? this.matchingService.calculate(opportunity, profile).score;
  }

  private toSafeAiProjection(ai: LatestAiProjection) {
    return {
      id: ai.runId,
      taskType: ai.taskType,
      aiScore: ai.aiScore,
      completedAt: ai.completedAt?.toISOString?.() ?? ai.createdAt?.toISOString?.() ?? null,
    };
  }


  private sortRules(query: OpportunityListQueryDto): OpportunitySortDto[] {
    if (query.sorts?.length) return query.sorts.slice(0, 4);
    if (query.advancedSort) {
      try {
        const parsed = JSON.parse(query.advancedSort) as unknown;
        if (Array.isArray(parsed)) {
          return parsed
            .filter((item): item is OpportunitySortDto =>
              typeof item === 'object' &&
              item !== null &&
              typeof (item as OpportunitySortDto).field === 'string' &&
              ((item as OpportunitySortDto).direction === 'asc' || (item as OpportunitySortDto).direction === 'desc'),
            )
            .slice(0, 4);
        }
      } catch {
        return [];
      }
    }
    if (query.sort) return [this.defaultSortRule(query.sort)];
    return [];
  }

  private defaultSortRule(sort: OpportunitySortField): OpportunitySortDto {
    if (sort === 'deadline' || sort === 'deadline-soon') return { field: sort, direction: 'asc' };
    if (sort === 'title' || sort === 'sourceStatus') return { field: sort, direction: 'asc' };
    return { field: sort, direction: 'desc' };
  }

  private needsPrivateSortedPage(sortRules: OpportunitySortDto[], query: OpportunityListQueryDto): boolean {
    return (
      typeof query.minMatch === 'number' ||
      this.hasSort(sortRules, 'highestAI') ||
      this.hasSort(sortRules, 'matchScore') ||
      this.hasSort(sortRules, 'recommended') ||
      this.hasSort(sortRules, 'best-match')
    );
  }

  private hasSort(sortRules: OpportunitySortDto[], field: string): boolean {
    return sortRules.some((sort) => sort.field === field);
  }

  private hasStateOnlyRestriction(query: OpportunityListQueryDto): boolean {
    return (
      query.trackedOnly === true ||
      query.favorite !== undefined ||
      query.hidden !== undefined ||
      query.archived !== undefined ||
      Boolean(query.pipelineStatuses?.length) ||
      Boolean(query.pipelineReachedStatuses?.length) ||
      Boolean(query.tags?.length)
    );
  }

  private sortValue(opportunity: OpportunitySortCandidate, field: string, states: Map<string, OpportunityUserState>, aiRows: Map<string, LatestAiProjection>, matchScores: Map<string, number>): string | number | null {
    switch (field) {
      case 'highestAI':
        return aiRows.get(opportunity._id)?.aiScore ?? null;
      case 'matchScore':
      case 'recommended':
      case 'best-match':
        return matchScores.get(opportunity._id) ?? states.get(opportunity._id)?.matchScore ?? null;
      case 'moneyMax':
      case 'highest-pay':
        return opportunity.money?.max ?? null;
      case 'deadline':
      case 'deadlineAt':
      case 'deadline-soon':
        return opportunity.deadline ? new Date(opportunity.deadline).getTime() : null;
      case 'publishedAt':
      case 'newest':
        return opportunity.publishedAt ? new Date(opportunity.publishedAt).getTime() : null;
      case 'updatedAt':
        return opportunity.updatedAt ? new Date(opportunity.updatedAt).getTime() : null;
      case 'title':
        return opportunity.title ?? '';
      case 'sourceStatus':
        return opportunity.sourceStatus ?? '';
      case 'firstSeenAt':
      default:
        return opportunity.firstSeenAt ? new Date(opportunity.firstSeenAt).getTime() : null;
    }
  }

  private compareSortValues(left: string | number | null, right: string | number | null, direction: 'asc' | 'desc'): number {
    const leftMissing = left === null || left === undefined || left === '';
    const rightMissing = right === null || right === undefined || right === '';
    if (leftMissing && rightMissing) return 0;
    if (leftMissing) return 1;
    if (rightMissing) return -1;
    const base = typeof left === 'string' || typeof right === 'string' ? String(left).localeCompare(String(right)) : Number(left) - Number(right);
    return direction === 'asc' ? base : -base;
  }

  private compareRepositorySortValues(left: string | number | null, right: string | number | null, direction: 'asc' | 'desc'): number {
    const leftMissing = left === null || left === undefined || left === '';
    const rightMissing = right === null || right === undefined || right === '';
    if (leftMissing && rightMissing) return 0;
    if (leftMissing) return direction === 'asc' ? -1 : 1;
    if (rightMissing) return direction === 'asc' ? 1 : -1;
    const base = typeof left === 'string' || typeof right === 'string' ? String(left).localeCompare(String(right)) : Number(left) - Number(right);
    return direction === 'asc' ? base : -base;
  }

  private encodePrivateCursor(item: Pick<Opportunity, '_id'>): string | null {
    return item ? Buffer.from(JSON.stringify({ privateSort: true, id: item._id })).toString('base64url') : null;
  }

  private privateCursorId(cursor: string): string | undefined {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: string };
      return typeof decoded?.id === 'string' && decoded.id ? decoded.id : undefined;
    } catch {
      return undefined;
    }
  }

  private primaryCanonical(opportunity: Opportunity) {
    return {
      deadline: opportunity.deadline?.toISOString?.() ?? null,
      money: opportunity.money ?? {},
      sourceStatus: opportunity.sourceStatus,
      primarySource: opportunity.sourceOccurrences.length ? this.toSafeSourceOccurrence(opportunity.sourceOccurrences.find((item) => item.primary) ?? opportunity.sourceOccurrences[0]) : null,
    };
  }

  private criticalConflicts(opportunity: Opportunity) {
    const fields = [
      { field: 'deadline', canonical: opportunity.deadline?.toISOString?.() ?? null, read: (occurrence: SourceOccurrence) => occurrence.normalizedSnapshot && 'deadline' in occurrence.normalizedSnapshot ? (occurrence.normalizedSnapshot.deadline ? new Date(occurrence.normalizedSnapshot.deadline).toISOString() : null) : undefined },
      { field: 'money', canonical: this.stableJson(opportunity.money ?? {}), read: (occurrence: SourceOccurrence) => occurrence.normalizedSnapshot && 'money' in occurrence.normalizedSnapshot ? this.stableJson(occurrence.normalizedSnapshot.money ?? {}) : undefined },
      { field: 'sourceStatus', canonical: opportunity.sourceStatus, read: (occurrence: SourceOccurrence) => occurrence.normalizedSnapshot?.sourceStatus ?? occurrence.status ?? 'Unknown' },
    ];
    return fields.flatMap(({ field, canonical, read }) => {
      const occurrences = opportunity.sourceOccurrences.map((occurrence) => ({
        sourceId: occurrence.sourceId,
        url: this.safeUrl(occurrence.url),
        primary: occurrence.primary,
        lastSeenAt: occurrence.lastSeenAt?.toISOString?.() ?? null,
        value: read(occurrence),
      })).filter((item) => item.value !== undefined);
      if (!occurrences.length) return [];
      const values = new Set(occurrences.map((item) => String(item.value ?? '')));
      const hasConflict = values.size > 1 || occurrences.some((item) => String(item.value ?? '') !== String(canonical ?? ''));
      return hasConflict ? [{ field, severity: 'critical', canonical: field === 'money' ? opportunity.money ?? {} : canonical, occurrences }] : [];
    });
  }

  private sourceDocuments(opportunity: Opportunity) {
    return opportunity.sourceOccurrences.flatMap((occurrence) => {
      const documents: { kind: 'url' | 'file'; sourceId: string; label: string; url?: string; fileId?: string }[] = [];
      const url = this.safeUrl(occurrence.url);
      if (url) documents.push({ kind: 'url', sourceId: occurrence.sourceId, label: occurrence.sourceId, url });
      const fileId = typeof occurrence.sourceMetadata?.importFileId === 'string' ? occurrence.sourceMetadata.importFileId : undefined;
      if (fileId) documents.push({ kind: 'file', sourceId: occurrence.sourceId, label: 'Импортированный файл', fileId });
      const nativeDocuments = occurrence.sourceMetadata?.sourceDocuments;
      if (Array.isArray(nativeDocuments)) {
        for (const document of nativeDocuments) {
          if (!document || typeof document !== 'object' || Array.isArray(document)) continue;
          const native = document as Record<string, unknown>;
          const documentUrl = typeof native.url === 'string' ? this.safeUrl(native.url) : undefined;
          if (!documentUrl || documents.some((existing) => existing.url === documentUrl)) continue;
          const label = typeof native.label === 'string' && native.label.trim() ? native.label.trim() : occurrence.sourceId;
          documents.push({ kind: 'url', sourceId: occurrence.sourceId, label, url: documentUrl });
        }
      }
      return documents;
    });
  }

  private safeUrl(url?: string): string | undefined {
    if (!url || !/^https?:\/\//i.test(url)) return undefined;
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? url : undefined;
    } catch {
      return undefined;
    }
  }

  private stableJson(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value ?? null);
    return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))));
  }

  private async applySavedView(actor: Actor, query: OpportunityListQueryDto): Promise<OpportunityListQueryDto> {
    const viewId = query.viewId ?? query.savedViewId;
    if (!viewId || !this.savedViewsRepository) return query;
    const view = await this.savedViewsRepository.getById(viewId);
    if (actor.role !== 'Admin' && view.userId !== actor.id) throw new ForbiddenException('Saved view access denied');
    const savedQuery = this.pickOpportunityQuery(view.query);
    const savedFilters = this.pickOpportunityQuery(view.filters);
    const savedSort = this.pickOpportunityQuery(view.sort);
    const explicitQuery = this.pickOpportunityQuery(query);
    return { ...savedQuery, ...savedFilters, ...savedSort, ...explicitQuery, viewId: undefined, savedViewId: undefined };
  }

  private pickOpportunityQuery(input: unknown): Partial<OpportunityListQueryDto> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const allowed = new Set([
      'type', 'types', 'query', 'profileId', 'sourceIds', 'excludeSourceIds', 'sourceGroups', 'sourceGroup',
      'skills', 'technologies', 'seniority', 'employmentTypes', 'remoteType', 'locations', 'countriesAllowed',
      'currency', 'moneyPeriod', 'moneyKind', 'moneyMin', 'moneyMax', 'includeMissingMoney', 'publishedFrom', 'publishedTo', 'firstSeenFrom',
      'firstSeenTo', 'deadlineFrom', 'deadlineTo', 'updatedFrom', 'updatedTo', 'hasDeadline', 'multipleSources',
      'manualOnly', 'importedOnly', 'descriptionContains', 'language', 'status', 'archive', 'favorite', 'hidden',
      'archived', 'pipelineStatuses', 'tags', 'minMatch', 'minAiScore', 'analyzed', 'latestAI', 'sort', 'sorts',
      'advancedSort', 'cursor', 'limit',
    ]);
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key, value]) => allowed.has(key) && value !== undefined)) as Partial<OpportunityListQueryDto>;
  }

  private assertPipelineStatusAllowed(type: OpportunityType, status?: UpdatePersonalStateDto['pipelineStatus']): void {
    if (!status) return;
    if (!isPipelineStageForType(type, status)) {
      throw new BadRequestException({ code: 'PIPELINE_STATUS_INVALID', message: `Pipeline status ${status} is not valid for ${type} opportunities`, details: { type, status } });
    }
  }

  private needsStateRestriction(query: OpportunityListQueryDto): boolean {
    return (
      query.trackedOnly === true ||
      typeof query.favorite === 'boolean' ||
      typeof query.hidden === 'boolean' ||
      typeof query.archived === 'boolean' ||
      typeof query.minMatch === 'number' ||
      Boolean(query.pipelineStatuses?.length) ||
      Boolean(query.pipelineReachedStatuses?.length) ||
      Boolean(query.tags?.length)
    );
  }

  private sameOccurrence(left: SourceOccurrence, right: SourceOccurrence): boolean {
    if (left.sourceId !== right.sourceId) return false;
    if (left.externalId && right.externalId) return left.externalId === right.externalId;
    return left.url === right.url;
  }

  private toDate(value?: Date | string): Date | undefined {
    return value ? new Date(value) : undefined;
  }

  private async handleProfileRecalculateMatch(data: Record<string, unknown>) {
    const profileId = typeof data.profileId === 'string' ? data.profileId : '';
    const userId = typeof data.userId === 'string' ? data.userId : '';
    if (!profileId || !userId) throw new Error('profile.recalculateMatch requires profileId and userId');
    const profile = await this.profilesRepository.getById(profileId);
    if (profile.userId !== userId) throw new Error('Profile owner mismatch');
    const opportunities = await this.opportunitiesRepository.findActiveForMatching();
    let matched = 0;
    for (const opportunity of opportunities) {
      const match = this.matchingService.calculate(opportunity, profile);
      await this.statesRepository.upsert({
        userId: profile.userId,
        opportunityId: opportunity._id,
        profileId: profile._id,
        matchScore: match.score,
        matchComponents: match.components,
        matchCalculatedAt: new Date(),
      });
      matched += 1;
    }
    return { profileId, matched };
  }

  private async handleIngestionMatchAll(data: Record<string, unknown>) {
    const opportunityId = typeof data.opportunityId === 'string' ? data.opportunityId : '';
    if (!opportunityId) throw new Error('ingestion_match_all requires opportunityId');
    const opportunity = await this.opportunitiesRepository.getById(opportunityId);
    const profiles = await this.profilesRepository.listForIngestionMatching();
    let matchedProfiles = 0;
    for (const profile of profiles) {
      const match = this.matchingService.calculate(opportunity, profile);
      await this.statesRepository.upsert({
        userId: profile.userId,
        opportunityId: opportunity._id,
        profileId: profile._id,
        matchScore: match.score,
        matchComponents: match.components,
        matchCalculatedAt: new Date(),
      });
      matchedProfiles += 1;
    }
    const watchlists = this.moduleRef?.get<WatchlistsEvaluationPort>('WatchlistsService', { strict: false });
    const watchlistResult = watchlists ? await watchlists.evaluateOpportunity(opportunity, this.watchlistContextFromJob(data, opportunity)) : { evaluated: 0, hits: 0, autoAiQueued: 0 };
    return { opportunityId, matchedProfiles, watchlists: watchlistResult };
  }

  private async enqueueIngestionMatch(opportunityId: string, revision?: string, context?: WatchlistEvaluationContext): Promise<void> {
    if (!this.jobsService) return;
    await this.jobsService.enqueue('analytics', 'ingestion_match_all', {
      opportunityId,
      ...(context?.effectMode ? { effectMode: context.effectMode } : {}),
      ...(context?.sourceRunId ? { sourceRunId: context.sourceRunId } : {}),
      ...(context?.sourceId ? { sourceId: context.sourceId } : {}),
    }, { jobId: `ingestion-match:${opportunityId}${revision ? `:${revision}` : ''}` });
  }

  private watchlistContextFromJob(data: Record<string, unknown>, opportunity: Opportunity): WatchlistEvaluationContext {
    const effectMode = data.effectMode === 'historical' || data.effectMode === 'fresh'
      ? data.effectMode
      : this.persistedEffectMode(opportunity);
    return {
      ...(effectMode ? { effectMode } : {}),
      ...(typeof data.sourceRunId === 'string' ? { sourceRunId: data.sourceRunId } : {}),
      ...(typeof data.sourceId === 'string' ? { sourceId: data.sourceId } : {}),
    };
  }

  private persistedEffectMode(opportunity: Opportunity): 'fresh' | 'historical' | undefined {
    const values = (opportunity.sourceOccurrences ?? [])
      .map((occurrence) => occurrence.sourceMetadata?.sourceRunEffectMode)
      .filter((value): value is 'fresh' | 'historical' => value === 'fresh' || value === 'historical');
    if (values.includes('historical')) return 'historical';
    if (values.includes('fresh')) return 'fresh';
    return undefined;
  }

  private async enqueueSearchIndex(opportunityId: string, revision?: string): Promise<void> {
    if (!this.jobsService) return;
    await this.jobsService.enqueue('search', 'index-opportunity', { opportunityId }, { jobId: `search:opportunity:${opportunityId}${revision ? `:${revision}` : ''}` });
  }

  private bulkToPersonalDto(dto: BulkOpportunityActionDto): UpdatePersonalStateDto {
    const profilePatch = typeof dto.value.profileId === 'string' ? { profileId: dto.value.profileId } : {};
    if (dto.action === 'favorite') return { ...profilePatch, favorite: Boolean(dto.value.enabled) };
    if (dto.action === 'hide') return { ...profilePatch, hidden: Boolean(dto.value.enabled) };
    if (dto.action === 'archive') return { ...profilePatch, archived: Boolean(dto.value.enabled) };
    if (dto.action === 'pipeline') return { ...profilePatch, pipelineStatus: dto.value.status as UpdatePersonalStateDto['pipelineStatus'] };
    if (dto.action === 'tags') return { ...profilePatch, tags: dto.value.tags as string[] };
    return profilePatch;
  }

  private async saveReviewedState(userId: string, opportunity: Opportunity, profile: Profile) {
    const match = this.matchingService.calculate(opportunity, profile);
    return this.statesRepository.recordView(userId, opportunity._id, profile._id, opportunity.type, {
      matchScore: match.score,
      matchComponents: match.components,
      matchCalculatedAt: new Date(),
    });
  }
}
