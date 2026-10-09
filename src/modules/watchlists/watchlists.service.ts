import { ForbiddenException, Injectable, OnModuleInit, Optional } from '@nestjs/common';

import { Actor } from '../../common/access';
import { toPublic } from '../../common/schema';
import { AiService } from '../ai/ai.service';
import { JobsService } from '../jobs/jobs.service';
import { MatchingService } from '../matching';
import { NotificationsService } from '../notifications';
import { OpportunitiesRepository } from '../opportunities/opportunities.repository';
import { Opportunity } from '../opportunities/schemas/opportunity.schema';
import { Profile, ProfilesRepository } from '../profiles';
import { UsersRepository } from '../users/users.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { UpsertWatchlistDto, UpdateWatchlistDto } from './dto/watchlist.dto';
import { WatchlistHit } from './schemas/watchlist-hit.schema';
import { Watchlist } from './schemas/watchlist.schema';
import { WebhooksService } from '../webhooks';
import { WatchlistsRepository } from './watchlists.repository';

type WatchlistEvaluationContext = {
  effectMode?: 'fresh' | 'historical';
  sourceRunId?: string;
  sourceId?: string;
};

@Injectable()
export class WatchlistsService implements OnModuleInit {
  constructor(
    private readonly repository: WatchlistsRepository,
    private readonly profilesRepository: ProfilesRepository,
    private readonly realtime: RealtimeService,
    private readonly usersRepository: UsersRepository,
    @Optional() private readonly matchingService?: MatchingService,
    @Optional() private readonly aiService?: AiService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly webhooksService?: WebhooksService,
    @Optional() private readonly jobsService?: JobsService,
    @Optional() private readonly opportunitiesRepository?: OpportunitiesRepository,
  ) {}

  onModuleInit(): void {
    this.jobsService?.registerHandler('analytics', 'watchlist.evaluate', async (data) => this.handleScheduledEvaluate(data));
    this.jobsService?.registerHandler('analytics', 'watchlist.backfill', async (data) => this.handleBackfill(data));
  }

  async list(actor: Actor) {
    const watchlists = actor.role === 'Admin' ? await this.repository.listAll() : await this.repository.listByUser(actor.id);
    return watchlists.map((watchlist) => toPublic(watchlist));
  }

  async create(actor: Actor, dto: UpsertWatchlistDto) {
    await this.profilesRepository.getOwned(dto.profileId, actor.id);
    const created = await this.repository.create({
      ...this.toPatch(dto),
      userId: actor.id,
      autoAiRules: this.mergeAutoAiRules({ enabled: false }, dto.autoAiRules ?? {}),
      active: dto.active ?? true,
    });
    this.realtime.publish(actor.id, 'watchlist.created', { watchlistId: created._id });
    await this.enqueueWatchlistIndex(created._id);
    return toPublic(created);
  }

  async get(actor: Actor, id: string) {
    const watchlist = await this.getAccessible(actor, id);
    return toPublic(watchlist);
  }

  async update(actor: Actor, id: string, dto: UpdateWatchlistDto) {
    const existing = await this.getAccessible(actor, id);
    if (dto.profileId) {
      await this.ensureProfileAccess(actor, dto.profileId);
    }
    const updated = await this.repository.update(id, {
      ...this.toPatch(dto),
      autoAiRules: dto.autoAiRules ? this.mergeAutoAiRules(existing.autoAiRules, dto.autoAiRules) : existing.autoAiRules,
    });
    this.realtime.publish(updated.userId, 'watchlist.updated', { watchlistId: updated._id });
    await this.enqueueWatchlistIndex(updated._id);
    return toPublic(updated);
  }

  async pause(actor: Actor, id: string) {
    await this.getAccessible(actor, id);
    const updated = await this.repository.update(id, { active: false });
    this.realtime.publish(updated.userId, 'watchlist.paused', { watchlistId: updated._id });
    await this.enqueueWatchlistIndex(updated._id);
    return toPublic(updated);
  }

  async resume(actor: Actor, id: string) {
    await this.getAccessible(actor, id);
    const updated = await this.repository.update(id, { active: true });
    this.realtime.publish(updated.userId, 'watchlist.resumed', { watchlistId: updated._id });
    await this.enqueueWatchlistIndex(updated._id);
    return toPublic(updated);
  }

  async duplicate(actor: Actor, id: string) {
    const source = await this.getAccessible(actor, id);
    const {
      _id: _sourceId,
      deletedAt: _deletedAt,
      lastHitAt: _lastHitAt,
      totalHits: _totalHits,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...copyable
    } = source as Watchlist & { createdAt?: Date; updatedAt?: Date };
    const copy = await this.repository.create({
      ...copyable,
      name: `${source.name} copy`,
      active: false,
      totalHits: 0,
    });
    await this.enqueueWatchlistIndex(copy._id);
    return toPublic(copy);
  }

