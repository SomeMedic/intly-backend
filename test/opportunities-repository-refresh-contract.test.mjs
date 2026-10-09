import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { OpportunitiesRepository } = require('../src/modules/opportunities/opportunities.repository.ts');

const date = (iso) => new Date(iso);
const clone = (value) => structuredClone(value);

function occurrence(input = {}) {
  return {
    sourceId: input.sourceId ?? 'source-a',
    externalId: input.externalId ?? 'native-1',
    url: input.url ?? `https://source.example/${input.externalId ?? 'native-1'}`,
    primary: input.primary ?? true,
    firstSeenAt: input.firstSeenAt ?? date('2026-10-01T00:00:00.000Z'),
    lastSeenAt: input.lastSeenAt ?? date('2026-10-01T00:00:00.000Z'),
    publishedAt: input.publishedAt ?? date('2026-09-30T00:00:00.000Z'),
    status: input.status ?? 'Active',
    rawPayload: input.rawPayload ?? { native: input.externalId ?? 'native-1' },
    sourceMetadata: input.sourceMetadata ?? { channel: input.sourceId ?? 'source-a' },
    normalizedSnapshot: input.normalizedSnapshot ?? { sourceStatus: input.status ?? 'Active' },
  };
}

function opportunity(input = {}) {
  return {
    _id: input._id ?? 'opp-1',
    type: input.type ?? 'tender',
    title: input.title ?? 'Primary title',
    companyOrClient: input.companyOrClient ?? 'Buyer',
    description: input.description ?? 'Description',
    skills: input.skills ?? [],
    technologies: input.technologies ?? [],
    countriesAllowed: input.countriesAllowed ?? [],
    money: input.money ?? { min: 100, currency: 'RUB' },
    firstSeenAt: input.firstSeenAt ?? date('2026-10-01T00:00:00.000Z'),
    lastSeenAt: input.lastSeenAt ?? date('2026-10-01T00:00:00.000Z'),
    sourceStatus: input.sourceStatus ?? 'Active',
    sourceOccurrences: input.sourceOccurrences ?? [occurrence()],
    vacancyData: input.vacancyData ?? {},
    freelanceData: input.freelanceData ?? {},
    tenderData: input.tenderData ?? { etp: 'old', lots: [{ number: 1, price: 100 }] },
    canonicalTags: input.canonicalTags ?? [],
    adminCorrections: input.adminCorrections ?? [],
    importedByUserId: input.importedByUserId,
    mergedIntoOpportunityId: input.mergedIntoOpportunityId,
    mergedAt: input.mergedAt,
  };
}

function readPath(record, path) {
  return path.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return current[key];
  }, record);
}

function matchesFilter(record, filter) {
  for (const [field, expected] of Object.entries(filter)) {
    const actual = readPath(record, field);
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && Object.keys(expected).length === 1 && '$exists' in expected) {
      const exists = actual !== undefined;
      if (exists !== expected.$exists) return false;
      continue;
    }
    try {
      assert.deepEqual(actual, expected);
    } catch {
      return false;
    }
  }
  return true;
}

class FakeOpportunityModel {
  constructor(records) {
    this.records = new Map(records.map((record) => [record._id, clone(record)]));
    this.findOneAndUpdateCalls = [];
    this.beforeFindOneAndUpdate = null;
  }

  findById(id) {
    return { lean: async () => clone(this.records.get(id) ?? null) };
  }

  findOneAndUpdate(filter, update) {
    this.findOneAndUpdateCalls.push({ filter: clone(filter), update: clone(update) });
    this.beforeFindOneAndUpdate?.(this);
    this.beforeFindOneAndUpdate = null;
    const record = this.records.get(String(filter._id));
    if (!record || !matchesFilter(record, filter)) {
      return { lean: async () => null };
    }
    const updated = { ...record, ...(update?.$set ?? {}) };
    this.records.set(record._id, clone(updated));
    return { lean: async () => clone(updated) };
  }
}

function repositoryWith(model) {
  return new OpportunitiesRepository(model, { collection: () => ({ updateMany: async () => ({}) }) });
}

