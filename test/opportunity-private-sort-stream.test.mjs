import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { OpportunitiesRepository } = require('../src/modules/opportunities/opportunities.repository.ts');

const EXPECTED_PROJECTION = {
  _id: 1,
  title: 1,
  money: 1,
  deadline: 1,
  publishedAt: 1,
  firstSeenAt: 1,
  updatedAt: 1,
  sourceStatus: 1,
  skills: 1,
  technologies: 1,
  seniority: 1,
  remoteType: 1,
  location: 1,
  employmentType: 1,
  'sourceOccurrences.sourceId': 1,
};

describe('opportunity private sort candidate streaming', () => {
  it('streams the full candidate frontier through one projected Mongo cursor', async () => {
    const model = new FakeOpportunityModel(records(1001));
    const repo = repositoryWith(model);

    const batches = [];
    for await (const batch of repo.iteratePrivateSortCandidates({
      types: ['vacancy', 'tender'],
      sourceIds: ['hh', 'roseltorg'],
      technologies: ['TypeScript'],
    }, undefined, 999)) {
      batches.push(batch);
    }

    assert.equal(model.findCalls.length, 1);
    assert.deepEqual(model.findCalls[0].projection, EXPECTED_PROJECTION);
    assert.deepEqual(model.findCalls[0].sort, { firstSeenAt: -1, _id: 1 });
    assert.deepEqual(model.findCalls[0].cursorOptions, { batchSize: 500 });
    assert.equal(model.lastCursor.closeCalls, 1);
    assert.deepEqual(batches.map((batch) => batch.length), [500, 500, 1]);
    assert.equal(batches.flat().length, 1001);
    assert.ok(batches.every((batch) => batch.length <= 500));

    const first = batches[0][0];
    assert.equal(first._id, 'opp-0000');
    assert.equal(first.title, 'Opportunity 0');
    assert.deepEqual(first.sourceOccurrences, [{ sourceId: 'hh' }]);
    assert.equal(Object.hasOwn(first, 'description'), false);
    assert.equal(Object.hasOwn(first, 'rawPayload'), false);
    assert.equal(Object.hasOwn(first, 'tenderData'), false);
    assert.equal(Object.hasOwn(first.sourceOccurrences[0], 'rawPayload'), false);

    assert.deepEqual(model.findCalls[0].filter, {
      mergedIntoOpportunityId: { $exists: false },
      type: { $in: ['vacancy', 'tender'] },
      sourceStatus: { $in: ['Active', 'Unknown'] },
      'sourceOccurrences.sourceId': { $in: ['hh', 'roseltorg'] },
      $and: [{ $or: [{ technologies: { $in: ['TypeScript'] } }, { skills: { $in: ['TypeScript'] } }] }],
    });
  });

  it('filters recognized money aliases semantically and custom money dimensions exactly', async () => {
    const input = records(4);
    input[0].money = { max: 100, currency: 'USD', period: 'YEAR', kind: 'GROSS' };
    input[1].money = { max: 200, currency: 'USD', period: 'year', kind: 'gross' };
    input[2].money = { max: 300, currency: 'USD', period: 'MONTH', kind: 'NET' };
    input[3].money = { max: 400, currency: 'USD', period: 'FORTNIGHT', kind: 'desired-upper-bound' };

    const aliasModel = new FakeOpportunityModel(input);
    const aliasSeen = [];
    for await (const batch of repositoryWith(aliasModel).iteratePrivateSortCandidates({ moneyPeriod: 'year', moneyKind: 'gross' }, undefined, 10)) aliasSeen.push(...batch);

    assert.deepEqual(aliasSeen.map((item) => item._id), ['opp-0000', 'opp-0001']);
    assert.deepEqual(aliasModel.findCalls[0].filter.$and, [
      { $or: [{ 'money.period': { $regex: '^year$', $options: 'i' } }] },
      { $or: [{ 'money.kind': { $regex: '^gross$', $options: 'i' } }] },
    ]);

    const customModel = new FakeOpportunityModel(input);
    const customSeen = [];
    for await (const batch of repositoryWith(customModel).iteratePrivateSortCandidates({ moneyPeriod: 'FORTNIGHT', moneyKind: 'desired-upper-bound' }, undefined, 10)) customSeen.push(...batch);

    assert.deepEqual(customSeen.map((item) => item._id), ['opp-0003']);
    assert.equal(customModel.findCalls[0].filter['money.period'], 'FORTNIGHT');
    assert.equal(customModel.findCalls[0].filter['money.kind'], 'desired-upper-bound');
  });


  it('preserves restrictIds including an explicit empty list', async () => {
    const restrictedModel = new FakeOpportunityModel(records(3));
    const restrictedRepo = repositoryWith(restrictedModel);
    const restricted = [];
    for await (const batch of restrictedRepo.iteratePrivateSortCandidates({}, ['opp-0002', 'opp-0001'], 10)) {
      restricted.push(...batch);
    }

    assert.deepEqual(restricted.map((item) => item._id), ['opp-0001', 'opp-0002']);
    assert.deepEqual(restrictedModel.findCalls[0].filter._id, { $in: ['opp-0002', 'opp-0001'] });

    const emptyModel = new FakeOpportunityModel(records(3));
    const emptyRepo = repositoryWith(emptyModel);
    const empty = [];
    for await (const batch of emptyRepo.iteratePrivateSortCandidates({}, [], 10)) {
      empty.push(...batch);
    }

    assert.deepEqual(empty, []);
    assert.deepEqual(emptyModel.findCalls[0].filter._id, { $in: [] });
    assert.equal(emptyModel.lastCursor.closeCalls, 1);
  });

  it('closes the cursor on early consumer break', async () => {
    const model = new FakeOpportunityModel(records(7));
    const repo = repositoryWith(model);
    const seen = [];

    for await (const batch of repo.iteratePrivateSortCandidates({}, undefined, 2)) {
      seen.push(...batch);
      break;
    }

    assert.deepEqual(seen.map((item) => item._id), ['opp-0000', 'opp-0001']);
    assert.equal(model.findCalls.length, 1);
    assert.equal(model.lastCursor.closeCalls, 1);
  });

  it('projects normalized export content without raw history or subtype payloads', async () => {
    const model = new FakeOpportunityModel(records(3));
    const repo = repositoryWith(model);
    const result = await repo.findForExportByIds(['opp-0002']);
    assert.equal(result.length, 1);
    assert.equal(result[0].description, 'Heavy description 2');
    assert.deepEqual(result[0].sourceOccurrences, [{ sourceId: 'hh', url: 'https://example.test/2' }]);
    assert.equal(Object.hasOwn(result[0], 'rawPayload'), false);
    assert.equal(Object.hasOwn(result[0], 'tenderData'), false);
    assert.equal(Object.hasOwn(result[0].sourceOccurrences[0], 'rawPayload'), false);
    assert.equal(model.findCalls[0].projection.description, 1);
    assert.equal(model.findCalls[0].projection['sourceOccurrences.url'], 1);
    assert.equal(model.findCalls[0].projection.rawPayload, undefined);
  });

  it('keeps explicitly selected closed and merged candidates without applying canonical list filters', async () => {
    const input = records(2);
    input[0].sourceStatus = 'Closed';
    input[1].mergedIntoOpportunityId = input[0]._id;
    const model = new FakeOpportunityModel(input);
    const result = [];
    for await (const batch of repositoryWith(model).iteratePrivateSortCandidates({ type: 'tender', query: 'does not match' }, input.map((item) => item._id), 500, true)) result.push(...batch);
    assert.equal(result.length, 2);
    assert.deepEqual(model.findCalls[0].filter, { _id: { $in: input.map((item) => item._id) } });
    assert.equal(model.lastCursor.closeCalls, 1);
  });

  it('closes the cursor when the consumer throws while reading a batch', async () => {
    const model = new FakeOpportunityModel(records(4));
    const repo = repositoryWith(model);

    await assert.rejects(async () => {
      for await (const _batch of repo.iteratePrivateSortCandidates({}, undefined, 2)) {
        throw new Error('consumer failed');
      }
    }, /consumer failed/);

    assert.equal(model.findCalls.length, 1);
    assert.equal(model.lastCursor.closeCalls, 1);
  });

  it('clamps invalid batch sizes to one candidate per cursor batch', async () => {
    const model = new FakeOpportunityModel(records(3));
    const repo = repositoryWith(model);
    const batches = [];

    for await (const batch of repo.iteratePrivateSortCandidates({}, undefined, 0)) {
      batches.push(batch);
    }

    assert.deepEqual(model.findCalls[0].cursorOptions, { batchSize: 1 });
    assert.deepEqual(batches.map((batch) => batch.length), [1, 1, 1]);
    assert.equal(model.lastCursor.closeCalls, 1);
  });
});

