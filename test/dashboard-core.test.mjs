import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { DashboardService } = require('../src/modules/dashboard/dashboard.service.ts');
const { MatchingService } = require('../src/modules/matching/matching.service.ts');

describe('dashboard', () => {
  it('summarizes imported canonical rows with missing optional money skills and sources', async () => {
    const imported = {
      _id: 'opp-imported-1',
      type: 'vacancy',
      title: 'Imported row without optional fields',
      companyOrClient: undefined,
      description: undefined,
      sourceStatus: 'Unknown',
      firstSeenAt: new Date(),
      publishedAt: undefined,
    };
    const service = new DashboardService(
      { getMe: async () => ({ name: 'Manual User', timezone: 'Europe/Moscow' }) },
      { listByUser: async () => [{ _id: 'profile-1', userId: 'user-1', name: 'Profile', kind: 'career', isActive: true, targetRoles: [], technologies: [], structuredExperienceSummary: 'ok' }], getOwned: async () => ({ _id: 'profile-1', userId: 'user-1', name: 'Profile', kind: 'career', isActive: true, targetRoles: [], technologies: [], structuredExperienceSummary: 'ok' }) },
      new MatchingService(),
      { list: async () => ({ items: [] }) },
      { dueTasksForUser: async () => [] },
      new FakeModel([imported]),
      new FakeModel([]),
      new FakeModel([]),
      new FakeConnection(),
    );

    const result = await service.summary({ id: 'user-1', email: 'manual@example.test', role: 'User' }, {});

    assert.equal(result.recommended[0].id, 'opp-imported-1');
    assert.equal(result.recommended[0].compensationLabel, 'Сумма не указана');
    assert.equal(result.recommended[0].source.name, 'Ручной импорт');
    assert.deepEqual(result.recommended[0].skills, []);
    assert.equal(result.recommended[0].description, '');
  });

  it('loads personal states only for dashboard candidate and watchlist opportunities', async () => {
    const opportunities = [
      opportunity({ _id: 'candidate-hidden', title: 'Hidden dashboard candidate' }),
      opportunity({ _id: 'watch-hit-only', title: 'Watchlist-only opportunity', sourceStatus: 'Closed' }),
      opportunity({ _id: 'unrelated', title: 'Unrelated canonical row' }),
    ];
    const states = new FakeModel([
      state({ opportunityId: 'candidate-hidden', hidden: true, pipelineStatus: 'Applied', matchScore: 91 }),
      state({ opportunityId: 'watch-hit-only', hidden: true, favorite: true, pipelineStatus: 'Interview', matchScore: 88 }),
      state({ opportunityId: 'unbounded-noise', pipelineStatus: 'Interview', matchScore: 99 }),
      state({ opportunityId: 'deleted-noise', deletedAt: new Date(), pipelineStatus: 'Interview', matchScore: 100 }),
    ]);
    const watchHits = [
      { _id: 'hit-1', userId: 'user-1', profileId: 'profile-1', opportunityId: 'watch-hit-only', matchedAt: new Date() },
    ];
    const service = dashboardService({
      opportunities: new FakeModel(opportunities),
      states,
      connection: new FakeConnection({ watchlisthits: watchHits }),
    });

    const result = await service.summary({ id: 'user-1', email: 'manual@example.test', role: 'User' }, {});

    assert.deepEqual(states.findCalls, [{
      filter: {
        userId: 'user-1',
        profileId: 'profile-1',
        deletedAt: { $exists: false },
        opportunityId: { $in: ['candidate-hidden', 'unrelated', 'watch-hit-only'] },
      },
      projection: undefined,
    }]);
    assert.equal(result.kpis.find(item => item.id === 'pipeline').value, '3');
    assert.equal(result.recommended.some(item => item.id === 'candidate-hidden'), false);
    assert.equal(result.watchlistHits[0].id, 'watch-hit-only');
    assert.equal(result.watchlistHits[0].matchScore, 88);
    assert.equal(result.watchlistHits[0].pipelineStage, 'Interview');
    assert.equal(result.watchlistHits[0].favorite, true);
    assert.equal(result.watchlistHits[0].hidden, true);
  });

  it('does not query personal states when the user has no dashboard profile', async () => {
    const states = new FakeModel([state({ opportunityId: 'candidate-1', matchScore: 99 })]);
    const service = dashboardService({
      profiles: [],
      opportunities: new FakeModel([opportunity({ _id: 'candidate-1' })]),
      states,
    });

    const result = await service.summary({ id: 'user-1', email: 'manual@example.test', role: 'User' }, {});

    assert.equal(result.activeProfile, null);
    assert.deepEqual(result.recommended, []);
    assert.deepEqual(states.findCalls, []);
  });

  it('shows the desired Kwork upper budget with a currency instead of a raw decimal', async () => {
    const service = dashboardService({ opportunities: new FakeModel([
      opportunity({ _id: 'kwork-budget', money: { max: 150000, currency: 'RUB', kind: 'desired-upper-bound', originalText: '150000.00' } }),
    ]) });
    const result = await service.summary({ id: 'user-1', email: 'manual@example.test', role: 'User' }, {});
    assert.equal(result.recommended[0].compensationLabel, `до ${(150000).toLocaleString('ru-RU')} ₽`);
  });
});

