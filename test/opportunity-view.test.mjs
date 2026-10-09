import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { plainToInstance } = require('class-transformer');
const { validateSync } = require('class-validator');
const mongoose = require('mongoose');
const { MatchingService } = require('../src/modules/matching/matching.service.ts');
const { OpportunityProfileQueryDto } = require('../src/modules/opportunities/dto/opportunity.dto.ts');
const { OpportunitiesService } = require('../src/modules/opportunities/opportunities.service.ts');
const { OpportunityUserStatesRepository } = require('../src/modules/opportunities/opportunity-user-states.repository.ts');
const { OpportunityUserState, OpportunityUserStateSchema } = require('../src/modules/opportunities/schemas/opportunity-user-state.schema.ts');

const actor = { id: 'user-1', email: 'user@example.test', role: 'User' };
const activeProfile = { _id: '11111111-1111-4111-8111-111111111111', userId: actor.id, isActive: true, technologies: ['TypeScript'], targetRoles: ['Backend'] };
const explicitProfile = { _id: '22222222-2222-4222-8222-222222222222', userId: actor.id, isActive: false, technologies: ['NestJS'], targetRoles: ['API'] };

function opportunity(overrides = {}) {
  return {
    _id: overrides._id ?? '33333333-3333-4333-8333-333333333333',
    type: overrides.type ?? 'vacancy',
    title: overrides.title ?? 'Backend Engineer',
    companyOrClient: 'Acme',
    sourceStatus: 'Active',
    firstSeenAt: new Date('2026-10-01T00:00:00.000Z'),
    sourceOccurrences: [{ sourceId: 'hh', externalId: '1', url: 'https://example.test/jobs/1', primary: true, firstSeenAt: new Date('2026-10-01T00:00:00.000Z'), lastSeenAt: new Date('2026-10-01T00:00:00.000Z'), status: 'Active' }],
    skills: ['TypeScript'],
    technologies: ['NestJS'],
    canonicalTags: [],
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    _id: overrides._id ?? `state-${overrides.profileId ?? activeProfile._id}`,
    userId: overrides.userId ?? actor.id,
    opportunityId: overrides.opportunityId ?? '33333333-3333-4333-8333-333333333333',
    profileId: overrides.profileId ?? activeProfile._id,
    pipelineStatus: overrides.pipelineStatus ?? 'New',
    pipelineEvents: overrides.pipelineEvents ?? [{ status: overrides.pipelineStatus ?? 'New', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }],
    favorite: overrides.favorite ?? false,
    hidden: overrides.hidden ?? false,
    archived: overrides.archived ?? false,
    tags: overrides.tags ?? [],
    matchScore: overrides.matchScore ?? 25,
    matchComponents: overrides.matchComponents ?? { skills: 25 },
    responseState: overrides.responseState ?? {},
    notes: overrides.notes ?? [],
    ...overrides,
  };
}

function harness({ opportunityRecord = opportunity(), profiles = [activeProfile, explicitProfile], states = [] } = {}) {
  const stateRepository = new InMemoryStates(states);
  const profilesRepository = new InMemoryProfiles(profiles);
  const service = new OpportunitiesService(
    { getById: async (id) => {
      if (id !== opportunityRecord._id) throw new Error('not found');
      return opportunityRecord;
    } },
    stateRepository,
    {},
    {},
    profilesRepository,
    new MatchingService(),
  );
  return { service, stateRepository, profilesRepository, opportunityRecord };
}

test('GET opportunity detail is read-only and preserves an existing New personal state', async () => {
  const existing = state({ pipelineStatus: 'New' });
  const { service, stateRepository } = harness({ states: [existing] });

  const detail = await service.get(actor, existing.opportunityId, activeProfile._id);

  assert.equal(detail.personalState.pipelineStatus, 'New');
  assert.equal(stateRepository.recordViewCalls.length, 0);
  assert.equal(stateRepository.records[0].pipelineStatus, 'New');
});

test('POST opportunity view marks absent or New state as Reviewed and returns full detail', async () => {
  const { service, stateRepository } = harness();

  const detail = await service.view(actor, '33333333-3333-4333-8333-333333333333', activeProfile._id);

  assert.equal(detail.title, 'Backend Engineer');
  assert.equal(detail.personalState.pipelineStatus, 'Reviewed');
  assert.equal(stateRepository.recordViewCalls.length, 1);
  assert.equal(stateRepository.records[0].pipelineEvents.some((event) => event.status === 'Reviewed'), true);
});

