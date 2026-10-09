import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { ConflictException } = require('@nestjs/common');
const { ResponsesService } = require('../src/modules/responses/responses.service.ts');

const actor = { id: 'user-1', role: 'User' };

function paragraph(text) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function doc(content = [paragraph('Ready response text.')]) {
  return { type: 'doc', content };
}

function draft(overrides = {}) {
  return {
    _id: 'draft-1',
    userId: 'user-1',
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    revision: 3,
    opportunityType: 'vacancy',
    format: 'cover_letter',
    status: 'ready',
    documentJson: doc(),
    markdownCache: '',
    unresolvedPlaceholders: [],
    checklist: {
      factsChecked: true,
      requirementsCovered: true,
      noUnresolvedPlaceholders: true,
      userReviewed: true,
    },
    generation: { status: 'completed' },
    ...overrides,
  };
}

function opportunity(overrides = {}) {
  return {
    _id: 'opp-1',
    type: 'vacancy',
    title: 'Opportunity',
    tenderData: {},
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    _id: 'state-1',
    userId: 'user-1',
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    pipelineStatus: 'New',
    responseState: {},
    pipelineEvents: [{ status: 'New', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }],
    tags: ['keep'],
    favorite: true,
    hidden: false,
    archived: false,
    ...overrides,
  };
}

function makeStatesRepository(initialState = null, options = {}) {
  const calls = { find: [], upsert: [], recordResponseHandoff: [] };
  let current = initialState;
  let failNextUpsert = options.failNextUpsert ?? false;
  const definitions = {
    vacancy: ['New', 'Reviewed', 'Interested', 'Applied', 'HRReply', 'Interview', 'TechnicalInterview', 'Offer', 'Rejected', 'Archived'],
    freelance: ['New', 'Reviewed', 'Interested', 'ResponseSent', 'ClientReplied', 'Negotiation', 'Won', 'InProgress', 'Completed', 'Lost', 'Archived'],
    tender: ['New', 'Reviewed', 'Interested', 'PreparingApplication', 'ApplicationSubmitted', 'Admitted', 'BiddingEvaluation', 'Won', 'Contracting', 'InProgress', 'Completed', 'Lost', 'Archived'],
  };
  const legacy = {
    vacancy: { Shortlisted: 'Interested', Won: 'Offer' },
    freelance: { Shortlisted: 'Interested', Applied: 'ResponseSent', Interview: 'Negotiation', Offer: 'Negotiation', Rejected: 'Lost' },
    tender: { Shortlisted: 'Interested', Applied: 'ApplicationSubmitted', Rejected: 'Lost' },
  };
  function normalized(type, status) {
    if (definitions[type].includes(status)) return status;
    return legacy[type][status] ?? 'New';
  }
  function shouldAdvance(type, currentStatus, targetStatus) {
    const currentNormalized = normalized(type, currentStatus);
    return definitions[type].indexOf(currentNormalized) < definitions[type].indexOf(targetStatus);
  }
  function mergeResponseState(responseStateEntry) {
    const base = current?.responseState && typeof current.responseState === 'object' ? { ...current.responseState } : {};
    const byFormat = base.byFormat && typeof base.byFormat === 'object' ? base.byFormat : {};
    const currentLatest = base.latestResponse && typeof base.latestResponse === 'object' ? base.latestResponse : undefined;
    const currentForFormat = byFormat[responseStateEntry.format] && typeof byFormat[responseStateEntry.format] === 'object'
      ? byFormat[responseStateEntry.format]
      : undefined;
    const incomingUpdatedAt = Date.parse(responseStateEntry.updatedAt);
    const shouldReplaceLatest = !currentLatest?.updatedAt || Date.parse(currentLatest.updatedAt) <= incomingUpdatedAt;
    const shouldReplaceFormat = !currentForFormat?.updatedAt || Date.parse(currentForFormat.updatedAt) <= incomingUpdatedAt;
    return {
      ...base,
      latestResponse: shouldReplaceLatest ? responseStateEntry : currentLatest,
      byFormat: {
        ...byFormat,
        [responseStateEntry.format]: shouldReplaceFormat ? responseStateEntry : currentForFormat,
      },
    };
  }
  return {
    calls,
    current: () => current,
    failNextUpsert() {
      failNextUpsert = true;
    },
    async find(userId, opportunityId, profileId) {
      calls.find.push({ userId, opportunityId, profileId });
      return current;
    },
    async upsert(input) {
      calls.upsert.push(input);
      if (failNextUpsert) {
        failNextUpsert = false;
        throw new Error('state write failed');
      }
      const nextStatus = input.pipelineStatus ?? current?.pipelineStatus ?? 'New';
      const previousEvents = current?.pipelineEvents ?? [];
      const event = { status: nextStatus, firstReachedAt: new Date('2026-10-03T00:00:00.000Z') };
      current = {
        ...state(),
        ...current,
        ...input,
        pipelineStatus: nextStatus,
        pipelineEvents: previousEvents.some((item) => item.status === nextStatus) ? previousEvents : [...previousEvents, event],
      };
      return current;
    },
    async recordResponseHandoff(userId, opportunityId, profileId, type, payload) {
      calls.recordResponseHandoff.push({ userId, opportunityId, profileId, type, payload });
      options.beforeRecordResponseHandoff?.({ current, userId, opportunityId, profileId, type, payload, setCurrent: (next) => { current = next; } });
      if (failNextUpsert) {
        failNextUpsert = false;
        throw new Error('state write failed');
      }
      const nextStatus = payload.pipelineStatus && shouldAdvance(type, current?.pipelineStatus ?? 'New', payload.pipelineStatus)
        ? payload.pipelineStatus
        : current?.pipelineStatus ?? 'New';
      const previousEvents = current?.pipelineEvents ?? [];
      const event = { status: nextStatus, firstReachedAt: new Date('2026-10-03T00:00:00.000Z') };
      current = {
        ...state(),
        ...current,
        userId,
        opportunityId,
        profileId,
        pipelineStatus: nextStatus,
        responseState: mergeResponseState({ ...payload.latestResponse, format: payload.format, updatedAt: payload.updatedAt ?? payload.latestResponse.updatedAt }),
        pipelineEvents: previousEvents.some((item) => item.status === nextStatus) ? previousEvents : [...previousEvents, event],
      };
      return current;
    },
  };
}

