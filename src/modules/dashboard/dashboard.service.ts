import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { Actor } from '../../common/access';
import { UsersService } from '../users/users.service';
import { ProfilesRepository } from '../profiles/profiles.repository';
import { Profile } from '../profiles/schemas/profile.schema';
import { MatchingService } from '../matching';
import { CalendarService } from '../calendar';
import { TasksService } from '../tasks';
import { Opportunity, SourceStatus } from '../opportunities/schemas/opportunity.schema';
import { OpportunityUserState } from '../opportunities/schemas/opportunity-user-state.schema';
import { Source } from '../sources/schemas/source.schema';
import { DashboardQueryDto } from './dashboard.dto';

type DashboardOpportunityWithState = Opportunity & { dashboardState?: OpportunityUserState };

const DASHBOARD_OPPORTUNITY_PROJECTION = {
  'sourceOccurrences.rawPayload': 0,
  'sourceOccurrences.sourceMetadata': 0,
} as const;
const RECOMMENDED_LIMIT = 8;
const RECOMMENDED_CANDIDATE_LIMIT = 64;
const COMPUTED_RECOMMENDATION_BATCH_SIZE = 500;
const NEGATIVE_RECOMMENDATION_STATUSES = ['Rejected', 'Lost', 'Archived'] as const;
const SHARED_IMPORT_OWNERS = ['system:ingestion'] as const;
const PROCESSED_RECOMMENDATION_STATUSES = [
  'Reviewed', 'Interested', 'Shortlisted',
  'Applied', 'HRReply', 'Interview', 'TechnicalInterview', 'Offer',
  'ResponseSent', 'ClientReplied', 'Negotiation', 'Won', 'InProgress', 'Completed',
  'PreparingApplication', 'ApplicationSubmitted', 'Admitted', 'BiddingEvaluation', 'Contracting',
] as const;

