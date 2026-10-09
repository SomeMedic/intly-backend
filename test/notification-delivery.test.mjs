import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it, test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { NotificationsService } = require('../src/modules/notifications/notifications.service.ts');
const { NotificationsRepository } = require('../src/modules/notifications/notifications.repository.ts');
const { validateNotificationSettingsPatch } = require('../src/modules/notifications/dto/notification.dto.ts');

describe('notification delivery routing', () => {
  it('computes overnight quiet hours in the user timezone and queues until the configured end', () => {
    const { service } = makeService();
    const delay = service.quietHoursDelayMs(
      { start: '23:00', end: '08:00', timezone: 'Europe/Moscow' },
      'UTC',
      new Date('2026-10-03T21:30:00.000Z'),
    );

    assert.equal(delay, 7.5 * 60 * 60 * 1000);
  });

  it('applies per-category channel overrides and schedules a grouped digest job', async () => {
    const { jobs, realtime, repo, service } = makeService({
      user: {
        notificationSettings: {
          inApp: true,
          email: true,
          telegram: false,
          digestMode: 'weekly',
          eventChannels: {
            ai: { email: false, telegram: true, mode: 'digest' },
          },
        },
      },
    });

    const notification = await service.notify({
      userId: 'user-1',
      type: 'resume.adaptation.ready',
      title: 'Resume ready',
      data: { opportunityId: 'opp-1' },
    });

    assert.equal(notification.category, 'ai');
    assert.equal(notification.deliveries.length, 1);
    assert.equal(notification.deliveries[0].channel, 'telegram');
    assert.equal(notification.deliveries[0].mode, 'weekly');
    assert.match(notification.deliveries[0].digestKey, /^weekly:/);
    assert.equal(jobs.enqueued.length, 1);
    assert.equal(jobs.enqueued[0].name, 'notification.digest');
    assert.equal(jobs.enqueued[0].data.channel, 'telegram');
    assert.equal(realtime.published.length, 1);
    assert.equal(repo.notifications.get(notification._id).deliveries[0].channel, 'telegram');
  });

  it('reuses idempotent notifications and re-enqueues queued deliveries without repeating realtime', async () => {
    const { jobs, realtime, repo, service } = makeService({
      user: { notificationSettings: { inApp: true, email: true, telegram: false, digestMode: 'instant' } },
    });

    const first = await service.notify({
      userId: 'user-1',
      type: 'watchlist.hit',
      title: 'Watch hit',
      data: { watchlistId: 'watch-1', opportunityId: 'opp-1' },
      idempotencyKey: 'watchlist.hit:watch-1:opp-1',
    });
    const second = await service.notify({
      userId: 'user-1',
      type: 'watchlist.hit',
      title: 'Watch hit',
      data: { watchlistId: 'watch-1', opportunityId: 'opp-1' },
      idempotencyKey: 'watchlist.hit:watch-1:opp-1',
    });

    assert.equal(first._id, second._id);
    assert.equal(repo.notifications.size, 1);
    assert.equal(realtime.published.length, 1);
    assert.equal(jobs.enqueued.length, 2);
    assert.deepEqual(jobs.enqueued.map((job) => job.opts.jobId), [`notification:${first._id}`, `notification:${first._id}`]);
  });

  it('re-checks preferences at dispatch and skips disabled external channels without repeating sent deliveries', async () => {
    const queuedAt = new Date('2026-10-03T10:00:00.000Z');
    const { repo, service } = makeService({
      user: { notificationSettings: { inApp: true, email: false, telegram: false } },
      notifications: [
        {
          _id: 'notification-1',
          userId: 'user-1',
          type: 'opportunity_export.completed',
          category: 'opportunity',
          title: 'Export ready',
          body: '',
          data: {},
          deliveries: [
            { channel: 'email', status: 'queued', mode: 'instant', dispatchAt: queuedAt },
            { channel: 'telegram', status: 'sent', attemptedAt: queuedAt },
          ],
        },
      ],
    });

    await service.dispatch('notification-1');

    const updated = repo.notifications.get('notification-1');
    assert.equal(updated.deliveries[0].status, 'skipped');
    assert.equal(updated.deliveries[0].reason, 'Notification channel is disabled');
    assert.equal(updated.deliveries[1].status, 'sent');
    assert.equal(updated.deliveries[1].attemptedAt.getTime(), queuedAt.getTime());
  });

  it('preserves delivery metadata when external dispatch records the final status', async () => {
    const dispatchAt = new Date('2026-10-03T10:00:00.000Z');
    const { repo, service } = makeService({
      user: { notificationSettings: { inApp: true, email: true, telegram: false } },
      notifications: [
        {
          _id: 'notification-1',
          userId: 'user-1',
          type: 'opportunity_export.completed',
          category: 'opportunity',
          title: 'Export ready',
          body: '',
          data: {},
          deliveries: [{ channel: 'email', status: 'queued', mode: 'instant', dispatchAt, digestKey: 'daily:2026-10-03' }],
        },
      ],
    });
    service.sendEmail = async () => ({ channel: 'email', status: 'sent', attemptedAt: new Date('2026-10-03T10:01:00.000Z') });

    await service.dispatch('notification-1');

    const [delivery] = repo.notifications.get('notification-1').deliveries;
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.mode, 'instant');
    assert.equal(delivery.digestKey, 'daily:2026-10-03');
    assert.equal(delivery.dispatchAt.getTime(), dispatchAt.getTime());
  });

  it('sends one digest per channel and deduplicates repeated opportunities in the digest body', async () => {
    const notifications = [
      digestItem('n-1', 'opp-1', 'Same opportunity'),
      digestItem('n-2', 'opp-1', 'Repeated opportunity'),
      digestItem('n-3', 'opp-2', 'Second opportunity'),
    ];
    const { repo, service } = makeService({
      user: { notificationSettings: { email: true, digestMode: 'daily' } },
      notifications,
    });
    let digestBody = '';
    service.sendEmail = async (_to, notification) => {
      digestBody = notification.body;
      return { channel: 'email', status: 'sent', attemptedAt: new Date('2026-10-03T12:00:00.000Z') };
    };

    await service.dispatchDigest('user-1', 'email', 'daily:2026-10-03');

    assert.match(digestBody, /Same opportunity/);
    assert.doesNotMatch(digestBody, /Repeated opportunity/);
    assert.match(digestBody, /Second opportunity/);
    assert.equal(repo.digestUpdates.length, 1);
    assert.deepEqual(repo.digestUpdates[0].ids, ['n-1', 'n-2', 'n-3']);
    assert.equal(repo.digestUpdates[0].delivery.status, 'sent');
    assert.equal(repo.digestUpdates[0].delivery.reason, 'Included in daily digest');
  });

  it('re-checks quiet hours before digest dispatch and requeues the digest window', async () => {
    const { jobs, repo, service } = makeService({
      user: {
        notificationSettings: {
          email: true,
          digestMode: 'daily',
          quietHours: { start: '00:00', end: '23:59', timezone: 'UTC' },
        },
      },
      notifications: [digestItem('n-1', 'opp-1', 'Same opportunity')],
    });

    await service.dispatchDigest('user-1', 'email', 'daily:2026-10-03');

    assert.equal(repo.digestUpdates.length, 0);
    assert.equal(jobs.enqueued.at(-1).name, 'notification.digest');
    assert.equal(jobs.enqueued.at(-1).data.digestKey, 'daily:2026-10-03');
    assert.ok(jobs.enqueued.at(-1).opts.delay > 0);
  });
});

