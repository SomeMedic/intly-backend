import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { WatchlistsService } = require('../src/modules/watchlists/watchlists.service.ts');
const { SavedViewsService } = require('../src/modules/saved-views/saved-views.service.ts');
const { TasksService } = require('../src/modules/tasks/tasks.service.ts');
const { AnalyticsService } = require('../src/modules/analytics/analytics.service.ts');
const { CalendarService } = require('../src/modules/calendar/calendar.service.ts');

const user = { id: 'user-1', email: 'user@example.test', role: 'User' };

describe('workflow modules', () => {
  it('creates profile-bound watchlists with auto AI off unless explicitly enabled', async () => {
    const repository = new InMemoryWatchlistsRepository();
    const service = new WatchlistsService(repository, new InMemoryProfilesRepository(), new InMemoryRealtime(), new InMemoryUsersRepository());

    const created = await service.create(user, {
      name: 'Remote Nest',
      profileId: 'profile-1',
      filters: { type: 'vacancy' },
    });

    assert.equal(created.autoAiRules.enabled, false);
    assert.equal(created.active, true);
    assert.equal(repository.records[0].profileId, 'profile-1');
  });


  it('evaluates watchlists and enqueues optional AutoAI through the real AI service', async () => {
    const repository = new InMemoryWatchlistsRepository();
    repository.records.push({
      _id: 'watch-1',
      userId: 'user-1',
      profileId: 'profile-1',
      name: 'AI watch',
      filters: { type: 'vacancy', sourceIds: ['hh'] },
      matchMin: 1,
      autoAiRules: { enabled: true, dailyMax: 1 },
      active: true,
    });
    const ai = new InMemoryAiService();
    const service = new WatchlistsService(repository, new InMemoryProfilesRepository(), new InMemoryRealtime(), new InMemoryUsersRepository(), new InMemoryMatchingService(), ai);

    const result = await service.evaluateOpportunity({
      _id: 'opp-1',
      type: 'vacancy',
      sourceOccurrences: [{ sourceId: 'hh' }],
      technologies: ['NestJS'],
      skills: ['TypeScript'],
    });

    assert.equal(result.hits, 1);
    assert.equal(result.autoAiQueued, 1);
    assert.equal(ai.runs[0].opportunityId, 'opp-1');
  });

  it('records historical watchlist hits without alerts, webhooks, or AutoAI', async () => {
    const repository = new InMemoryWatchlistsRepository();
    repository.records.push({
      _id: 'watch-1',
      userId: 'user-1',
      profileId: 'profile-1',
      name: 'Historical watch',
      filters: { query: 'Python', remoteType: 'remote' },
      autoAiRules: { enabled: true, dailyMax: 10 },
      notificationPolicy: { inApp: true, email: true, telegram: true, mode: 'instant' },
      active: true,
    });
    const realtime = new InMemoryRealtime();
    const notifications = new InMemoryNotificationsService();
    const webhooks = new InMemoryWebhooksService();
    const ai = new InMemoryAiService();
    const service = new WatchlistsService(repository, new InMemoryProfilesRepository(), realtime, new InMemoryUsersRepository(), new InMemoryMatchingService(), ai, notifications, webhooks);

    const result = await service.evaluateOpportunity(opportunity({ title: 'Senior Python API', remoteType: 'remote' }), { effectMode: 'historical', sourceRunId: 'run-1' });

    assert.equal(result.hits, 1);
    assert.equal(result.autoAiQueued, 0);
    assert.equal(repository.hits[0].notificationState, 'suppressed_historical');
    assert.deepEqual(realtime.events, []);
    assert.deepEqual(notifications.sent, []);
    assert.deepEqual(webhooks.sent, []);
    assert.deepEqual(ai.runs, []);
  });

  it('emits one fresh watchlist alert per rule and opportunity pair', async () => {
    const repository = new InMemoryWatchlistsRepository();
    repository.records.push({
      _id: 'watch-1',
      userId: 'user-1',
      profileId: 'profile-1',
      name: 'Fresh watch',
      filters: { query: 'Python', remoteType: 'remote' },
      autoAiRules: { enabled: false },
      notificationPolicy: { inApp: true, email: true, mode: 'daily' },
      active: true,
    });
    const realtime = new InMemoryRealtime();
    const notifications = new InMemoryNotificationsService();
    const service = new WatchlistsService(repository, new InMemoryProfilesRepository(), realtime, new InMemoryUsersRepository(), new InMemoryMatchingService(), undefined, notifications);

    await service.evaluateOpportunity(opportunity({ _id: 'opp-once', title: 'Python platform', remoteType: 'remote' }), { effectMode: 'fresh' });
    await service.evaluateOpportunity(opportunity({ _id: 'opp-once', title: 'Python platform', remoteType: 'remote' }), { effectMode: 'fresh' });

    assert.equal(repository.hits.length, 1);
    assert.equal(realtime.events.length, 1);
    assert.equal(notifications.sent.length, 1);
    assert.equal(notifications.sent[0].idempotencyKey, 'watchlist.hit:watch-1:opp-once');
    assert.equal(notifications.sent[0].channels.email, true);
    assert.equal(notifications.sent[0].mode, 'daily');
    assert.equal(repository.hits[0].notificationState, 'notified');
  });


  it('skips watchlist matching side effects for non-active or missing owners', async () => {
    for (const status of ['Disabled', 'Locked', 'Invited', 'Deleted', 'missing']) {
      const repository = new InMemoryWatchlistsRepository();
      repository.records.push({
        _id: `watch-${status}`,
        userId: 'user-1',
        profileId: 'profile-1',
        name: `${status} owner watch`,
        filters: { query: 'Python' },
        autoAiRules: { enabled: true },
        notificationPolicy: { inApp: true, email: true, telegram: true, mode: 'instant' },
        active: true,
      });
      const realtime = new InMemoryRealtime();
      const notifications = new InMemoryNotificationsService();
      const webhooks = new InMemoryWebhooksService();
      const ai = new InMemoryAiService();
      const users = new InMemoryUsersRepository(status === 'missing' ? {} : { 'user-1': { _id: 'user-1', status } });
      const service = new WatchlistsService(
        repository,
        new InMemoryProfilesRepository(),
        realtime,
        users,
        new InMemoryMatchingService(),
        ai,
        notifications,
        webhooks,
        undefined,
        undefined,
      );

      const result = await service.evaluateOpportunity(opportunity({ _id: `inactive-${status}`, title: 'Python platform' }), { effectMode: 'fresh' });

      assert.deepEqual(result, { evaluated: 0, hits: 0, autoAiQueued: 0 });
      assert.deepEqual(repository.hits, []);
      assert.deepEqual(realtime.events, []);
      assert.deepEqual(notifications.sent, []);
      assert.deepEqual(webhooks.sent, []);
      assert.deepEqual(ai.runs, []);
    }
  });

  it('retries pending watchlist notification after a notify failure without cloning hits', async () => {
    const repository = new InMemoryWatchlistsRepository();
    repository.records.push({
      _id: 'watch-1',
      userId: 'user-1',
      profileId: 'profile-1',
      name: 'Retry watch',
      filters: { query: 'Python' },
      autoAiRules: { enabled: false },
      active: true,
    });
    const realtime = new InMemoryRealtime();
    const notifications = new InMemoryNotificationsService();
    notifications.failNext = true;
    const service = new WatchlistsService(repository, new InMemoryProfilesRepository(), realtime, new InMemoryUsersRepository(), new InMemoryMatchingService(), undefined, notifications);

    await assert.rejects(() => service.evaluateOpportunity(opportunity({ _id: 'retry-opp', title: 'Python retry' }), { effectMode: 'fresh' }), /notification failed/);
    assert.equal(repository.hits.length, 1);
    assert.equal(repository.hits[0].notificationState, 'pending');

    await service.evaluateOpportunity(opportunity({ _id: 'retry-opp', title: 'Python retry' }), { effectMode: 'fresh' });

    assert.equal(repository.hits.length, 1);
    assert.equal(notifications.sent.length, 1);
    assert.equal(realtime.events.length, 1);
    assert.equal(repository.hits[0].notificationState, 'notified');
  });

  it('applies query remote profile source exclusions and existing AI score filters', async () => {
    const repository = new InMemoryWatchlistsRepository();
    repository.records.push({
      _id: 'watch-1',
      userId: 'user-1',
      profileId: 'profile-1',
      name: 'Filtered watch',
      filters: { query: 'Python', remoteType: 'remote' },
      exclusions: { companies: ['Blocked LLC'], keywords: ['agency'] },
      aiMin: 80,
      autoAiRules: { enabled: false },
      active: true,
    });
    const opportunities = new InMemoryOpportunitiesRepository();
    const service = new WatchlistsService(repository, new InMemoryProfilesRepository({ sourceIds: ['hh'] }), new InMemoryRealtime(), new InMemoryUsersRepository(), new InMemoryMatchingService(), undefined, new InMemoryNotificationsService(), undefined, undefined, opportunities);

    assert.equal((await service.evaluateOpportunity(opportunity({ _id: 'wrong-remote', title: 'Python', remoteType: 'office', sourceOccurrences: [{ sourceId: 'hh' }] }))).hits, 0);
    assert.equal((await service.evaluateOpportunity(opportunity({ _id: 'wrong-source', title: 'Python', remoteType: 'remote', sourceOccurrences: [{ sourceId: 'other' }] }))).hits, 0);
    assert.equal((await service.evaluateOpportunity(opportunity({ _id: 'blocked-company', title: 'Python', companyOrClient: 'Blocked LLC', remoteType: 'remote', sourceOccurrences: [{ sourceId: 'hh' }] }))).hits, 0);
    opportunities.aiRows.push({ userId: 'user-1', profileId: 'profile-1', opportunityId: 'accepted', taskType: 'opportunity_analysis', status: 'completed', aiScore: 85 });
    assert.equal((await service.evaluateOpportunity(opportunity({ _id: 'accepted', title: 'Python API', remoteType: 'remote', sourceOccurrences: [{ sourceId: 'hh' }] }))).hits, 1);
  });

  it('clears optional AutoAI daily cap with null while preserving other flags', async () => {
    const repository = new InMemoryWatchlistsRepository();
    repository.records.push({
      _id: 'watch-1',
      userId: 'user-1',
      profileId: 'profile-1',
      name: 'AI cap',
      filters: {},
      autoAiRules: { enabled: true, dailyMax: 3, rerunOnMaterialChange: false },
      active: true,
    });
    const service = new WatchlistsService(repository, new InMemoryProfilesRepository(), new InMemoryRealtime(), new InMemoryUsersRepository());

    const updated = await service.update(user, 'watch-1', { autoAiRules: { dailyMax: null } });

    assert.equal(updated.autoAiRules.enabled, true);
    assert.equal(updated.autoAiRules.dailyMax, undefined);
    assert.equal(updated.autoAiRules.rerunOnMaterialChange, false);
  });

  it('keeps one saved view default per user and scope', async () => {
    const repository = new InMemorySavedViewsRepository();
    const service = new SavedViewsService(repository);

    const first = await service.create(user, { name: 'A', scope: 'opportunities', isDefault: true });
    const second = await service.create(user, { name: 'B', scope: 'opportunities', isDefault: true });

    assert.equal(repository.records.find((item) => item._id === first.id).isDefault, false);
    assert.equal(repository.records.find((item) => item._id === second.id).isDefault, true);
  });


  it('duplicates admin-accessed saved views for the actor with a Russian copy name', async () => {
    const repository = new InMemorySavedViewsRepository();
    const service = new SavedViewsService(repository);
    repository.records.push({ _id: 'view-foreign', userId: 'user-2', name: 'Исходный фильтр', scope: 'opportunities', query: { type: 'vacancy' }, filters: {}, sort: {}, isDefault: true, pinned: true });

    const duplicate = await service.duplicate({ id: 'admin-1', email: 'admin@example.test', role: 'Admin' }, 'view-foreign');

    assert.equal(duplicate.userId, 'admin-1');
    assert.equal(duplicate.name, 'Исходный фильтр — копия');
    assert.equal(duplicate.isDefault, false);
    assert.equal(repository.records.find((item) => item._id === 'view-foreign').userId, 'user-2');
  });

  it('allows only the saved view owner to set a default view', async () => {
    const repository = new InMemorySavedViewsRepository();
    const service = new SavedViewsService(repository);
    repository.records.push({ _id: 'view-foreign', userId: 'user-2', name: 'Foreign', scope: 'opportunities', query: {}, filters: {}, sort: {}, isDefault: false });

    await assert.rejects(
      () => service.setDefault({ id: 'admin-1', email: 'admin@example.test', role: 'Admin' }, 'view-foreign'),
      /Only the saved view owner/,
    );
    await assert.rejects(
      () => service.update({ id: 'admin-1', email: 'admin@example.test', role: 'Admin' }, 'view-foreign', { isDefault: true }),
      /Only the saved view owner/,
    );
    assert.equal(repository.records.find((item) => item._id === 'view-foreign').isDefault, false);
  });

  it('allows board participants to create tasks and publishes to owner and members', async () => {
    const repository = new InMemoryTasksRepository();
    const realtime = new InMemoryRealtime();
    const service = new TasksService(repository, realtime);
    repository.boards.push({
      _id: 'board-1',
      ownerUserId: 'owner-1',
      name: 'Shared board',
      members: ['user-1'],
      columns: [{ id: 'todo', name: 'To do', order: 1 }],
      scope: 'shared',
    });

    const task = await service.createTask(user, {
      boardId: 'board-1',
      title: 'Prepare response',
      statusColumnId: 'todo',
    });

    assert.equal(task.title, 'Prepare response');
    assert.equal(task.assigneeId, undefined);
    assert.deepEqual(realtime.events.map((event) => event.userId).sort(), ['owner-1', 'user-1']);
  });

  it('creates public tasks with due date assignee and normalized checklist defaults', async () => {
    const repository = new InMemoryTasksRepository();
    const service = new TasksService(repository, new InMemoryRealtime());
    repository.boards.push({
      _id: 'board-1',
      ownerUserId: 'owner-1',
      name: 'Shared board',
      members: ['user-1'],
      columns: [{ id: 'todo', name: 'To do', order: 1 }],
      scope: 'shared',
    });

    const task = await service.createTask(user, {
      boardId: 'board-1',
      title: 'QA follow-up',
      statusColumnId: 'todo',
      assigneeId: 'user-1',
      dueAt: '2026-10-03T12:30',
      checklist: [{ text: 'Verify browser proof' }],
      subtasks: [{ title: 'Collect evidence' }],
    });

    assert.equal(task.assigneeId, 'user-1');
    assert.equal(new Date(task.dueAt).toISOString(), new Date('2026-10-03T12:30').toISOString());
    assert.equal(typeof task.checklist[0].id, 'string');
    assert.notEqual(task.checklist[0].id, '');
    assert.equal(task.checklist[0].completed, false);
    assert.equal(typeof task.subtasks[0].id, 'string');
    assert.notEqual(task.subtasks[0].id, '');
    assert.equal(task.subtasks[0].completed, false);
  });


  it('rejects task assignees outside the board participants', async () => {
    const repository = new InMemoryTasksRepository();
    const service = new TasksService(repository, new InMemoryRealtime());
    repository.boards.push({
      _id: 'board-1',
      ownerUserId: 'owner-1',
      name: 'Shared board',
      members: ['user-1'],
      columns: [{ id: 'todo', name: 'To do', order: 1 }],
      scope: 'shared',
    });

    await assert.rejects(
      () => service.createTask(user, { boardId: 'board-1', title: 'Bad assignee', statusColumnId: 'todo', assigneeId: 'outsider' }),
      /board participant/,
    );
  });

  it('checks linked task access before creating calendar events', async () => {
    const tasks = {
      async getTask() {
        throw new Error('Board access denied');
      },
      async dueTasksForUser() {
        return [];
      },
    };
    const calendar = new CalendarService(new InMemoryCalendarRepository(), tasks, new InMemoryRealtime());

    await assert.rejects(
      () => calendar.create(user, { type: 'manual', title: 'Call', startAt: new Date().toISOString(), taskId: 'task-1' }),
      /Board access denied/,
    );
  });

  it('preserves calendar metadata and reminders on partial updates', async () => {
    const repository = new InMemoryCalendarRepository();
    const calendar = new CalendarService(repository, new InMemoryTasksService(), new InMemoryRealtime());
    const created = await calendar.create(user, {
      type: 'follow_up',
      title: 'Initial call',
      startAt: '2026-10-02T10:00:00.000Z',
      metadata: { notes: 'keep me' },
      reminders: [{ id: 'rem-1', remindAt: '2026-10-02T09:00:00.000Z', channels: ['inApp'] }],
    });

    const updated = await calendar.update(user, created.id, { title: 'Renamed call' });

    assert.equal(updated.title, 'Renamed call');
    assert.deepEqual(updated.metadata, { notes: 'keep me' });
    assert.equal(updated.reminders.length, 1);
    assert.equal(updated.reminders[0].id, 'rem-1');
  });

  it('rejects calendar events whose end is not after start', async () => {
    const calendar = new CalendarService(new InMemoryCalendarRepository(), new InMemoryTasksService(), new InMemoryRealtime());

    await assert.rejects(
      () => calendar.create(user, { type: 'call', title: 'Bad range', startAt: '2026-10-02T10:00:00.000Z', endAt: '2026-10-02T09:59:00.000Z' }),
      /end must be after start/,
    );
  });

  it('checks linked task access before editing calendar reminders', async () => {
    const repository = new InMemoryCalendarRepository();
    repository.records.push({ _id: 'event-1', userId: user.id, type: 'call', title: 'Linked', startAt: new Date('2026-10-02T10:00:00.000Z'), taskId: 'task-1', metadata: {}, reminders: [] });
    const tasks = {
      async getTask() {
        throw new Error('Board access denied');
      },
      async dueTasksForUser() {
        return [];
      },
    };
    const calendar = new CalendarService(repository, tasks, new InMemoryRealtime());

    await assert.rejects(
      () => calendar.createReminder(user, 'event-1', { remindAt: '2026-10-02T09:30:00.000Z', channels: ['inApp'] }),
      /Board access denied/,
    );
  });

  it('persists and schedules pending calendar reminders', async () => {
    const repository = new InMemoryCalendarRepository();
    const jobs = new InMemoryJobsService();
    const calendar = new CalendarService(repository, new InMemoryTasksService(), new InMemoryRealtime(), jobs);
    const created = await calendar.create(user, { type: 'call', title: 'Reminder call', startAt: '2026-10-02T10:00:00.000Z' });

    const updated = await calendar.createReminder(user, created.id, { remindAt: '2026-10-02T09:30:00.000Z', channels: ['inApp', 'email'] });

    assert.equal(updated.reminders.length, 1);
    assert.equal(updated.reminders[0].channels[1], 'email');
    assert.equal(jobs.enqueued[0].queue, 'notifications');
    assert.equal(jobs.enqueued[0].name, 'calendar.reminder');
  });

  it('builds personal analytics from first reached pipeline events', async () => {
    const service = new AnalyticsService(new InMemoryStatesRepository(), new InMemoryOpportunitiesRepository());

    const analytics = await service.personal(user, { period: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z' });

    assert.deepEqual(
      analytics.funnel.filter((item) => item.count > 0).map((item) => [item.status, item.count]),
      [
        ['Reviewed', 1],
        ['Applied', 1],
      ],
    );
    assert.equal(analytics.totals.tracked, 1);
  });
});

class InMemoryRealtime {
  events = [];
  publish(userId, type, payload) {
    this.events.push({ userId, type, payload });
  }
}

class InMemoryProfilesRepository {
  constructor(overrides = {}) {
    this.overrides = overrides ?? {};
  }

  async getOwned(id) {
    return { _id: id, userId: user.id };
  }
  async findById(id) {
    return { _id: id, userId: user.id, technologies: ['NestJS'], skills: ['TypeScript'], sourceIds: [], matchWeights: {}, ...this.overrides };
  }
}

class InMemoryWatchlistsRepository {
  records = [];
  hits = [];
  async create(input) {
    const record = { _id: `watch-${this.records.length + 1}`, ...input };
    this.records.push(record);
    return record;
  }
  async listActive() {
    return this.records.filter((record) => record.active);
  }
  async getById(id) {
    const record = this.records.find((item) => item._id === id);
    if (!record) throw new Error('Watchlist not found');
    return record;
  }
  async update(id, input) {
    const record = await this.getById(id);
    Object.assign(record, input);
    return record;
  }
  async recordHit(input) {
    const existing = this.hits.find((hit) => hit.watchlistId === input.watchlistId && hit.opportunityId === input.opportunityId);
    if (existing) return { ...existing, newlyCreated: false };
    const hit = { _id: `hit-${this.hits.length + 1}`, ...input };
    this.hits.push(hit);
    return { ...hit, newlyCreated: true };
  }
  async countAutoAiQueuedSince() {
    return 0;
  }
  async markAutoAiQueued(hitId, aiRunId) {
    const hit = this.hits.find((item) => item._id === hitId);
    hit.aiRunId = aiRunId;
    hit.autoAiState = 'queued';
  }
  async markNotificationState(hitId, notificationState) {
    const hit = this.hits.find((item) => item._id === hitId);
    hit.notificationState = notificationState;
  }
}

class InMemoryMatchingService {
  calculate() {
    return { score: 75, components: {} };
  }
}

class InMemoryAiService {
  runs = [];
  async runOpportunityAnalysis(_actor, dto) {
    this.runs.push(dto);
    return { _id: `ai-${this.runs.length}`, ...dto };
  }
}

class InMemoryNotificationsService {
  sent = [];
  async notify(input) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('notification failed');
    }
    this.sent.push(input);
    return { _id: `notification-${this.sent.length}`, ...input, newlyCreated: true };
  }
}