function harness({ draftValue = draft(), opportunityValue = opportunity(), updateWithRevision, statesRepository = makeStatesRepository(state()), realtime, beforeUpdatePipelineHandoff, updatePipelineHandoff } = {}) {
  const updates = [];
  const realtimeEvents = [];
  let storedDraft = draftValue;
  const responseRepository = {
    getOwned: async () => storedDraft,
    updateWithRevision: updateWithRevision ?? (async (_id, _userId, _revision, patch) => {
      updates.push(patch);
      storedDraft = { ...storedDraft, ...patch, revision: storedDraft.revision + 1 };
      return storedDraft;
    }),
    updatePipelineHandoff: updatePipelineHandoff ?? (async (_id, _userId, handoffId, handoff) => {
      beforeUpdatePipelineHandoff?.({ storedDraft, handoffId, handoff, setStoredDraft: (next) => { storedDraft = next; } });
      if (storedDraft.pipelineHandoff?.id === handoffId) {
        storedDraft = { ...storedDraft, pipelineHandoff: handoff };
      }
      return storedDraft;
    }),
  };
  const responses = new ResponsesService(
    responseRepository,
    { getById: async () => opportunityValue },
    {},
    {},
    { register: () => undefined },
    { storeBuffer: async () => ({ _id: 'file-1', originalName: 'response.txt', mimeType: 'text/plain', size: 10 }) },
    { notify: async () => undefined },
    { emit: async () => undefined },
    statesRepository,
    realtime ?? { publish: (...args) => realtimeEvents.push(args) },
  );
  return { responses, updates, statesRepository, realtimeEvents, responseRepository, currentDraft: () => storedDraft };
}