test('manual New remains explicit after a detail refetch', async () => {
  const existing = state({ pipelineStatus: 'Reviewed', pipelineEvents: [{ status: 'Reviewed', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }] });
  const { service, stateRepository } = harness({ states: [existing] });

  const manual = await service.updatePersonal(actor, existing.opportunityId, { profileId: activeProfile._id, pipelineStatus: 'New' });
  const detail = await service.get(actor, existing.opportunityId, activeProfile._id);

  assert.equal(manual.pipelineStatus, 'New');
  assert.equal(detail.personalState.pipelineStatus, 'New');
  assert.equal(stateRepository.recordViewCalls.length, 0);
});

test('POST opportunity view preserves later stages and unrelated personal data', async () => {
  const oldMatchCalculatedAt = new Date('2026-10-01T08:00:00.000Z');
  const oldUpdatedAt = new Date('2026-10-01T09:00:00.000Z');
  const existing = state({
    pipelineStatus: 'Applied',
    favorite: true,
    tags: ['priority'],
    matchScore: 41,
    matchComponents: { historical: 1 },
    matchCalculatedAt: oldMatchCalculatedAt,
    responseState: { latestResponse: { draftId: 'draft-1' } },
    notes: [{ id: 'note-1', text: 'Keep', pinned: false }],
    pipelineEvents: [{ status: 'Applied', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }],
    updatedAt: oldUpdatedAt,
  });
  const { service, stateRepository } = harness({ states: [existing] });

  const detail = await service.view(actor, existing.opportunityId, activeProfile._id);

  assert.equal(detail.personalState.pipelineStatus, 'Applied');
  assert.equal(detail.personalState.favorite, true);
  assert.deepEqual(detail.personalState.tags, ['priority']);
  assert.equal(detail.personalState.matchScore, 41);
  assert.deepEqual(detail.personalState.matchComponents, { historical: 1 });
  assert.equal(detail.personalState.matchCalculatedAt, oldMatchCalculatedAt);
  assert.equal(detail.personalState.updatedAt, oldUpdatedAt);
  assert.deepEqual(detail.personalState.responseState, { latestResponse: { draftId: 'draft-1' } });
  assert.deepEqual(detail.personalState.notes, [{ id: 'note-1', text: 'Keep', pinned: false }]);
  assert.equal(stateRepository.records[0].pipelineEvents.some((event) => event.status === 'Reviewed'), false);
});

test('view without an active profile returns shared detail and writes no personal state', async () => {
  const { service, stateRepository } = harness({ profiles: [] });

  const detail = await service.view(actor, '33333333-3333-4333-8333-333333333333');

  assert.equal(detail.title, 'Backend Engineer');
  assert.equal(detail.personalState, null);
  assert.equal(stateRepository.recordViewCalls.length, 0);
  assert.equal(stateRepository.records.length, 0);
});

test('explicit view profile uses ownership lookup instead of the active profile', async () => {
  const { service, stateRepository, profilesRepository } = harness();

  const detail = await service.view(actor, '33333333-3333-4333-8333-333333333333', explicitProfile._id);

  assert.equal(detail.personalState.profileId, explicitProfile._id);
  assert.deepEqual(profilesRepository.getOwnedCalls, [{ id: explicitProfile._id, userId: actor.id }]);
  assert.equal(profilesRepository.findActiveCalls, 0);
  assert.equal(stateRepository.records[0].profileId, explicitProfile._id);
});

test('explicit view profile rejects foreign ownership before writing state', async () => {
  const foreignProfileId = '44444444-4444-4444-8444-444444444444';
  const { service, stateRepository } = harness({ profiles: [{ _id: foreignProfileId, userId: 'other-user', isActive: false }] });

  await assert.rejects(
    () => service.view(actor, '33333333-3333-4333-8333-333333333333', foreignProfileId),
    /Profile not found/,
  );
  assert.equal(stateRepository.recordViewCalls.length, 0);
  assert.equal(stateRepository.records.length, 0);
});

test('opportunity view body keeps profileId validation', () => {
  const invalid = plainToInstance(OpportunityProfileQueryDto, { profileId: 'profile-1' });
  const valid = plainToInstance(OpportunityProfileQueryDto, { profileId: activeProfile._id });

  assert.ok(validateSync(invalid).length >= 1);
  assert.equal(validateSync(valid).length, 0);
});