test('secondary refresh preserves stored primary and cannot overwrite canonical facts', async () => {
  const primary = occurrence({ externalId: 'native-primary', primary: true, url: 'https://source.example/primary' });
  const secondary = occurrence({ externalId: 'native-secondary', primary: false, url: 'https://source.example/secondary' });
  const model = new FakeOpportunityModel([opportunity({ sourceOccurrences: [primary, secondary], title: 'Primary title', money: { min: 100 } })]);
  const repo = repositoryWith(model);

  const updated = await repo.upsertOccurrence(
    'opp-1',
    occurrence({ externalId: 'native-secondary', primary: true, url: 'https://source.example/secondary', lastSeenAt: date('2026-10-05T00:00:00.000Z'), rawPayload: { changed: true } }),
    { title: 'Secondary title', money: { min: 999 }, sourceStatus: 'Closed' },
  );

  assert.equal(updated.title, 'Primary title');
  assert.deepEqual(updated.money, { min: 100 });
  assert.equal(updated.sourceStatus, 'Active');
  const retainedSecondary = updated.sourceOccurrences.find((item) => item.externalId === 'native-secondary');
  assert.equal(retainedSecondary.primary, false);
  assert.deepEqual(retainedSecondary.rawPayload, { changed: true });
  assert.equal(retainedSecondary.lastSeenAt.toISOString(), '2026-10-05T00:00:00.000Z');
});

test('primary refresh preserves primary and updates unpinned canonical facts', async () => {
  const model = new FakeOpportunityModel([opportunity({ sourceOccurrences: [occurrence({ primary: true })], title: 'Old title' })]);
  const repo = repositoryWith(model);

  const updated = await repo.upsertOccurrence(
    'opp-1',
    occurrence({ primary: false, lastSeenAt: date('2026-10-05T00:00:00.000Z') }),
    { title: 'New primary title', sourceStatus: 'Closed' },
  );

  assert.equal(updated.title, 'New primary title');
  assert.equal(updated.sourceStatus, 'Closed');
  assert.equal(updated.sourceOccurrences[0].primary, true);
});

test('new occurrence becomes secondary when an existing primary exists', async () => {
  const model = new FakeOpportunityModel([opportunity({ sourceOccurrences: [occurrence({ externalId: 'native-primary', primary: true })] })]);
  const repo = repositoryWith(model);

  const updated = await repo.upsertOccurrence(
    'opp-1',
    occurrence({ externalId: 'native-secondary', primary: true, url: 'https://source.example/secondary' }),
    { title: 'Ignored secondary title' },
  );

  assert.equal(updated.title, 'Primary title');
  assert.equal(updated.sourceOccurrences.length, 2);
  assert.equal(updated.sourceOccurrences.find((item) => item.externalId === 'native-secondary').primary, false);
});

test('primary refresh protects pinned canonical fields including nested contracts', async () => {
  const model = new FakeOpportunityModel([
    opportunity({
      sourceOccurrences: [occurrence({ primary: true })],
      title: 'Old title',
      money: { min: 100, currency: 'RUB' },
      tenderData: { etp: 'old', lots: [{ number: 1, price: 100 }] },
      adminCorrections: [
        { field: 'money', value: { min: 100, currency: 'RUB' }, correctedBy: 'admin', correctedAt: date('2026-10-02T00:00:00.000Z'), pinned: true },
        { field: 'tenderData', value: { etp: 'old' }, correctedBy: 'admin', correctedAt: date('2026-10-02T00:00:00.000Z'), pinned: true },
      ],
    }),
  ]);
  const repo = repositoryWith(model);

  const updated = await repo.upsertOccurrence(
    'opp-1',
    occurrence({ primary: true }),
    { title: 'Allowed title', money: { min: 999, currency: 'USD' }, tenderData: { etp: 'new', lots: [{ number: 2, price: 999 }] } },
  );

  assert.equal(updated.title, 'Allowed title');
  assert.deepEqual(updated.money, { min: 100, currency: 'RUB' });
  assert.deepEqual(updated.tenderData, { etp: 'old', lots: [{ number: 1, price: 100 }] });
  assert.deepEqual(model.findOneAndUpdateCalls[0].filter.money, { min: 100, currency: 'RUB' });
  assert.deepEqual(model.findOneAndUpdateCalls[0].filter.tenderData, { etp: 'old', lots: [{ number: 1, price: 100 }] });
});

test('upsert retries CAS conflict and preserves concurrent source occurrence changes', async () => {
  const model = new FakeOpportunityModel([opportunity({ sourceOccurrences: [occurrence({ externalId: 'native-primary', primary: true })] })]);
  model.beforeFindOneAndUpdate = () => {
    const current = model.records.get('opp-1');
    model.records.set('opp-1', {
      ...current,
      sourceOccurrences: [
        ...current.sourceOccurrences,
        occurrence({ externalId: 'native-concurrent', primary: false, url: 'https://source.example/concurrent' }),
      ],
    });
  };
  const repo = repositoryWith(model);

  const updated = await repo.upsertOccurrence(
    'opp-1',
    occurrence({ externalId: 'native-secondary', primary: true, url: 'https://source.example/secondary' }),
    { title: 'Ignored secondary title' },
  );

  assert.equal(model.findOneAndUpdateCalls.length, 2);
  assert.deepEqual(updated.sourceOccurrences.map((item) => item.externalId).sort(), ['native-concurrent', 'native-primary', 'native-secondary']);
  assert.equal(updated.sourceOccurrences.find((item) => item.externalId === 'native-secondary').primary, false);
});