test('vacancy sent advances personal pipeline to Applied and stores latest response reference', async () => {
  const statesRepository = makeStatesRepository(state({ responseState: { source: 'manual', byFormat: { telegram_chat: { draftId: 'old' } } } }));
  const { responses, updates, realtimeEvents } = harness({ statesRepository });

  const result = await responses.setStatus(actor, 'draft-1', { status: 'sent', revision: 3 });

  assert.equal(result.status, 'sent');
  assert.equal(updates.length, 1);
  assert.equal(statesRepository.calls.recordResponseHandoff.length, 1);
  assert.deepEqual(statesRepository.calls.recordResponseHandoff[0].payload.pipelineStatus, 'Applied');
  assert.deepEqual(statesRepository.calls.recordResponseHandoff[0].payload.latestResponse.draftId, 'draft-1');
  assert.equal(statesRepository.current().pipelineStatus, 'Applied');
  assert.deepEqual(statesRepository.current().tags, ['keep']);
  assert.equal(statesRepository.current().responseState.source, 'manual');
  assert.equal(statesRepository.current().responseState.latestResponse.draftId, 'draft-1');
  assert.equal(statesRepository.current().responseState.latestResponse.format, 'cover_letter');
  assert.equal(statesRepository.current().responseState.latestResponse.status, 'sent');
  assert.equal(statesRepository.current().responseState.byFormat.telegram_chat.draftId, 'old');
  assert.equal(statesRepository.current().responseState.byFormat.cover_letter.draftId, 'draft-1');
  assert.equal(realtimeEvents.length, 1);
  assert.equal(realtimeEvents[0][1], 'pipeline.changed');
  assert.equal(realtimeEvents[0][2].pipelineStatus, 'Applied');
  assert.equal(result.pipelineHandoff.status, 'synced');
});

test('stale response revision does not touch pipeline state', async () => {
  const statesRepository = makeStatesRepository(state());
  const { responses } = harness({
    statesRepository,
    updateWithRevision: async () => {
      throw new ConflictException({ code: 'RESPONSE_DRAFT_REVISION_CONFLICT', message: 'Response draft revision conflict' });
    },
  });

  await assert.rejects(
    () => responses.setStatus(actor, 'draft-1', { status: 'sent', revision: 2 }),
    (error) => error?.response?.code === 'RESPONSE_DRAFT_REVISION_CONFLICT',
  );

  assert.equal(statesRepository.calls.find.length, 0);
  assert.equal(statesRepository.calls.upsert.length, 0);
  assert.equal(statesRepository.calls.recordResponseHandoff.length, 0);
});

test('freelance sent preserves legacy raw status already normalized to ResponseSent', async () => {
  const reached = new Date('2026-09-20T00:00:00.000Z');
  const statesRepository = makeStatesRepository(state({
    pipelineStatus: 'Applied',
    pipelineEvents: [{ status: 'Applied', firstReachedAt: reached }],
  }));
  const { responses, realtimeEvents } = harness({
    draftValue: draft({ opportunityType: 'freelance', format: 'short_proposal' }),
    opportunityValue: opportunity({ type: 'freelance' }),
    statesRepository,
  });

  await responses.setStatus(actor, 'draft-1', { status: 'sent', revision: 3 });

  assert.equal(statesRepository.current().pipelineStatus, 'Applied');
  assert.deepEqual(statesRepository.current().pipelineEvents, [{ status: 'Applied', firstReachedAt: reached }]);
  assert.equal(statesRepository.current().responseState.latestResponse.format, 'short_proposal');
  assert.equal(realtimeEvents[0][2].pipelineStatus, 'ResponseSent');
  assert.equal(realtimeEvents[0][2].rawPipelineStatus, 'Applied');
});

test('final response handoff does not move opportunities that are already later in pipeline', async () => {
  const statesRepository = makeStatesRepository(state({
    pipelineStatus: 'Offer',
    pipelineEvents: [{ status: 'Offer', firstReachedAt: new Date('2026-09-25T00:00:00.000Z') }],
  }));
  const { responses, realtimeEvents } = harness({ statesRepository });

  await responses.setStatus(actor, 'draft-1', { status: 'sent', revision: 3 });

  assert.equal(statesRepository.current().pipelineStatus, 'Offer');
  assert.equal(statesRepository.current().pipelineEvents.length, 1);
  assert.equal(statesRepository.current().responseState.latestResponse.status, 'sent');
  assert.equal(realtimeEvents[0][2].pipelineStatus, 'Offer');
});

