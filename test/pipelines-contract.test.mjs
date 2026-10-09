import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { plainToInstance } = require('class-transformer');
const { validateSync } = require('class-validator');
const { PipelinesService } = require('../src/modules/pipelines/pipelines.service.ts');
const { OpportunitiesService } = require('../src/modules/opportunities/opportunities.service.ts');
const { OpportunityUserStatesRepository } = require('../src/modules/opportunities/opportunity-user-states.repository.ts');
const { PIPELINE_DEFINITIONS } = require('../src/modules/opportunities/pipeline-definitions.ts');
const { PipelineQueryDto } = require('../src/modules/pipelines/dto/pipelines.dto.ts');
const { CalendarRepository } = require('../src/modules/calendar/calendar.repository.ts');
const { TasksService } = require('../src/modules/tasks/tasks.service.ts');

const actor = { id: 'user-1', role: 'User' };
const profile = { _id: 'profile-1', userId: 'user-1', isActive: true, targetRoles: [], technologies: [] };
const now = Date.now();

function opportunity(overrides = {}) {
  return {
    _id: overrides._id ?? 'opp-1',
    type: overrides.type ?? 'vacancy',
    title: overrides.title ?? 'Opportunity',
    companyOrClient: overrides.companyOrClient ?? 'Acme',
    firstSeenAt: overrides.firstSeenAt ?? new Date('2026-10-01T00:00:00.000Z'),
    sourceStatus: 'Active',
    sourceOccurrences: overrides.sourceOccurrences ?? [{ sourceId: 'hh' }],
    canonicalTags: overrides.canonicalTags ?? [],
    deadline: overrides.deadline,
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    _id: overrides._id ?? `state-${overrides.opportunityId ?? 'opp-1'}`,
    userId: overrides.userId ?? 'user-1',
    profileId: overrides.profileId ?? 'profile-1',
    opportunityId: overrides.opportunityId ?? 'opp-1',
    pipelineStatus: overrides.pipelineStatus ?? 'New',
    pipelineEvents: overrides.pipelineEvents ?? [{ status: overrides.pipelineStatus ?? 'New', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }],
    matchScore: overrides.matchScore ?? 50,
    tags: overrides.tags ?? [],
    favorite: false,
    hidden: false,
    archived: false,
    ...overrides,
  };
}

function harness({ opportunities = [], states = [], tasks = [], calendarEvents = [] } = {}) {
  const realtimeEvents = [];
  const repository = {
    states,
    async findByUserProfile(userId, profileId) {
      return this.states.filter((item) => item.userId === userId && (!profileId || item.profileId === profileId));
    },
    async upsert(input) {
      const existing = this.states.find((item) => item.userId === input.userId && item.profileId === input.profileId && item.opportunityId === input.opportunityId);
      const event = { status: input.pipelineStatus ?? existing?.pipelineStatus ?? 'New', firstReachedAt: new Date('2026-10-03T00:00:00.000Z') };
      if (existing) {
        Object.assign(existing, input, { pipelineEvents: existing.pipelineEvents.some((item) => item.status === event.status) ? existing.pipelineEvents : [...existing.pipelineEvents, event] });
        return existing;
      }
      const created = state({ ...input, pipelineEvents: [event] });
      this.states.push(created);
      return created;
    },
  };
  const opportunityRepository = {
    async findByIds(ids) { return opportunities.filter((item) => ids.includes(item._id)); },
    async getById(id) {
      const item = opportunities.find((candidate) => candidate._id === id);
      if (!item) throw new Error('not found');
      return item;
    },
    async latestCompletedAnalysisByOpportunity(input) {
      return opportunities
        .filter((item) => input.opportunityIds.includes(item._id))
        .filter((item) => typeof input.minAiScore !== 'number' || (item.aiScore ?? 0) >= input.minAiScore)
        .map((item) => ({ opportunityId: item._id, aiScore: item.aiScore ?? null, runId: `run-${item._id}`, taskType: 'opportunity_analysis' }));
    },
  };
  const profiles = {
    async findActive(userId) { return userId === profile.userId ? profile : null; },
    async getOwned(id, userId) {
      if (id !== profile._id || userId !== profile.userId) throw new Error('forbidden');
      return profile;
    },
    async getById(id) {
      if (id !== profile._id) throw new Error('not found');
      return profile;
    },
  };
  const realtime = { publish: (...args) => realtimeEvents.push(args) };
  const taskService = {
    attentionTasksForUser: async () => tasks.filter((task) => !task.completedAt),
    dueTasksForUser: async () => tasks.filter((task) => task.dueAt && !task.completedAt),
  };
  const calendarRepository = { list: async () => calendarEvents };
  return { service: new PipelinesService(repository, opportunityRepository, profiles, realtime, taskService, calendarRepository), repository, opportunityRepository, profiles, realtimeEvents };
}

