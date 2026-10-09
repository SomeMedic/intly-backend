import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { BadRequestException, ConflictException, NotFoundException } = require('@nestjs/common');
const { ResumesService } = require('../src/modules/resumes/resumes.service.ts');

const actor = { id: 'user-1', email: 'user@example.test', role: 'User' };

test('resume adaptation list supports deleted-only trash visibility with filters', async () => {
  const calls = [];
  const service = serviceWith({
    listAdaptations: async (userId, query) => {
      calls.push({ userId, query });
      return [{ _id: 'deleted-1', userId, deletedAt: new Date('2026-10-06T00:00:00.000Z'), revision: 4 }];
    },
  });

  const result = await service.listAdaptations(actor, { deleted: 'only', profileId: 'profile-1', opportunityId: 'opp-1', baseResumeId: 'resume-1' });

  assert.equal(result.items[0]._id, 'deleted-1');
  assert.deepEqual(calls, [{ userId: 'user-1', query: { opportunityId: 'opp-1', profileId: 'profile-1', baseResumeId: 'resume-1', deleted: 'only' } }]);
});

test('resume adaptation delete soft-deletes with revision CAS and preserves content outside the patch', async () => {
  const calls = [];
  const service = serviceWith({
    getActiveAdaptationOwnedWithRevision: async (id, userId, revision) => {
      calls.push({ method: 'getActiveAdaptationOwnedWithRevision', id, userId, revision });
      return adaptation({ revision, status: 'review', documentJson: { headline: 'Keep me' }, suggestions: [{ id: 'sug-1', status: 'pending' }] });
    },
    softDeleteAdaptationWithRevision: async (id, userId, revision) => {
      calls.push({ method: 'softDeleteAdaptationWithRevision', id, userId, revision });
    },
  });

  assert.deepEqual(await service.deleteAdaptation(actor, 'adapt-1', { revision: 5 }), { success: true });
  assert.deepEqual(calls, [
    { method: 'getActiveAdaptationOwnedWithRevision', id: 'adapt-1', userId: 'user-1', revision: 5 },
    { method: 'softDeleteAdaptationWithRevision', id: 'adapt-1', userId: 'user-1', revision: 5 },
  ]);
});

test('stale resume adaptation delete rejects before cancelling a generating AI run', async () => {
  let aiTouched = false;
  const service = serviceWith(
    {
      getActiveAdaptationOwnedWithRevision: async () => { throw new ConflictException('Resume adaptation revision conflict'); },
      softDeleteAdaptationWithRevision: async () => { throw new Error('should not soft-delete stale request'); },
    },
    {
      getRun: async () => { aiTouched = true; throw new Error('should not inspect AI run for stale request'); },
      cancel: async () => { aiTouched = true; throw new Error('should not cancel AI run for stale request'); },
    },
  );

  await assert.rejects(() => service.deleteAdaptation(actor, 'adapt-1', { revision: 4 }), ConflictException);
  assert.equal(aiTouched, false);
});

test('generating resume adaptation delete cancels queued AI run after revision check and before soft-delete', async () => {
  const calls = [];
  const service = serviceWith(
    {
      getActiveAdaptationOwnedWithRevision: async (id, userId, revision) => {
        calls.push({ method: 'getActiveAdaptationOwnedWithRevision', id, userId, revision });
        return adaptation({ revision, status: 'generating', aiRunId: 'run-1' });
      },
      softDeleteAdaptationWithRevision: async (id, userId, revision) => {
        calls.push({ method: 'softDeleteAdaptationWithRevision', id, userId, revision });
      },
    },
    {
      getRun: async (runActor, id) => {
        calls.push({ method: 'getRun', actorId: runActor.id, id });
        return { _id: id, userId: runActor.id, status: 'queued' };
      },
      cancel: async (runActor, id) => {
        calls.push({ method: 'cancel', actorId: runActor.id, id });
        return { _id: id, userId: runActor.id, status: 'cancelled' };
      },
    },
  );

  assert.deepEqual(await service.deleteAdaptation(actor, 'adapt-1', { revision: 5 }), { success: true });
  assert.deepEqual(calls.map((call) => call.method), ['getActiveAdaptationOwnedWithRevision', 'getRun', 'cancel', 'softDeleteAdaptationWithRevision']);
});

