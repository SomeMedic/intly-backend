import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';

import { Actor } from '../../common/access';
import { addMoneyDimensionFilter, canonicalMoneyDimensionValue } from '../../common/money-dimensions';
import { Opportunity, OpportunityDocument, OpportunityType, OPPORTUNITY_TYPES, SourceOccurrence } from '../opportunities/schemas/opportunity.schema';
import { OpportunityUserState, OpportunityUserStateDocument, PipelineStatus } from '../opportunities/schemas/opportunity-user-state.schema';
import { normalizePipelineStatus, pipelineStagesForType } from '../opportunities/pipeline-definitions';
import { Source, SourceDocument } from '../sources/schemas/source.schema';
import { AnalyticsQueryDto } from './dto/analytics.dto';

type Range = { from: Date; to: Date; period: string };
type AnalyticsRow = Record<string, string | number | null>;
type PipelineGroup = 'reviewed' | 'responses' | 'replies' | 'interviews' | 'offersWon';

type AnalyticsOpportunity = Opportunity & {
  createdAt?: Date;
  updatedAt?: Date;
};

type AnalyticsState = OpportunityUserState & {
  createdAt?: Date;
  updatedAt?: Date;
};

type SourceInfo = Pick<Source, '_id' | 'name' | 'group'>;

const REVIEWED_STATUSES = new Set<PipelineStatus>(['Reviewed']);
const WIN_STATUSES = new Set<PipelineStatus>(['Won']);
const RESPONSE_STATUSES = new Set<PipelineStatus>(['Applied', 'ResponseSent', 'ApplicationSubmitted']);
const REPLY_STATUSES = new Set<PipelineStatus>(['HRReply', 'Interview', 'TechnicalInterview', 'Offer', 'ClientReplied', 'Negotiation', 'Won', 'Admitted', 'BiddingEvaluation', 'Contracting']);
const INTERVIEW_STATUSES = new Set<PipelineStatus>(['Interview', 'TechnicalInterview', 'Negotiation', 'Admitted', 'BiddingEvaluation']);
const OFFER_WON_STATUSES = new Set<PipelineStatus>(['Offer', 'Won']);

@Injectable()
export class AnalyticsService {
  private readonly opportunities?: Model<OpportunityDocument>;
  private readonly states?: Model<OpportunityUserStateDocument>;
  private readonly sourcesModel?: Model<SourceDocument>;
  private readonly connection?: Connection;
  private readonly legacyStatesRepository?: { findByUserProfile(userId: string, profileId?: string): Promise<AnalyticsState[]> };
  private readonly legacyOpportunitiesRepository?: { findByIds(ids: string[]): Promise<AnalyticsOpportunity[]>; analyticsByType?(): Promise<AnalyticsRow[]>; analyticsByTechnology?(): Promise<AnalyticsRow[]>; analyticsBySource?(): Promise<AnalyticsRow[]> };

  constructor(
    @InjectModel(Opportunity.name) opportunitiesOrStates: Model<OpportunityDocument> | { findByUserProfile(userId: string, profileId?: string): Promise<AnalyticsState[]> },
    @InjectModel(OpportunityUserState.name) statesOrOpportunities: Model<OpportunityUserStateDocument> | { findByIds(ids: string[]): Promise<AnalyticsOpportunity[]>; analyticsByType?(): Promise<AnalyticsRow[]>; analyticsByTechnology?(): Promise<AnalyticsRow[]>; analyticsBySource?(): Promise<AnalyticsRow[]> },
    @InjectModel(Source.name) sourcesModel?: Model<SourceDocument>,
    @InjectConnection() connection?: Connection,
  ) {
    if (this.hasLegacyStateRepository(opportunitiesOrStates)) {
      this.legacyStatesRepository = opportunitiesOrStates;
      this.legacyOpportunitiesRepository = statesOrOpportunities as { findByIds(ids: string[]): Promise<AnalyticsOpportunity[]>; analyticsByType?(): Promise<AnalyticsRow[]>; analyticsByTechnology?(): Promise<AnalyticsRow[]>; analyticsBySource?(): Promise<AnalyticsRow[]> };
    } else {
      this.opportunities = opportunitiesOrStates as Model<OpportunityDocument>;
      this.states = statesOrOpportunities as Model<OpportunityUserStateDocument>;
      this.sourcesModel = sourcesModel;
      this.connection = connection;
    }
  }