class InMemoryWebhooksService {
  sent = [];
  async emit(userId, type, payload) {
    this.sent.push({ userId, type, payload });
  }
}


class InMemoryUsersRepository {
  constructor(records = { 'user-1': { _id: 'user-1', status: 'Active' } }) {
    this.records = records;
  }

  async findById(id) {
    return this.records[id] ?? null;
  }
}

class InMemorySavedViewsRepository {
  records = [];
  async create(input) {
    const record = { _id: `view-${this.records.length + 1}`, ...input };
    this.records.push(record);
    return record;
  }
  async getById(id) {
    const record = this.records.find((item) => item._id === id);
    if (!record) throw new Error('Saved view not found');
    return record;
  }
  async update(id, input) {
    const record = await this.getById(id);
    Object.assign(record, input);
    return record;
  }
  async clearDefault(userId, scope) {
    for (const record of this.records) {
      if (record.userId === userId && record.scope === scope) record.isDefault = false;
    }
  }
}

class InMemoryTasksRepository {
  boards = [];
  tasks = [];
  async getBoard(id) {
    const board = this.boards.find((item) => item._id === id);
    if (!board) throw new Error('Board not found');
    return board;
  }
  async createTask(input) {
    const task = { _id: `task-${this.tasks.length + 1}`, ...input };
    this.tasks.push(task);
    return task;
  }
}