test('generating resume adaptation without aiRunId soft-deletes retained content without fake AI cancellation', async () => {
  let aiTouched = false;
  let deleted = false;
  const service = serviceWith(
    {
      getActiveAdaptationOwnedWithRevision: async (id, userId, revision) => adaptation({ revision, status: 'generating' }),
      softDeleteAdaptationWithRevision: async () => { deleted = true; },
    },
    {
      getRun: async () => { aiTouched = true; },
      cancel: async () => { aiTouched = true; },
    },
  );

  assert.deepEqual(await service.deleteAdaptation(actor, 'adapt-1', { revision: 5 }), { success: true });
  assert.equal(deleted, true);
  assert.equal(aiTouched, false);
});

test('restore uses deleted revision CAS and returns preserved adaptation', async () => {
  const restored = adaptation({ revision: 8, deletedAt: undefined, documentJson: { headline: 'Preserved' }, suggestions: [{ id: 'sug-1', status: 'accepted' }] });
  const calls = [];
  const service = serviceWith({
    restoreAdaptationWithRevision: async (id, userId, revision) => {
      calls.push({ id, userId, revision });
      return restored;
    },
  });

  assert.equal(await service.restoreAdaptation(actor, 'adapt-1', { revision: 7 }), restored);
  assert.deepEqual(calls, [{ id: 'adapt-1', userId: 'user-1', revision: 7 }]);
});

test('undo reorder restores order from exact current ids while preserving edited item content', async () => {
  const saved = [];
  const service = serviceWith({
    getAdaptationOwned: async () => adaptation({
      revision: 12,
      status: 'review',
      documentJson: {
        skills: [
          { id: 'b', text: 'Beta edited', score: 2 },
          { id: 'a', text: 'Alpha edited', score: 1 },
          { id: 'c', text: 'Gamma edited', score: 3 },
        ],
      },
      suggestions: [reorderSuggestion({ status: 'accepted', decidedAt: new Date('2026-10-06T00:00:00.000Z') })],
    }),
    updateAdaptationWithRevision: async (id, userId, revision, patch) => {
      saved.push({ id, userId, revision, patch });
      return adaptation({ revision: revision + 1, ...patch });
    },
  });

  const result = await service.undoReorderSuggestion(actor, 'adapt-1', 'sug-reorder', { revision: 12, order: ['a', 'b', 'c'] });

  assert.deepEqual(result.documentJson.skills.map((item) => [item.id, item.text, item.score]), [
    ['a', 'Alpha edited', 1],
    ['b', 'Beta edited', 2],
    ['c', 'Gamma edited', 3],
  ]);
  assert.equal(result.suggestions[0].status, 'pending');
  assert.equal('decidedAt' in result.suggestions[0], false);
  assert.equal(result.status, 'editing');
  assert.equal(saved[0].revision, 12);
});

