import { BadRequestException, ConflictException, Inject, Injectable, Logger, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';

import { Actor } from '../../common/access';
import { CryptoService } from '../../infrastructure/crypto.service';
import { AuditService } from '../audit/audit.service';
import { OpportunitiesRepository, SourceRefreshCandidate } from '../opportunities/opportunities.repository';
import { ConnectorRegistryService } from './connectors/connector-registry.service';
import { Connector, ConnectorHealth, ConnectorRateLimitError, RawOpportunityRecord, ValidationResult } from './connectors/connector.types';
import { RefreshSourceDto, RunSourceDto, UpdateSourceDto } from './dto/source.dto';
import {
  IngestBatchResult,
  NormalizedOpportunityInput,
  JobsServiceLike,
  OPPORTUNITIES_INGEST_SERVICE,
  OpportunitiesIngestServiceLike,
  RealtimeServiceLike,
  SOURCES_JOBS_SERVICE,
  SOURCES_REALTIME_SERVICE,
} from './ingestion/source-ingestion.types';
import { SourceDeduplicationService } from './deduplication/source-deduplication.service';
import { WebExtractionHttpError } from './extraction/web-extraction.service';
import { SourceNormalizerService } from './normalization/source-normalizer.service';
import { SourceRun } from './schemas/source-run.schema';
import { Source } from './schemas/source.schema';
import { isSourceActiveRunConflict, SourcesRepository } from './sources.repository';

const INGESTION_QUEUE = 'ingestion';
const SOURCE_FETCH_JOB = 'source.fetchPage';
const SOURCE_BACKFILL_JOB = 'source.backfill';
const SOURCE_REFRESH_JOB = 'source.refreshActive';
const TELEGRAM_POLL_JOB = 'telegram.poll';
const VK_POLL_JOB = 'vk.poll';
const ATS_POLL_JOB = 'ats.poll';
const SOURCE_HEALTH_JOB = 'source.healthCheck';
const SOURCE_RUN_RECOVERY_STALE_MS = 5 * 60 * 1000;
const SOURCE_RUN_RECOVERY_QUEUE_STATES = ['active', 'waiting', 'delayed', 'paused', 'prioritized', 'waiting-children'] as const;
const SOURCE_RUN_RECOVERY_QUEUE_PAGE_SIZE = 100;

type SafeSource = Omit<Source, 'credentialsEncrypted'> & { credentialsConfigured: boolean; credentialsRequired: boolean };
type SourceRunStats = {
  seen: number;
  normalized: number;
  upserted: number;
  created: number;
  updated: number;
  duplicates: number;
  failed: number;
};
type SourceRunJobResult = Pick<SourceRun, '_id' | 'sourceId' | 'runType' | 'status' | 'finishedAt'> & { stats: SourceRunStats; error?: string };
type SkippedScheduledRun = { skipped: true; sourceId: string; reason: string; existingRunId?: string };
type RefreshCandidateIdentity = { opportunityId: string; sourceId: string; externalId: string; url: string };
type PendingRefreshIngest = {
  version: 1;
  sourceId: string;
  runId: string;
  connectorId: string;
  candidateKey: string;
  records: NormalizedOpportunityInput[];
  duplicateCount: number;
  statsCounted: boolean;
};
type PendingIngestPage = {
  version: 1;
  sourceId: string;
  runId: string;
  connectorId: string;
  checkpointBefore: Record<string, unknown>;
  checkpointAfter: Record<string, unknown>;
  hasMore: boolean;
  nextPage?: number;
  records: NormalizedOpportunityInput[];
  duplicateCount: number;
  pageStatsCounted: boolean;
};
type SourceRunRecoveryResult = { recovered: true; enqueued: true; run: SourceRun };
type SourceQueueJobSummary = { id?: string; name?: string; state: string; sourceId?: string; runId?: string };

class SourceIngestBackpressureError extends ConnectorRateLimitError {
  constructor(message: string) {
    super(message, 5);
  }
}

class SourcePendingIngestError extends Error {
  constructor(message: string) {
    super(message);
  }
}

class SourceRefreshUnavailableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

@Injectable()
export class SourcesService implements OnModuleInit {
  constructor(
    private readonly sourcesRepository: SourcesRepository,
    private readonly connectorRegistry: ConnectorRegistryService,
    private readonly normalizer: SourceNormalizerService,
    private readonly deduplication: SourceDeduplicationService,
    private readonly cryptoService: CryptoService,
    private readonly auditService: AuditService,
    @Inject(SOURCES_JOBS_SERVICE) private readonly jobsService: JobsServiceLike,
    @Inject(SOURCES_REALTIME_SERVICE) private readonly realtimeService: RealtimeServiceLike,
    @Inject(OPPORTUNITIES_INGEST_SERVICE) private readonly opportunitiesIngest: OpportunitiesIngestServiceLike,
    @Optional() private readonly opportunitiesRepository?: OpportunitiesRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sourcesRepository.ensureCatalog();
    this.jobsService.registerHandler(INGESTION_QUEUE, SOURCE_FETCH_JOB, (data) => this.executeSourceJob(data));
    this.jobsService.registerHandler(INGESTION_QUEUE, SOURCE_BACKFILL_JOB, (data) => this.executeSourceJob(data));
    this.jobsService.registerHandler(INGESTION_QUEUE, SOURCE_REFRESH_JOB, (data) => this.executeSourceJob(data));
    this.jobsService.registerHandler(INGESTION_QUEUE, TELEGRAM_POLL_JOB, (data) => this.executeSourceJob(data));
    this.jobsService.registerHandler(INGESTION_QUEUE, VK_POLL_JOB, (data) => this.executeSourceJob(data));
    this.jobsService.registerHandler(INGESTION_QUEUE, ATS_POLL_JOB, (data) => this.executeSourceJob(data));
    this.jobsService.registerHandler('maintenance', SOURCE_HEALTH_JOB, (data) => this.executeHealthJob(data));
    await this.scheduleEnabledSources();
  }

  async list(params: { group?: string; connectorFamily?: string; healthState?: string; query?: string; limit?: number; cursor?: string }) {
    const page = await this.sourcesRepository.list(params);
    return { ...page, items: page.items.map((source) => this.toSafeSource(source)) };
  }

  async publicRegistry(group?: string) {
    const page = await this.sourcesRepository.list({ group, limit: 200 });
    return {
      items: page.items.map((source) => ({
        id: source._id,
        name: source.name,
        group: source.group,
        status: source.runtimeState,
        healthState: source.healthState,
        types: source.opportunityTypes,
        connectorFamily: source.connectorFamily,
      })),
      nextCursor: null,
      total: page.total,
    };
  }

  async get(id: string): Promise<SafeSource> {
    return this.toSafeSource(await this.sourcesRepository.get(id));
  }

  async update(actor: Actor, id: string, dto: UpdateSourceDto): Promise<SafeSource> {
    const source = await this.sourcesRepository.get(id);
    const update: Partial<Source> = {
      updatedByUserId: actor.id,
    };
    if (dto.enabled !== undefined) update.enabled = dto.enabled;
    if (dto.runtimeState) update.runtimeState = dto.runtimeState;
    if (dto.intervalSeconds !== undefined) update.intervalSeconds = dto.intervalSeconds;
    if (dto.timeoutMs !== undefined) update.timeoutMs = dto.timeoutMs;
    if (dto.tenants) update.config = { ...source.config, tenants: dto.tenants };
    if (dto.discoveryHosts) update.config = { ...(update.config ?? source.config), discoveryHosts: dto.discoveryHosts };
    if (dto.discoveryUrls) update.config = { ...(update.config ?? source.config), discoveryUrls: dto.discoveryUrls };
    if (dto.searchText !== undefined) update.config = { ...(update.config ?? source.config), searchText: dto.searchText };
    if (dto.area !== undefined) update.config = { ...(update.config ?? source.config), area: dto.area };
    if (dto.perPage !== undefined) update.limits = { ...source.limits, perPage: dto.perPage };
    if (dto.maxPages !== undefined) update.limits = { ...(update.limits ?? source.limits), maxPages: dto.maxPages };
    if (dto.proxyPoolEnabled !== undefined) update.proxyPoolEnabled = dto.proxyPoolEnabled;
    if (dto.credentials) {
      update.credentialsEncrypted = this.cryptoService.encrypt(JSON.stringify(dto.credentials));
      update.credentialsPreview = this.previewCredentials(dto.credentials);
    }
    const updated = await this.sourcesRepository.update(id, update);
    await this.auditService.record(actor, 'source.update', 'source', id, this.changedFields(dto));
    await this.syncSourceSchedule(updated);
    return this.toSafeSource(updated);
  }

  async check(id: string): Promise<{ sourceId: string; health: ConnectorHealth }> {
    const source = await this.sourcesRepository.get(id);
    const connector = this.connectorRegistry.get(source);
    const health = await connector.healthCheck({ source, requestId: `health:${Date.now()}`, credentials: this.sourceCredentials(source) });
    const probePatch: Partial<Source> = {
      lastHealthCheckAt: health.checkedAt,
      lastHealthCheckState: health.state,
      lastHealthCheckMessage: health.message,
    };
    if ((health.state === 'Failed' || health.state === 'Degraded') && source.runtimeState !== 'Disabled' && source.runtimeState !== 'Maintenance') {
      probePatch.healthState = health.state;
      probePatch.healthMessage = health.message;
      probePatch.lastFailureAt = health.checkedAt;
      probePatch.lastError = health.message;
    }
    await this.sourcesRepository.updateHealth(id, probePatch);
    return { sourceId: id, health };
  }

  async run(actor: Actor, id: string, dto: RunSourceDto): Promise<SourceRun> {
    const source = await this.sourcesRepository.get(id);
    if (!source.enabled || source.runtimeState === 'Disabled' || source.runtimeState === 'Maintenance') {
      throw new BadRequestException(`Source ${id} is not enabled for ingestion`);
    }
    const runType = dto.runType ?? 'manual';
    let run: SourceRun;
    try {
      run = await this.sourcesRepository.createRun({
        sourceId: id,
        runType,
        status: 'Queued',
        requestedByUserId: actor.id,
        checkpointBefore: source.checkpoint ?? {},
        requestMetadata: { backfillDays: dto.backfillDays ?? 30 },
      });
    } catch (error) {
      if (!isSourceActiveRunConflict(error)) throw error;
      const active = await this.sourcesRepository.findActiveRun(id);
      throw new ConflictException({ code: 'SOURCE_RUN_ACTIVE', message: `Source ${id} already has an active collection run`, details: { runId: active?._id } });
    }
    const name = runType === 'backfill' ? SOURCE_BACKFILL_JOB : SOURCE_FETCH_JOB;
    await this.jobsService.enqueue(INGESTION_QUEUE, this.jobNameForSource(source, name), { runId: run._id, sourceId: id, backfillDays: dto.backfillDays ?? 30 }, { jobId: `source:${id}:run:${run._id}` });
    await this.auditService.record(actor, 'source.run', 'source', id, ['runType', 'backfillDays']);
    return run;
  }

  async refresh(actor: Actor, id: string, dto: RefreshSourceDto): Promise<SourceRun> {
    const source = await this.sourcesRepository.get(id);
    if (!source.enabled || source.runtimeState === 'Disabled' || source.runtimeState === 'Maintenance') {
      throw new BadRequestException(`Source ${id} is not enabled for refresh`);
    }
    const connector = this.connectorRegistry.get(source);
    if (!connector.capabilities().supportsRefresh || !connector.refresh) {
      throw new BadRequestException(`Source ${id} does not support selective refresh`);
    }
    const limit = this.refreshLimit(dto.limit);
    let run: SourceRun;
    try {
      run = await this.sourcesRepository.createRun({
        sourceId: id,
        runType: 'manual',
        status: 'Queued',
        requestedByUserId: actor.id,
        checkpointBefore: source.checkpoint ?? {},
        requestMetadata: {
          mode: 'refresh',
          refresh: {
            version: 1,
            requestedOpportunityIds: this.safeStringArray(dto.opportunityIds),
            limit,
            completedKeys: [],
          },
        },
      });
    } catch (error) {
      if (!isSourceActiveRunConflict(error)) throw error;
      const active = await this.sourcesRepository.findActiveRun(id);
      throw new ConflictException({ code: 'SOURCE_RUN_ACTIVE', message: `Source ${id} already has an active collection run`, details: { runId: active?._id } });
    }
    await this.jobsService.enqueue(INGESTION_QUEUE, this.jobNameForSource(source, SOURCE_REFRESH_JOB), { runId: run._id, sourceId: id, mode: 'refresh', limit }, { jobId: `source:${id}:refresh:${run._id}` });
    await this.auditService.record(actor, 'source.refresh', 'source', id, ['limit', 'opportunityIds']);
    return run;
  }

  async discover(actor: Actor, id: string): Promise<{ source: SafeSource; result: Record<string, unknown> }> {
    const source = await this.sourcesRepository.get(id);
    const connector = this.connectorRegistry.get(source);
    if (!connector.discover) {
      throw new BadRequestException(`Source ${id} does not support discovery`);
    }
    const result = await connector.discover({ source, requestId: `discover:${Date.now()}`, credentials: this.sourceCredentials(source) });
    const tenants = Array.isArray(result.details?.tenants)
      ? result.details.tenants.filter((tenant): tenant is string => typeof tenant === 'string' && tenant.trim().length > 0)
      : [];
    const updated =
      tenants.length > 0
        ? await this.sourcesRepository.update(id, { config: { ...source.config, tenants: Array.from(new Set([...(this.existingTenants(source)), ...tenants])) } })
        : source;
    await this.auditService.record(actor, 'source.discover', 'source', id, ['tenants']);
    await this.syncSourceSchedule(updated);
    return { source: this.toSafeSource(updated), result };
  }

  listRuns(params: { sourceId?: string; status?: string; limit?: number; cursor?: string }) {
    return this.sourcesRepository.listRuns(params);
  }

  async stopRun(actor: Actor, runId: string): Promise<SourceRun> {
    const run = await this.sourcesRepository.requestStop(runId);
    await this.auditService.record(actor, 'source.run.stop', 'source', run.sourceId, ['runId']);
    return run;
  }

  async recoverRun(actor: Actor, runId: string): Promise<SourceRunRecoveryResult> {
    const run = await this.sourcesRepository.getRun(runId);
    const source = await this.sourcesRepository.get(run.sourceId);
    this.assertRecoverableRun(run, source);
    const pendingJob = await this.findPendingSourceJob(run);
    if (pendingJob) {
      throw new ConflictException({
        code: 'SOURCE_RUN_RECOVERY_BUSY',
        message: `Source ${run.sourceId} still has a pending ingestion job`,
        details: { job: pendingJob },
      });
    }
    const recovered = await this.sourcesRepository.recoverActiveRunToQueued(run);
    if (!recovered) {
      throw new ConflictException({
        code: 'SOURCE_RUN_RECOVERY_CHANGED',
        message: `Source run ${runId} changed before recovery could claim it`,
        details: { runId },
      });
    }
    try {
      await this.enqueueRunContinuation(source, recovered, this.requestedBackfillDays(recovered, 30));
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'SOURCE_RUN_RECOVERY_ENQUEUE_FAILED',
        message: `Source run ${runId} was returned to Queued but could not be enqueued`,
        details: { runId, error: error instanceof Error ? error.message : String(error) },
      });
    }
    await this.auditService.record(actor, 'source.run.recover', 'source', run.sourceId, ['runId']);
    return { recovered: true, enqueued: true, run: recovered };
  }

  async executeRun(runId: string, requestedBackfillDays = 30): Promise<SourceRun> {
    const startedRun = await this.sourcesRepository.startRun(runId);
    if (!startedRun) {
      const existing = await this.sourcesRepository.getRun(runId);
      if (existing.status === 'Queued' || existing.status === 'Failed') throw new Error(`Source ${existing.sourceId} is busy with another collection run`);
      return existing;
    }
    let run = startedRun;
    let source = await this.sourcesRepository.get(run.sourceId);
    if (!source.enabled || source.runtimeState === 'Disabled' || source.runtimeState === 'Maintenance') {
      return this.cancelRunWithoutRetry(run, `Source ${source._id} is not enabled for ingestion`);
    }
    let connector = this.connectorRegistry.get(source);
    try {
      const credentials = this.sourceCredentials(source);
      const backfillDays = this.requestedBackfillDays(run, requestedBackfillDays);
      const backfillSince = this.backfillSince(run, backfillDays);
      const effectMode = this.collectionEffectMode(source, run, backfillDays);
      run = await this.persistBackfillWindow(run, backfillDays, backfillSince, effectMode);
      source = await this.prepareSourceForPolling(source, connector, runId, credentials);
      connector = this.connectorRegistry.get(source);
      const validation = await connector.validateConfig({ ...(source.endpoint ?? {}), ...(source.config ?? {}), credentials });
      if (!validation.ok) {
        throw new Error(validation.message ?? 'Connector config validation failed');
      }
      let checkpoint = this.startingCheckpoint(run, source);
      let stats = this.runStats(run.stats);
      const maxPages = this.maxPagesPerAttempt(source);
      let pagesFetched = 0;
      let hasMore = false;
      let nextPage: number | undefined;
      while (pagesFetched < maxPages) {
        source = { ...source, checkpoint };
        let pendingPage = this.pendingIngestPage(run, source._id, runId, connector.id, checkpoint);
        if (!pendingPage) {
          const page = await connector.fetchPage({
            source,
            requestId: runId,
            checkpoint,
            backfillDays: this.connectorBackfillDays(backfillSince),
            backfillSince: backfillSince.toISOString(),
            page: nextPage,
            credentials,
          });
          const afterFetchRun = await this.sourcesRepository.getRun(runId);
          if (afterFetchRun.status === 'Cancelled' || afterFetchRun.requestedStopAt) return afterFetchRun;

          const normalized = page.records
            .map((record) => this.normalizer.normalize(source, record))
            .filter((record) => this.withinBackfillWindow(record, backfillSince));
          const collapsed = this.deduplication.collapseBatch(normalized);
          const nextCheckpoint = connector.checkpoint(page);
          if (page.hasMore && page.nextPage === undefined && this.sameCheckpoint(checkpoint, nextCheckpoint)) {
            throw new Error(`Connector ${connector.id} reported hasMore without pagination progress`);
          }
          pendingPage = {
            version: 1,
            sourceId: source._id,
            runId,
            connectorId: connector.id,
            checkpointBefore: checkpoint,
            checkpointAfter: nextCheckpoint,
            hasMore: page.hasMore,
            nextPage: page.nextPage,
            records: collapsed.records,
            duplicateCount: collapsed.duplicates,
            pageStatsCounted: false,
          };
          run = await this.sourcesRepository.updateRun(runId, {
            requestMetadata: this.requestMetadataWithPending(run, pendingPage),
          });
        }

        const beforeDeliveryRun = await this.sourcesRepository.getRun(runId);
        if (this.isStoppedRun(beforeDeliveryRun)) return beforeDeliveryRun;

        const ingestResult = await this.opportunitiesIngest.ingestFromSource({ sourceId: source._id, runId, effectMode, records: pendingPage.records });
        const afterDeliveryRun = await this.sourcesRepository.getRun(runId);
        if (this.isStoppedRun(afterDeliveryRun)) return afterDeliveryRun;
        const pageStatsDelta = pendingPage.pageStatsCounted
          ? {}
          : {
              seen: ingestResult.seen,
              normalized: ingestResult.normalized,
              duplicates: ingestResult.duplicates + pendingPage.duplicateCount,
            };

        stats = this.addRunStats(stats, {
          ...pageStatsDelta,
          upserted: ingestResult.upserted,
          created: ingestResult.created,
          updated: ingestResult.updated,
          failed: ingestResult.failed,
        });
        if (ingestResult.failed > 0) {
          await this.handlePartialIngest(run, pendingPage, ingestResult, stats);
        }

        checkpoint = pendingPage.checkpointAfter;
        pagesFetched += 1;
        hasMore = pendingPage.hasMore;
        nextPage = pendingPage.nextPage;

        await this.sourcesRepository.updateCheckpoint(source._id, checkpoint);
        const persistedRun = await this.sourcesRepository.updateRun(runId, {
          checkpointAfter: checkpoint,
          stats,
          requestMetadata: this.requestMetadataWithoutPending(run),
        });
        run = persistedRun;
        if (persistedRun.status === 'Cancelled' || persistedRun.requestedStopAt) return persistedRun;
        source = await this.sourcesRepository.get(run.sourceId);
        if (!source.enabled || source.runtimeState === 'Disabled' || source.runtimeState === 'Maintenance') {
          return this.cancelRunWithoutRetry(persistedRun, `Source ${source._id} is not enabled for ingestion`);
        }
        if (!hasMore) break;
      }

      if (hasMore) {
        const queued = await this.sourcesRepository.updateRun(runId, {
          status: 'Queued',
          checkpointAfter: checkpoint,
          stats,
        });
        await this.enqueueRunContinuation(source, run, backfillDays);
        return queued;
      }

      if (checkpoint.incomplete === true) {
        const limitation = typeof checkpoint.limitation === 'string' ? checkpoint.limitation : 'Connector could not collect the complete requested source window';
        throw new Error(`Incomplete source collection: ${limitation}`);
      }
      if (checkpoint.hasMore === true) {
        throw new Error('Source collection ended with unresolved checkpoint continuation');
      }

      const finishedAt = new Date();
      const finished = await this.sourcesRepository.finishRunIfNotStopped(runId, {
        status: 'Succeeded',
        finishedAt,
        checkpointAfter: checkpoint,
        stats,
      });
      if (finished.status !== 'Succeeded') return finished;
      await this.markSourceCollectionSucceeded(source._id, finished.finishedAt ?? finishedAt);
      if (stats.failed > 0) {
        try {
          await this.sourcesRepository.recoverRunDlq(runId);
        } catch {
          Logger.warn(`Could not reconcile recovered failures for source run ${runId}`, SourcesService.name);
        }
      }
      if (run.requestedByUserId) {
        this.realtimeService?.publish(run.requestedByUserId, 'source.run.completed', { sourceId: source._id, runId });
      }
      return finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Source run failed';
      const currentRun = await this.sourcesRepository.getRun(runId);
      if (this.isStoppedRun(currentRun)) return currentRun;
      if (error instanceof ConnectorRateLimitError) {
        const name = this.jobNameForSource(source, run.runType === 'backfill' ? SOURCE_BACKFILL_JOB : SOURCE_FETCH_JOB);
        await this.sourcesRepository.updateHealth(source._id, {
          healthState: 'Degraded',
          healthMessage: message,
          lastFailureAt: new Date(),
          lastError: message,
        });
        const queued = await this.sourcesRepository.updateRun(runId, {
          status: 'Queued',
          error: message,
        });
        await this.jobsService.enqueue(
          INGESTION_QUEUE,
          name,
          { runId, sourceId: source._id, backfillDays: this.requestedBackfillDays(run, requestedBackfillDays) },
          { jobId: `source:${source._id}:run:${runId}:retry:${Date.now()}`, delay: Math.max(error.retryAfterSeconds, 1) * 1000 },
        );
        return queued;
      }
      await this.sourcesRepository.updateHealth(source._id, {
        healthState: 'Failed',
        healthMessage: message,
        lastFailureAt: new Date(),
        lastError: message,
      });
      await this.sourcesRepository.createDlq({
        queue: INGESTION_QUEUE,
        jobName: run.runType === 'backfill' ? SOURCE_BACKFILL_JOB : SOURCE_FETCH_JOB,
        sourceId: source._id,
        runId,
        payload: { runId, sourceId: source._id },
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
        attempts: 1,
      });
      await this.sourcesRepository.updateRun(runId, {
        status: 'Failed',
        finishedAt: new Date(),
        error: message,
        stats: this.addRunStats(this.runStats((await this.sourcesRepository.getRun(runId)).stats), { failed: error instanceof SourcePendingIngestError ? 0 : 1 }),
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async executeRefreshRun(runId: string, fallbackLimit = 25): Promise<SourceRun> {
    const startedRun = await this.sourcesRepository.startRun(runId);
    if (!startedRun) {
      const existing = await this.sourcesRepository.getRun(runId);
      if (existing.status === 'Queued' || existing.status === 'Failed') throw new Error(`Source ${existing.sourceId} is busy with another collection run`);
      return existing;
    }
    let run = startedRun;
    const source = await this.sourcesRepository.get(run.sourceId);
    if (!source.enabled || source.runtimeState === 'Disabled' || source.runtimeState === 'Maintenance') {
      return this.cancelRunWithoutRetry(run, `Source ${source._id} is not enabled for refresh`);
    }
    const connector = this.connectorRegistry.get(source);
    if (!connector.capabilities().supportsRefresh || !connector.refresh) {
      return this.cancelRunWithoutRetry(run, `Source ${source._id} does not support selective refresh`);
    }
    try {
      const credentials = this.sourceCredentials(source);
      const validation = await connector.validateConfig({ ...(source.endpoint ?? {}), ...(source.config ?? {}), credentials });
      if (!validation.ok) throw new Error(validation.message ?? 'Connector config validation failed');
      const candidates = await this.refreshCandidates(source, run, fallbackLimit);
      run = await this.persistRefreshCandidates(run, candidates);
      let stats = this.runStats(run.stats);
      let completedKeys = this.refreshCompletedKeys(run);
      for (const candidate of candidates) {
        run = await this.sourcesRepository.getRun(runId);
        if (this.isStoppedRun(run)) return run;
        completedKeys = this.refreshCompletedKeys(run);
        const candidateKey = this.refreshCandidateKey(candidate);
        if (completedKeys.has(candidateKey)) continue;
        let pending = this.pendingRefreshIngest(run, source._id, runId, connector.id, candidateKey);
        if (!pending) {
          const occurrence = await this.refreshOccurrence(candidate);
          let result;
          try {
            result = await connector.refresh(occurrence as Record<string, unknown>, {
              source,
              requestId: `${runId}:refresh:${candidateKey}`,
              checkpoint: {},
              backfillDays: 1,
              credentials,
              signal: AbortSignal.timeout(this.refreshTimeoutMs(source)),
            });
          } catch (error) {
            if (this.isConfirmedRemovedRefreshError(error)) {
              run = await this.handleConfirmedRefreshRemoval(source, runId, candidate, stats, completedKeys, error);
              if (this.isStoppedRun(run)) return run;
              stats = this.runStats(run.stats);
              completedKeys = this.refreshCompletedKeys(run);
              continue;
            }
            throw error;
          }
          const afterFetchRun = await this.sourcesRepository.getRun(runId);
          if (this.isStoppedRun(afterFetchRun)) return afterFetchRun;
          if (!result.record) {
            throw new SourceRefreshUnavailableError(`Source refresh returned no record for ${candidate.externalId}`);
          }
          this.assertRefreshRecordIdentity(candidate, result.record);
          const normalized = this.normalizer.normalize(source, result.record);
          const collapsed = this.deduplication.collapseBatch([normalized]);
          pending = {
            version: 1,
            sourceId: source._id,
            runId,
            connectorId: connector.id,
            candidateKey,
            records: collapsed.records,
            duplicateCount: collapsed.duplicates,
            statsCounted: false,
          };
          run = await this.sourcesRepository.updateRun(runId, {
            requestMetadata: this.refreshMetadataWithPending(afterFetchRun, pending),
          });
        }

        const beforeDeliveryRun = await this.sourcesRepository.getRun(runId);
        if (this.isStoppedRun(beforeDeliveryRun)) return beforeDeliveryRun;
        const ingestResult = await this.opportunitiesIngest.ingestFromSource({ sourceId: source._id, runId, records: pending.records });
        const afterDeliveryRun = await this.sourcesRepository.getRun(runId);
        if (this.isStoppedRun(afterDeliveryRun)) return afterDeliveryRun;
        const statsDelta = pending.statsCounted
          ? {}
          : {
              seen: 1,
              normalized: pending.records.length,
              duplicates: ingestResult.duplicates + pending.duplicateCount,
            };
        stats = this.addRunStats(stats, {
          ...statsDelta,
          upserted: ingestResult.upserted,
          created: ingestResult.created,
          updated: ingestResult.updated,
          failed: ingestResult.failed,
        });
        if (ingestResult.failed > 0) {
          await this.sourcesRepository.updateRun(runId, {
            status: 'Running',
            stats,
            requestMetadata: this.refreshMetadataWithPending(afterDeliveryRun, { ...pending, statsCounted: true }),
            error: this.ingestFailureMessage(ingestResult),
          });
          throw new SourcePendingIngestError(this.ingestFailureMessage(ingestResult));
        }
        completedKeys.add(candidateKey);
        run = await this.sourcesRepository.updateRun(runId, {
          stats,
          requestMetadata: this.refreshMetadataWithoutPending(this.refreshMetadataWithCompleted(afterDeliveryRun, completedKeys)),
        });
      }
      const beforeFinishRun = await this.sourcesRepository.getRun(runId);
      if (this.isStoppedRun(beforeFinishRun)) return beforeFinishRun;
      const finishedAt = new Date();
      const finished = await this.sourcesRepository.finishRunIfNotStopped(runId, {
        status: 'Succeeded',
        finishedAt,
        stats,
        requestMetadata: this.refreshMetadataWithCompleted(run, completedKeys),
      });
      if (this.isStoppedRun(finished) || finished.status !== 'Succeeded') return finished;
      await this.markSourceCollectionSucceeded(source._id, finished.finishedAt ?? finishedAt);
      if (run.requestedByUserId) {
        this.realtimeService?.publish(run.requestedByUserId, 'source.run.completed', { sourceId: source._id, runId });
      }
      return finished;
    } catch (error) {
      const refreshError = this.toRefreshError(error);
      const message = refreshError instanceof Error ? refreshError.message : 'Source refresh failed';
      const currentRun = await this.sourcesRepository.getRun(runId);
      if (this.isStoppedRun(currentRun)) return currentRun;
      if (refreshError instanceof ConnectorRateLimitError) {
        await this.sourcesRepository.updateHealth(source._id, {
          healthState: 'Degraded',
          healthMessage: message,
          lastFailureAt: new Date(),
          lastError: message,
        });
        const queued = await this.sourcesRepository.updateRun(runId, { status: 'Queued', error: message });
        await this.jobsService.enqueue(
          INGESTION_QUEUE,
          this.jobNameForSource(source, SOURCE_REFRESH_JOB),
          { runId, sourceId: source._id, mode: 'refresh', limit: this.refreshLimit(currentRun.requestMetadata?.refresh && typeof currentRun.requestMetadata.refresh === 'object' ? (currentRun.requestMetadata.refresh as Record<string, unknown>).limit : fallbackLimit) },
          { jobId: `source:${source._id}:refresh:${runId}:retry:${Date.now()}`, delay: Math.max(refreshError.retryAfterSeconds, 1) * 1000 },
        );
        return queued;
      }
      await this.sourcesRepository.updateHealth(source._id, {
        healthState: refreshError instanceof SourceRefreshUnavailableError ? 'Degraded' : 'Failed',
        healthMessage: message,
        lastFailureAt: new Date(),
        lastError: message,
      });
      await this.sourcesRepository.createDlq({
        queue: INGESTION_QUEUE,
        jobName: SOURCE_REFRESH_JOB,
        sourceId: source._id,
        runId,
        payload: { runId, sourceId: source._id, mode: 'refresh' },
        error: message,
        stack: refreshError instanceof Error ? refreshError.stack : undefined,
        attempts: 1,
      });
      await this.sourcesRepository.updateRun(runId, {
        status: 'Failed',
        finishedAt: new Date(),
        error: message,
        stats: this.addRunStats(this.runStats((await this.sourcesRepository.getRun(runId)).stats), { failed: refreshError instanceof SourcePendingIngestError ? 0 : 1 }),
      });
      throw refreshError instanceof Error ? refreshError : new Error(message);
    }
  }

  private async handleConfirmedRefreshRemoval(
    source: Source,
    runId: string,
    candidate: RefreshCandidateIdentity,
    stats: SourceRunStats,
    completedKeys: Set<string>,
    error: unknown,
  ): Promise<SourceRun> {
    if (!this.opportunitiesIngest.markSourceOccurrenceRemoved) {
      throw new SourceRefreshUnavailableError('Opportunity source occurrence removal service is not available');
    }
    const candidateKey = this.refreshCandidateKey(candidate);
    const beforeRemovalRun = await this.sourcesRepository.getRun(runId);
    if (this.isStoppedRun(beforeRemovalRun)) return beforeRemovalRun;
    const removedKeys = this.refreshRemovedKeys(beforeRemovalRun);
    await this.opportunitiesIngest.markSourceOccurrenceRemoved({
      opportunityId: candidate.opportunityId,
      sourceId: candidate.sourceId,
      externalId: candidate.externalId,
      url: candidate.url,
      observedAt: new Date(),
      reason: this.confirmedRemovedReason(error),
      runId,
    });
    completedKeys.add(candidateKey);
    const counted = removedKeys.has(candidateKey);
    removedKeys.add(candidateKey);
    const nextStats = counted
      ? stats
      : this.addRunStats(stats, {
          seen: 1,
          upserted: 1,
          updated: 1,
        });
    const afterRemovalRun = await this.sourcesRepository.getRun(runId);
    return this.sourcesRepository.updateRun(runId, {
      stats: nextStats,
      requestMetadata: this.refreshMetadataWithRemoved(this.refreshMetadataWithCompleted(afterRemovalRun, completedKeys), removedKeys),
    });
  }

  private isConfirmedRemovedRefreshError(error: unknown): error is WebExtractionHttpError {
    return error instanceof WebExtractionHttpError && (error.status === 404 || error.status === 410);
  }

  private confirmedRemovedReason(error: unknown): string {
    return error instanceof WebExtractionHttpError ? `HTTP ${error.status}` : 'confirmed_removed';
  }

  private async refreshCandidates(source: Source, run: SourceRun, fallbackLimit: number): Promise<RefreshCandidateIdentity[]> {
    const existing = this.refreshCandidateMetadata(run);
    if (existing.length > 0) return existing;
    if (!this.opportunitiesRepository) throw new Error('Opportunity refresh candidate repository is not available');
    const refresh = this.refreshMetadata(run);
    const requestedOpportunityIds = this.safeStringArray(refresh.requestedOpportunityIds);
    const limit = this.refreshLimit(refresh.limit ?? fallbackLimit);
    const now = Date.now();
    const activeIntervalSeconds = Math.max(Math.floor(Number(source.intervalSeconds ?? 0)), 300);
    const candidates = await this.opportunitiesRepository.listSourceRefreshCandidates({
      sourceId: source._id,
      activeCutoff: new Date(now - activeIntervalSeconds * 1000),
      inactiveCutoff: new Date(now - 86_400_000),
      limit,
      opportunityIds: requestedOpportunityIds,
      ignoreCadence: requestedOpportunityIds.length > 0,
    });
    return candidates.map((candidate) => this.toRefreshCandidateIdentity(candidate));
  }

  private async persistRefreshCandidates(run: SourceRun, candidates: RefreshCandidateIdentity[]): Promise<SourceRun> {
    const existing = this.refreshCandidateMetadata(run);
    if (existing.length > 0) return run;
    return this.sourcesRepository.updateRun(run._id, {
      requestMetadata: {
        ...(run.requestMetadata ?? {}),
        mode: 'refresh',
        refresh: {
          ...this.refreshMetadata(run),
          version: 1,
          candidates,
          completedKeys: this.safeStringArray(this.refreshMetadata(run).completedKeys),
        },
      },
    });
  }

  private refreshMetadata(run: SourceRun): Record<string, unknown> {
    const metadata = run.requestMetadata?.refresh;
    return this.isPlainRecord(metadata) ? metadata : {};
  }

  private refreshCandidateMetadata(run: SourceRun): RefreshCandidateIdentity[] {
    const candidates = this.refreshMetadata(run).candidates;
    if (!Array.isArray(candidates)) return [];
    return candidates.map((candidate) => {
      if (!this.isPlainRecord(candidate)) throw new SourcePendingIngestError('Source refresh metadata has invalid candidate');
      if (
        typeof candidate.opportunityId !== 'string' ||
        typeof candidate.sourceId !== 'string' ||
        typeof candidate.externalId !== 'string' ||
        !candidate.externalId.trim() ||
        typeof candidate.url !== 'string' ||
        !candidate.url.trim()
      ) {
        throw new SourcePendingIngestError('Source refresh metadata has invalid candidate identity');
      }
      return {
        opportunityId: candidate.opportunityId,
        sourceId: candidate.sourceId,
        externalId: candidate.externalId,
        url: candidate.url,
      };
    });
  }

  private toRefreshCandidateIdentity(candidate: SourceRefreshCandidate): RefreshCandidateIdentity {
    const externalId = typeof candidate.occurrence.externalId === 'string' ? candidate.occurrence.externalId.trim() : '';
    if (!externalId) throw new SourcePendingIngestError(`Source refresh candidate ${candidate.opportunityId} is missing native externalId`);
    return {
      opportunityId: candidate.opportunityId,
      sourceId: candidate.occurrence.sourceId,
      externalId,
      url: candidate.occurrence.url,
    };
  }

  private async refreshOccurrence(candidate: RefreshCandidateIdentity): Promise<Record<string, unknown>> {
    if (!this.opportunitiesRepository) throw new Error('Opportunity refresh candidate repository is not available');
    const occurrence = await this.opportunitiesRepository.getSourceRefreshOccurrence(candidate);
    if (!occurrence) {
      throw new SourceRefreshUnavailableError(`Source refresh occurrence ${candidate.externalId} is no longer active for ${candidate.opportunityId}`);
    }
    return occurrence as unknown as Record<string, unknown>;
  }

  private pendingRefreshIngest(run: SourceRun, sourceId: string, runId: string, connectorId: string, candidateKey: string): PendingRefreshIngest | undefined {
    const pending = run.requestMetadata?.pendingRefreshIngest;
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return undefined;
    const candidate = pending as Partial<PendingRefreshIngest>;
    if (candidate.version !== 1) throw new SourcePendingIngestError('Source refresh run has unsupported pending ingest metadata');
    if (candidate.sourceId !== sourceId || candidate.runId !== runId || candidate.connectorId !== connectorId || candidate.candidateKey !== candidateKey) {
      throw new SourcePendingIngestError('Source refresh pending ingest metadata belongs to a different candidate');
    }
    if (!Array.isArray(candidate.records)) throw new SourcePendingIngestError('Source refresh pending ingest metadata has invalid records');
    const duplicateCount = candidate.duplicateCount;
    if (typeof duplicateCount !== 'number' || !Number.isInteger(duplicateCount) || duplicateCount < 0) {
      throw new SourcePendingIngestError('Source refresh pending ingest metadata has invalid duplicateCount');
    }
    if (typeof candidate.statsCounted !== 'boolean') throw new SourcePendingIngestError('Source refresh pending ingest metadata has invalid statsCounted');
    return {
      version: 1,
      sourceId,
      runId,
      connectorId,
      candidateKey,
      records: this.hydratePendingRecords(candidate.records, sourceId),
      duplicateCount,
      statsCounted: candidate.statsCounted,
    };
  }

  private refreshMetadataWithPending(run: SourceRun, pending: PendingRefreshIngest): Record<string, unknown> {
    return {
      ...(run.requestMetadata ?? {}),
      mode: 'refresh',
      pendingRefreshIngest: pending,
    };
  }

  private refreshMetadataWithoutPending(metadata: Record<string, unknown>): Record<string, unknown> {
    const { pendingRefreshIngest: _pendingRefreshIngest, ...rest } = metadata;
    return rest;
  }

  private refreshCompletedKeys(run: SourceRun): Set<string> {
    return new Set(this.safeStringArray(this.refreshMetadata(run).completedKeys));
  }

  private refreshRemovedKeys(run: SourceRun): Set<string> {
    return new Set(this.safeStringArray(this.refreshMetadata(run).removedKeys));
  }

  private refreshMetadataWithCompleted(run: SourceRun, completedKeys: Set<string>): Record<string, unknown> {
    return {
      ...(run.requestMetadata ?? {}),
      mode: 'refresh',
      refresh: {
        ...this.refreshMetadata(run),
        completedKeys: Array.from(completedKeys),
      },
    };
  }

  private refreshMetadataWithRemoved(metadata: Record<string, unknown>, removedKeys: Set<string>): Record<string, unknown> {
    const refresh = this.isPlainRecord(metadata.refresh) ? metadata.refresh : {};
    return {
      ...metadata,
      mode: 'refresh',
      refresh: {
        ...refresh,
        removedKeys: Array.from(removedKeys),
      },
    };
  }

  private refreshCandidateKey(candidate: RefreshCandidateIdentity): string {
    return `${candidate.opportunityId}:${candidate.externalId}`;
  }

  private assertRefreshRecordIdentity(candidate: RefreshCandidateIdentity, record: RawOpportunityRecord): void {
    if (record.externalId === candidate.externalId && this.sameCanonicalUrl(record.url, candidate.url)) return;
    throw new Error(`Refresh result identity mismatch for ${candidate.externalId ?? candidate.url}`);
  }

  private sameCanonicalUrl(left: string, right: string): boolean {
    try {
      const normalize = (value: string) => {
        const url = new URL(value);
        url.hash = '';
        return url.toString();
      };
      return normalize(left) === normalize(right);
    } catch {
      return left === right;
    }
  }

  private refreshLimit(value: unknown): number {
    const numeric = Number(value ?? 25);
    return Number.isFinite(numeric) && numeric > 0 ? Math.min(Math.floor(numeric), 100) : 25;
  }

  private safeStringArray(value: unknown): string[] {
    return Array.isArray(value) ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))) : [];
  }

  private refreshTimeoutMs(source: Source): number {
    const value = Number(source.timeoutMs);
    return Number.isFinite(value) && value >= 1000 ? Math.min(Math.floor(value), 120_000) : 20_000;
  }

  private toRefreshError(error: unknown): unknown {
    if (error instanceof WebExtractionHttpError && error.status === 429) {
      return new ConnectorRateLimitError(error.message, this.retryAfterSeconds(error.retryAfter));
    }
    return error;
  }

  private retryAfterSeconds(value: string | undefined): number {
    if (!value) return 60;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.min(Math.ceil(numeric), 3600);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(Math.max(Math.ceil((date - Date.now()) / 1000), 1), 3600);
    return 60;
  }

  private maxPagesPerAttempt(source: Source): number {
    const value = Number(source.limits?.maxPages ?? 10);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 100) : 10;
  }

  private requestedBackfillDays(run: SourceRun, fallback: number): number {
    const value = Number(run.requestMetadata?.backfillDays ?? fallback);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 30) : 30;
  }

  private assertRecoverableRun(run: SourceRun, source: Source): void {
    if (!source.enabled || source.runtimeState === 'Disabled' || source.runtimeState === 'Maintenance') {
      throw new BadRequestException({
        code: 'SOURCE_RUN_RECOVERY_SOURCE_DISABLED',
        message: `Source ${source._id} is not enabled for ingestion recovery`,
        details: { sourceId: source._id },
      });
    }
    if (!['manual', 'scheduled', 'backfill'].includes(run.runType) || run.requestMetadata?.mode === 'refresh') {
      throw new BadRequestException({
        code: 'SOURCE_RUN_RECOVERY_INELIGIBLE',
        message: `Source run ${run._id} is not a collection run that can be recovered`,
        details: { runId: run._id, runType: run.runType },
      });
    }
    if (!['Running', 'Queued'].includes(run.status) || run.requestedStopAt) {
      throw new BadRequestException({
        code: 'SOURCE_RUN_RECOVERY_INELIGIBLE',
        message: `Source run ${run._id} is not an active recoverable run`,
        details: { runId: run._id, status: run.status },
      });
    }
    const updatedAt = this.dateValue(run.updatedAt);
    if (!updatedAt) {
      throw new BadRequestException({
        code: 'SOURCE_RUN_RECOVERY_INELIGIBLE',
        message: `Source run ${run._id} has no valid updatedAt timestamp`,
        details: { runId: run._id },
      });
    }
    const ageMs = Date.now() - updatedAt.getTime();
    if (ageMs < SOURCE_RUN_RECOVERY_STALE_MS) {
      throw new ConflictException({
        code: 'SOURCE_RUN_RECOVERY_FRESH',
        message: `Source run ${run._id} is not stale enough to recover`,
        details: { runId: run._id, staleAfterMs: SOURCE_RUN_RECOVERY_STALE_MS, ageMs },
      });
    }
  }

  private async findPendingSourceJob(run: SourceRun): Promise<SourceQueueJobSummary | null> {
    const queue = this.jobsService.queue(INGESTION_QUEUE);
    if (!queue.getJobs) {
      throw new ServiceUnavailableException({
        code: 'SOURCE_RUN_RECOVERY_QUEUE_UNAVAILABLE',
        message: 'Source run recovery cannot inspect ingestion queue jobs',
        details: { runId: run._id },
      });
    }
    try {
      for (const state of SOURCE_RUN_RECOVERY_QUEUE_STATES) {
        let start = 0;
        while (true) {
          const jobs = await queue.getJobs([state], start, start + SOURCE_RUN_RECOVERY_QUEUE_PAGE_SIZE - 1, false);
          for (const job of jobs) {
            const data = job.data ?? {};
            const jobSourceId = typeof data.sourceId === 'string' ? data.sourceId : undefined;
            const jobRunId = typeof data.runId === 'string' ? data.runId : undefined;
            if (jobRunId === run._id || jobSourceId === run.sourceId) {
              return { id: job.id, name: job.name, state, sourceId: jobSourceId, runId: jobRunId };
            }
          }
          if (jobs.length < SOURCE_RUN_RECOVERY_QUEUE_PAGE_SIZE) break;
          start += SOURCE_RUN_RECOVERY_QUEUE_PAGE_SIZE;
        }
      }
      return null;
    } catch (error) {
      throw new ServiceUnavailableException({
        code: 'SOURCE_RUN_RECOVERY_QUEUE_UNAVAILABLE',
        message: 'Source run recovery could not inspect ingestion queue jobs',
        details: { runId: run._id, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private backfillSince(run: SourceRun, backfillDays: number): Date {
    const stored = typeof run.requestMetadata?.backfillSince === 'string' ? Date.parse(run.requestMetadata.backfillSince) : NaN;
    if (Number.isFinite(stored)) return new Date(stored);
    return new Date(Date.now() - backfillDays * 86_400_000);
  }

  private async persistBackfillWindow(run: SourceRun, backfillDays: number, backfillSince: Date, effectMode: 'fresh' | 'historical'): Promise<SourceRun> {
    const backfillSinceIso = backfillSince.toISOString();
    if (run.requestMetadata?.backfillDays === backfillDays && run.requestMetadata?.backfillSince === backfillSinceIso && run.requestMetadata?.sourceRunEffectMode === effectMode) return run;
    return this.sourcesRepository.updateRun(run._id, {
      requestMetadata: {
        ...(run.requestMetadata ?? {}),
        backfillDays,
        backfillSince: backfillSinceIso,
        sourceRunEffectMode: effectMode,
      },
    });
  }

  private collectionEffectMode(source: Source, run: SourceRun, backfillDays: number): 'fresh' | 'historical' {
    const stored = run.requestMetadata?.sourceRunEffectMode;
    if (stored === 'fresh' || stored === 'historical') return stored;
    if (run.runType === 'backfill') return 'historical';
    if (run.requestMetadata?.mode === 'refresh') return 'fresh';
    if (!source.lastSuccessAt && backfillDays >= 30) return 'historical';
    return 'fresh';
  }

  private connectorBackfillDays(backfillSince: Date): number {
    const elapsedDays = Math.ceil(Math.max(Date.now() - backfillSince.getTime(), 0) / 86_400_000);
    return Math.max(elapsedDays, 1);
  }

  private startingCheckpoint(run: SourceRun, source: Source): Record<string, unknown> {
    return this.hasRecordKeys(run.checkpointAfter) ? run.checkpointAfter : source.checkpoint ?? {};
  }

  private hasRecordKeys(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
  }

  private withinBackfillWindow(record: { publishedAt?: unknown }, backfillSince: Date): boolean {
    const publishedAt = this.dateValue(record.publishedAt);
    return !publishedAt || publishedAt.getTime() >= backfillSince.getTime();
  }

  private dateValue(value: unknown): Date | undefined {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value !== 'string') return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
  }

  private async enqueueRunContinuation(source: Source, run: SourceRun, requestedBackfillDays: number): Promise<void> {
    const name = this.jobNameForSource(source, run.runType === 'backfill' ? SOURCE_BACKFILL_JOB : SOURCE_FETCH_JOB);
    await this.jobsService.enqueue(
      INGESTION_QUEUE,
      name,
      { runId: run._id, sourceId: source._id, backfillDays: requestedBackfillDays },
      { jobId: `source:${source._id}:run:${run._id}:continue:${Date.now()}` },
    );
  }

  private async handlePartialIngest(
    run: SourceRun,
    pendingPage: PendingIngestPage,
    ingestResult: IngestBatchResult,
    stats: SourceRunStats,
  ): Promise<never> {
    const failedRecords = this.failedPendingRecords(pendingPage.records, ingestResult);
    const retainedPending: PendingIngestPage = {
      ...pendingPage,
      records: failedRecords,
      duplicateCount: 0,
      pageStatsCounted: true,
    };
    const errorMessage = this.ingestFailureMessage(ingestResult);
    const allFailuresTransient = ingestResult.failures.length > 0 && ingestResult.failures.every((failure) => failure.transient);
    await this.sourcesRepository.updateRun(run._id, {
      status: allFailuresTransient ? 'Queued' : 'Running',
      checkpointAfter: pendingPage.checkpointBefore,
      stats,
      requestMetadata: this.requestMetadataWithPending(run, retainedPending),
      error: errorMessage,
    });
    if (allFailuresTransient) {
      throw new SourceIngestBackpressureError(errorMessage);
    }
    throw new SourcePendingIngestError(errorMessage);
  }

  private failedPendingRecords(records: NormalizedOpportunityInput[], ingestResult: IngestBatchResult): NormalizedOpportunityInput[] {
    const failureIndexes = ingestResult.failures.map((failure) => failure.index);
    const failedIndexes = new Set(failureIndexes);
    if (
      failureIndexes.length !== ingestResult.failed ||
      failedIndexes.size !== failureIndexes.length ||
      failureIndexes.some((index) => !Number.isInteger(index) || index < 0 || index >= records.length)
    ) {
      return records;
    }
    const failed = records.filter((_, index) => failedIndexes.has(index));
    return failed.length > 0 ? failed : records;
  }

  private ingestFailureMessage(ingestResult: IngestBatchResult): string {
    const first = ingestResult.failures[0];
    const suffix = first ? `: ${first.reason}` : '';
    return `Source ingestion failed for ${ingestResult.failed} record(s)${suffix}`;
  }

  private pendingIngestPage(run: SourceRun, sourceId: string, runId: string, connectorId: string, checkpoint: Record<string, unknown>): PendingIngestPage | undefined {
    const pending = run.requestMetadata?.pendingIngest;
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return undefined;
    const candidate = pending as Partial<PendingIngestPage>;
    if (candidate.version !== 1) throw new SourcePendingIngestError('Source run has unsupported pending ingest metadata');
    if (candidate.sourceId !== sourceId || candidate.runId !== runId || candidate.connectorId !== connectorId) {
      throw new SourcePendingIngestError('Source run pending ingest metadata belongs to a different source run');
    }
    if (!this.isPlainRecord(candidate.checkpointBefore) || !this.isPlainRecord(candidate.checkpointAfter)) {
      throw new SourcePendingIngestError('Source run pending ingest metadata has invalid checkpoints');
    }
    if (!this.sameCheckpoint(candidate.checkpointBefore, checkpoint)) {
      throw new SourcePendingIngestError('Source run pending ingest checkpoint does not match the current provider checkpoint');
    }
    if (typeof candidate.hasMore !== 'boolean') throw new SourcePendingIngestError('Source run pending ingest metadata has invalid hasMore');
    if (candidate.nextPage !== undefined && (!Number.isInteger(candidate.nextPage) || candidate.nextPage < 0)) {
      throw new SourcePendingIngestError('Source run pending ingest metadata has invalid nextPage');
    }
    const duplicateCount = candidate.duplicateCount;
    if (typeof duplicateCount !== 'number' || !Number.isInteger(duplicateCount) || duplicateCount < 0) {
      throw new SourcePendingIngestError('Source run pending ingest metadata has invalid duplicateCount');
    }
    if (typeof candidate.pageStatsCounted !== 'boolean') {
      throw new SourcePendingIngestError('Source run pending ingest metadata has invalid pageStatsCounted');
    }
    if (!Array.isArray(candidate.records)) throw new SourcePendingIngestError('Source run pending ingest metadata has invalid records');
    const records = this.hydratePendingRecords(candidate.records, sourceId);
    return {
      version: 1,
      sourceId,
      runId,
      connectorId,
      checkpointBefore: candidate.checkpointBefore,
      checkpointAfter: candidate.checkpointAfter,
      hasMore: candidate.hasMore,
      nextPage: candidate.nextPage,
      records,
      duplicateCount,
      pageStatsCounted: candidate.pageStatsCounted,
    };
  }

  private hydratePendingRecords(records: unknown[], sourceId: string): NormalizedOpportunityInput[] {
    return records.map((record, index) => {
      if (!this.isPlainRecord(record)) throw new SourcePendingIngestError(`Source run pending ingest record ${index} is invalid`);
      const sourceOccurrences = record.sourceOccurrences;
      if (!Array.isArray(sourceOccurrences) || !this.isPlainRecord(sourceOccurrences[0])) {
        throw new SourcePendingIngestError(`Source run pending ingest record ${index} is missing source occurrence identity`);
      }
      const occurrence = sourceOccurrences[0];
      if (occurrence.sourceId !== sourceId || typeof occurrence.externalId !== 'string' || typeof occurrence.url !== 'string') {
        throw new SourcePendingIngestError(`Source run pending ingest record ${index} has invalid source occurrence identity`);
      }
      if (typeof record.title !== 'string' || !record.title.trim()) {
        throw new SourcePendingIngestError(`Source run pending ingest record ${index} is missing title`);
      }
      return {
        ...record,
        publishedAt: this.dateValue(record.publishedAt),
        deadline: this.dateValue(record.deadline),
        sourceOccurrences: sourceOccurrences.map((item) => {
          if (!this.isPlainRecord(item)) return item;
          return {
            ...item,
            firstSeenAt: this.dateValue(item.firstSeenAt) ?? item.firstSeenAt,
            lastSeenAt: this.dateValue(item.lastSeenAt) ?? item.lastSeenAt,
            publishedAt: this.dateValue(item.publishedAt) ?? item.publishedAt,
          };
        }),
      } as NormalizedOpportunityInput;
    });
  }

  private isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  private isStoppedRun(run: SourceRun): boolean {
    return run.status === 'Cancelled' || Boolean(run.requestedStopAt);
  }

  private requestMetadataWithPending(run: SourceRun, pending: PendingIngestPage): Record<string, unknown> {
    return {
      ...(run.requestMetadata ?? {}),
      pendingIngest: pending,
    };
  }

  private requestMetadataWithoutPending(run: SourceRun): Record<string, unknown> {
    const { pendingIngest: _pendingIngest, ...metadata } = run.requestMetadata ?? {};
    return metadata;
  }

  private runStats(input: Record<string, number> | undefined): SourceRunStats {
    return {
      seen: this.statValue(input?.seen),
      normalized: this.statValue(input?.normalized),
      upserted: this.statValue(input?.upserted),
      created: this.statValue(input?.created),
      updated: this.statValue(input?.updated),
      duplicates: this.statValue(input?.duplicates),
      failed: this.statValue(input?.failed),
    };
  }

  private addRunStats(current: SourceRunStats, delta: Partial<SourceRunStats>): SourceRunStats {
    return {
      seen: current.seen + this.statValue(delta.seen),
      normalized: current.normalized + this.statValue(delta.normalized),
      upserted: current.upserted + this.statValue(delta.upserted),
      created: current.created + this.statValue(delta.created),
      updated: current.updated + this.statValue(delta.updated),
      duplicates: current.duplicates + this.statValue(delta.duplicates),
      failed: current.failed + this.statValue(delta.failed),
    };
  }

  private statValue(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  private sameCheckpoint(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }


  private async cancelRunWithoutRetry(run: SourceRun, message: string): Promise<SourceRun> {
    return this.sourcesRepository.updateRun(run._id, {
      status: 'Cancelled',
      finishedAt: new Date(),
      error: message,
    });
  }

  private async executeSourceJob(data: Record<string, unknown>): Promise<SourceRunJobResult | SkippedScheduledRun> {
    const run = await this.executeQueuedRun(data);
    if ('skipped' in run) return run;
    // Mongo owns resumable checkpoints and pending delivery; Redis retains only a job receipt.
    return {
      _id: run._id,
      sourceId: run.sourceId,
      runType: run.runType,
      status: run.status,
      stats: this.runStats(run.stats),
      finishedAt: run.finishedAt,
      error: run.error?.slice(0, 2000),
    };
  }

  private async executeQueuedRun(data: Record<string, unknown>): Promise<SourceRun | SkippedScheduledRun> {
    const existingRunId = typeof data.runId === 'string' ? data.runId : '';
    if (existingRunId) {
      if (data.mode === 'refresh') return this.executeRefreshRun(existingRunId, this.refreshLimit(data.limit));
      return this.executeRun(existingRunId, Number(data.backfillDays ?? 30));
    }
    const sourceId = String(data.sourceId ?? '');
    if (!sourceId) throw new Error('sourceId is required');
    const source = await this.sourcesRepository.get(sourceId);
    if (data.mode === 'refresh') return this.executeQueuedRefreshRun(source, data);
    if (data.scheduled === true) {
      if (process.env.SOURCE_SCHEDULER_ENABLED !== 'true' || !await this.shouldSchedule(source)) {
        return { skipped: true, sourceId, reason: 'Source scheduling is disabled or configuration is unavailable' };
      }
      const active = await this.sourcesRepository.findActiveRun(sourceId);
      if (active) return { skipped: true, sourceId, existingRunId: active._id, reason: 'A collection run already owns this source checkpoint' };
      const latest = await this.sourcesRepository.latestCollectionRun(sourceId);
      if (latest?.status === 'Failed' && !latest.requestedStopAt) return this.executeRun(latest._id, Number(data.backfillDays ?? 30));
    }
    if (!source.enabled || source.runtimeState === 'Disabled' || source.runtimeState === 'Maintenance') {
      return this.sourcesRepository.createRun({
        sourceId,
        runType: data.scheduled ? 'scheduled' : 'manual',
        status: 'Cancelled',
        checkpointBefore: source.checkpoint ?? {},
        finishedAt: new Date(),
        error: `Source ${sourceId} is not enabled for ingestion`,
        requestMetadata: { backfillDays: data.backfillDays ?? 30, scheduled: Boolean(data.scheduled) },
      });
    }
    let run: SourceRun;
    try {
      run = await this.sourcesRepository.createRun({
        sourceId,
        runType: data.scheduled ? 'scheduled' : 'manual',
        status: 'Queued',
        checkpointBefore: source.checkpoint ?? {},
        requestMetadata: { backfillDays: data.backfillDays ?? 30, scheduled: Boolean(data.scheduled) },
      });
    } catch (error) {
      if (data.scheduled !== true || !isSourceActiveRunConflict(error)) throw error;
      const active = await this.sourcesRepository.findActiveRun(sourceId);
      return { skipped: true, sourceId, existingRunId: active?._id, reason: 'Another collection run claimed this source' };
    }
    return this.executeRun(run._id, Number(data.backfillDays ?? 30));
  }

  private async executeQueuedRefreshRun(source: Source, data: Record<string, unknown>): Promise<SourceRun | SkippedScheduledRun> {
    const sourceId = source._id;
    if (data.scheduled === true) {
      if (process.env.SOURCE_SCHEDULER_ENABLED !== 'true' || !await this.shouldScheduleRefresh(source)) {
        return { skipped: true, sourceId, reason: 'Source refresh scheduling is disabled or configuration is unavailable' };
      }
      const active = await this.sourcesRepository.findActiveRun(sourceId);
      if (active) return { skipped: true, sourceId, existingRunId: active._id, reason: 'A collection run already owns this source checkpoint' };
    }
    if (!source.enabled || source.runtimeState === 'Disabled' || source.runtimeState === 'Maintenance') {
      return this.sourcesRepository.createRun({
        sourceId,
        runType: data.scheduled ? 'scheduled' : 'manual',
        status: 'Cancelled',
        checkpointBefore: source.checkpoint ?? {},
        finishedAt: new Date(),
        error: `Source ${sourceId} is not enabled for refresh`,
        requestMetadata: { mode: 'refresh', scheduled: Boolean(data.scheduled), refresh: { version: 1, limit: this.refreshLimit(data.limit), completedKeys: [] } },
      });
    }
    let run: SourceRun;
    try {
      run = await this.sourcesRepository.createRun({
        sourceId,
        runType: data.scheduled ? 'scheduled' : 'manual',
        status: 'Queued',
        checkpointBefore: source.checkpoint ?? {},
        requestMetadata: { mode: 'refresh', scheduled: Boolean(data.scheduled), refresh: { version: 1, limit: this.refreshLimit(data.limit), completedKeys: [] } },
      });
    } catch (error) {
      if (data.scheduled !== true || !isSourceActiveRunConflict(error)) throw error;
      const active = await this.sourcesRepository.findActiveRun(sourceId);
      return { skipped: true, sourceId, existingRunId: active?._id, reason: 'Another collection run claimed this source' };
    }
    return this.executeRefreshRun(run._id, this.refreshLimit(data.limit));
  }

  private async executeHealthJob(data: Record<string, unknown>): Promise<unknown> {
    const sourceId = String(data.sourceId ?? '');
    if (!sourceId) throw new Error('sourceId is required');
    return this.check(sourceId);
  }

  private decryptCredentials(source: Source): Record<string, unknown> | undefined {
    if (!source.credentialsEncrypted) return undefined;
    return JSON.parse(this.cryptoService.decrypt(source.credentialsEncrypted)) as Record<string, unknown>;
  }

  private sourceCredentials(source: Source): Record<string, unknown> | undefined {
    const stored = this.decryptCredentials(source) ?? {};
    if (source.connectorFamily === 'TelegramMtproto') {
      const encryptedSession = process.env.TELEGRAM_SESSION_ENCRYPTED;
      const envSession = encryptedSession ? this.cryptoService.decrypt(encryptedSession) : undefined;
      return {
        ...stored,
        apiId: stored.apiId ?? process.env.TELEGRAM_API_ID,
        apiHash: stored.apiHash ?? process.env.TELEGRAM_API_HASH,
        session: stored.session ?? envSession,
      };
    }
    if (source.connectorFamily === 'VkWall') {
      return {
        ...stored,
        accessToken: stored.accessToken ?? process.env.VK_API_TOKEN,
      };
    }
    return Object.keys(stored).length > 0 ? stored : undefined;
  }

  private async scheduleEnabledSources(): Promise<void> {
    const sources: Source[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.sourcesRepository.list({ limit: 200, cursor });
      sources.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const enabled: Source[] = [];
    const refreshEnabled: Source[] = [];
    if (process.env.SOURCE_SCHEDULER_ENABLED === 'true') {
      for (const source of sources) {
        if (await this.shouldSchedule(source)) enabled.push(source);
        if (await this.shouldScheduleRefresh(source)) refreshEnabled.push(source);
      }
    }
    const queue = this.jobsService.queue(INGESTION_QUEUE);
    const desired = new Set([
      ...enabled.map(source => this.schedulerId(source)),
      ...refreshEnabled.map(source => this.refreshSchedulerId(source)),
    ]);
    for (const scheduler of await queue.getJobSchedulers(0, -1, true)) {
      if (scheduler.key.startsWith('source:') && !desired.has(scheduler.key)) await queue.removeJobScheduler(scheduler.key);
    }
    for (const source of enabled) await this.scheduleSource(source);
    for (const source of refreshEnabled) await this.scheduleSourceRefresh(source);
  }

  private async shouldSchedule(source: Source): Promise<boolean> {
    if (!source.enabled || source.runtimeState === 'Disabled' || source.runtimeState === 'Maintenance') return false;
    if (!Number.isFinite(source.intervalSeconds) || source.intervalSeconds <= 0) return false;
    const connector = this.connectorRegistry.get(source);
    const capabilities = connector.capabilities();
    if (!capabilities.supportsIncremental && !capabilities.supportsBackfill) return false;
    try {
      const credentials = this.sourceCredentials(source);
      if (source.connectorFamily === 'AtsPublicBoard' && !this.hasConfiguredTenants(source)) {
        return Boolean(connector.discover) && this.hasDiscoverySeeds(source);
      }
      const validation = await connector.validateConfig({ ...(source.endpoint ?? {}), ...(source.config ?? {}), credentials });
      return validation.ok;
    } catch {
      return false;
    }
  }

  private schedulerId(source: Source): string {
    return `source:${source._id}:${this.jobNameForSource(source, SOURCE_FETCH_JOB)}`;
  }

  private refreshSchedulerId(source: Source): string {
    return `source:${source._id}:${SOURCE_REFRESH_JOB}`;
  }

  private async syncSourceSchedule(source: Source): Promise<void> {
    const queue = this.jobsService.queue(INGESTION_QUEUE);
    const enabled = process.env.SOURCE_SCHEDULER_ENABLED === 'true' && await this.shouldSchedule(source);
    const refreshEnabled = process.env.SOURCE_SCHEDULER_ENABLED === 'true' && await this.shouldScheduleRefresh(source);
    const desiredIds = new Set([
      ...(enabled ? [this.schedulerId(source)] : []),
      ...(refreshEnabled ? [this.refreshSchedulerId(source)] : []),
    ]);
    for (const scheduler of await queue.getJobSchedulers(0, -1, true)) {
      if (scheduler.key.startsWith(`source:${source._id}:`) && !desiredIds.has(scheduler.key)) await queue.removeJobScheduler(scheduler.key);
    }
    if (enabled) await this.scheduleSource(source);
    if (refreshEnabled) await this.scheduleSourceRefresh(source);
  }

  private async scheduleSource(source: Source): Promise<void> {
    const name = this.jobNameForSource(source, SOURCE_FETCH_JOB);
    const data = { sourceId: source._id, scheduled: true, backfillDays: 30 };
    const schedulerId = this.schedulerId(source);
    const queue = this.jobsService.queue(INGESTION_QUEUE);
    await queue.upsertJobScheduler(schedulerId, { every: source.intervalSeconds * 1000 }, {
      name,
      data,
      opts: { attempts: 5, backoff: { type: 'exponential', delay: 1500 }, removeOnComplete: { age: 86400, count: 2000 }, removeOnFail: { age: 30 * 86400, count: 10000 } },
    });
  }

  private async shouldScheduleRefresh(source: Source): Promise<boolean> {
    if (!source.enabled || source.runtimeState === 'Disabled' || source.runtimeState === 'Maintenance') return false;
    if (!Number.isFinite(source.intervalSeconds) || source.intervalSeconds <= 0) return false;
    const connector = this.connectorRegistry.get(source);
    const capabilities = connector.capabilities();
    if (!capabilities.supportsRefresh || !connector.refresh) return false;
    try {
      const credentials = this.sourceCredentials(source);
      const validation = await connector.validateConfig({ ...(source.endpoint ?? {}), ...(source.config ?? {}), credentials });
      return validation.ok;
    } catch {
      return false;
    }
  }

  private async scheduleSourceRefresh(source: Source): Promise<void> {
    const data = { sourceId: source._id, scheduled: true, mode: 'refresh', limit: 25 };
    const queue = this.jobsService.queue(INGESTION_QUEUE);
    await queue.upsertJobScheduler(this.refreshSchedulerId(source), { every: source.intervalSeconds * 1000 }, {
      name: SOURCE_REFRESH_JOB,
      data,
      opts: { attempts: 5, backoff: { type: 'exponential', delay: 1500 }, removeOnComplete: { age: 86400, count: 2000 }, removeOnFail: { age: 30 * 86400, count: 10000 } },
    });
  }

  private async prepareSourceForPolling(source: Source, connector: Connector, requestId: string, credentials: Record<string, unknown> | undefined): Promise<Source> {
    if (source.connectorFamily !== 'AtsPublicBoard' || !connector.discover || !this.hasDiscoverySeeds(source) || !this.shouldAutoDiscoverAts(source)) {
      return source;
    }
    const existingTenants = this.existingTenants(source);
    try {
      const result = await connector.discover({ source, requestId: `${requestId}:discover`, credentials });
      return this.persistDiscoveredTenants(source, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = await this.sourcesRepository.update(source._id, {
        config: {
          ...source.config,
          atsDiscovery: this.discoveryState(false, message, [], undefined),
        },
      });
      if (existingTenants.length > 0) return updated;
      throw new Error(`ATS discovery failed before polling: ${message}`);
    }
  }

  private async persistDiscoveredTenants(source: Source, result: ValidationResult): Promise<Source> {
    const tenants = this.tenantsFromDiscovery(result);
    const mergedTenants = Array.from(new Set([...this.existingTenants(source), ...tenants]));
    return this.sourcesRepository.update(source._id, {
      config: {
        ...source.config,
        tenants: mergedTenants,
        atsDiscovery: this.discoveryState(result.ok, result.message, tenants, result.details?.candidatesChecked),
      },
    });
  }

  private discoveryState(ok: boolean, message: string | undefined, tenants: string[], candidatesChecked: unknown): Record<string, unknown> {
    const now = new Date();
    const everySeconds = 24 * 60 * 60;
    return {
      ok,
      message,
      lastRunAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() + everySeconds * 1000).toISOString(),
      tenantsFound: tenants.length,
      candidatesChecked: typeof candidatesChecked === 'number' ? candidatesChecked : undefined,
    };
  }

  private tenantsFromDiscovery(result: ValidationResult): string[] {
    return Array.isArray(result.details?.tenants)
      ? Array.from(new Set(result.details.tenants.filter((tenant): tenant is string => typeof tenant === 'string' && tenant.trim().length > 0).map((tenant) => this.tenantValue(tenant))))
      : [];
  }

  private shouldAutoDiscoverAts(source: Source): boolean {
    if (!this.hasConfiguredTenants(source)) return true;
    const state = this.recordValue(source.config?.atsDiscovery);
    const nextRunAt = typeof state.nextRunAt === 'string' ? Date.parse(state.nextRunAt) : 0;
    return !Number.isFinite(nextRunAt) || nextRunAt <= Date.now();
  }

  private hasConfiguredTenants(source: Source): boolean {
    return this.existingTenants(source).length > 0;
  }

  private hasDiscoverySeeds(source: Source): boolean {
    return this.nonEmptyStringArray(source.config?.discoveryHosts) || this.nonEmptyStringArray(source.config?.discoveryUrls);
  }

  private nonEmptyStringArray(value: unknown): boolean {
    return Array.isArray(value) && value.some((item) => typeof item === 'string' && item.trim().length > 0);
  }

  private recordValue(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  }

  private previewCredentials(credentials: Record<string, unknown>): string {
    const keys = Object.keys(credentials).sort();
    return keys.length === 0 ? 'empty credential object' : `stored keys: ${keys.join(', ')}`;
  }

  private existingTenants(source: Source): string[] {
    const tenants = source.config?.tenants;
    return Array.isArray(tenants) ? Array.from(new Set(tenants.filter((tenant): tenant is string => typeof tenant === 'string' && tenant.trim().length > 0).map((tenant) => this.tenantValue(tenant)))) : [];
  }

  private tenantValue(tenant: string): string {
    const value = tenant.trim();
    return /^https?:\/\//i.test(value) ? value : value.toLowerCase();
  }

  private jobNameForSource(source: Source, fallback: string): string {
    if (fallback === SOURCE_REFRESH_JOB) return fallback;
    if (source.connectorFamily === 'TelegramMtproto') return TELEGRAM_POLL_JOB;
    if (source.connectorFamily === 'VkWall') return VK_POLL_JOB;
    if (source.connectorFamily === 'AtsPublicBoard' || source.connectorFamily === 'AtsAuthenticated') return ATS_POLL_JOB;
    return fallback;
  }

  private async markSourceCollectionSucceeded(sourceId: string, finishedAt: Date): Promise<void> {
    await this.sourcesRepository.updateHealth(sourceId, {
      healthState: 'Healthy',
      healthMessage: undefined,
      lastSuccessAt: finishedAt,
      lastError: undefined,
    });
  }

  private changedFields(dto: UpdateSourceDto): string[] {
    return Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => (key === 'credentials' ? 'credentials' : key));
  }

  private toSafeSource(source: Source): SafeSource {
    const { credentialsEncrypted: _credentialsEncrypted, ...safe } = source;
    return {
      ...safe,
      credentialsConfigured: Boolean(source.credentialsEncrypted),
      credentialsRequired: this.connectorRegistry.get(source).capabilities().requiresCredentials ?? false,
    };
  }
}