test('atomic handoff preserves a concurrently advanced later pipeline stage', async () => {
  const statesRepository = makeStatesRepository(state({ pipelineStatus: 'New' }), {
    beforeRecordResponseHandoff: ({ current, setCurrent }) => {
      setCurrent({ ...current, pipelineStatus: 'Offer', pipelineEvents: [{ status: 'Offer', firstReachedAt: new Date('2026-10-02T00:00:00.000Z') }] });
    },
  });
  const { responses, realtimeEvents } = harness({ statesRepository });

  await responses.setStatus(actor, 'draft-1', { status: 'sent', revision: 3 });

  assert.equal(statesRepository.current().pipelineStatus, 'Offer');
  assert.equal(statesRepository.current().responseState.latestResponse.draftId, 'draft-1');
  assert.equal(realtimeEvents[0][2].pipelineStatus, 'Offer');
});

test('confirmed tender submitted advances to ApplicationSubmitted while preserving incomplete draft checks', async () => {
  const incompleteTender = draft({
    opportunityType: 'tender',
    format: 'commercial_proposal',
    status: 'draft',
    checklist: {},
    documentJson: doc([]),
    unresolvedPlaceholders: ['{{client_name}}'],
    generation: { status: 'stale' },
  });
  const statesRepository = makeStatesRepository(state({ pipelineStatus: 'PreparingApplication' }));
  const { responses, updates, realtimeEvents } = harness({
    draftValue: incompleteTender,
    opportunityValue: opportunity({ type: 'tender', tenderData: { requiredApplicationSections: ['eligibility'] } }),
    statesRepository,
  });

  const result = await responses.setStatus(actor, 'draft-1', { status: 'submitted', revision: 3, confirmedExternalSubmission: true });

  assert.equal(result.status, 'submitted');
  assert.equal(result.checklist, incompleteTender.checklist);
  assert.deepEqual(result.unresolvedPlaceholders, ['{{client_name}}']);
  assert.deepEqual(Object.keys(updates[0]).sort(), ['pipelineHandoff', 'sentAt', 'status']);
  assert.equal(statesRepository.current().pipelineStatus, 'ApplicationSubmitted');
  assert.equal(statesRepository.current().responseState.latestResponse.status, 'submitted');
  assert.equal(realtimeEvents[0][2].pipelineStatus, 'ApplicationSubmitted');
});

test('tender sent remains readiness-gated and does not record ApplicationSubmitted', async () => {
  const statesRepository = makeStatesRepository(state({ pipelineStatus: 'PreparingApplication' }));
  const { responses, realtimeEvents } = harness({
    draftValue: draft({ opportunityType: 'tender', format: 'application_draft' }),
    opportunityValue: opportunity({ type: 'tender' }),
    statesRepository,
  });

  await responses.setStatus(actor, 'draft-1', { status: 'sent', revision: 3 });

  assert.equal(statesRepository.current().pipelineStatus, 'PreparingApplication');
  assert.equal(statesRepository.current().responseState.latestResponse, undefined);
  assert.equal(realtimeEvents.length, 0);
});

test('pipeline handoff failure is durable and draft get retries without new response status write', async () => {
  const statesRepository = makeStatesRepository(state(), { failNextUpsert: true });
  const sentAt = new Date('2026-10-03T10:00:00.000Z');
  const { responses, updates, currentDraft } = harness({
    draftValue: draft({ sentAt }),
    statesRepository,
  });

  const failed = await responses.setStatus(actor, 'draft-1', { status: 'sent', revision: 3 });
  assert.equal(failed.status, 'sent');
  assert.equal(updates[0].sentAt, sentAt);
  assert.equal(failed.pipelineHandoff.status, 'error');
  assert.equal(failed.pipelineHandoff.error, 'state write failed');
  assert.equal(statesRepository.current().pipelineStatus, 'New');

  const retried = await responses.get(actor, 'draft-1');

  assert.equal(retried.pipelineHandoff.status, 'synced');
  assert.equal(statesRepository.current().pipelineStatus, 'Applied');
  assert.equal(statesRepository.current().responseState.latestResponse.draftId, 'draft-1');
  assert.equal(statesRepository.calls.recordResponseHandoff.length, 2);
  assert.equal(updates.length, 1);
  assert.equal(currentDraft().revision, 4);
});