test('pipeline board returns exact typed columns including empty stages', async () => {
  const { service } = harness({ opportunities: [opportunity({ _id: 'opp-tender', type: 'tender' })], states: [state({ opportunityId: 'opp-tender', pipelineStatus: 'PreparingApplication' })] });

  const board = await service.board(actor, { type: 'tender' });

  assert.equal(board.type, 'tender');
  assert.equal(board.profileId, 'profile-1');
  assert.deepEqual(board.columns.map((column) => column.stage), PIPELINE_DEFINITIONS.tender);
  assert.equal(board.columns.find((column) => column.stage === 'PreparingApplication').items.length, 1);
  assert.equal(board.columns.find((column) => column.stage === 'ApplicationSubmitted').items.length, 0);
});

test('pipeline writes validate canonical type-specific targets without sequential gate', async () => {
  const { service, realtimeEvents } = harness({ opportunities: [opportunity({ _id: 'opp-v', type: 'vacancy' })], states: [] });

  await assert.rejects(
    () => service.update(actor, 'opp-v', { profileId: 'profile-1', pipelineStatus: 'ResponseSent' }),
    (error) => error?.response?.code === 'PIPELINE_STATUS_INVALID',
  );
  const updated = await service.update(actor, 'opp-v', { profileId: 'profile-1', pipelineStatus: 'TechnicalInterview' });

  assert.equal(updated.state.pipelineStatus, 'TechnicalInterview');
  assert.equal(realtimeEvents[0][1], 'pipeline.changed');
  assert.equal(realtimeEvents[0][2].pipelineStatus, 'TechnicalInterview');
});

test('opportunity personal pipeline writes use the same canonical validation', async () => {
  const { repository, opportunityRepository, profiles } = harness({ opportunities: [opportunity({ _id: 'opp-f', type: 'freelance' })], states: [] });
  const service = new OpportunitiesService(opportunityRepository, repository, {}, {}, profiles, { calculate: () => ({ score: 77, components: {} }) });

  await assert.rejects(
    () => service.updatePersonal(actor, 'opp-f', { profileId: 'profile-1', pipelineStatus: 'Applied' }),
    (error) => error?.response?.code === 'PIPELINE_STATUS_INVALID',
  );
  const stateResult = await service.updatePersonal(actor, 'opp-f', { profileId: 'profile-1', pipelineStatus: 'ResponseSent' });

  assert.equal(stateResult.pipelineStatus, 'ResponseSent');
});

test('pipeline board normalizes legacy states without losing cards and reports unmapped raw values', async () => {
  const earliest = new Date('2026-09-20T00:00:00.000Z');
  const { service } = harness({
    opportunities: [opportunity({ _id: 'opp-f', type: 'freelance' }), opportunity({ _id: 'opp-bad', type: 'freelance' })],
    states: [
      state({ opportunityId: 'opp-f', pipelineStatus: 'Applied', pipelineEvents: [{ status: 'Applied', firstReachedAt: earliest }] }),
      state({ opportunityId: 'opp-bad', pipelineStatus: 'Interviewing', pipelineEvents: [{ status: 'Interviewing', firstReachedAt: earliest }] }),
    ],
  });

  const board = await service.board(actor, { type: 'freelance' });

  const responseSent = board.columns.find((column) => column.stage === 'ResponseSent').items[0];
  const fallbackNew = board.columns.find((column) => column.stage === 'New').items.find((item) => item.id === 'opp-bad');
  assert.equal(responseSent.state.rawPipelineStatus, 'Applied');
  assert.deepEqual(responseSent.suggestedActions, ['follow_up']);
  assert.ok(fallbackNew);
  assert.deepEqual(board.diagnostics.unmappedPipelineStatuses, [{ opportunityId: 'opp-bad', rawStatus: 'Interviewing' }]);
});

