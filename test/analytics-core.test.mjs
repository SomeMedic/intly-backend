import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { AnalyticsService } = require('../src/modules/analytics/analytics.service.ts');

const now = new Date('2026-10-02T12:00:00.000Z');
const opportunities = [
  {
    _id: 'opp-1', type: 'vacancy', title: 'Backend Engineer', companyOrClient: 'Acme', sourceStatus: 'Active', firstSeenAt: now, lastSeenAt: now,
    technologies: ['Node.js'], skills: ['MongoDB'], location: 'Москва', remoteType: 'remote', money: { min: 200000, max: 260000, currency: 'RUB', period: 'month' },
    sourceOccurrences: [{ sourceId: 'hh', url: 'https://example.com/1', primary: true, firstSeenAt: now, lastSeenAt: now, status: 'Active', rawPayload: {}, sourceMetadata: {} }],
  },
  {
    _id: 'opp-2', type: 'freelance', title: 'Landing page', companyOrClient: 'Other client', sourceStatus: 'Active', firstSeenAt: now, lastSeenAt: now,
    technologies: ['React'], skills: [], location: 'Remote', remoteType: 'remote', money: { max: 1000, currency: 'USD', period: 'project' },
    sourceOccurrences: [{ sourceId: 'fl', url: 'https://example.com/2', primary: true, firstSeenAt: now, lastSeenAt: now, status: 'Active', rawPayload: {}, sourceMetadata: {} }],
  },
];
const states = [
  { _id: 'state-1', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-1', pipelineStatus: 'Applied', matchScore: 82, pipelineEvents: [{ status: 'Reviewed', firstReachedAt: now }, { status: 'Applied', firstReachedAt: now }] },
  { _id: 'state-2', userId: 'user-2', profileId: 'profile-2', opportunityId: 'opp-2', pipelineStatus: 'Won', matchScore: 99, pipelineEvents: [{ status: 'Won', firstReachedAt: now }] },
];
const sources = [
  { _id: 'hh', name: 'HH', group: 'job_board' },
  { _id: 'fl', name: 'Freelance', group: 'freelance' },
];

describe('analytics core', () => {
  it('applies personal filters without leaking other users and exports real CSV rows', async () => {
    const service = new AnalyticsService(new FakeModel(opportunities), new FakeModel(states), new FakeModel(sources), new FakeConnection([{ _id: 'opp-1', aiScore: 91 }]));

    const payload = await service.personal({ id: 'user-1', email: 'u1@example.test', role: 'User' }, { period: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z', profileId: 'profile-1', type: 'vacancy', sourceId: 'hh' });
    const csv = await service.personalCsv({ id: 'user-1', email: 'u1@example.test', role: 'User' }, { period: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z', type: 'vacancy' });

    assert.equal(payload.totals.tracked, 1);
    assert.equal(payload.totals.responsesSent, 1);
    assert.equal(payload.totals.avgAiScore, 91);
    assert.equal(payload.sources[0].sourceName, 'HH');
    assert.equal(payload.technologies.some((row) => row.technology === 'React'), false);
    assert.match(csv, /personal|kpi|sources|technologies/);
  });



  it('treats custom date-only to value as inclusive through the end of that day', async () => {
    const lateSameDay = { ...opportunities[0], _id: 'opp-late', firstSeenAt: new Date('2026-10-03T20:30:00.000Z'), lastSeenAt: new Date('2026-10-03T20:30:00.000Z') };
    const service = new AnalyticsService(new FakeModel([lateSameDay]), new FakeModel([]), new FakeModel(sources), new FakeConnection([]));

    const payload = await service.market({ period: 'custom', from: '2026-10-03', to: '2026-10-03', type: 'vacancy' });

    assert.equal(payload.totals.opportunities, 1);
  });

  it('builds market geography pay counterpart and source quality aggregates from shared opportunities', async () => {
    const service = new AnalyticsService(new FakeModel(opportunities), new FakeModel(states), new FakeModel(sources), new FakeConnection([]));

    const payload = await service.market({ period: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z', type: 'vacancy', sourceId: 'hh' });
    const csv = await service.marketCsv({ period: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z', type: 'vacancy' });

    assert.equal(payload.totals.opportunities, 1);
    assert.equal(payload.compensation.coverage, 100);
    assert.equal(payload.geography.locations[0].location, 'Москва');
    assert.equal(payload.counterparts[0].counterpart, 'Acme');
    assert.equal(payload.sources[0].sourceName, 'HH');
    assert.match(csv, /market|compensation|counterparts|HH/);
  });

  it('uses earliest exact lifetime pipeline events and includes closed personal wins by default', async () => {
    const rangeQuery = { period: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z' };
    const closedWin = { ...opportunities[0], _id: 'opp-closed-win', sourceStatus: 'Closed', firstSeenAt: new Date('2026-09-01T00:00:00.000Z') };
    const interviewOnly = { ...opportunities[0], _id: 'opp-interview-only', firstSeenAt: now };
    const exactApplied = { ...opportunities[0], _id: 'opp-applied', firstSeenAt: now, technologies: ['Node.js', 'Node.js'], skills: ['Node.js'] };
    const localStates = [
      { _id: 'state-win', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-closed-win', pipelineStatus: 'Won', matchScore: 90, pipelineEvents: [{ status: 'Won', firstReachedAt: now }] },
      { _id: 'state-interview', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-interview-only', pipelineStatus: 'Interview', matchScore: 70, pipelineEvents: [{ status: 'Interview', firstReachedAt: now }] },
      { _id: 'state-applied', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-applied', pipelineStatus: 'Applied', matchScore: 60, pipelineEvents: [{ status: 'Applied', firstReachedAt: now }] },
    ];
    const service = new AnalyticsService(new FakeModel([closedWin, interviewOnly, exactApplied]), new FakeModel(localStates), new FakeModel(sources), new FakeConnection([]));

    const payload = await service.personal({ id: 'user-1', email: 'u1@example.test', role: 'User' }, rangeQuery);

    assert.equal(payload.totals.tracked, 3);
    assert.equal(payload.totals.reviewed, 0);
    assert.equal(payload.totals.responsesSent, 1);
    assert.equal(payload.totals.replies, 2);
    assert.equal(payload.totals.offersWon, 1);
    assert.equal(payload.timeseries.find((row) => row.date === '2026-10-02').responses, 1);
    assert.equal(payload.timeseries.find((row) => row.date === '2026-10-02').interviews, 1);
    assert.equal(payload.technologies.find((row) => row.technology === 'Node.js').count, 2);
  });

  it('returns type-specific funnels and market previous-window comparison with source group filters', async () => {
    const tender = { ...opportunities[0], _id: 'opp-tender', type: 'tender', title: 'Government tender', firstSeenAt: now, sourceOccurrences: [{ ...opportunities[0].sourceOccurrences[0], sourceId: 'hh', sourceMetadata: { group: 'tenders' } }] };
    const previousTender = { ...tender, _id: 'opp-prev', firstSeenAt: new Date('2026-09-30T12:00:00.000Z') };
    const service = new AnalyticsService(new FakeModel([tender, previousTender]), new FakeModel([{ _id: 'state-tender', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-tender', pipelineStatus: 'Won', matchScore: 88, pipelineEvents: [{ status: 'Won', firstReachedAt: now }] }]), new FakeModel(sources), new FakeConnection([]));

    const personal = await service.personal({ id: 'user-1', email: 'u1@example.test', role: 'User' }, { period: 'custom', from: '2026-10-01', to: '2026-10-03', type: 'tender' });
    const market = await service.market({ period: 'custom', from: '2026-10-01', to: '2026-10-03', type: 'tender', sourceGroups: ['tenders'] });

    assert.deepEqual(personal.funnels[0].stages.map((row) => row.status), ['Reviewed', 'Interested', 'PreparingApplication', 'ApplicationSubmitted', 'Admitted', 'BiddingEvaluation', 'Won', 'Contracting', 'InProgress', 'Completed', 'Lost', 'Archived']);
    assert.equal(market.totals.opportunities, 1);
    assert.equal(market.comparison.previousCount, 1);
    assert.equal(market.comparison.growthRate, 0);
    assert.equal(market.volume.sourceGroups[0].sourceGroup, 'tenders');
  });


  it('keeps uncapped personal analytics and uses earliest group dates for conversion windows', async () => {
    const manyOpportunities = Array.from({ length: 5001 }, (_, index) => ({
      ...opportunities[0],
      _id: `bulk-${index}`,
      title: `Bulk ${index}`,
      firstSeenAt: now,
      sourceOccurrences: [{ ...opportunities[0].sourceOccurrences[0], sourceId: index % 2 ? 'hh' : 'fl', sourceMetadata: { group: index % 2 ? 'job_board' : 'freelance' } }],
    }));
    const manyStates = manyOpportunities.map((opportunity, index) => ({
      _id: `bulk-state-${index}`,
      userId: 'user-1',
      profileId: 'profile-1',
      opportunityId: opportunity._id,
      pipelineStatus: index === 0 ? 'Interview' : 'Applied',
      matchScore: 50,
      pipelineEvents: index === 0
        ? [{ status: 'Applied', firstReachedAt: new Date('2026-09-01T00:00:00.000Z') }, { status: 'Interview', firstReachedAt: now }]
        : [{ status: 'Applied', firstReachedAt: now }],
    }));
    const service = new AnalyticsService(new FakeModel(manyOpportunities), new FakeModel(manyStates), new FakeModel(sources), new FakeConnection([]));

    const payload = await service.personal({ id: 'user-1', email: 'u1@example.test', role: 'User' }, { period: 'custom', from: '2026-10-01', to: '2026-10-03' });

    assert.equal(payload.totals.tracked, 5001);
    assert.equal(payload.totals.responsesSent, 5000);
    assert.equal(payload.totals.interviewsNegotiations, 1);
    assert.equal(payload.funnels.find((item) => item.type === 'vacancy').stages[0].conversionRate, null);
    const appliedStage = payload.funnels.find((item) => item.type === 'vacancy').stages.find((stage) => stage.status === 'Applied');
    const interviewStage = payload.funnels.find((item) => item.type === 'vacancy').stages.find((stage) => stage.status === 'Interview');
    assert.equal(appliedStage.conversionRate, null);
    assert.equal(interviewStage.conversionRate, null);
    assert.equal(payload.timeseries.find((row) => row.date === '2026-10-01').found, 0);
  });

  it('aligns period aggregates source attribution money groups and CSV sections', async () => {
    const oldOpportunity = { ...opportunities[0], _id: 'opp-old', title: 'Old role', firstSeenAt: new Date('2026-09-01T00:00:00.000Z'), technologies: ['OldTech'], money: { max: 1, currency: 'RUB', period: 'month', kind: 'gross' } };
    const currentMultiSource = {
      ...opportunities[0],
      _id: 'opp-current-multi',
      title: 'Backend Engineer',
      companyOrClient: 'Acme',
      firstSeenAt: now,
      location: '',
      countriesAllowed: ['RU'],
      technologies: ['Node.js', 'Node.js'],
      skills: ['Node.js', 'Postgres'],
      money: { min: 10, max: 20, currency: 'USD', period: 'hour', kind: 'net' },
      sourceOccurrences: [
        { ...opportunities[0].sourceOccurrences[0], sourceId: 'hh', sourceMetadata: { group: 'job_board' } },
        { ...opportunities[0].sourceOccurrences[0], sourceId: 'fl', sourceMetadata: { group: 'freelance' } },
      ],
    };
    const localStates = [
      { _id: 'state-old', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-old', pipelineStatus: 'Won', matchScore: 75, pipelineEvents: [{ status: 'Won', firstReachedAt: now }] },
      { _id: 'state-current-a', userId: 'user-1', profileId: 'profile-1', opportunityId: 'opp-current-multi', pipelineStatus: 'Won', matchScore: 85, pipelineEvents: [{ status: 'Applied', firstReachedAt: now }, { status: 'Interview', firstReachedAt: now }, { status: 'Won', firstReachedAt: now }] },
      { _id: 'state-current-b', userId: 'user-1', profileId: 'profile-2', opportunityId: 'opp-current-multi', pipelineStatus: 'Applied', matchScore: 65, pipelineEvents: [{ status: 'Applied', firstReachedAt: now }] },
    ];
    const service = new AnalyticsService(new FakeModel([oldOpportunity, currentMultiSource]), new FakeModel(localStates), new FakeModel(sources), new FakeConnection([{ _id: { opportunityId: 'opp-current-multi', profileId: 'profile-1' }, aiScore: 80 }, { _id: { opportunityId: 'opp-current-multi', profileId: 'profile-2' }, aiScore: 60 }]));

    const payload = await service.personal({ id: 'user-1', email: 'u1@example.test', role: 'User' }, { period: 'custom', from: '2026-10-01', to: '2026-10-03', role: 'Backend Engineer' });
    const csv = await service.personalCsv({ id: 'user-1', email: 'u1@example.test', role: 'User' }, { period: 'custom', from: '2026-10-01', to: '2026-10-03' });

    assert.equal(payload.totals.avgAiScore, 70);
    assert.equal(payload.technologies.some((row) => row.technology === 'OldTech'), false);
    assert.equal(payload.technologies.find((row) => row.technology === 'Node.js').count, 1);
    assert.equal(payload.compensation.byTypeCurrencyPeriodKind[0].type, 'vacancy');
    assert.equal(payload.compensation.byTypeCurrencyPeriodKind[0].currency, 'USD');
    assert.equal(payload.compensation.byTypeCurrencyPeriodKind[0].period, 'hour');
    assert.equal(payload.compensation.byTypeCurrencyPeriodKind[0].kind, 'net');
    assert.equal(payload.sources.find((row) => row.sourceId === 'hh').found, 1);
    assert.equal(payload.sources.find((row) => row.sourceId === 'fl').responses, 2);
    assert.equal(payload.sources.find((row) => row.sourceId === 'fl').replies, 1);
    assert.equal(payload.profiles.find((row) => row.profileId === 'profile-1').wins, 1);
    assert.equal(payload.geography.locations[0].location, 'unknown');
    assert.equal(payload.geography.countries[0].country, 'RU');
    assert.match(csv, /type_funnel|timeseries|profiles|score_match|compensation_by_type_currency_period_kind/);
  });

  it('exports market comparison source group seniority timeseries remote and money sections', async () => {
    const service = new AnalyticsService(new FakeModel(opportunities), new FakeModel(states), new FakeModel(sources), new FakeConnection([]));

    const csv = await service.marketCsv({ period: 'custom', from: '2026-10-01', to: '2026-10-03', type: 'vacancy' });

    assert.match(csv, /comparison|source_groups|seniority|timeseries|geography_remote_types|compensation_by_type_currency_period_kind/);
  });


  it('groups and filters unknown money dimensions semantically', async () => {
    const unknownMoney = { ...opportunities[0], _id: 'opp-unknown-money', firstSeenAt: now, money: { max: 100, currency: '', period: '', kind: '' } };
    const uppercaseUnknownMoney = { ...opportunities[0], _id: 'opp-uppercase-unknown-money', firstSeenAt: now, money: { max: 150, currency: '', period: 'UNKNOWN', kind: 'UNKNOWN' } };
    const knownMoney = { ...opportunities[0], _id: 'opp-known-money', firstSeenAt: now, money: { max: 200, currency: 'USD', period: 'hour', kind: 'net' } };
    const service = new AnalyticsService(new FakeModel([unknownMoney, uppercaseUnknownMoney, knownMoney]), new FakeModel([]), new FakeModel(sources), new FakeConnection([]));

    const payload = await service.market({ period: 'custom', from: '2026-10-01', to: '2026-10-03', currency: 'unknown', moneyPeriod: 'UNKNOWN', moneyKind: 'UNKNOWN' });

    assert.equal(payload.totals.opportunities, 2);
    assert.equal(payload.compensation.byTypeCurrencyPeriodKind[0].currency, 'unknown');
    assert.equal(payload.compensation.byTypeCurrencyPeriodKind[0].period, 'unknown');
    assert.equal(payload.compensation.byTypeCurrencyPeriodKind[0].kind, 'unknown');
  });


  it('matches recognized money period and kind aliases semantically while custom values stay exact', async () => {
    const yearUpper = { ...opportunities[0], _id: 'opp-year-upper', firstSeenAt: now, money: { max: 100, currency: 'USD', period: 'YEAR', kind: 'GROSS' } };
    const yearLower = { ...opportunities[0], _id: 'opp-year-lower', firstSeenAt: now, money: { max: 200, currency: 'USD', period: 'year', kind: 'gross' } };
    const monthUpper = { ...opportunities[0], _id: 'opp-month-upper', firstSeenAt: now, money: { max: 300, currency: 'USD', period: 'MONTH', kind: 'NET' } };
    const custom = { ...opportunities[0], _id: 'opp-custom-period', firstSeenAt: now, money: { max: 400, currency: 'USD', period: 'FORTNIGHT', kind: 'desired-upper-bound' } };
    const service = new AnalyticsService(new FakeModel([yearUpper, yearLower, monthUpper, custom]), new FakeModel([]), new FakeModel(sources), new FakeConnection([]));

    const yearGross = await service.market({ period: 'custom', from: '2026-10-01', to: '2026-10-03', moneyPeriod: 'year', moneyKind: 'gross' });
    const monthNet = await service.market({ period: 'custom', from: '2026-10-01', to: '2026-10-03', moneyPeriod: 'month', moneyKind: 'net' });
    const customExact = await service.market({ period: 'custom', from: '2026-10-01', to: '2026-10-03', moneyPeriod: 'FORTNIGHT', moneyKind: 'desired-upper-bound' });

    assert.equal(yearGross.totals.opportunities, 2);
    assert.equal(monthNet.totals.opportunities, 1);
    assert.equal(customExact.totals.opportunities, 1);
    assert.equal(customExact.compensation.byTypeCurrencyPeriodKind[0].period, 'FORTNIGHT');
    assert.equal(customExact.compensation.byTypeCurrencyPeriodKind[0].kind, 'desired-upper-bound');
  });


  it('canonicalizes recognized money dimensions in compensation rows without merging custom values', async () => {
    const rows = [
      { ...opportunities[0], _id: 'opp-year-upper-row', firstSeenAt: now, money: { max: 100, currency: 'USD', period: 'YEAR', kind: 'GROSS' } },
      { ...opportunities[0], _id: 'opp-year-lower-row', firstSeenAt: now, money: { max: 300, currency: 'USD', period: 'year', kind: 'gross' } },
      { ...opportunities[0], _id: 'opp-hourly-row', firstSeenAt: now, money: { max: 50, currency: 'USD', period: 'HOURLY', kind: 'RATE' } },
      { ...opportunities[0], _id: 'opp-hour-row', firstSeenAt: now, money: { max: 70, currency: 'USD', period: 'hour', kind: 'rate' } },
      { ...opportunities[0], _id: 'opp-custom-upper-row', firstSeenAt: now, money: { max: 400, currency: 'USD', period: 'FORTNIGHT', kind: 'gross' } },
      { ...opportunities[0], _id: 'opp-custom-lower-row', firstSeenAt: now, money: { max: 500, currency: 'USD', period: 'fortnight', kind: 'gross' } },
    ];
    const service = new AnalyticsService(new FakeModel(rows), new FakeModel([]), new FakeModel(sources), new FakeConnection([]));

    const payload = await service.market({ period: 'custom', from: '2026-10-01', to: '2026-10-03' });
    const compensation = payload.compensation.byTypeCurrencyPeriodKind;
    const year = compensation.find((row) => row.period === 'year' && row.kind === 'gross');
    const hour = compensation.find((row) => row.period === 'hour' && row.kind === 'rate');
    const customUpper = compensation.find((row) => row.period === 'FORTNIGHT');
    const customLower = compensation.find((row) => row.period === 'fortnight');

    assert.equal(year.count, 2);
    assert.equal(year.min, 100);
    assert.equal(year.max, 300);
    assert.equal(year.median, 200);
    assert.equal(hour.count, 2);
    assert.equal(hour.min, 50);
    assert.equal(hour.max, 70);
    assert.equal(hour.median, 60);
    assert.equal(customUpper.count, 1);
    assert.equal(customUpper.max, 400);
    assert.equal(customLower.count, 1);
    assert.equal(customLower.max, 500);
    assert.equal(compensation.some((row) => row.period === 'YEAR' || row.period === 'HOURLY'), false);
    assert.ok(payload.compensation.byCurrency.some((row) => row.currencyPeriod === 'USD / year' && row.count === 2));
    assert.ok(payload.compensation.byCurrency.some((row) => row.currencyPeriod === 'USD / hour' && row.count === 2));
    assert.ok(payload.compensation.byCurrency.some((row) => row.currencyPeriod === 'USD / FORTNIGHT' && row.count === 1));
    assert.ok(payload.compensation.byCurrency.some((row) => row.currencyPeriod === 'USD / fortnight' && row.count === 1));
  });


  it('counts source groups and countries once per canonical opportunity and filters unknown source groups', async () => {
    const duplicateGroup = {
      ...opportunities[0],
      _id: 'opp-duplicate-group',
      firstSeenAt: now,
      countriesAllowed: ['RU', 'RU'],
      sourceOccurrences: [
        { ...opportunities[0].sourceOccurrences[0], sourceId: 'hh-1', sourceMetadata: { group: 'job_board' } },
        { ...opportunities[0].sourceOccurrences[0], sourceId: 'hh-2', sourceMetadata: { group: 'job_board' } },
      ],
    };
    const unknownGroup = { ...opportunities[0], _id: 'opp-unknown-group', firstSeenAt: now, sourceOccurrences: [{ ...opportunities[0].sourceOccurrences[0], sourceId: 'x', sourceMetadata: {} }] };
    const service = new AnalyticsService(new FakeModel([duplicateGroup, unknownGroup]), new FakeModel([]), new FakeModel(sources), new FakeConnection([]));

    const all = await service.market({ period: 'custom', from: '2026-10-01', to: '2026-10-03' });
    const unknown = await service.market({ period: 'custom', from: '2026-10-01', to: '2026-10-03', sourceGroups: ['unknown'] });

    assert.equal(all.volume.sourceGroups.find((row) => row.sourceGroup === 'job_board').count, 1);
    assert.equal(all.geography.countries.find((row) => row.country === 'RU').count, 1);
    assert.equal(unknown.totals.opportunities, 1);
    assert.equal(unknown.volume.sourceGroups[0].sourceGroup, 'unknown');
  });

});

class FakeConnection {
  constructor(aiRows) { this.aiRows = aiRows; }
  collection() {
    return { aggregate: () => ({ toArray: async () => this.aiRows }) };
  }
}

class FakeModel {
  constructor(records) { this.records = records; }
  find(filter = {}) { return new FakeQuery(this.records.filter((record) => matches(record, filter))); }
}

class FakeQuery {
  constructor(records) { this.records = records; }
  select() { return this; }
  sort() { return this; }
  limit(value) { this.records = this.records.slice(0, value); return this; }
  lean() { return Promise.resolve(this.records); }
}

function matches(record, filter) {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and') {
      if (!value.every((part) => matches(record, part))) return false;
      continue;
    }
    if (key === '$or') {
      if (!value.some((part) => matches(record, part))) return false;
      continue;
    }
    if (value && typeof value === 'object' && '$exists' in value && !('$in' in value)) {
      if ((getValues(record, key).length > 0) !== value.$exists) return false;
      continue;
    }
    if (key === 'firstSeenAt') {
      const time = +new Date(record.firstSeenAt);
      if (value.$gte && time < +new Date(value.$gte)) return false;
      if (value.$lte && time > +new Date(value.$lte)) return false;
      continue;
    }
    const values = getValues(record, key);
    if (value?.$size !== undefined) {
      const raw = getRawValue(record, key);
      if (!Array.isArray(raw) || raw.length !== value.$size) return false;
      continue;
    }
    if (value?.$elemMatch) {
      if (!values.some((entry) => matches(entry, value.$elemMatch))) return false;
      continue;
    }
    if (value?.$in) {
      if (!values.some((item) => value.$in.includes(item))) return false;
      continue;
    }
    if (value?.$regex) {
      const pattern = new RegExp(value.$regex, value.$options ?? '');
      if (!values.some((item) => pattern.test(String(item)))) return false;
      continue;
    }
    if (!values.some((item) => item === value)) return false;
  }
  return true;
}


function getRawValue(record, path) {
  return path.split('.').reduce((value, part) => value?.[part], record);
}

function getValues(record, path) {
  const walk = (value, parts) => {
    if (value === undefined || value === null) return [];
    if (!parts.length) return Array.isArray(value) ? value : [value];
    const [head, ...rest] = parts;
    if (Array.isArray(value)) return value.flatMap((item) => walk(item, parts));
    return walk(value[head], rest);
  };
  return walk(record, path.split('.'));
}