  async personal(actor: Actor, query: AnalyticsQueryDto) {
    if (this.legacyStatesRepository && this.legacyOpportunitiesRepository) return this.legacyPersonal(actor, query);
    const userId = actor.role === 'Admin' && query.userId ? query.userId : actor.id;
    const range = this.resolveRange(query);
    const sourceIds = this.sourceIds(query);
    const stateFilter: Record<string, unknown> = { userId, deletedAt: { $exists: false } };
    if (query.profileId) stateFilter.profileId = query.profileId;

    const [states, sources] = await Promise.all([
      this.states!.find(stateFilter).lean(),
      this.sourcesModel!.find({}).select({ _id: 1, name: 1, group: 1 }).lean(),
    ]);
    const typedStates = states as AnalyticsState[];
    const opportunities = await this.opportunities!.find({
      _id: { $in: Array.from(new Set(typedStates.map((state) => state.opportunityId))) },
      ...this.opportunityFilter(query, sourceIds, query.includeClosed !== 'false'),
    }).select(this.opportunityAnalyticsProjection()).lean() as AnalyticsOpportunity[];
    const opportunityMap = new Map(opportunities.map((opportunity) => [opportunity._id, opportunity]));
    const scopedStates = typedStates.filter((state) => opportunityMap.has(state.opportunityId));
    const periodOpportunities = opportunities.filter((opportunity) => this.inRange(opportunity.firstSeenAt, range));
    const sourceMap = this.sourceMap(sources as SourceInfo[]);
    const latestAi = await this.latestAiScores(userId, query.profileId, opportunities.map((opportunity) => opportunity._id));

    const funnel = this.personalFunnel(scopedStates, opportunityMap, range, query.type);
    const currentPipeline = this.currentPipeline(scopedStates, opportunityMap, query.type);
    const grouped = this.pipelineGroups(scopedStates, range, opportunityMap);
    const aiScores = Array.from(latestAi.values()).map((score) => this.finiteNumber(score)).filter((score): score is number => score !== null);
    const matchScores = scopedStates.map((state) => this.finiteNumber(state.matchScore)).filter((score): score is number => score !== null);

    return {
      filters: this.filterEcho(query, range, sourceIds, query.includeClosed !== 'false'),
      totals: {
        found: periodOpportunities.length,
        tracked: scopedStates.length,
        reviewed: grouped.reviewed,
        responsesSent: grouped.responses,
        replies: grouped.replies,
        interviewsNegotiations: grouped.interviews,
        offersWon: grouped.offersWon,
        conversionRate: this.percent(grouped.offersWon, grouped.reviewed),
        conversionRateFormula: 'offersWon/reviewed',
        avgMatchScore: this.average(matchScores),
        avgAiScore: this.average(aiScores),
      },
      funnel,
      funnels: this.personalFunnels(scopedStates, opportunityMap, range, query.type),
      currentPipeline,
      timeseries: this.personalTimeseries(opportunities, scopedStates, range),
      sources: this.personalSources(scopedStates, opportunityMap, sourceMap, range, sourceIds),
      technologies: this.technologyRows(periodOpportunities),
      compensation: this.compensation(periodOpportunities),
      scoreBands: this.scoreBands(scopedStates, latestAi),
      geography: this.geography(periodOpportunities),
      counterparts: this.counterparts(periodOpportunities),
      profiles: this.profileRows(scopedStates, range),
    };
  }

  async personalCsv(actor: Actor, query: AnalyticsQueryDto): Promise<string> {
    const payload = await this.personal(actor, query);
    return this.csv([
      ...this.sectionRows('kpi', Object.entries(payload.totals).map(([metric, value]) => ({ metric, value: this.scalar(value) }))),
      ...this.sectionRows('funnel', payload.funnel),
      ...this.sectionRows('type_funnel', payload.funnels.flatMap((funnel) => funnel.stages.map((stage) => ({ type: funnel.type, ...stage })))),
      ...this.sectionRows('timeseries', payload.timeseries),
      ...this.sectionRows('sources', payload.sources),
      ...this.sectionRows('technologies', payload.technologies),
      ...this.sectionRows('compensation', payload.compensation.byCurrency),
      ...this.sectionRows('compensation_by_type_currency_period_kind', payload.compensation.byTypeCurrencyPeriodKind),
      ...this.sectionRows('score_match', payload.scoreBands.match),
      ...this.sectionRows('score_ai', payload.scoreBands.ai),
      ...this.sectionRows('geography_locations', payload.geography.locations),
      ...this.sectionRows('geography_countries', payload.geography.countries),
      ...this.sectionRows('geography_remote_types', payload.geography.remoteTypes),
      ...this.sectionRows('counterparts', payload.counterparts),
      ...this.sectionRows('profiles', payload.profiles),
    ]);
  }

  async market(query: AnalyticsQueryDto = {}) {
    const range = this.resolveRange(query);
    const sourceIds = this.sourceIds(query);
    const previousRange = this.previousRange(range);
    const baseFilter = this.opportunityFilter(query, sourceIds, query.includeClosed === 'true');
    const [opportunities, previousOpportunities, sources] = await Promise.all([
      this.opportunities!.find({
        ...baseFilter,
        firstSeenAt: { $gte: range.from, $lte: range.to },
      }).select(this.opportunityAnalyticsProjection()).sort({ firstSeenAt: -1, _id: 1 }).lean(),
      this.opportunities!.find({
        ...baseFilter,
        firstSeenAt: { $gte: previousRange.from, $lte: previousRange.to },
      }).select({ _id: 1 }).lean(),
      this.sourcesModel!.find({}).select({ _id: 1, name: 1, group: 1 }).lean(),
    ]);
    const typed = opportunities as AnalyticsOpportunity[];
    const sourceMap = this.sourceMap(sources as SourceInfo[]);
    const active = typed.filter((opportunity) => ['Active', 'Unknown'].includes(opportunity.sourceStatus));
    const previousCount = previousOpportunities.length;

    return {
      filters: this.filterEcho(query, range, sourceIds, query.includeClosed === 'true'),
      totals: {
        opportunities: typed.length,
        active: active.length,
        closedExpiredRemoved: typed.length - active.length,
        numericMoneyCoverage: this.percent(this.moneyComparable(typed).length, typed.length),
        sourceCount: new Set(typed.flatMap((opportunity) => (opportunity.sourceOccurrences ?? []).map((occurrence) => occurrence.sourceId))).size,
      },
      comparison: {
        previousFrom: previousRange.from.toISOString(),
        previousTo: previousRange.to.toISOString(),
        previousCount,
        growthRate: previousCount === 0 ? null : this.percent(typed.length - previousCount, previousCount),
      },
      volume: {
        byType: this.countBy(typed, (opportunity) => opportunity.type, 'type'),
        byStatus: this.countBy(typed, (opportunity) => opportunity.sourceStatus ?? 'Unknown', 'status'),
        timeseries: this.marketTimeseries(typed, range),
        sourceGroups: this.sourceGroupRows(typed),
        seniority: this.countBy(typed, (opportunity) => opportunity.seniority, 'seniority'),
      },
      roles: this.roleRows(typed),
      technologies: this.technologyRows(typed),
      compensation: this.compensation(typed),
      geography: this.geography(typed),
      sources: this.marketSources(typed, sourceMap),
      counterparts: this.counterparts(typed),
    };
  }