describe('notification settings validation', () => {
  it('rejects invalid quiet hours and invalid event channel maps', () => {
    assert.throws(
      () => validateNotificationSettingsPatch({ quietHours: { start: '09:00', end: '09:00', timezone: 'Europe/Moscow' } }, { partial: true }),
      /start and end must differ/,
    );
    assert.throws(
      () => validateNotificationSettingsPatch({ quietHours: { start: '09:00', end: '18:00', timezone: 'Mars/Base' } }, { partial: true }),
      /timezone is invalid/,
    );
    assert.throws(
      () => validateNotificationSettingsPatch({ eventChannels: { sales: { email: true } } }, { partial: true }),
      /not a supported notification category/,
    );
    assert.throws(
      () => validateNotificationSettingsPatch({ eventChannels: { ai: { email: 'yes' } } }, { partial: true }),
      /email must be boolean/,
    );
  });

  it('returns atomic dotted notification settings updates for supplied fields only', async () => {
    const { users, service } = makeService({
      user: {
        notificationSettings: {
          inApp: true,
          email: false,
          telegram: false,
          digestMode: 'instant',
          eventChannels: { opportunity: { email: true } },
        },
      },
    });

    const result = await service.updateSettings(actor(), {
      quietHours: { start: '23:00', end: '08:00', timezone: 'Europe/Moscow' },
      eventChannels: { ai: { telegram: true, mode: 'digest' } },
    });

    assert.deepEqual(users.updates[0], {
      'notificationSettings.quietHours': { start: '23:00', end: '08:00', timezone: 'Europe/Moscow' },
      'notificationSettings.eventChannels.ai': { telegram: true, mode: 'digest' },
    });
    assert.equal(result.eventChannels.opportunity.email, true);
    assert.equal(result.eventChannels.ai.telegram, true);
  });
});