test('recordView is one owner-scoped atomic upsert and cannot regress later stages', async () => {
  const calls = [];
  const model = {
    findOneAndUpdate: async (...args) => {
      calls.push(args);
      return state({ pipelineStatus: 'Applied' });
    },
  };
  const repository = new OpportunityUserStatesRepository(model);

  const result = await repository.recordView(actor.id, 'opp-1', activeProfile._id, 'vacancy', {
    matchScore: 88,
    matchComponents: { skills: 80 },
    matchCalculatedAt: new Date('2026-10-05T12:00:00.000Z'),
  });

  assert.equal(result.pipelineStatus, 'Applied');
  assert.equal(calls.length, 1);
  const [filter, update, options] = calls[0];
  assert.deepEqual(filter, { userId: actor.id, opportunityId: 'opp-1', profileId: activeProfile._id, deletedAt: { $exists: false } });
  assert.equal(options.upsert, true);
  assert.equal(options.updatePipeline, true);
  const set = update[0].$set;
  assert.deepEqual(set.favorite, { $ifNull: ['$favorite', false] });
  assert.deepEqual(set.responseState, { $ifNull: ['$responseState', {}] });
  assert.deepEqual(set.matchScore, { $cond: [set.pipelineStatus.$cond[0], { $literal: 88 }, '$matchScore'] });
  assert.deepEqual(set.matchComponents, { $cond: [set.pipelineStatus.$cond[0], { $literal: { skills: 80 } }, '$matchComponents'] });
  assert.deepEqual(set.matchCalculatedAt, { $cond: [set.pipelineStatus.$cond[0], { $literal: new Date('2026-10-05T12:00:00.000Z') }, '$matchCalculatedAt'] });
  assert.deepEqual(set.pipelineStatus.$cond[0], { $eq: [{ $ifNull: ['$pipelineStatus', 'New'] }, 'New'] });
  assert.equal(set.pipelineStatus.$cond[1], 'Reviewed');
  assert.deepEqual(set.pipelineStatus.$cond[2], { $ifNull: ['$pipelineStatus', 'New'] });
  assert.deepEqual(set.pipelineEvents.$let.in.$cond[0].$and[0], set.pipelineStatus.$cond[0]);
  assert.deepEqual(set.updatedAt, { $cond: [set.pipelineStatus.$cond[0], set.updatedAt.$cond[1], '$updatedAt'] });
  assert.equal(options.timestamps, false);
});

test('recordView retries only the exact owned unique-key insert race without upserting again', async () => {
  const duplicate = Object.assign(new Error('owned unique insert race'), { code: 11000,
    keyPattern: { userId: 1, opportunityId: 1, profileId: 1 },
    keyValue: { userId: actor.id, opportunityId: 'opp-1', profileId: activeProfile._id } });
  const calls = [];
  const repository = new OpportunityUserStatesRepository({ async findOneAndUpdate(...args) {
    calls.push(args);
    if (calls.length === 1) throw duplicate;
    return state({ pipelineStatus: 'Applied' });
  } });
  const result = await repository.recordView(actor.id, 'opp-1', activeProfile._id, 'vacancy', { matchScore: 88, matchComponents: {}, matchCalculatedAt: new Date() });
  assert.equal(result.pipelineStatus, 'Applied');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][0], calls[0][0]);
  assert.equal(calls[1][1], calls[0][1]);
  assert.equal(calls[0][2].upsert, true);
  assert.deepEqual(calls[1][2], { ...calls[0][2], upsert: false });
});

