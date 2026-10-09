import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { withCanonicalOpportunity } from './canonical-opportunity-transaction';

import { newId } from '../../common/schema';

import {
  OpportunityUserState,
  OpportunityUserStateDocument,
  PipelineStatus,
} from './schemas/opportunity-user-state.schema';
import { expandPipelineStatusFilterForType, normalizePipelineStatus, pipelineStagesForType } from './pipeline-definitions';
import { OpportunityType } from './schemas/opportunity.schema';

export type ResponseHandoffPayload = {
  format: string;
  latestResponse: Record<string, unknown>;
  updatedAt?: string;
  pipelineStatus?: PipelineStatus | null;
};

export type OpportunityViewPayload = {
  matchScore: number;
  matchComponents: Record<string, number>;
  matchCalculatedAt: Date;
};

type OwnedStateFilter = {
  userId: string;
  opportunityId: string;
  profileId: string;
  deletedAt: { $exists: boolean };
};

@Injectable()
export class OpportunityUserStatesRepository {
  constructor(
    @InjectModel(OpportunityUserState.name)
    private readonly stateModel: Model<OpportunityUserStateDocument>,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async find(userId: string, opportunityId: string, profileId: string): Promise<OpportunityUserState | null> {
    return this.stateModel.findOne({ userId, opportunityId, profileId, deletedAt: { $exists: false } }).lean();
  }

  async findByOpportunity(userId: string, opportunityId: string): Promise<OpportunityUserState[]> {
    return this.stateModel.find({ userId, opportunityId, deletedAt: { $exists: false } }).lean();
  }

  async upsert(input: Partial<OpportunityUserState> & { userId: string; opportunityId: string; profileId: string }): Promise<OpportunityUserState> {
    const now = new Date();
    const targetStatus = input.pipelineStatus ?? null;
    const set = {
      ...this.defaultStateSet(input.userId, input.opportunityId, input.profileId, now),
      ...this.literalStatePatch(input),
      pipelineStatus: targetStatus ?? { $ifNull: ['$pipelineStatus', 'New'] },
      pipelineEvents: this.pipelineEventsAppendPipeline(targetStatus, now),
      updatedAt: now,
    };
    const filter = {
      userId: input.userId,
      opportunityId: input.opportunityId,
      profileId: input.profileId,
      deletedAt: { $exists: false },
    };
    const updated = await this.findOneAndUpdateOwnedState(
      filter,
      [{ $set: set }] as Record<string, unknown>[],
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        updatePipeline: true,
        lean: true,
      } as Record<string, unknown>,
    );
    if (!updated) throw new NotFoundException('Personal opportunity state not found');
    return updated;
  }

  async get(userId: string, opportunityId: string, profileId: string): Promise<OpportunityUserState> {
    const state = await this.find(userId, opportunityId, profileId);
    if (!state) {
      throw new NotFoundException('Personal opportunity state not found');
    }
    return state;
  }