test('errored older handoff retry does not replace newer latest response', async () => {
  const statesRepository = makeStatesRepository(state(), { failNextUpsert: true });
  const { responses } = harness({ statesRepository });

  const failed = await responses.setStatus(actor, 'draft-1', { status: 'sent', revision: 3 });
  const newerUpdatedAt = new Date(Date.parse(failed.pipelineHandoff.createdAt) + 60_000).toISOString();
  await statesRepository.recordResponseHandoff('user-1', 'opp-1', 'profile-1', 'vacancy', {
    format: 'telegram_chat',
    latestResponse: {
      draftId: 'draft-new',
      format: 'telegram_chat',
      status: 'sent',
      sentAt: newerUpdatedAt,
      updatedAt: newerUpdatedAt,
    },
    updatedAt: newerUpdatedAt,
    pipelineStatus: 'Applied',
  });

  const retried = await responses.get(actor, 'draft-1');

  assert.equal(retried.pipelineHandoff.status, 'synced');
  assert.equal(statesRepository.current().responseState.latestResponse.draftId, 'draft-new');
  assert.equal(statesRepository.current().responseState.byFormat.telegram_chat.draftId, 'draft-new');
  assert.equal(statesRepository.current().responseState.byFormat.cover_letter.draftId, 'draft-1');
  assert.equal(statesRepository.calls.recordResponseHandoff.at(-1).payload.updatedAt, failed.pipelineHandoff.createdAt);
  assert.equal(statesRepository.current().responseState.byFormat.cover_letter.updatedAt, failed.pipelineHandoff.createdAt);
});

test('handoff marker update failure leaves persisted pending marker for later retry', async () => {
  const statesRepository = makeStatesRepository(state());
  const persistedDrafts = [];
  const { responses } = harness({
    statesRepository,
    updatePipelineHandoff: async () => {
      throw new Error('marker write failed');
    },
    updateWithRevision: async (_id, _userId, _revision, patch) => {
      const persisted = { ...draft(), ...patch, revision: 4 };
      persistedDrafts.push(persisted);
      return persisted;
    },
  });

  const result = await responses.setStatus(actor, 'draft-1', { status: 'sent', revision: 3 });

  assert.equal(statesRepository.current().pipelineStatus, 'Applied');
  assert.equal(result.pipelineHandoff.status, 'pending');
  assert.equal(persistedDrafts[0].pipelineHandoff.status, 'pending');
});

test('stale handoff completion cannot overwrite a newer response marker', async () => {
  const newerMarker = {
    id: 'newer-marker',
    status: 'pending',
    targetPipelineStatus: 'Applied',
    responseStatus: 'sent',
    draftId: 'draft-1',
    format: 'telegram_chat',
    sentAt: '2026-10-03T12:00:00.000Z',
    createdAt: '2026-10-03T12:00:00.000Z',
    updatedAt: '2026-10-03T12:00:00.000Z',
  };
  const statesRepository = makeStatesRepository(state());
  const { responses, currentDraft } = harness({
    statesRepository,
    beforeUpdatePipelineHandoff: ({ storedDraft, setStoredDraft }) => {
      if (storedDraft.pipelineHandoff?.id !== newerMarker.id) {
        setStoredDraft({ ...storedDraft, pipelineHandoff: newerMarker, revision: storedDraft.revision + 1 });
      }
    },
  });

  const result = await responses.setStatus(actor, 'draft-1', { status: 'sent', revision: 3 });

  assert.equal(result.pipelineHandoff.id, newerMarker.id);
  assert.equal(result.pipelineHandoff.status, 'pending');
  assert.equal(currentDraft().pipelineHandoff.id, newerMarker.id);
});