test('recordView propagates foreign, broader-index and unrelated failures without a retry', async () => {
  const pattern = { userId: 1, opportunityId: 1, profileId: 1 };
  const value = { userId: actor.id, opportunityId: 'opp-1', profileId: activeProfile._id };
  for (const attributes of [
    { code: 11000, keyPattern: pattern, keyValue: { ...value, userId: 'foreign-user' } },
    { code: 11000, keyPattern: pattern, keyValue: { ...value, profileId: 'foreign-profile' } },
    { code: 11000, keyPattern: pattern, keyValue: { ...value, opportunityId: 'other-opportunity' } },
    { code: 11000, keyPattern: { ...pattern, pipelineStatus: 1 }, keyValue: { ...value, pipelineStatus: 'New' } },
    { code: 11000, keyPattern: { _id: 1 }, keyValue: { _id: 'state-1' } },
    { code: 11000 }, { code: 112, keyPattern: pattern, keyValue: value },
  ]) {
    const failure = Object.assign(new Error('unrelated storage failure'), attributes);
    let calls = 0;
    const repository = new OpportunityUserStatesRepository({ async findOneAndUpdate() { calls += 1; throw failure; } });
    await assert.rejects(() => repository.recordView(actor.id, 'opp-1', activeProfile._id, 'vacancy', { matchScore: 88, matchComponents: {}, matchCalculatedAt: new Date() }), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('local Mongo recordView marks initial views once and preserves reviewed match metadata on repeat', async (t) => {
  const fixture = await withViewRepository(t);
  if (!fixture) return;
  const { repository, StateModel } = fixture;
  const firstMatchAt = new Date('2026-10-05T12:00:00.000Z');
  const secondMatchAt = new Date('2026-10-05T13:00:00.000Z');

  const first = await repository.recordView(actor.id, 'opp-mongo-repeat', activeProfile._id, 'vacancy', {
    matchScore: 88,
    matchComponents: { first: 1 },
    matchCalculatedAt: firstMatchAt,
  });
  const second = await repository.recordView(actor.id, 'opp-mongo-repeat', activeProfile._id, 'vacancy', {
    matchScore: 99,
    matchComponents: { second: 1 },
    matchCalculatedAt: secondMatchAt,
  });
  const stored = await StateModel.findOne({ userId: actor.id, opportunityId: 'opp-mongo-repeat', profileId: activeProfile._id }).lean();

  assert.equal(first.pipelineStatus, 'Reviewed');
  assert.equal(second.pipelineStatus, 'Reviewed');
  assert.equal(stored.pipelineStatus, 'Reviewed');
  assert.equal(stored.matchScore, 88);
  assert.deepEqual(stored.matchComponents, { first: 1 });
  assert.equal(stored.matchCalculatedAt.toISOString(), firstMatchAt.toISOString());
  assert.equal(stored.pipelineEvents.filter((event) => event.status === 'Reviewed').length, 1);
  assert.equal(stored.pipelineEvents[0].firstReachedAt.toISOString(), first.pipelineEvents[0].firstReachedAt.toISOString());
  assert.equal(stored.updatedAt.toISOString(), first.updatedAt.toISOString());
});

test('local Mongo recordView leaves advanced stage match metadata and updatedAt unchanged', async (t) => {
  const fixture = await withViewRepository(t);
  if (!fixture) return;
  const { repository, StateModel } = fixture;
  const oldMatchAt = new Date('2026-10-01T08:00:00.000Z');
  const oldUpdatedAt = new Date('2026-10-01T09:00:00.000Z');
  await StateModel.collection.insertOne({
    _id: 'state-advanced',
    userId: actor.id,
    opportunityId: 'opp-advanced',
    profileId: activeProfile._id,
    pipelineStatus: 'Applied',
    favorite: true,
    hidden: false,
    archived: false,
    tags: ['priority'],
    matchScore: 41,
    matchComponents: { historical: 1 },
    matchCalculatedAt: oldMatchAt,
    responseState: { latestResponse: { draftId: 'draft-1' } },
    notes: [{ id: 'note-1', text: 'Keep', pinned: false }],
    checklist: [],
    pinned: false,
    pipelineEvents: [{ status: 'Applied', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }],
    createdAt: new Date('2026-10-01T07:00:00.000Z'),
    updatedAt: oldUpdatedAt,
  });

  const viewed = await repository.recordView(actor.id, 'opp-advanced', activeProfile._id, 'vacancy', {
    matchScore: 99,
    matchComponents: { new: 1 },
    matchCalculatedAt: new Date('2026-10-05T12:00:00.000Z'),
  });
  const stored = await StateModel.findById('state-advanced').lean();

  assert.equal(viewed.pipelineStatus, 'Applied');
  assert.equal(stored.pipelineStatus, 'Applied');
  assert.equal(stored.matchScore, 41);
  assert.deepEqual(stored.matchComponents, { historical: 1 });
  assert.equal(stored.matchCalculatedAt.toISOString(), oldMatchAt.toISOString());
  assert.equal(stored.updatedAt.toISOString(), oldUpdatedAt.toISOString());
  assert.deepEqual(stored.responseState, { latestResponse: { draftId: 'draft-1' } });
  assert.deepEqual(stored.tags, ['priority']);
  assert.equal(stored.pipelineEvents.some((event) => event.status === 'Reviewed'), false);
});

test('local Mongo simultaneous view and response handoff cannot regress or lose response state', async (t) => {
  const fixture = await withViewRepository(t);
  if (!fixture) return;
  const { repository, StateModel } = fixture;
  await StateModel.collection.insertOne({
    _id: 'state-race',
    userId: actor.id,
    opportunityId: 'opp-race',
    profileId: activeProfile._id,
    pipelineStatus: 'New',
    favorite: true,
    hidden: false,
    archived: false,
    tags: ['keep'],
    matchScore: 12,
    matchComponents: { old: 1 },
    responseState: { byFormat: {} },
    notes: [],
    checklist: [],
    pinned: false,
    pipelineEvents: [{ status: 'New', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }],
    createdAt: new Date('2026-10-01T07:00:00.000Z'),
    updatedAt: new Date('2026-10-01T09:00:00.000Z'),
  });

  await Promise.all([
    repository.recordView(actor.id, 'opp-race', activeProfile._id, 'vacancy', {
      matchScore: 88,
      matchComponents: { view: 1 },
      matchCalculatedAt: new Date('2026-10-05T12:00:00.000Z'),
    }),
    repository.recordResponseHandoff(actor.id, 'opp-race', activeProfile._id, 'vacancy', {
      format: 'cover_letter',
      pipelineStatus: 'Applied',
      updatedAt: '2026-10-05T12:30:00.000Z',
      latestResponse: { draftId: 'draft-1', status: 'sent' },
    }),
  ]);
  const stored = await StateModel.findById('state-race').lean();

  assert.equal(stored.pipelineStatus, 'Applied');
  assert.deepEqual(stored.tags, ['keep']);
  assert.equal(stored.favorite, true);
  assert.equal(stored.responseState.latestResponse.draftId, 'draft-1');
  assert.equal(stored.responseState.byFormat.cover_letter.draftId, 'draft-1');
  assert.equal(stored.pipelineEvents.some((event) => event.status === 'Applied'), true);
  assert.ok(stored.pipelineEvents.length <= 3);
});

test('local Mongo concurrent initial views produce one owned state without duplicate-key failures', async (t) => {
  const fixture = await withViewRepository(t);
  if (!fixture) return;
  const { repository, StateModel } = fixture;
  const start = startGate();

  const views = await Promise.allSettled(
    Array.from({ length: 5 }, async (_, index) => {
      await start.ready();
      return repository.recordView(actor.id, 'opp-initial-race', activeProfile._id, 'vacancy', {
        matchScore: 50 + index,
        matchComponents: { index },
        matchCalculatedAt: new Date(`2026-10-05T12:0${index}:00.000Z`),
      });
    }),
  );
  const stored = await StateModel.find({ userId: actor.id, opportunityId: 'opp-initial-race', profileId: activeProfile._id }).lean();

  assert.deepEqual(views.filter((result) => result.status === 'rejected').map(formatSettledRejection), []);
  assert.equal(views.filter((result) => result.status === 'fulfilled').length, 5);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].pipelineStatus, 'Reviewed');
  assert.equal(stored[0].pipelineEvents.filter((event) => event.status === 'Reviewed').length, 1);
});

test('local Mongo simultaneous initial view and response handoff keep one state and response data', async (t) => {
  const fixture = await withViewRepository(t);
  if (!fixture) return;
  const { repository, StateModel } = fixture;
  const start = startGate();

  const writes = await Promise.allSettled([
    ...Array.from({ length: 5 }, async (_, index) => {
      await start.ready();
      return repository.recordView(actor.id, 'opp-initial-handoff-race', activeProfile._id, 'vacancy', {
        matchScore: 60 + index,
        matchComponents: { index },
        matchCalculatedAt: new Date(`2026-10-05T13:0${index}:00.000Z`),
      });
    }),
    (async () => {
      await start.ready();
      return repository.recordResponseHandoff(actor.id, 'opp-initial-handoff-race', activeProfile._id, 'vacancy', {
        format: 'cover_letter',
        pipelineStatus: 'Applied',
        updatedAt: '2026-10-05T13:30:00.000Z',
        latestResponse: { draftId: 'draft-race', status: 'sent' },
      });
    })(),
  ]);
  const stored = await StateModel.find({ userId: actor.id, opportunityId: 'opp-initial-handoff-race', profileId: activeProfile._id }).lean();

  assert.deepEqual(writes.filter((result) => result.status === 'rejected').map(formatSettledRejection), []);
  assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 6);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].pipelineStatus, 'Applied');
  assert.equal(stored[0].responseState.latestResponse.draftId, 'draft-race');
  assert.equal(stored[0].responseState.byFormat.cover_letter.draftId, 'draft-race');
  assert.equal(stored[0].pipelineEvents.filter((event) => event.status === 'Applied').length, 1);
  assert.ok(stored[0].pipelineEvents.length <= 2);
});