function dashboardService({ profiles = [profile()], opportunities = new FakeModel([]), states = new FakeModel([]), sources = new FakeModel([]), connection = new FakeConnection() } = {}) {
  opportunities.stateRecords = states.records;
  return new DashboardService(
    { getMe: async () => ({ name: 'Manual User', timezone: 'Europe/Moscow' }) },
    {
      listByUser: async () => profiles,
      getOwned: async (_id, userId) => profiles.find(item => item._id === _id && item.userId === userId),
    },
    new MatchingService(),
    { list: async () => ({ items: [] }) },
    { dueTasksForUser: async () => [] },
    opportunities,
    states,
    sources,
    connection,
  );
}

function profile(overrides = {}) {
  return {
    _id: 'profile-1',
    userId: 'user-1',
    name: 'Profile',
    kind: 'career',
    isActive: true,
    targetRoles: [],
    technologies: [],
    structuredExperienceSummary: 'ok',
    ...overrides,
  };
}

function opportunity(overrides = {}) {
  return {
    _id: 'opp-1',
    type: 'vacancy',
    title: 'Opportunity',
    companyOrClient: '',
    description: '',
    sourceStatus: 'Active',
    firstSeenAt: new Date(),
    publishedAt: new Date(),
    sourceOccurrences: [{ sourceId: 'source-1', primary: true, url: 'https://example.test/job', rawPayload: { huge: true } }],
    sourceMetadata: { huge: true },
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    _id: `state-${overrides.opportunityId ?? 'opp-1'}`,
    userId: 'user-1',
    profileId: 'profile-1',
    opportunityId: 'opp-1',
    archived: false,
    hidden: false,
    favorite: false,
    pipelineStatus: 'New',
    matchScore: 50,
    ...overrides,
  };
}

class FakeModel {
  constructor(records) {
    this.records = records;
    this.findCalls = [];
    this.countCalls = [];
  }
  async countDocuments(filter = {}) {
    this.countCalls.push(filter);
    return this.records.filter(record => matches(record, filter)).length;
  }
  find(filter = {}, projection) {
    this.findCalls.push({ filter, projection });
    return new FakeQuery(this.records.filter(record => matches(record, filter)).map(record => project(record, projection)));
  }
  aggregate() {
    const states = this.stateRecords ?? [];
    const records = this.records
      .filter(record => ['Active', 'Unknown'].includes(record.sourceStatus))
      .filter(record => !record.importedByUserId || record.importedByUserId === 'system:ingestion' || record.importedByUserId === 'user-1' || !isPrivateImport(record))
      .map(record => ({ ...project(record, { 'sourceOccurrences.rawPayload': 0 }), dashboardState: states.find(stateRecord => stateRecord.userId === 'user-1' && stateRecord.profileId === 'profile-1' && stateRecord.opportunityId === record._id && !stateRecord.deletedAt) }))
      .filter(record => record.dashboardState?.hidden !== true)
      .filter(record => record.dashboardState?.archived !== true)
      .filter(record => !['Rejected', 'Lost', 'Archived'].includes(record.dashboardState?.pipelineStatus))
      .sort((left, right) => {
        const leftProcessed = processedRank(left.dashboardState?.pipelineStatus);
        const rightProcessed = processedRank(right.dashboardState?.pipelineStatus);
        return leftProcessed - rightProcessed
          || (right.dashboardState?.matchScore ?? -1) - (left.dashboardState?.matchScore ?? -1)
          || +new Date(right.publishedAt ?? right.firstSeenAt ?? 0) - +new Date(left.publishedAt ?? left.firstSeenAt ?? 0)
          || String(left._id).localeCompare(String(right._id));
      })
      .slice(0, 64);
    return new FakeQuery(records);
  }
}

