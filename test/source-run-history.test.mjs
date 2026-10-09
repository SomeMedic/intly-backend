import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { BadRequestException } = require('@nestjs/common');
const { SourcesRepository } = require('../src/modules/sources/sources.repository.ts');
const { SourceRunSchema } = require('../src/modules/sources/schemas/source-run.schema.ts');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function run(_id, createdAt, overrides = {}) {
  return {
    _id,
    sourceId: 'source-a',
    status: 'Succeeded',
    runType: 'scheduled',
    checkpointBefore: {},
    checkpointAfter: {},
    stats: {},
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    ...overrides,
  };
}

function repositoryFor(rows) {
  return new SourcesRepository({}, new InMemoryRunModel(rows), {});
}

function decodeCursor(cursor) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

test('source run history orders by createdAt desc before UUID and emits scoped opaque cursors', async () => {
  const repo = repositoryFor([
    run(uuid(900), '2026-10-06T10:00:00.000Z'),
    run(uuid(100), '2026-10-06T12:00:00.000Z'),
    run(uuid(500), '2026-10-06T11:00:00.000Z'),
  ]);

  const page = await repo.listRuns({ sourceId: 'source-a', limit: 2 });

  assert.deepEqual(page.items.map((item) => item._id), [uuid(100), uuid(500)]);
  assert.equal(page.latestCollectionRun._id, uuid(100));
  assert.ok(page.nextCursor);
  assert.deepEqual(decodeCursor(page.nextCursor), {
    v: 1,
    id: uuid(500),
    createdAt: '2026-10-06T11:00:00.000Z',
    sourceId: 'source-a',
  });

  const second = await repo.listRuns({ sourceId: 'source-a', limit: 2, cursor: page.nextCursor });
  assert.deepEqual(second.items.map((item) => item._id), [uuid(900)]);
  assert.equal(second.nextCursor, null);
});

test('source run history keeps equal timestamp pages stable without gaps', async () => {
  const same = '2026-10-06T12:00:00.000Z';
  const repo = repositoryFor([
    run(uuid(1), same),
    run(uuid(3), same),
    run(uuid(2), same),
    run(uuid(4), '2026-10-06T11:59:00.000Z'),
  ]);

  const first = await repo.listRuns({ sourceId: 'source-a', limit: 2 });
  const second = await repo.listRuns({ sourceId: 'source-a', limit: 2, cursor: first.nextCursor });

  assert.deepEqual(first.items.map((item) => item._id), [uuid(3), uuid(2)]);
  assert.deepEqual(second.items.map((item) => item._id), [uuid(1), uuid(4)]);
  assert.equal(second.nextCursor, null);
});

test('source run history latestCollectionRun ignores health and is independent from page cursor and status filter', async () => {
  const rows = [
    run(uuid(10), '2026-10-06T10:00:00.000Z', { status: 'Succeeded', runType: 'scheduled' }),
    run(uuid(11), '2026-10-06T11:00:00.000Z', { status: 'Failed', runType: 'manual' }),
    run(uuid(12), '2026-10-06T12:00:00.000Z', { status: 'Succeeded', runType: 'backfill' }),
  ];
  for (let index = 0; index < 55; index += 1) {
    rows.push(run(uuid(1000 + index), `2026-10-07T00:${String(index).padStart(2, '0')}:00.000Z`, { status: 'Succeeded', runType: 'health' }));
  }
  const repo = repositoryFor(rows);

  const failed = await repo.listRuns({ sourceId: 'source-a', status: 'Failed', limit: 1 });
  const first = await repo.listRuns({ sourceId: 'source-a', limit: 50 });
  const second = await repo.listRuns({ sourceId: 'source-a', limit: 50, cursor: first.nextCursor });

  assert.deepEqual(failed.items.map((item) => item._id), [uuid(11)]);
  assert.equal(failed.nextCursor, null);
  assert.equal(failed.latestCollectionRun._id, uuid(12));
  assert.equal(failed.latestCollectionRun.runType, 'backfill');
  assert.equal(first.items.length, 50);
  assert.ok(first.items.every((item) => item.runType === 'health'));
  assert.ok(first.nextCursor);
  assert.equal(first.latestCollectionRun._id, uuid(12));
  assert.equal(first.latestCollectionRun.runType, 'backfill');
  assert.deepEqual(second.items.map((item) => item._id), [uuid(1004), uuid(1003), uuid(1002), uuid(1001), uuid(1000), uuid(12), uuid(11), uuid(10)]);
  assert.equal(second.nextCursor, null);
  assert.equal(second.latestCollectionRun._id, uuid(12));
  assert.equal(second.latestCollectionRun.runType, 'backfill');

  const global = await repo.listRuns({ limit: 1 });
  assert.equal(global.latestCollectionRun, null);
});

