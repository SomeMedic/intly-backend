import { BadRequestException, ConflictException, Injectable, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Job } from 'bullmq';

import { Actor } from '../../common/access';
import { newId, toPublic } from '../../common/schema';
import { AuditService } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { KnowledgeChunk, KnowledgeChunkDocument, KnowledgeDocument, KnowledgeDocumentDocument, KnowledgeService } from '../knowledge';
import { OpportunitiesRepository } from '../opportunities';
import { Opportunity, OpportunityDocument } from '../opportunities/schemas/opportunity.schema';
import { Profile, ProfileDocument, ProfilesRepository } from '../profiles';
import { Task, TaskDocument } from '../tasks/schemas/task.schema';
import { TasksRepository } from '../tasks/tasks.repository';
import { Watchlist, WatchlistDocument } from '../watchlists/schemas/watchlist.schema';
import { WatchlistsRepository } from '../watchlists/watchlists.repository';
import { MeiliSearchService } from './meili-search.service';
import { AdminSearchRebuildDto, RecentSearchQueryDto, SearchScope, UnifiedSearchDto } from './dto/search.dto';
import { SearchRepository } from './search.repository';
import { SearchRebuild, SearchRebuildDocument, SearchRebuildLock, SearchRebuildLockDocument, SearchRebuildMutation, SearchRebuildMutationDocument, SearchRebuildWriter, SearchRebuildWriterDocument } from './schemas/search-rebuild.schema';

export type SearchItem = {
  id: string;
  entityType: Exclude<SearchScope, 'all'>;
  title: string;
  subtitle?: string;
  excerpt?: string;
  score?: number;
  url: string;
  payload?: Record<string, unknown>;
};
type SearchIndexName = keyof typeof SEARCH_INDEX_SETTINGS;
type SearchRebuildJobProgress = {
  stage: string;
  index?: string;
  processed?: number;
  total?: number;
  taskUids?: number[];
};
type SearchRebuildActiveLock = Pick<SearchRebuildLock, 'jobId' | 'rebuildId' | 'stagingPrefix' | 'phase' | 'journalError'>;
type SearchMutation = Pick<SearchRebuildMutation, '_id' | 'rebuildId' | 'index' | 'operation' | 'documentId'>;
type SearchWriterLease = { writerId: string };

@Injectable()
export class SearchService implements OnModuleInit {
  constructor(
    private readonly searchRepository: SearchRepository,
    private readonly meili: MeiliSearchService,
    private readonly jobsService: JobsService,
    private readonly opportunitiesRepository: OpportunitiesRepository,
    private readonly tasksRepository: TasksRepository,
    private readonly profilesRepository: ProfilesRepository,
    private readonly watchlistsRepository: WatchlistsRepository,
    private readonly knowledgeService: KnowledgeService,
    @InjectModel(Opportunity.name) private readonly opportunityModel: Model<OpportunityDocument>,
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    @InjectModel(Profile.name) private readonly profileModel: Model<ProfileDocument>,
    @InjectModel(Watchlist.name) private readonly watchlistModel: Model<WatchlistDocument>,
    @InjectModel(KnowledgeDocument.name) private readonly knowledgeDocumentModel: Model<KnowledgeDocumentDocument>,
    @InjectModel(KnowledgeChunk.name) private readonly knowledgeChunkModel: Model<KnowledgeChunkDocument>,
    @InjectModel(SearchRebuild.name) private readonly searchRebuildModel: Model<SearchRebuildDocument>,
    @InjectModel(SearchRebuildLock.name) private readonly searchRebuildLockModel: Model<SearchRebuildLockDocument>,
    @InjectModel(SearchRebuildMutation.name) private readonly searchRebuildMutationModel: Model<SearchRebuildMutationDocument>,
    @InjectModel(SearchRebuildWriter.name) private readonly searchRebuildWriterModel: Model<SearchRebuildWriterDocument>,
    @Optional() private readonly audit?: AuditService,
  ) {}

  onModuleInit(): void {
    this.jobsService.registerHandler('search', 'rebuild', async (data, job) => this.rebuildAll(data, job));
    this.jobsService.registerHandler('search', 'index-opportunity', async (data) => this.indexOpportunity(String(data.opportunityId)));
    this.jobsService.registerHandler('search', 'delete-opportunity', async (data) => this.deleteIndexed('opportunities', String(data.opportunityId)));
    this.jobsService.registerHandler('search', 'index-task', async (data) => this.indexTask(String(data.taskId)));
    this.jobsService.registerHandler('search', 'delete-task', async (data) => this.deleteIndexed('tasks', String(data.taskId)));
    this.jobsService.registerHandler('search', 'index-profile', async (data) => this.indexProfile(String(data.profileId)));
    this.jobsService.registerHandler('search', 'delete-profile', async (data) => this.deleteIndexed('profiles', String(data.profileId)));
    this.jobsService.registerHandler('search', 'index-watchlist', async (data) => this.indexWatchlist(String(data.watchlistId)));
    this.jobsService.registerHandler('search', 'delete-watchlist', async (data) => this.deleteIndexed('watchlists', String(data.watchlistId)));
    this.jobsService.registerHandler('search', 'index-knowledge-document', async (data) => this.indexKnowledgeDocument(String(data.documentId)));
    this.jobsService.registerHandler('search', 'delete-knowledge-document', async (data) => this.deleteKnowledgeDocument(String(data.documentId)));
  }

  async search(actor: Actor, dto: UnifiedSearchDto) {
    const scope = dto.scope ?? 'all';
    const scopes: Array<Exclude<SearchScope, 'all'>> = dto.scopes?.length
      ? dto.scopes.filter((target): target is Exclude<SearchScope, 'all'> => target !== 'all')
      : scope === 'all'
        ? ['opportunities', 'tasks', 'profiles', 'watchlists', 'knowledge']
        : [scope];
    await this.searchRepository.recordRecent(actor.id, dto.query, scope, dto.filters ?? {});
    const limit = dto.limit ?? 8;
    const groups = await Promise.all(scopes.map((target) => this.searchScope(actor, target, dto, limit)));
    return {
      query: dto.query,
      mode: dto.mode ?? 'hybrid',
      indexAvailable: this.meili.available(),
      groups: Object.fromEntries(groups.map((group) => [group.scope, { items: group.items, nextCursor: null }])),
    };
  }

