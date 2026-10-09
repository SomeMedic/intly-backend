import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo } from 'mongoose';
import { newId } from '../../common/schema';
import { compareDuplicateOpportunities } from './opportunity-deduplication';
import { DUPLICATE_INDEX_VERSION, opportunityDuplicateKeys } from './opportunity-duplicate-keys';
import { mergePersonalStates, mergeSourceOccurrences } from './opportunity-merge';
import type { Opportunity } from './schemas/opportunity.schema';
import type { OpportunityUserState } from './schemas/opportunity-user-state.schema';
import { mergeWatchlistHitMetadata } from '../watchlists/watchlists.repository';
import type { WatchlistHit } from '../watchlists/schemas/watchlist-hit.schema';
import { compareSemanticDuplicateOpportunities, semanticOpportunityFacts } from './opportunity-semantic-duplicates';
import type { SemanticDuplicateEvidence } from './opportunity-semantic-duplicates';
import { duplicateDecisionSnapshot, type DuplicateDecisionSnapshot } from './opportunity-duplicate-decisions';

type Reference = mongo.Document & { _id: string; opportunityId?: string };
type DuplicateDecisionRecord = DuplicateDecisionSnapshot & {
  decision: 'distinct' | 'merge';
  decidedBy: string;
  decidedAt: Date;
  reason?: string;
  targetId?: string;
};
type MergeOptions = {
  actorId?: string;
  automatic?: boolean;
  historicalRunId?: string;
  semanticEvidence?: SemanticDuplicateEvidence;
  session?: mongo.ClientSession;
  expectedDecisionSnapshot?: DuplicateDecisionSnapshot;
  reviewDecision?: DuplicateDecisionRecord;
  reviewResolution?: { reviewId: string; candidateIds: string[]; decidedAt: Date };
};

