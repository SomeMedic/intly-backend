import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';

import { withCanonicalOpportunity } from '../opportunities/canonical-opportunity-transaction';
import { WatchlistHit, WatchlistHitDocument } from './schemas/watchlist-hit.schema';
import { Watchlist, WatchlistDocument } from './schemas/watchlist.schema';


export type WatchlistHitMergePatch = {
  canonicalSet: Partial<WatchlistHit>;
  supersededSet: Partial<WatchlistHit>;
};

const NOTIFICATION_RANK: Record<string, number> = { suppressed_historical: 0, pending: 1, failed: 2, notified: 3 };
const AUTO_AI_RANK: Record<string, number> = { off: 0, eligible: 1, queued: 2, completed: 3 };

export function mergeWatchlistHitMetadata(canonical: WatchlistHit, duplicate: WatchlistHit): WatchlistHitMergePatch {
  const canonicalSet: Partial<WatchlistHit> = {};
  if (duplicate.matchedAt && (!canonical.matchedAt || duplicate.matchedAt < canonical.matchedAt)) canonicalSet.matchedAt = duplicate.matchedAt;
  if (typeof duplicate.matchScore === 'number' && duplicate.matchScore > (canonical.matchScore ?? 0)) canonicalSet.matchScore = duplicate.matchScore;
  if (typeof duplicate.aiScore === 'number' && (typeof canonical.aiScore !== 'number' || duplicate.aiScore > canonical.aiScore)) canonicalSet.aiScore = duplicate.aiScore;
  if (rank(duplicate.notificationState, NOTIFICATION_RANK) > rank(canonical.notificationState, NOTIFICATION_RANK)) canonicalSet.notificationState = duplicate.notificationState;
  if (duplicate.notificationKey && !canonical.notificationKey) canonicalSet.notificationKey = duplicate.notificationKey;
  const notificationKeys = uniqueStrings([...(canonical.notificationKeys ?? []), canonical.notificationKey, ...(duplicate.notificationKeys ?? []), duplicate.notificationKey]);
  if (notificationKeys.length) canonicalSet.notificationKeys = notificationKeys;
  if (rank(duplicate.autoAiState, AUTO_AI_RANK) > rank(canonical.autoAiState, AUTO_AI_RANK)) canonicalSet.autoAiState = duplicate.autoAiState;
  if (duplicate.aiRunId && !canonical.aiRunId) canonicalSet.aiRunId = duplicate.aiRunId;
  const aiRunHistory = uniqueStrings([...(canonical.aiRunHistory ?? []), canonical.aiRunId, ...(duplicate.aiRunHistory ?? []), duplicate.aiRunId]);
  if (aiRunHistory.length) canonicalSet.aiRunHistory = aiRunHistory;
  return { canonicalSet, supersededSet: { supersededByHitId: canonical._id } };
}