test('pipeline attention derives from linked tasks and deadlines, not stage alone, and suggestions do not mutate tasks', async () => {
  const tasks = [{ _id: 'task-1', opportunityId: 'opp-follow', profileId: 'profile-1', type: 'Follow-up', dueAt: new Date(now - 60_000), title: 'Follow up' }];
  const { service } = harness({
    opportunities: [
      opportunity({ _id: 'opp-stage-only', type: 'vacancy' }),
      opportunity({ _id: 'opp-follow', type: 'vacancy' }),
      opportunity({ _id: 'opp-deadline', type: 'tender', deadline: new Date(now + 2 * 86_400_000) }),
    ],
    states: [
      state({ opportunityId: 'opp-stage-only', pipelineStatus: 'Applied' }),
      state({ opportunityId: 'opp-follow', pipelineStatus: 'Applied' }),
      state({ opportunityId: 'opp-deadline', pipelineStatus: 'ApplicationSubmitted' }),
    ],
    tasks,
  });

  const vacancy = await service.board(actor, { type: 'vacancy', attention: 'all' });
  const stageOnly = vacancy.columns.find((column) => column.stage === 'Applied').items.find((item) => item.id === 'opp-stage-only');
  const follow = vacancy.columns.find((column) => column.stage === 'Applied').items.find((item) => item.id === 'opp-follow');
  const urgent = await service.board(actor, { type: 'tender', attention: 'deadline_urgent' });

  assert.deepEqual(stageOnly.attention, []);
  assert.deepEqual(stageOnly.suggestedActions, ['follow_up']);
  assert.deepEqual(follow.attention.sort(), ['follow_up_due', 'needs_attention', 'overdue']);
  assert.equal(vacancy.columns.find((column) => column.stage === 'Applied').attentionCount, 1);
  assert.deepEqual(urgent.columns.find((column) => column.stage === 'ApplicationSubmitted').items[0].attention, ['deadline_urgent']);
  assert.equal(tasks.length, 1);
});

test('pipeline board applies source score tag date counterpart attention and sort filters', async () => {
  const opportunities = [
    opportunity({ _id: 'low', type: 'vacancy', companyOrClient: 'Other', sourceOccurrences: [{ sourceId: 'hh' }], canonicalTags: ['backend'], firstSeenAt: new Date('2026-10-01T00:00:00.000Z'), aiScore: 60 }),
    opportunity({ _id: 'best', type: 'vacancy', companyOrClient: 'Acme Corp', sourceOccurrences: [{ sourceId: 'hh' }], canonicalTags: ['backend'], firstSeenAt: new Date('2026-10-02T00:00:00.000Z'), deadline: new Date(now + 2 * 86_400_000), aiScore: 95 }),
    opportunity({ _id: 'wrong-source', type: 'vacancy', companyOrClient: 'Acme Corp', sourceOccurrences: [{ sourceId: 'other' }], canonicalTags: ['backend'], firstSeenAt: new Date('2026-10-02T00:00:00.000Z'), aiScore: 99 }),
  ];
  const states = [
    state({ opportunityId: 'low', pipelineStatus: 'Applied', matchScore: 40, tags: ['priority'] }),
    state({ opportunityId: 'best', pipelineStatus: 'Applied', matchScore: 82, tags: ['priority'] }),
    state({ opportunityId: 'wrong-source', pipelineStatus: 'Applied', matchScore: 90, tags: ['priority'] }),
  ];
  const { service } = harness({ opportunities, states });

  const board = await service.board(actor, { type: 'vacancy', sourceIds: ['hh'], minMatch: 80, minAiScore: 90, tags: ['priority'], dateFrom: '2026-10-02', dateTo: '2026-10-02', counterpart: 'acme', attention: 'deadline_urgent', sort: 'score' });

  const applied = board.columns.find((column) => column.stage === 'Applied').items;
  assert.deepEqual(applied.map((item) => item.id), ['best']);
  assert.equal(applied[0].aiScore, 95);
});