describe('notification center archive contract', () => {
  it('archives and restores notifications without deleting them', async () => {
    const { realtime, repo, service } = makeService({
      notifications: [
        {
          _id: 'notification-1',
          userId: 'user-1',
          type: 'system.notice',
          category: 'system',
          title: 'Notice',
          body: '',
          data: {},
          deliveries: [],
        },
      ],
    });

    const archived = await service.markArchived(actor(), 'notification-1', true);
    assert.ok(archived.archivedAt);
    assert.equal((await service.list(actor(), { archived: false })).items.length, 0);
    assert.equal((await service.list(actor(), { archived: true })).items.length, 1);

    const restored = await service.markArchived(actor(), 'notification-1', false);
    assert.equal(restored.archivedAt, undefined);
    assert.equal((await service.list(actor(), { filter: 'system' })).items.length, 1);
    assert.equal(repo.notifications.get('notification-1').deletedAt, undefined);
    assert.equal(realtime.published.at(-1).event, 'notification.archived');
    assert.equal(realtime.published.at(-1).payload.archived, false);
  });

  it('keeps external-only notifications out of the user center while retaining delivery log', async () => {
    const { realtime, repo, service } = makeService({
      user: { notificationSettings: { inApp: false, email: true, telegram: false } },
    });

    const notification = await service.notify({
      userId: 'user-1',
      type: 'opportunity_export.completed',
      title: 'Export ready',
    });

    assert.equal(notification.visibleInApp, false);
    assert.equal(notification.deliveries.length, 1);
    assert.equal(realtime.published.length, 0);
    assert.equal((await service.list(actor(), {})).items.length, 0);
    assert.equal(repo.notifications.get(notification._id).deliveries[0].channel, 'email');
  });
});