  async delete(actor: Actor, id: string) {
    await this.getAccessible(actor, id);
    await this.repository.softDelete(id);
    await this.enqueueWatchlistDelete(id);
    return { success: true };
  }

  async hits(actor: Actor, id: string, limit?: number) {
    const watchlist = await this.getAccessible(actor, id);
    const hits = await this.repository.listHits(id, limit);
    return { watchlist: toPublic(watchlist), items: hits.map((hit) => toPublic(hit)), nextCursor: null };
  }

  async evaluateOpportunity(opportunity: Opportunity, context: WatchlistEvaluationContext = {}): Promise<{ evaluated: number; hits: number; autoAiQueued: number }> {
    if (!this.matchingService) return { evaluated: 0, hits: 0, autoAiQueued: 0 };
    const watchlists = await this.repository.listActive();
    let evaluated = 0;
    let hits = 0;
    let autoAiQueued = 0;
    for (const watchlist of watchlists) {
      const result = await this.evaluateOne(watchlist, opportunity, context);
      if (result.evaluated) evaluated += 1;
      if (result.hit) hits += 1;
      if (result.autoAiQueued) autoAiQueued += 1;
    }
    return { evaluated, hits, autoAiQueued };
  }

  private async handleScheduledEvaluate(data: Record<string, unknown>) {
    if (!this.opportunitiesRepository) throw new Error('Opportunities repository is not available');
    const watchlistId = typeof data.watchlistId === 'string' ? data.watchlistId : '';
    const opportunityId = typeof data.opportunityId === 'string' ? data.opportunityId : '';
    if (!watchlistId || !opportunityId) throw new Error('watchlist.evaluate requires watchlistId and opportunityId');
    const [watchlist, opportunity] = await Promise.all([this.repository.getById(watchlistId), this.opportunitiesRepository.getById(opportunityId)]);
    const result = await this.evaluateOne(watchlist, opportunity);
    return { watchlistId, opportunityId, evaluated: result.evaluated ? 1 : 0, hits: result.hit ? 1 : 0, autoAiQueued: result.autoAiQueued ? 1 : 0 };
  }

  private async handleBackfill(data: Record<string, unknown>) {
    if (!this.opportunitiesRepository) throw new Error('Opportunities repository is not available');
    const watchlistId = typeof data.watchlistId === 'string' ? data.watchlistId : '';
    if (!watchlistId) throw new Error('watchlist.backfill requires watchlistId');
    const limit = Math.min(typeof data.limit === 'number' ? data.limit : 200, 500);
    const watchlist = await this.repository.getById(watchlistId);
    if (!watchlist.active || watchlist.deletedAt) return { watchlistId, evaluated: 0, hits: 0, autoAiQueued: 0 };
    const opportunities = await this.opportunitiesRepository.findActiveForMatching(limit);
    let evaluated = 0;
    let hits = 0;
    let autoAiQueued = 0;
    for (const opportunity of opportunities) {
      const result = await this.evaluateOne(watchlist, opportunity, { effectMode: 'historical' });
      if (result.evaluated) evaluated += 1;
      if (result.hit) hits += 1;
      if (result.autoAiQueued) autoAiQueued += 1;
    }
    return { watchlistId, evaluated, hits, autoAiQueued };
  }

