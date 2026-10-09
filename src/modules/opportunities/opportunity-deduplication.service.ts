import { BadRequestException, ConflictException, Injectable, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo } from 'mongoose';
import { JobsService } from '../jobs/jobs.service';
import { compareDuplicateOpportunities } from './opportunity-deduplication';
import { DUPLICATE_INDEX_VERSION } from './opportunity-duplicate-keys';
import { OpportunityMergesRepository } from './opportunity-merges.repository';
import { OpportunitiesRepository } from './opportunities.repository';
import { newId } from '../../common/schema';
import { EmbeddingsService } from '../knowledge/embeddings.service';
import { buildSemanticEmbeddingPlan, compareSemanticDuplicateOpportunities, semanticDuplicateEligibility, semanticOpportunityFacts } from './opportunity-semantic-duplicates';
import type { SemanticComparisonAudit, SemanticDuplicateEvidence, SemanticOpportunityEmbeddingEvidence } from './opportunity-semantic-duplicates';
import type { Opportunity } from './schemas/opportunity.schema';
import { duplicateDecisionSnapshot } from './opportunity-duplicate-decisions';
import { decodeDuplicateReviewCursor, duplicateReviewSearchPattern, encodeDuplicateReviewCursor } from './opportunity-duplicate-review-list';
import type { DuplicateReviewListOptions } from './opportunity-duplicate-review-list';

type IndexState = mongo.Document & { _id: string; status: string; nextCursor?: string | null };
type PendingDuplicate = mongo.Document & { _id: string; revision: string; requestedAt: Date; actorId?: string };
type HistoricalDuplicateRun = mongo.Document & {
  _id: string; version: number; status: 'queued' | 'running' | 'retrying' | 'completed';
  startedAt: Date; nextCursor: string | null; leaseOwner?: string; leaseExpiresAt?: Date;
  scanned: number; merged: number; review: number; missing: number;
};
type DuplicateResult = {
  status: 'index_pending' | 'review_required' | 'completed'; opportunityId: string;
  merged: string[]; review: Array<{ opportunityId: string; reasons: string[]; semantic?: SemanticComparisonAudit }>; candidateSearchComplete: boolean;
};