  async recordResponseHandoff(
    userId: string,
    opportunityId: string,
    profileId: string,
    type: OpportunityType,
    payload: ResponseHandoffPayload,
  ): Promise<OpportunityUserState> {
    const now = new Date();
    const actionAt = this.validDate(payload.updatedAt) ?? now;
    const actionAtIso = actionAt.toISOString();
    const latestResponse = { ...payload.latestResponse, format: payload.format, updatedAt: payload.updatedAt ?? actionAtIso };
    const targetStatus = payload.pipelineStatus ?? null;
    const targetRank = targetStatus ? this.pipelineRank(type, targetStatus) : -1;
    const currentRank = this.pipelineRankExpression(type);
    const filter = { userId, opportunityId, profileId, deletedAt: { $exists: false } };
    const updated = await this.findOneAndUpdateOwnedState(
      filter,
      [
        {
          $set: {
            ...this.defaultStateSet(userId, opportunityId, profileId, now),
            pipelineStatus: {
              $cond: [
                { $gt: [targetRank, currentRank] },
                targetStatus ?? '$pipelineStatus',
                { $ifNull: ['$pipelineStatus', 'New'] },
              ],
            },
            responseState: this.responseStatePipeline(payload.format, latestResponse),
            pipelineEvents: this.pipelineEventsPipeline(targetStatus, targetRank, currentRank, actionAt),
            updatedAt: now,
          },
        },
      ] as Record<string, unknown>[],
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        updatePipeline: true,
        lean: true,
        rawResult: false,
        projection: {},
      } as Record<string, unknown>,
    );
    if (!updated) throw new NotFoundException('Personal opportunity state not found');
    return updated;
  }

  async recordView(
    userId: string,
    opportunityId: string,
    profileId: string,
    _type: OpportunityType,
    payload: OpportunityViewPayload,
  ): Promise<OpportunityUserState> {
    const now = new Date();
    const targetStatus: PipelineStatus = 'Reviewed';
    const shouldReview = this.viewShouldReviewExpression();
    const filter = { userId, opportunityId, profileId, deletedAt: { $exists: false } };
    const updated = await this.findOneAndUpdateOwnedState(
      filter,
      [
        {
          $set: {
            ...this.defaultStateSet(userId, opportunityId, profileId, now),
            matchScore: { $cond: [shouldReview, { $literal: payload.matchScore }, '$matchScore'] },
            matchComponents: { $cond: [shouldReview, { $literal: payload.matchComponents }, '$matchComponents'] },
            matchCalculatedAt: { $cond: [shouldReview, { $literal: payload.matchCalculatedAt }, '$matchCalculatedAt'] },
            pipelineStatus: {
              $cond: [
                shouldReview,
                targetStatus,
                { $ifNull: ['$pipelineStatus', 'New'] },
              ],
            },
            pipelineEvents: this.viewPipelineEventsPipeline(shouldReview, now),
            updatedAt: { $cond: [shouldReview, now, '$updatedAt'] },
          },
        },
      ] as Record<string, unknown>[],
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        updatePipeline: true,
        lean: true,
        timestamps: false,
      } as Record<string, unknown>,
    );
    if (!updated) throw new NotFoundException('Personal opportunity state not found');
    return updated;
  }

  async findForList(userId: string, opportunityIds: string[], profileId?: string): Promise<OpportunityUserState[]> {
    return this.stateModel
      .find({
        userId,
        opportunityId: { $in: opportunityIds },
        ...(profileId ? { profileId } : {}),
        deletedAt: { $exists: false },
      })
      .lean();
  }

  async findByUserProfile(userId: string, profileId?: string): Promise<OpportunityUserState[]> {
    return this.stateModel
      .find({
        userId,
        ...(profileId ? { profileId } : {}),
        deletedAt: { $exists: false },
      })
      .sort({ updatedAt: -1, _id: 1 })
      .lean();
  }

  async findByProfileAndStatus(userId: string, profileId: string, statuses: PipelineStatus[]): Promise<OpportunityUserState[]> {
    return this.stateModel
      .find({
        userId,
        profileId,
        pipelineStatus: { $in: statuses },
        deletedAt: { $exists: false },
      })
      .sort({ updatedAt: -1, _id: 1 })
      .lean();
  }

  async findMatchingStates(
    userId: string,
    filters: { profileId?: string; favorite?: boolean; hidden?: boolean; archived?: boolean; minMatch?: number; tags?: string[] },
    projection?: Record<string, number>,
  ): Promise<OpportunityUserState[]> {
    return this.stateModel
      .find({
        userId,
        ...(filters.profileId ? { profileId: filters.profileId } : {}),
        ...(typeof filters.favorite === 'boolean' ? { favorite: filters.favorite } : {}),
        ...(typeof filters.hidden === 'boolean' ? { hidden: filters.hidden } : {}),
        ...(typeof filters.archived === 'boolean' ? { archived: filters.archived } : {}),
        ...(typeof filters.minMatch === 'number' ? { matchScore: { $gte: filters.minMatch } } : {}),
        ...(filters.tags?.length ? { tags: { $in: filters.tags } } : {}),
        deletedAt: { $exists: false },
      }, projection)
      .lean();
  }

  async findMatchingOpportunityIds(
    userId: string,
    filters: { profileId?: string; favorite?: boolean; hidden?: boolean; archived?: boolean; minMatch?: number; pipelineStatuses?: PipelineStatus[]; pipelineReachedStatuses?: PipelineStatus[]; pipelineReachedFrom?: string; pipelineReachedTo?: string; tags?: string[] },
  ): Promise<string[]> {
    const states = await this.findMatchingStates(userId, filters);
    return Array.from(new Set(states.map((state) => state.opportunityId)));
  }

  private defaultStateSet(userId: string, opportunityId: string, profileId: string, now: Date): Record<string, unknown> {
    return {
      _id: { $ifNull: ['$_id', newId()] },
      userId,
      opportunityId,
      profileId,
      favorite: { $ifNull: ['$favorite', false] },
      hidden: { $ifNull: ['$hidden', false] },
      archived: { $ifNull: ['$archived', false] },
      tags: { $ifNull: ['$tags', []] },
      matchScore: { $ifNull: ['$matchScore', 0] },
      matchComponents: { $ifNull: ['$matchComponents', {}] },
      responseState: { $ifNull: ['$responseState', {}] },
      notes: { $ifNull: ['$notes', []] },
      checklist: { $ifNull: ['$checklist', []] },
      pinned: { $ifNull: ['$pinned', false] },
      pipelineEvents: { $ifNull: ['$pipelineEvents', []] },
      createdAt: { $ifNull: ['$createdAt', now] },
    };
  }

  private literalStatePatch(input: Partial<OpportunityUserState>): Record<string, unknown> {
    const reserved = new Set(['_id', 'userId', 'opportunityId', 'profileId', 'pipelineStatus', 'pipelineEvents', 'createdAt', 'updatedAt', 'deletedAt']);
    return Object.fromEntries(
      Object.entries(input)
        .filter(([key, value]) => !reserved.has(key) && value !== undefined)
        .map(([key, value]) => [key, { $literal: value }]),
    );
  }

  private pipelineEventsAppendPipeline(targetStatus: PipelineStatus | null, reachedAt: Date): Record<string, unknown> {
    if (!targetStatus) return { $ifNull: ['$pipelineEvents', []] };
    return {
      $let: {
        vars: { currentEvents: { $ifNull: ['$pipelineEvents', []] } },
        in: {
          $cond: [
            { $in: [targetStatus, { $map: { input: '$$currentEvents', as: 'event', in: '$$event.status' } }] },
            '$$currentEvents',
            { $concatArrays: ['$$currentEvents', [{ status: targetStatus, firstReachedAt: reachedAt }]] },
          ],
        },
      },
    };
  }

  private viewShouldReviewExpression(): Record<string, unknown> {
    return { $eq: [{ $ifNull: ['$pipelineStatus', 'New'] }, 'New'] };
  }

  private viewPipelineEventsPipeline(shouldReview: Record<string, unknown>, reachedAt: Date): Record<string, unknown> {
    return {
      $let: {
        vars: { currentEvents: { $ifNull: ['$pipelineEvents', []] } },
        in: {
          $cond: [
            {
              $and: [
                shouldReview,
                { $not: [{ $in: ['Reviewed', { $map: { input: '$$currentEvents', as: 'event', in: '$$event.status' } }] }] },
              ],
            },
            { $concatArrays: ['$$currentEvents', [{ status: 'Reviewed', firstReachedAt: reachedAt }]] },
            '$$currentEvents',
          ],
        },
      },
    };
  }

  private pipelineRank(type: OpportunityType, status: PipelineStatus): number {
    const stages = pipelineStagesForType(type) as readonly string[];
    const normalized = normalizePipelineStatus(type, status);
    return stages.indexOf(normalized.status);
  }

  private pipelineRankExpression(type: OpportunityType): Record<string, unknown> {
    return {
      $switch: {
        branches: (pipelineStagesForType(type) as readonly string[]).map((status, index) => ({
          case: { $in: ['$pipelineStatus', expandPipelineStatusFilterForType(type, [status])] },
          then: index,
        })),
        default: -1,
      },
    };
  }

  private responseStatePipeline(format: string, latestResponse: Record<string, unknown>): Record<string, unknown> {
    return {
      $let: {
        vars: {
          base: { $cond: [{ $eq: [{ $type: '$responseState' }, 'object'] }, '$responseState', {}] },
          currentLatestUpdatedAt: '$responseState.latestResponse.updatedAt',
          currentFormat: { $getField: { input: '$responseState.byFormat', field: format } },
        },
        in: {
          $mergeObjects: [
            '$$base',
            {
              latestResponse: {
                $cond: [
                  { $gt: [{ $toDate: { $ifNull: ['$$currentLatestUpdatedAt', '1970-01-01T00:00:00.000Z'] } }, { $toDate: String(latestResponse.updatedAt ?? new Date().toISOString()) }] },
                  '$$base.latestResponse',
                  latestResponse,
                ],
              },
              byFormat: {
                $mergeObjects: [
                  { $cond: [{ $eq: [{ $type: '$$base.byFormat' }, 'object'] }, '$$base.byFormat', {}] },
                  {
                    [format]: {
                      $cond: [
                        { $gt: [{ $toDate: { $ifNull: ['$$currentFormat.updatedAt', '1970-01-01T00:00:00.000Z'] } }, { $toDate: String(latestResponse.updatedAt ?? new Date().toISOString()) }] },
                        '$$currentFormat',
                        latestResponse,
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    };
  }

  private pipelineEventsPipeline(targetStatus: PipelineStatus | null, targetRank: number, currentRank: Record<string, unknown>, reachedAt: Date): Record<string, unknown> {
    if (!targetStatus || targetRank < 0) return { $ifNull: ['$pipelineEvents', []] };
    return {
      $let: {
        vars: {
          currentEvents: { $ifNull: ['$pipelineEvents', []] },
          currentRank,
        },
        in: {
          $cond: [
            {
              $and: [
                { $gt: [targetRank, '$$currentRank'] },
                { $not: [{ $in: [targetStatus, { $map: { input: '$$currentEvents', as: 'event', in: '$$event.status' } }] }] },
              ],
            },
            { $concatArrays: ['$$currentEvents', [{ status: targetStatus, firstReachedAt: reachedAt }]] },
            '$$currentEvents',
          ],
        },
      },
    };
  }

  private validDate(value?: Date | string | null): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(+date) ? date : null;
  }

  private async findOneAndUpdateOwnedState(
    filter: OwnedStateFilter,
    update: Record<string, unknown>[],
    options: Record<string, unknown>,
  ): Promise<OpportunityUserState | null> {
    if (this.connection?.db) {
      return withCanonicalOpportunity(this.connection, filter.opportunityId, async (opportunityId, session) => {
        const canonicalFilter = { ...filter, opportunityId };
        const canonicalUpdate = update.map(stage => '$set' in stage ? { ...stage, $set: { ...(stage.$set as Record<string, unknown>), opportunityId: { $literal: opportunityId } } } : stage);
        return this.stateModel.findOneAndUpdate(canonicalFilter, canonicalUpdate, { ...options, session });
      });
    }
    try {
      return await this.stateModel.findOneAndUpdate(filter, update, options);
    } catch (error) {
      if (!this.isOwnedUniqueKeyRace(error, filter)) throw error;
      return this.stateModel.findOneAndUpdate(filter, update, { ...options, upsert: false });
    }
  }

  private isOwnedUniqueKeyRace(
    error: unknown,
    filter: OwnedStateFilter,
  ): boolean {
    if (!error || typeof error !== 'object') return false;
    const duplicate = error as { code?: unknown; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
    if (duplicate.code !== 11000) return false;
    const keyPattern = duplicate.keyPattern ?? {};
    const keyValue = duplicate.keyValue ?? {};
    return Object.keys(keyPattern).length === 3
      && Object.keys(keyValue).length === 3
      && keyPattern.userId === 1
      && keyPattern.opportunityId === 1
      && keyPattern.profileId === 1
      && keyValue.userId === filter.userId
      && keyValue.opportunityId === filter.opportunityId
      && keyValue.profileId === filter.profileId;
  }

}
