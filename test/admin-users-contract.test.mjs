import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { AdminUsersController } = require('../src/modules/users/admin-users.controller.ts');
const { UsersRepository } = require('../src/modules/users/users.repository.ts');
const { UsersService } = require('../src/modules/users/users.service.ts');

function user(input = {}) {
  return {
    _id: input._id ?? 'user-1',
    email: input.email ?? 'user@example.com',
    name: input.name ?? 'User One',
    role: input.role ?? 'User',
    status: input.status ?? 'Deleted',
    locale: 'ru',
    timezone: 'Europe/Moscow',
    uiSettings: {},
    notificationSettings: {},
    aiPreferences: {},
    inviteDefaults: { starterProfile: true, defaultPrompts: true, notifications: true },
    onboarding: { minimumComplete: false, checklist: {} },
    telegram: { linked: false },
    passwordHash: input.passwordHash,
    passwordChangedAt: input.passwordChangedAt,
    lastActiveAt: input.lastActiveAt,
    deletedAt: input.deletedAt,
    createdAt: input.createdAt ?? new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: input.updatedAt ?? new Date('2026-10-02T00:00:00.000Z'),
  };
}

test('admin user list/detail includes Deleted lifecycle accounts without changing normal user lookup', async () => {
  const calls = [];
  const service = new UsersService({
    list: async (params) => {
      calls.push(['list', params]);
      return { items: [user()], nextCursor: null };
    },
    getById: async (id, options) => {
      calls.push(['getById', id, options]);
      return user({ _id: id });
    },
  });

  const page = await service.listAdmin({
    status: 'Deleted',
    inviteState: 'pending',
    createdFrom: '2026-10-01T00:00:00.000Z',
    createdTo: '2026-10-07T00:00:00.000Z',
    sort: 'createdAt:desc',
  });
  const detail = await service.getAdmin('deleted-user');

  assert.equal(page.items[0].status, 'Deleted');
  assert.equal(detail.id, 'deleted-user');
  assert.equal(calls[0][1].includeDeleted, true);
  assert.equal(calls[0][1].inviteState, 'pending');
  assert.equal(calls[0][1].sort, 'createdAt:desc');
  assert.ok(calls[0][1].createdFrom instanceof Date);
  assert.ok(calls[0][1].createdTo instanceof Date);
  assert.deepEqual(calls[1], ['getById', 'deleted-user', { includeDeleted: true }]);
});

test('admin password reset endpoint never returns the raw reset token', async () => {
  const auditEvents = [];
  const controller = new AdminUsersController(
    {},
    { sendPasswordResetForUser: async () => ({ accepted: false, emailSent: false, deliveryError: 'Email delivery is not configured', resetToken: 'secret-reset-token' }) },
    { record: async (event) => auditEvents.push(event) },
  );

  const result = await controller.resetPassword(
    { id: 'admin', role: 'Admin' },
    'user-1',
    { headers: { 'x-request-id': 'request-1' } },
  );

  assert.equal(result.resetToken, undefined);
  assert.equal(result.deliveryError, 'Email delivery is not configured');
  assert.equal(auditEvents[0].action, 'user.reset_password');
  assert.equal(auditEvents[0].requestId, 'request-1');
});

test('admin user pagination follows the selected sort tuple instead of comparing only ids', async () => {
  const repository = new UsersRepository(fakeUserModel([
    user({ _id: 'zzzz', name: 'Ada', status: 'Active', passwordChangedAt: new Date('2026-10-01T00:00:00.000Z') }),
    user({ _id: 'aaaa', name: 'Bea', status: 'Active', passwordChangedAt: new Date('2026-10-01T00:00:00.000Z') }),
    user({ _id: 'bbbb', name: 'Cid', status: 'Active', passwordChangedAt: new Date('2026-10-01T00:00:00.000Z') }),
  ]));

  const first = await repository.list({ includeDeleted: true, sort: 'name:asc', limit: 1 });
  const second = await repository.list({ includeDeleted: true, sort: 'name:asc', limit: 2, cursor: first.nextCursor });

  assert.deepEqual(first.items.map(item => item._id), ['zzzz']);
  assert.equal(first.nextCursor, 'zzzz');
  assert.deepEqual(second.items.map(item => item._id), ['aaaa', 'bbbb']);
});