  async marketCsv(query: AnalyticsQueryDto): Promise<string> {
    const payload = await this.market(query);
    return this.csv([
      ...this.sectionRows('kpi', Object.entries(payload.totals).map(([metric, value]) => ({ metric, value: this.scalar(value) }))),
      ...this.sectionRows('comparison', [payload.comparison]),
      ...this.sectionRows('types', payload.volume.byType),
      ...this.sectionRows('statuses', payload.volume.byStatus),
      ...this.sectionRows('timeseries', payload.volume.timeseries),
      ...this.sectionRows('source_groups', payload.volume.sourceGroups),
      ...this.sectionRows('seniority', payload.volume.seniority),
      ...this.sectionRows('roles', payload.roles),
      ...this.sectionRows('technologies', payload.technologies),
      ...this.sectionRows('compensation', payload.compensation.byCurrency),
      ...this.sectionRows('compensation_by_type_currency_period_kind', payload.compensation.byTypeCurrencyPeriodKind),
      ...this.sectionRows('geography_locations', payload.geography.locations),
      ...this.sectionRows('geography_countries', payload.geography.countries),
      ...this.sectionRows('geography_remote_types', payload.geography.remoteTypes),
      ...this.sectionRows('sources', payload.sources),
      ...this.sectionRows('counterparts', payload.counterparts),
    ]);
  }

  async sources(query: AnalyticsQueryDto = {}) {
    const market = await this.market(query);
    return { items: market.sources };
  }

  async dashboardSummary(actor: Actor) {
    const [personal, market] = await Promise.all([this.personal(actor, {}), this.market({})]);
    return {
      personal: {
        totals: personal.totals,
        currentPipeline: personal.currentPipeline,
        funnel: personal.funnel,
      },
      market: {
        byType: market.volume.byType,
        topTechnologies: market.technologies.slice(0, 10),
        topSources: market.sources.slice(0, 10),
      },
    };
  }

  private hasLegacyStateRepository(value: unknown): value is { findByUserProfile(userId: string, profileId?: string): Promise<AnalyticsState[]> } {
    return Boolean(value && typeof value === 'object' && 'findByUserProfile' in value);
  }

  private async legacyPersonal(actor: Actor, query: AnalyticsQueryDto) {
    const userId = actor.role === 'Admin' && query.userId ? query.userId : actor.id;
    const range = this.resolveRange(query);
    const states = await this.legacyStatesRepository!.findByUserProfile(userId, query.profileId);
    const opportunities = await this.legacyOpportunitiesRepository!.findByIds(states.map((state) => state.opportunityId));
    const filtered = opportunities.filter((opportunity) => (!query.type || opportunity.type === query.type) && (!this.sourceIds(query).length || (opportunity.sourceOccurrences ?? []).some((occurrence) => this.sourceIds(query).includes(occurrence.sourceId))));
    const opportunityMap = new Map(filtered.map((opportunity) => [opportunity._id, opportunity]));
    const scopedStates = states.filter((state) => opportunityMap.has(state.opportunityId));
    const grouped = this.pipelineGroups(scopedStates, range, opportunityMap);
    return {
      filters: this.filterEcho(query, range, this.sourceIds(query), true),
      totals: { tracked: scopedStates.length, found: filtered.filter((opportunity) => this.inRange(opportunity.firstSeenAt, range)).length, reviewed: grouped.reviewed, responsesSent: grouped.responses, replies: grouped.replies, interviewsNegotiations: grouped.interviews, offersWon: grouped.offersWon, conversionRate: this.percent(grouped.offersWon, grouped.reviewed), conversionRateFormula: 'offersWon/reviewed', avgMatchScore: this.average(scopedStates.map((state) => this.finiteNumber(state.matchScore)).filter((score): score is number => score !== null)), avgAiScore: null },
      funnel: this.personalFunnel(scopedStates, opportunityMap, range, query.type),
      funnels: this.personalFunnels(scopedStates, opportunityMap, range, query.type),
      currentPipeline: this.currentPipeline(scopedStates, opportunityMap, query.type),
      timeseries: this.personalTimeseries(filtered, scopedStates, range),
      sources: this.personalSources(scopedStates, opportunityMap, new Map(), range, this.sourceIds(query)),
      technologies: this.technologyRows(filtered.filter((opportunity) => this.inRange(opportunity.firstSeenAt, range))),
      compensation: this.compensation(filtered.filter((opportunity) => this.inRange(opportunity.firstSeenAt, range))),
      scoreBands: this.scoreBands(scopedStates, new Map()),
      geography: this.geography(filtered.filter((opportunity) => this.inRange(opportunity.firstSeenAt, range))),
      counterparts: this.counterparts(filtered.filter((opportunity) => this.inRange(opportunity.firstSeenAt, range))),
      profiles: this.profileRows(scopedStates, range),
    };
  }

