import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { WatchlistsRepository, mergeWatchlistHitMetadata } = require('../src/modules/watchlists/watchlists.repository.ts');
const { TenderDocumentsRepository } = require('../src/modules/tender-documents/tender-documents.repository.ts');

function query(value) {
  return {
    session() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean: async () => (typeof value === 'function' ? value() : value),
  };
}

function matches(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = record[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
      if ('$in' in expected) return expected.$in.includes(actual);
      if ('$gt' in expected) return actual > expected.$gt;
    }
    return actual === expected;
  });
}

function canonicalConnection(updates = [], options = {}) {
  return {
    db: {
      collection(name) {
        assert.equal(name, 'opportunities');
        return {
          findOne: async (filter) => {
            if (filter._id === 'old-opp') return { _id: 'old-opp', mergedIntoOpportunityId: 'canonical-opp' };
            if (filter._id === 'canonical-opp') return { _id: 'canonical-opp' };
            return null;
          },
          updateOne: async (filter, update) => { updates.push({ filter, update }); return { matchedCount: 1 }; },
        };
      },
    },
    startSession: async () => ({
      withTransaction: async (callback) => { options.beforeTransaction?.(); return callback(); },
      endSession: async () => undefined,
    }),
  };
}

function watchlistModels(hits, options = {}) {
  const stats = { watchlistUpdates: 0, totalHitDecrements: 0, creates: 0 };
  const hitModel = {
    findOne(filter) { return query(() => { options.beforeFindOne?.({ filter, hits, stats }); return hits.find((item) => matches(item, filter)) ?? null; }); },
    find(filter) { return query(() => hits.filter((item) => matches(item, filter))); },
    async create(input, createOptions = {}) {
      stats.creates += 1;
      if (options.throwDuplicateOnFirstCreate && stats.creates === 1) {
        options.beforeDuplicateCreate?.({ input, createOptions, hits });
        throw { code: 11000 };
      }
      const rows = Array.isArray(input) ? input : [input];
      const created = rows.map((row) => ({ _id: `hit-${hits.length + 1}`, matchedAt: new Date(), ...row }));
      for (const row of created) hits.push(row);
      return Array.isArray(input) ? created.map((row) => ({ toObject: () => row })) : { toObject: () => created[0] };
    },
    findOneAndUpdate(filter, update) {
      return query(() => {
        const item = hits.find((row) => matches(row, filter));
        if (!item) return null;
        Object.assign(item, update.$set ?? {});
        return { ...item };
      });
    },
    async updateOne(filter, update) {
      const item = hits.find((row) => matches(row, filter));
      if (item) Object.assign(item, update.$set ?? {});
      return { matchedCount: item ? 1 : 0, modifiedCount: item ? 1 : 0 };
    },
  };
  const watchlist = options.watchlist ?? { _id: 'watch-1', totalHits: hits.filter((hit) => hit.watchlistId === 'watch-1' && hit.supersededByHitId === undefined).length };
  const watchlistModel = { updateOne: async (filter, update) => {
    stats.watchlistUpdates += 1;
    if (!matches(watchlist, filter)) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$inc?.totalHits) { watchlist.totalHits += update.$inc.totalHits; stats.totalHitDecrements += update.$inc.totalHits < 0 ? Math.abs(update.$inc.totalHits) : 0; }
    return { matchedCount: 1, modifiedCount: 1 };
  } };
  stats.watchlist = watchlist;
  return { hitModel, watchlistModel, stats };
}

test('watchlist hits written through merged aliases are recorded on canonical opportunity and preserve existing hit state', async () => {
  const revisions = [];
  const hits = [{ _id: 'hit-old', watchlistId: 'watch-1', opportunityId: 'old-opp', autoAiState: 'queued', aiRunId: 'run-old', matchedAt: new Date('2026-10-01T00:00:00.000Z'), matchScore: 75 }];
  const { hitModel, watchlistModel } = watchlistModels(hits);
  const repository = new WatchlistsRepository(watchlistModel, hitModel, canonicalConnection(revisions));

  const result = await repository.recordHit({ watchlistId: 'watch-1', opportunityId: 'old-opp', autoAiState: 'eligible', matchScore: 88 });

  assert.equal(result._id, 'hit-old');
  assert.equal(result.opportunityId, 'canonical-opp');
  assert.equal(result.newlyCreated, false);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].opportunityId, 'canonical-opp');
  assert.equal(hits[0].autoAiState, 'queued');
  assert.equal(hits[0].aiRunId, 'run-old');
  assert.equal(revisions.length, 1);
  assert.deepEqual(revisions[0].update, { $inc: { privateReferenceRevision: 1 } });
});

