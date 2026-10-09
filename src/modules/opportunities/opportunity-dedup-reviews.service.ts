import { BadRequestException, ConflictException, Injectable, NotFoundException, OnApplicationBootstrap, Optional, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo } from 'mongoose';

import { Actor } from '../../common/access';
import { newId } from '../../common/schema';
import { ResolveDuplicateReviewDto } from './dto/duplicate-review.dto';
import { duplicateDecisionSnapshot, duplicateReviewToken, DuplicateDecisionSnapshot } from './opportunity-duplicate-decisions';
import { OpportunityDeduplicationService } from './opportunity-deduplication.service';
import { OpportunityMergesRepository } from './opportunity-merges.repository';
import { OpportunitiesRepository } from './opportunities.repository';
import type { Opportunity, SourceOccurrence } from './schemas/opportunity.schema';
import { semanticDuplicateFactHash, semanticOpportunityFacts } from './opportunity-semantic-duplicates';
import type { SemanticComparisonAudit } from './opportunity-semantic-duplicates';

type DedupReviewCandidate = {
  opportunityId: string;
  reasons?: string[];
  semantic?: SemanticComparisonAudit;
};

type DedupReview = mongo.Document & {
  _id: string;
  status: 'open' | 'resolved' | 'superseded';
  review?: DedupReviewCandidate[];
  checkedAt?: Date;
  checkStartedAt?: Date;
  candidateSearchComplete?: boolean;
};

type DuplicateDecisionRecord = DuplicateDecisionSnapshot & {
  decision: 'distinct' | 'merge';
  decidedBy: string;
  decidedAt: Date;
  reason?: string;
  targetId?: string;
};

type Preview = {
  id: string;
  type: Opportunity['type'];
  title: string;
  companyOrClient: string;
  location?: string;
  publishedAt?: Date;
  description: string;
  sourceOccurrences: Array<Pick<SourceOccurrence, 'sourceId' | 'externalId' | 'url'>>;
};

type DetailPair = {
  candidate: Preview;
  reasons: string[];
  semantic?: SemanticComparisonAudit;
  reviewToken: string;
};

@Injectable()
export class OpportunityDedupReviewsService implements OnApplicationBootstrap {
  constructor(
    private readonly opportunities: OpportunitiesRepository,
    private readonly merges: OpportunityMergesRepository,
    @InjectConnection() private readonly connection: Connection,
    @Optional() private readonly deduplication?: OpportunityDeduplicationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const db = this.connection.db;
    if (!db) return;
    await db.collection('opportunity_duplicate_decisions').createIndex({ decision: 1, decidedAt: -1 });
  }

  async get(id: string) {
    const db = this.database();
    const review = await db.collection<DedupReview>('opportunity_dedup_reviews').findOne({ _id: id });
    if (!review) throw new NotFoundException('Duplicate review not found');
    const root = await this.opportunities.getById(id);
    if (review.status !== 'open') return {
      id: review._id,
      status: review.status,
      checkedAt: review.checkedAt,
      candidateSearchComplete: review.candidateSearchComplete === true,
      opportunity: this.preview(root),
      pairs: [],
      unavailableCandidates: [],
    };
    const byCandidate = new Map<string, DedupReviewCandidate>();
    for (const item of review.review ?? []) {
      if (!item?.opportunityId || item.opportunityId === id) continue;
      if (!byCandidate.has(item.opportunityId)) byCandidate.set(item.opportunityId, item);
    }
    const pairs: DetailPair[] = [];
    const unavailableCandidates: string[] = [];
    const seenPairs = new Set<string>();
    for (const item of byCandidate.values()) {
      let candidate: Opportunity;
      try { candidate = await this.opportunities.getById(item.opportunityId); }
      catch { unavailableCandidates.push(item.opportunityId); continue; }
      if (candidate._id === root._id) { unavailableCandidates.push(item.opportunityId); continue; }
      const token = duplicateReviewToken(review._id, root, candidate);
      const snapshot = duplicateDecisionSnapshot(root, candidate);
      if (!token || !snapshot || seenPairs.has(snapshot._id)) continue;
      seenPairs.add(snapshot._id);
      pairs.push({
        candidate: this.preview(candidate),
        reasons: item.reasons ?? [],
        ...(this.currentSemanticAudit(item.semantic, root, candidate) ? { semantic: item.semantic } : {}),
        reviewToken: token,
      });
    }
    return {
      id: review._id,
      status: review.status,
      checkedAt: review.checkedAt,
      candidateSearchComplete: review.candidateSearchComplete === true,
      opportunity: this.preview(root),
      pairs,
      unavailableCandidates,
    };
  }