function testMongoUri() {
  const base = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/intly';
  const url = new URL(base);
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol)) throw new Error(`opportunity view test refuses MongoDB protocol ${url.protocol}`);
  if (!loopback) throw new Error(`opportunity view test refuses non-loopback MongoDB host ${host}`);
  url.pathname = `/intly_opportunity_view_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  url.searchParams.set('serverSelectionTimeoutMS', '800');
  return url.toString();
}

function startGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  queueMicrotask(release);
  return { ready: () => promise };
}

function formatSettledRejection(result) {
  const error = result.reason;
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message,
    keyPattern: error?.keyPattern,
    keyValue: error?.keyValue,
  };
}

async function withViewRepository(t) {
  const uri = testMongoUri();
  let connection;
  try {
    connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 800 }).asPromise();
  } catch (error) {
    t.skip(`local Mongo unavailable for opportunity view proof: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  t.after(async () => {
    await connection.dropDatabase().catch(() => undefined);
    await connection.close().catch(() => undefined);
  });
  const collectionName = `opportunity_user_states_view_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const schema = OpportunityUserStateSchema.clone();
  schema.clearIndexes();
  schema.index({ userId: 1, opportunityId: 1, profileId: 1 }, { unique: true });
  const StateModel = connection.model(`${OpportunityUserState.name}_View_${Date.now()}_${Math.random().toString(16).slice(2)}`, schema, collectionName);
  await StateModel.init();
  return {
    repository: new OpportunityUserStatesRepository(StateModel),
    StateModel,
  };
}

class InMemoryProfiles {
  constructor(records) {
    this.records = records;
    this.getOwnedCalls = [];
    this.findActiveCalls = 0;
  }

  async findActive(userId) {
    this.findActiveCalls += 1;
    return this.records.find((profile) => profile.userId === userId && profile.isActive) ?? null;
  }

  async getOwned(id, userId) {
    this.getOwnedCalls.push({ id, userId });
    const profile = this.records.find((item) => item._id === id && item.userId === userId);
    if (!profile) throw new Error('Profile not found');
    return profile;
  }
}

class InMemoryStates {
  constructor(records) {
    this.records = records.map((record) => ({ ...record }));
    this.recordViewCalls = [];
  }

  async find(userId, opportunityId, profileId) {
    return this.records.find((record) => record.userId === userId && record.opportunityId === opportunityId && record.profileId === profileId) ?? null;
  }

  async upsert(input) {
    const existing = await this.find(input.userId, input.opportunityId, input.profileId);
    const event = { status: input.pipelineStatus ?? existing?.pipelineStatus ?? 'New', firstReachedAt: new Date('2026-10-05T10:00:00.000Z') };
    if (existing) {
      Object.assign(existing, input);
      if (!existing.pipelineEvents.some((item) => item.status === event.status)) existing.pipelineEvents.push(event);
      return existing;
    }
    const created = state({ ...input, pipelineEvents: [event] });
    this.records.push(created);
    return created;
  }

  async recordView(userId, opportunityId, profileId, type, payload) {
    this.recordViewCalls.push({ userId, opportunityId, profileId, type, payload });
    const existing = await this.find(userId, opportunityId, profileId);
    const patch = {
      matchScore: payload.matchScore,
      matchComponents: payload.matchComponents,
      matchCalculatedAt: payload.matchCalculatedAt,
    };
    if (existing) {
      if (existing.pipelineStatus === 'New') {
        Object.assign(existing, patch);
        existing.pipelineStatus = 'Reviewed';
        if (!existing.pipelineEvents.some((item) => item.status === 'Reviewed')) {
          existing.pipelineEvents.push({ status: 'Reviewed', firstReachedAt: new Date('2026-10-05T10:00:00.000Z') });
        }
      }
      return existing;
    }
    const created = state({
      userId,
      opportunityId,
      profileId,
      pipelineStatus: 'Reviewed',
      pipelineEvents: [{ status: 'Reviewed', firstReachedAt: new Date('2026-10-05T10:00:00.000Z') }],
      ...patch,
    });
    this.records.push(created);
    return created;
  }
}