test('pipeline DI metadata uses concrete task and calendar providers, not Object tokens', () => {
  const paramTypes = Reflect.getMetadata('design:paramtypes', PipelinesService);

  assert.equal(paramTypes[4], TasksService);
  assert.equal(paramTypes[5], CalendarRepository);
});

test('pipeline attention includes no-due reminders and calendar links while excluding completed tasks', async () => {
  const tasks = [
    { _id: 'task-reminder', opportunityId: 'opp-reminder', profileId: 'profile-1', type: 'Follow-up', reminders: [{ remindAt: new Date(now - 60_000) }], title: 'Reminder only' },
    { _id: 'task-complete', opportunityId: 'opp-complete', profileId: 'profile-1', type: 'Follow-up', dueAt: new Date(now - 60_000), completedAt: new Date(now - 30_000), title: 'Done' },
    { _id: 'task-calendar', opportunityId: 'opp-calendar-task', profileId: 'profile-1', type: 'Task', title: 'Linked calendar task' },
  ];
  const calendarEvents = [
    { _id: 'event-direct', userId: 'user-1', opportunityId: 'opp-calendar-direct', type: 'calendar_event', startAt: new Date(now + 60_000), reminders: [] },
    { _id: 'event-task', userId: 'user-1', taskId: 'task-calendar', type: 'calendar_event', startAt: new Date(now + 120_000), reminders: [] },
  ];
  const { service } = harness({
    opportunities: [
      opportunity({ _id: 'opp-reminder', type: 'vacancy' }),
      opportunity({ _id: 'opp-complete', type: 'vacancy' }),
      opportunity({ _id: 'opp-calendar-direct', type: 'vacancy' }),
      opportunity({ _id: 'opp-calendar-task', type: 'vacancy' }),
    ],
    states: [
      state({ opportunityId: 'opp-reminder', pipelineStatus: 'Applied' }),
      state({ opportunityId: 'opp-complete', pipelineStatus: 'Applied' }),
      state({ opportunityId: 'opp-calendar-direct', pipelineStatus: 'Applied' }),
      state({ opportunityId: 'opp-calendar-task', pipelineStatus: 'Applied' }),
    ],
    tasks,
    calendarEvents,
  });

  const board = await service.board(actor, { type: 'vacancy', attention: 'needs_attention' });
  const ids = board.columns.flatMap((column) => column.items).map((item) => item.id).sort();
  const reminder = board.columns.flatMap((column) => column.items).find((item) => item.id === 'opp-reminder');

  assert.deepEqual(ids, ['opp-calendar-direct', 'opp-calendar-task', 'opp-reminder']);
  assert.deepEqual(reminder.attention.sort(), ['follow_up_due', 'needs_attention', 'overdue']);
});

test('pipeline query dto rejects invalid numeric and date filter values', async () => {
  const invalidNumber = plainToInstance(PipelineQueryDto, { minMatch: 'text', minAiScore: 101 });
  const invalidDate = plainToInstance(PipelineQueryDto, { dateFrom: 'not-a-date' });
  const { service } = harness();

  assert.ok(validateSync(invalidNumber).length >= 2);
  assert.ok(validateSync(invalidDate).length >= 1);
  await assert.rejects(
    () => service.board(actor, { dateFrom: '2026-10-03', dateTo: '2026-10-02' }),
    (error) => error?.response?.code === 'PIPELINE_QUERY_INVALID',
  );
});