test('exact removal marks only requested occurrence and preserves other source/private canonical state', async () => {
  const primary = occurrence({ externalId: 'native-primary', primary: true, rawPayload: { keep: 'raw' } });
  const secondary = occurrence({ externalId: 'native-secondary', primary: false, url: 'https://source.example/secondary', rawPayload: { keep: 'secondary' } });
  const model = new FakeOpportunityModel([
    opportunity({
      sourceOccurrences: [primary, secondary],
      title: 'Pinned title',
      adminCorrections: [{ field: 'title', value: 'Pinned title', correctedBy: 'admin', correctedAt: date('2026-10-02T00:00:00.000Z'), pinned: true }],
    }),
  ]);
  const repo = repositoryWith(model);

  const updated = await repo.markSourceOccurrenceRemovedExact({
    opportunityId: 'opp-1',
    sourceId: 'source-a',
    externalId: 'native-primary',
    url: 'https://source.example/native-primary',
    observedAt: date('2026-10-05T00:00:00.000Z'),
    reason: 'typed-404',
    runId: 'run-1',
  });

  assert.notEqual(updated, false);
  assert.equal(updated.title, 'Pinned title');
  assert.equal(updated.adminCorrections.length, 1);
  assert.deepEqual(updated.sourceOccurrences.find((item) => item.externalId === 'native-secondary').rawPayload, { keep: 'secondary' });
  const removed = updated.sourceOccurrences.find((item) => item.externalId === 'native-primary');
  assert.equal(removed.status, 'Removed');
  assert.deepEqual(removed.rawPayload, { keep: 'raw' });
  assert.deepEqual(removed.sourceMetadata.removal, { reason: 'typed-404', runId: 'run-1', observedAt: '2026-10-05T00:00:00.000Z' });
});

test('exact removal returns false on URL mismatch or concurrent CAS conflict', async () => {
  const model = new FakeOpportunityModel([opportunity({ sourceOccurrences: [occurrence({ externalId: 'native-primary', primary: true })] })]);
  const repo = repositoryWith(model);

  const mismatch = await repo.markSourceOccurrenceRemovedExact({
    opportunityId: 'opp-1', sourceId: 'source-a', externalId: 'native-primary', url: 'https://source.example/other', observedAt: date('2026-10-05T00:00:00.000Z'), reason: 'typed-410', runId: 'run-1',
  });
  assert.equal(mismatch, false);

  model.beforeFindOneAndUpdate = () => {
    const current = model.records.get('opp-1');
    model.records.set('opp-1', { ...current, adminCorrections: [{ field: 'title', value: current.title, correctedBy: 'admin', correctedAt: date('2026-10-05T00:00:00.000Z'), pinned: true }] });
  };
  const conflict = await repo.markSourceOccurrenceRemovedExact({
    opportunityId: 'opp-1', sourceId: 'source-a', externalId: 'native-primary', url: 'https://source.example/native-primary', observedAt: date('2026-10-05T00:00:00.000Z'), reason: 'typed-410', runId: 'run-2',
  });
  assert.equal(conflict, false);
  assert.equal(model.records.get('opp-1').sourceOccurrences[0].status, 'Active');
});

test('exact removal sets canonical Removed only when every retained occurrence is Removed', async () => {
  const model = new FakeOpportunityModel([
    opportunity({
      sourceStatus: 'Active',
      sourceOccurrences: [
        occurrence({ externalId: 'native-primary', primary: true, status: 'Active' }),
        occurrence({ externalId: 'native-old', primary: false, url: 'https://source.example/old', status: 'Removed', normalizedSnapshot: { sourceStatus: 'Removed' } }),
      ],
    }),
  ]);
  const repo = repositoryWith(model);

  const updated = await repo.markSourceOccurrenceRemovedExact({
    opportunityId: 'opp-1',
    sourceId: 'source-a',
    externalId: 'native-primary',
    url: 'https://source.example/native-primary',
    observedAt: '2026-10-05T00:00:00.000Z',
    reason: 'typed-404',
    runId: 'run-1',
  });

  assert.notEqual(updated, false);
  assert.equal(updated.sourceStatus, 'Removed');
  const removed = updated.sourceOccurrences.find((item) => item.externalId === 'native-primary');
  assert.equal(removed.normalizedSnapshot.sourceStatus, 'Removed');
});