describe('notification history pagination', () => {
  it('pages more than 100 visible notifications with stable tied timestamp cursor and no duplicates', async () => {
    const repository = new NotificationsRepository(new FakeNotificationModel(historyFixture(125)));
    const first = await repository.list('user-1', { filter: 'all', limit: 50 });
    const second = await repository.list('user-1', { filter: 'all', limit: 50, cursor: first.nextCursor });
    const third = await repository.list('user-1', { filter: 'all', limit: 50, cursor: second.nextCursor });
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item._id);

    assert.equal(first.items.length, 50);
    assert.equal(second.items.length, 50);
    assert.equal(third.items.length, 25);
    assert.equal(new Set(ids).size, 125);
    assert.equal(first.total, 125);
    assert.equal(first.counts.all, 125);
    assert.equal(third.nextCursor, null);
  });

  it('keeps selected class filter inside cursor query for category pages', async () => {
    const items = [
      ...Array.from({ length: 55 }, (_item, index) => notificationRecord({
        _id: `z-opp-${String(55 - index).padStart(3, '0')}`,
        type: 'watchlist.hit',
        category: 'opportunity',
        createdAt: new Date('2026-10-03T12:00:00.000Z'),
      })),
      notificationRecord({ _id: 'a-system-001', type: 'system.notice', category: 'system', createdAt: new Date('2026-10-03T12:00:00.000Z') }),
      notificationRecord({ _id: 'a-task-001', type: 'calendar.reminder', category: 'workflow', createdAt: new Date('2026-10-03T12:00:00.000Z') }),
    ];
    const model = new FakeNotificationModel(items);
    const repository = new NotificationsRepository(model);
    const first = await repository.list('user-1', { filter: 'opportunities', limit: 50 });
    const second = await repository.list('user-1', { filter: 'opportunities', limit: 50, cursor: first.nextCursor });

    assert.equal(second.items.length, 5);
    assert.ok(second.items.every((item) => item.type.startsWith('watchlist')));
    assert.ok(model.findFilters[1].$and);
    assert.ok(model.findFilters[1].$and[0].$or);
    assert.ok(model.findFilters[1].$and[1].$or);
  });

  it('returns unread filter total archive counts and legacy center classifications', async () => {
    const repository = new NotificationsRepository(new FakeNotificationModel([
      notificationRecord({ _id: 'n-system', type: 'admin.alert', category: 'system', readAt: new Date('2026-10-03T12:00:00.000Z') }),
      notificationRecord({ _id: 'n-opportunity', type: 'watchlist.hit', category: 'system' }),
      notificationRecord({ _id: 'n-task', type: 'calendar.reminder', category: 'system' }),
      notificationRecord({ _id: 'n-mixed-opportunity', type: 'opportunity.response', category: 'workflow' }),
      notificationRecord({ _id: 'n-mid-reminder', type: 'custom.deadline.reminder', category: 'system' }),
      notificationRecord({ _id: 'n-opportunity-task-type', type: 'task.reminder', category: 'opportunity' }),
      notificationRecord({ _id: 'n-uppercase-opportunity', type: 'Watchlist.hit', category: 'system' }),
      notificationRecord({ _id: 'n-nonprefix-task-text', type: 'custom.task.audit', category: 'system' }),
      notificationRecord({ _id: 'n-workflow-type-only', type: 'workflow.updated', category: 'ai' }),
      notificationRecord({ _id: 'n-workflow-system-type', type: 'system.notice', category: 'workflow' }),
      notificationRecord({ _id: 'n-archived', type: 'system.notice', category: 'system', archivedAt: new Date('2026-10-03T13:00:00.000Z') }),
      notificationRecord({ _id: 'n-hidden', type: 'system.notice', category: 'system', visibleInApp: false }),
      notificationRecord({ _id: 'n-deleted', type: 'system.notice', category: 'system', deletedAt: new Date('2026-10-03T14:00:00.000Z') }),
      notificationRecord({ _id: 'n-other-user', userId: 'user-2', type: 'watchlist.hit', category: 'opportunity' }),
    ]));

    const unread = await repository.list('user-1', { filter: 'unread', limit: 10 });
    const opportunities = await repository.list('user-1', { filter: 'opportunities', limit: 10 });
    const tasks = await repository.list('user-1', { filter: 'tasks', limit: 10 });
    const archived = await repository.list('user-1', { filter: 'archived', limit: 10 });

    assert.equal(unread.total, 9);
    assert.deepEqual(unread.counts, { all: 10, unread: 9, system: 2, opportunities: 4, tasks: 3, archived: 1 });
    assert.deepEqual(opportunities.items.map((item) => item._id).sort(), ['n-mixed-opportunity', 'n-opportunity', 'n-opportunity-task-type', 'n-uppercase-opportunity']);
    assert.deepEqual(tasks.items.map((item) => item._id).sort(), ['n-mid-reminder', 'n-task', 'n-workflow-system-type']);
    assert.deepEqual(archived.items.map((item) => item._id), ['n-archived']);
  });

  it('rejects malformed cross-scope cursors and invalid filters or limits', async () => {
    const repository = new NotificationsRepository(new FakeNotificationModel(historyFixture(3)));
    const first = await repository.list('user-1', { filter: 'all', limit: 2 });

    await assert.rejects(() => repository.list('user-1', { filter: 'unread', limit: 2, cursor: first.nextCursor }), /cursor is invalid/i);
    await assert.rejects(() => repository.list('user-1', { filter: 'all', limit: 2, cursor: 'not-a-cursor' }), /cursor is invalid/i);
    await assert.rejects(() => repository.list('user-1', { filter: 'bad', limit: 2 }), /filter is invalid/i);
    await assert.rejects(() => repository.list('user-1', { filter: 'all', limit: 101 }), /limit/i);
  });
});

function actor() {
  return { id: 'user-1', email: 'user@example.test', role: 'User' };
}

function digestItem(id, opportunityId, title) {
  return {
    _id: id,
    userId: 'user-1',
    type: 'watchlist.hit',
    category: 'opportunity',
    title,
    body: '',
    data: { opportunityId },
    deliveries: [{ channel: 'email', status: 'queued', mode: 'daily', digestKey: 'daily:2026-10-03' }],
  };
}

