import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { DashboardService } = require('../src/modules/dashboard/dashboard.service.ts');
const { MatchingService } = require('../src/modules/matching/matching.service.ts');

const processedStatuses = new Set([
  'Reviewed', 'Interested', 'Shortlisted',
  'Applied', 'HRReply', 'Interview', 'TechnicalInterview', 'Offer',
  'ResponseSent', 'ClientReplied', 'Negotiation', 'Won', 'InProgress', 'Completed',
  'PreparingApplication', 'ApplicationSubmitted', 'Admitted', 'BiddingEvaluation', 'Contracting',
]);

describe('dashboard recommendations', () => {
  it('ranks recommendations across the full eligible profile corpus instead of the newest 100 rows', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:30:00.000Z') });
    const baseDate = Date.parse('2026-10-05T12:00:00.000Z');
    const newestLow = Array.from({ length: 120 }, (_, index) => opportunity({
      _id: `newest-low-${String(index).padStart(3, '0')}`,
      title: `Cashier ${index}`,
      companyOrClient: `Retail ${index}`,
      skills: ['cashier'],
      technologies: ['cashier'],
      firstSeenAt: new Date(baseDate - index * 60_000),
      publishedAt: new Date(baseDate - index * 60_000),
    }));
    const important = [
      opportunity({ _id: 'old-python-96', title: 'Senior Python Platform', companyOrClient: 'A-Team', importedByUserId: 'system:ingestion', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-08-01T00:00:00.000Z'), publishedAt: new Date('2026-08-01T00:00:00.000Z') }),
      opportunity({ _id: 'null-shared-95', title: 'Null Shared Python', companyOrClient: 'Null Shared', importedByUserId: null, skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-08-02T00:00:00.000Z'), publishedAt: new Date('2026-08-02T00:00:00.000Z') }),
      opportunity({ _id: 'empty-shared-94', title: 'Empty Shared Python', companyOrClient: 'Empty Shared', importedByUserId: '', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-08-03T00:00:00.000Z'), publishedAt: new Date('2026-08-03T00:00:00.000Z') }),
      opportunity({ _id: 'restored-new-93', title: 'Restored Python', companyOrClient: 'B-Team', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-07-01T00:00:00.000Z'), publishedAt: new Date('2026-07-01T00:00:00.000Z') }),
      opportunity({ _id: 'reviewed-100', title: 'Reviewed Python', companyOrClient: 'Reviewed', importedByUserId: 'system:ingestion', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-10-04T01:00:00.000Z'), publishedAt: new Date('2026-10-04T01:00:00.000Z') }),
      opportunity({ _id: 'interested-100', title: 'Interested Python', companyOrClient: 'Interested', importedByUserId: 'system:ingestion', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-10-04T02:00:00.000Z'), publishedAt: new Date('2026-10-04T02:00:00.000Z') }),
      opportunity({ _id: 'shortlisted-100', title: 'Shortlisted Python', companyOrClient: 'Shortlisted', importedByUserId: 'system:ingestion', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-10-04T03:00:00.000Z'), publishedAt: new Date('2026-10-04T03:00:00.000Z') }),
      opportunity({ _id: 'processed-99', title: 'Already Applied', companyOrClient: 'C-Team', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-10-04T00:00:00.000Z'), publishedAt: new Date('2026-10-04T00:00:00.000Z') }),
      opportunity({ _id: 'foreign-native-91', title: 'Foreign Native Python', companyOrClient: 'Foreign Native', importedByUserId: 'other-user', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-08-04T00:00:00.000Z'), publishedAt: new Date('2026-08-04T00:00:00.000Z') }),
      opportunity({ _id: 'hidden-100', title: 'Hidden Python', companyOrClient: 'Hidden', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'rejected-100', title: 'Rejected Python', companyOrClient: 'Rejected', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'archived-100', title: 'Archived Python', companyOrClient: 'Archived', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'wrong-profile-100', title: 'Wrong Profile Python', companyOrClient: 'Wrong Profile', skills: ['cashier'], technologies: ['cashier'] }),
      opportunity({ _id: 'wrong-user-100', title: 'Wrong User Python', companyOrClient: 'Wrong User', skills: ['cashier'], technologies: ['cashier'] }),
      opportunity({ _id: 'deleted-state-100', title: 'Deleted State Python', companyOrClient: 'Deleted State', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'private-100', title: 'Private Import', companyOrClient: 'Private', importedByUserId: 'other-user', sourceId: 'manual', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'wrong-source-100', title: 'Wrong Source Python', companyOrClient: 'Wrong Source', sourceId: 'blocked-source', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'closed-100', title: 'Closed Python', companyOrClient: 'Closed', sourceStatus: 'Closed', skills: ['Python'], technologies: ['Python'] }),
    ];
    const states = [
      ...newestLow.map((item) => state({ opportunityId: item._id, matchScore: 49 })),
      state({ opportunityId: 'old-python-96', matchScore: 96 }),
      state({ opportunityId: 'null-shared-95', matchScore: 95 }),
      state({ opportunityId: 'empty-shared-94', matchScore: 94 }),
      state({ opportunityId: 'restored-new-93', matchScore: 93, pipelineStatus: 'New' }),
      state({ opportunityId: 'reviewed-100', matchScore: 100, pipelineStatus: 'Reviewed' }),
      state({ opportunityId: 'interested-100', matchScore: 100, pipelineStatus: 'Interested' }),
      state({ opportunityId: 'shortlisted-100', matchScore: 100, pipelineStatus: 'Shortlisted' }),
      state({ opportunityId: 'processed-99', matchScore: 99, pipelineStatus: 'Applied' }),
      state({ opportunityId: 'foreign-native-91', matchScore: 91 }),
      state({ opportunityId: 'hidden-100', matchScore: 100, hidden: true }),
      state({ opportunityId: 'rejected-100', matchScore: 100, pipelineStatus: 'Rejected' }),
      state({ opportunityId: 'archived-100', matchScore: 100, archived: true }),
      state({ opportunityId: 'wrong-profile-100', profileId: 'other-profile', matchScore: 100 }),
      state({ opportunityId: 'wrong-user-100', userId: 'other-user', matchScore: 100 }),
      state({ opportunityId: 'deleted-state-100', matchScore: 100, deletedAt: new Date() }),
      state({ opportunityId: 'private-100', matchScore: 100 }),
      state({ opportunityId: 'wrong-source-100', matchScore: 100 }),
      state({ opportunityId: 'closed-100', matchScore: 100 }),
    ];
    const service = dashboardService({
      opportunities: new FakeOpportunityModel([...newestLow, ...important], states),
      states: new FakeStateModel(states),
    });

    const result = await service.summary(actor(), {});
    const ids = result.recommended.map((item) => item.id);

    assert.equal(ids[0], 'old-python-96');
    assert.ok(ids.includes('null-shared-95'));
    assert.ok(ids.includes('empty-shared-94'));
    assert.ok(ids.includes('restored-new-93'));
    assert.ok(ids.includes('foreign-native-91'));
    assert.ok(ids.indexOf('newest-low-000') === -1 || ids.indexOf('old-python-96') < ids.indexOf('newest-low-000'));
    assert.equal(ids.includes('hidden-100'), false);
    assert.equal(ids.includes('rejected-100'), false);
    assert.equal(ids.includes('archived-100'), false);
    assert.equal(ids.includes('wrong-profile-100'), false);
    assert.equal(ids.includes('wrong-user-100'), false);
    assert.equal(ids.includes('deleted-state-100'), false);
    assert.equal(ids.includes('private-100'), false);
    assert.equal(ids.includes('wrong-source-100'), false);
    assert.equal(ids.includes('closed-100'), false);
    for (const id of ['reviewed-100', 'interested-100', 'shortlisted-100']) {
      assert.ok(ids.indexOf(id) === -1 || ids.indexOf(id) > ids.indexOf('restored-new-93'));
    }
    assert.ok(ids.indexOf('processed-99') === -1 || ids.indexOf('processed-99') > ids.indexOf('restored-new-93'));
    assert.equal(result.recentlyAdded.length, 8);
    assert.equal(result.recentlyAdded[0].id, 'newest-low-000');
  });

  it('uses freshness and stable id ordering when match scores tie', async () => {
    const opportunities = [
      opportunity({ _id: 'tie-old', firstSeenAt: new Date('2026-10-01T00:00:00.000Z'), publishedAt: new Date('2026-10-01T00:00:00.000Z') }),
      opportunity({ _id: 'tie-new', firstSeenAt: new Date('2026-10-04T00:00:00.000Z'), publishedAt: new Date('2026-10-04T00:00:00.000Z') }),
      opportunity({ _id: 'tie-alpha', firstSeenAt: new Date('2026-10-03T00:00:00.000Z'), publishedAt: new Date('2026-10-03T00:00:00.000Z') }),
      opportunity({ _id: 'tie-beta', firstSeenAt: new Date('2026-10-03T00:00:00.000Z'), publishedAt: new Date('2026-10-03T00:00:00.000Z') }),
    ];
    const states = opportunities.map((item) => state({ opportunityId: item._id, matchScore: 90 }));
    const result = await dashboardService({ opportunities: new FakeOpportunityModel(opportunities, states), states: new FakeStateModel(states) }).summary(actor(), {});

    assert.deepEqual(result.recommended.map((item) => item.id), ['tie-new', 'tie-alpha', 'tie-beta', 'tie-old']);
  });

  it('recomputes cached states with invalid numeric match scores outside the 0-100 contract', async () => {
    const opportunities = [
      opportunity({ _id: 'too-high-score', title: 'Too High Score', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-08-01T00:00:00.000Z'), publishedAt: new Date('2026-08-01T00:00:00.000Z') }),
      opportunity({ _id: 'negative-score', title: 'Negative Score', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-08-02T00:00:00.000Z'), publishedAt: new Date('2026-08-02T00:00:00.000Z') }),
      opportunity({ _id: 'valid-cached-score', title: 'Valid Cached Score', skills: ['cashier'], technologies: ['cashier'], firstSeenAt: new Date('2026-10-05T00:00:00.000Z'), publishedAt: new Date('2026-10-05T00:00:00.000Z') }),
    ];
    const states = [
      state({ opportunityId: 'too-high-score', matchScore: 124 }),
      state({ opportunityId: 'negative-score', matchScore: -5 }),
      state({ opportunityId: 'valid-cached-score', matchScore: 40 }),
    ];
    const matching = new CountingMatchingService();
    const result = await dashboardService({ opportunities: new FakeOpportunityModel(opportunities, states), states: new FakeStateModel(states), matching }).summary(actor(), {});
    const ids = result.recommended.map(item => item.id);

    assert.ok(ids.includes('too-high-score'));
    assert.ok(ids.includes('negative-score'));
    assert.ok(ids.includes('valid-cached-score'));
    assert.equal(matching.calculatedIds.includes('valid-cached-score'), false);
    assert.equal(matching.calculatedIds.includes('too-high-score'), true);
    assert.equal(matching.calculatedIds.includes('negative-score'), true);
  });

  it('limits a large same-score band after server-side freshness ordering', async () => {
    const opportunities = Array.from({ length: 80 }, (_, index) => opportunity({
      _id: `same-score-${String(index).padStart(2, '0')}`,
      firstSeenAt: new Date(`2026-08-${String((index % 20) + 1).padStart(2, '0')}T00:00:00.000Z`),
      publishedAt: new Date(`2026-08-${String((index % 20) + 1).padStart(2, '0')}T00:00:00.000Z`),
    }));
    opportunities[79].publishedAt = new Date('2026-10-05T00:00:00.000Z');
    opportunities[79].firstSeenAt = new Date('2026-10-05T00:00:00.000Z');
    const states = opportunities.map((item) => state({ opportunityId: item._id, matchScore: 72 }));
    const fakeStates = new FakeStateModel(states);
    const matching = new CountingMatchingService();
    const result = await dashboardService({ opportunities: new FakeOpportunityModel(opportunities, states), states: fakeStates, matching }).summary(actor(), {});

    const ids = result.recommended.map((item) => item.id);
    assert.equal(fakeStates.lastBatchReturned, 64);
    assert.equal(matching.calculateCalls, 0);
    assert.equal(ids[0], 'same-score-79');
    assert.equal(ids.length, 8);
  });

  it('computes recommendations for existing states without a finite cached match score', async () => {
    const opportunities = [
      opportunity({ _id: 'missing-score-python', title: 'Missing Score Python', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'hidden-missing-score', title: 'Hidden Missing Score', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'negative-missing-score', title: 'Negative Missing Score', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'processed-missing-score', title: 'Processed Missing Score', skills: ['Python'], technologies: ['Python'] }),
    ];
    const states = [
      state({ opportunityId: 'missing-score-python', matchScore: undefined }),
      state({ opportunityId: 'hidden-missing-score', matchScore: undefined, hidden: true }),
      state({ opportunityId: 'negative-missing-score', matchScore: undefined, pipelineStatus: 'Rejected' }),
      state({ opportunityId: 'processed-missing-score', matchScore: undefined, pipelineStatus: 'Reviewed' }),
    ];
    const result = await dashboardService({ opportunities: new FakeOpportunityModel(opportunities, states), states: new FakeStateModel(states) }).summary(actor(), {});
    const ids = result.recommended.map((item) => item.id);

    assert.equal(ids[0], 'missing-score-python');
    assert.equal(result.recommended[0].matchScore > 0, true);
    assert.equal(ids.includes('hidden-missing-score'), false);
    assert.equal(ids.includes('negative-missing-score'), false);
    assert.ok(ids.indexOf('processed-missing-score') === -1 || ids.indexOf('processed-missing-score') > ids.indexOf('missing-score-python'));
  });

  it('ranks uncached eligible opportunities against a full cached top64 without materializing all rows', async () => {
    const cached = Array.from({ length: 80 }, (_, index) => opportunity({
      _id: `cached-low-${String(index).padStart(2, '0')}`,
      title: `Cached low ${index}`,
      skills: ['cashier'],
      technologies: ['cashier'],
      firstSeenAt: new Date('2026-09-01T00:00:00.000Z'),
      publishedAt: new Date('2026-09-01T00:00:00.000Z'),
    }));
    const uncached = [
      opportunity({ _id: 'uncached-python-old', title: 'Uncached Python Old', companyOrClient: 'Uncached A', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-08-01T00:00:00.000Z'), publishedAt: new Date('2026-08-01T00:00:00.000Z') }),
      opportunity({ _id: 'missing-score-python', title: 'Missing Score Python', companyOrClient: 'Uncached B', sourceId: 'source-secondary', skills: ['Python'], technologies: ['Python'], firstSeenAt: new Date('2026-08-02T00:00:00.000Z'), publishedAt: new Date('2026-08-02T00:00:00.000Z') }),
      opportunity({ _id: 'hidden-missing-score', title: 'Hidden Missing Score', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'rejected-missing-score', title: 'Rejected Missing Score', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'processed-missing-score', title: 'Processed Missing Score', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'wrong-source-uncached', title: 'Wrong Source Uncached', sourceId: 'blocked-source', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'private-uncached', title: 'Private Uncached', importedByUserId: 'other-user', sourceId: 'manual', skills: ['Python'], technologies: ['Python'] }),
    ];
    const filler = Array.from({ length: 700 }, (_, index) => opportunity({
      _id: `uncached-filler-${String(index).padStart(3, '0')}`,
      title: `Uncached filler ${index}`,
      skills: ['cashier'],
      technologies: ['cashier'],
    }));
    const states = [
      ...cached.map((item) => state({ opportunityId: item._id, matchScore: 1 })),
      state({ opportunityId: 'missing-score-python', matchScore: undefined }),
      state({ opportunityId: 'hidden-missing-score', matchScore: undefined, hidden: true }),
      state({ opportunityId: 'rejected-missing-score', matchScore: undefined, pipelineStatus: 'Rejected' }),
      state({ opportunityId: 'processed-missing-score', matchScore: undefined, pipelineStatus: 'Reviewed' }),
    ];
    const fakeOpportunities = new FakeOpportunityModel([...cached, ...uncached, ...filler], states);
    const result = await dashboardService({ opportunities: fakeOpportunities, states: new FakeStateModel(states) }).summary(actor(), {});
    const ids = result.recommended.map((item) => item.id);
    assert.equal(ids[0], 'missing-score-python');
    assert.equal(ids[1], 'uncached-python-old');
    assert.equal(ids.includes('hidden-missing-score'), false);
    assert.equal(ids.includes('rejected-missing-score'), false);
    assert.equal(ids.includes('processed-missing-score'), false);
    assert.equal(ids.includes('wrong-source-uncached'), false);
    assert.equal(ids.includes('private-uncached'), false);
    assert.ok(fakeOpportunities.maxAggregateReturned <= 500);
  });

  it('moderately diversifies repeated source employer and technology clusters', async () => {
    const opportunities = [
      opportunity({ _id: 'same-source-99', sourceId: 'source-main', companyOrClient: 'SameCo', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'same-source-98', sourceId: 'source-main', companyOrClient: 'SameCo', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'same-source-97', sourceId: 'source-main', companyOrClient: 'SameCo', skills: ['Python'], technologies: ['Python'] }),
      opportunity({ _id: 'diverse-80', sourceId: 'source-secondary', companyOrClient: 'OtherCo', skills: ['Go'], technologies: ['Go'] }),
    ];
    const states = [
      state({ opportunityId: 'same-source-99', matchScore: 99 }),
      state({ opportunityId: 'same-source-98', matchScore: 98 }),
      state({ opportunityId: 'same-source-97', matchScore: 97 }),
      state({ opportunityId: 'diverse-80', matchScore: 80 }),
    ];
    const result = await dashboardService({
      opportunities: new FakeOpportunityModel(opportunities, states),
      states: new FakeStateModel(states),
      profile: profile({ sourceIds: ['source-main', 'source-secondary'] }),
      sources: new FakeModel([source('source-main'), source('source-secondary')]),
    }).summary(actor(), {});
    const ids = result.recommended.map((item) => item.id);

    assert.deepEqual(ids, ['same-source-99', 'same-source-98', 'diverse-80', 'same-source-97']);
  });
});

function dashboardService({ profile: activeProfile = profile(), opportunities, states, sources = new FakeModel([source('source-main')]), matching = new MatchingService() }) {
  if (typeof states.attachOpportunities === 'function') states.attachOpportunities(opportunities.records);
  return new DashboardService(
    { getMe: async () => ({ name: 'Manual User', timezone: 'Europe/Moscow' }) },
    { listByUser: async () => [activeProfile], getOwned: async () => activeProfile },
    matching,
    { list: async () => ({ items: [] }) },
    { dueTasksForUser: async () => [] },
    opportunities,
    states,
    sources,
    new FakeConnection(),
  );
}

function actor() {
  return { id: 'user-1', email: 'manual@example.test', role: 'User' };
}

function profile(overrides = {}) {
  return {
    _id: 'profile-1',
    userId: 'user-1',
    name: 'Senior Python',
    kind: 'career',
    isActive: true,
    targetRoles: ['Senior Python Developer'],
    technologies: ['Python'],
    sourceIds: ['source-main', 'source-secondary'],
    structuredExperienceSummary: 'ok',
    ...overrides,
  };
}

function source(_id) {
  return { _id, name: _id, enabled: true, runtimeState: 'Enabled', healthState: 'Operational' };
}

function opportunity(overrides = {}) {
  const sourceId = overrides.sourceId ?? 'source-main';
  return {
    _id: 'opp-1',
    type: 'vacancy',
    title: 'Opportunity',
    companyOrClient: 'Company',
    description: 'Python work',
    sourceStatus: 'Active',
    firstSeenAt: new Date('2026-10-01T00:00:00.000Z'),
    publishedAt: new Date('2026-10-01T00:00:00.000Z'),
    skills: ['Python'],
    technologies: ['Python'],
    money: {},
    sourceOccurrences: [{ sourceId, primary: true, url: `https://example.test/${overrides._id ?? 'opp-1'}`, rawPayload: { huge: true }, sourceMetadata: { huge: true } }],
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


class CountingMatchingService extends MatchingService {
  calculateCalls = 0;
  calculatedIds = [];
  calculate(opportunity, profile) {
    this.calculateCalls += 1;
    this.calculatedIds.push(opportunity._id);
    return super.calculate(opportunity, profile);
  }
}

class FakeOpportunityModel {
  constructor(records, states) {
    this.records = records;
    this.states = states;
    this.findCalls = [];
    this.aggregateCalls = [];
  }
  async countDocuments(filter = {}) {
    return this.records.filter(record => matches(record, filter)).length;
  }
  find(filter = {}, projection) {
    this.findCalls.push({ filter, projection });
    return new FakeQuery(this.records.filter(record => matches(record, filter)).map(record => project(record, projection)));
  }
  aggregate(pipeline) {
    this.aggregateCalls.push(pipeline);
    const firstMatch = pipeline.find(stage => stage.$match)?.$match ?? {};
    const stateMatch = dashboardLookupStateMatch(pipeline);
    const computedOnly = pipeline.some(stage => stage.$match?.$or?.some?.(option => option.dashboardState === null || option['dashboardState.matchScore']));
    const cachelessOnly = pipeline.some(stage => stage.$match?.dashboardState?.$size === 0);
    const limit = pipeline.findLast?.(stage => stage.$limit)?.$limit ?? 64;
    let rows = this.records
      .filter(record => matches(record, firstMatch))
      .map(record => {
        const dashboardState = this.states.find(stateRecord => stateRecord.userId === stateMatch.userId
          && stateRecord.profileId === stateMatch.profileId
          && stateRecord.opportunityId === record._id);
        return { ...project(record, { 'sourceOccurrences.rawPayload': 0 }), dashboardState };
      });
    if (computedOnly) {
      rows = rows
        .filter(record => !record.dashboardState?.deletedAt)
        .filter(record => record.dashboardState?.hidden !== true)
        .filter(record => record.dashboardState?.archived !== true)
        .filter(record => !['Rejected', 'Lost', 'Archived'].includes(record.dashboardState?.pipelineStatus))
        .filter(record => !validCachedScore(record.dashboardState?.matchScore))
        .sort((left, right) => String(left._id).localeCompare(String(right._id)));
    } else if (cachelessOnly) {
      rows = rows
        .filter(record => !record.dashboardState)
        .sort((left, right) => +new Date(right.publishedAt ?? right.firstSeenAt ?? 0) - +new Date(left.publishedAt ?? left.firstSeenAt ?? 0) || String(left._id).localeCompare(String(right._id)));
    } else {
      rows = rows
        .filter(record => record.dashboardState?.hidden !== true)
        .filter(record => record.dashboardState?.archived !== true)
        .filter(record => !['Rejected', 'Lost', 'Archived'].includes(record.dashboardState?.pipelineStatus))
        .sort(compareRecommendationRows);
    }
    const returned = rows.slice(0, computedOnly ? undefined : limit);
    this.maxAggregateReturned = Math.max(this.maxAggregateReturned ?? 0, computedOnly ? 500 : returned.length);
    return new FakeQuery(returned);
  }

}

class FakeModel {
  constructor(records) {
    this.records = records;
  }
  async countDocuments(filter = {}) {
    return this.records.filter(record => matches(record, filter)).length;
  }
  find(filter = {}, projection) {
    return new FakeQuery(this.records.filter(record => matches(record, filter)).map(record => project(record, projection)));
  }
}

class FakeStateModel extends FakeModel {
  attachOpportunities(records) {
    this.opportunities = records;
  }
  aggregate(pipeline) {
    const firstMatch = pipeline.find(stage => stage.$match)?.$match ?? {};
    const stateMatch = withoutExpr(firstMatch);
    const rankedStates = this.records
      .filter(record => matches(record, stateMatch))
      .filter(record => validCachedScore(record.matchScore))
      .map(record => ({
        ...record,
        recommendationMatchScore: record.matchScore,
      }));
    if (pipeline.some(stage => stage.$group)) {
      const grouped = new Map();
      for (const record of rankedStates) {
        const key = record.recommendationMatchScore;
        grouped.set(key, { _id: key, count: (grouped.get(key)?.count ?? 0) + 1 });
      }
      return new FakeQuery([...grouped.values()].sort((left, right) => right._id - left._id));
    }
    const scoreList = firstMatch.matchScore?.$in ?? firstMatch.$expr?.$in?.[1] ?? [];
    const lookupMatch = withoutExpr(pipeline.find(stage => stage.$lookup)?.$lookup?.pipeline?.find(stage => stage.$match)?.$match ?? {});
    const limit = pipeline.find(stage => stage.$limit)?.$limit;
    const rows = rankedStates
      .filter(record => scoreList.includes(record.recommendationMatchScore))
      .flatMap(record => {
        const opportunity = this.opportunities.find(item => item._id === record.opportunityId && matches(item, lookupMatch));
        return opportunity ? [{ ...project(opportunity, { 'sourceOccurrences.rawPayload': 0 }), dashboardState: stateProjection(record) }] : [];
      })
      .sort((left, right) => (right.dashboardState?.matchScore ?? -1) - (left.dashboardState?.matchScore ?? -1)
        || +new Date(right.publishedAt ?? right.firstSeenAt ?? 0) - +new Date(left.publishedAt ?? left.firstSeenAt ?? 0)
        || String(left._id).localeCompare(String(right._id)))
      .slice(0, limit ?? undefined);
    this.lastBatchReturned = rows.length;
    return new FakeQuery(rows);
  }
}

class FakeQuery {
  constructor(records) {
    this.records = records;
  }
  sort(sortSpec = {}) {
    const entries = Object.entries(sortSpec);
    this.records = [...this.records].sort((left, right) => {
      for (const [field, direction] of entries) {
        const compared = compareValues(valueAt(left, field)?.[0], valueAt(right, field)?.[0]);
        if (compared !== 0) return direction === -1 ? -compared : compared;
      }
      return 0;
    });
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
  models = {};
  collection() {
    return new FakeModel([]);
  }
}


function dashboardLookupStateMatch(pipeline) {
  const lookup = pipeline.find(stage => stage.$lookup)?.$lookup;
  const pipelineMatch = lookup?.pipeline?.find(stage => stage.$match)?.$match;
  if (pipelineMatch) return pipelineMatch;
  const filter = pipeline.find(stage => stage.$set?.dashboardState?.$first?.$filter)?.$set.dashboardState.$first.$filter;
  const conditions = filter?.cond?.$and ?? [];
  const stateMatch = {};
  for (const condition of conditions) {
    const [field, value] = condition.$eq ?? [];
    if (field === '$$state.userId') stateMatch.userId = value;
    if (field === '$$state.profileId') stateMatch.profileId = value;
  }
  return stateMatch;
}

function validCachedScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function compareRecommendationRows(left, right) {
  const leftProcessed = processedStatuses.has(left.dashboardState?.pipelineStatus) ? 1 : 0;
  const rightProcessed = processedStatuses.has(right.dashboardState?.pipelineStatus) ? 1 : 0;
  return leftProcessed - rightProcessed
    || (right.dashboardState?.matchScore ?? -1) - (left.dashboardState?.matchScore ?? -1)
    || +new Date(right.publishedAt ?? right.firstSeenAt ?? 0) - +new Date(left.publishedAt ?? left.firstSeenAt ?? 0)
    || String(left._id).localeCompare(String(right._id));
}

function matches(record, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return condition.some(option => matches(record, option));
    if (key === '$and') return condition.every(option => matches(record, option));
    return matchesCondition(valueAt(record, key), condition);
  });
}

function matchesCondition(value, condition) {
  if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
    return Object.entries(condition).every(([operator, expected]) => {
      if (operator === '$exists') return expected ? value !== undefined : value === undefined;
      if (operator === '$in') return values(value).some(item => expected.includes(item));
      if (operator === '$nin') return values(value).every(item => !expected.includes(item));
      if (operator === '$ne') return values(value).every(item => item !== expected);
      if (operator === '$type') return expected === 'number' ? values(value).some(item => typeof item === 'number' && Number.isFinite(item)) : false;
      if (operator === '$gt') return values(value).some(item => item > expected);
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

function withoutExpr(filter) {
  const { $expr: _expr, ...rest } = filter;
  return rest;
}

function stateProjection(record) {
  return {
    _id: record._id,
    userId: record.userId,
    opportunityId: record.opportunityId,
    profileId: record.profileId,
    pipelineStatus: record.pipelineStatus,
    favorite: record.favorite,
    hidden: record.hidden,
    archived: record.archived,
    matchScore: record.matchScore,
    deletedAt: record.deletedAt,
  };
}

function project(record, projection) {
  if (!projection) return record;
  return {
    ...record,
    sourceOccurrences: record.sourceOccurrences?.map(occurrence => {
      const { rawPayload: _rawPayload, sourceMetadata: _sourceMetadata, ...rest } = occurrence;
      return rest;
    }),
  };
}

function compareValues(left, right) {
  const leftValue = left instanceof Date ? +left : left;
  const rightValue = right instanceof Date ? +right : right;
  if (leftValue === rightValue) return 0;
  if (leftValue === undefined) return 1;
  if (rightValue === undefined) return -1;
  return leftValue > rightValue ? 1 : -1;
}