test('exact removal keeps Active secondary as canonical after primary is removed', async () => {
  const model = new FakeOpportunityModel([
    opportunity({
      sourceStatus: 'Active',
      sourceOccurrences: [
        occurrence({ externalId: 'native-primary', primary: true, status: 'Active' }),
        occurrence({ externalId: 'native-secondary', primary: false, url: 'https://source.example/secondary', status: 'Active' }),
      ],
    }),
  ]);
  const repo = repositoryWith(model);

  const updated = await repo.markSourceOccurrenceRemovedExact({
    opportunityId: 'opp-1',
    sourceId: 'source-a',
    externalId: 'native-primary',
    url: 'https://source.example/native-primary',
    observedAt: date('2026-10-05T00:00:00.000Z'),
    reason: 'typed-410',
    runId: 'run-2',
  });

  assert.notEqual(updated, false);
  assert.equal(updated.sourceStatus, 'Active');
  assert.equal(updated.sourceOccurrences.find((item) => item.externalId === 'native-secondary').status, 'Active');
});

test('exact removal promotes Unknown over Closed Expired and Removed when no Active remains', async () => {
  const model = new FakeOpportunityModel([
    opportunity({
      sourceStatus: 'Active',
      sourceOccurrences: [
        occurrence({ externalId: 'native-primary', primary: true, status: 'Active' }),
        occurrence({ externalId: 'native-unknown', primary: false, url: 'https://source.example/unknown', status: 'Unknown' }),
        occurrence({ externalId: 'native-closed', primary: false, url: 'https://source.example/closed', status: 'Closed' }),
        occurrence({ externalId: 'native-expired', primary: false, url: 'https://source.example/expired', status: 'Expired' }),
      ],
    }),
  ]);
  const repo = repositoryWith(model);

  const updated = await repo.markSourceOccurrenceRemovedExact({
    opportunityId: 'opp-1',
    sourceId: 'source-a',
    externalId: 'native-primary',
    url: 'https://source.example/native-primary',
    observedAt: date('2026-10-05T00:00:00.000Z'),
    reason: 'typed-404',
    runId: 'run-3',
  });

  assert.notEqual(updated, false);
  assert.equal(updated.sourceStatus, 'Unknown');
});

test('exact removal preserves pinned sourceStatus while updating occurrence snapshot', async () => {
  const model = new FakeOpportunityModel([
    opportunity({
      sourceStatus: 'Active',
      sourceOccurrences: [occurrence({ externalId: 'native-primary', primary: true, status: 'Active' })],
      adminCorrections: [{ field: 'sourceStatus', value: 'Active', correctedBy: 'admin', correctedAt: date('2026-10-02T00:00:00.000Z'), pinned: true }],
    }),
  ]);
  const repo = repositoryWith(model);

  const updated = await repo.markSourceOccurrenceRemovedExact({
    opportunityId: 'opp-1',
    sourceId: 'source-a',
    externalId: 'native-primary',
    url: 'https://source.example/native-primary',
    observedAt: date('2026-10-05T00:00:00.000Z'),
    reason: 'typed-410',
    runId: 'run-4',
  });

  assert.notEqual(updated, false);
  assert.equal(updated.sourceStatus, 'Active');
  assert.equal(updated.sourceOccurrences[0].status, 'Removed');
  assert.equal(updated.sourceOccurrences[0].normalizedSnapshot.sourceStatus, 'Removed');
});

test('exact removal is idempotent for a repeated already removed occurrence', async () => {
  const model = new FakeOpportunityModel([
    opportunity({
      sourceStatus: 'Removed',
      lastSeenAt: date('2026-10-06T00:00:00.000Z'),
      sourceOccurrences: [occurrence({ externalId: 'native-primary', primary: true, status: 'Removed', normalizedSnapshot: { sourceStatus: 'Removed' }, lastSeenAt: date('2026-10-06T00:00:00.000Z') })],
    }),
  ]);
  const repo = repositoryWith(model);

  const updated = await repo.markSourceOccurrenceRemovedExact({
    opportunityId: 'opp-1',
    sourceId: 'source-a',
    externalId: 'native-primary',
    url: 'https://source.example/native-primary',
    observedAt: date('2026-10-05T00:00:00.000Z'),
    reason: 'typed-404',
    runId: 'run-5',
  });

  assert.notEqual(updated, false);
  assert.equal(updated.sourceStatus, 'Removed');
  assert.equal(updated.lastSeenAt.toISOString(), '2026-10-06T00:00:00.000Z');
  assert.equal(model.findOneAndUpdateCalls.length, 0);
});