  private async evaluateOne(watchlist: Watchlist, opportunity: Opportunity, context: WatchlistEvaluationContext = {}): Promise<{ evaluated: boolean; hit: boolean; autoAiQueued: boolean }> {
    if (!this.matchingService || !watchlist.active || watchlist.deletedAt || !this.matchesFilters(watchlist, opportunity)) {
      return { evaluated: false, hit: false, autoAiQueued: false };
    }
    const profile = await this.profilesRepository.findById(watchlist.profileId);
    if (!profile || profile.deletedAt) return { evaluated: false, hit: false, autoAiQueued: false };
    if (profile.userId !== watchlist.userId) return { evaluated: false, hit: false, autoAiQueued: false };
    if (!(await this.hasActiveOwner(watchlist.userId))) return { evaluated: false, hit: false, autoAiQueued: false };
    if (!this.matchesProfileSources(profile, opportunity)) return { evaluated: true, hit: false, autoAiQueued: false };
    const match = this.matchingService.calculate(opportunity, profile);
    if (typeof watchlist.matchMin === 'number' && match.score < watchlist.matchMin) return { evaluated: true, hit: false, autoAiQueued: false };
    const aiScore = await this.latestAiScore(watchlist, opportunity, profile);
    if (typeof watchlist.aiMin === 'number' && (typeof aiScore !== 'number' || aiScore < watchlist.aiMin)) return { evaluated: true, hit: false, autoAiQueued: false };
    const notificationKey = context.effectMode === 'historical' ? undefined : `watchlist.hit:${watchlist._id}:${opportunity._id}`;
    const hit = await this.repository.recordHit({
      watchlistId: watchlist._id,
      userId: watchlist.userId,
      profileId: watchlist.profileId,
      opportunityId: opportunity._id,
      matchScore: match.score,
      ...(typeof aiScore === 'number' ? { aiScore } : {}),
      notificationState: context.effectMode === 'historical' ? 'suppressed_historical' : 'pending',
      ...(notificationKey ? { notificationKey } : {}),
      autoAiState: watchlist.autoAiRules?.enabled ? 'eligible' : 'off',
    });
    const hitPayload = { watchlistId: watchlist._id, opportunityId: opportunity._id, matchScore: match.score };
    if (context.effectMode !== 'historical' && hit.notificationKey && hit.notificationState === 'pending') {
      const policy = this.notificationPolicy(watchlist);
      const notification = await this.notificationsService?.notify({
        userId: watchlist.userId,
        type: 'watchlist.hit',
        title: 'New watchlist hit',
        body: opportunity.title,
        data: hitPayload,
        idempotencyKey: hit.notificationKey,
        channels: { inApp: policy.inApp, email: policy.email, telegram: policy.telegram },
        mode: policy.mode,
      });
      if (notification?.newlyCreated !== false) {
        if (policy.inApp !== false) this.realtime.publish(watchlist.userId, 'watchlist.hit', hitPayload);
        await this.webhooksService?.emit(watchlist.userId, 'notification.created', { type: 'watchlist.hit', ...hitPayload });
      }
      await this.repository.markNotificationState(hit._id, 'notified');
    }
    return { evaluated: true, hit: true, autoAiQueued: await this.enqueueOptionalAutoAi(watchlist, profile, opportunity, hit, context) };
  }

  private matchesFilters(watchlist: Watchlist, opportunity: Opportunity): boolean {
    const filters = watchlist.filters ?? {};
    if (typeof filters.type === 'string' && opportunity.type !== filters.type) return false;
    if (typeof filters.remoteType === 'string' && opportunity.remoteType !== filters.remoteType) return false;
    if (typeof filters.query === 'string' && filters.query.trim() && !this.matchesQuery(opportunity, filters.query)) return false;
    const sourceIds = Array.isArray(filters.sourceIds) ? filters.sourceIds : undefined;
    if (sourceIds?.length && !opportunity.sourceOccurrences.some((occurrence) => sourceIds.includes(occurrence.sourceId))) return false;
    const technologies = Array.isArray(filters.technologies) ? filters.technologies.map(String) : undefined;
    if (technologies?.length && !technologies.some((technology) => opportunity.technologies.includes(technology))) return false;
    const skills = Array.isArray(filters.skills) ? filters.skills.map(String) : undefined;
    if (skills?.length && !skills.some((skill) => opportunity.skills.includes(skill))) return false;
    if (!this.matchesExclusions(watchlist, opportunity)) return false;
    return true;
  }

  private async enqueueOptionalAutoAi(watchlist: Watchlist, profile: Profile, opportunity: Opportunity, hit: WatchlistHit, context: WatchlistEvaluationContext): Promise<boolean> {
    if (context.effectMode === 'historical') return false;
    if (hit.notificationState === 'suppressed_historical') return false;
    if (!watchlist.autoAiRules?.enabled || !this.aiService) return false;
    if (!watchlist.autoAiRules.rerunOnMaterialChange && ['queued', 'completed'].includes(hit.autoAiState)) return false;
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    if (typeof watchlist.autoAiRules.dailyMax === 'number') {
      const usedToday = await this.repository.countAutoAiQueuedSince(watchlist._id, since);
      if (usedToday >= watchlist.autoAiRules.dailyMax) return false;
    }
    const run = await this.aiService.runOpportunityAnalysis(
      { id: watchlist.userId, email: `user:${watchlist.userId}`, role: 'User' },
      { opportunityId: opportunity._id, profileId: profile._id },
    );
    await this.repository.markAutoAiQueued(hit._id, run._id);
    return true;
  }

  private async hasActiveOwner(userId: string): Promise<boolean> {
    const owner = await this.usersRepository.findById(userId);
    return owner?.status === 'Active' && !owner.deletedAt;
  }

  private matchesProfileSources(profile: Profile, opportunity: Opportunity): boolean {
    const sourceIds = profile.sourceIds ?? [];
    return !sourceIds.length || opportunity.sourceOccurrences.some((occurrence) => sourceIds.includes(occurrence.sourceId));
  }

