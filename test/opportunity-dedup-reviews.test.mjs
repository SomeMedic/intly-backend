import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { ConflictException } = require('@nestjs/common');
const { OpportunityDedupReviewsService } = require('../src/modules/opportunities/opportunity-dedup-reviews.service.ts');
const { duplicateDecisionSnapshot, duplicateReviewToken } = require('../src/modules/opportunities/opportunity-duplicate-decisions.ts');
const { OpportunityMergesRepository } = require('../src/modules/opportunities/opportunity-merges.repository.ts');
const { semanticDuplicateFactHash, semanticOpportunityFacts } = require('../src/modules/opportunities/opportunity-semantic-duplicates.ts');

const baseDate = new Date('2026-10-01T00:00:00.000Z');
const sourceOccurrence = id => ({
  sourceId: 'hh',
  externalId: id,
  url: `https://jobs.example/${id}`,
  primary: true,
  firstSeenAt: baseDate,
  lastSeenAt: baseDate,
  status: 'Active',
  rawPayload: { private: true },
  sourceMetadata: { indexKey: 'hidden' },
});
const opportunity = input => ({
  _id: input._id,
  type: 'vacancy',
  title: input.title ?? 'Backend Engineer',
  companyOrClient: input.companyOrClient ?? 'Acme',
  description: input.description ?? 'Build backend services',
  location: 'Remote',
  publishedAt: baseDate,
  firstSeenAt: baseDate,
  lastSeenAt: baseDate,
  updatedAt: input.updatedAt ?? baseDate,
  sourceStatus: 'Active',
  sourceOccurrences: [sourceOccurrence(input._id)],
  canonicalTags: [],
  vacancyData: {},
  freelanceData: {},
  tenderData: {},
  duplicateKeys: [],
  duplicateIndexVersion: 1,
});

function semanticAudit(left, right) {
  return {
    left: { factsHash: semanticDuplicateFactHash(semanticOpportunityFacts(left)) },
    right: { factsHash: semanticDuplicateFactHash(semanticOpportunityFacts(right)) },
    title: { minimum: 1, maximum: 1, weightedMean: 1, left: [], right: [] },
    description: { minimum: 1, maximum: 1, weightedMean: 1, left: [], right: [] },
  };
}

function fixture({ changedCandidate = false, aliasCandidate = false, extraReview = false, reviewStatus = 'open', semantic = false } = {}) {
  const root = opportunity({ _id: '11111111-1111-4111-8111-111111111111' });
  const candidate = opportunity({
    _id: '22222222-2222-4222-8222-222222222222',
    description: changedCandidate ? 'Changed facts' : 'Build backend services',
  });
  const alias = opportunity({ _id: '33333333-3333-4333-8333-333333333333' });
  alias.mergedIntoOpportunityId = candidate._id;
  const unrelated = opportunity({ _id: '44444444-4444-4444-8444-444444444444', title: 'Frontend Engineer' });
  const review = [{ opportunityId: aliasCandidate ? alias._id : candidate._id, reasons: ['text_candidate_requires_review'], ...(semantic ? { semantic: semanticAudit(root, candidate) } : {}) }];
  if (aliasCandidate) review.push({ opportunityId: candidate._id, reasons: ['same_canonical_alias'] });
  if (extraReview) review.push({ opportunityId: unrelated._id, reasons: ['other_candidate'] });
  const rows = new Map([
    ['opportunities', [root, candidate, alias, unrelated]],
    ['opportunity_dedup_reviews', [{
      _id: root._id,
      status: reviewStatus,
      checkedAt: baseDate,
      checkStartedAt: new Date('2026-10-01T00:00:00.000Z'),
      candidateSearchComplete: true,
      review,
    }]],
    ['opportunity_duplicate_decisions', []],
    ['opportunity_merges', []],
    ['audit_events', []],
  ]);
  const collection = name => new InMemoryCollection(rows.get(name) ?? (rows.set(name, []), rows.get(name)), name);
  const db = { collection, admin: () => ({ command: async () => ({ setName: 'test-rs' }) }) };
  const sessions = [];
  const connection = {
    db,
    async startSession() {
      const session = {
        committed: false,
        ended: false,
        async withTransaction(callback) { const value = await callback(); this.committed = true; return value; },
        async endSession() { this.ended = true; },
      };
      sessions.push(session);
      return session;
    },
  };
  const repo = {
    async getById(id) {
      const record = rows.get('opportunities').find(item => item._id === id);
      if (!record) throw new Error('not found');
      return record.mergedIntoOpportunityId ? this.getById(record.mergedIntoOpportunityId) : record;
    },
  };
  const mergeCalls = [];
  const merges = {
    async merge(...args) {
      mergeCalls.push(args);
      const [targetId, duplicateId, options] = args;
      rows.get('opportunities').find(item => item._id === duplicateId).mergedIntoOpportunityId = targetId;
      if (options.reviewDecision) {
        await db.collection('opportunity_duplicate_decisions').updateOne({ _id: options.reviewDecision._id }, { $set: options.reviewDecision }, { upsert: true, session: options.session });
      }
      if (options.reviewResolution) {
        await db.collection('opportunity_dedup_reviews').updateOne({ _id: options.reviewResolution.reviewId }, { $set: { status: 'resolved', review: [], checkStartedAt: options.reviewResolution.decidedAt, checkedAt: options.reviewResolution.decidedAt } }, { session: options.session });
      }
      return rows.get('opportunities').find(item => item._id === targetId);
    },
  };
  const reconciled = [];
  const service = new OpportunityDedupReviewsService(repo, merges, connection, { reconcileMergeEffects: async () => { reconciled.push(true); } });
  return { service, rows, root, candidate, alias, unrelated, sessions, mergeCalls, reconciled, connectionDb: db };
}