test('source run history accepts legacy UUID cursor by resolving its filtered anchor', async () => {
  const repo = repositoryFor([
    run(uuid(1), '2026-10-06T12:00:00.000Z'),
    run(uuid(2), '2026-10-06T11:00:00.000Z'),
    run(uuid(3), '2026-10-06T10:00:00.000Z'),
  ]);

  const page = await repo.listRuns({ sourceId: 'source-a', limit: 10, cursor: uuid(2) });

  assert.deepEqual(page.items.map((item) => item._id), [uuid(3)]);
});

test('source run history rejects malformed, missing, and cross-filter cursors with explicit bad request', async () => {
  const repo = repositoryFor([
    run(uuid(1), '2026-10-06T12:00:00.000Z', { sourceId: 'source-a', status: 'Succeeded' }),
    run(uuid(4), '2026-10-06T11:30:00.000Z', { sourceId: 'source-a', status: 'Succeeded' }),
    run(uuid(2), '2026-10-06T11:00:00.000Z', { sourceId: 'source-b', status: 'Succeeded' }),
    run(uuid(3), '2026-10-06T10:00:00.000Z', { sourceId: 'source-a', status: 'Failed' }),
  ]);
  const cursor = (await repo.listRuns({ sourceId: 'source-a', status: 'Succeeded', limit: 1 })).nextCursor;

  await assert.rejects(() => repo.listRuns({ sourceId: 'source-a', cursor: 'not-a-cursor' }), BadRequestException);
  await assert.rejects(() => repo.listRuns({ sourceId: 'source-a', cursor: uuid(999) }), BadRequestException);
  await assert.rejects(() => repo.listRuns({ sourceId: 'source-b', cursor: uuid(1) }), BadRequestException);
  await assert.rejects(() => repo.listRuns({ sourceId: 'source-a', status: 'Failed', cursor }), BadRequestException);
});

test('SourceRun schema declares additive keyset indexes for run history filters', () => {
  const indexKeys = SourceRunSchema.indexes().map(([key]) => key);
  assert.ok(indexKeys.some((key) => JSON.stringify(key) === JSON.stringify({ createdAt: -1, _id: -1 })));
  assert.ok(indexKeys.some((key) => JSON.stringify(key) === JSON.stringify({ sourceId: 1, createdAt: -1, _id: -1 })));
  assert.ok(indexKeys.some((key) => JSON.stringify(key) === JSON.stringify({ status: 1, createdAt: -1, _id: -1 })));
  assert.ok(indexKeys.some((key) => JSON.stringify(key) === JSON.stringify({ sourceId: 1, status: 1, createdAt: -1, _id: -1 })));
});

class InMemoryRunModel {
  constructor(rows) {
    this.rows = rows.map((row) => structuredClone(row));
  }

  find(filter) {
    return new Query(this.rows.filter((row) => matches(row, filter)));
  }

  findOne(filter) {
    return new Query(this.rows.filter((row) => matches(row, filter)), true);
  }
}

class Query {
  constructor(rows, single = false) {
    this.rows = rows;
    this.single = single;
  }

  sort(sortSpec) {
    const entries = Object.entries(sortSpec);
    this.rows = [...this.rows].sort((left, right) => {
      for (const [field, direction] of entries) {
        const cmp = compareValue(left[field], right[field]);
        if (cmp !== 0) return direction < 0 ? -cmp : cmp;
      }
      return 0;
    });
    return this;
  }

  limit(count) {
    this.rows = this.rows.slice(0, count);
    return this;
  }

  async lean() {
    const result = this.single ? this.rows[0] ?? null : this.rows;
    return structuredClone(result);
  }
}

function matches(row, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === '$or') return expected.some((branch) => matches(row, branch));
    return matchesField(row[field], expected);
  });
}

function matchesField(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    if ('$lt' in expected) return compareValue(actual, expected.$lt) < 0;
    if ('$in' in expected) return expected.$in.includes(actual);
  }
  return compareValue(actual, expected) === 0;
}

function compareValue(left, right) {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