test('admin invite state filters compose with status and use activation evidence', async () => {
  const repository = new UsersRepository(fakeUserModel([
    user({ _id: 'deleted-accepted', status: 'Deleted', deletedAt: new Date('2026-10-04T00:00:00.000Z'), passwordChangedAt: new Date('2026-10-01T00:00:00.000Z') }),
    user({ _id: 'deleted-unaccepted', status: 'Deleted', deletedAt: new Date('2026-10-04T00:00:00.000Z') }),
    user({ _id: 'invited-pending', status: 'Invited' }),
  ]));

  const acceptedDeleted = await repository.list({ includeDeleted: true, status: 'Deleted', inviteState: 'accepted' });
  const pendingDeleted = await repository.list({ includeDeleted: true, status: 'Deleted', inviteState: 'pending' });
  const pendingInvited = await repository.list({ includeDeleted: true, status: 'Invited', inviteState: 'pending' });

  assert.deepEqual(acceptedDeleted.items.map(item => item._id), ['deleted-accepted']);
  assert.deepEqual(pendingDeleted.items.map(item => item._id), []);
  assert.deepEqual(pendingInvited.items.map(item => item._id), ['invited-pending']);
});

function fakeUserModel(items) {
  const rows = items.map(item => ({ ...item }));
  return {
    findOne(filter) {
      return { lean: async () => rows.find(row => matches(row, filter)) ?? null };
    },
    find(filter) {
      let sortSpec = { _id: 1 };
      let limitValue = rows.length;
      return {
        sort(spec) {
          sortSpec = spec;
          return this;
        },
        limit(value) {
          limitValue = value;
          return this;
        },
        async lean() {
          return rows.filter(row => matches(row, filter)).sort((left, right) => compareRows(left, right, sortSpec)).slice(0, limitValue);
        },
      };
    },
  };
}

function matches(row, filter) {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$and') {
      if (!expected.every(condition => matches(row, condition))) return false;
    } else if (key === '$or') {
      if (!expected.some(condition => matches(row, condition))) return false;
    } else if (key === '$expr') {
      if (!evaluateExpression(row, expected)) return false;
    } else if (expected && typeof expected === 'object' && '$exists' in expected) {
      if ((row[key] !== undefined) !== expected.$exists) return false;
    } else if (expected && typeof expected === 'object' && ('$gte' in expected || '$lt' in expected || '$gt' in expected)) {
      const value = row[key];
      if ('$gte' in expected && !(value >= expected.$gte)) return false;
      if ('$gt' in expected && !(value > expected.$gt)) return false;
      if ('$lt' in expected && !(value < expected.$lt)) return false;
    } else if (row[key] !== expected) {
      return false;
    }
  }
  return true;
}

function evaluateExpression(row, expression) {
  if ('$or' in expression) return expression.$or.some(item => evaluateExpression(row, item));
  if ('$and' in expression) return expression.$and.every(item => evaluateExpression(row, item));
  if ('$gt' in expression) return valueFor(row, expression.$gt[0]) > valueFor(row, expression.$gt[1]);
  if ('$lt' in expression) return valueFor(row, expression.$lt[0]) < valueFor(row, expression.$lt[1]);
  if ('$eq' in expression) return valueFor(row, expression.$eq[0]) === valueFor(row, expression.$eq[1]);
  return false;
}

function valueFor(row, expression) {
  if (typeof expression === 'string' && expression.startsWith('$')) return row[expression.slice(1)];
  if (expression && typeof expression === 'object' && '$ifNull' in expression) {
    const value = valueFor(row, expression.$ifNull[0]);
    return value ?? expression.$ifNull[1];
  }
  return expression;
}

function compareRows(left, right, sortSpec) {
  for (const [field, direction] of Object.entries(sortSpec)) {
    const leftValue = field === 'lastActiveAt' || field === 'createdAt' ? left[field] ?? new Date(0) : left[field];
    const rightValue = field === 'lastActiveAt' || field === 'createdAt' ? right[field] ?? new Date(0) : right[field];
    if (leftValue < rightValue) return -1 * direction;
    if (leftValue > rightValue) return 1 * direction;
  }
  return 0;
}