  private opportunityFilter(query: AnalyticsQueryDto, sourceIds: string[], includeClosed: boolean): Record<string, unknown> {
    const filter: Record<string, unknown> = { mergedIntoOpportunityId: { $exists: false } };
    const and: Record<string, unknown>[] = [];
    if (query.type) filter.type = query.type;
    if (!includeClosed) filter.sourceStatus = { $in: ['Active', 'Unknown'] };
    if (sourceIds.length) filter['sourceOccurrences.sourceId'] = { $in: sourceIds };
    if (query.sourceGroups?.length) {
      const knownSourceGroups = query.sourceGroups.filter((item) => item !== 'unknown');
      const sourceGroupOr: Record<string, unknown>[] = [];
      if (knownSourceGroups.length) sourceGroupOr.push({ 'sourceOccurrences.sourceMetadata.group': { $in: knownSourceGroups } });
      if (query.sourceGroups.includes('unknown')) {
        sourceGroupOr.push(
          { sourceOccurrences: { $exists: false } },
          { sourceOccurrences: { $size: 0 } },
          {
            sourceOccurrences: {
              $elemMatch: {
                $or: [
                  { 'sourceMetadata.group': { $exists: false } },
                  { 'sourceMetadata.group': null },
                  { 'sourceMetadata.group': '' },
                  { 'sourceMetadata.group': 'unknown' },
                ],
              },
            },
          },
        );
      }
      and.push({ $or: sourceGroupOr });
    }
    if (query.locations?.length) {
      const knownLocations = query.locations.filter((item) => item !== 'unknown');
      const locationOr: Record<string, unknown>[] = [];
      if (knownLocations.length) locationOr.push({ location: { $in: knownLocations } }, { countriesAllowed: { $in: knownLocations } });
      if (query.locations.includes('unknown')) locationOr.push({ $or: [{ location: { $exists: false } }, { location: null }, { location: '' }, { location: 'unknown' }] });
      and.push({ $or: locationOr });
    }
    if (query.countriesAllowed?.length) {
      const knownCountries = query.countriesAllowed.filter((item) => item !== 'unknown');
      const countryOr: Record<string, unknown>[] = [];
      if (knownCountries.length) countryOr.push({ countriesAllowed: { $in: knownCountries } });
      if (query.countriesAllowed.includes('unknown')) countryOr.push({ $or: [{ countriesAllowed: { $exists: false } }, { countriesAllowed: { $size: 0 } }] });
      and.push({ $or: countryOr });
    }
    if (query.technologies?.length) and.push({ $or: [{ technologies: { $in: query.technologies } }, { skills: { $in: query.technologies } }] });
    if (query.seniority) filter.seniority = query.seniority;
    if (query.remoteType) filter.remoteType = query.remoteType;
    this.addSemanticUnknownFilter(filter, and, 'money.currency', query.currency);
    addMoneyDimensionFilter(filter, and, 'money.period', 'period', query.moneyPeriod);
    addMoneyDimensionFilter(filter, and, 'money.kind', 'kind', query.moneyKind);
    if (query.role) filter.title = query.role;
    if (query.counterpart === 'unknown') and.push({ $or: [{ companyOrClient: { $exists: false } }, { companyOrClient: null }, { companyOrClient: '' }, { companyOrClient: 'unknown' }] });
    else if (query.counterpart) filter.companyOrClient = query.counterpart;
    if (and.length) filter.$and = and;
    return filter;
  }

