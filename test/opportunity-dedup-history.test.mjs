import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');
const { OpportunityDeduplicationService } = require('../src/modules/opportunities/opportunity-deduplication.service.ts');

const startedAt = new Date('2026-10-01T00:00:00.000Z');

function fixture({ runs = [], pages = [], deduplicateImpl } = {}) {
  const queued = [], scans = [], collections = new Map();
  const collection = (name) => {
    if (!collections.has(name)) collections.set(name, new InMemoryCollection(name, initialRows(name, runs)));
    return collections.get(name);
  };
  const repo = {
    getById: async (id) => ({ _id: id, type: 'vacancy', title: id, firstSeenAt: startedAt }),
    duplicateCandidates: async () => ({ items: [], hasMore: false }),
    duplicateScanPage: async (frozenCreatedAt, after) => {
      scans.push({ frozenCreatedAt, after: after ?? null });
      return pages.find((page) => (page.after ?? null) === (after ?? null))?.result ?? { items: [], nextCursor: null };
    },
  };
  const merge = { merge: async () => ({ _id: 'canonical' }) };
  const jobs = { enqueue: async (...args) => { queued.push(args); }, registerHandler: () => undefined };
  const connection = { db: { collection }, collection };
  const service = new OpportunityDeduplicationService(repo, merge, jobs, connection);
  if (deduplicateImpl) service.deduplicate = deduplicateImpl;
  return { service, queued, scans, collection };
}

function initialRows(name, runs) {
  if (name === 'opportunity_dedup_indexes') return [{ _id: '1', status: 'ready' }];
  if (name === 'opportunity_dedup_runs') return runs.map((row) => ({ ...row }));
  return [];
}

test('historical work resumes only unleased runs and keeps the frozen cursor in the job', async () => {
  const expired = { _id: 'run-expired', version: 1, status: 'queued', startedAt, nextCursor: 'cursor-50', scanned: 50, merged: 0, review: 0, missing: 0, leaseExpiresAt: new Date(Date.now() - 1_000) };
  const leased = { _id: 'run-leased', version: 1, status: 'running', startedAt, nextCursor: null, scanned: 0, merged: 0, review: 0, missing: 0, leaseExpiresAt: new Date(Date.now() + 60_000) };
  const retryLater = { _id: 'run-retry-later', version: 1, status: 'retrying', startedAt, nextCursor: null, scanned: 0, merged: 0, review: 0, missing: 0, retryAfter: new Date(Date.now() + 60_000) };
  const f = fixture({ runs: [expired, leased, retryLater] });

  const result = await f.service.reconcileDeferredWork();

  assert.equal(result.status, 'ready');
  const historyJobs = f.queued.filter((call) => call[1] === 'opportunity.duplicate-history');
  assert.deepEqual(historyJobs.map((call) => call[2]).sort((left, right) => left.runId.localeCompare(right.runId)), [
    { runId: 'initial-1', after: null },
    { runId: 'run-expired', after: 'cursor-50' },
  ]);
  assert.equal(historyJobs.some((call) => call[2].runId === 'run-leased'), false);
  assert.equal(historyJobs.some((call) => call[2].runId === 'run-retry-later'), false);
  assert.match(historyJobs.find((call) => call[2].runId === 'run-expired')[3].jobId, /^duplicate-history:run-expired:cursor-50:/);
});