function repositoryWith(model) {
  return new OpportunitiesRepository(model, { collection: () => ({ aggregate: () => ({ toArray: async () => [] }) }) });
}

function records(count) {
  return Array.from({ length: count }, (_, index) => ({
    _id: `opp-${String(index).padStart(4, '0')}`,
    type: index % 2 === 0 ? 'vacancy' : 'tender',
    title: `Opportunity ${index}`,
    description: `Heavy description ${index}`,
    rawPayload: { native: index },
    tenderData: { lots: [{ number: index, price: index * 100 }] },
    money: { max: index * 1000, currency: 'RUB' },
    deadline: new Date(Date.UTC(2026, 10, 1, 0, index % 60)),
    publishedAt: new Date(Date.UTC(2026, 9, 1, 0, index % 60)),
    firstSeenAt: new Date(Date.UTC(2026, 9, 5, 0, 0, 0) - index * 60_000),
    updatedAt: new Date(Date.UTC(2026, 9, 6, 0, index % 60)),
    sourceStatus: index % 5 === 0 ? 'Unknown' : 'Active',
    skills: ['TypeScript'],
    technologies: ['TypeScript'],
    seniority: 'Middle',
    remoteType: 'Remote',
    location: 'RU',
    employmentType: 'Full-time',
    mergedIntoOpportunityId: undefined,
    sourceOccurrences: [{
      sourceId: index % 2 === 0 ? 'hh' : 'roseltorg',
      externalId: `native-${index}`,
      url: `https://example.test/${index}`,
      rawPayload: { retained: true },
    }],
  }));
}