  private addSemanticUnknownFilter(filter: Record<string, unknown>, and: Record<string, unknown>[], field: string, value?: string): void {
    if (!value) return;
    if (value === 'unknown') {
      and.push({ $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }, { [field]: 'unknown' }] });
      return;
    }
    filter[field] = value;
  }

  private resolveRange(query: AnalyticsQueryDto): Range {
    const now = new Date();
    if (query.period === 'custom') {
      const from = this.analyticsBoundary(query.from, 'from');
      const to = this.analyticsBoundary(query.to, 'to');
      if (!Number.isFinite(+from) || !Number.isFinite(+to) || +to < +from) {
        throw new BadRequestException('Specify valid analytics from/to dates');
      }
      return { from, to, period: 'custom' };
    }
    const days = query.period === '7d' ? 7 : query.period === '90d' ? 90 : 30;
    return { from: new Date(+now - days * 86_400_000), to: now, period: query.period ?? '30d' };
  }


  private previousRange(range: Range): Range {
    const width = +range.to - +range.from;
    const previousTo = new Date(+range.from - 1);
    return { from: new Date(+previousTo - width), to: previousTo, period: range.period };
  }

  private analyticsBoundary(value: string | undefined, edge: 'from' | 'to'): Date {
    if (!value) return new Date('');
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Date(`${value}T${edge === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`);
    }
    return new Date(value);
  }

  private sourceIds(query: AnalyticsQueryDto): string[] {
    return Array.from(new Set([...(query.sourceIds ?? []), ...(query.sourceId ? [query.sourceId] : [])].filter(Boolean)));
  }

  private filterEcho(query: AnalyticsQueryDto, range: Range, sourceIds: string[], includeClosed: boolean) {
    return {
      period: range.period,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      profileId: query.profileId ?? null,
      type: query.type ?? 'all',
      sourceIds,
      sourceGroups: query.sourceGroups ?? [],
      locations: query.locations ?? [],
      countriesAllowed: query.countriesAllowed ?? [],
      technologies: query.technologies ?? [],
      seniority: query.seniority ?? null,
      remoteType: query.remoteType ?? null,
      role: query.role ?? null,
      counterpart: query.counterpart ?? null,
      currency: query.currency ?? null,
      moneyPeriod: query.moneyPeriod ?? null,
      moneyKind: query.moneyKind ?? null,
      includeClosed,
    };
  }

  private sourceMap(sources: SourceInfo[]): Map<string, { name: string; group: string }> {
    return new Map(sources.map((source) => [source._id, { name: source.name, group: source.group }]));
  }

  private opportunityAnalyticsProjection() {
    return {
      _id: 1, type: 1, title: 1, companyOrClient: 1, skills: 1, technologies: 1, seniority: 1, location: 1, remoteType: 1, countriesAllowed: 1, money: 1, firstSeenAt: 1, lastSeenAt: 1, sourceStatus: 1,
      'sourceOccurrences.sourceId': 1,
      'sourceOccurrences.primary': 1,
      'sourceOccurrences.lastSeenAt': 1,
      'sourceOccurrences.status': 1,
      'sourceOccurrences.sourceMetadata.group': 1,
    };
  }

  private async latestAiScores(userId: string, profileId: string | undefined, opportunityIds: string[]): Promise<Map<string, number | null>> {
    if (!opportunityIds.length) return new Map();
    const match: Record<string, unknown> = { userId, status: 'completed', taskType: 'opportunity_analysis', opportunityId: { $in: opportunityIds } };
    if (profileId) match.profileId = profileId;
    if (!this.connection) return new Map();
    const groupId = profileId ? '$opportunityId' : { opportunityId: '$opportunityId', profileId: '$profileId' };
    const rows = await this.connection.collection('ai_analyses').aggregate([
      { $match: match },
      { $sort: { completedAt: -1, createdAt: -1, _id: -1 } },
      { $group: { _id: groupId, aiScore: { $first: '$aiScore' } } },
    ]).toArray();
    return new Map(rows.map((row, index) => [typeof row._id === 'string' ? row._id : `${row._id?.opportunityId ?? 'opportunity'}:${row._id?.profileId ?? index}`, typeof row.aiScore === 'number' ? row.aiScore : null]));
  }

  private personalFunnel(states: AnalyticsState[], opportunities: Map<string, AnalyticsOpportunity>, range: Range, selectedType?: OpportunityType) {
    const types = selectedType ? [selectedType] : OPPORTUNITY_TYPES.slice();
    const statuses = Array.from(new Set(types.flatMap((type) => this.pipelineStatusesForType(type))));
    return statuses.map((status) => {
      const count = states.filter((state) => {
        const opportunity = opportunities.get(state.opportunityId);
        return opportunity && (!selectedType || opportunity.type === selectedType) && this.inRange(this.earliestReachedAtForType(state, opportunity.type, new Set([status])), range);
      }).length;
      return { status, label: this.pipelineLabel(status), count };
    });
  }

  private personalFunnels(states: AnalyticsState[], opportunities: Map<string, AnalyticsOpportunity>, range: Range, selectedType?: OpportunityType) {
    const types = selectedType ? [selectedType] : OPPORTUNITY_TYPES.slice();
    return types.map((type) => {
      const typeStates = states.filter((state) => opportunities.get(state.opportunityId)?.type === type);
      const counts = this.pipelineStatusesForType(type).map((status) => ({
        status,
        label: this.pipelineLabel(status),
        count: typeStates.filter((state) => this.inRange(this.earliestReachedAtForType(state, type, new Set([status])), range)).length,
        pipelineReachedStatuses: status,
      }));
      const stages = counts.map((stage, index) => ({
        ...stage,
        conversionRate: index === 0 ? null : this.percent(stage.count, counts[index - 1].count),
        conversionRateFormula: index === 0 ? null : `${stage.status}/${counts[index - 1].status}`,
      }));
      return { type, stages };
    });
  }

  private pipelineStatusesForType(type: OpportunityType): PipelineStatus[] {
    return pipelineStagesForType(type).filter((status) => status !== 'New') as PipelineStatus[];
  }

  private currentPipeline(states: AnalyticsState[], opportunities: Map<string, AnalyticsOpportunity>, selectedType?: OpportunityType) {
    const statuses = selectedType ? this.pipelineStatusesForType(selectedType) : Array.from(new Set(OPPORTUNITY_TYPES.flatMap((type) => this.pipelineStatusesForType(type))));
    return statuses.map((status) => ({
      status,
      label: this.pipelineLabel(status),
      count: states.filter((state) => {
        const opportunity = opportunities.get(state.opportunityId);
        return opportunity && (!selectedType || opportunity.type === selectedType) && normalizePipelineStatus(opportunity.type, state.pipelineStatus).status === status;
      }).length,
    }));
  }

  private pipelineGroups(states: AnalyticsState[], range: Range, opportunities = new Map<string, AnalyticsOpportunity>()): Record<PipelineGroup, number> {
    const count = (statuses: Set<PipelineStatus>) => states.filter((state) => {
      const opportunity = opportunities.get(state.opportunityId);
      const reachedAt = opportunity ? this.earliestReachedAtForType(state, opportunity.type, statuses) : this.earliestReachedAt(state, statuses);
      return this.inRange(reachedAt, range);
    }).length;
    return {
      reviewed: count(REVIEWED_STATUSES),
      responses: count(RESPONSE_STATUSES),
      replies: count(REPLY_STATUSES),
      interviews: count(INTERVIEW_STATUSES),
      offersWon: count(OFFER_WON_STATUSES),
    };
  }

  private personalSources(states: AnalyticsState[], opportunities: Map<string, AnalyticsOpportunity>, sources: Map<string, { name: string; group: string }>, range: Range, selectedSourceIds: string[] = []) {
    const selected = selectedSourceIds.length ? new Set(selectedSourceIds) : null;
    const rows = new Map<string, { sourceId: string; sourceName: string; group: string; found: number; responses: number; replies: number; wins: number; sampleCount: number; foundOpportunityIds: Set<string> }>();
    const relevantSources = (opportunity: AnalyticsOpportunity): string[] => {
      const occurrences = opportunity.sourceOccurrences?.length ? opportunity.sourceOccurrences : [{ sourceId: 'manual' } as SourceOccurrence];
      return Array.from(new Set(occurrences.map((occurrence) => occurrence.sourceId).filter((sourceId) => !selected || selected.has(sourceId))));
    };
    const ensure = (sourceId: string) => {
      const info = sources.get(sourceId) ?? { name: sourceId === 'manual' ? 'Ручной импорт' : sourceId, group: 'unknown' };
      const row = rows.get(sourceId) ?? { sourceId, sourceName: info.name, group: info.group, found: 0, responses: 0, replies: 0, wins: 0, sampleCount: 0, foundOpportunityIds: new Set<string>() };
      rows.set(sourceId, row);
      return row;
    };
    for (const opportunity of opportunities.values()) {
      if (!this.inRange(opportunity.firstSeenAt, range)) continue;
      for (const sourceId of relevantSources(opportunity)) {
        const row = ensure(sourceId);
        if (!row.foundOpportunityIds.has(opportunity._id)) {
          row.foundOpportunityIds.add(opportunity._id);
          row.found += 1;
        }
      }
    }
    for (const state of states) {
      const opportunity = opportunities.get(state.opportunityId);
      if (!opportunity) continue;
      for (const sourceId of relevantSources(opportunity)) {
        const row = ensure(sourceId);
        row.sampleCount += 1;
        if (this.inRange(this.earliestReachedAt(state, RESPONSE_STATUSES), range)) row.responses += 1;
        if (this.inRange(this.earliestReachedAt(state, REPLY_STATUSES), range)) row.replies += 1;
        if (this.inRange(this.earliestReachedAt(state, WIN_STATUSES), range)) row.wins += 1;
      }
    }
    return Array.from(rows.values()).map(({ foundOpportunityIds: _foundOpportunityIds, ...row }) => ({
      ...row,
      responseRate: this.percent(row.responses, row.sampleCount),
      replyRate: this.percent(row.replies, row.sampleCount),
      winRate: this.percent(row.wins, row.sampleCount),
      qualityLabel: row.sampleCount < 5 ? 'Малая выборка' : row.wins > 0 ? 'Есть успешные исходы' : 'Без успешных исходов',
    })).sort((left, right) => right.sampleCount - left.sampleCount || right.found - left.found || left.sourceName.localeCompare(right.sourceName));
  }

  private marketSources(opportunities: AnalyticsOpportunity[], sources: Map<string, { name: string; group: string }>) {
    const rows = new Map<string, { sourceId: string; sourceName: string; group: string; count: number; duplicateContributions: number; active: number; closed: number; lastSeenAt: Date | null }>();
    for (const opportunity of opportunities) {
      const occurrences = opportunity.sourceOccurrences ?? [];
      for (const occurrence of occurrences.length ? occurrences : [{ sourceId: 'manual', lastSeenAt: opportunity.lastSeenAt, status: opportunity.sourceStatus } as SourceOccurrence]) {
        const sourceId = occurrence.sourceId;
        const info = sources.get(sourceId) ?? { name: sourceId === 'manual' ? 'Ручной импорт' : sourceId, group: 'unknown' };
        const row = rows.get(sourceId) ?? { sourceId, sourceName: info.name, group: info.group, count: 0, duplicateContributions: 0, active: 0, closed: 0, lastSeenAt: null };
        row.count += 1;
        if (occurrences.length > 1) row.duplicateContributions += 1;
        if (['Active', 'Unknown'].includes(occurrence.status ?? opportunity.sourceStatus)) row.active += 1;
        else row.closed += 1;
        const seen = occurrence.lastSeenAt ?? opportunity.lastSeenAt;
        if (seen && (!row.lastSeenAt || +new Date(seen) > +row.lastSeenAt)) row.lastSeenAt = new Date(seen);
        rows.set(sourceId, row);
      }
    }
    return Array.from(rows.values()).map((row) => ({
      ...row,
      duplicateRate: this.percent(row.duplicateContributions, row.count),
      freshnessLabel: row.lastSeenAt ? `${Math.max(0, Math.round((Date.now() - +row.lastSeenAt) / 86_400_000))} дн. назад` : 'Нет данных',
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    })).sort((left, right) => right.count - left.count || left.sourceName.localeCompare(right.sourceName));
  }

  private technologyRows(opportunities: AnalyticsOpportunity[]) {
    return this.countValues(opportunities.flatMap((opportunity) => Array.from(new Set([...(opportunity.technologies ?? []), ...(opportunity.skills ?? [])]))), 'technology');
  }

  private roleRows(opportunities: AnalyticsOpportunity[]) {
    return this.countValues(opportunities.map((opportunity) => this.roleLabel(opportunity)).filter(Boolean) as string[], 'role');
  }

  private roleLabel(opportunity: AnalyticsOpportunity): string | undefined {
    return opportunity.title?.trim();
  }

  private counterparts(opportunities: AnalyticsOpportunity[]) {
    return this.countValues(opportunities.map((opportunity) => opportunity.companyOrClient?.trim() || 'unknown'), 'counterpart');
  }

  private geography(opportunities: AnalyticsOpportunity[]) {
    return {
      locations: this.countValues(opportunities.map((opportunity) => opportunity.location?.trim() || 'unknown'), 'location'),
      countries: this.countValues(opportunities.flatMap((opportunity) => Array.from(new Set(opportunity.countriesAllowed?.length ? opportunity.countriesAllowed : ['unknown']))), 'country'),
      remoteTypes: this.countValues(opportunities.map((opportunity) => opportunity.remoteType?.trim() || 'unknown'), 'remoteType'),
    };
  }

  private compensation(opportunities: AnalyticsOpportunity[]) {
    const comparable = this.moneyComparable(opportunities);
    const byCurrency = new Map<string, number[]>();
    const byTypeCurrencyPeriodKind = new Map<string, { type: string; currency: string; period: string; kind: string; values: number[] }>();
    for (const item of comparable) {
      const value = this.finiteNumber(item.money.max) ?? this.finiteNumber(item.money.min);
      if (value === null) continue;
      const currency = item.money.currency || 'unknown';
      const period = canonicalMoneyDimensionValue('period', item.money.period) ?? 'unknown';
      const kind = canonicalMoneyDimensionValue('kind', item.money.kind) ?? 'unknown';
      const currencyPeriod = `${currency}${period !== 'unknown' ? ` / ${period}` : ''}`;
      byCurrency.set(currencyPeriod, [...(byCurrency.get(currencyPeriod) ?? []), value]);
      const key = `${item.type}|${currency}|${period}|${kind}`;
      const row = byTypeCurrencyPeriodKind.get(key) ?? { type: item.type, currency, period, kind, values: [] };
      row.values.push(value);
      byTypeCurrencyPeriodKind.set(key, row);
    }
    const summarise = (values: number[]) => ({ count: values.length, median: this.median(values), min: Math.min(...values), max: Math.max(...values) });
    return {
      comparableCount: comparable.length,
      missingCount: Math.max(0, opportunities.length - comparable.length),
      coverage: this.percent(comparable.length, opportunities.length),
      byCurrency: Array.from(byCurrency.entries()).map(([currencyPeriod, values]) => ({
        currencyPeriod,
        ...summarise(values),
      })).sort((left, right) => right.count - left.count),
      byTypeCurrencyPeriodKind: Array.from(byTypeCurrencyPeriodKind.values()).map(({ values, ...row }) => ({
        ...row,
        ...summarise(values),
      })).sort((left, right) => right.count - left.count || left.currency.localeCompare(right.currency)),
    };
  }

  private moneyComparable(opportunities: AnalyticsOpportunity[]) {
    return opportunities
      .map((opportunity) => ({ type: opportunity.type, money: opportunity.money ?? {} }))
      .filter((item) => this.finiteNumber(item.money.min) !== null || this.finiteNumber(item.money.max) !== null);
  }

  private personalTimeseries(opportunities: AnalyticsOpportunity[], states: AnalyticsState[], range: Range) {
    const rows = new Map<string, { date: string; from: string; to: string; found: number; responses: number; replies: number; interviews: number; wins: number }>();
    const ensure = (date: Date) => {
      const bucket = this.bucketInfo(date, range, 'personal');
      const row = rows.get(bucket.date) ?? { date: bucket.date, from: bucket.from, to: bucket.to, found: 0, responses: 0, replies: 0, interviews: 0, wins: 0 };
      rows.set(bucket.date, row);
      return row;
    };
    for (const date of this.bucketStarts(range, 'personal')) ensure(date);
    for (const opportunity of opportunities) {
      const firstSeenAt = this.validDate(opportunity.firstSeenAt);
      if (firstSeenAt && this.inRange(firstSeenAt, range)) ensure(firstSeenAt).found += 1;
    }
    for (const state of states) {
      const groups: [keyof Omit<{ date: string; from: string; to: string; found: number; responses: number; replies: number; interviews: number; wins: number }, 'date' | 'from' | 'to' | 'found'>, Set<PipelineStatus>][] = [
        ['responses', RESPONSE_STATUSES],
        ['replies', REPLY_STATUSES],
        ['interviews', INTERVIEW_STATUSES],
        ['wins', WIN_STATUSES],
      ];
      for (const [key, statuses] of groups) {
        const reachedAt = this.earliestReachedAt(state, statuses);
        if (!this.inRange(reachedAt, range)) continue;
        ensure(reachedAt!)[key] += 1;
      }
    }
    return Array.from(rows.values()).sort((left, right) => left.date.localeCompare(right.date));
  }

  private marketTimeseries(opportunities: AnalyticsOpportunity[], range: Range) {
    const rows = new Map<string, { date: string; from: string; to: string; count: number; vacancy: number; freelance: number; tender: number }>();
    const ensure = (date: Date) => {
      const bucket = this.bucketInfo(date, range, 'market');
      const row = rows.get(bucket.date) ?? { date: bucket.date, from: bucket.from, to: bucket.to, count: 0, vacancy: 0, freelance: 0, tender: 0 };
      rows.set(bucket.date, row);
      return row;
    };
    for (const date of this.bucketStarts(range, 'market')) ensure(date);
    for (const opportunity of opportunities) {
      const firstSeenAt = this.validDate(opportunity.firstSeenAt);
      if (!firstSeenAt || !this.inRange(firstSeenAt, range)) continue;
      const row = ensure(firstSeenAt);
      row.count += 1;
      row[opportunity.type] += 1;
    }
    return Array.from(rows.values()).sort((left, right) => left.date.localeCompare(right.date));
  }

  private profileRows(states: AnalyticsState[], range: Range) {
    const rows = new Map<string, { profileId: string; tracked: number; trackedAllTime: number; responses: number; interviews: number; wins: number }>();
    for (const state of states) {
      const row = rows.get(state.profileId) ?? { profileId: state.profileId, tracked: 0, trackedAllTime: 0, responses: 0, interviews: 0, wins: 0 };
      row.tracked += 1;
      row.trackedAllTime += 1;
      if (this.inRange(this.earliestReachedAt(state, RESPONSE_STATUSES), range)) row.responses += 1;
      if (this.inRange(this.earliestReachedAt(state, INTERVIEW_STATUSES), range)) row.interviews += 1;
      if (this.inRange(this.earliestReachedAt(state, WIN_STATUSES), range)) row.wins += 1;
      rows.set(state.profileId, row);
    }
    return Array.from(rows.values()).sort((left, right) => right.trackedAllTime - left.trackedAllTime);
  }

  private sourceGroupRows(opportunities: AnalyticsOpportunity[]) {
    return this.countValues(opportunities.flatMap((opportunity) => {
      const occurrences = opportunity.sourceOccurrences ?? [];
      return occurrences.length
        ? Array.from(new Set(occurrences.map((occurrence) => String(occurrence.sourceMetadata?.group || 'unknown'))))
        : ['unknown'];
    }), 'sourceGroup');
  }

  private scoreBands(states: AnalyticsState[], aiScores: Map<string, number | null>) {
    return {
      match: this.scoreBandRows(states.map((state) => state.matchScore), 'matchBand'),
      ai: this.scoreBandRows(Array.from(aiScores.values()), 'aiBand'),
    };
  }

  private scoreBandRows(values: (number | null | undefined)[], key: string) {
    const bands = [
      { label: '0-20', min: 0, max: 20 },
      { label: '21-40', min: 21, max: 40 },
      { label: '41-60', min: 41, max: 60 },
      { label: '61-80', min: 61, max: 80 },
      { label: '81-100', min: 81, max: 100 },
    ];
    return bands.map((band) => ({
      [key]: band.label,
      from: band.min,
      to: band.max,
      count: values.filter((value) => { const numeric = this.finiteNumber(value); return numeric !== null && numeric >= band.min && numeric <= band.max; }).length,
    }));
  }


  private earliestReachedAtForType(state: AnalyticsState, type: OpportunityType, statuses: Set<PipelineStatus>): Date | null {
    const dates = (state.pipelineEvents ?? [])
      .filter((event) => statuses.has(normalizePipelineStatus(type, event.status).status))
      .map((event) => this.validDate(event.firstReachedAt))
      .filter((date): date is Date => Boolean(date))
      .sort((left, right) => +left - +right);
    if (dates[0]) return dates[0];
    return statuses.has(normalizePipelineStatus(type, state.pipelineStatus).status) ? this.validDate(state.updatedAt) : null;
  }

  private earliestReachedAt(state: AnalyticsState, statuses: Set<PipelineStatus>): Date | null {
    const dates = (state.pipelineEvents ?? [])
      .filter((event) => statuses.has(event.status))
      .map((event) => this.validDate(event.firstReachedAt))
      .filter((date): date is Date => Boolean(date))
      .sort((left, right) => +left - +right);
    return dates[0] ?? null;
  }

  private stateTouchedInRange(state: AnalyticsState, range: Range): boolean {
    return (state.pipelineEvents ?? []).some((event) => this.inRange(event.firstReachedAt, range)) || this.inRange(state.updatedAt, range);
  }

  private inRange(value: Date | string | null | undefined, range: Range): boolean {
    if (!value) return false;
    const date = new Date(value);
    return Number.isFinite(+date) && +date >= +range.from && +date <= +range.to;
  }

  private validDate(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(+date) ? date : null;
  }

  private bucketInfo(date: Date, range: Range, mode: 'personal' | 'market'): { date: string; from: string; to: string } {
    const longRange = +range.to - +range.from > 45 * 86_400_000;
    if (!longRange) {
      const key = date.toISOString().slice(0, 10);
      return { date: key, from: key, to: key };
    }
    if (mode === 'market') {
      const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
      const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
      return { date: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`, from: this.clippedDate(start, range), to: this.clippedDate(end, range) };
    }
    const rangeStart = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate()));
    const dateStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const index = Math.max(0, Math.floor((+dateStart - +rangeStart) / (7 * 86_400_000)));
    const start = new Date(+rangeStart + index * 7 * 86_400_000);
    const end = new Date(Math.min(+range.to, +start + 6 * 86_400_000));
    return { date: this.clippedDate(start, range), from: this.clippedDate(start, range), to: this.clippedDate(end, range) };
  }

  private bucketStarts(range: Range, mode: 'personal' | 'market'): Date[] {
    const longRange = +range.to - +range.from > 45 * 86_400_000;
    const dates: Date[] = [];
    if (longRange && mode === 'market') {
      let cursor = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 1));
      const end = new Date(Date.UTC(range.to.getUTCFullYear(), range.to.getUTCMonth(), 1));
      while (+cursor <= +end) {
        dates.push(new Date(cursor));
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      }
      return dates;
    }
    const step = longRange && mode === 'personal' ? 7 * 86_400_000 : 86_400_000;
    let cursor = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate()));
    const end = new Date(Date.UTC(range.to.getUTCFullYear(), range.to.getUTCMonth(), range.to.getUTCDate()));
    while (+cursor <= +end) {
      dates.push(new Date(cursor));
      cursor = new Date(+cursor + step);
    }
    return dates;
  }

  private clippedDate(date: Date, range: Range): string {
    const clipped = new Date(Math.min(Math.max(+date, +range.from), +range.to));
    return clipped.toISOString().slice(0, 10);
  }

  private countBy(opportunities: AnalyticsOpportunity[], pick: (opportunity: AnalyticsOpportunity) => string | undefined, key: string): AnalyticsRow[] {
    return this.countValues(opportunities.map(pick).filter(Boolean) as string[], key);
  }

  private countValues(values: string[], key: string): AnalyticsRow[] {
    const counts = new Map<string, number>();
    for (const value of values.map((item) => item.trim()).filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
    return Array.from(counts.entries()).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([value, count]) => ({ [key]: value, count }));
  }

  private finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private average(values: number[]): number | null {
    if (!values.length) return null;
    return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
  }

  private median(values: number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 100) / 100;
  }

  private percent(numerator: number, denominator: number): number | null {
    if (!denominator) return null;
    return Math.round((numerator / denominator) * 1000) / 10;
  }

  private pipelineLabel(status: PipelineStatus): string {
    const labels: Record<PipelineStatus, string> = {
      New: 'Новые',
      Reviewed: 'Просмотрено',
      Interested: 'Интересно',
      Shortlisted: 'В шорт-листе',
      Applied: 'Отклик отправлен',
      HRReply: 'Ответ HR',
      Interview: 'Интервью',
      TechnicalInterview: 'Техническое интервью',
      Offer: 'Оффер',
      Rejected: 'Отклонено',
      Archived: 'Архив',
      ResponseSent: 'Ответ отправлен',
      ClientReplied: 'Клиент ответил',
      Negotiation: 'Переговоры',
      Won: 'Выиграно',
      InProgress: 'В работе',
      Completed: 'Завершено',
      Lost: 'Проиграно',
      PreparingApplication: 'Подготовка заявки',
      ApplicationSubmitted: 'Заявка подана',
      Admitted: 'Допущены',
      BiddingEvaluation: 'Торги/оценка',
      Contracting: 'Контрактование',
    };
    return labels[status];
  }

  private csv(rows: Record<string, unknown>[]): string {
    const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    const body = [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ''))]
      .map((row) => row.map((value) => this.csvCell(value)).join(','))
      .join('\n');
    return `\uFEFF${body}\n`;
  }

  private sectionRows(section: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map((row) => ({ section, ...row }));
  }

  private scalar(value: unknown): string | number | null {
    if (typeof value === 'string' || typeof value === 'number' || value === null) return value;
    return value === undefined ? null : JSON.stringify(value);
  }

  private csvCell(value: unknown): string {
    const text = this.scalar(value) ?? '';
    return `"${String(text).replaceAll('"', '""')}"`;
  }
}
