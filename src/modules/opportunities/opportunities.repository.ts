import { ConflictException, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, PipelineStage } from 'mongoose';

import { addMoneyDimensionFilter } from '../../common/money-dimensions';
import type { MatchingOpportunity } from '../matching/matching.service';
import { OpportunityListQueryDto, OpportunitySortDto } from './dto/opportunity.dto';
import { Opportunity, OpportunityDocument, SourceOccurrence, SourceStatus } from './schemas/opportunity.schema';
import { sourceOccurrenceRevision } from './source-occurrence-revision';
import { DUPLICATE_INDEX_VERSION, opportunityDuplicateKeys } from './opportunity-duplicate-keys';
import { OpportunityMergesRepository } from './opportunity-merges.repository';

export type CursorPage<T> = { items: T[]; nextCursor: string | null };

export type OpportunitySortCandidate = MatchingOpportunity & Pick<Opportunity,
  '_id' | 'title' | 'deadline' | 'sourceStatus'
> & { updatedAt?: Date };

export type OpportunityExportCandidate = Pick<Opportunity,
  '_id' | 'type' | 'title' | 'companyOrClient' | 'summary' | 'description' |
  'skills' | 'technologies' | 'seniority' | 'employmentType' | 'location' |
  'remoteType' | 'money' | 'sourceStatus' | 'publishedAt' | 'firstSeenAt' |
  'deadline' | 'canonicalTags'
> & { sourceOccurrences: Array<Pick<SourceOccurrence, 'sourceId' | 'url'>> };

export type LatestAiProjection = {
  opportunityId: string;
  runId: string;
  aiScore: number | null;
  completedAt?: Date;
  createdAt?: Date;
  taskType: string;
};

export type SourceRefreshCandidate = {
  opportunityId: string;
  occurrence: SourceOccurrence;
};

export type SourceRefreshOccurrenceIdentity = {
  sourceId: string;
  opportunityId: string;
  externalId: string;
  url: string;
};


export type SourceSampleCandidate = Pick<Opportunity,
  '_id' | 'type' | 'title' | 'companyOrClient' | 'summary' | 'description' | 'sourceStatus' | 'firstSeenAt' | 'lastSeenAt' |
  'publishedAt' | 'deadline' | 'skills' | 'technologies' | 'remoteType' | 'location' | 'money' | 'canonicalTags'
> & { sourceOccurrence: SourceOccurrence };

export type SourceSamplePage = CursorPage<SourceSampleCandidate>;

export type RetainedSourceOccurrenceRepairInput = {
  opportunityId: string;
  sourceId: string;
  externalId: string;
  url: string;
  expectedOccurrenceRevision: string;
  occurrencePatch: Pick<SourceOccurrence, 'publishedAt' | 'status' | 'normalizedSnapshot'>;
  canonicalPatch: Partial<Opportunity>;
};


export type MarkSourceOccurrenceRemovedExactInput = {
  opportunityId: string;
  sourceId: string;
  externalId: string;
  url: string;
  observedAt: Date | string;
  reason: string;
  runId: string;
};

const OPPORTUNITY_UPSERT_MAX_CAS_ATTEMPTS = 3;
const OPPORTUNITY_CANONICAL_CONTROL_FIELDS = new Set([
  '_id',
  'firstSeenAt',
  'lastSeenAt',
  'sourceOccurrences',
  'adminCorrections',
  'mergedIntoOpportunityId',
  'mergedAt',
]);

@Injectable()
export class OpportunitiesRepository {
  constructor(
    @InjectModel(Opportunity.name) private readonly opportunityModel: Model<OpportunityDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Optional() private readonly merges?: OpportunityMergesRepository,
  ) {}

  async list(query: OpportunityListQueryDto, restrictIds?: string[]): Promise<CursorPage<Opportunity>> {
    const limit = Math.min(query.limit ?? 50, 100);
    const filter = this.toFilter(query);
    if (restrictIds) {
      filter._id = { $in: restrictIds };
    }
    const sort = this.toSort(query);
    const cursorFilter = query.cursor ? this.decodeCursor(query.cursor, query.sort) : null;
    const mongoQuery = cursorFilter ? { $and: [filter, cursorFilter] } : filter;
    const items = await this.opportunityModel
      .find(mongoQuery)
      .sort(sort)
      .limit(limit + 1)
      .lean();

    const pageItems = items.slice(0, limit);
    return {
      items: pageItems,
      nextCursor: items.length > limit ? this.encodeCursor(pageItems[pageItems.length - 1], query.sort) : null,
    };
  }


  async latestCompletedAnalysisByOpportunity(input: { userId: string; profileId?: string; opportunityIds?: string[]; minAiScore?: number }): Promise<LatestAiProjection[]> {
    const match: Record<string, unknown> = {
      userId: input.userId,
      taskType: 'opportunity_analysis',
      status: 'completed',
    };
    if (input.profileId) match.profileId = input.profileId;
    if (input.opportunityIds?.length) match.opportunityId = { $in: input.opportunityIds };
    const rows = await this.connection.collection('ai_analyses').aggregate([
      { $match: match },
      { $sort: { completedAt: -1, createdAt: -1, _id: -1 } },
      { $group: { _id: '$opportunityId', run: { $first: '$$ROOT' } } },
      ...(typeof input.minAiScore === 'number' ? [{ $match: { 'run.aiScore': { $gte: input.minAiScore } } }] : []),
      { $project: { _id: 0, opportunityId: '$_id', runId: '$run._id', aiScore: { $ifNull: ['$run.aiScore', null] }, completedAt: '$run.completedAt', createdAt: '$run.createdAt', taskType: '$run.taskType' } },
      { $sort: { aiScore: -1, completedAt: -1, opportunityId: 1 } },
    ]).toArray();
    return rows.map((row) => ({
      opportunityId: String(row.opportunityId),
      runId: String(row.runId),
      aiScore: typeof row.aiScore === 'number' ? row.aiScore : null,
      completedAt: row.completedAt instanceof Date ? row.completedAt : row.completedAt ? new Date(String(row.completedAt)) : undefined,
      createdAt: row.createdAt instanceof Date ? row.createdAt : row.createdAt ? new Date(String(row.createdAt)) : undefined,
      taskType: String(row.taskType ?? 'opportunity_analysis'),
    }));
  }