  private matchesQuery(opportunity: Opportunity, query: string): boolean {
    const needle = query.trim().toLocaleLowerCase();
    const values = [
      opportunity.title,
      opportunity.companyOrClient,
      ...(opportunity.canonicalTags ?? []),
      ...(opportunity.skills ?? []),
      ...(opportunity.technologies ?? []),
    ];
    return values.some((value) => String(value ?? '').toLocaleLowerCase().includes(needle));
  }

  private matchesExclusions(watchlist: Watchlist, opportunity: Opportunity): boolean {
    const exclusions = watchlist.exclusions ?? {};
    const companies = Array.isArray(exclusions.companies) ? exclusions.companies.map((item) => String(item).trim().toLocaleLowerCase()).filter(Boolean) : [];
    if (companies.length && companies.includes((opportunity.companyOrClient ?? '').toLocaleLowerCase())) return false;
    const keywords = Array.isArray(exclusions.keywords) ? exclusions.keywords.map((item) => String(item).trim().toLocaleLowerCase()).filter(Boolean) : [];
    if (keywords.length) {
      const haystack = [opportunity.title, opportunity.companyOrClient, opportunity.description, opportunity.summary].join(' ').toLocaleLowerCase();
      if (keywords.some((keyword) => haystack.includes(keyword))) return false;
    }
    const sourceIds = Array.isArray(exclusions.sourceIds) ? exclusions.sourceIds.map(String) : [];
    if (sourceIds.length && opportunity.sourceOccurrences.some((occurrence) => sourceIds.includes(occurrence.sourceId))) return false;
    return true;
  }

  private async latestAiScore(watchlist: Watchlist, opportunity: Opportunity, profile: Profile): Promise<number | undefined> {
    if (typeof watchlist.aiMin !== 'number' || !this.opportunitiesRepository) return undefined;
    const repository = this.opportunitiesRepository as unknown as {
      latestCompletedAnalysisByOpportunity?: (input: { userId: string; profileId?: string; opportunityIds?: string[] }) => Promise<Array<{ opportunityId: string; aiScore: number | null }>>;
    };
    if (typeof repository.latestCompletedAnalysisByOpportunity !== 'function') return undefined;
    const rows = await repository.latestCompletedAnalysisByOpportunity({ userId: watchlist.userId, profileId: profile._id, opportunityIds: [opportunity._id] });
    const score = rows.find((row) => row.opportunityId === opportunity._id)?.aiScore;
    return typeof score === 'number' ? score : undefined;
  }

  private notificationPolicy(watchlist: Watchlist): { inApp: boolean; email?: boolean; telegram?: boolean; mode?: 'instant' | 'daily' | 'weekly' } {
    const policy = watchlist.notificationPolicy ?? {};
    const mode = policy.mode === 'daily' || policy.mode === 'weekly' || policy.mode === 'instant' ? policy.mode : undefined;
    return {
      inApp: policy.inApp !== false,
      ...(typeof policy.email === 'boolean' ? { email: policy.email } : {}),
      ...(typeof policy.telegram === 'boolean' ? { telegram: policy.telegram } : {}),
      ...(mode ? { mode } : {}),
    };
  }

  private mergeAutoAiRules(existing: Watchlist['autoAiRules'], patch: { enabled?: boolean; dailyMax?: number | null; rerunOnMaterialChange?: boolean }): Watchlist['autoAiRules'] {
    const merged = { ...(existing ?? { enabled: false }), ...patch } as Watchlist['autoAiRules'] & { dailyMax?: number | null };
    if (patch.dailyMax === null) delete merged.dailyMax;
    return merged as Watchlist['autoAiRules'];
  }

  private async enqueueWatchlistIndex(watchlistId: string): Promise<void> {
    if (!this.jobsService) return;
    await this.jobsService.enqueue('search', 'index-watchlist', { watchlistId }, { jobId: `search:watchlist:${watchlistId}` });
  }

  private async enqueueWatchlistDelete(watchlistId: string): Promise<void> {
    if (!this.jobsService) return;
    await this.jobsService.enqueue('search', 'delete-watchlist', { watchlistId }, { jobId: `search:watchlist-delete:${watchlistId}` });
  }

  private async getAccessible(actor: Actor, id: string): Promise<Watchlist> {
    const watchlist = await this.repository.getById(id);
    if (actor.role !== 'Admin' && watchlist.userId !== actor.id) {
      throw new ForbiddenException('Watchlist access denied');
    }
    return watchlist;
  }

  private async ensureProfileAccess(actor: Actor, profileId: string) {
    if (actor.role === 'Admin') {
      await this.profilesRepository.getById(profileId);
    } else {
      await this.profilesRepository.getOwned(profileId, actor.id);
    }
  }

  private toPatch(dto: UpsertWatchlistDto | UpdateWatchlistDto): Partial<Watchlist> {
    const { autoAiRules: _autoAiRules, ...rest } = dto;
    return rest;
  }
}