test('detail returns public previews, deduped candidate pair and a current review token', async () => {
  const f = fixture();

  const detail = await f.service.get(f.root._id);

  assert.equal(detail.id, f.root._id);
  assert.equal(detail.pairs.length, 1);
  assert.equal(detail.pairs[0].candidate.id, f.candidate._id);
  assert.match(detail.pairs[0].reviewToken, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(detail.pairs[0].candidate.sourceOccurrences[0]).sort(), ['externalId', 'sourceId', 'url']);
});

test('detail includes semantic audit only when it matches current root and candidate facts', async () => {
  const f = fixture({ semantic: true });

  const detail = await f.service.get(f.root._id);

  assert.equal(detail.pairs.length, 1);
  assert.equal(detail.pairs[0].semantic.left.factsHash, semanticDuplicateFactHash(semanticOpportunityFacts(f.root)));
  assert.equal(detail.pairs[0].semantic.right.factsHash, semanticDuplicateFactHash(semanticOpportunityFacts(f.candidate)));
});

test('stale semantic audit is hidden while preview and token stay current', async () => {
  const f = fixture({ semantic: true });
  f.candidate.title = 'Backend Platform Engineer';
  f.candidate.description = 'Changed full body after the review audit was written';
  f.candidate.sourceOccurrences = [{ ...f.candidate.sourceOccurrences[0], externalId: 'changed-native-id' }];

  const detail = await f.service.get(f.root._id);

  assert.equal(detail.pairs.length, 1);
  assert.equal(detail.pairs[0].semantic, undefined);
  assert.equal(detail.pairs[0].candidate.title, 'Backend Platform Engineer');
  assert.equal(detail.pairs[0].candidate.description, 'Changed full body after the review audit was written');
  assert.equal(detail.pairs[0].candidate.sourceOccurrences[0].externalId, 'changed-native-id');
  assert.equal(detail.pairs[0].reviewToken, duplicateReviewToken(f.root._id, f.root, f.candidate));
});

test('stale token rejects before writing decisions or audit records', async () => {
  const f = fixture({ changedCandidate: true });

  await assert.rejects(() => f.service.resolve({ id: 'admin-1', role: 'Admin' }, f.root._id, {
    candidateId: f.candidate._id,
    decision: 'distinct',
    reviewToken: '0'.repeat(64),
  }), ConflictException);

  assert.equal(f.rows.get('opportunity_duplicate_decisions').length, 0);
  assert.equal(f.rows.get('audit_events').length, 0);
  assert.equal(f.rows.get('opportunity_dedup_reviews')[0].status, 'open');
});

test('distinct decision stores pair snapshot and advances checkStartedAt atomically', async () => {
  const f = fixture();
  const token = duplicateReviewToken(f.root._id, f.root, f.candidate);

  const result = await f.service.resolve({ id: 'admin-1', role: 'Admin' }, f.root._id, {
    candidateId: f.candidate._id,
    decision: 'distinct',
    reviewToken: token,
    reason: 'Different role',
  });

  const decision = f.rows.get('opportunity_duplicate_decisions')[0];
  const review = f.rows.get('opportunity_dedup_reviews')[0];
  assert.equal(result.decision, 'distinct');
  assert.equal(decision.decision, 'distinct');
  assert.equal(decision.reason, 'Different role');
  assert.equal(review.status, 'resolved');
  assert.equal(review.review.length, 0);
  assert.ok(review.checkStartedAt > baseDate);
  assert.equal(f.rows.get('audit_events')[0].action, 'opportunity.duplicate.distinct');
  assert.equal(+f.rows.get('opportunities').find(item => item._id === f.root._id).updatedAt, +review.checkStartedAt);
  assert.equal(+f.rows.get('opportunities').find(item => item._id === f.candidate._id).updatedAt, +review.checkStartedAt);
  assert.equal(f.sessions[0].committed, true);
});

test('canonical alias resolve accepts preview id and removes all raw candidates for that canonical pair only', async () => {
  const f = fixture({ aliasCandidate: true, extraReview: true });
  const detail = await f.service.get(f.root._id);
  const token = duplicateReviewToken(f.root._id, f.root, f.candidate);

  assert.equal(detail.pairs.length, 2);
  assert.equal(detail.pairs[0].candidate.id, f.candidate._id);
  await f.service.resolve({ id: 'admin-1', role: 'Admin' }, f.root._id, {
    candidateId: f.candidate._id,
    decision: 'distinct',
    reviewToken: token,
  });

  const review = f.rows.get('opportunity_dedup_reviews')[0];
  assert.equal(review.status, 'open');
  assert.deepEqual(review.review.map(item => item.opportunityId), [f.unrelated._id]);
});