/** Approved cross-domain reference migration boundary. All Mongo mutations share one transaction. */
@Injectable()
export class OpportunityMergesRepository {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async merge(targetId: string, duplicateId: string, options: MergeOptions = {}): Promise<Opportunity> {
    if (!targetId || targetId === duplicateId) throw new BadRequestException('Choose two different opportunities to merge');
    const database = this.connection.db;
    if (!database) throw new ServiceUnavailableException('Database is not connected');
    if (!options.session) {
      const hello = await database.admin().command({ hello: 1 });
      if (!hello.setName && hello.msg !== 'isdbgrid') throw new ServiceUnavailableException('Safe opportunity merging requires a transaction-capable MongoDB replica set');
    }
    const opportunities = database.collection<Opportunity>('opportunities');
    const ownedSession = options.session ? undefined : await this.connection.startSession();
    const session = options.session ?? ownedSession!;
    const work = async () => {
      // Keep transaction operations sequential: the Mongo driver does not support parallel commands in a transaction.
      const target = await opportunities.findOne({ _id: targetId }, { session });
      const duplicate = await opportunities.findOne({ _id: duplicateId }, { session });
      if (!target || !duplicate) throw new NotFoundException('Opportunity not found');
      if (target.mergedIntoOpportunityId) throw new ConflictException('Merge target is already an alias');
      if (duplicate.mergedIntoOpportunityId === targetId) return target;
      if (duplicate.mergedIntoOpportunityId) throw new ConflictException('Duplicate was already merged into another opportunity');
      if (target.type !== duplicate.type) throw new ConflictException('Opportunities of different types cannot be merged');
      if (options.expectedDecisionSnapshot) {
        const current = duplicateDecisionSnapshot(target, duplicate);
        const expected = options.expectedDecisionSnapshot;
        if (!current || current._id !== expected._id || current.leftHash !== expected.leftHash || current.rightHash !== expected.rightHash) {
          throw new ConflictException('Duplicate review facts changed before merge');
        }
      }
      if (options.automatic) {
        const snapshot = duplicateDecisionSnapshot(target, duplicate);
        if (snapshot) {
          const declined = await database.collection<DuplicateDecisionRecord>('opportunity_duplicate_decisions').findOne({
            _id: snapshot._id,
            decision: 'distinct',
            leftHash: snapshot.leftHash,
            rightHash: snapshot.rightHash,
          }, { session, projection: { _id: 1 } });
          if (declined) throw new ConflictException('Duplicate pair was manually marked distinct');
        }
      }
      const comparison = options.semanticEvidence
        ? compareSemanticDuplicateOpportunities(semanticOpportunityFacts(target), semanticOpportunityFacts(duplicate), options.semanticEvidence)
        : compareDuplicateOpportunities(target, duplicate);
      if (options.automatic && comparison.verdict !== 'duplicate') throw new ConflictException('Duplicate evidence changed before merge');
      // Explicit tender identity conflicts are protected even for a manual merge.
      if (target.type === 'tender' && comparison.verdict === 'distinct') throw new ConflictException('Tender identity conflicts; different lots must remain separate');
      const mergedAt = new Date();
      const references: Record<string, number> = {};
      const states = database.collection<OpportunityUserState>('opportunityuserstates');
      const sourceStates = states.find({ opportunityId: duplicateId, deletedAt: { $exists: false } }, { session });
      for await (const state of sourceStates) {
        const existing = await states.findOne({ opportunityId: targetId, userId: state.userId, profileId: state.profileId, deletedAt: { $exists: false } }, { session });
        if (!existing) {
          await states.updateOne({ _id: state._id }, { $set: { opportunityId: targetId, updatedAt: mergedAt } }, { session });
        } else {
          await states.updateOne({ _id: existing._id }, { $set: { ...mergePersonalStates(existing, state, target.type), updatedAt: mergedAt } }, { session });
          // Retain the complete duplicate personal record for owner-scoped history/recovery.
          await states.updateOne({ _id: state._id }, { $set: { deletedAt: mergedAt, mergedIntoStateId: existing._id, mergedAt } }, { session });
        }
        references.personalStates = (references.personalStates ?? 0) + 1;
      }
      // Unique domain records may contain independently edited business data. Abort atomically instead of discarding one.
      const uniqueRelations = [
        { collection: 'responses', fields: ['userId', 'profileId', 'format'], active: true },
        { collection: 'tenderdocumentlinks', fields: ['userId', 'profileId', 'sourceId', 'sourceUrl'], active: true },
      ];
      for (const relation of uniqueRelations) {
        const collection = database.collection<Reference>(relation.collection);
        const filter = { opportunityId: duplicateId, ...(relation.active ? { deletedAt: { $exists: false } } : {}) };
        for await (const record of collection.find(filter, { session })) {
          // Tender links without a native source URL do not participate in the partial unique index.
          if (relation.collection === 'tenderdocumentlinks' && (record.sourceId === undefined || record.sourceUrl === undefined)) continue;
          const identity = Object.fromEntries(relation.fields.map(field => [field, record[field]]));
          const collision = await collection.findOne({ ...identity, opportunityId: targetId, ...(relation.active ? { deletedAt: { $exists: false } } : {}) }, { session, projection: { _id: 1 } });
          if (collision) throw new ConflictException({ message: 'Duplicate has independent related records that need resolution before merging', code: 'merge_related_record_conflict', domain: relation.collection });
        }
      }
      const hits = database.collection<WatchlistHit>('watchlisthits');
      for await (const hit of hits.find({ opportunityId: duplicateId, supersededByHitId: { $exists: false } }, { session })) {
        const existing = await hits.findOne({ opportunityId: targetId, watchlistId: hit.watchlistId, supersededByHitId: { $exists: false } }, { session });
        if (existing) {
          const patch = mergeWatchlistHitMetadata(existing, hit);
          if (Object.keys(patch.canonicalSet).length) await hits.updateOne({ _id: existing._id }, { $set: patch.canonicalSet }, { session });
          await hits.updateOne({ _id: hit._id }, { $set: patch.supersededSet }, { session });
          await database.collection<Reference>('watchlists').updateOne({ _id: hit.watchlistId, totalHits: { $gt: 0 } }, { $inc: { totalHits: -1 } }, { session });
        } else await hits.updateOne({ _id: hit._id }, { $set: { opportunityId: targetId } }, { session });
        references.watchlisthits = (references.watchlisthits ?? 0) + 1;
      }
      for (const name of ['opportunitycomments', 'issuereports', 'ai_analyses', 'responses', 'tasks', 'calendarevents', 'tenderdocumentlinks']) {
        const moved = await database.collection<Reference>(name).updateMany({ opportunityId: duplicateId }, { $set: { opportunityId: targetId } }, { session });
        references[name] = moved.modifiedCount;
      }
      await database.collection('notifications').updateMany({ 'data.opportunityId': duplicateId }, { $set: { 'data.opportunityId': targetId } }, { session });
      await database.collection('fileassets').updateMany({ 'metadata.opportunityId': duplicateId }, { $set: { 'metadata.opportunityId': targetId } }, { session });
      const sourceOccurrences = mergeSourceOccurrences(target, duplicate);
      const merged: Opportunity = {
        ...target,
        sourceOccurrences,
        canonicalTags: [...new Set([...(target.canonicalTags ?? []), ...(duplicate.canonicalTags ?? [])])],
        firstSeenAt: new Date(Math.min(+new Date(target.firstSeenAt), +new Date(duplicate.firstSeenAt))),
        lastSeenAt: new Date(Math.max(+new Date(target.lastSeenAt), +new Date(duplicate.lastSeenAt))),
      };
      await opportunities.updateOne({ _id: targetId, mergedIntoOpportunityId: { $exists: false } }, { $set: {
        sourceOccurrences: merged.sourceOccurrences, canonicalTags: merged.canonicalTags,
        firstSeenAt: merged.firstSeenAt, lastSeenAt: merged.lastSeenAt, updatedAt: mergedAt,
        duplicateKeys: opportunityDuplicateKeys(merged), duplicateIndexVersion: DUPLICATE_INDEX_VERSION,
      } }, { session });
      await opportunities.updateOne({ _id: duplicateId, mergedIntoOpportunityId: { $exists: false } }, { $set: {
        mergedIntoOpportunityId: targetId, mergedAt, sourceStatus: 'Removed', updatedAt: mergedAt,
      } }, { session });
      await database.collection<Reference>('opportunity_dedup_reviews').updateOne({ _id: duplicateId }, {
        $set: { status: 'superseded', mergedIntoOpportunityId: targetId, checkedAt: mergedAt },
      }, { session });
      if (options.reviewDecision && options.reviewResolution) {
        await database.collection<DuplicateDecisionRecord>('opportunity_duplicate_decisions').updateOne(
          { _id: options.reviewDecision._id },
          { $set: options.reviewDecision },
          { upsert: true, session },
        );
        const review = await database.collection<{ _id: string; review?: Array<{ opportunityId: string }>; checkStartedAt?: Date }>('opportunity_dedup_reviews').findOne({ _id: options.reviewResolution.reviewId }, { session });
        const resolved = new Set(options.reviewResolution.candidateIds);
        const remaining = (review?.review ?? []).filter((item) => !resolved.has(item.opportunityId));
        await database.collection<Reference>('opportunity_dedup_reviews').updateOne({ _id: options.reviewResolution.reviewId }, { $set: {
          status: remaining.length ? 'open' : 'resolved',
          review: remaining,
          checkedAt: options.reviewResolution.decidedAt,
          checkStartedAt: review?.checkStartedAt && review.checkStartedAt > options.reviewResolution.decidedAt ? review.checkStartedAt : options.reviewResolution.decidedAt,
          lastDecisionPairKey: options.reviewDecision._id,
        } }, { session });
      }
      // Private bodies remain in private collections; the shared receipt contains IDs/counters only.
      await database.collection<Reference>('opportunity_merges').insertOne({ _id: duplicateId, targetId, duplicateId, actorId: options.actorId, automatic: options.automatic ?? false, ...(options.historicalRunId ? { historicalRunId: options.historicalRunId } : {}), comparison, references, mergedAt, effectsPending: true }, { session });
      if (options.actorId) await database.collection<Reference>('audit_events').insertOne({ _id: newId(), userId: options.actorId, action: 'opportunity.merge', entityType: 'opportunity', entityId: targetId, fields: ['sourceOccurrences', 'privateReferences'], createdAt: mergedAt, updatedAt: mergedAt }, { session });
      return merged;
    };
    try {
      const result = options.session ? await work() : await session.withTransaction(work, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10_000 });
      if (!result) throw new ConflictException('Opportunity merge did not commit');
      return result;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) throw new ConflictException('Related data changed during merge; no partial merge was saved');
      throw error;
    } finally { if (ownedSession) await ownedSession.endSession(); }
  }
}