  async recent(actor: Actor, query: RecentSearchQueryDto) {
    const items = await this.searchRepository.listRecent(actor.id, query.scope);
    return { items: items.map((item) => toPublic(item)), nextCursor: null };
  }

  async clearRecent(actor: Actor): Promise<{ success: true }> {
    await this.searchRepository.clearRecent(actor.id);
    return { success: true };
  }

  async adminIndexes() {
    return { items: await this.meili.indexStats(), nextCursor: null };
  }

  async adminMaintenance() {
    const checkedAt = new Date();
    const [active, latest, counts] = await Promise.all([
      this.searchRebuildModel.findOne({ status: { $in: ['Queued', 'Running'] } }).sort({ createdAt: -1 }).lean(),
      this.searchRebuildModel.findOne({}).sort({ createdAt: -1 }).lean(),
      this.jobsService.queue('search').getJobCounts('waiting', 'active', 'delayed', 'failed'),
    ]);
    const format = async (item: (SearchRebuild & { createdAt?: Date; updatedAt?: Date }) | null) => {
      if (!item) return undefined;
      const job = await this.jobsService.queue('search').getJob(item.jobId).catch(() => null);
      const state = job ? await job.getState() : item.status.toLowerCase();
      return {
        id: item.jobId,
        rebuildId: item._id,
        queue: 'search',
        state,
        progress: job?.progress ?? item.progress ?? { stage: item.stage ?? item.status.toLowerCase() },
        createdAt: item.createdAt ?? null,
        startedAt: item.startedAt ?? null,
        finishedAt: item.finishedAt ?? null,
        durationMs: item.startedAt && item.finishedAt ? Math.max(item.finishedAt.getTime() - item.startedAt.getTime(), 0) : undefined,
        failedReason: item.error,
      };
    };
    return {
      checkedAt,
      status: this.meili.available() ? 'configured' : 'unconfigured',
      active: await format(active),
      latest: await format(latest),
      backlog: (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0),
      lastError: latest?.status === 'Failed' ? latest.error : undefined,
    };
  }

