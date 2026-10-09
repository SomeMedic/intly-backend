import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');
const { OpportunityDeduplicationService } = require('../src/modules/opportunities/opportunity-deduplication.service.ts');
const { duplicateDecisionSnapshot } = require('../src/modules/opportunities/opportunity-duplicate-decisions.ts');

const opportunity = {
  _id: 'canonical',
  type: 'vacancy',
  title: 'Backend Engineer',
  companyOrClient: 'Acme',
  description: 'Build backend services for a product team with reliable APIs and databases.',
  location: 'Remote',
  publishedAt: new Date('2026-10-01T00:00:00.000Z'),
  firstSeenAt: new Date('2026-10-01T00:00:00.000Z'),
  sourceOccurrences: [{ sourceId: 'hh', externalId: 'native-1', url: 'https://jobs.example/canonical' }],
};

function fixture({ ready = true, hasMore = false, items = [], receipts = [], failAt, pending = [], runs = [], scanPages = [], deduplicateImpl } = {}) {
  const merges = [], queued = [];
  const collections = new Map();
  const collection = (name) => {
    if (!collections.has(name)) collections.set(name, new InMemoryCollection(name, initialRows(name, { ready, receipts, pending, runs })));
    return collections.get(name);
  };
  const repo = {
    getById: async () => opportunity,
    duplicateCandidates: async () => ({ items, hasMore }),
    duplicateScanPage: async (_startedAt, after) => scanPages.find((page) => (page.after ?? null) === (after ?? null))?.result ?? { items: [], nextCursor: null },
  };
  const merge = { merge: async (...args) => { merges.push(args); return { ...opportunity, _id: args[0] }; } };
  const jobs = {
    enqueue: async (...args) => {
      queued.push(args);
      if (queued.length === failAt) throw new Error('Redis unavailable');
    },
    registerHandler: () => undefined,
  };
  const connection = { db: { collection }, collection };
  const service = new OpportunityDeduplicationService(repo, merge, jobs, connection);
  if (deduplicateImpl) service.deduplicate = deduplicateImpl;
  return { service, merges, queued, collections, collection };
}

function initialRows(name, { ready, receipts, pending, runs }) {
  if (name === 'opportunity_dedup_indexes') return ready ? [{ _id: '1', status: 'ready' }] : [];
  if (name === 'opportunity_merges') return receipts.map((item) => ({ ...item }));
  if (name === 'opportunity_dedup_pending') return pending.map((item) => ({ ...item }));
  if (name === 'opportunity_dedup_runs') return runs.map((item) => ({ ...item }));
  return [];
}

test('an incomplete candidate index cannot authorize an automatic merge and persists pending work', async () => {
  const f = fixture({ ready: false });

  const result = await f.service.deduplicate('canonical', 'user-1');

  assert.equal(result.status, 'index_pending');
  assert.equal(result.candidateSearchComplete, false);
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.queued, []);
  const pending = f.collection('opportunity_dedup_pending').rows;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]._id, 'canonical');
  assert.equal(pending[0].actorId, 'user-1');
  assert.ok(pending[0].revision);
  assert.ok(pending[0].requestedAt instanceof Date);
});

test('candidate overflow stops before any partial automatic consolidation and opens review', async () => {
  const f = fixture({ hasMore: true, items: [opportunity] });

  const result = await f.service.deduplicate('canonical');

  assert.equal(result.status, 'review_required');
  assert.equal(result.candidateSearchComplete, false);
  assert.deepEqual(result.review[0].reasons, ['candidate_limit_reached']);
  assert.deepEqual(f.merges, []);
  const reviews = f.collection('opportunity_dedup_reviews').rows;
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, 'open');
  assert.deepEqual(reviews[0].review[0].reasons, ['candidate_limit_reached']);
});

test('sparse evidence produces review without touching personal or canonical records', async () => {
  const f = fixture({ items: [{ ...opportunity, _id: 'candidate', description: '', publishedAt: null, sourceOccurrences: [] }] });

  const result = await f.service.deduplicate('canonical');

  assert.equal(result.status, 'review_required');
  assert.equal(result.review[0].opportunityId, 'candidate');
  assert.deepEqual(f.merges, []);
  assert.equal(f.collection('opportunity_dedup_reviews').rows[0].status, 'open');
});