  async resolve(actor: Actor, id: string, dto: ResolveDuplicateReviewDto) {
    const db = this.database();
    const reviewBefore = await db.collection<DedupReview>('opportunity_dedup_reviews').findOne({ _id: id });
    if (!reviewBefore) throw new NotFoundException('Duplicate review not found');
    const root = await this.opportunities.getById(id);
    const candidate = await this.opportunities.getById(dto.candidateId);
    const reviewMembers = await this.reviewMembersForCandidate(reviewBefore, candidate._id);
    if (!reviewMembers.length) throw new NotFoundException('Duplicate review candidate not found');
    if (root._id === candidate._id) throw new ConflictException('Duplicate pair already points to the same canonical opportunity');
    if (dto.decision === 'merge' && dto.targetId !== root._id && dto.targetId !== candidate._id) {
      throw new BadRequestException('Merge target must be one of the reviewed opportunities');
    }
    const token = duplicateReviewToken(id, root, candidate);
    const snapshot = duplicateDecisionSnapshot(root, candidate);
    if (!token || !snapshot || token !== dto.reviewToken) throw new ConflictException('Duplicate review facts changed');
    const existing = await db.collection<DuplicateDecisionRecord>('opportunity_duplicate_decisions').findOne({ _id: snapshot._id });
    if (existing && existing.leftHash === snapshot.leftHash && existing.rightHash === snapshot.rightHash && existing.decision === dto.decision && existing.targetId === dto.targetId) {
      return { status: 'resolved', decision: existing.decision, pairKey: existing._id, targetId: existing.targetId };
    }
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') throw new ServiceUnavailableException('Duplicate review resolution requires a transaction-capable MongoDB replica set');
    const session = await this.connection.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const reviews = db.collection<DedupReview>('opportunity_dedup_reviews');
        const currentReview = await reviews.findOne({ _id: id }, { session });
        if (!currentReview) throw new NotFoundException('Duplicate review not found');
        if (currentReview.status !== 'open') throw new ConflictException('Duplicate review is already resolved');
        const currentRoot = await db.collection<Opportunity>('opportunities').findOne({ _id: root._id, mergedIntoOpportunityId: { $exists: false } }, { session });
        const currentCandidate = await db.collection<Opportunity>('opportunities').findOne({ _id: candidate._id, mergedIntoOpportunityId: { $exists: false } }, { session });
        if (!currentRoot || !currentCandidate) throw new ConflictException('Duplicate review pair changed');
        if (currentRoot._id === currentCandidate._id) throw new ConflictException('Duplicate pair already points to the same canonical opportunity');
        const currentToken = duplicateReviewToken(id, currentRoot, currentCandidate);
        const currentSnapshot = duplicateDecisionSnapshot(currentRoot, currentCandidate);
        if (!currentToken || !currentSnapshot || currentToken !== dto.reviewToken || currentSnapshot._id !== snapshot._id) {
          throw new ConflictException('Duplicate review facts changed');
        }
        const currentMembers = await this.reviewMembersForCandidate(currentReview, currentCandidate._id, session);
        if (!currentMembers.length) throw new ConflictException('Duplicate review candidate changed');
        const decidedAt = new Date();
        if (dto.decision === 'merge') {
          const targetId = dto.targetId!;
          const duplicateId = targetId === currentRoot._id ? currentCandidate._id : currentRoot._id;
          await this.merges.merge(targetId, duplicateId, {
            actorId: actor.id,
            session,
            expectedDecisionSnapshot: currentSnapshot,
            reviewDecision: this.decisionRecord(currentSnapshot, dto, actor.id, decidedAt),
            reviewResolution: { reviewId: id, candidateIds: currentMembers.map((item) => item.opportunityId), decidedAt },
          });
        } else {
          await this.guardOpportunityPair(currentRoot, currentCandidate, decidedAt, session);
          await db.collection<DuplicateDecisionRecord>('opportunity_duplicate_decisions').updateOne(
            { _id: currentSnapshot._id },
            { $set: this.decisionRecord(currentSnapshot, dto, actor.id, decidedAt) },
            { upsert: true, session },
          );
          await this.applyReviewResolution(reviews, id, currentMembers.map((item) => item.opportunityId), currentSnapshot, decidedAt, session);
          await db.collection<mongo.Document & { _id: string }>('audit_events').insertOne({
            _id: newId(), userId: actor.id, action: 'opportunity.duplicate.distinct', entityType: 'opportunity',
            entityId: id, fields: ['duplicateDecision'], createdAt: decidedAt, updatedAt: decidedAt,
          }, { session });
        }
        return { status: 'resolved', decision: dto.decision, pairKey: currentSnapshot._id, targetId: dto.targetId };
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10_000 });
      if (dto.decision === 'merge') await this.deduplication?.reconcileMergeEffects().catch(() => undefined);
      return result;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) throw new ConflictException('Duplicate review was resolved concurrently');
      throw error;
    } finally {
      await session.endSession();
    }
  }

  private async applyReviewResolution(
    reviews: mongo.Collection<DedupReview>,
    reviewId: string,
    candidateIds: string[],
    snapshot: DuplicateDecisionSnapshot,
    decidedAt: Date,
    session: mongo.ClientSession,
  ) {
    const review = await reviews.findOne({ _id: reviewId }, { session });
    if (!review) throw new NotFoundException('Duplicate review not found');
    const resolved = new Set(candidateIds);
    const remaining = (review.review ?? []).filter((item) => !resolved.has(item.opportunityId));
    const update = await reviews.updateOne({ _id: reviewId }, { $set: {
      status: remaining.length ? 'open' : 'resolved',
      review: remaining,
      checkedAt: decidedAt,
      checkStartedAt: maxDate(review.checkStartedAt, decidedAt),
      lastDecisionPairKey: snapshot._id,
    } }, { session });
    if (update.matchedCount !== 1) throw new ConflictException('Duplicate review changed');
  }

  private decisionRecord(snapshot: DuplicateDecisionSnapshot, dto: ResolveDuplicateReviewDto, decidedBy: string, decidedAt: Date): DuplicateDecisionRecord {
    return {
      ...snapshot,
      decision: dto.decision,
      decidedBy,
      decidedAt,
      ...(dto.reason ? { reason: dto.reason } : {}),
      ...(dto.targetId ? { targetId: dto.targetId } : {}),
    };
  }

  private async guardOpportunityPair(left: Opportunity, right: Opportunity, decidedAt: Date, session: mongo.ClientSession) {
    const collection = this.database().collection<Opportunity>('opportunities');
    for (const opportunity of [left, right]) {
      const filter: Record<string, unknown> = { _id: opportunity._id, mergedIntoOpportunityId: { $exists: false } };
      if ((opportunity as Opportunity & { updatedAt?: Date }).updatedAt) filter.updatedAt = (opportunity as Opportunity & { updatedAt?: Date }).updatedAt;
      const result = await collection.updateOne(filter, { $set: { updatedAt: decidedAt } }, { session });
      if (result.matchedCount !== 1) throw new ConflictException('Duplicate review facts changed');
    }
  }

  private async reviewMembersForCandidate(review: DedupReview, canonicalCandidateId: string, session?: mongo.ClientSession): Promise<DedupReviewCandidate[]> {
    const matches: DedupReviewCandidate[] = [];
    const seen = new Set<string>();
    for (const item of review.review ?? []) {
      if (!item?.opportunityId || seen.has(item.opportunityId)) continue;
      seen.add(item.opportunityId);
      const canonical = await this.resolveCanonicalOpportunity(item.opportunityId, session).catch(() => null);
      if (canonical?._id === canonicalCandidateId) matches.push(item);
    }
    return matches;
  }

  private async resolveCanonicalOpportunity(id: string, session?: mongo.ClientSession): Promise<Opportunity> {
    const collection = this.database().collection<Opportunity>('opportunities');
    const visited = new Set<string>();
    for (let hop = 0; hop < 20; hop += 1) {
      if (visited.has(id)) throw new ConflictException('Opportunity alias cycle');
      visited.add(id);
      const opportunity = await collection.findOne({ _id: id }, { session });
      if (!opportunity) throw new NotFoundException('Opportunity not found');
      if (!opportunity.mergedIntoOpportunityId) return opportunity;
      id = opportunity.mergedIntoOpportunityId;
    }
    throw new ConflictException('Opportunity alias chain exceeds safe depth');
  }

  private preview(opportunity: Opportunity): Preview {
    return {
      id: opportunity._id,
      type: opportunity.type,
      title: opportunity.title,
      companyOrClient: opportunity.companyOrClient,
      ...(opportunity.location ? { location: opportunity.location } : {}),
      ...(opportunity.publishedAt ? { publishedAt: opportunity.publishedAt } : {}),
      description: opportunity.description,
      sourceOccurrences: (opportunity.sourceOccurrences ?? []).map((occurrence) => ({
        sourceId: occurrence.sourceId,
        ...(occurrence.externalId ? { externalId: occurrence.externalId } : {}),
        url: occurrence.url,
      })),
    };
  }

  private currentSemanticAudit(audit: SemanticComparisonAudit | undefined, root: Opportunity, candidate: Opportunity): boolean {
    if (!audit) return false;
    const leftHash = semanticDuplicateFactHash(semanticOpportunityFacts(root));
    const rightHash = semanticDuplicateFactHash(semanticOpportunityFacts(candidate));
    return Boolean(leftHash && rightHash && audit.left.factsHash === leftHash && audit.right.factsHash === rightHash);
  }

  private database() {
    if (!this.connection.db) throw new ServiceUnavailableException('Database is not connected');
    return this.connection.db;
  }
}

function maxDate(left: Date | undefined, right: Date): Date {
  return left && left > right ? left : right;
}