class FakeOpportunityModel {
  constructor(inputRecords) {
    this.records = inputRecords;
    this.findCalls = [];
    this.lastCursor = null;
  }

  find(filter, projection) {
    const call = { filter: clone(filter), projection: clone(projection), sort: null, cursorOptions: null };
    this.findCalls.push(call);
    let sorted = this.records.filter((record) => matchesFilter(record, filter));
    return {
      lean: async () => sorted.map((record) => projectRecord(record, projection)),
      sort: (sort) => {
        call.sort = clone(sort);
        sorted = sorted.slice().sort((left, right) => compareRecords(left, right, sort));
        return {
          lean: () => ({
            cursor: (cursorOptions) => {
              call.cursorOptions = clone(cursorOptions);
              this.lastCursor = new FakeCursor(sorted.map((record) => projectRecord(record, projection)));
              return this.lastCursor;
            },
          }),
        };
      },
    };
  }
}

class FakeCursor {
  constructor(items) {
    this.items = items;
    this.index = 0;
    this.closeCalls = 0;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async next() {
    if (this.index >= this.items.length) return { done: true };
    const value = this.items[this.index];
    this.index += 1;
    return { value, done: false };
  }

  async close() {
    this.closeCalls += 1;
  }
}

function matchesFilter(record, filter) {
  for (const [field, expected] of Object.entries(filter)) {
    if (field === '$and') {
      if (!expected.every((condition) => matchesFilter(record, condition))) return false;
      continue;
    }
    if (field === '$or') {
      if (!expected.some((condition) => matchesFilter(record, condition))) return false;
      continue;
    }
    if (!matchesValue(readPath(record, field), expected)) return false;
  }
  return true;
}

function matchesValue(actual, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$exists' in expected) return (actual !== undefined) === expected.$exists;
    if ('$in' in expected) {
      if (Array.isArray(actual)) return actual.some((item) => expected.$in.includes(item));
      return expected.$in.includes(actual);
    }
    if ('$nin' in expected) {
      if (Array.isArray(actual)) return actual.every((item) => !expected.$nin.includes(item));
      return !expected.$nin.includes(actual);
    }
    if ('$regex' in expected) return new RegExp(expected.$regex, expected.$options ?? '').test(String(actual ?? ''));
  }
  return Object.is(actual, expected);
}

function compareRecords(left, right, sort) {
  for (const [field, direction] of Object.entries(sort)) {
    const compared = compareValues(readPath(left, field), readPath(right, field));
    if (compared !== 0) return compared * direction;
  }
  return 0;
}

function compareValues(left, right) {
  const normalizedLeft = left instanceof Date ? left.getTime() : left;
  const normalizedRight = right instanceof Date ? right.getTime() : right;
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  return 0;
}

function projectRecord(record, projection) {
  const output = {};
  for (const [path, enabled] of Object.entries(projection)) {
    if (!enabled) continue;
    if (path.startsWith('sourceOccurrences.')) {
      const key = path.slice('sourceOccurrences.'.length);
      output.sourceOccurrences = (record.sourceOccurrences ?? []).map((occurrence, index) => ({ ...output.sourceOccurrences?.[index], [key]: occurrence[key] }));
      continue;
    }
    const value = readPath(record, path);
    if (value !== undefined) writePath(output, path, value);
  }
  return clone(output);
}

function readPath(record, path) {
  return path.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) return current.map((item) => item?.[key]).filter((item) => item !== undefined);
    return current[key];
  }, record);
}

function writePath(record, path, value) {
  const segments = path.split('.');
  let current = record;
  for (const segment of segments.slice(0, -1)) {
    current[segment] ??= {};
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
}

function clone(value) {
  return structuredClone(value);
}