test('Redis failure retains the durable receipt; reconciliation retries identical jobs', async () => {
  const receipt = { _id: 'alias', targetId: 'canonical', duplicateId: 'alias', effectsPending: true };
  const failing = fixture({ receipts: [receipt], failAt: 2 });
  await assert.rejects(failing.service.reconcileMergeEffects(), /Redis unavailable/);
  assert.equal(failing.collection('opportunity_merges').rows[0].effectsPending, true);

  const recovered = fixture({ receipts: [receipt] });
  await recovered.service.reconcileMergeEffects();

  assert.deepEqual(recovered.queued.slice(0, 2), failing.queued);
  assert.deepEqual(recovered.queued.map(call => [call[0], call[1]]), [['search', 'index-opportunity'], ['search', 'delete-opportunity'], ['analytics', 'ingestion_match_all']]);
  assert.equal(recovered.queued[2][2].effectMode, 'historical');
  assert.equal(recovered.collection('opportunity_merges').rows[0].effectsPending, false);
  assert.ok(recovered.collection('opportunity_merges').rows[0].effectsQueuedAt instanceof Date);
});

test('pending reconciliation survives Redis failure and retries the same durable request', async () => {
  const pending = [{ _id: 'canonical', revision: 'rev-1', requestedAt: new Date('2026-10-01T00:00:00.000Z'), actorId: 'user-1' }];
  const failing = fixture({ pending, failAt: 1 });

  await assert.rejects(failing.service.reconcileDeferredWork(), /Redis unavailable/);
  assert.equal(failing.collection('opportunity_dedup_pending').rows.length, 1);

  const recovered = fixture({ pending });
  const result = await recovered.service.reconcileDeferredWork();

  assert.equal(result.status, 'ready');
  assert.equal(result.queued, 1);
  assert.deepEqual(recovered.queued[0].slice(0, 3), ['dedup', 'opportunity.deduplicate', { opportunityId: 'canonical', actorId: 'user-1' }]);
  assert.match(recovered.queued[0][3].jobId, /^duplicate-pending:canonical:rev-1:/);
});

test('finishing a deduplication does not delete a newer pending request', async () => {
  const newer = { _id: 'canonical', revision: 'newer', requestedAt: new Date(Date.now() + 60_000), actorId: 'user-2' };
  const f = fixture({ pending: [newer] });

  const result = await f.service.deduplicate('canonical');

  assert.equal(result.status, 'completed');
  assert.equal(f.collection('opportunity_dedup_pending').rows.length, 1);
  assert.equal(f.collection('opportunity_dedup_pending').rows[0].revision, 'newer');
});

test('an Admin declined pair stays separate across repeated automatic checks of unchanged facts', async () => {
  const candidate = { ...opportunity, _id: 'declined-candidate', sourceOccurrences: [{ sourceId: 'other', externalId: 'native-2', url: 'https://jobs.example/second' }] };
  const f = fixture({ items: [candidate] });
  f.collection('opportunity_duplicate_decisions').rows.push({ ...duplicateDecisionSnapshot(opportunity, candidate), decision: 'distinct' });
  const first = await f.service.deduplicate('canonical');
  const second = await f.service.deduplicate('canonical');
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.equal(f.merges.length, 0);
  assert.equal(f.collection('opportunity_dedup_reviews').rows.length, 0);
});

test('a declined snapshot does not suppress a pair whose relevant facts changed later', async () => {
  const old = { ...opportunity, _id: 'changed-candidate', description: 'Different duties before the listing was updated.' };
  const candidate = { ...opportunity, _id: old._id, sourceOccurrences: [{ sourceId: 'other', externalId: 'native-2', url: 'https://jobs.example/second' }] };
  const f = fixture({ items: [candidate] });
  f.collection('opportunity_duplicate_decisions').rows.push({ ...duplicateDecisionSnapshot(opportunity, old), decision: 'distinct' });
  const result = await f.service.deduplicate('canonical');
  assert.equal(result.status, 'review_required');
  assert.ok(result.review.some(item => item.opportunityId === candidate._id));
});

test('a review recheck survives Redis failure as durable pending and retains actor context', async () => {
  const f = fixture({ failAt: 1 });
  const result = await f.service.requestReviewCheck('canonical', 'admin-actor');
  assert.deepEqual(result, { accepted: true, queued: false, queuePending: true, opportunityId: 'canonical' });
  const pending = f.collection('opportunity_dedup_pending').rows[0];
  assert.equal(pending.actorId, 'admin-actor');
  assert.ok(pending.revision && pending.requestedAt instanceof Date);
});