  async adminRebuild(actor: Actor, dto: AdminSearchRebuildDto) {
    if (dto.confirmed !== true) throw new BadRequestException('Search rebuild requires confirmed=true');
    if (!this.meili.available()) throw new ServiceUnavailableException('Search index is unavailable');
    const rebuildId = newId();
    const stagingPrefix = `rebuild_${rebuildId.replaceAll('-', '')}`;
    const lock = await this.acquireRebuildLock(rebuildId, rebuildId, stagingPrefix);
    if (!lock) throw new ConflictException('Search rebuild is already running');
    let enqueuedResult: { id: string; queue: string } | undefined;
    try {
      await this.searchRebuildModel.create({ _id: rebuildId, status: 'Queued', jobId: rebuildId, actorUserId: actor.id, stagingPrefix, stage: 'queued', progress: { stage: 'queued' } });
      await this.audit?.record(actor, 'search.rebuild.enqueue', 'search-rebuild', rebuildId, ['confirmed']);
      const result = await this.jobsService.enqueue('search', 'rebuild', { rebuildId, actorUserId: actor.id, stagingPrefix }, { jobId: `search-rebuild:${rebuildId}` });
      enqueuedResult = result;
      await this.searchRebuildModel.updateOne({ _id: rebuildId }, { $set: { jobId: result.id } });
      await this.searchRebuildLockModel.updateOne({ _id: SEARCH_REBUILD_LOCK_ID, rebuildId }, { $set: { jobId: result.id } });
      return result;
    } catch (error) {
      if (enqueuedResult) return enqueuedResult;
      await this.releaseRebuildLock(rebuildId);
      await this.searchRebuildModel.updateOne({ _id: rebuildId }, { $set: { status: 'Failed', stage: 'failed', error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000), finishedAt: new Date() } });
      throw error;
    }
  }

  async rebuildAll(data: Record<string, unknown> = {}, job?: Job) {
    if (!this.meili.available()) throw new ServiceUnavailableException('Search index is unavailable');
    const rebuildId = typeof data.rebuildId === 'string' ? data.rebuildId : newId();
    const stagingPrefix = typeof data.stagingPrefix === 'string' ? data.stagingPrefix : `rebuild_${rebuildId.replaceAll('-', '')}`;
    const lock = await this.acquireRebuildLock(rebuildId, job?.id ?? rebuildId, stagingPrefix);
    if (!lock) throw new ConflictException('Search rebuild is already running');
    const taskUids: number[] = [];
    let retainPublishingLockOnFailure = false;
    try {
      const existing = await this.searchRebuildModel.findOne({ _id: rebuildId }).lean();
      if (Array.isArray(existing?.taskUids)) taskUids.push(...existing.taskUids.filter((taskUid): taskUid is number => typeof taskUid === 'number'));
      if (existing?.swappedAt) {
        const cleanupWarning = await this.cleanupStagingIndexes(stagingPrefix, taskUids);
        await this.releaseRebuildLock(rebuildId);
        await this.updateJobProgress(job, { stage: 'completed', taskUids });
        await this.updateRebuildStatus(rebuildId, {
          status: 'Succeeded',
          stage: 'completed',
          progress: { stage: 'completed', taskUids, cleanupWarning },
          taskUids,
          cleanupWarning,
          finishedAt: new Date(),
        });
        return { status: 'completed', rebuildId, taskUids, cleanupWarning };
      }
      if (typeof existing?.swapTaskUid === 'number') {
        await this.searchRebuildLockModel.updateOne({ _id: SEARCH_REBUILD_LOCK_ID, rebuildId }, { $set: { phase: 'publishing' } });
        if (!taskUids.includes(existing.swapTaskUid)) taskUids.push(existing.swapTaskUid);
        await this.updateRebuildStatus(rebuildId, { stage: 'waiting-recorded-swap', progress: { stage: 'waiting-recorded-swap', taskUids }, taskUids });
        await this.meili.waitForTaskUid(existing.swapTaskUid, 'recorded swap search indexes');
        await this.updateRebuildStatus(rebuildId, { swappedAt: new Date(), stage: 'cleanup', progress: { stage: 'cleanup', taskUids }, taskUids });
        const cleanupWarning = await this.cleanupStagingIndexes(stagingPrefix, taskUids);
        await this.releaseRebuildLock(rebuildId);
        await this.updateJobProgress(job, { stage: 'completed', taskUids });
        await this.updateRebuildStatus(rebuildId, {
          status: 'Succeeded',
          stage: 'completed',
          progress: { stage: 'completed', taskUids, cleanupWarning },
          taskUids,
          cleanupWarning,
          finishedAt: new Date(),
        });
        return { status: 'completed', rebuildId, taskUids, cleanupWarning };
      }
      if (existing && ['submitting-swap', 'swap-submit-unknown'].includes(String(existing.stage))) {
        await this.searchRebuildLockModel.updateOne({ _id: SEARCH_REBUILD_LOCK_ID, rebuildId }, { $set: { phase: 'publishing' } });
        retainPublishingLockOnFailure = true;
        throw new ConflictException('Search rebuild swap submission is unresolved; staging indexes retained for reconciliation');
      }
      await this.updateRebuildStatus(rebuildId, {
        status: 'Running',
        jobId: job?.id ?? rebuildId,
        actorUserId: typeof data.actorUserId === 'string' ? data.actorUserId : undefined,
        stagingPrefix,
        stage: 'running',
        startedAt: new Date(),
        error: undefined,
        journalError: undefined,
        progress: { stage: 'running' },
      });
      await this.updateJobProgress(job, { stage: 'running', taskUids });
      const indexes: Record<string, { count: number; stagingIndex: string }> = {};
      for (const descriptor of this.rebuildDescriptors(stagingPrefix)) {
        await this.refreshRebuildLock(rebuildId);
        await this.assertNoJournalFailures(rebuildId);
        const result = await this.rebuildIndex(descriptor, taskUids, rebuildId, job);
        indexes[descriptor.name] = { count: result.count, stagingIndex: descriptor.stagingIndex };
      }
      await this.assertNoJournalFailures(rebuildId);
      await this.updateRebuildStatus(rebuildId, { stage: 'ensuring-live-indexes', progress: { stage: 'ensuring-live-indexes', taskUids }, taskUids, indexes });
      for (const descriptor of this.rebuildDescriptors(stagingPrefix)) taskUids.push(...await this.meili.ensureIndexReady(descriptor.name, descriptor.settings));
      await this.enterPublishingPhase(rebuildId, job, taskUids);
      await this.replayRebuildJournal(rebuildId, stagingPrefix, taskUids, job);
      await this.assertNoJournalFailures(rebuildId);
      await this.updateRebuildStatus(rebuildId, { stage: 'submitting-swap', progress: { stage: 'submitting-swap', taskUids }, taskUids, indexes });
      await this.updateJobProgress(job, { stage: 'submitting-swap', taskUids });
      retainPublishingLockOnFailure = true;
      const swapTaskUid = await this.meili.submitSwapIndexes(this.rebuildDescriptors(stagingPrefix).map((descriptor) => ({ indexes: [descriptor.name, descriptor.stagingIndex] })));
      taskUids.push(swapTaskUid);
      await this.updateRebuildStatus(rebuildId, { swapTaskUid, stage: 'waiting-swap', progress: { stage: 'waiting-swap', taskUids }, taskUids, indexes });
      retainPublishingLockOnFailure = false;
      await this.meili.waitForTaskUid(swapTaskUid, 'swap search indexes');
      await this.updateRebuildStatus(rebuildId, { swappedAt: new Date(), stage: 'cleanup', progress: { stage: 'cleanup', taskUids }, taskUids, indexes });
      const cleanupWarning = await this.cleanupStagingIndexes(stagingPrefix, taskUids);
      await this.releaseRebuildLock(rebuildId);
      await this.updateJobProgress(job, { stage: 'completed', taskUids });
      await this.updateRebuildStatus(rebuildId, {
        status: 'Succeeded',
        stage: 'completed',
        progress: { stage: 'completed', taskUids, cleanupWarning },
        indexes,
        taskUids,
        cleanupWarning,
        finishedAt: new Date(),
      });
      return { status: 'completed', rebuildId, indexes, taskUids, cleanupWarning };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const persisted = await this.searchRebuildModel.findOne({ _id: rebuildId }).lean();
      if (persisted?.swappedAt) {
        const cleanupWarning = await this.cleanupStagingIndexes(stagingPrefix, taskUids, message);
        await this.releaseRebuildLock(rebuildId);
        await this.updateJobProgress(job, { stage: 'completed', taskUids });
        await this.updateRebuildStatus(rebuildId, {
          status: 'Succeeded',
          stage: 'completed',
          progress: { stage: 'completed', taskUids, cleanupWarning },
          taskUids,
          cleanupWarning,
          finishedAt: new Date(),
        });
        return { status: 'completed', rebuildId, taskUids, cleanupWarning };
      }
      if (typeof persisted?.swapTaskUid === 'number') {
        await this.updateRebuildStatus(rebuildId, {
          status: 'Running',
          stage: 'swap-resolution-failed',
          progress: { stage: 'swap-resolution-failed', taskUids },
          taskUids,
          error: `Search rebuild has recorded swap task ${persisted.swapTaskUid} but could not resolve it; publishing lock and staging indexes retained for reconciliation: ${message}`.slice(0, 2000),
        }).catch(() => undefined);
        throw error;
      }
      if (retainPublishingLockOnFailure) {
        await this.updateRebuildStatus(rebuildId, {
          status: 'Running',
          stage: 'swap-submit-unknown',
          progress: { stage: 'swap-submit-unknown', taskUids },
          taskUids,
          error: `Search rebuild swap submission is ambiguous; publishing lock and staging indexes retained for reconciliation: ${message}`.slice(0, 2000),
        }).catch(() => undefined);
        throw error;
      }
      await this.releaseRebuildLock(rebuildId);
      await this.updateRebuildStatus(rebuildId, {
        status: 'Failed',
        stage: 'failed',
        progress: { stage: 'failed', taskUids },
        taskUids,
        error: message.slice(0, 2000),
        finishedAt: new Date(),
      });
      throw error;
    }
  }

  async indexOpportunity(opportunityId: string) {
    const writer = await this.beginSearchWriter();
    try {
      const opportunity = await this.opportunityModel.findById(opportunityId).lean();
      if (!opportunity || opportunity.mergedIntoOpportunityId) return await this.deleteWithWriter('opportunities', opportunityId, writer);
      const projection = this.opportunityProjection(opportunity);
      await this.meili.ensureIndex('opportunities', SEARCH_INDEX_SETTINGS.opportunities);
      await this.meili.upsert('opportunities', [projection]);
      await this.journalUpsert('opportunities', [projection], writer);
      return { status: 'indexed', index: 'opportunities', id: opportunityId };
    } finally {
      await this.finishSearchWriter(writer);
    }
  }

  async indexTask(taskId: string) {
    const writer = await this.beginSearchWriter();
    try {
      const task = await this.taskModel.findOne({ _id: taskId, deletedAt: { $exists: false } }).lean();
      if (!task) return await this.deleteWithWriter('tasks', taskId, writer);
      const projection = this.taskProjection(task);
      await this.meili.ensureIndex('tasks', SEARCH_INDEX_SETTINGS.tasks);
      await this.meili.upsert('tasks', [projection]);
      await this.journalUpsert('tasks', [projection], writer);
      return { status: 'indexed', index: 'tasks', id: taskId };
    } finally {
      await this.finishSearchWriter(writer);
    }
  }

  async indexProfile(profileId: string) {
    const writer = await this.beginSearchWriter();
    try {
      const profile = await this.profileModel.findOne({ _id: profileId, deletedAt: { $exists: false } }).lean();
      if (!profile) return await this.deleteWithWriter('profiles', profileId, writer);
      const projection = this.profileProjection(profile);
      await this.meili.ensureIndex('profiles', SEARCH_INDEX_SETTINGS.profiles);
      await this.meili.upsert('profiles', [projection]);
      await this.journalUpsert('profiles', [projection], writer);
      return { status: 'indexed', index: 'profiles', id: profileId };
    } finally {
      await this.finishSearchWriter(writer);
    }
  }

  async indexWatchlist(watchlistId: string) {
    const writer = await this.beginSearchWriter();
    try {
      const watchlist = await this.watchlistModel.findOne({ _id: watchlistId, deletedAt: { $exists: false } }).lean();
      if (!watchlist) return await this.deleteWithWriter('watchlists', watchlistId, writer);
      const projection = this.watchlistProjection(watchlist);
      await this.meili.ensureIndex('watchlists', SEARCH_INDEX_SETTINGS.watchlists);
      await this.meili.upsert('watchlists', [projection]);
      await this.journalUpsert('watchlists', [projection], writer);
      return { status: 'indexed', index: 'watchlists', id: watchlistId };
    } finally {
      await this.finishSearchWriter(writer);
    }
  }

  async indexKnowledgeDocument(documentId: string) {
    const writer = await this.beginSearchWriter();
    try {
      await this.meili.ensureIndex('knowledge_chunks', SEARCH_INDEX_SETTINGS.knowledge_chunks);
      const document = await this.knowledgeDocumentModel.findOne({ _id: documentId, deletedAt: { $exists: false } }).lean();
      if (!document || document.mode === 'disabled') return await this.deleteKnowledgeChunks(documentId, writer);
      const chunks = await this.knowledgeChunkModel.find({ documentId, active: true, deletedAt: { $exists: false } }).select('+embedding').lean();
      const projections = chunks.map((chunk) => this.knowledgeChunkProjection(chunk, document));
      await this.meili.upsert('knowledge_chunks', projections);
      await this.journalUpsert('knowledge_chunks', projections, writer);
      return { status: 'indexed', index: 'knowledge_chunks', documentId, count: chunks.length };
    } finally {
      await this.finishSearchWriter(writer);
    }
  }

  async deleteKnowledgeDocument(documentId: string) {
    const writer = await this.beginSearchWriter();
    try {
      return await this.deleteKnowledgeChunks(documentId, writer);
    } finally {
      await this.finishSearchWriter(writer);
    }
  }

  private async deleteKnowledgeChunks(documentId: string, writer: SearchWriterLease) {
    const chunks = await this.knowledgeChunkModel.find({ documentId }).lean();
    await Promise.all(chunks.map((chunk) => this.deleteWithWriter('knowledge_chunks', chunk._id, writer)));
    return { status: 'deleted', index: 'knowledge_chunks', documentId, count: chunks.length };
  }

  async deleteIndexed(index: string, id: string) {
    const writer = await this.beginSearchWriter();
    try {
      return await this.deleteWithWriter(index, id, writer);
    } finally {
      await this.finishSearchWriter(writer);
    }
  }

  private async deleteWithWriter(index: string, id: string, writer: SearchWriterLease) {
    await this.meili.delete(index, id);
    await this.journalDelete(index as SearchIndexName, id, writer);
    return { status: 'deleted', index, id };
  }

  private rebuildDescriptors(stagingPrefix: string) {
    return [
      {
        name: 'opportunities' as const,
        stagingIndex: this.stagingIndex(stagingPrefix, 'opportunities'),
        settings: SEARCH_INDEX_SETTINGS.opportunities,
        count: () => this.opportunityModel.countDocuments({}),
        stream: () => this.cursor(this.opportunityModel.find({}).lean()),
        project: (item: Opportunity) => this.opportunityProjection(item),
      },
      {
        name: 'tasks' as const,
        stagingIndex: this.stagingIndex(stagingPrefix, 'tasks'),
        settings: SEARCH_INDEX_SETTINGS.tasks,
        count: () => this.taskModel.countDocuments({ deletedAt: { $exists: false } }),
        stream: () => this.cursor(this.taskModel.find({ deletedAt: { $exists: false } }).lean()),
        project: (item: Task) => this.taskProjection(item),
      },
      {
        name: 'profiles' as const,
        stagingIndex: this.stagingIndex(stagingPrefix, 'profiles'),
        settings: SEARCH_INDEX_SETTINGS.profiles,
        count: () => this.profileModel.countDocuments({ deletedAt: { $exists: false } }),
        stream: () => this.cursor(this.profileModel.find({ deletedAt: { $exists: false } }).lean()),
        project: (item: Profile) => this.profileProjection(item),
      },
      {
        name: 'watchlists' as const,
        stagingIndex: this.stagingIndex(stagingPrefix, 'watchlists'),
        settings: SEARCH_INDEX_SETTINGS.watchlists,
        count: () => this.watchlistModel.countDocuments({ deletedAt: { $exists: false } }),
        stream: () => this.cursor(this.watchlistModel.find({ deletedAt: { $exists: false } }).lean()),
        project: (item: Watchlist) => this.watchlistProjection(item),
      },
      {
        name: 'knowledge_chunks' as const,
        stagingIndex: this.stagingIndex(stagingPrefix, 'knowledge_chunks'),
        settings: SEARCH_INDEX_SETTINGS.knowledge_chunks,
        count: () => this.knowledgeChunkModel.countDocuments({ active: true, deletedAt: { $exists: false } }),
        stream: () => this.cursor(this.knowledgeChunkModel.find({ active: true, deletedAt: { $exists: false } }).select('+embedding').lean()),
        project: (item: KnowledgeChunk) => this.knowledgeChunkProjectionForRebuild(item),
      },
    ];
  }

  private async rebuildIndex(
    descriptor: ReturnType<SearchService['rebuildDescriptors']>[number],
    taskUids: number[],
    rebuildId: string,
    job?: Job,
  ): Promise<{ count: number }> {
    await this.updateRebuildStatus(rebuildId, { stage: `preparing:${descriptor.name}`, progress: { stage: 'preparing', index: descriptor.name, taskUids }, taskUids });
    taskUids.push(...await this.meili.prepareEmptyIndex(descriptor.stagingIndex, descriptor.settings));
    const total = await descriptor.count();
    let processed = 0;
    let batch: Array<Record<string, unknown>> = [];
    await this.updateJobProgress(job, { stage: 'indexing', index: descriptor.name, processed, total, taskUids });
    for await (const item of descriptor.stream()) {
      const projection = await descriptor.project(item as never);
      processed += 1;
      if (!projection) continue;
      batch.push(projection);
      if (batch.length >= SEARCH_REBUILD_BATCH_SIZE) {
        const taskUid = await this.meili.addDocumentsAwaited(descriptor.stagingIndex, batch);
        if (typeof taskUid === 'number') taskUids.push(taskUid);
        batch = [];
        await this.refreshRebuildLock(rebuildId);
        await this.assertNoJournalFailures(rebuildId);
        await this.updateRebuildStatus(rebuildId, { stage: `indexing:${descriptor.name}`, progress: { stage: 'indexing', index: descriptor.name, processed, total, taskUids }, taskUids });
        await this.updateJobProgress(job, { stage: 'indexing', index: descriptor.name, processed, total, taskUids });
      }
    }
    const taskUid = await this.meili.addDocumentsAwaited(descriptor.stagingIndex, batch);
    if (typeof taskUid === 'number') taskUids.push(taskUid);
    await this.updateRebuildStatus(rebuildId, { stage: `indexed:${descriptor.name}`, progress: { stage: 'indexed', index: descriptor.name, processed, total, taskUids }, taskUids });
    await this.updateJobProgress(job, { stage: 'indexed', index: descriptor.name, processed, total, taskUids });
    return { count: processed };
  }

  private cursor(query: unknown): AsyncIterable<unknown> {
    const chain = query as { cursor?: (options?: Record<string, unknown>) => AsyncIterable<unknown> };
    if (!chain.cursor) throw new Error('Search rebuild query cursor is unavailable');
    return chain.cursor({ batchSize: SEARCH_REBUILD_BATCH_SIZE });
  }

  private async acquireRebuildLock(rebuildId: string, jobId: string, stagingPrefix: string): Promise<boolean> {
    const now = new Date();
    const lockedUntil = this.lockUntil();
    const same = await this.searchRebuildLockModel.findOneAndUpdate(
      { _id: SEARCH_REBUILD_LOCK_ID, $or: [{ rebuildId }, { jobId }] },
      { $set: { jobId, rebuildId, stagingPrefix, lockedUntil } },
      { new: true },
    ).lean();
    if (same) return true;
    const expired = await this.searchRebuildLockModel.findOneAndUpdate(
      { _id: SEARCH_REBUILD_LOCK_ID, lockedUntil: { $lte: now }, phase: 'building' },
      { $set: { jobId, rebuildId, stagingPrefix, lockedUntil, phase: 'building' }, $unset: { journalError: 1 } },
      { new: true },
    ).lean();
    if (expired) return true;
    try {
      await this.searchRebuildLockModel.create({ _id: SEARCH_REBUILD_LOCK_ID, jobId, rebuildId, stagingPrefix, lockedUntil, phase: 'building' });
      return true;
    } catch (error) {
      if ((error as { code?: unknown })?.code === 11000) return false;
      throw error;
    }
  }

  private async refreshRebuildLock(rebuildId: string): Promise<void> {
    await this.searchRebuildLockModel.updateOne({ _id: SEARCH_REBUILD_LOCK_ID, rebuildId }, { $set: { lockedUntil: this.lockUntil() } });
  }

  private async releaseRebuildLock(rebuildId: string): Promise<void> {
    await this.searchRebuildLockModel.deleteOne({ _id: SEARCH_REBUILD_LOCK_ID, rebuildId });
  }

  private lockUntil(): Date {
    return new Date(Date.now() + SEARCH_REBUILD_LOCK_TTL_MS);
  }


  private async activeRebuildLock(): Promise<SearchRebuildActiveLock | null> {
    const lock = await this.searchRebuildLockModel.findOne({ _id: SEARCH_REBUILD_LOCK_ID }).lean();
    if (!lock) return null;
    if (lock.phase === 'publishing' || lock.lockedUntil > new Date()) return lock;
    return null;
  }

  private stagingIndex(stagingPrefix: string, index: SearchIndexName): string {
    return `${stagingPrefix}_${index}`;
  }

  private async beginSearchWriter(): Promise<SearchWriterLease> {
    const deadline = Date.now() + SEARCH_UPDATE_PUBLISH_WAIT_TIMEOUT_MS;
    for (;;) {
      const writerId = newId();
      await this.searchRebuildWriterModel.create({ _id: writerId });
      const lock = await this.activeRebuildLock();
      if (lock?.phase !== 'publishing') return { writerId };
      await this.searchRebuildWriterModel.deleteOne({ _id: writerId });
      if (Date.now() >= deadline) throw new ConflictException('Search rebuild is still publishing; retry search index update later');
      await this.delay(SEARCH_UPDATE_PUBLISH_WAIT_INTERVAL_MS);
    }
  }

  private async finishSearchWriter(writer: SearchWriterLease): Promise<void> {
    await this.searchRebuildWriterModel.deleteOne({ _id: writer.writerId });
  }

  private async journalUpsert(index: SearchIndexName, documents: Array<Record<string, unknown>>, writer: SearchWriterLease): Promise<void> {
    if (!documents.length) return;
    const lock = await this.activeRebuildLock();
    if (!lock) return;
    try {
      await this.searchRebuildWriterModel.updateOne({ _id: writer.writerId }, { $set: { rebuildId: lock.rebuildId } });
      await this.searchRebuildMutationModel.insertMany(documents.map((document) => ({
        _id: newId(),
        rebuildId: lock.rebuildId,
        index,
        operation: 'upsert',
        documentId: String(document.id),
      })), { ordered: true });
    } catch (error) {
      await this.markJournalFailure(lock.rebuildId, error);
      throw error;
    }
  }

  private async journalDelete(index: SearchIndexName, id: string, writer: SearchWriterLease): Promise<void> {
    const lock = await this.activeRebuildLock();
    if (!lock) return;
    try {
      await this.searchRebuildWriterModel.updateOne({ _id: writer.writerId }, { $set: { rebuildId: lock.rebuildId } });
      await this.searchRebuildMutationModel.create({ _id: newId(), rebuildId: lock.rebuildId, index, operation: 'delete', documentId: id });
    } catch (error) {
      await this.markJournalFailure(lock.rebuildId, error);
      throw error;
    }
  }

  private async markJournalFailure(rebuildId: string, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await Promise.all([
      this.searchRebuildLockModel.updateOne({ _id: SEARCH_REBUILD_LOCK_ID, rebuildId }, { $set: { journalError: message } }),
      this.searchRebuildModel.updateOne({ _id: rebuildId }, { $set: { journalError: message } }),
    ]);
  }

  private async assertNoJournalFailures(rebuildId: string): Promise<void> {
    const lock = await this.searchRebuildLockModel.findOne({ _id: SEARCH_REBUILD_LOCK_ID, rebuildId }).lean();
    if (lock?.journalError) throw new Error(`Search rebuild journal failed; live index retained: ${lock.journalError}`);
  }

  private async enterPublishingPhase(rebuildId: string, job: Job | undefined, taskUids: number[]): Promise<void> {
    const result = await this.searchRebuildLockModel.updateOne(
      { _id: SEARCH_REBUILD_LOCK_ID, rebuildId, phase: 'building' },
      { $set: { phase: 'publishing', lockedUntil: this.lockUntil() } },
    );
    if (!result.matchedCount) {
      const current = await this.searchRebuildLockModel.findOne({ _id: SEARCH_REBUILD_LOCK_ID, rebuildId }).lean();
      if (current?.phase !== 'publishing') throw new ConflictException('Search rebuild lock was lost before publishing');
    }
    await this.waitForSearchWritersToDrain(rebuildId, job, taskUids);
  }

  private async waitForSearchWritersToDrain(rebuildId: string, job: Job | undefined, taskUids: number[]): Promise<void> {
    const deadline = Date.now() + SEARCH_REBUILD_WRITER_DRAIN_TIMEOUT_MS;
    for (;;) {
      await this.refreshRebuildLock(rebuildId);
      await this.assertNoJournalFailures(rebuildId);
      const activeWriters = await this.searchRebuildWriterModel.countDocuments({});
      await this.updateJobProgress(job, { stage: 'draining-search-writers', processed: 0, total: activeWriters, taskUids });
      await this.updateRebuildStatus(rebuildId, { stage: 'draining-search-writers', progress: { stage: 'draining-search-writers', processed: 0, total: activeWriters, taskUids }, taskUids });
      if (activeWriters === 0) return;
      if (Date.now() >= deadline) throw new Error(`Search rebuild could not drain ${activeWriters} active search writer(s); live index retained`);
      await this.delay(SEARCH_REBUILD_WRITER_DRAIN_INTERVAL_MS);
    }
  }

  private async replayRebuildJournal(rebuildId: string, stagingPrefix: string, taskUids: number[], job?: Job): Promise<void> {
    const total = await this.searchRebuildMutationModel.countDocuments({ rebuildId });
    let processed = 0;
    for await (const item of this.cursor(this.searchRebuildMutationModel.find({ rebuildId }).sort({ createdAt: 1, _id: 1 }).lean())) {
      const mutation = item as SearchMutation;
      if (!this.isSearchIndexName(mutation.index)) continue;
      await this.applyCurrentDocumentToStaging(stagingPrefix, mutation.index, mutation.documentId, taskUids);
      processed += 1;
      if (processed % SEARCH_REBUILD_BATCH_SIZE === 0) {
        await this.refreshRebuildLock(rebuildId);
        await this.assertNoJournalFailures(rebuildId);
        await this.updateJobProgress(job, { stage: 'replaying-journal', index: mutation.index, processed, total, taskUids });
        await this.updateRebuildStatus(rebuildId, { stage: 'replaying-journal', progress: { stage: 'replaying-journal', index: mutation.index, processed, total, taskUids }, taskUids });
      }
    }
    await this.updateJobProgress(job, { stage: 'replaying-journal', processed, total, taskUids });
    await this.updateRebuildStatus(rebuildId, { stage: 'replaying-journal', progress: { stage: 'replaying-journal', processed, total, taskUids }, taskUids });
  }

  private async applyCurrentDocumentToStaging(stagingPrefix: string, index: SearchIndexName, documentId: string, taskUids: number[]): Promise<void> {
    const stagingIndex = this.stagingIndex(stagingPrefix, index);
    const projection = await this.currentSearchProjection(index, documentId);
    if (!projection) {
      await this.meili.delete(stagingIndex, documentId);
      return;
    }
    const taskUid = await this.meili.addDocumentsAwaited(stagingIndex, [projection]);
    if (typeof taskUid === 'number') taskUids.push(taskUid);
  }

  private async currentSearchProjection(index: SearchIndexName, documentId: string): Promise<Record<string, unknown> | null> {
    switch (index) {
      case 'opportunities': {
        const opportunity = await this.opportunityModel.findById(documentId).lean();
        return opportunity ? this.opportunityProjection(opportunity) : null;
      }
      case 'tasks': {
        const task = await this.taskModel.findOne({ _id: documentId, deletedAt: { $exists: false } }).lean();
        return task ? this.taskProjection(task) : null;
      }
      case 'profiles': {
        const profile = await this.profileModel.findOne({ _id: documentId, deletedAt: { $exists: false } }).lean();
        return profile ? this.profileProjection(profile) : null;
      }
      case 'watchlists': {
        const watchlist = await this.watchlistModel.findOne({ _id: documentId, deletedAt: { $exists: false } }).lean();
        return watchlist ? this.watchlistProjection(watchlist) : null;
      }
      case 'knowledge_chunks': {
        const chunk = await this.knowledgeChunkModel.findOne({ _id: documentId, active: true, deletedAt: { $exists: false } }).select('+embedding').lean();
        if (!chunk) return null;
        return this.knowledgeChunkProjectionForRebuild(chunk);
      }
    }
  }

  private async knowledgeChunkProjectionForRebuild(chunk: KnowledgeChunk): Promise<Record<string, unknown> | null> {
    const document = await this.knowledgeDocumentModel.findOne({ _id: chunk.documentId, deletedAt: { $exists: false } }).lean();
    if (!document || document.mode === 'disabled') return null;
    return this.knowledgeChunkProjection(chunk, document);
  }

  private isSearchIndexName(index: string): index is SearchIndexName {
    return index in SEARCH_INDEX_SETTINGS;
  }

  private async cleanupStagingIndexes(stagingPrefix: string, taskUids: number[], priorWarning?: string): Promise<string | undefined> {
    const warnings = priorWarning ? [priorWarning] : [];
    for (const descriptor of this.rebuildDescriptors(stagingPrefix)) {
      try {
        const cleanupTask = await this.meili.deleteIndexIfExists(descriptor.stagingIndex);
        if (typeof cleanupTask === 'number') taskUids.push(cleanupTask);
      } catch (error) {
        warnings.push(`cleanup ${descriptor.stagingIndex}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return warnings.length ? warnings.join('; ').slice(0, 2000) : undefined;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async updateRebuildStatus(rebuildId: string, patch: Partial<SearchRebuild>): Promise<void> {
    const setOnInsert: Partial<SearchRebuild> = { _id: rebuildId };
    if (!('status' in patch)) setOnInsert.status = 'Running';
    if (!('jobId' in patch)) setOnInsert.jobId = rebuildId;
    if (!('stagingPrefix' in patch)) setOnInsert.stagingPrefix = `rebuild_${rebuildId.replaceAll('-', '')}`;
    await this.searchRebuildModel.updateOne(
      { _id: rebuildId },
      {
        $set: patch,
        $setOnInsert: setOnInsert,
      },
      { upsert: true },
    );
  }

  private async updateJobProgress(job: Job | undefined, progress: SearchRebuildJobProgress): Promise<void> {
    await job?.updateProgress(progress).catch(() => undefined);
  }

  private async searchScope(actor: Actor, scope: Exclude<SearchScope, 'all'>, dto: UnifiedSearchDto, limit: number): Promise<{ scope: SearchScope; items: SearchItem[] }> {
    if (this.meili.available() && (scope === 'opportunities' || scope === 'knowledge')) {
      try {
        const meiliItems = await this.searchMeili(actor, scope, dto, limit);
        if (meiliItems.length) return { scope, items: meiliItems };
      } catch {
        // Mongo fallback below is deliberate: search remains truthful and marks indexAvailable=false at top level only when Meili is not configured.
      }
    }
    return { scope, items: await this.searchMongo(actor, scope, dto, limit) };
  }

  private async searchMeili(actor: Actor, scope: Exclude<SearchScope, 'all'>, dto: UnifiedSearchDto, limit: number): Promise<SearchItem[]> {
    if (scope === 'knowledge') {
      const result = await this.knowledgeService.retrieveForActor(actor, dto.query, dto.profileId, limit);
      return result.evidence.map((item) => ({
        id: item.chunkId,
        entityType: 'knowledge',
        title: item.documentTitle,
        excerpt: item.excerpt,
        score: item.score,
        url: `/knowledge/documents/${item.documentId}`,
        payload: item,
      }));
    }
    const hits = await this.meili.search('opportunities', dto.query, { limit });
    const opportunities = await this.opportunitiesRepository.findByIds(hits.map((hit) => hit.id));
    return opportunities.map((opportunity) => ({
      id: opportunity._id,
      entityType: 'opportunities',
      title: opportunity.title,
      subtitle: opportunity.companyOrClient,
      excerpt: opportunity.summary ?? opportunity.description.slice(0, 400),
      score: hits.find((hit) => hit.id === opportunity._id)?.score,
      url: `/opportunities/${opportunity._id}`,
      payload: { type: opportunity.type, sourceStatus: opportunity.sourceStatus },
    }));
  }

  private async searchMongo(actor: Actor, scope: Exclude<SearchScope, 'all'>, dto: UnifiedSearchDto, limit: number): Promise<SearchItem[]> {
    switch (scope) {
      case 'opportunities': {
        const result = await this.opportunitiesRepository.list({ query: dto.query, profileId: dto.profileId, limit, archive: true });
        return result.items.map((opportunity) => ({
          id: opportunity._id,
          entityType: 'opportunities',
          title: opportunity.title,
          subtitle: opportunity.companyOrClient,
          excerpt: opportunity.summary ?? opportunity.description.slice(0, 400),
          url: `/opportunities/${opportunity._id}`,
          payload: { type: opportunity.type, sourceStatus: opportunity.sourceStatus },
        }));
      }
      case 'tasks': {
        const boardIds = actor.role === 'Admin' ? undefined : (await this.tasksRepository.listBoardsForUser(actor.id)).map((board) => board._id);
        const tasks = await this.tasksRepository.listTasks({ boardIds });
        return tasks
          .filter((task) => this.includes(task.title, dto.query) || this.includes(task.description, dto.query))
          .slice(0, limit)
          .map((task) => ({ id: task._id, entityType: 'tasks', title: task.title, subtitle: task.type, excerpt: task.description.slice(0, 400), url: `/tasks/${task._id}` }));
      }
      case 'profiles': {
        const profiles = actor.role === 'Admin' ? [] : await this.profilesRepository.listByUser(actor.id);
        return profiles
          .filter((profile) => this.includes([profile.name, ...profile.targetRoles, ...profile.technologies].join(' '), dto.query))
          .slice(0, limit)
          .map((profile) => ({ id: profile._id, entityType: 'profiles', title: profile.name, subtitle: profile.kind, excerpt: profile.structuredExperienceSummary, url: `/profiles/${profile._id}` }));
      }
      case 'watchlists': {
        const watchlists = actor.role === 'Admin' ? await this.watchlistsRepository.listAll() : await this.watchlistsRepository.listByUser(actor.id);
        return watchlists
          .filter((watchlist) => this.includes(watchlist.name, dto.query))
          .slice(0, limit)
          .map((watchlist) => ({ id: watchlist._id, entityType: 'watchlists', title: watchlist.name, subtitle: watchlist.active ? 'Active' : 'Paused', url: `/watchlists/${watchlist._id}` }));
      }
      case 'knowledge': {
        const result = await this.knowledgeService.retrieveForActor(actor, dto.query, dto.profileId, limit);
        return result.evidence.map((item) => ({
          id: item.chunkId,
          entityType: 'knowledge',
          title: item.documentTitle,
          excerpt: item.excerpt,
          score: item.score,
          url: `/knowledge/documents/${item.documentId}`,
          payload: item,
        }));
      }
    }
  }

  private includes(value: string | undefined, query: string): boolean {
    return (value ?? '').toLowerCase().includes(query.toLowerCase());
  }

  private opportunityProjection(opportunity: Opportunity): Record<string, unknown> {
    return {
      id: opportunity._id,
      type: opportunity.type,
      title: opportunity.title,
      companyOrClient: opportunity.companyOrClient,
      descriptionText: opportunity.description,
      summary: opportunity.summary,
      skills: opportunity.skills,
      technologies: opportunity.technologies,
      seniority: opportunity.seniority,
      employmentType: opportunity.employmentType,
      remoteType: opportunity.remoteType,
      location: opportunity.location,
      countriesAllowed: opportunity.countriesAllowed,
      moneyNormalized: opportunity.money,
      sourceIds: opportunity.sourceOccurrences.map((item) => item.sourceId),
      sourceGroups: opportunity.sourceOccurrences.map((item) => item.sourceMetadata?.group).filter(Boolean),
      sourceStatus: opportunity.sourceStatus,
      publishedAt: opportunity.publishedAt?.toISOString?.() ?? null,
      firstSeenAt: opportunity.firstSeenAt?.toISOString?.() ?? null,
      deadline: opportunity.deadline?.toISOString?.() ?? null,
      tags: opportunity.canonicalTags,
      updatedAt: (opportunity as Opportunity & { updatedAt?: Date }).updatedAt?.toISOString?.() ?? null,
    };
  }

  private taskProjection(task: Task): Record<string, unknown> {
    return {
      id: task._id,
      userIds: [task.reporterId, task.assigneeId].filter(Boolean),
      boardId: task.boardId,
      title: task.title,
      description: task.description,
      type: task.type,
      priority: task.priority,
      labels: task.labels,
      opportunityId: task.opportunityId,
      profileId: task.profileId,
      dueAt: task.dueAt?.toISOString?.() ?? null,
      updatedAt: (task as Task & { updatedAt?: Date }).updatedAt?.toISOString?.() ?? null,
    };
  }

  private profileProjection(profile: Profile): Record<string, unknown> {
    return {
      id: profile._id,
      userId: profile.userId,
      title: profile.name,
      kind: profile.kind,
      targetRoles: profile.targetRoles,
      seniority: profile.seniority,
      technologies: profile.technologies,
      locations: profile.locations,
      summary: profile.structuredExperienceSummary,
      updatedAt: (profile as Profile & { updatedAt?: Date }).updatedAt?.toISOString?.() ?? null,
    };
  }

  private watchlistProjection(watchlist: Watchlist): Record<string, unknown> {
    return {
      id: watchlist._id,
      userId: watchlist.userId,
      profileId: watchlist.profileId,
      title: watchlist.name,
      filters: watchlist.filters,
      active: watchlist.active,
      totalHits: watchlist.totalHits,
      updatedAt: (watchlist as Watchlist & { updatedAt?: Date }).updatedAt?.toISOString?.() ?? null,
    };
  }

  private knowledgeChunkProjection(chunk: KnowledgeChunk, document?: KnowledgeDocument): Record<string, unknown> {
    return {
      id: chunk._id,
      documentId: chunk.documentId,
      documentTitle: document?.title,
      userId: chunk.userId,
      profileIds: chunk.profileIds,
      section: chunk.section,
      type: chunk.type,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      inputHash: chunk.inputHash,
      embeddingModel: chunk.embeddingMetadata?.model,
      _vectors: chunk.embedding?.length ? { default: chunk.embedding } : undefined,
      updatedAt: (chunk as KnowledgeChunk & { updatedAt?: Date }).updatedAt?.toISOString?.() ?? null,
    };
  }
}

const SEARCH_INDEX_SETTINGS = {
  opportunities: {
    searchableAttributes: ['title', 'companyOrClient', 'summary', 'skills', 'technologies', 'descriptionText', 'tags'],
    filterableAttributes: ['type', 'skills', 'technologies', 'seniority', 'employmentType', 'remoteType', 'location', 'countriesAllowed', 'sourceIds', 'sourceGroups', 'sourceStatus', 'tags'],
    sortableAttributes: ['publishedAt', 'firstSeenAt', 'updatedAt', 'deadline'],
  },
  knowledge_chunks: {
    searchableAttributes: ['documentTitle', 'section', 'text'],
    filterableAttributes: ['userId', 'profileIds', 'documentId', 'section', 'type', 'embeddingModel'],
    sortableAttributes: ['updatedAt', 'chunkIndex'],
  },
  tasks: {
    searchableAttributes: ['title', 'description', 'labels'],
    filterableAttributes: ['userIds', 'boardId', 'type', 'priority', 'opportunityId', 'profileId'],
    sortableAttributes: ['dueAt', 'updatedAt'],
  },
  profiles: {
    searchableAttributes: ['title', 'targetRoles', 'technologies', 'summary'],
    filterableAttributes: ['userId', 'kind', 'targetRoles', 'technologies', 'locations'],
    sortableAttributes: ['updatedAt'],
  },
  watchlists: {
    searchableAttributes: ['title'],
    filterableAttributes: ['userId', 'profileId', 'active'],
    sortableAttributes: ['updatedAt', 'totalHits'],
  },
} as const;

const SEARCH_REBUILD_BATCH_SIZE = 500;
const SEARCH_REBUILD_LOCK_ID = 'search-rebuild';
const SEARCH_REBUILD_LOCK_TTL_MS = 60 * 60 * 1000;
const SEARCH_REBUILD_WRITER_DRAIN_TIMEOUT_MS = 2 * 60 * 1000;
const SEARCH_REBUILD_WRITER_DRAIN_INTERVAL_MS = 250;
const SEARCH_UPDATE_PUBLISH_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const SEARCH_UPDATE_PUBLISH_WAIT_INTERVAL_MS = 250;