test('personal state upsert is atomic and appends firstReach without replacing concurrent events', async () => {
  const calls = [];
  const model = {
    findOne: () => { throw new Error('upsert must not pre-read state'); },
    findOneAndUpdate: async (...args) => {
      calls.push(args);
      return {
        _id: 'state-1',
        userId: 'user-1',
        opportunityId: 'opp-1',
        profileId: 'profile-1',
        pipelineStatus: 'Reviewed',
        pipelineEvents: [
          { status: 'ApplicationSubmitted', firstReachedAt: new Date('2026-10-03T09:00:00.000Z') },
          { status: 'Reviewed', firstReachedAt: new Date('2026-10-03T10:00:00.000Z') },
        ],
      };
    },
  };
  const repository = new OpportunityUserStatesRepository(model);

  const result = await repository.upsert({
    userId: 'user-1',
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    pipelineStatus: 'Reviewed',
    tags: ['$salary'],
    notes: [{ id: 'note-1', text: '$company', pinned: false }],
    matchComponents: { '$score': 90, source: '$provider' },
  });

  assert.equal(result.pipelineEvents.length, 2);
  assert.equal(calls.length, 1);
  const [filter, update, options] = calls[0];
  assert.deepEqual(filter, { userId: 'user-1', opportunityId: 'opp-1', profileId: 'profile-1', deletedAt: { $exists: false } });
  assert.equal(options.updatePipeline, true);
  const set = update[0].$set;
  assert.equal(set.pipelineStatus, 'Reviewed');
  assert.deepEqual(set.tags, { $literal: ['$salary'] });
  assert.deepEqual(set.notes, { $literal: [{ id: 'note-1', text: '$company', pinned: false }] });
  assert.deepEqual(set.matchComponents, { $literal: { '$score': 90, source: '$provider' } });
  assert.deepEqual(set.pipelineEvents.$let.in.$cond[0], { $in: ['Reviewed', { $map: { input: '$$currentEvents', as: 'event', in: '$$event.status' } }] });
  assert.deepEqual(set.pipelineEvents.$let.in.$cond[1], '$$currentEvents');
  assert.deepEqual(set.pipelineEvents.$let.in.$cond[2].$concatArrays[0], '$$currentEvents');
});

test('response handoff repository helper uses one owner-scoped atomic merge without regressing later stages', async () => {
  const calls = [];
  const model = {
    findOneAndUpdate: async (...args) => {
      calls.push(args);
      return { _id: 'state-1', userId: 'user-1', opportunityId: 'opp-1', profileId: 'profile-1', pipelineStatus: 'Offer', responseState: { byFormat: {} } };
    },
  };
  const repository = new OpportunityUserStatesRepository(model);

  const result = await repository.recordResponseHandoff('user-1', 'opp-1', 'profile-1', 'vacancy', {
    format: 'cover_letter',
    pipelineStatus: 'Applied',
    updatedAt: '2026-10-03T10:00:00.000Z',
    latestResponse: { draftId: 'draft-1', status: 'sent' },
  });

  assert.equal(result.pipelineStatus, 'Offer');
  assert.equal(calls.length, 1);
  const [filter, update, options] = calls[0];
  assert.deepEqual(filter, { userId: 'user-1', opportunityId: 'opp-1', profileId: 'profile-1', deletedAt: { $exists: false } });
  assert.equal(Array.isArray(update), true);
  assert.equal(options.upsert, true);
  assert.equal(options.new, true);
  assert.equal(options.updatePipeline, true);
  const set = update[0].$set;
  assert.ok(set._id.$ifNull[1]);
  assert.deepEqual(set.favorite, { $ifNull: ['$favorite', false] });
  assert.deepEqual(set.tags, { $ifNull: ['$tags', []] });
  assert.deepEqual(set.pipelineStatus.$cond[0], { $gt: [3, set.pipelineStatus.$cond[0].$gt[1]] });
  assert.equal(set.pipelineStatus.$cond[0].$gt[1].$switch.branches.find((branch) => branch.then === 7).case.$in[1].includes('Won'), true);
  assert.equal(set.pipelineStatus.$cond[1], 'Applied');
  assert.ok(set.responseState.$let.in.$mergeObjects[1].byFormat.$mergeObjects[1].cover_letter);
  assert.equal(set.pipelineEvents.$let.vars.currentRank.$switch.branches.find((branch) => branch.then === 7).case.$in[1].includes('Won'), true);
  assert.deepEqual(set.pipelineEvents.$let.in.$cond[0].$and[0], { $gt: [3, '$$currentRank'] });
  assert.deepEqual(set.pipelineEvents.$let.in.$cond[1].$concatArrays[1][0], { status: 'Applied', firstReachedAt: new Date('2026-10-03T10:00:00.000Z') });
});