function rank(value: string | undefined, table: Record<string, number>): number {
  return typeof value === 'string' ? table[value] ?? 0 : 0;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

@Injectable()
export class WatchlistsRepository {
  constructor(
    @InjectModel(Watchlist.name) private readonly watchlistModel: Model<WatchlistDocument>,
    @InjectModel(WatchlistHit.name) private readonly hitModel: Model<WatchlistHitDocument>,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  listByUser(userId: string): Promise<Watchlist[]> {
    return this.watchlistModel.find({ userId, deletedAt: { $exists: false } }).sort({ updatedAt: -1, _id: 1 }).lean();
  }

  listAll(): Promise<Watchlist[]> {
    return this.watchlistModel.find({ deletedAt: { $exists: false } }).sort({ updatedAt: -1, _id: 1 }).lean();
  }

  listActive(): Promise<Watchlist[]> {
    return this.watchlistModel.find({ active: true, deletedAt: { $exists: false } }).sort({ updatedAt: -1, _id: 1 }).lean();
  }

  findById(id: string): Promise<Watchlist | null> {
    return this.watchlistModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
  }

  async getById(id: string): Promise<Watchlist> {
    const watchlist = await this.findById(id);
    if (!watchlist) throw new NotFoundException('Watchlist not found');
    return watchlist;
  }

  async create(input: Partial<Watchlist>): Promise<Watchlist> {
    const created = await this.watchlistModel.create(input);
    return created.toObject();
  }

  async update(id: string, input: Partial<Watchlist>): Promise<Watchlist> {
    const updated = await this.watchlistModel.findOneAndUpdate({ _id: id, deletedAt: { $exists: false } }, { $set: input }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Watchlist not found');
    return updated;
  }

  async softDelete(id: string): Promise<void> {
    const result = await this.watchlistModel.updateOne({ _id: id, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date(), active: false } });
    if (result.matchedCount === 0) throw new NotFoundException('Watchlist not found');
  }

  listHits(watchlistId: string, limit = 50): Promise<WatchlistHit[]> {
    return this.hitModel.find({ watchlistId, supersededByHitId: { $exists: false } }).sort({ matchedAt: -1, _id: 1 }).limit(limit).lean();
  }

  countAutoAiQueuedSince(watchlistId: string, since: Date): Promise<number> {
    return this.hitModel.countDocuments({ watchlistId, autoAiState: { $in: ['queued', 'completed'] }, matchedAt: { $gte: since } });
  }

  async markAutoAiQueued(hitId: string, aiRunId: string): Promise<void> {
    const hit = await this.hitModel.findOne({ _id: hitId }).lean();
    if (this.connection?.db && hit?.opportunityId) {
      await withCanonicalOpportunity(this.connection, hit.opportunityId, async (_opportunityId, session) => this.markAutoAiQueuedInSession(hitId, aiRunId, session));
      return;
    }
    await this.markAutoAiQueuedInSession(hitId, aiRunId);
  }

  async markNotificationState(hitId: string, notificationState: string): Promise<void> {
    const hit = await this.hitModel.findOne({ _id: hitId }).lean();
    if (this.connection?.db && hit?.opportunityId) {
      await withCanonicalOpportunity(this.connection, hit.opportunityId, async (_opportunityId, session) => this.markNotificationStateInSession(hitId, notificationState, session));
      return;
    }
    await this.markNotificationStateInSession(hitId, notificationState);
  }

  async recordHit(input: Partial<WatchlistHit>): Promise<WatchlistHit & { newlyCreated?: boolean }> {
    if (this.connection?.db && input.opportunityId) {
      const requestedOpportunityId = input.opportunityId;
      try {
        return await withCanonicalOpportunity(this.connection, requestedOpportunityId, async (opportunityId, session) => this.recordCanonicalHit({ ...input, opportunityId }, requestedOpportunityId, session));
      } catch (error) {
        if (!this.isDuplicateKey(error)) throw error;
        return withCanonicalOpportunity(this.connection, requestedOpportunityId, async (opportunityId, session) => this.recordCanonicalHit({ ...input, opportunityId }, requestedOpportunityId, session));
      }
    }
    return this.recordCanonicalHit(input, input.opportunityId);
  }

  private async recordCanonicalHit(input: Partial<WatchlistHit>, requestedOpportunityId?: string, session?: mongo.ClientSession): Promise<WatchlistHit & { newlyCreated?: boolean }> {
    const existing = await this.hitModel.findOne({ watchlistId: input.watchlistId, opportunityId: input.opportunityId, supersededByHitId: { $exists: false } }).session(session ?? null).lean();
    if (existing) {
      if (requestedOpportunityId && requestedOpportunityId !== input.opportunityId) await this.supersedeAliasHit(input.watchlistId, requestedOpportunityId, existing, session);
      return { ...existing, newlyCreated: false };
    }
    if (requestedOpportunityId && requestedOpportunityId !== input.opportunityId) {
      const alias = await this.hitModel.findOne({ watchlistId: input.watchlistId, opportunityId: requestedOpportunityId, supersededByHitId: { $exists: false } }).session(session ?? null).lean();
      if (alias) {
        try {
          const updated = await this.hitModel.findOneAndUpdate(
            { _id: alias._id, opportunityId: requestedOpportunityId, supersededByHitId: { $exists: false } },
            { $set: { opportunityId: input.opportunityId } },
            { new: true, session },
          ).lean();
          if (updated) return { ...updated, newlyCreated: false };
        } catch (error) {
          if (session || !this.isDuplicateKey(error)) throw error;
          const raced = await this.hitModel.findOne({ watchlistId: input.watchlistId, opportunityId: input.opportunityId, supersededByHitId: { $exists: false } }).lean();
          if (!raced) throw error;
          await this.supersedeAliasHit(input.watchlistId, requestedOpportunityId, raced);
          return { ...raced, newlyCreated: false };
        }
      }
    }
    try {
      const [created] = await this.hitModel.create([input], { session });
      await this.watchlistModel.updateOne({ _id: input.watchlistId }, { $inc: { totalHits: 1 }, $set: { lastHitAt: new Date() } }, { session });
      return { ...created.toObject(), newlyCreated: true };
    } catch (error) {
      if (session || !this.isDuplicateKey(error)) throw error;
      const raced = await this.hitModel.findOne({ watchlistId: input.watchlistId, opportunityId: input.opportunityId, supersededByHitId: { $exists: false } }).lean();
      if (!raced) throw error;
      return { ...raced, newlyCreated: false };
    }
  }

  private async supersedeAliasHit(watchlistId: string | undefined, aliasOpportunityId: string, canonical: WatchlistHit, session?: mongo.ClientSession): Promise<void> {
    if (!watchlistId) return;
    const alias = await this.hitModel.findOne({ watchlistId, opportunityId: aliasOpportunityId, supersededByHitId: { $exists: false } }).session(session ?? null).lean();
    if (!alias || alias._id === canonical._id) return;
    const patch = mergeWatchlistHitMetadata(canonical, alias);
    if (Object.keys(patch.canonicalSet).length) await this.hitModel.updateOne({ _id: canonical._id }, { $set: patch.canonicalSet }, { session });
    const superseded = await this.hitModel.updateOne({ _id: alias._id, supersededByHitId: { $exists: false } }, { $set: patch.supersededSet }, { session });
    if ((superseded.modifiedCount ?? superseded.matchedCount ?? 0) > 0) await this.watchlistModel.updateOne({ _id: watchlistId, totalHits: { $gt: 0 } }, { $inc: { totalHits: -1 } }, { session });
  }

  private async markAutoAiQueuedInSession(hitId: string, aiRunId: string, session?: mongo.ClientSession): Promise<void> {
    const hit = await this.hitModel.findOne({ _id: hitId }).session(session ?? null).lean();
    if (!hit) return;
    const hitHistory = uniqueStrings([...(hit.aiRunHistory ?? []), hit.aiRunId, aiRunId]);
    const updatedHit = { ...hit, autoAiState: 'queued', aiRunId, aiRunHistory: hitHistory };
    await this.hitModel.updateOne({ _id: hitId }, { $set: { autoAiState: 'queued', aiRunId, ...(hitHistory.length ? { aiRunHistory: hitHistory } : {}) } }, { session });
    if (hit.supersededByHitId) await this.propagateSupersededHit(hit.supersededByHitId, updatedHit, session);
  }

  private async markNotificationStateInSession(hitId: string, notificationState: string, session?: mongo.ClientSession): Promise<void> {
    const hit = await this.hitModel.findOne({ _id: hitId }).session(session ?? null).lean();
    if (!hit) return;
    const updatedHit = { ...hit, notificationState };
    await this.hitModel.updateOne({ _id: hitId }, { $set: { notificationState } }, { session });
    if (hit.supersededByHitId) await this.propagateSupersededHit(hit.supersededByHitId, updatedHit, session);
  }

  private async propagateSupersededHit(canonicalHitId: string, duplicate: WatchlistHit, session?: mongo.ClientSession): Promise<void> {
    let nextHitId: string | undefined = canonicalHitId;
    let mergedDuplicate = duplicate;
    for (let depth = 0; nextHitId && depth < 20; depth += 1) {
      const canonical: WatchlistHit | null = await this.hitModel.findOne({ _id: nextHitId }).session(session ?? null).lean();
      if (!canonical) return;
      const patch = mergeWatchlistHitMetadata(canonical, mergedDuplicate);
      if (Object.keys(patch.canonicalSet).length) await this.hitModel.updateOne({ _id: canonical._id }, { $set: patch.canonicalSet }, { session });
      mergedDuplicate = { ...canonical, ...patch.canonicalSet };
      nextHitId = canonical.supersededByHitId;
    }
  }

  private isDuplicateKey(error: unknown): boolean {
    return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 11000;
  }
}