class InMemoryStatesRepository {
  async findByUserProfile() {
    return [
      {
        _id: 'state-1',
        opportunityId: 'opp-1',
        pipelineStatus: 'Applied',
        pipelineEvents: [
          { status: 'Reviewed', firstReachedAt: new Date('2026-10-02T10:00:00.000Z') },
          { status: 'Applied', firstReachedAt: new Date('2026-10-02T11:00:00.000Z') },
        ],
      },
    ];
  }
}

class InMemoryOpportunitiesRepository {
  aiRows = [];

  async findByIds() {
    return [{ _id: 'opp-1', type: 'vacancy', technologies: ['NestJS'], sourceOccurrences: [{ sourceId: 'hh' }] }];
  }

  async latestCompletedAnalysisByOpportunity(input) {
    return this.aiRows
      .filter((row) => row.userId === input.userId)
      .filter((row) => !input.profileId || row.profileId === input.profileId)
      .filter((row) => !input.opportunityIds?.length || input.opportunityIds.includes(row.opportunityId));
  }
}

function opportunity(overrides = {}) {
  return {
    _id: 'opp-1',
    type: 'vacancy',
    title: 'Remote Python engineer',
    companyOrClient: 'Acme',
    description: '',
    remoteType: 'remote',
    sourceOccurrences: [{ sourceId: 'hh' }],
    technologies: ['Python'],
    skills: ['Python'],
    canonicalTags: [],
    ...overrides,
  };
}

class InMemoryTasksService {
  async getTask(_actor, id) {
    return { _id: id, boardId: 'board-1' };
  }
  async dueTasksForUser() {
    return [];
  }
}

class InMemoryJobsService {
  enqueued = [];
  registerHandler(queue, name, handler) {
    this.handler = { queue, name, handler };
  }
  async enqueue(queue, name, data, options) {
    this.enqueued.push({ queue, name, data, options });
    return { id: String(this.enqueued.length), queue };
  }
}

class InMemoryCalendarRepository {
  records = [];
  async create(input) {
    const record = { _id: `event-${this.records.length + 1}`, metadata: {}, reminders: [], ...input };
    this.records.push(record);
    return record;
  }
  async get(id) {
    const record = this.records.find((item) => item._id === id);
    if (!record) throw new Error('Calendar event not found');
    return record;
  }
  async update(id, patch) {
    const record = await this.get(id);
    Object.assign(record, patch);
    return record;
  }
  async softDelete(id) {
    const record = await this.get(id);
    record.deletedAt = new Date();
  }
}