class FakeQuery {
  constructor(records) {
    this.records = records;
  }
  sort() {
    return this;
  }
  limit(value) {
    this.records = this.records.slice(0, value);
    return this;
  }
  lean() {
    return this;
  }
  cursor() {
    return this;
  }
  [Symbol.asyncIterator]() {
    let index = 0;
    const records = this.records;
    return {
      async next() {
        if (index >= records.length) return { done: true };
        return { done: false, value: records[index++] };
      },
    };
  }
  async exec() {
    return this.records;
  }
  async toArray() {
    return this.records;
  }
}

class FakeConnection {
  constructor(collections = {}) {
    this.collections = collections;
  }
  models = {};
  collection(_name, fallback) {
    const records = this.collections[_name] ?? this.collections[fallback] ?? [];
    return new FakeCollection(records);
  }
}

class FakeCollection {
  constructor(records) {
    this.records = records;
  }
  find(filter = {}) {
    return new FakeQuery(this.records.filter(record => matches(record, filter)));
  }
  async countDocuments(filter = {}) {
    return this.records.filter(record => matches(record, filter)).length;
  }
}

function matches(record, filter) {
  return Object.entries(filter).every(([key, condition]) => matchesCondition(valueAt(record, key), condition));
}

function matchesCondition(value, condition) {
  if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
    return Object.entries(condition).every(([operator, expected]) => {
      if (operator === '$exists') return expected ? value !== undefined : value === undefined;
      if (operator === '$in') return values(value).some(item => expected.includes(item));
      if (operator === '$nin') return values(value).every(item => !expected.includes(item));
      if (operator === '$gte') return values(value).some(item => +new Date(item) >= +new Date(expected));
      if (operator === '$lte') return values(value).some(item => +new Date(item) <= +new Date(expected));
      return false;
    });
  }
  return values(value).includes(condition);
}

function valueAt(record, path) {
  const found = path.split('.').reduce((valuesSoFar, part) => valuesSoFar.flatMap(value => {
    if (Array.isArray(value)) return value.map(item => item?.[part]);
    return [value?.[part]];
  }), [record]).filter(value => value !== undefined);
  return found.length ? found : undefined;
}

function values(value) {
  return Array.isArray(value) ? value : [value];
}

function project(record, projection) {
  if (!projection) return record;
  const clone = {
    ...record,
    sourceOccurrences: record.sourceOccurrences?.map(occurrence => {
      const { rawPayload, sourceMetadata, ...rest } = occurrence;
      return rest;
    }),
  };
  return clone;
}

function processedRank(status) {
  return ['Reviewed', 'Interested', 'Shortlisted', 'Applied', 'HRReply', 'Interview', 'TechnicalInterview', 'Offer', 'ResponseSent', 'ClientReplied', 'Negotiation', 'Won', 'InProgress', 'Completed', 'PreparingApplication', 'ApplicationSubmitted', 'Admitted', 'BiddingEvaluation', 'Contracting'].includes(status) ? 1 : 0;
}

function isPrivateImport(record) {
  return record.sourceOccurrences?.some(occurrence => occurrence.sourceId === 'manual' || occurrence.sourceMetadata?.importFileId);
}