@Injectable()
export class DashboardService {
  constructor(
    private readonly users: UsersService,
    private readonly profiles: ProfilesRepository,
    private readonly matching: MatchingService,
    private readonly calendar: CalendarService,
    private readonly tasks: TasksService,
    @InjectModel(Opportunity.name) private readonly opportunities: Model<Opportunity>,
    @InjectModel(OpportunityUserState.name) private readonly states: Model<OpportunityUserState>,
    @InjectModel(Source.name) private readonly sources: Model<Source>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async summary(actor: Actor, query: DashboardQueryDto) {
    const now = new Date();
    const timezone = await this.userTimezone(actor);
    const { from, to, period } = this.range(query, now, timezone);
    const [user, profiles, sources] = await Promise.all([
      this.users.getMe(actor), this.profiles.listByUser(actor.id), this.sources.find().lean().exec(),
    ]);
    const profile = query.profileId
      ? await this.profiles.getOwned(query.profileId, actor.id)
      : profiles.find(item => item.isActive) ?? null;
    const profileSourceIds = profile?.sourceIds ?? [];
    const personal = { userId: actor.id, ...(profile ? { profileId: profile._id } : {}), deletedAt: { $exists: false } };
    const canonical = {
      sourceStatus: { $in: ['Active', 'Unknown'] as SourceStatus[] },
      ...(profileSourceIds.length ? { 'sourceOccurrences.sourceId': { $in: profileSourceIds } } : {}),
    };
    const upcomingTo = new Date(now.getTime() + 7 * 86_400_000);
    const [newCount, highMatch, pipelineCount, candidateItems, recommendationCandidates, watchHits, watchCount, dueTasksAll, calendarPayload, unread] = await Promise.all([
      this.opportunities.countDocuments({ ...canonical, firstSeenAt: { $gte: from, $lte: to } }),
      profile ? this.states.countDocuments({ ...personal, hidden: false, archived: false, matchScore: { $gte: 80 } }) : 0,
      profile ? this.states.countDocuments({ ...personal, pipelineStatus: { $nin: ['New', 'Rejected', 'Archived', 'Won'] }, archived: false }) : 0,
      this.opportunities.find(canonical, DASHBOARD_OPPORTUNITY_PROJECTION).sort({ firstSeenAt: -1, _id: 1 }).limit(100).lean().exec(),
      profile ? this.recommendationCandidates(actor, profile, canonical) : [],
      this.collection('WatchlistHit', 'watchlisthits').find({ userId: actor.id, ...(profile ? { profileId: profile._id } : {}), matchedAt: { $gte: from, $lte: to } }).sort({ matchedAt: -1 }).limit(8).toArray(),
      this.collection('WatchlistHit', 'watchlisthits').countDocuments({ userId: actor.id, ...(profile ? { profileId: profile._id } : {}), matchedAt: { $gte: from, $lte: to } }),
      this.tasks.dueTasksForUser(actor, { end: to }),
      this.calendar.list(actor, { start: now.toISOString(), end: upcomingTo.toISOString() }),
      this.collection('Notification', 'notifications').countDocuments({ userId: actor.id, readAt: { $exists: false }, deletedAt: { $exists: false } }),
    ]);
    const dueTasks = dueTasksAll
      .filter(task => !task.completedAt)
      .sort((a, b) => +new Date(a.dueAt ?? 0) - +new Date(b.dueAt ?? 0) || a._id.localeCompare(b._id));
    const upcomingEvents = [...calendarPayload.items]
      .sort((a, b) => +new Date(String(a.startAt ?? 0)) - +new Date(String(b.startAt ?? 0)) || String(a.id ?? '').localeCompare(String(b.id ?? '')));
    const hitIds = watchHits.map(hit => String(hit.opportunityId));
    const stateOpportunityIds = [...new Set([...candidateItems.map(opportunity => String(opportunity._id)), ...hitIds])];
    const [personalStates, hitItems] = await Promise.all([
      profile && stateOpportunityIds.length
        ? this.states.find({ ...personal, opportunityId: { $in: stateOpportunityIds } }).lean().exec()
        : [],
      hitIds.length ? this.opportunities.find({ _id: { $in: hitIds } }, DASHBOARD_OPPORTUNITY_PROJECTION).lean().exec() : [],
    ]);
    const stateMap = new Map(personalStates.map(state => [state.opportunityId, state]));
    const recommendationStateMap = new Map(recommendationCandidates.flatMap(opportunity => opportunity.dashboardState ? [[opportunity._id, opportunity.dashboardState] as const] : []));
    const sourceNames = new Map(sources.map(source => [source._id, source.name]));
    const items = candidateItems.map(opportunity => this.mini(opportunity, stateMap.get(opportunity._id), profile, sourceNames));
    const recommendedItems = recommendationCandidates.map(opportunity => this.mini(opportunity, recommendationStateMap.get(opportunity._id), profile, sourceNames));
    const byHit = new Map(hitItems.map(opportunity => [opportunity._id, this.mini(opportunity, stateMap.get(opportunity._id), profile, sourceNames)]));
    const enabled = sources.filter(source => source.enabled && source.runtimeState === 'Enabled');
    const failed = enabled.filter(source => source.healthState === 'Failed');
    const unverified = enabled.filter(source => source.healthState === 'Unknown');
    const degraded = enabled.some(source => source.healthState === 'Degraded');
    const health = failed.length ? 'issue' : degraded ? 'degraded' : !enabled.length || unverified.length ? 'unknown' : 'operational';
    const labels = { issue: 'Есть ошибки источников', degraded: 'Некоторые источники работают с задержкой', unknown: 'Статус источников ещё не проверен', operational: 'Источники работают' };
    const lastSyncAt = sources.flatMap(source => source.lastSuccessAt ? [source.lastSuccessAt] : []).sort((a, b) => +new Date(b) - +new Date(a))[0];
    const profileSummaries = profiles.map(item => this.profileSummary(item, sources));
    return {
      userName: user.name, period,
      activeProfile: profile ? this.profileSummary(profile, sources) : null,
      profiles: profileSummaries,
      statusLine: `${newCount} новых возможностей за выбранный период`,
      kpis: [
        { id: 'new', label: 'Новые возможности', value: String(newCount) },
        { id: 'high-match', label: 'Высокий Match', value: String(highMatch) },
        { id: 'watchlist-hits', label: 'Совпадения правил', value: String(watchCount) },
        { id: 'pipeline', label: 'В работе', value: String(pipelineCount) },
        { id: 'tasks', label: 'Задачи к сроку', value: String(dueTasks.length) },
        { id: 'events', label: 'Ближайшие события', value: String(upcomingEvents.length) },
      ],
      recommended: profile ? this.diversifyRecommended(recommendedItems) : [],
      watchlistHits: hitIds.flatMap(id => byHit.has(id) ? [byHit.get(id)] : []),
      recentlyAdded: items.filter(item => +new Date(item.firstSeenAt) >= +now - 86_400_000).slice(0, 8),
      tasks: dueTasks.slice(0, 8), events: upcomingEvents.slice(0, 8),
      systemHealth: { status: health, label: labels[health], activeSources: enabled.length, failedSources: failed.length, lastSyncAt },
      notificationsUnread: unread,
    };
  }

  private collection(model: string, fallback: string) {
    return this.connection.collection(this.connection.models[model]?.collection.name ?? fallback);
  }

  private async recommendationCandidates(actor: Actor, profile: Profile, canonical: Record<string, unknown>): Promise<DashboardOpportunityWithState[]> {
    const baseStateMatch = this.recommendationStateMatch(actor, profile);
    const unprocessed: DashboardOpportunityWithState[] = [];
    await this.appendRecommendationScoreBatches(unprocessed, actor, canonical, baseStateMatch, false);
    const computed = await this.computedRecommendationCandidates(actor, profile, canonical);
    unprocessed.push(...computed.unprocessed);
    const results = this.sortRecommendationCandidates(unprocessed).slice(0, RECOMMENDED_CANDIDATE_LIMIT);
    if (results.length < RECOMMENDED_CANDIDATE_LIMIT) {
      const processed: DashboardOpportunityWithState[] = [];
      await this.appendRecommendationScoreBatches(processed, actor, canonical, baseStateMatch, true);
      processed.push(...computed.processed);
      results.push(...this.sortRecommendationCandidates(processed).slice(0, RECOMMENDED_CANDIDATE_LIMIT - results.length));
    }
    return results;
  }

  private recommendationStateMatch(actor: Actor, profile: Profile): Record<string, unknown> {
    return {
      userId: actor.id,
      profileId: profile._id,
      deletedAt: { $exists: false },
      hidden: { $ne: true },
      archived: { $ne: true },
      pipelineStatus: { $nin: [...NEGATIVE_RECOMMENDATION_STATUSES] },
    };
  }

  private recommendationOpportunityMatch(actor: Actor, canonical: Record<string, unknown>): Record<string, unknown> {
    return {
      ...canonical,
      $or: [
        { importedByUserId: { $exists: false } },
        { importedByUserId: null },
        { importedByUserId: '' },
        { importedByUserId: { $in: [...SHARED_IMPORT_OWNERS] } },
        { importedByUserId: actor.id },
        {
          $and: [
            { importedByUserId: { $nin: [actor.id, ...SHARED_IMPORT_OWNERS, null, ''] } },
            { 'sourceOccurrences.sourceId': { $ne: 'manual' } },
            { 'sourceOccurrences.sourceMetadata.importFileId': { $exists: false } },
            { importedFromFeedId: { $exists: false } },
          ],
        },
      ],
    };
  }

  private recommendationProcessedMatch(processed: boolean): Record<string, unknown> {
    return processed
      ? { pipelineStatus: { $in: [...PROCESSED_RECOMMENDATION_STATUSES] } }
      : { pipelineStatus: { $nin: [...NEGATIVE_RECOMMENDATION_STATUSES, ...PROCESSED_RECOMMENDATION_STATUSES] } };
  }

  private async appendRecommendationScoreBatches(
    results: DashboardOpportunityWithState[],
    actor: Actor,
    canonical: Record<string, unknown>,
    baseStateMatch: Record<string, unknown>,
    processed: boolean,
  ): Promise<void> {
    const bands = await this.states.aggregate<{ _id: number; count: number }>([
      { $match: { ...baseStateMatch, ...this.recommendationProcessedMatch(processed), matchScore: { $gte: 0, $lte: 100 } } },
      { $group: { _id: '$matchScore', count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
    ]).exec();
    let offset = 0;
    while (results.length < RECOMMENDED_CANDIDATE_LIMIT && offset < bands.length) {
      const scores: number[] = [];
      let optimisticCount = 0;
      for (; offset < bands.length; offset += 1) {
        scores.push(bands[offset]._id);
        optimisticCount += bands[offset].count;
        if (optimisticCount >= RECOMMENDED_CANDIDATE_LIMIT - results.length) {
          offset += 1;
          break;
        }
      }
      if (!scores.length) return;
      const rows = await this.cachedRecommendationScoreBatch(actor, canonical, baseStateMatch, processed, scores, RECOMMENDED_CANDIDATE_LIMIT - results.length);
      results.push(...rows);
    }
  }

  private async cachedRecommendationScoreBatch(
    actor: Actor,
    canonical: Record<string, unknown>,
    baseStateMatch: Record<string, unknown>,
    processed: boolean,
    scores: number[],
    limit: number,
  ): Promise<DashboardOpportunityWithState[]> {
    const opportunitiesCollection = this.connection.models[Opportunity.name]?.collection.name ?? this.opportunities.collection?.name ?? 'opportunities';
    return this.states.aggregate<DashboardOpportunityWithState>([
      {
        $match: {
          ...baseStateMatch,
          ...this.recommendationProcessedMatch(processed),
          matchScore: { $in: scores, $gte: 0, $lte: 100 },
        },
      },
      {
        $lookup: {
          from: opportunitiesCollection,
          let: { opportunityId: '$opportunityId' },
          pipeline: [
            { $match: { ...this.recommendationOpportunityMatch(actor, canonical), $expr: { $eq: ['$_id', '$$opportunityId'] } } },
            { $project: this.recommendationOpportunityProjection() },
          ],
          as: 'opportunity',
        },
      },
      { $unwind: '$opportunity' },
      { $set: { 'opportunity.dashboardState': this.dashboardStateProjectionExpression() } },
      {
        $set: {
          recommendationMatchScore: '$matchScore',
          recommendationFreshnessAt: { $ifNull: ['$opportunity.publishedAt', '$opportunity.firstSeenAt'] },
        },
      },
      { $sort: { recommendationMatchScore: -1, recommendationFreshnessAt: -1, 'opportunity._id': 1 } },
      { $limit: limit },
      { $replaceRoot: { newRoot: '$opportunity' } },
    ]).exec();
  }

  private async computedRecommendationCandidates(
    actor: Actor,
    profile: Profile,
    canonical: Record<string, unknown>,
  ): Promise<{ unprocessed: DashboardOpportunityWithState[]; processed: DashboardOpportunityWithState[] }> {
    const statesCollection = this.connection.models[OpportunityUserState.name]?.collection.name ?? this.states.collection?.name ?? 'opportunityuserstates';
    const top = {
      unprocessed: [] as DashboardOpportunityWithState[],
      processed: [] as DashboardOpportunityWithState[],
    };
    const cursor = this.opportunities.aggregate<DashboardOpportunityWithState>([
      { $match: this.recommendationOpportunityMatch(actor, canonical) },
      {
        $lookup: {
          from: statesCollection,
          localField: '_id',
          foreignField: 'opportunityId',
          as: 'dashboardState',
        },
      },
      {
        $set: {
          dashboardState: {
            $first: {
              $filter: {
                input: '$dashboardState',
                as: 'state',
                cond: {
                  $and: [
                    { $eq: ['$$state.userId', actor.id] },
                    { $eq: ['$$state.profileId', profile._id] },
                  ],
                },
              },
            },
          },
        },
      },
      {
        $match: {
          'dashboardState.deletedAt': { $exists: false },
          'dashboardState.hidden': { $ne: true },
          'dashboardState.archived': { $ne: true },
          'dashboardState.pipelineStatus': { $nin: [...NEGATIVE_RECOMMENDATION_STATUSES] },
          $or: [
            { dashboardState: null },
            { 'dashboardState.matchScore': { $not: { $gte: 0, $lte: 100 } } },
          ],
        },
      },
      { $project: { ...this.computedRecommendationOpportunityProjection(), dashboardState: 1 } },
    ]).cursor({ batchSize: COMPUTED_RECOMMENDATION_BATCH_SIZE });
    for await (const opportunity of cursor) {
      const candidate = this.computedRecommendationCandidate(opportunity, profile);
      if (!candidate) continue;
      const bucket = this.recommendationCandidateProcessed(candidate) ? top.processed : top.unprocessed;
      this.rememberRecommendationCandidate(bucket, candidate);
    }
    return {
      unprocessed: await this.hydrateRecommendationCandidates(top.unprocessed),
      processed: await this.hydrateRecommendationCandidates(top.processed),
    };
  }

  private async hydrateRecommendationCandidates(items: DashboardOpportunityWithState[]): Promise<DashboardOpportunityWithState[]> {
    if (!items.length) return [];
    const stateById = new Map(items.map(item => [item._id, item.dashboardState]));
    const hydrated = await this.opportunities.find({ _id: { $in: items.map(item => item._id) } }, DASHBOARD_OPPORTUNITY_PROJECTION).lean().exec();
    const byId = new Map(hydrated.map(item => [item._id, item]));
    return items.map(item => ({ ...(byId.get(item._id) ?? item), dashboardState: stateById.get(item._id) }));
  }

  private computedRecommendationCandidate(opportunity: DashboardOpportunityWithState, profile: Profile): DashboardOpportunityWithState | null {
    const state = opportunity.dashboardState;
    if (state?.deletedAt) return null;
    if (state?.hidden || state?.archived) return null;
    if (NEGATIVE_RECOMMENDATION_STATUSES.includes(state?.pipelineStatus as typeof NEGATIVE_RECOMMENDATION_STATUSES[number])) return null;
    if (this.validCachedMatchScore(state?.matchScore)) return null;
    const money = opportunity.money ?? {};
    const skills = opportunity.skills ?? [];
    const technologies = opportunity.technologies ?? [];
    const sourceOccurrences = opportunity.sourceOccurrences ?? [];
    const matchScore = this.matching.calculate({ ...opportunity, money, skills, technologies, sourceOccurrences }, this.matchingProfile(profile)).score;
    return {
      ...opportunity,
      dashboardState: {
        ...(state ?? {}),
        userId: state?.userId ?? profile.userId,
        profileId: state?.profileId ?? profile._id,
        opportunityId: state?.opportunityId ?? opportunity._id,
        pipelineStatus: state?.pipelineStatus ?? 'New',
        hidden: state?.hidden ?? false,
        archived: state?.archived ?? false,
        favorite: state?.favorite ?? false,
        matchScore,
      } as OpportunityUserState,
    };
  }

  private validCachedMatchScore(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  }

  private recommendationCandidateProcessed(candidate: DashboardOpportunityWithState): boolean {
    return PROCESSED_RECOMMENDATION_STATUSES.includes(candidate.dashboardState?.pipelineStatus as typeof PROCESSED_RECOMMENDATION_STATUSES[number]);
  }

  private rememberRecommendationCandidate(top: DashboardOpportunityWithState[], candidate: DashboardOpportunityWithState): void {
    top.push(candidate);
    top.sort((left, right) => this.compareRecommendationCandidates(left, right));
    if (top.length > RECOMMENDED_CANDIDATE_LIMIT) top.length = RECOMMENDED_CANDIDATE_LIMIT;
  }

  private sortRecommendationCandidates(items: DashboardOpportunityWithState[]): DashboardOpportunityWithState[] {
    return [...items].sort((left, right) => this.compareRecommendationCandidates(left, right));
  }

  private compareRecommendationCandidates(left: DashboardOpportunityWithState, right: DashboardOpportunityWithState): number {
    return (right.dashboardState?.matchScore ?? -1) - (left.dashboardState?.matchScore ?? -1)
      || +new Date(right.publishedAt ?? right.firstSeenAt ?? 0) - +new Date(left.publishedAt ?? left.firstSeenAt ?? 0)
      || String(left._id).localeCompare(String(right._id));
  }

  private computedRecommendationOpportunityProjection() {
    return {
      _id: 1,
      type: 1,
      title: 1,
      companyOrClient: 1,
      skills: 1,
      technologies: 1,
      seniority: 1,
      employmentType: 1,
      location: 1,
      remoteType: 1,
      money: 1,
      publishedAt: 1,
      firstSeenAt: 1,
      sourceStatus: 1,
      sourceOccurrences: {
        $map: {
          input: { $ifNull: ['$sourceOccurrences', []] },
          as: 'occurrence',
          in: {
            sourceId: '$$occurrence.sourceId',
            url: '$$occurrence.url',
            primary: '$$occurrence.primary',
          },
        },
      },
    };
  }

  private recommendationOpportunityProjection() {
    return {
      _id: 1,
      type: 1,
      title: 1,
      companyOrClient: 1,
      description: 1,
      skills: 1,
      technologies: 1,
      seniority: 1,
      employmentType: 1,
      location: 1,
      remoteType: 1,
      money: 1,
      publishedAt: 1,
      firstSeenAt: 1,
      sourceStatus: 1,
      sourceOccurrences: {
        $map: {
          input: { $ifNull: ['$sourceOccurrences', []] },
          as: 'occurrence',
          in: {
            sourceId: '$$occurrence.sourceId',
            externalId: '$$occurrence.externalId',
            url: '$$occurrence.url',
            primary: '$$occurrence.primary',
            firstSeenAt: '$$occurrence.firstSeenAt',
            lastSeenAt: '$$occurrence.lastSeenAt',
            publishedAt: '$$occurrence.publishedAt',
            checksum: '$$occurrence.checksum',
            status: '$$occurrence.status',
            normalizedSnapshot: '$$occurrence.normalizedSnapshot',
          },
        },
      },
    };
  }

  private dashboardStateProjectionExpression() {
    return {
      _id: '$_id',
      userId: '$userId',
      opportunityId: '$opportunityId',
      profileId: '$profileId',
      pipelineStatus: '$pipelineStatus',
      favorite: '$favorite',
      hidden: '$hidden',
      archived: '$archived',
      matchScore: '$matchScore',
      deletedAt: '$deletedAt',
    };
  }

  private diversifyRecommended<T extends { source: { id: string }; companyOrClient: string; skills: string[] }>(items: T[]): T[] {
    const selected: T[] = [];
    const deferred: T[] = [];
    const sourceCounts = new Map<string, number>();
    const companyCounts = new Map<string, number>();
    const techCounts = new Map<string, number>();
    for (const item of items) {
      const source = item.source.id;
      const company = item.companyOrClient.trim().toLowerCase();
      const tech = item.skills[0]?.trim().toLowerCase() ?? '';
      const saturated = (sourceCounts.get(source) ?? 0) >= 2
        || (company && (companyCounts.get(company) ?? 0) >= 2)
        || (tech && (techCounts.get(tech) ?? 0) >= 2);
      if (saturated) {
        deferred.push(item);
        continue;
      }
      selected.push(item);
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
      if (company) companyCounts.set(company, (companyCounts.get(company) ?? 0) + 1);
      if (tech) techCounts.set(tech, (techCounts.get(tech) ?? 0) + 1);
      if (selected.length >= RECOMMENDED_LIMIT) return selected;
    }
    return [...selected, ...deferred].slice(0, RECOMMENDED_LIMIT);
  }

  private profileSummary(profile: Profile, sources: Source[]) {
    return {
      id: profile._id, name: profile.name, type: profile.kind,
      targetRole: (profile.targetRoles ?? []).join(', '), seniority: (profile.seniority ?? [])[0] ?? null,
      technologies: profile.technologies ?? [],
      activeSourceCount: sources.filter(source => source.enabled && (!(profile.sourceIds ?? []).length || profile.sourceIds.includes(source._id))).length,
      matchPresetName: 'Настроенные веса',
      needsAttention: [
        ...(!profile.structuredExperienceSummary ? [{ id: 'experience', label: 'Добавить опыт', href: `/profiles/${profile._id}`, severity: 'info' }] : []),
      ],
    };
  }

  private mini(opportunity: Opportunity, state: OpportunityUserState | undefined, profile: Profile | null, sources: Map<string, string>) {
    const occurrences = opportunity.sourceOccurrences ?? [];
    const primary = occurrences.find(source => source.primary) ?? occurrences[0];
    const money = opportunity.money ?? {};
    const skills = opportunity.skills ?? [];
    const technologies = opportunity.technologies ?? [];
    const range = [money.min, money.max].filter(value => typeof value === 'number').map(value => value!.toLocaleString('ru-RU')).join(' – ');
    const upperBudget = money.kind === 'desired-upper-bound' && money.min === undefined && typeof money.max === 'number' && Number.isFinite(money.max);
    const compensationLabel = upperBudget
      ? `до ${money.max!.toLocaleString('ru-RU')} ${money.currency === 'RUB' ? '₽' : money.currency ?? ''}`.trim()
      : money.originalText || (range ? `${range} ${money.currency ?? ''}${money.period ? ` / ${money.period}` : ''}` : 'Сумма не указана');
    return {
      id: opportunity._id, type: opportunity.type, title: opportunity.title,
      companyOrClient: opportunity.companyOrClient ?? '',
      compensationLabel,
      source: { id: primary?.sourceId ?? 'manual', name: sources.get(primary?.sourceId ?? '') ?? 'Ручной импорт', status: opportunity.sourceStatus ?? 'Unknown', url: this.safeSourceUrl(primary?.url), extraCount: Math.max(0, occurrences.length - 1) },
      matchScore: state?.matchScore ?? (profile ? this.matching.calculate({ ...opportunity, money, skills, technologies, sourceOccurrences: occurrences }, this.matchingProfile(profile)).score : null),
      skills: [...new Set([...skills, ...technologies])],
      pipelineStage: state?.pipelineStatus ?? 'New',
      firstSeenAt: opportunity.firstSeenAt, publishedAt: opportunity.publishedAt,
      favorite: state?.favorite ?? false, hidden: state?.hidden ?? false, archived: state?.archived ?? false,
      description: opportunity.description ?? '',
    };
  }

  private matchingProfile(profile: Profile): Profile {
    return {
      ...profile,
      seniority: profile.seniority ?? [],
      technologies: profile.technologies ?? [],
      compensationPreferences: profile.compensationPreferences ?? {},
      remotePreferences: profile.remotePreferences ?? [],
      locations: profile.locations ?? [],
      employmentTypes: profile.employmentTypes ?? [],
      sourceIds: profile.sourceIds ?? [],
    };
  }

  private async userTimezone(actor: Actor): Promise<string> {
    const user = await this.users.getMe(actor);
    const timezone = typeof user.timezone === 'string' ? user.timezone : 'Europe/Moscow';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
      return timezone;
    } catch {
      return 'Europe/Moscow';
    }
  }

  private safeSourceUrl(url?: string): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      const hostname = parsed.hostname.toLowerCase();
      if (hostname === 'localhost' || hostname.endsWith('.local') || hostname === '0.0.0.0' || hostname.startsWith('127.') || hostname.startsWith('10.') || hostname.startsWith('192.168.')) return null;
      if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return null;
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private range(query: DashboardQueryDto, now: Date, timezone: string) {
    const period = query.period ?? '7d';
    const days: Record<string, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };
    const today = this.dayRange(now, timezone);
    const from = period === 'custom' ? new Date(query.from ?? '') : period === 'today' ? today.from : new Date(+now - days[period] * 86_400_000);
    const to = period === 'custom' ? new Date(query.to ?? '') : period === 'today' ? today.to : now;
    if (!Number.isFinite(+from) || !Number.isFinite(+to) || +to < +from || +to - +from > 366 * 86_400_000) {
      throw new BadRequestException('Specify a valid dashboard period of up to 366 days');
    }
    return { from, to, period };
  }

  private dayRange(now: Date, timezone: string): { from: Date; to: Date } {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
    const y = value('year');
    const m = value('month');
    const d = value('day');
    const from = this.zonedTimeToUtc(y, m, d, 0, 0, 0, timezone);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const to = new Date(+this.zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, timezone) - 1);
    return { from, to };
  }

  private zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timezone: string): Date {
    const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    return new Date(+guess - this.timezoneOffsetMs(guess, timezone));
  }

  private timezoneOffsetMs(date: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const part = (type: string) => Number(parts.find(item => item.type === type)?.value);
    return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second')) - +date;
  }
}