test('resolved review detail is read-only and resolve returns conflict without new writes', async () => {
  const f = fixture({ reviewStatus: 'resolved' });
  const token = duplicateReviewToken(f.root._id, f.root, f.candidate);

  const detail = await f.service.get(f.root._id);
  await assert.rejects(() => f.service.resolve({ id: 'admin-1', role: 'Admin' }, f.root._id, {
    candidateId: f.candidate._id,
    decision: 'distinct',
    reviewToken: token,
  }), ConflictException);

  assert.equal(detail.status, 'resolved');
  assert.deepEqual(detail.pairs, []);
  assert.equal(f.rows.get('opportunity_duplicate_decisions').length, 0);
  assert.equal(f.rows.get('audit_events').length, 0);
});

test('merge decision delegates to merge repository with the same session and durable decision', async () => {
  const f = fixture();
  const token = duplicateReviewToken(f.root._id, f.root, f.candidate);

  const result = await f.service.resolve({ id: 'admin-1', role: 'Admin' }, f.root._id, {
    candidateId: f.candidate._id,
    decision: 'merge',
    targetId: f.root._id,
    reviewToken: token,
  });

  const [, duplicateId, options] = f.mergeCalls[0];
  assert.equal(result.decision, 'merge');
  assert.equal(duplicateId, f.candidate._id);
  assert.equal(options.session, f.sessions[0]);
  assert.equal(options.reviewDecision.decision, 'merge');
  assert.equal(options.reviewDecision.targetId, f.root._id);
  assert.equal(options.reviewResolution.reviewId, f.root._id);
  assert.equal(f.reconciled.length, 1);
});

test('automatic merge rejects an unchanged manual distinct decision without partial writes', async () => {
  const f = fixture();
  const snapshot = duplicateDecisionSnapshot(f.root, f.candidate);
  f.rows.get('opportunity_duplicate_decisions').push({ ...snapshot, decision: 'distinct', decidedBy: 'admin-1', decidedAt: new Date() });
  const mergeRepo = new OpportunityMergesRepository({
    db: f.connectionDb,
    async startSession() {
      return { async withTransaction(callback) { return callback(); }, async endSession() {} };
    },
  });

  await assert.rejects(() => mergeRepo.merge(f.root._id, f.candidate._id, { automatic: true }), /manually marked distinct/);

  assert.equal(f.rows.get('opportunities').find(item => item._id === f.candidate._id).mergedIntoOpportunityId, undefined);
  assert.equal((f.rows.get('opportunity_merges') ?? []).length, 0);
});

class InMemoryCollection {
  constructor(rows, name) { this.rows = rows; this.name = name; }
  async createIndex() { return `${this.name}_idx`; }
  async findOne(filter = {}) { return this.rows.find(row => matches(row, filter)) ?? null; }
  async insertOne(row) { this.rows.push(row); return { insertedId: row._id }; }
  async updateOne(filter, update, options = {}) {
    let row = this.rows.find(item => matches(item, filter));
    if (!row && options.upsert) { row = { ...extractEquality(filter) }; this.rows.push(row); }
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(row, update);
    return { matchedCount: 1, modifiedCount: 1 };
  }
  find(filter = {}) {
    let rows = this.rows.filter(row => matches(row, filter));
    const chain = {
      async *[Symbol.asyncIterator]() { for (const row of rows) yield row; },
      limit(count) { rows = rows.slice(0, count); return chain; },
      project() { return chain; },
      sort() { return chain; },
      toArray: async () => rows,
    };
    return chain;
  }
  async updateMany(filter, update) {
    let modifiedCount = 0;
    for (const row of this.rows) {
      if (!matches(row, filter)) continue;
      applyUpdate(row, update);
      modifiedCount += 1;
    }
    return { modifiedCount };
  }
}

function matches(row, filter) {
  return Object.entries(filter ?? {}).every(([field, expected]) => {
    if (field === '$and') return expected.every(condition => matches(row, condition));
    if (field === '$or') return expected.some(condition => matches(row, condition));
    return matchesValue(row[field], expected);
  });
}

function matchesValue(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    if ('$exists' in expected && (actual !== undefined) !== expected.$exists) return false;
    if ('$in' in expected && !expected.$in.some(value => Object.is(actual, value))) return false;
    return Object.entries(expected).every(([key]) => key.startsWith('$'));
  }
  return Object.is(actual, expected);
}

function applyUpdate(row, update) {
  Object.assign(row, update.$set ?? {});
  for (const key of Object.keys(update.$unset ?? {})) delete row[key];
}

function extractEquality(filter) {
  return Object.fromEntries(Object.entries(filter).filter(([, value]) => !(value && typeof value === 'object' && !Array.isArray(value))));
}