  async listSourceSamples(params: { sourceId: string; cursor?: string; limit?: number }): Promise<SourceSamplePage> {
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 50);
    const cursor = this.decodeSourceSampleCursor(params.cursor);
    const pipeline: PipelineStage[] = [
      { $match: { 'sourceOccurrences.sourceId': params.sourceId, mergedIntoOpportunityId: { $exists: false } } },
      { $set: { sourceOccurrence: { $first: { $filter: { input: '$sourceOccurrences', as: 'occurrence', cond: { $eq: ['$$occurrence.sourceId', params.sourceId] } } } } } },
      { $match: { sourceOccurrence: { $ne: null } } },
      ...(cursor ? [{ $match: { $or: [
        { 'sourceOccurrence.lastSeenAt': { $lt: cursor.lastSeenAt } },
        { 'sourceOccurrence.lastSeenAt': cursor.lastSeenAt, _id: { $gt: cursor.id } },
      ] } }] : []),
      { $sort: { 'sourceOccurrence.lastSeenAt': -1, _id: 1 } },
      { $limit: limit + 1 },
      { $project: this.sourceSampleProjection() },
    ];
    const rows = await this.opportunityModel.aggregate<SourceSampleCandidate>(pipeline).exec();
    const pageItems = rows.slice(0, limit);
    return {
      items: pageItems,
      nextCursor: rows.length > limit ? this.encodeSourceSampleCursor(pageItems[pageItems.length - 1]) : null,
    };
  }

  async getSourceSample(sourceId: string, opportunityId: string): Promise<SourceSampleCandidate | null> {
    const rows = await this.opportunityModel.aggregate<SourceSampleCandidate>([
      { $match: { _id: opportunityId, 'sourceOccurrences.sourceId': sourceId, mergedIntoOpportunityId: { $exists: false } } },
      { $set: { sourceOccurrence: { $first: { $filter: { input: '$sourceOccurrences', as: 'occurrence', cond: { $eq: ['$$occurrence.sourceId', sourceId] } } } } } },
      { $match: { sourceOccurrence: { $ne: null } } },
      { $limit: 1 },
      { $project: this.sourceSampleProjection() },
    ]).exec();
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<Opportunity | null> {
    return this.opportunityModel.findById(id).lean();
  }

  async findByIds(ids: string[]): Promise<Opportunity[]> {
    return this.opportunityModel.find({ _id: { $in: ids } }).lean();
  }

  async findForExportByIds(ids: string[]): Promise<OpportunityExportCandidate[]> {
    return this.opportunityModel.find({ _id: { $in: ids } }, {
      _id: 1, type: 1, title: 1, companyOrClient: 1, summary: 1, description: 1,
      skills: 1, technologies: 1, seniority: 1, employmentType: 1, location: 1,
      remoteType: 1, money: 1, sourceStatus: 1, publishedAt: 1, firstSeenAt: 1,
      deadline: 1, canonicalTags: 1, 'sourceOccurrences.sourceId': 1, 'sourceOccurrences.url': 1,
    }).lean();
  }

  async findTypesByIds(ids: string[]): Promise<Array<Pick<Opportunity, '_id' | 'type'>>> {
    return this.opportunityModel.find({ _id: { $in: ids } }, { _id: 1, type: 1 }).lean();
  }

  async listForExport(query: OpportunityListQueryDto, restrictIds?: string[], limit = 1000): Promise<Opportunity[]> {
    const filter = this.toFilter(query);
    if (restrictIds) {
      filter._id = { $in: restrictIds };
    }
    return this.opportunityModel
      .find(filter)
      .sort(this.toSort(query))
      .limit(Math.min(limit, 1000))
      .lean();
  }

  async listCanonicalCandidates(query: OpportunityListQueryDto, restrictIds?: string[], batchSize = 500): Promise<Opportunity[]> {
    const filter = this.toFilter(query);
    if (restrictIds) {
      filter._id = { $in: restrictIds };
    }
    const limit = Math.min(Math.max(batchSize, 1), 500);
    const items: Opportunity[] = [];
    let cursor: { firstSeenAt?: Date; _id: string } | null = null;
    while (true) {
      const cursorFilter: Record<string, unknown> | null = cursor ? this.afterCanonicalCursor(cursor) : null;
      const mongoQuery: Record<string, unknown> = cursorFilter ? { $and: [filter, cursorFilter] } : filter;
      const batch: Opportunity[] = await this.opportunityModel
        .find(mongoQuery)
        .sort({ firstSeenAt: -1, _id: 1 })
        .limit(limit)
        .lean();
      if (!batch.length) break;
      items.push(...batch);
      const last: Opportunity = batch[batch.length - 1];
      cursor = { firstSeenAt: last.firstSeenAt, _id: last._id };
      if (batch.length < limit) break;
    }
    return items;
  }

  async *iteratePrivateSortCandidates(query: OpportunityListQueryDto, restrictIds?: string[], batchSize = 500, selectedOnly = false): AsyncGenerator<OpportunitySortCandidate[]> {
    const filter = selectedOnly ? {} : this.toFilter(query);
    if (restrictIds) filter._id = { $in: restrictIds };
    const limit = Math.min(Math.max(batchSize, 1), 500);
    const projection = {
      _id: 1, title: 1, money: 1, deadline: 1, publishedAt: 1, firstSeenAt: 1,
      updatedAt: 1, sourceStatus: 1, skills: 1, technologies: 1, seniority: 1,
      remoteType: 1, location: 1, employmentType: 1, 'sourceOccurrences.sourceId': 1,
    };
    const cursor = this.opportunityModel.find(filter, projection)
      .sort({ firstSeenAt: -1, _id: 1 })
      .lean()
      .cursor({ batchSize: limit });
    let batch: OpportunitySortCandidate[] = [];
    try {
      for await (const candidate of cursor) {
        batch.push(candidate);
        if (batch.length === limit) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length) yield batch;
    } finally {
      await cursor.close();
    }
  }

  async findActiveForMatching(limit = 1000): Promise<Opportunity[]> {
    return this.opportunityModel
      .find({ sourceStatus: { $in: ['Active', 'Unknown'] }, mergedIntoOpportunityId: { $exists: false } })
      .sort({ firstSeenAt: -1, _id: 1 })
      .limit(limit)
      .lean();
  }

  async getById(id: string): Promise<Opportunity> {
    const visited = new Set<string>();
    for (let hop = 0; hop < 20; hop += 1) {
      if (visited.has(id)) throw new ConflictException('Opportunity alias cycle');
      visited.add(id);
      const opportunity = await this.findById(id);
      if (!opportunity) throw new NotFoundException('Opportunity not found');
      if (!opportunity.mergedIntoOpportunityId) return opportunity;
      id = opportunity.mergedIntoOpportunityId;
    }
    throw new ConflictException('Opportunity alias chain exceeds safe depth');
  }

  async findByOccurrence(sourceId: string, externalId?: string, url?: string): Promise<Opportunity | null> {
      const occurrenceFilter: Record<string, unknown> = externalId
      ? { sourceOccurrences: { $elemMatch: { sourceId, externalId } } }
      : { sourceOccurrences: { $elemMatch: { sourceId, url } } };
    return this.opportunityModel.findOne({ ...occurrenceFilter, mergedIntoOpportunityId: { $exists: false } }).lean();
  }

  async listSourceRefreshCandidates(input: {
    sourceId: string;
    activeCutoff: Date;
    inactiveCutoff: Date;
    limit: number;
    opportunityIds?: string[];
    ignoreCadence?: boolean;
  }): Promise<SourceRefreshCandidate[]> {
    const match: Record<string, unknown> = {
      mergedIntoOpportunityId: { $exists: false },
      sourceOccurrences: { $elemMatch: { sourceId: input.sourceId } },
    };
    if (input.opportunityIds?.length) match._id = { $in: input.opportunityIds };
    const occurrenceMatch: Record<string, unknown> = {
      'sourceOccurrences.sourceId': input.sourceId,
      'sourceOccurrences.status': { $ne: 'Removed' },
    };
    if (!input.ignoreCadence) {
      occurrenceMatch.$or = [
        { 'sourceOccurrences.status': { $in: ['Active', 'Unknown'] }, 'sourceOccurrences.lastSeenAt': { $lte: input.activeCutoff } },
        { 'sourceOccurrences.status': { $in: ['Closed', 'Expired'] }, 'sourceOccurrences.lastSeenAt': { $lte: input.inactiveCutoff } },
        { 'sourceOccurrences.lastSeenAt': { $exists: false } },
      ];
    }
    const rows = await this.opportunityModel.aggregate([
      { $match: match },
      { $unwind: '$sourceOccurrences' },
      { $match: { ...occurrenceMatch, 'sourceOccurrences.externalId': { $type: 'string', $ne: '' }, 'sourceOccurrences.url': { $type: 'string', $ne: '' } } },
      { $sort: { 'sourceOccurrences.lastSeenAt': 1, _id: 1 } },
      { $limit: Math.min(Math.max(input.limit, 1), 100) },
      { $project: { _id: 1, sourceOccurrences: 1 } },
    ]).exec();
    return rows
      .filter((row): row is { _id: unknown; sourceOccurrences: SourceOccurrence } => Boolean(row?.sourceOccurrences?.url))
      .map((row) => ({ opportunityId: String(row._id), occurrence: row.sourceOccurrences }));
  }

  async getSourceRefreshOccurrence(input: SourceRefreshOccurrenceIdentity): Promise<SourceOccurrence | null> {
    const opportunity = await this.opportunityModel.findOne({
      _id: input.opportunityId,
      mergedIntoOpportunityId: { $exists: false },
      sourceOccurrences: {
        $elemMatch: {
          sourceId: input.sourceId,
          externalId: input.externalId,
          url: input.url,
          status: { $ne: 'Removed' },
        },
      },
    }, { sourceOccurrences: 1 }).lean();
    const occurrence = opportunity?.sourceOccurrences?.find((item) =>
      item.sourceId === input.sourceId &&
      item.externalId === input.externalId &&
      item.url === input.url &&
      item.status !== 'Removed',
    );
    return occurrence ?? null;
  }

  async create(input: Partial<Opportunity>): Promise<Opportunity> {
    const created = await this.opportunityModel.create({ ...input, duplicateKeys: opportunityDuplicateKeys(input), duplicateIndexVersion: DUPLICATE_INDEX_VERSION });
    return created.toObject();
  }

  async update(id: string, input: Partial<Opportunity>): Promise<Opportunity> {
    for (let attempt = 0; attempt < OPPORTUNITY_UPSERT_MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.getById(id);
      const patch = { ...input, duplicateKeys: opportunityDuplicateKeys({ ...current, ...input }), duplicateIndexVersion: DUPLICATE_INDEX_VERSION };
      const updated = await this.opportunityModel.findOneAndUpdate(this.casFilter(current, this.touchedCanonicalFields(input)), { $set: patch }, { new: true }).lean();
      if (updated) return updated;
    }
    throw new ConflictException('Opportunity changed while saving canonical fields');
  }

  async analyticsByType(): Promise<{ type: string; count: number }[]> {
    return this.opportunityModel.aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }, { $project: { _id: 0, type: '$_id', count: 1 } }]);
  }

  async analyticsBySource(): Promise<{ sourceId: string; count: number }[]> {
    return this.opportunityModel.aggregate([
      { $unwind: '$sourceOccurrences' },
      { $group: { _id: '$sourceOccurrences.sourceId', count: { $sum: 1 } } },
      { $project: { _id: 0, sourceId: '$_id', count: 1 } },
      { $sort: { count: -1 } },
    ]);
  }

  async analyticsByTechnology(): Promise<{ technology: string; count: number }[]> {
    return this.opportunityModel.aggregate([
      { $unwind: '$technologies' },
      { $group: { _id: '$technologies', count: { $sum: 1 } } },
      { $project: { _id: 0, technology: '$_id', count: 1 } },
      { $sort: { count: -1 } },
      { $limit: 50 },
    ]);
  }

  async mergeIntoCanonical(targetId: string, duplicateId: string, actorId?: string): Promise<Opportunity> {
    if (!this.merges) throw new ServiceUnavailableException('Safe merge repository is unavailable');
    return this.merges.merge(targetId, duplicateId, { actorId });
  }

  async duplicateCandidates(opportunity: Opportunity, limit = 200): Promise<{ items: Opportunity[]; hasMore: boolean }> {
    const keys = opportunityDuplicateKeys(opportunity);
    if (!keys.length) return { items: [], hasMore: false };
    const exactKeys = keys.filter(key => key.startsWith('native:') || key.startsWith('url:'));
    const textKeys = keys.filter(key => key.startsWith('company:') || key.startsWith('fingerprint:'));
    const companyFilter: Record<string, unknown> = { duplicateKeys: { $in: textKeys } };
    // Fuzzy matching can only accept publication days at most two UTC days apart.
    // Keep exact native/URL candidates outside this restriction, including unknown dates.
    const publishedAt = opportunity.publishedAt && new Date(opportunity.publishedAt);
    if (publishedAt && Number.isFinite(publishedAt.getTime())) {
      const day = Math.floor(publishedAt.getTime() / 86_400_000) * 86_400_000;
      companyFilter.$or = [
        { publishedAt: { $gte: new Date(day - 2 * 86_400_000), $lt: new Date(day + 3 * 86_400_000) } },
        { publishedAt: null },
      ];
    }
    const nativeSources = [...new Set((opportunity.sourceOccurrences ?? [])
      .filter(occurrence => occurrence.externalId?.trim()).map(occurrence => occurrence.sourceId))];
    if (nativeSources.length) companyFilter.sourceOccurrences = { $not: { $elemMatch: { sourceId: { $in: nativeSources }, externalId: { $type: 'string', $ne: '' } } } };
    const items = await this.opportunityModel.find({
      _id: { $ne: opportunity._id }, type: opportunity.type, mergedIntoOpportunityId: { $exists: false },
      $or: [
        ...(exactKeys.length ? [{ duplicateKeys: { $in: exactKeys } }] : []),
        ...(textKeys.length ? [companyFilter] : []),
      ],
    }, {
      _id: 1, type: 1, title: 1, companyOrClient: 1, description: 1, location: 1, publishedAt: 1, firstSeenAt: 1, tenderData: 1,
      'sourceOccurrences.sourceId': 1, 'sourceOccurrences.externalId': 1, 'sourceOccurrences.url': 1,
    }).sort({ firstSeenAt: 1, _id: 1 }).limit(limit + 1).lean();
    return { items: items.slice(0, limit), hasMore: items.length > limit };
  }

  async duplicateScanPage(startedAt: Date, after?: string, limit = 50): Promise<CursorPage<Pick<Opportunity, '_id'>>> {
    const rows = await this.opportunityModel.find({
      createdAt: { $lte: startedAt }, mergedIntoOpportunityId: { $exists: false },
      ...(after ? { _id: { $gt: after } } : {}),
    }, { _id: 1 }).sort({ _id: 1 }).limit(limit + 1).lean();
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1]._id : null };
  }

  async duplicateIndexPage(after?: string, limit = 500): Promise<{ indexed: number; nextCursor: string | null }> {
    const rows = await this.opportunityModel.find({
      ...(after ? { _id: { $gt: after } } : {}), mergedIntoOpportunityId: { $exists: false },
    }, {
      _id: 1, type: 1, title: 1, companyOrClient: 1, location: 1, publishedAt: 1, updatedAt: 1, duplicateIndexVersion: 1,
      'sourceOccurrences.sourceId': 1, 'sourceOccurrences.externalId': 1, 'sourceOccurrences.url': 1,
    }).sort({ _id: 1 }).limit(limit + 1).lean();
    const operations = rows.slice(0, limit).filter(opportunity => opportunity.duplicateIndexVersion !== DUPLICATE_INDEX_VERSION).map(opportunity => ({ updateOne: {
      filter: { _id: opportunity._id, updatedAt: (opportunity as Opportunity & { updatedAt?: Date }).updatedAt, mergedIntoOpportunityId: { $exists: false } },
      update: { $set: { duplicateKeys: opportunityDuplicateKeys(opportunity), duplicateIndexVersion: DUPLICATE_INDEX_VERSION } },
      timestamps: false,
    } }));
    // Indexing neither changes canonical facts nor pretends the original record was freshly observed.
    if (operations.length) await this.opportunityModel.bulkWrite(operations, { ordered: false });
    return { indexed: Math.min(rows.length, limit), nextCursor: rows.length > limit ? rows[limit - 1]._id : null };
  }

  async upsertOccurrence(id: string, occurrence: SourceOccurrence, patch: Partial<Opportunity>): Promise<Opportunity> {
    const touchedCanonicalFields = this.touchedCanonicalFields(patch);
    for (let attempt = 0; attempt < OPPORTUNITY_UPSERT_MAX_CAS_ATTEMPTS; attempt += 1) {
      const opportunity = await this.getById(id);
      const existingOccurrences = opportunity.sourceOccurrences ?? [];
      const index = existingOccurrences.findIndex((existing) => this.sameOccurrence(existing, occurrence));
      const hasPrimary = existingOccurrences.some((item) => item.primary);
      const existing = index >= 0 ? existingOccurrences[index] : null;
      const effectivePrimary = existing ? existing.primary : occurrence.primary === true && !hasPrimary;
      const mergedOccurrence: SourceOccurrence = existing
        ? { ...existing, ...occurrence, primary: existing.primary, firstSeenAt: existing.firstSeenAt }
        : { ...occurrence, primary: effectivePrimary };
      const sourceOccurrences = index >= 0
        ? existingOccurrences.map((item, itemIndex) => (itemIndex === index ? mergedOccurrence : item))
        : [...existingOccurrences, mergedOccurrence];
      const canonicalPatch = effectivePrimary ? this.unpinnedCanonicalPatch(opportunity, patch) : {};
      const update: Partial<Opportunity> = {
        ...canonicalPatch,
        firstSeenAt: opportunity.firstSeenAt,
        sourceOccurrences,
        lastSeenAt: occurrence.lastSeenAt,
        duplicateKeys: opportunityDuplicateKeys({ ...opportunity, ...canonicalPatch, sourceOccurrences }),
        duplicateIndexVersion: DUPLICATE_INDEX_VERSION,
      };
      const updated = await this.opportunityModel.findOneAndUpdate(
        { ...this.casFilter(opportunity, touchedCanonicalFields), sourceOccurrences: opportunity.sourceOccurrences ?? [] },
        { $set: update },
        { new: true },
      ).lean();
      if (updated) return updated;
    }
    throw new ConflictException('Opportunity changed while upserting source occurrence');
  }

  async repairRetainedSourceOccurrenceExact(input: RetainedSourceOccurrenceRepairInput): Promise<Opportunity | false> {
    const touchedCanonicalFields = this.touchedCanonicalFields(input.canonicalPatch);
    for (let attempt = 0; attempt < OPPORTUNITY_UPSERT_MAX_CAS_ATTEMPTS; attempt += 1) {
      const opportunity = await this.findById(input.opportunityId);
      if (!opportunity || opportunity.mergedIntoOpportunityId) return false;
      const existingOccurrences = opportunity.sourceOccurrences ?? [];
      const index = existingOccurrences.findIndex((item) =>
        item.sourceId === input.sourceId &&
        item.externalId === input.externalId &&
        item.url === input.url,
      );
      if (index < 0) return false;
      const existing = existingOccurrences[index];
      if (existing.status === 'Removed') return false;
      if (sourceOccurrenceRevision(input.opportunityId, existing) !== input.expectedOccurrenceRevision) return false;
      const repairedOccurrence: SourceOccurrence = {
        ...existing,
        ...(input.occurrencePatch.publishedAt ? { publishedAt: input.occurrencePatch.publishedAt } : {}),
        status: input.occurrencePatch.status,
        normalizedSnapshot: input.occurrencePatch.normalizedSnapshot,
      };
      const sourceOccurrences = existingOccurrences.map((item, itemIndex) => itemIndex === index ? repairedOccurrence : item);
      const canonicalPatch = existing.primary ? this.unpinnedCanonicalPatch(opportunity, input.canonicalPatch) : {};
      const absentNativeFields = ['seniority', 'employmentType', 'location', 'remoteType', 'deadline'];
      const canonicalUnset = Object.fromEntries(Object.entries(canonicalPatch)
        .filter(([field, value]) => value === undefined && absentNativeFields.includes(field))
        .map(([field]) => [field, '']));
      const update: Partial<Opportunity> = {
        ...Object.fromEntries(Object.entries(canonicalPatch).filter(([, value]) => value !== undefined)),
        sourceOccurrences,
        firstSeenAt: opportunity.firstSeenAt,
        lastSeenAt: opportunity.lastSeenAt,
        duplicateKeys: opportunityDuplicateKeys({ ...opportunity, ...canonicalPatch, sourceOccurrences }),
        duplicateIndexVersion: DUPLICATE_INDEX_VERSION,
      };
      const updated = await this.opportunityModel.findOneAndUpdate(
        this.casFilter(opportunity, touchedCanonicalFields),
        { $set: update, ...(Object.keys(canonicalUnset).length ? { $unset: canonicalUnset } : {}) },
        { new: true },
      ).lean();
      if (updated) return updated;
    }
    throw new ConflictException('Opportunity changed while repairing retained source occurrence');
  }

  async markSourceOccurrenceRemovedExact(input: MarkSourceOccurrenceRemovedExactInput): Promise<Opportunity | false> {
    const observedAt = this.validDate(input.observedAt);
    if (!observedAt) return false;
    const opportunity = await this.findById(input.opportunityId);
    if (!opportunity || opportunity.mergedIntoOpportunityId) return false;
    const existingOccurrences = opportunity.sourceOccurrences ?? [];
    const index = existingOccurrences.findIndex((item) =>
      item.sourceId === input.sourceId &&
      item.externalId === input.externalId &&
      item.url === input.url,
    );
    if (index < 0) return false;
    const existing = existingOccurrences[index];
    const alreadyRemoved = existing.status === 'Removed';
    const sourceOccurrences = existingOccurrences.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      return {
        ...item,
        status: 'Removed' as SourceStatus,
        lastSeenAt: this.maxDate(item.lastSeenAt, observedAt),
        sourceMetadata: {
          ...(item.sourceMetadata ?? {}),
          removal: {
            reason: input.reason,
            runId: input.runId,
            observedAt: observedAt.toISOString(),
          },
        },
        normalizedSnapshot: {
          ...(item.normalizedSnapshot ?? {}),
          sourceStatus: 'Removed' as SourceStatus,
        },
      };
    });
    const nextSourceStatus = this.isPinnedCanonicalField('sourceStatus', this.pinnedFields(opportunity))
      ? opportunity.sourceStatus
      : this.canonicalStatusFromOccurrences(sourceOccurrences);
    const nextLastSeenAt = this.maxDate(opportunity.lastSeenAt, observedAt);
    if (alreadyRemoved && opportunity.sourceStatus === nextSourceStatus && new Date(opportunity.lastSeenAt).getTime() === nextLastSeenAt.getTime()) {
      return opportunity;
    }
    const updated = await this.opportunityModel.findOneAndUpdate(
      this.casFilter(opportunity, ['sourceStatus', 'lastSeenAt']),
      { $set: { sourceOccurrences, sourceStatus: nextSourceStatus, lastSeenAt: nextLastSeenAt } },
      { new: true },
    ).lean();
    return updated ?? false;
  }

  private sourceSampleProjection(): Record<string, unknown> {
    return {
      _id: 1,
      type: 1,
      title: 1,
      companyOrClient: 1,
      summary: 1,
      description: 1,
      sourceStatus: 1,
      firstSeenAt: 1,
      lastSeenAt: 1,
      publishedAt: 1,
      deadline: 1,
      skills: 1,
      technologies: 1,
      remoteType: 1,
      location: 1,
      money: 1,
      canonicalTags: 1,
      sourceOccurrence: 1,
    };
  }

  private encodeSourceSampleCursor(item: SourceSampleCandidate): string {
    return Buffer.from(JSON.stringify({ lastSeenAt: item.sourceOccurrence.lastSeenAt, id: item._id }), 'utf8').toString('base64url');
  }

  private decodeSourceSampleCursor(cursor?: string): { lastSeenAt: Date; id: string } | null {
    if (!cursor) return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { lastSeenAt?: string; id?: string };
      if (typeof parsed.id !== 'string') return null;
      const lastSeenAt = parsed.lastSeenAt ? new Date(parsed.lastSeenAt) : null;
      if (!lastSeenAt || !Number.isFinite(lastSeenAt.getTime())) return null;
      return { lastSeenAt, id: parsed.id };
    } catch {
      return null;
    }
  }

  private toFilter(query: OpportunityListQueryDto): Record<string, unknown> {
    const filter: Record<string, unknown> = { mergedIntoOpportunityId: { $exists: false } };
    const and: Record<string, unknown>[] = [];
    const types = query.types?.length ? query.types : query.type ? [query.type] : undefined;
    if (types?.length) filter.type = { $in: types };
    filter.sourceStatus = { $in: this.statuses(query.archive, query.status) };
    if (query.sourceIds?.length) filter['sourceOccurrences.sourceId'] = { $in: query.sourceIds };
    if (query.excludeSourceIds?.length) and.push({ 'sourceOccurrences.sourceId': { $nin: query.excludeSourceIds } });
    const sourceGroups = query.sourceGroups?.length ? query.sourceGroups : query.sourceGroup ? [query.sourceGroup] : undefined;
    if (sourceGroups?.length) {
      const knownSourceGroups = sourceGroups.filter((item) => item !== 'unknown');
      const sourceGroupOr: Record<string, unknown>[] = [];
      if (knownSourceGroups.length) sourceGroupOr.push({ 'sourceOccurrences.sourceMetadata.group': { $in: knownSourceGroups } });
      if (sourceGroups.includes('unknown')) {
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
    if (query.remoteType) filter.remoteType = query.remoteType;
    if (query.skills?.length) filter.skills = { $in: query.skills };
    if (query.technologies?.length) and.push({ $or: [{ technologies: { $in: query.technologies } }, { skills: { $in: query.technologies } }] });
    if (query.seniority) filter.seniority = query.seniority;
    if (query.employmentTypes?.length) filter.employmentType = { $in: query.employmentTypes };
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
    this.addSemanticUnknownFilter(filter, and, 'money.currency', query.currency);
    addMoneyDimensionFilter(filter, and, 'money.period', 'period', query.moneyPeriod);
    addMoneyDimensionFilter(filter, and, 'money.kind', 'kind', query.moneyKind);
    if (query.role) filter.title = query.role;
    if (query.counterpart === 'unknown') and.push({ $or: [{ companyOrClient: { $exists: false } }, { companyOrClient: null }, { companyOrClient: '' }, { companyOrClient: 'unknown' }] });
    else if (query.counterpart) filter.companyOrClient = query.counterpart;
    this.addNumberRange(and, 'money.max', query.moneyMin, query.moneyMax, query.includeMissingMoney);
    this.addDateRange(filter, 'publishedAt', query.publishedFrom, query.publishedTo);
    this.addDateRange(filter, 'firstSeenAt', query.firstSeenFrom, query.firstSeenTo);
    this.addDateRange(filter, 'deadline', query.deadlineFrom, query.deadlineTo);
    this.addDateRange(filter, 'updatedAt', query.updatedFrom, query.updatedTo);
    if (typeof query.hasDeadline === 'boolean') {
      if (query.hasDeadline) and.push({ deadline: { $ne: null, $exists: true } });
      else and.push({ $or: [{ deadline: { $exists: false } }, { deadline: null }] });
    }
    if (query.multipleSources) and.push({ $expr: { $gt: [{ $size: '$sourceOccurrences' }, 1] } });
    if (query.manualOnly || query.importedOnly) filter.importedByUserId = { $exists: true };
    if (query.descriptionContains) {
      const escaped = this.escapeRegex(query.descriptionContains);
      and.push({ description: { $regex: escaped, $options: 'i' } });
    }
    if (query.language) filter.language = query.language;
    if (query.tags?.length) filter.canonicalTags = { $in: query.tags };
    if (query.query) {
      const escaped = this.escapeRegex(query.query);
      and.push({
        $or: [
          { title: { $regex: escaped, $options: 'i' } },
          { companyOrClient: { $regex: escaped, $options: 'i' } },
          { canonicalTags: { $regex: escaped, $options: 'i' } },
          { skills: { $regex: escaped, $options: 'i' } },
          { technologies: { $regex: escaped, $options: 'i' } },
        ],
      });
    }
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

  private statuses(archive?: boolean, explicit?: SourceStatus[]): SourceStatus[] {
    if (explicit?.length) return explicit;
    return archive ? ['Closed', 'Expired', 'Removed'] : ['Active', 'Unknown'];
  }

  private toSort(query: OpportunityListQueryDto): Record<string, 1 | -1> {
    const advanced = this.parseSorts(query.sorts, query.advancedSort);
    if (advanced.length) return this.sortObject(advanced);
    if (query.sort === 'deadline' || query.sort === 'deadline-soon') return { deadline: 1, firstSeenAt: -1, _id: 1 };
    if (query.sort === 'highest-pay') return { 'money.max': -1, firstSeenAt: -1, _id: 1 };
    if (query.sort === 'publishedAt' || query.sort === 'newest') return { publishedAt: -1, firstSeenAt: -1, _id: 1 };
    if (query.sort === 'title') return { title: 1, firstSeenAt: -1, _id: 1 };
    if (query.sort === 'sourceStatus') return { sourceStatus: 1, firstSeenAt: -1, _id: 1 };
    return { firstSeenAt: -1, _id: 1 };
  }

  private addDateRange(filter: Record<string, unknown>, field: string, from?: string, to?: string): void {
    if (!from && !to) return;
    filter[field] = {
      ...(from ? { $gte: new Date(from) } : {}),
      ...(to ? { $lte: new Date(to) } : {}),
    };
  }

  private addNumberRange(and: Record<string, unknown>[], field: string, min?: number, max?: number, includeMissing?: boolean): void {
    if (typeof min !== 'number' && typeof max !== 'number') return;
    const range = {
      ...(typeof min === 'number' ? { $gte: min } : {}),
      ...(typeof max === 'number' ? { $lte: max } : {}),
    };
    const condition = { [field]: range };
    if (includeMissing) {
      and.push({ $or: [condition, { [field]: { $exists: false } }, { [field]: null }] });
    } else {
      and.push(condition);
    }
  }

  private parseSorts(sorts?: OpportunitySortDto[], advancedSort?: string): OpportunitySortDto[] {
    if (sorts?.length) return sorts.slice(0, 4);
    if (!advancedSort) return [];
    try {
      const parsed = JSON.parse(advancedSort) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item): item is OpportunitySortDto =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as OpportunitySortDto).field === 'string' &&
          ((item as OpportunitySortDto).direction === 'asc' || (item as OpportunitySortDto).direction === 'desc'),
        )
        .slice(0, 4);
    } catch {
      return [];
    }
  }

  private sortObject(sorts: OpportunitySortDto[]): Record<string, 1 | -1> {
    const fieldMap: Record<string, string> = {
      newest: 'publishedAt',
      recommended: 'firstSeenAt',
      'best-match': 'firstSeenAt',
      'highest-pay': 'money.max',
      deadline: 'deadline',
      'deadline-soon': 'deadline',
      publishedAt: 'publishedAt',
      firstSeenAt: 'firstSeenAt',
      deadlineAt: 'deadline',
      updatedAt: 'updatedAt',
      moneyMax: 'money.max',
      matchScore: 'firstSeenAt',
      title: 'title',
      sourceStatus: 'sourceStatus',
      highestAI: 'firstSeenAt',
    };
    const result: Record<string, 1 | -1> = {};
    for (const sort of sorts) {
      const mapped = fieldMap[sort.field];
      if (mapped) result[mapped] = sort.direction === 'asc' ? 1 : -1;
    }
    result.firstSeenAt ??= -1;
    result._id = 1;
    return result;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private encodeCursor(item: Opportunity, sort?: string): string {
    const keyDate = sort === 'deadline' || sort === 'deadline-soon' ? item.deadline : item.firstSeenAt;
    return Buffer.from(JSON.stringify({ date: keyDate?.toISOString?.() ?? null, dateIsNull: !keyDate, id: item._id })).toString('base64url');
  }

  private decodeCursor(cursor: string, sort?: string): Record<string, unknown> {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { date?: string | null; dateIsNull?: boolean; id: string };
    const deadlineSort = sort === 'deadline' || sort === 'deadline-soon';
    const field = deadlineSort ? 'deadline' : 'firstSeenAt';
    if (deadlineSort && decoded.dateIsNull) {
      return {
        $or: [
          { deadline: { $exists: false }, _id: { $gt: decoded.id } },
          { deadline: null, _id: { $gt: decoded.id } },
          { deadline: { $ne: null } },
        ],
      };
    }
    if (!decoded.date) return { _id: { $gt: decoded.id } };
    const date = new Date(decoded.date);
    return deadlineSort
      ? { $or: [{ [field]: { $gt: date } }, { [field]: date, _id: { $gt: decoded.id } }] }
      : { $or: [{ [field]: { $lt: date } }, { [field]: date, _id: { $gt: decoded.id } }] };
  }

  private afterCanonicalCursor(cursor: { firstSeenAt?: Date; _id: string }): Record<string, unknown> {
    if (!cursor.firstSeenAt) return { _id: { $gt: cursor._id } };
    const firstSeenAt = new Date(cursor.firstSeenAt);
    return { $or: [{ firstSeenAt: { $lt: firstSeenAt } }, { firstSeenAt, _id: { $gt: cursor._id } }] };
  }


  private canonicalStatusFromOccurrences(occurrences: SourceOccurrence[]): SourceStatus {
    const statuses = occurrences.map((item) => item.status ?? 'Unknown');
    for (const status of ['Active', 'Unknown', 'Closed', 'Expired', 'Removed'] as SourceStatus[]) {
      if (statuses.includes(status)) return status;
    }
    return 'Removed';
  }

  private pinnedFields(opportunity: Opportunity): string[] {
    return (opportunity.adminCorrections ?? [])
      .filter((item) => item.pinned)
      .map((item) => item.field);
  }

  private validDate(value: Date | string): Date | null {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private maxDate(left: Date | string | undefined, right: Date): Date {
    const leftDate = left ? new Date(left) : null;
    if (leftDate && Number.isFinite(leftDate.getTime()) && leftDate.getTime() > right.getTime()) return leftDate;
    return right;
  }

  private touchedCanonicalFields(patch: Partial<Opportunity>): string[] {
    return Object.keys(patch).filter((field) => !OPPORTUNITY_CANONICAL_CONTROL_FIELDS.has(field));
  }

  private unpinnedCanonicalPatch(opportunity: Opportunity, patch: Partial<Opportunity>): Partial<Opportunity> {
    const pinnedFields = this.pinnedFields(opportunity);
    return Object.fromEntries(
      Object.entries(patch).filter(([field]) =>
        !OPPORTUNITY_CANONICAL_CONTROL_FIELDS.has(field) &&
        !this.isPinnedCanonicalField(field, pinnedFields),
      ),
    ) as Partial<Opportunity>;
  }

  private isPinnedCanonicalField(field: string, pinnedFields: string[]): boolean {
    return pinnedFields.some((pinned) => field === pinned || field.startsWith(`${pinned}.`) || pinned.startsWith(`${field}.`));
  }

  private casFilter(opportunity: Opportunity, touchedCanonicalFields: string[]): Record<string, unknown> {
    const filter: Record<string, unknown> = {
      _id: opportunity._id,
      mergedIntoOpportunityId: { $exists: false },
      sourceOccurrences: opportunity.sourceOccurrences ?? [],
      adminCorrections: opportunity.adminCorrections ?? [],
    };
    for (const field of touchedCanonicalFields) {
      const value = this.readPath(opportunity as unknown as Record<string, unknown>, field);
      filter[field] = value === undefined ? { $exists: false } : value;
    }
    return filter;
  }

  private readPath(record: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[key];
    }, record);
  }

  private sameOccurrence(left: SourceOccurrence, right: SourceOccurrence): boolean {
    if (left.sourceId !== right.sourceId) return false;
    if (left.externalId && right.externalId) return left.externalId === right.externalId;
    return left.url === right.url;
  }
}