test('undo reorder rejects malformed order, nonaccepted suggestions, and unsupported suggestions', async () => {
  await assert.rejects(
    () => serviceForUndo(reorderSuggestion({ status: 'accepted' })).undoReorderSuggestion(actor, 'adapt-1', 'sug-reorder', { revision: 3, order: ['a', 'a', 'c'] }),
    /unique item ids/,
  );
  await assert.rejects(
    () => serviceForUndo(reorderSuggestion({ status: 'accepted' })).undoReorderSuggestion(actor, 'adapt-1', 'sug-reorder', { revision: 3, order: ['a', 'b'] }),
    /current item ids/,
  );
  await assert.rejects(
    () => serviceForUndo(reorderSuggestion({ status: 'accepted' })).undoReorderSuggestion(actor, 'adapt-1', 'sug-reorder', { revision: 3, order: ['b', 'a', 'c'] }),
    /must differ from the current order/,
  );
  await assert.rejects(
    () => serviceForUndo(reorderSuggestion({ status: 'pending' })).undoReorderSuggestion(actor, 'adapt-1', 'sug-reorder', { revision: 3, order: ['a', 'b', 'c'] }),
    /Only accepted/,
  );
  await assert.rejects(
    () => serviceForUndo({ ...reorderSuggestion({ status: 'accepted' }), proposed: { sectionId: 'skills', action: 'replace', itemId: 'a' } }).undoReorderSuggestion(actor, 'adapt-1', 'sug-reorder', { revision: 3, order: ['a', 'b', 'c'] }),
    /not a reorder/,
  );
  await assert.rejects(
    () => serviceForUndo({ ...reorderSuggestion({ status: 'accepted' }), proposed: { documentPatch: { headline: 'x' }, sectionId: 'skills', action: 'reorder' } }).undoReorderSuggestion(actor, 'adapt-1', 'sug-reorder', { revision: 3, order: ['a', 'b', 'c'] }),
    /not a reorder/,
  );
  await assert.rejects(
    () => serviceForUndo({ ...reorderSuggestion({ status: 'accepted' }), proposed: { sectionId: 'headline', action: 'reorder', itemId: 'b', toIndex: 0 } }).undoReorderSuggestion(actor, 'adapt-1', 'sug-reorder', { revision: 3, order: ['a', 'b', 'c'] }),
    /section is not supported/,
  );
  await assert.rejects(
    () => serviceForUndo(reorderSuggestion({ status: 'accepted' })).undoReorderSuggestion(actor, 'adapt-1', 'sug-reorder', { revision: 3, order: ['b', 'c', 'a'] }),
    /does not match/,
  );
});

test('restore and delete surface missing adaptations as not found', async () => {
  const service = serviceWith({
    getActiveAdaptationOwnedWithRevision: async () => { throw new NotFoundException('Resume adaptation not found'); },
    restoreAdaptationWithRevision: async () => { throw new NotFoundException('Resume adaptation not found'); },
  });

  await assert.rejects(() => service.deleteAdaptation(actor, 'foreign', { revision: 1 }), NotFoundException);
  await assert.rejects(() => service.restoreAdaptation(actor, 'foreign', { revision: 1 }), NotFoundException);
});

function serviceForUndo(suggestion) {
  return serviceWith({
    getAdaptationOwned: async () => adaptation({
      revision: 3,
      documentJson: { skills: [{ id: 'b', text: 'Beta' }, { id: 'a', text: 'Alpha' }, { id: 'c', text: 'Gamma' }] },
      suggestions: [suggestion],
    }),
    updateAdaptationWithRevision: async () => { throw new Error('invalid undo should not update'); },
  });
}

function serviceWith(repositoryOverrides = {}, aiOverrides = {}) {
  return new ResumesService(
    repositoryOverrides,
    {},
    {},
    {
      getRun: async () => ({ _id: 'run-1', status: 'completed' }),
      cancel: async () => ({ _id: 'run-1', status: 'cancelled' }),
      ...aiOverrides,
    },
    { register: () => undefined },
    {},
  );
}

function adaptation(overrides = {}) {
  return {
    _id: 'adapt-1',
    userId: 'user-1',
    profileId: 'profile-1',
    opportunityId: 'opp-1',
    baseResumeId: 'resume-1',
    documentJson: { skills: [] },
    markdownCache: 'cache',
    suggestions: [],
    status: 'review',
    revision: 1,
    generation: {},
    exportState: {},
    ...overrides,
  };
}

function reorderSuggestion(overrides = {}) {
  return {
    id: 'sug-reorder',
    type: 'reorder_section',
    title: 'Move Beta first',
    proposed: { sectionId: 'skills', action: 'reorder', itemId: 'b', toIndex: 0 },
    status: 'accepted',
    ...overrides,
  };
}