test('historical page claims one lease, passes run id to deduplicate, and counts durable merge receipts', async () => {
  const run = { _id: 'run-1', version: 1, status: 'queued', startedAt, nextCursor: 'cursor-50', scanned: 50, merged: 0, review: 0, missing: 0 };
  const calls = [];
  let f;
  f = fixture({
    runs: [run],
    pages: [{ after: 'cursor-50', result: { items: [{ _id: 'opp-51' }, { _id: 'opp-52' }], nextCursor: null } }],
    deduplicateImpl: async (...args) => {
      calls.push(args);
      if (args[0] === 'opp-51') {
        f.collection('opportunity_merges').rows.push(
          { _id: 'merge-1', historicalRunId: args[3], effectsPending: true },
          { _id: 'merge-2', historicalRunId: args[3], effectsPending: true },
        );
      }
      return { status: 'completed', opportunityId: args[0], merged: [], review: [], candidateSearchComplete: true };
    },
  });

  const result = await f.service.historicalPage('run-1', 'cursor-50');
  const stored = f.collection('opportunity_dedup_runs').rows[0];
  const secondClaim = await f.service.historicalPage('run-1', 'cursor-50');

  assert.equal(result.status, 'completed');
  assert.deepEqual(f.scans, [{ frozenCreatedAt: startedAt, after: 'cursor-50' }]);
  assert.deepEqual(calls.map((call) => call.slice(0, 4)), [
    ['opp-51', undefined, false, 'run-1'],
    ['opp-52', undefined, false, 'run-1'],
  ]);
  assert.equal(stored.status, 'completed');
  assert.equal(stored.nextCursor, 'opp-52');
  assert.equal(stored.scanned, 52);
  assert.equal(stored.merged, 2);
  assert.equal(stored.leaseOwner, undefined);
  assert.equal(stored.leaseExpiresAt, undefined);
  assert.equal(secondClaim.status, 'superseded');
});

test('historical page failure keeps per-item progress and retry metadata for recovery', async () => {
  const run = { _id: 'run-fail', version: 1, status: 'queued', startedAt, nextCursor: null, scanned: 0, merged: 0, review: 0, missing: 0 };
  const calls = [];
  const f = fixture({
    runs: [run],
    pages: [{ after: null, result: { items: [{ _id: 'opp-ok' }, { _id: 'opp-fails' }], nextCursor: 'opp-fails' } }],
    deduplicateImpl: async (...args) => {
      calls.push(args);
      if (args[0] === 'opp-fails') throw new Error('page failed');
      return { status: 'completed', opportunityId: args[0], merged: [], review: [], candidateSearchComplete: true };
    },
  });

  await assert.rejects(f.service.historicalPage('run-fail'), /page failed/);
  const stored = f.collection('opportunity_dedup_runs').rows[0];

  assert.equal(stored.status, 'retrying');
  assert.equal(stored.nextCursor, 'opp-ok');
  assert.equal(stored.scanned, 1);
  assert.equal(stored.failedAttempts, 1);
  assert.ok(stored.retryAfter instanceof Date);
  assert.ok(stored.retryAfter.getTime() > Date.now());
  assert.equal(stored.lastError, 'dedup_page_failed');
  assert.equal(stored.leaseOwner, undefined);
  assert.equal(stored.leaseExpiresAt, undefined);
  assert.deepEqual(calls.map((call) => call.slice(0, 4)), [
    ['opp-ok', undefined, false, 'run-fail'],
    ['opp-fails', undefined, false, 'run-fail'],
  ]);
});

class InMemoryCollection {
  constructor(name, rows = []) { this.name = name; this.rows = rows; this.calls = []; }
  async findOne(filter = {}) { return this.rows.find((row) => matches(row, filter)) ?? null; }
  find(filter = {}) {
    let rows = this.rows.filter((row) => matches(row, filter));
    const chain = {
      sort: (sortSpec) => { rows = rows.slice().sort((left, right) => compareRows(left, right, sortSpec)); return chain; },
      limit: (count) => { rows = rows.slice(0, count); return chain; },
      project: () => chain,
      toArray: async () => rows,
    };
    return chain;
  }
  async countDocuments(filter = {}) { return this.rows.filter((row) => matches(row, filter)).length; }
  async updateOne(filter, update, options = {}) {
    this.calls.push({ method: 'updateOne', filter, update, options });
    let row = this.rows.find((item) => matches(item, filter));
    if (!row && options.upsert) { row = { ...extractEquality(filter) }; this.rows.push(row); }
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