test('a completed recheck removes old actionable pairs while retaining newer review results', async () => {
  const f = fixture();
  const review = { _id: 'canonical', status: 'open', review: [{ opportunityId: 'old-candidate' }], checkStartedAt: new Date(0) };
  f.collection('opportunity_dedup_reviews').rows.push(review);
  await f.service.deduplicate('canonical');
  assert.equal(review.status, 'resolved');
  assert.deepEqual(review.review, []);
  review.status = 'open';
  review.review = [{ opportunityId: 'newer-candidate' }];
  review.checkStartedAt = new Date(Date.now() + 60_000);
  await f.service.deduplicate('canonical');
  assert.equal(review.status, 'open');
  assert.deepEqual(review.review, [{ opportunityId: 'newer-candidate' }]);
});

class InMemoryCollection {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows;
    this.calls = [];
  }

  async findOne(filter = {}) {
    return this.rows.find((row) => matches(row, filter)) ?? null;
  }

  find(filter = {}) {
    let rows = this.rows.filter((row) => matches(row, filter));
    const chain = {
      sort: (sortSpec) => { rows = rows.slice().sort((left, right) => compareRows(left, right, sortSpec)); return chain; },
      limit: (count) => { rows = rows.slice(0, count); return chain; },
      project: () => chain,
      toArray: async () => rows.map((row) => row),
    };
    return chain;
  }

  async countDocuments(filter = {}) {
    return this.rows.filter((row) => matches(row, filter)).length;
  }

  async updateOne(filter, update, options = {}) {
    this.calls.push({ method: 'updateOne', filter, update, options });
    let row = this.rows.find((item) => matches(item, filter));
    if (!row && options.upsert) {
      row = { ...extractEquality(filter) };
      this.rows.push(row);
    }
    if (!row) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    applyUpdate(row, update);
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    this.calls.push({ method: 'findOneAndUpdate', filter, update, options });
    const row = this.rows.find((item) => matches(item, filter));
    if (!row) return null;
    applyUpdate(row, update);
    return options.returnDocument === 'after' ? row : null;
  }

  async deleteOne(filter) {
    this.calls.push({ method: 'deleteOne', filter });
    const index = this.rows.findIndex((row) => matches(row, filter));
    if (index === -1) return { deletedCount: 0 };
    this.rows.splice(index, 1);
    return { deletedCount: 1 };
  }
}

function matches(row, filter) {
  return Object.entries(filter ?? {}).every(([field, expected]) => {
    if (field === '$and') return expected.every((condition) => matches(row, condition));
    if (field === '$or') return expected.some((condition) => matches(row, condition));
    return matchesValue(row[field], expected);
  });
}

function matchesValue(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    if ('$exists' in expected && (actual !== undefined) !== expected.$exists) return false;
    if ('$lte' in expected && !(actual <= expected.$lte)) return false;
    if ('$lt' in expected && !(actual < expected.$lt)) return false;
    if ('$gte' in expected && !(actual >= expected.$gte)) return false;
    if ('$gt' in expected && !(actual > expected.$gt)) return false;
    if ('$ne' in expected && Object.is(actual, expected.$ne)) return false;
    if ('$in' in expected && !expected.$in.some((value) => Object.is(actual, value))) return false;
    return Object.entries(expected).every(([key]) => key.startsWith('$'));
  }
  return Object.is(actual, expected);
}

function applyUpdate(row, update) {
  for (const [key, value] of Object.entries(update.$setOnInsert ?? {})) if (row[key] === undefined) row[key] = value;
  Object.assign(row, update.$set ?? {});
  for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + value;
  for (const key of Object.keys(update.$unset ?? {})) delete row[key];
}

function extractEquality(filter) {
  return Object.fromEntries(Object.entries(filter).filter(([, value]) => !(value && typeof value === 'object' && !Array.isArray(value))));
}

function compareRows(left, right, sortSpec) {
  for (const [field, direction] of Object.entries(sortSpec ?? {})) {
    if (left[field] < right[field]) return -1 * direction;
    if (left[field] > right[field]) return 1 * direction;
  }
  return 0;
}