@Injectable()
export class OpportunityDeduplicationService implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private reconciliationTimer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly opportunities: OpportunitiesRepository,
    private readonly merges: OpportunityMergesRepository,
    private readonly jobs: JobsService,
    @InjectConnection() private readonly connection: Connection,
    @Optional() private readonly embeddings?: EmbeddingsService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler('dedup', 'opportunity.deduplicate', data => this.deduplicate(String(data.opportunityId ?? ''), typeof data.actorId === 'string' ? data.actorId : undefined));
    this.jobs.registerHandler('maintenance', 'opportunity.duplicate-index', data => this.indexPage(typeof data.after === 'string' ? data.after : undefined));
    this.jobs.registerHandler('maintenance', 'opportunity.merge-effects', () => this.reconcileMergeEffects());
    this.jobs.registerHandler('maintenance', 'opportunity.dedup-work', () => this.reconcileDeferredWork());
    this.jobs.registerHandler('dedup', 'opportunity.duplicate-history', data => this.historicalPage(String(data.runId ?? ''), typeof data.after === 'string' ? data.after : undefined));
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.connection.db!.collection('opportunity_merges').createIndex({ historicalRunId: 1 });
    await this.connection.db!.collection('opportunity_dedup_pending').createIndex({ requestedAt: 1, _id: 1 });
    await this.connection.db!.collection('opportunity_dedup_reviews').createIndex({ status: 1, checkedAt: -1 });
    const state = await this.connection.db!.collection<IndexState>('opportunity_dedup_indexes').findOne({ _id: String(DUPLICATE_INDEX_VERSION) });
    if (state?.status !== 'ready') await this.jobs.enqueue('maintenance', 'opportunity.duplicate-index', { after: state?.nextCursor }, { jobId: `duplicate-index:${DUPLICATE_INDEX_VERSION}:${state?.nextCursor ?? 'start'}` });
    await this.enqueueReconciliation();
    this.reconciliationTimer = setInterval(() => { void this.enqueueReconciliation().catch(() => undefined); }, 60_000);
    this.reconciliationTimer.unref();
  }
  onApplicationShutdown(): void { if (this.reconciliationTimer) clearInterval(this.reconciliationTimer); }
  private async enqueueReconciliation() {
    const minute = Math.floor(Date.now() / 60_000);
    await this.jobs.enqueue('maintenance', 'opportunity.merge-effects', {}, { jobId: `merge-effects:${minute}` });
    await this.jobs.enqueue('maintenance', 'opportunity.dedup-work', {}, { jobId: `dedup-work:${DUPLICATE_INDEX_VERSION}:${minute}` });
  }

  async indexPage(after?: string) {
    const result = await this.opportunities.duplicateIndexPage(after);
    await this.connection.db!.collection<IndexState>('opportunity_dedup_indexes').updateOne({ _id: String(DUPLICATE_INDEX_VERSION) }, { $set: {
      status: result.nextCursor ? 'running' : 'ready', nextCursor: result.nextCursor, updatedAt: new Date(),
    } }, { upsert: true });
    if (result.nextCursor) await this.jobs.enqueue('maintenance', 'opportunity.duplicate-index', { after: result.nextCursor }, { jobId: `duplicate-index:${DUPLICATE_INDEX_VERSION}:${result.nextCursor}` });
    else await this.reconcileDeferredWork();
    return result;
  }

  async deduplicate(opportunityId: string, actorId?: string, reconcileEffects = true, historicalRunId?: string): Promise<DuplicateResult> {
    const startedAt = new Date();
    let canonical: Opportunity;
    try { canonical = await this.opportunities.getById(opportunityId); }
    catch (error) {
      if (error instanceof NotFoundException) await this.connection.db!.collection<PendingDuplicate>('opportunity_dedup_pending').deleteOne({ _id: opportunityId, requestedAt: { $lte: startedAt } });
      throw error;
    }
    const indexed = await this.connection.db!.collection<IndexState>('opportunity_dedup_indexes').findOne({ _id: String(DUPLICATE_INDEX_VERSION), status: 'ready' });
    if (!indexed) {
      await this.connection.db!.collection<PendingDuplicate>('opportunity_dedup_pending').updateOne({ _id: opportunityId }, {
        $set: { revision: newId(), requestedAt: startedAt, ...(actorId ? { actorId } : {}) },
        ...(!actorId ? { $unset: { actorId: '' } } : {}),
      }, { upsert: true });
      return { status: 'index_pending', opportunityId: canonical._id, merged: [], review: [], candidateSearchComplete: false };
    }
    const candidates = await this.opportunities.duplicateCandidates(canonical);
    const merged: string[] = [];
    const review: DuplicateResult['review'] = [];
    if (candidates.hasMore) return this.finishDuplicate(opportunityId, startedAt, {
      status: 'review_required', opportunityId: canonical._id, merged,
      review: [{ opportunityId: canonical._id, reasons: ['candidate_limit_reached'] }], candidateSearchComplete: false,
    });
    let declined = await this.declinedCandidateIds(canonical, candidates.items);
    for (const candidate of candidates.items) {
      if (declined.has(candidate._id)) continue;
      let decision = compareDuplicateOpportunities(canonical, candidate);
      let evidence: SemanticDuplicateEvidence | undefined;
      let semantic: SemanticComparisonAudit | undefined;
      const leftFacts = semanticOpportunityFacts(canonical);
      const rightFacts = semanticOpportunityFacts(candidate);
      if (decision.verdict === 'ambiguous' && this.embeddings && semanticDuplicateEligibility(leftFacts, rightFacts).eligible) {
        try {
          evidence = { left: await this.semanticEmbedding(canonical), right: await this.semanticEmbedding(candidate) };
          const semanticDecision = compareSemanticDuplicateOpportunities(leftFacts, rightFacts, evidence);
          semantic = semanticDecision.evidence ?? undefined;
          decision = { ...semanticDecision, level: semanticDecision.level === 'semantic' ? null : semanticDecision.level };
        } catch {
          review.push({ opportunityId: candidate._id, reasons: [...decision.reasons, 'semantic_evidence_unavailable'] });
          continue;
        }
      }
      if (decision.verdict === 'distinct') continue;
      if (decision.verdict === 'ambiguous') { review.push({ opportunityId: candidate._id, reasons: decision.reasons, ...(semantic ? { semantic } : {}) }); continue; }
      const ordered = [canonical, candidate].sort((left, right) => +new Date(left.firstSeenAt) - +new Date(right.firstSeenAt) || left._id.localeCompare(right._id));
      try {
        canonical = await this.merges.merge(ordered[0]._id, ordered[1]._id, {
          automatic: true, actorId, historicalRunId,
          ...(evidence ? { semanticEvidence: ordered[0]._id === canonical._id ? evidence : { left: evidence.right, right: evidence.left } } : {}),
        });
        merged.push(ordered[1]._id);
        // A merge changes relevant provenance; prior decisions cover their exact snapshots only.
        declined = await this.declinedCandidateIds(canonical, candidates.items);
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        // A manual decision may commit after the batch snapshot was read.
        // Honour that decision instead of putting the same pair back in review.
        if ((await this.declinedCandidateIds(canonical, [candidate])).has(candidate._id)) continue;
        review.push({ opportunityId: candidate._id, reasons: ['merge_conflict_requires_review'] });
      }
    }
    if (reconcileEffects) await this.reconcileMergeEffects();
    return this.finishDuplicate(opportunityId, startedAt, { status: review.length ? 'review_required' : 'completed', opportunityId: canonical._id, merged, review, candidateSearchComplete: true });
  }

  private async declinedCandidateIds(opportunity: Opportunity, candidates: Opportunity[]): Promise<Set<string>> {
    if (!candidates.length) return new Set();
    const snapshots = candidates
      .map(candidate => ({ candidateId: candidate._id, snapshot: duplicateDecisionSnapshot(opportunity, candidate) }))
      .filter((item): item is { candidateId: string; snapshot: NonNullable<typeof item.snapshot> } => Boolean(item.snapshot));
    if (!snapshots.length) return new Set();
    const decisions = await this.connection.db!.collection<mongo.Document & { _id: string }>('opportunity_duplicate_decisions').find({
      _id: { $in: snapshots.map(item => item.snapshot._id) }, decision: 'distinct',
    }).toArray();
    const byId = new Map(decisions.map(decision => [String(decision._id), decision]));
    return new Set(snapshots.filter(({ snapshot }) => {
      const decision = byId.get(snapshot._id);
      return decision?.leftHash === snapshot.leftHash && decision.rightHash === snapshot.rightHash;
    }).map(item => item.candidateId));
  }

  private async semanticEmbedding(opportunity: Opportunity): Promise<SemanticOpportunityEmbeddingEvidence> {
    const plan = buildSemanticEmbeddingPlan(semanticOpportunityFacts(opportunity), { passagePrefix: this.embeddings!.passagePrefix() });
    if (!plan) throw new ConflictException('Full semantic embedding plan is unavailable');
    const { title, description, ...metadata } = plan;
    const deadline = Date.now() + 30_000;
    const embed = async (segments: typeof title) => {
      const result: SemanticOpportunityEmbeddingEvidence['title'][number][] = [];
      for (const segment of segments) {
        if (Date.now() > deadline) throw new ConflictException('Full semantic embedding exceeded its execution window');
        const embedding = await this.embeddings!.embedAttestedPassage(segment.text);
        result.push({ index: segment.index, startByte: segment.startByte, endByte: segment.endByte, textHash: segment.textHash, ...embedding });
      }
      return result;
    };
    return { ...metadata, title: await embed(title), description: await embed(description) };
  }

  private async finishDuplicate(originalId: string, startedAt: Date, result: DuplicateResult): Promise<DuplicateResult> {
    const reviews = this.connection.db!.collection<{ _id: string } & mongo.Document>('opportunity_dedup_reviews');
    const currentCheck = { $or: [{ checkStartedAt: { $exists: false } }, { checkStartedAt: { $lte: startedAt } }] };
    if (result.review.length) {
      try {
        await reviews.updateOne({ _id: result.opportunityId, ...currentCheck }, { $set: {
          status: 'open', version: DUPLICATE_INDEX_VERSION, review: result.review,
          candidateSearchComplete: result.candidateSearchComplete, checkStartedAt: startedAt, checkedAt: new Date(),
        } }, { upsert: true });
      } catch (error) {
        // A newer check already wrote this _id. Its result takes precedence.
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 11000) throw error;
      }
    } else await reviews.updateOne({ _id: result.opportunityId, status: 'open', ...currentCheck }, { $set: {
      status: 'resolved', review: [], candidateSearchComplete: result.candidateSearchComplete,
      checkStartedAt: startedAt, checkedAt: new Date(),
    } });
    // Do not erase a newer request that arrived while this check was running.
    await this.connection.db!.collection<PendingDuplicate>('opportunity_dedup_pending').deleteOne({ _id: originalId, requestedAt: { $lte: startedAt } });
    return result;
  }

  async reconcileDeferredWork() {
    const db = this.connection.db!;
    const ready = await db.collection<IndexState>('opportunity_dedup_indexes').findOne({ _id: String(DUPLICATE_INDEX_VERSION), status: 'ready' });
    if (!ready) return { status: 'index_pending', queued: 0 };
    const minute = Math.floor(Date.now() / 60_000);
    const pending = await db.collection<PendingDuplicate>('opportunity_dedup_pending').find({}).sort({ requestedAt: 1, _id: 1 }).limit(100).toArray();
    for (const item of pending) await this.jobs.enqueue('dedup', 'opportunity.deduplicate', {
      opportunityId: item._id, ...(item.actorId ? { actorId: item.actorId } : {}),
    }, { jobId: `duplicate-pending:${item._id}:${item.revision}:${minute}` });
    const runs = db.collection<HistoricalDuplicateRun>('opportunity_dedup_runs');
    await runs.updateOne({ _id: `initial-${DUPLICATE_INDEX_VERSION}` }, { $setOnInsert: {
      version: DUPLICATE_INDEX_VERSION, status: 'queued', startedAt: new Date(), nextCursor: null,
      scanned: 0, merged: 0, review: 0, missing: 0,
    } }, { upsert: true });
    const resumable = await runs.find({ version: DUPLICATE_INDEX_VERSION, status: { $ne: 'completed' },
      $and: [
        { $or: [{ leaseExpiresAt: { $exists: false } }, { leaseExpiresAt: { $lte: new Date() } }] },
        { $or: [{ retryAfter: { $exists: false } }, { retryAfter: { $lte: new Date() } }] },
      ],
    }).limit(10).toArray();
    for (const run of resumable) await this.enqueueHistoricalPage(run._id, run.nextCursor);
    return { status: 'ready', queued: pending.length, historicalRuns: resumable.length };
  }

  private enqueueHistoricalPage(runId: string, after: string | null) {
    return this.jobs.enqueue('dedup', 'opportunity.duplicate-history', { runId, after }, {
      jobId: `duplicate-history:${runId}:${after ?? 'start'}:${Math.floor(Date.now() / 60_000)}`,
    });
  }

  async historicalPage(runId: string, after?: string) {
    const runs = this.connection.db!.collection<HistoricalDuplicateRun>('opportunity_dedup_runs');
    const now = new Date();
    const leaseOwner = newId();
    const run = await runs.findOneAndUpdate({ _id: runId, version: DUPLICATE_INDEX_VERSION,
      status: { $in: ['queued', 'running', 'retrying'] }, nextCursor: after ?? null,
      $and: [
        { $or: [{ leaseExpiresAt: { $exists: false } }, { leaseExpiresAt: { $lte: now } }] },
        { $or: [{ retryAfter: { $exists: false } }, { retryAfter: { $lte: now } }] },
      ],
    }, { $set: { status: 'running', leaseOwner, leaseExpiresAt: new Date(+now + 300_000), updatedAt: now } }, { returnDocument: 'after' });
    if (!run) return { status: 'superseded' };
    try {
      const page = await this.opportunities.duplicateScanPage(run.startedAt, after);
      let cursor = after ?? null;
      for (const item of page.items) {
        let result: DuplicateResult | undefined;
        try { result = await this.deduplicate(item._id, undefined, false, runId); }
        catch (error) { if (!(error instanceof NotFoundException)) throw error; }
        if (result?.status === 'index_pending') throw new ConflictException('Historical deduplication is waiting for the candidate index');
        const progress = await runs.updateOne({ _id: runId, leaseOwner, nextCursor: cursor }, {
          $set: { nextCursor: item._id, updatedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 300_000) },
          $inc: { scanned: 1, review: result?.review.length ? 1 : 0, missing: result ? 0 : 1 },
        });
        if (progress.matchedCount !== 1) throw new ConflictException('Historical deduplication lease changed');
        cursor = item._id;
      }
      await this.reconcileMergeEffects();
      const completed = !page.nextCursor;
      const merged = await this.connection.db!.collection('opportunity_merges').countDocuments({ historicalRunId: runId });
      const released = await runs.updateOne({ _id: runId, leaseOwner }, {
        $set: { status: completed ? 'completed' : 'queued', merged, updatedAt: new Date(), ...(completed ? { finishedAt: new Date() } : {}) },
        $unset: { leaseOwner: '', leaseExpiresAt: '', retryAfter: '', lastError: '' },
      });
      if (released.matchedCount !== 1) throw new ConflictException('Historical deduplication lease changed');
      if (!completed) await this.enqueueHistoricalPage(runId, cursor);
      return { status: completed ? 'completed' : 'queued', runId, scanned: page.items.length, nextCursor: completed ? null : cursor };
    } catch (error) {
      const merged = await this.connection.db!.collection('opportunity_merges').countDocuments({ historicalRunId: runId });
      await runs.updateOne({ _id: runId, leaseOwner }, {
        $set: { status: 'retrying', merged, updatedAt: new Date(), retryAfter: new Date(Date.now() + 60_000), lastError: 'dedup_page_failed' },
        $unset: { leaseOwner: '', leaseExpiresAt: '' }, $inc: { failedAttempts: 1 },
      });
      throw error;
    }
  }

  async historicalStatus() {
    const db = this.connection.db!;
    const [runs, pending, review] = await Promise.all([
      db.collection<HistoricalDuplicateRun>('opportunity_dedup_runs').find({}).sort({ startedAt: -1, _id: 1 }).limit(10).project({ leaseOwner: 0, leaseExpiresAt: 0 }).toArray(),
      db.collection('opportunity_dedup_pending').countDocuments({}),
      db.collection('opportunity_dedup_reviews').countDocuments({ status: 'open' }),
    ]);
    const authoritativeRuns = await Promise.all(runs.map(async run => ({ ...run, merged: await db.collection('opportunity_merges').countDocuments({ historicalRunId: run._id }) })));
    return { runs: authoritativeRuns, pending, review };
  }

  async listReviews(options: DuplicateReviewListOptions = {}) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Duplicate review limit must be between 1 and 100');
    const cursor = decodeDuplicateReviewCursor(options.cursor);
    const query = options.query?.trim() ?? '';
    if (query.length > 200) throw new BadRequestException('Duplicate review query is too long');
    const reviews = this.connection.db!.collection('opportunity_dedup_reviews');
    const joinOpportunity: mongo.Document[] = [
      { $lookup: { from: 'opportunities', localField: '_id', foreignField: '_id', pipeline: [{ $project: {
        _id: 1, type: 1, title: 1, companyOrClient: 1, location: 1, publishedAt: 1,
        'sourceOccurrences.sourceId': 1, 'sourceOccurrences.externalId': 1, 'sourceOccurrences.url': 1,
      } }], as: 'opportunityDocs' } },
      { $set: { opportunity: { $ifNull: [{ $arrayElemAt: ['$opportunityDocs', 0] }, null] } } },
      { $unset: 'opportunityDocs' },
    ];
    const filter: mongo.Document[] = [{ $match: { status: 'open' } }];
    if (query) {
      const pattern = duplicateReviewSearchPattern(query);
      filter.push(...joinOpportunity, { $match: { $or: [
        { _id: { $regex: pattern, $options: 'i' } },
        { 'opportunity.title': { $regex: pattern, $options: 'i' } },
        { 'opportunity.companyOrClient': { $regex: pattern, $options: 'i' } },
      ] } });
    }
    const pagination: mongo.Document[] = cursor ? [{ $match: { $or: [
      { checkedAt: { $lt: cursor.checkedAt } }, { checkedAt: cursor.checkedAt, _id: { $gt: cursor.id } },
    ] } }] : [];
    const [rows, count] = await Promise.all([
      reviews.aggregate<{ _id: string; checkedAt: Date }>([
        ...filter, ...pagination, { $sort: { checkedAt: -1, _id: 1 } }, { $limit: limit + 1 }, ...(!query ? joinOpportunity : []),
      ], { allowDiskUse: true }).toArray(),
      query ? reviews.aggregate<{ total: number }>([...filter, { $count: 'total' }]).toArray().then(rows => rows[0]?.total ?? 0) : reviews.countDocuments({ status: 'open' }),
    ]);
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { items, total: count, nextCursor: hasMore ? encodeDuplicateReviewCursor(items[items.length - 1]) : null, hasMore };
  }

  async requestReviewCheck(opportunityId: string, actorId: string) {
    const opportunity = await this.opportunities.getById(opportunityId);
    const revision = newId();
    await this.connection.db!.collection<PendingDuplicate>('opportunity_dedup_pending').updateOne({ _id: opportunity._id }, {
      $set: { revision, actorId, requestedAt: new Date() },
    }, { upsert: true });
    const jobId = `duplicate-review:${opportunity._id}:${revision}`;
    try {
      await this.jobs.enqueue('dedup', 'opportunity.deduplicate', { opportunityId: opportunity._id, actorId }, { jobId });
      return { accepted: true, queued: true, queuePending: false, opportunityId: opportunity._id, jobId };
    } catch {
      return { accepted: true, queued: false, queuePending: true, opportunityId: opportunity._id };
    }
  }

  async startHistoricalRun(actorId: string) {
    const runId = newId();
    const run = { _id: runId, version: DUPLICATE_INDEX_VERSION, status: 'queued' as const,
      startedAt: new Date(), nextCursor: null, scanned: 0, merged: 0, review: 0, missing: 0, actorId };
    await this.connection.db!.collection<HistoricalDuplicateRun>('opportunity_dedup_runs').insertOne(run);
    // The durable queued run is recovered by reconciliation if Redis is unavailable.
    try { await this.enqueueHistoricalPage(runId, null); }
    catch { return { ...run, queuePending: true }; }
    return { ...run, queuePending: false };
  }

  /** Mongo receipt is the outbox: Redis failure leaves it pending for periodic/startup reconciliation. */
  async reconcileMergeEffects() {
    const receipts = await this.connection.collection('opportunity_merges').find({ effectsPending: true }).limit(100).toArray();
    for (const receipt of receipts) {
      await this.jobs.enqueue('search', 'index-opportunity', { opportunityId: receipt.targetId }, { jobId: `merge:${receipt._id}:search:target` });
      await this.jobs.enqueue('search', 'delete-opportunity', { opportunityId: receipt.duplicateId }, { jobId: `merge:${receipt._id}:search:alias` });
      await this.jobs.enqueue('analytics', 'ingestion_match_all', { opportunityId: receipt.targetId, effectMode: 'historical' }, { jobId: `merge:${receipt._id}:match` });
      await this.connection.collection('opportunity_merges').updateOne({ _id: receipt._id, effectsPending: true }, { $set: { effectsPending: false, effectsQueuedAt: new Date() } });
    }
    return { reconciled: receipts.length };
  }
}