function makeService(options = {}) {
  const repo = new InMemoryNotificationsRepository(options.notifications ?? []);
  const user = {
    _id: 'user-1',
    email: 'user@example.test',
    timezone: 'Europe/Moscow',
    notificationSettings: { inApp: true, email: false, telegram: false, digestMode: 'instant' },
    telegram: { linked: false },
    ...(options.user ?? {}),
  };
  const users = {
    updates: [],
    async getById(id) {
      assert.equal(id, 'user-1');
      return user;
    },
    async update(_id, patch) {
      this.updates.push(structuredClone(patch));
      for (const [key, value] of Object.entries(patch)) {
        setDotted(user, key, value);
      }
      return user;
    },
  };
  const realtime = {
    published: [],
    publish(userId, event, payload) {
      this.published.push({ userId, event, payload });
    },
  };
  const jobs = {
    enqueued: [],
    registerHandler() {},
    async enqueue(queue, name, data, opts) {
      this.enqueued.push({ queue, name, data, opts });
    },
  };
  const crypto = { encrypt: (value) => `enc:${value}`, decrypt: (value) => value.replace(/^enc:/, '') };
  return { jobs, realtime, repo, users, service: new NotificationsService(repo, users, realtime, jobs, crypto) };
}

class InMemoryNotificationsRepository {
  constructor(items) {
    this.notifications = new Map(items.map((item) => [item._id, structuredClone(item)]));
    this.digestUpdates = [];
    this.nextId = 1;
  }

  async create(input) {
    const notification = { _id: `created-${this.nextId++}`, ...structuredClone(input) };
    this.notifications.set(notification._id, notification);
    return structuredClone(notification);
  }

  async createIdempotent(input) {
    if (input.idempotencyKey) {
      const existing = [...this.notifications.values()].find((item) => item.idempotencyKey === input.idempotencyKey && !item.deletedAt);
      if (existing) return { notification: structuredClone(existing), created: false };
    }
    return { notification: await this.create(input), created: true };
  }

  async getById(id) {
    const notification = this.notifications.get(id);
    if (!notification) throw new Error('Notification not found');
    return structuredClone(notification);
  }

  async list(userId, query) {
    const items = [...this.notifications.values()]
      .filter((item) => item.userId === userId)
      .filter((item) => !item.deletedAt)
      .filter((item) => item.visibleInApp !== false)
      .filter((item) => query.archived ? item.archivedAt : !item.archivedAt)
      .filter((item) => query.filter === 'system' ? item.category === 'system' : true)
      .filter((item) => query.unreadOnly || query.filter === 'unread' ? !item.readAt : true)
      .map((item) => structuredClone(item));
    return { items, nextCursor: null, total: items.length, counts: { all: items.length, unread: items.filter((item) => !item.readAt).length, system: 0, opportunities: 0, tasks: 0, archived: 0 } };
  }

  async markArchived(id, userId, archived) {
    const notification = this.notifications.get(id);
    assert.equal(notification.userId, userId);
    if (archived) notification.archivedAt = new Date('2026-10-03T12:00:00.000Z');
    else delete notification.archivedAt;
    return structuredClone(notification);
  }

  async setDeliveries(id, deliveries) {
    const notification = this.notifications.get(id);
    notification.deliveries = structuredClone(deliveries);
    return structuredClone(notification);
  }

  async listDigest(userId, channel, digestKey) {
    return [...this.notifications.values()]
      .filter((item) => item.userId === userId)
      .filter((item) => item.deliveries.some((delivery) => delivery.channel === channel && delivery.digestKey === digestKey && delivery.status === 'queued'))
      .map((item) => structuredClone(item));
  }

  async setDigestDeliveries(ids, channel, digestKey, delivery) {
    this.digestUpdates.push({ ids: [...ids], channel, digestKey, delivery: structuredClone(delivery) });
    for (const id of ids) {
      const notification = this.notifications.get(id);
      notification.deliveries = notification.deliveries.map((item) => (
        item.channel === channel && item.digestKey === digestKey && item.status === 'queued'
          ? { ...item, ...structuredClone(delivery) }
          : item
      ));
    }
    return { modifiedCount: ids.length };
  }
}