test('watchlist hit alias collisions supersede the old hit without deleting history or hiding queued AutoAI', async () => {
  const hits = [
    { _id: 'hit-old', watchlistId: 'watch-1', opportunityId: 'old-opp', autoAiState: 'queued', aiRunId: 'run-old', matchedAt: new Date('2026-10-01T00:00:00.000Z'), matchScore: 95 },
    { _id: 'hit-canonical', watchlistId: 'watch-1', opportunityId: 'canonical-opp', autoAiState: 'eligible', matchedAt: new Date('2026-10-02T00:00:00.000Z'), matchScore: 80 },
  ];
  const { hitModel, watchlistModel, stats } = watchlistModels(hits);
  const repository = new WatchlistsRepository(watchlistModel, hitModel, canonicalConnection());

  const result = await repository.recordHit({ watchlistId: 'watch-1', opportunityId: 'old-opp', autoAiState: 'eligible', matchScore: 88 });
  await repository.recordHit({ watchlistId: 'watch-1', opportunityId: 'old-opp', autoAiState: 'eligible', matchScore: 88 });
  const visible = await repository.listHits('watch-1');

  assert.equal(result._id, 'hit-canonical');
  assert.equal(hits.find((item) => item._id === 'hit-old').supersededByHitId, 'hit-canonical');
  const canonical = hits.find((item) => item._id === 'hit-canonical');
  assert.equal(canonical.autoAiState, 'queued');
  assert.equal(canonical.aiRunId, 'run-old');
  assert.deepEqual(canonical.aiRunHistory, ['run-old']);
  assert.equal(canonical.matchScore, 95);
  assert.equal(canonical.matchedAt.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.deepEqual(visible.map((item) => item._id), ['hit-canonical']);
  assert.equal(stats.totalHitDecrements, 1);
  assert.equal(stats.watchlist.totalHits, 1);
});



test('delayed watchlist mark updates on superseded hits propagate to canonical hit without losing run history', async () => {
  const hits = [
    { _id: 'hit-old', watchlistId: 'watch-1', opportunityId: 'old-opp', supersededByHitId: 'hit-canonical', notificationState: 'pending', notificationKey: 'notify-old', autoAiState: 'eligible', aiRunId: 'run-old-started', matchedAt: new Date('2026-10-01T00:00:00.000Z'), matchScore: 80 },
    { _id: 'hit-canonical', watchlistId: 'watch-1', opportunityId: 'canonical-opp', notificationState: 'pending', notificationKey: 'notify-canonical', autoAiState: 'queued', aiRunId: 'run-canonical', matchedAt: new Date('2026-10-02T00:00:00.000Z'), matchScore: 70 },
  ];
  const { hitModel, watchlistModel } = watchlistModels(hits);
  const repository = new WatchlistsRepository(watchlistModel, hitModel, canonicalConnection());

  await repository.markAutoAiQueued('hit-old', 'run-old-completed-late');
  await repository.markNotificationState('hit-old', 'notified');

  const old = hits.find((item) => item._id === 'hit-old');
  const canonical = hits.find((item) => item._id === 'hit-canonical');
  assert.equal(old.autoAiState, 'queued');
  assert.equal(old.aiRunId, 'run-old-completed-late');
  assert.deepEqual(old.aiRunHistory, ['run-old-started', 'run-old-completed-late']);
  assert.equal(old.notificationState, 'notified');
  assert.equal(canonical.notificationState, 'notified');
  assert.equal(canonical.autoAiState, 'queued');
  assert.equal(canonical.aiRunId, 'run-canonical');
  assert.deepEqual(canonical.aiRunHistory, ['run-canonical', 'run-old-started', 'run-old-completed-late']);
  assert.deepEqual(canonical.notificationKeys, ['notify-canonical', 'notify-old']);
});


test('late watchlist mark rereads superseded hit inside canonical transaction after merge race', async () => {
  const hits = [
    { _id: 'hit-old', watchlistId: 'watch-1', opportunityId: 'old-opp', notificationState: 'pending', notificationKey: 'notify-old', autoAiState: 'eligible', aiRunId: 'run-old-started', matchedAt: new Date('2026-10-01T00:00:00.000Z'), matchScore: 90 },
    { _id: 'hit-mid', watchlistId: 'watch-1', opportunityId: 'mid-opp', supersededByHitId: 'hit-canonical', notificationState: 'pending', notificationKey: 'notify-mid', autoAiState: 'eligible', aiRunId: 'run-mid', matchedAt: new Date('2026-10-02T00:00:00.000Z'), matchScore: 80 },
    { _id: 'hit-canonical', watchlistId: 'watch-1', opportunityId: 'canonical-opp', notificationState: 'pending', notificationKey: 'notify-canonical', autoAiState: 'queued', aiRunId: 'run-canonical', matchedAt: new Date('2026-10-03T00:00:00.000Z'), matchScore: 70 },
  ];
  const { hitModel, watchlistModel } = watchlistModels(hits);
  let mergeHappened = false;
  const repository = new WatchlistsRepository(watchlistModel, hitModel, canonicalConnection([], {
    beforeTransaction: () => {
      if (!mergeHappened) {
        mergeHappened = true;
        hits.find((item) => item._id === 'hit-old').supersededByHitId = 'hit-mid';
      }
    },
  }));

  await repository.markAutoAiQueued('hit-old', 'run-old-completed-late');
  await repository.markNotificationState('hit-old', 'notified');

  const old = hits.find((item) => item._id === 'hit-old');
  const mid = hits.find((item) => item._id === 'hit-mid');
  const canonical = hits.find((item) => item._id === 'hit-canonical');
  assert.equal(old.supersededByHitId, 'hit-mid');
  assert.equal(old.aiRunId, 'run-old-completed-late');
  assert.deepEqual(old.aiRunHistory, ['run-old-started', 'run-old-completed-late']);
  assert.equal(mid.aiRunId, 'run-mid');
  assert.deepEqual(mid.aiRunHistory, ['run-mid', 'run-old-started', 'run-old-completed-late']);
  assert.equal(canonical.aiRunId, 'run-canonical');
  assert.deepEqual(canonical.aiRunHistory, ['run-canonical', 'run-mid', 'run-old-started', 'run-old-completed-late']);
  assert.equal(canonical.notificationState, 'notified');
  assert.deepEqual(canonical.notificationKeys, ['notify-canonical', 'notify-mid', 'notify-old']);
});

test('watchlist recordHit retries duplicate-key transaction in a fresh transaction without extra totalHits', async () => {
  const hits = [];
  const { hitModel, watchlistModel, stats } = watchlistModels(hits, {
    throwDuplicateOnFirstCreate: true,
    beforeDuplicateCreate: ({ input, hits: rows }) => rows.push({ _id: 'hit-raced', matchedAt: new Date('2026-10-03T00:00:00.000Z'), ...input[0] }),
  });
  const repository = new WatchlistsRepository(watchlistModel, hitModel, canonicalConnection());

  const result = await repository.recordHit({ watchlistId: 'watch-1', opportunityId: 'old-opp', autoAiState: 'eligible', matchScore: 88 });

  assert.equal(result._id, 'hit-raced');
  assert.equal(result.opportunityId, 'canonical-opp');
  assert.equal(result.newlyCreated, false);
  assert.equal(stats.creates, 1);
  assert.equal(stats.watchlistUpdates, 0);
  assert.equal(hits.length, 1);
});

test('mergeWatchlistHitMetadata preserves both AI runs and notification keys without deleting duplicate history', () => {
  const patch = mergeWatchlistHitMetadata(
    { _id: 'hit-canonical', watchlistId: 'watch-1', opportunityId: 'canonical-opp', notificationState: 'pending', notificationKey: 'notify-canonical', autoAiState: 'queued', aiRunId: 'run-canonical', matchedAt: new Date('2026-10-02T00:00:00.000Z'), matchScore: 70 },
    { _id: 'hit-duplicate', watchlistId: 'watch-1', opportunityId: 'old-opp', notificationState: 'notified', notificationKey: 'notify-duplicate', autoAiState: 'completed', aiRunId: 'run-duplicate', matchedAt: new Date('2026-10-01T00:00:00.000Z'), matchScore: 95 },
  );

  assert.equal(patch.canonicalSet.notificationState, 'notified');
  assert.equal(patch.canonicalSet.autoAiState, 'completed');
  assert.deepEqual(patch.canonicalSet.aiRunHistory, ['run-canonical', 'run-duplicate']);
  assert.deepEqual(patch.canonicalSet.notificationKeys, ['notify-canonical', 'notify-duplicate']);
  assert.equal(patch.canonicalSet.matchScore, 95);
  assert.equal(patch.canonicalSet.matchedAt.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.deepEqual(patch.supersededSet, { supersededByHitId: 'hit-canonical' });
});

test('tender document repository creates links on canonical opportunity inside the shared revision transaction', async () => {
  const revisions = [];
  const created = [];
  const model = {
    async create(input) {
      const rows = Array.isArray(input) ? input : [input];
      const docs = rows.map((row) => ({ _id: `link-${created.length + 1}`, ...row }));
      created.push(...docs);
      return docs.map((doc) => ({ toObject: () => doc }));
    },
  };
  const repository = new TenderDocumentsRepository(model, canonicalConnection(revisions));

  const link = await repository.create({ userId: 'user-1', opportunityId: 'old-opp', profileId: 'profile-1', knowledgeDocumentId: 'doc-1', fileId: 'file-1', title: 'Doc', aiStatus: 'Not analyzed' });

  assert.equal(link.opportunityId, 'canonical-opp');
  assert.equal(created[0].opportunityId, 'canonical-opp');
  assert.equal(revisions.length, 1);
  assert.deepEqual(revisions[0].update, { $inc: { privateReferenceRevision: 1 } });
});