function setDotted(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor[part] ??= {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function historyFixture(count) {
  const tied = new Date('2026-10-03T12:00:00.000Z');
  return Array.from({ length: count }, (_item, index) => notificationRecord({
    _id: `n-${String(count - index).padStart(3, '0')}`,
    type: 'system.notice',
    category: 'system',
    createdAt: tied,
  }));
}

function notificationRecord(overrides = {}) {
  return {
    _id: 'n-1',
    userId: 'user-1',
    type: 'system.notice',
    category: 'system',
    title: 'Notice',
    body: '',
    data: {},
    deliveries: [],
    visibleInApp: true,
    createdAt: new Date('2026-10-03T12:00:00.000Z'),
    ...overrides,
  };
}

class FakeNotificationModel {
  constructor(items) {
    this.items = items.map((item) => structuredClone(item));
    this.findFilters = [];
  }

  find(filter) {
    this.findFilters.push(structuredCloneFilter(filter));
    return new FakeQuery(this.items.filter((item) => matchesFilter(item, filter)));
  }

  countDocuments(filter) {
    return Promise.resolve(this.items.filter((item) => matchesFilter(item, filter)).length);
  }
}

class FakeQuery {
  constructor(items) {
    this.items = items;
  }

  sort(sortSpec) {
    const entries = Object.entries(sortSpec);
    this.items.sort((a, b) => {
      for (const [key, direction] of entries) {
        const left = comparable(a[key]);
        const right = comparable(b[key]);
        if (left === right) continue;
        return (left > right ? 1 : -1) * direction;
      }
      return 0;
    });
    return this;
  }

  limit(count) {
    this.items = this.items.slice(0, count);
    return this;
  }

  lean() {
    return Promise.resolve(this.items.map((item) => structuredClone(item)));
  }
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function matchesFilter(item, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((branch) => matchesFilter(item, branch));
    if (key === '$and') return expected.every((branch) => matchesFilter(item, branch));
    if (key === 'type' && expected?.$regex instanceof RegExp) return expected.$regex.test(item.type);
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
      if ('$exists' in expected) return expected.$exists ? item[key] !== undefined : item[key] === undefined;
      if ('$ne' in expected) return item[key] !== expected.$ne;
      if ('$lt' in expected) return comparable(item[key]) < comparable(expected.$lt);
      if ('$in' in expected) return expected.$in.includes(item[key]);
      if ('$nin' in expected) return !expected.$nin.includes(item[key]);
      if ('$not' in expected && expected.$not instanceof RegExp) return !expected.$not.test(item[key]);
    }
    if (item[key] instanceof Date && expected instanceof Date) return item[key].getTime() === expected.getTime();
    return item[key] === expected;
  });
}

function structuredCloneFilter(value) {
  if (value instanceof RegExp) return value;
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map((item) => structuredCloneFilter(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, structuredCloneFilter(item)]));
  }
  return value;
}

test('weekly digest after Monday morning schedules the following Monday, and daily boundary schedules tomorrow', () => {
  const { service } = makeService();
  assert.equal(service.nextDigestAt('weekly', 'Europe/Moscow', new Date('2026-10-05T07:00:00Z')).toISOString(), '2026-10-12T06:00:00.000Z');
  assert.equal(service.nextDigestAt('weekly', 'Europe/Moscow', new Date('2026-10-04T07:00:00Z')).toISOString(), '2026-10-05T06:00:00.000Z');
  assert.equal(service.nextDigestAt('daily', 'UTC', new Date('2026-10-05T09:00:01Z')).toISOString(), '2026-10-06T09:00:00.000Z');
});


test('transformed partial DTO with emitted undefined fields does not reset untouched notification preferences', async () => {
  const { UpdateNotificationSettingsDto } = require('../src/modules/notifications/dto/notification.dto.ts');
  const { plainToInstance } = require('class-transformer');
  const { service, users } = makeService({ user: { notificationSettings: { inApp: true, email: true, telegram: false, digestMode: 'weekly', eventChannels: { ai: { mode: 'digest' } } } } });
  await service.updateSettings(actor(), plainToInstance(UpdateNotificationSettingsDto, { quietHours: null }));
  assert.deepEqual(users.updates[0], { 'notificationSettings.quietHours': null });
  assert.equal(users.updates[0]['notificationSettings.digestMode'], undefined);
  assert.equal((await users.getById('user-1')).notificationSettings.digestMode, 'weekly');
});
