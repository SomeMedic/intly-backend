#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const projectRoot = resolve(rootDir, '..');
const reportPath = resolve(projectRoot, '.local/reports/analytics-blocks.json');
const runId = `analytics-blocks-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const roleTitle = `QA Analytics Role ${runId}`;
const password = `AnalyticsQA-${randomUUID()}-intly-2026!`;
const from = '2026-08-01';
const to = '2026-10-03';
const qaGroup = `qa_group_${runId}`;
const otherGroup = `qa_other_${runId}`;
const allSourceStatuses = 'Active,Closed,Expired,Removed,Unknown';
const profileA = randomUUID();
const profileB = randomUUID();
const report = {
  ok: false,
  runId,
  startedAt: new Date().toISOString(),
  apiBaseUrl: null,
  adminCredentialSource: null,
  checks: [],
  warnings: [],
  fixtures: { roleTitle, from, to, profileIds: [profileA, profileB] },
};

const ids = {
  duplicateGroup: randomUUID(),
  unknownOccurrence: randomUUID(),
  noOccurrence: randomUUID(),
  closedWon: randomUUID(),
  weekly: randomUUID(),
};

async function main() {
  const env = await loadEnvFile(resolve(rootDir, '.env'));
  assert(env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'production', 'Refusing to run analytics acceptance against production');
  const apiBaseUrl = apiBase(env);
  assertLoopbackUrl(apiBaseUrl, 'API base URL');
  report.apiBaseUrl = apiBaseUrl.replace(/\/api\/v1$/, '/api/v1');
  const mongoUri = process.env.MONGODB_URI ?? env.MONGODB_URI;
  assert(mongoUri, 'MONGODB_URI is required for analytics verification');
  assertLoopbackMongoUri(mongoUri);
  const adminCredentials = await loadAdminCredentials(env);
  report.adminCredentialSource = adminCredentials.source;

  let owner;
  try {
    const admin = new ApiClient(apiBaseUrl);
    await step('bootstrap-admin.login', async () => {
      const login = await admin.post('/auth/login', { email: adminCredentials.email, password: adminCredentials.password });
      admin.setAccessToken(requiredString(login, 'accessToken'));
      assert(login.user?.role === 'Admin', 'bootstrap credentials must belong to an Admin user');
      return { userId: login.user.id, role: login.user.role, email: login.user.email };
    });

    owner = await createActivatedUser(admin, apiBaseUrl);
    await step('mongo.seed-analytics-fixtures', () => seedAnalyticsFixtures(mongoUri, owner.userId));

    const personal = await step('analytics.personal.event-semantics-closed-weekly-csv', async () => {
      const payload = await owner.client.get(`/analytics/personal?${query({ period: 'custom', from, to, role: roleTitle })}`);
      assert(payload.totals.tracked === 6, `personal tracked should include all states, got ${payload.totals.tracked}`);
      assert(payload.totals.responsesSent === 2, `earliest Applied before range must not count; expected 2 responses, got ${payload.totals.responsesSent}`);
      assert(payload.totals.interviewsNegotiations === 1, `Interview group should count only in-range Interview fixture, got ${payload.totals.interviewsNegotiations}`);
      assert(payload.totals.offersWon === 1, `closed Won should be included by default, got ${payload.totals.offersWon}`);
      const withoutClosed = await owner.client.get(`/analytics/personal?${query({ period: 'custom', from, to, role: roleTitle, includeClosed: 'false' })}`);
      assert(withoutClosed.totals.offersWon === 0, 'includeClosed=false should exclude the closed Won fixture');
      assert(Array.isArray(payload.timeseries) && payload.timeseries.length >= 9, 'personal long range should produce weekly buckets');
      assert(payload.timeseries[0].from === `${from}T00:00:00.000Z` || payload.timeseries[0].from === from, 'first weekly bucket should start at the requested from boundary');
      assert(payload.timeseries.at(-1).to.startsWith(to), 'last weekly bucket should be clipped to requested to boundary');
      const csv = await owner.client.getText(`/analytics/personal/export.csv?${query({ period: 'custom', from, to, role: roleTitle })}`);
      assertCsvSections(csv, ['timeseries', 'profiles', 'score_match', 'score_ai', 'type_funnel', 'compensation_by_type_currency_period_kind'], 'personal CSV');
      return {
        tracked: payload.totals.tracked,
        responsesSent: payload.totals.responsesSent,
        interviewsNegotiations: payload.totals.interviewsNegotiations,
        offersWon: payload.totals.offersWon,
        includeClosedFalseOffersWon: withoutClosed.totals.offersWon,
        timeseriesBuckets: payload.timeseries.length,
        firstBucket: payload.timeseries[0],
        lastBucket: payload.timeseries.at(-1),
      };
    });

    await step('analytics.market-unique-unknown-money-csv', async () => {
      const market = await owner.client.get(`/analytics/market?${query({ period: 'custom', from, to, role: roleTitle, includeClosed: 'true', comparePrevious: 'true' })}`);
      assert(market.totals.opportunities === 5, `market should see five isolated opportunities, got ${market.totals.opportunities}`);
      const groupRow = findRow(market.volume.sourceGroups, 'sourceGroup', qaGroup);
      assert(groupRow?.count === 2, `duplicate same-group occurrences should count once per opportunity; expected 2 with closed fixture, got ${groupRow?.count}`);
      const countryRu = findRow(market.geography.countries, 'country', 'RU');
      assert(countryRu?.count === 1, `duplicate countries should count once per opportunity, got ${countryRu?.count}`);
      const moneyRow = market.compensation.byTypeCurrencyPeriodKind.find((row) => row.type === 'vacancy' && row.currency === 'RUB' && row.period === 'month' && row.kind === 'gross');
      assert(moneyRow?.count === 2, `grouped money row should separate type/currency/period/kind and include closed fixture; got ${moneyRow?.count}`);
      const unknownGroup = await owner.client.get(`/analytics/market?${query({ period: 'custom', from, to, role: roleTitle, sourceGroups: 'unknown' })}`);
      assert(unknownGroup.totals.opportunities === 2, `sourceGroups=unknown should match missing group occurrence and absent occurrences, got ${unknownGroup.totals.opportunities}`);
      const unknownCountry = await owner.client.get(`/analytics/market?${query({ period: 'custom', from, to, role: roleTitle, countriesAllowed: 'unknown' })}`);
      assert(unknownCountry.totals.opportunities === 2, `countriesAllowed=unknown should match empty/missing countries, got ${unknownCountry.totals.opportunities}`);
      const unknownMoney = await owner.client.get(`/analytics/market?${query({ period: 'custom', from, to, role: roleTitle, currency: 'unknown', moneyPeriod: 'unknown', moneyKind: 'unknown' })}`);
      assert(unknownMoney.totals.opportunities === 2, `unknown money dimensions should match missing currency/period/kind, got ${unknownMoney.totals.opportunities}`);
      const csv = await owner.client.getText(`/analytics/market/export.csv?${query({ period: 'custom', from, to, role: roleTitle, includeClosed: 'true', comparePrevious: 'true' })}`);
      assertCsvSections(csv, ['comparison', 'source_groups', 'seniority', 'timeseries', 'geography_remote_types', 'compensation_by_type_currency_period_kind'], 'market CSV');
      return {
        opportunities: market.totals.opportunities,
        sourceGroupCount: groupRow.count,
        countryRuCount: countryRu.count,
        groupedMoneyCount: moneyRow.count,
        unknownGroupCount: unknownGroup.totals.opportunities,
        unknownCountryCount: unknownCountry.totals.opportunities,
        unknownMoneyCount: unknownMoney.totals.opportunities,
        comparisonPreviousCount: market.comparison.previousCount,
      };
    });

    await step('opportunities.drilldown-list-export-concordance', async () => {
      const appliedQuery = {
        role: roleTitle,
        profileScope: 'all',
        trackedOnly: 'true',
        status: allSourceStatuses,
        pipelineReachedStatuses: 'Applied',
        pipelineReachedFrom: from,
        pipelineReachedTo: to,
        limit: '20',
      };
      const appliedList = await owner.client.get(`/opportunities?${query(appliedQuery)}`);
      assert(idsOf(appliedList.items).length === 2, `Applied drilldown should include only in-range earliest Applied states, got ${idsOf(appliedList.items).length}`);
      assert(!idsOf(appliedList.items).includes(ids.duplicateGroup), 'Applied drilldown must exclude state whose earliest Applied is before the range');
      const appliedExport = await exportJson(owner.client, appliedQuery, { includePersonalData: false, fields: ['id', 'title'] });
      assert(sameSet(idsOf(appliedList.items), appliedExport.items.map((row) => row.id)), 'Applied export ids should match Applied list ids');

      const interviewQuery = { ...appliedQuery, pipelineReachedStatuses: 'Interview' };
      const interviewList = await owner.client.get(`/opportunities?${query(interviewQuery)}`);
      assert(sameSet(idsOf(interviewList.items), [ids.duplicateGroup]), `Interview drilldown should contain only duplicateGroup fixture, got ${idsOf(interviewList.items).join(',')}`);

      const reviewedActiveQuery = { ...appliedQuery, pipelineReachedStatuses: 'Reviewed' };
      const reviewedActiveList = await owner.client.get(`/opportunities?${query(reviewedActiveQuery)}`);
      assert(idsOf(reviewedActiveList.items).includes(ids.duplicateGroup), 'Reviewed drilldown with explicit all source statuses should include active duplicateGroup fixture');

      const wonClosedQuery = { ...appliedQuery, pipelineReachedStatuses: 'Won' };
      const wonClosedList = await owner.client.get(`/opportunities?${query(wonClosedQuery)}`);
      assert(sameSet(idsOf(wonClosedList.items), [ids.closedWon]), `Won drilldown with explicit all source statuses should include closed Won fixture only, got ${idsOf(wonClosedList.items).join(',')}`);
      const wonClosedExport = await exportJson(owner.client, wonClosedQuery, { fields: ['id', 'title'] });
      assert(sameSet(idsOf(wonClosedList.items), wonClosedExport.items.map((row) => row.id)), 'Won closed export ids should match list ids');

      const allTrackedQuery = { role: roleTitle, profileScope: 'all', trackedOnly: 'true', limit: '20' };
      const allTracked = await owner.client.get(`/opportunities?${query(allTrackedQuery)}`);
      const allTrackedIds = idsOf(allTracked.items);
      assert(allTrackedIds.length === new Set(allTrackedIds).size, 'All profiles tracked list should return distinct opportunities, not profile-state duplicates');
      assert(allTrackedIds.filter((id) => id === ids.duplicateGroup).length === 1, 'Opportunity tracked by two profiles should appear once');
      assert(allTrackedIds.length === 4, `default active all-profile tracked list should include four active tracked opportunities, got ${allTrackedIds.length}`);

      const unknownGroupQuery = { role: roleTitle, sourceGroups: 'unknown', limit: '20' };
      const unknownGroupList = await owner.client.get(`/opportunities?${query(unknownGroupQuery)}`);
      assert(sameSet(idsOf(unknownGroupList.items), [ids.unknownOccurrence, ids.noOccurrence]), `sourceGroups=unknown list mismatch: ${idsOf(unknownGroupList.items).join(',')}`);
      const unknownGroupExport = await exportJson(owner.client, unknownGroupQuery, { fields: ['id', 'title'] });
      assert(sameSet(idsOf(unknownGroupList.items), unknownGroupExport.items.map((row) => row.id)), 'sourceGroups=unknown export ids should match list ids');

      const unknownCountryList = await owner.client.get(`/opportunities?${query({ role: roleTitle, countriesAllowed: 'unknown', limit: '20' })}`);
      assert(sameSet(idsOf(unknownCountryList.items), [ids.unknownOccurrence, ids.noOccurrence]), `countriesAllowed=unknown list mismatch: ${idsOf(unknownCountryList.items).join(',')}`);

      const unknownMoneyList = await owner.client.get(`/opportunities?${query({ role: roleTitle, currency: 'unknown', moneyPeriod: 'unknown', moneyKind: 'unknown', limit: '20' })}`);
      assert(sameSet(idsOf(unknownMoneyList.items), [ids.unknownOccurrence, ids.noOccurrence]), `unknown money list mismatch: ${idsOf(unknownMoneyList.items).join(',')}`);

      const groupedMoneyList = await owner.client.get(`/opportunities?${query({ role: roleTitle, type: 'vacancy', status: allSourceStatuses, currency: 'RUB', moneyPeriod: 'month', moneyKind: 'gross', limit: '20' })}`);
      assert(sameSet(idsOf(groupedMoneyList.items), [ids.duplicateGroup, ids.closedWon]), `grouped money list mismatch: ${idsOf(groupedMoneyList.items).join(',')}`);

      return {
        appliedIds: idsOf(appliedList.items),
        interviewIds: idsOf(interviewList.items),
        reviewedActiveIds: idsOf(reviewedActiveList.items),
        wonClosedIds: idsOf(wonClosedList.items),
        allProfilesTrackedIds: allTrackedIds,
        unknownGroupIds: idsOf(unknownGroupList.items),
        unknownCountryIds: idsOf(unknownCountryList.items),
        unknownMoneyIds: idsOf(unknownMoneyList.items),
        groupedMoneyIds: idsOf(groupedMoneyList.items),
        appliedExportCount: appliedExport.items.length,
        wonClosedExportCount: wonClosedExport.items.length,
        unknownGroupExportCount: unknownGroupExport.items.length,
      };
    });

    report.ok = true;
    report.summary = { personalTracked: personal.tracked, checks: report.checks.length };
  } finally {
    await step('mongo.cleanup-run-fixtures', () => cleanupFixtures(mongoUri, owner?.email));
  }
}

async function seedAnalyticsFixtures(mongoUri, userId) {
  const mongoose = await import('mongoose');
  const connection = await mongoose.createConnection(mongoUri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const now = new Date();
    const opportunities = [
      opportunityDoc(ids.duplicateGroup, {
        type: 'vacancy', sourceStatus: 'Active', firstSeenAt: '2026-09-10T10:00:00.000Z', lastSeenAt: '2026-09-29T10:00:00.000Z', countriesAllowed: ['RU', 'RU'], remoteType: 'remote', seniority: 'Senior',
        money: { min: 180000, max: 220000, currency: 'RUB', period: 'month', kind: 'gross', originalText: 'RUB month gross' },
        sourceOccurrences: [sourceOccurrence('qa-analytics-a', qaGroup, 'a1'), sourceOccurrence('qa-analytics-b', qaGroup, 'a2')],
      }),
      opportunityDoc(ids.unknownOccurrence, {
        type: 'vacancy', sourceStatus: 'Active', firstSeenAt: '2026-09-11T10:00:00.000Z', lastSeenAt: '2026-09-29T10:00:00.000Z', countriesAllowed: [], remoteType: 'remote', seniority: 'Middle',
        money: { min: 100000, max: 120000, originalText: 'unknown dimensions' },
        sourceOccurrences: [sourceOccurrence('qa-analytics-unknown', undefined, 'u1')],
      }),
      opportunityDoc(ids.noOccurrence, {
        type: 'freelance', sourceStatus: 'Active', firstSeenAt: '2026-09-12T10:00:00.000Z', lastSeenAt: '2026-09-29T10:00:00.000Z', countriesAllowed: [], remoteType: 'hybrid', seniority: 'Middle',
        money: { min: 80000, max: 90000, originalText: 'unknown dimensions' },
        sourceOccurrences: [],
      }),
      opportunityDoc(ids.closedWon, {
        type: 'vacancy', sourceStatus: 'Closed', firstSeenAt: '2026-09-13T10:00:00.000Z', lastSeenAt: '2026-09-29T10:00:00.000Z', countriesAllowed: ['KZ'], remoteType: 'remote', seniority: 'Senior',
        money: { min: 250000, max: 300000, currency: 'RUB', period: 'month', kind: 'gross', originalText: 'closed won' },
        sourceOccurrences: [sourceOccurrence('qa-analytics-closed', qaGroup, 'c1', 'Closed')],
      }),
      opportunityDoc(ids.weekly, {
        type: 'tender', sourceStatus: 'Active', firstSeenAt: '2026-08-03T10:00:00.000Z', lastSeenAt: '2026-09-29T10:00:00.000Z', countriesAllowed: ['AM'], remoteType: 'onsite', seniority: 'Lead',
        money: { min: 1000, max: 2000, currency: 'USD', period: 'project', kind: 'net', originalText: 'USD project net' },
        sourceOccurrences: [sourceOccurrence('qa-analytics-other', otherGroup, 'w1')],
      }),
    ];
    const states = [
      stateDoc({ userId, opportunityId: ids.duplicateGroup, profileId: profileA, pipelineStatus: 'Interview', matchScore: 91, events: [['Reviewed', '2026-09-10T12:00:00.000Z'], ['Applied', '2026-07-15T12:00:00.000Z'], ['Applied', '2026-09-18T12:00:00.000Z'], ['Interview', '2026-09-20T12:00:00.000Z']] }),
      stateDoc({ userId, opportunityId: ids.duplicateGroup, profileId: profileB, pipelineStatus: 'Reviewed', matchScore: 55, events: [['Reviewed', '2026-09-10T13:00:00.000Z']] }),
      stateDoc({ userId, opportunityId: ids.unknownOccurrence, profileId: profileA, pipelineStatus: 'Applied', matchScore: 72, events: [['Reviewed', '2026-09-11T12:00:00.000Z'], ['Applied', '2026-09-14T12:00:00.000Z']] }),
      stateDoc({ userId, opportunityId: ids.noOccurrence, profileId: profileA, pipelineStatus: 'Reviewed', matchScore: 61, events: [['Reviewed', '2026-09-12T12:00:00.000Z']] }),
      stateDoc({ userId, opportunityId: ids.closedWon, profileId: profileA, pipelineStatus: 'Won', matchScore: 88, events: [['Reviewed', '2026-09-13T12:00:00.000Z'], ['Applied', '2026-09-14T12:00:00.000Z'], ['Offer', '2026-09-15T12:00:00.000Z'], ['Won', '2026-09-16T12:00:00.000Z']] }),
      stateDoc({ userId, opportunityId: ids.weekly, profileId: profileA, pipelineStatus: 'Reviewed', matchScore: 44, events: [['Reviewed', '2026-08-03T12:00:00.000Z']] }),
    ];
    const aiRows = [
      aiDoc({ userId, opportunityId: ids.duplicateGroup, profileId: profileA, score: 83, completedAt: '2026-09-21T12:00:00.000Z' }),
      aiDoc({ userId, opportunityId: ids.unknownOccurrence, profileId: profileA, score: 38, completedAt: '2026-09-15T12:00:00.000Z' }),
    ];
    await connection.db.collection('opportunities').insertMany(opportunities, { ordered: false });
    await connection.db.collection('opportunityuserstates').insertMany(states, { ordered: false });
    await connection.db.collection('ai_analyses').insertMany(aiRows, { ordered: false });
    return { opportunities: opportunities.length, states: states.length, aiAnalyses: aiRows.length, ids };
  } finally {
    await connection.close();
  }
}

function opportunityDoc(id, overrides) {
  const createdAt = new Date();
  return {
    _id: id,
    type: overrides.type,
    title: roleTitle,
    companyOrClient: `QA Counterpart ${runId}`,
    description: `Analytics QA fixture ${runId}`,
    summary: '',
    language: 'en',
    skills: ['AnalyticsQA'],
    technologies: ['TypeScript', 'MongoDB'],
    seniority: overrides.seniority,
    employmentType: 'contract',
    location: '',
    remoteType: overrides.remoteType,
    relocation: false,
    countriesAllowed: overrides.countriesAllowed,
    money: overrides.money,
    deadline: null,
    publishedAt: new Date(overrides.firstSeenAt),
    firstSeenAt: new Date(overrides.firstSeenAt),
    lastSeenAt: new Date(overrides.lastSeenAt),
    sourceStatus: overrides.sourceStatus,
    sourceOccurrences: overrides.sourceOccurrences,
    vacancyData: {},
    freelanceData: {},
    tenderData: {},
    canonicalTags: [runId],
    adminCorrections: [],
    importedByUserId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function sourceOccurrence(sourceId, group, externalId, status = 'Active') {
  const firstSeenAt = new Date('2026-09-10T10:00:00.000Z');
  const occurrence = {
    sourceId,
    externalId: `${runId}-${externalId}`,
    url: `https://example.test/${runId}/${externalId}`,
    checksum: '',
    primary: externalId.endsWith('1'),
    status,
    firstSeenAt,
    lastSeenAt: new Date('2026-09-29T10:00:00.000Z'),
    rawPayload: { runId, fixture: true },
    sourceMetadata: { runId },
    normalizedSnapshot: {},
  };
  if (group) occurrence.sourceMetadata.group = group;
  return occurrence;
}

function stateDoc({ userId, opportunityId, profileId, pipelineStatus, matchScore, events }) {
  const now = new Date();
  return {
    _id: randomUUID(),
    userId,
    opportunityId,
    profileId,
    pipelineStatus,
    favorite: false,
    hidden: false,
    archived: false,
    tags: [runId],
    matchScore,
    matchComponents: {},
    matchCalculatedAt: now,
    responseState: { runId },
    notes: [],
    checklist: [],
    pinned: false,
    pipelineEvents: events.map(([status, firstReachedAt]) => ({ status, firstReachedAt: new Date(firstReachedAt) })),
    createdAt: now,
    updatedAt: now,
  };
}

function aiDoc({ userId, opportunityId, profileId, score, completedAt }) {
  const completed = new Date(completedAt);
  return {
    _id: randomUUID(),
    userId,
    profileId,
    opportunityId,
    taskType: 'opportunity_analysis',
    status: 'completed',
    provider: 'local',
    modelId: 'qa-analytics-fixture',
    fallbackUsed: false,
    structuredOutput: { summary: `QA analytics fixture ${runId}`, aiScore: score },
    aiScore: score,
    usage: {},
    prompt: { kind: 'qa-analytics-fixture', runId },
    metadata: { fixture: true, runId },
    startedAt: new Date(completed.getTime() - 1000),
    completedAt: completed,
    createdAt: completed,
    updatedAt: completed,
  };
}

async function cleanupFixtures(mongoUri, email) {
  const mongoose = await import('mongoose');
  const connection = await mongoose.createConnection(mongoUri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const [opportunities, states, aiAnalyses, users] = await Promise.all([
      connection.db.collection('opportunities').deleteMany({ canonicalTags: runId }),
      connection.db.collection('opportunityuserstates').deleteMany({ tags: runId }),
      connection.db.collection('ai_analyses').deleteMany({ 'metadata.runId': runId }),
      email ? connection.db.collection('users').deleteMany({ email }) : Promise.resolve({ deletedCount: 0 }),
    ]);
    return { opportunities: opportunities.deletedCount, states: states.deletedCount, aiAnalyses: aiAnalyses.deletedCount, users: users.deletedCount };
  } finally {
    await connection.close();
  }
}

async function exportJson(client, queryObject, options = {}) {
  const exported = await client.post('/opportunities/export', {
    format: 'json',
    scope: 'filtered',
    query: { ...queryObject, limit: undefined },
    fields: options.fields ?? ['id', 'title'],
    includePersonalData: Boolean(options.includePersonalData),
    limit: 20,
  });
  const payload = JSON.parse(Buffer.from(requiredString(exported, 'contentBase64'), 'base64').toString('utf8'));
  assert(Array.isArray(payload.items), 'export JSON should contain items');
  assert(exported.count === payload.items.length, 'export count should match payload items length');
  return payload;
}

async function createActivatedUser(admin, apiBaseUrl) {
  const email = `qa-analytics-${Date.now()}-${randomUUID().slice(0, 8)}@intly.local`;
  const client = new ApiClient(apiBaseUrl);
  const result = await step('qa-user.invite-and-activate', async () => {
    const invited = await admin.post('/admin/users', { email, name: 'QA Analytics User', role: 'User', locale: 'en' });
    const activationToken = requiredString(invited, 'activationToken');
    const activated = await client.post('/auth/activate', { token: activationToken, password, name: 'QA Analytics User' });
    client.setAccessToken(requiredString(activated, 'accessToken'));
    return { userId: activated.user?.id, role: activated.user?.role, email };
  });
  return { client, userId: result.userId, email };
}

async function step(name, fn) {
  const item = { name, ok: false, startedAt: new Date().toISOString() };
  report.checks.push(item);
  try {
    item.result = await fn();
    item.ok = true;
  } catch (error) {
    item.error = sanitizeError(error);
    throw error;
  } finally {
    item.finishedAt = new Date().toISOString();
  }
  return item.result;
}

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.accessToken = null;
    this.cookies = new Map();
  }
  setAccessToken(token) { this.accessToken = token; }
  async get(path, options = {}) { return this.request('GET', path, undefined, options); }
  async post(path, body, options = {}) { return this.request('POST', path, body, options); }
  async getText(path, options = {}) { return this.request('GET', path, undefined, { ...options, text: true }); }
  async request(method, path, body, options = {}) {
    const headers = new Headers(options.headers ?? {});
    if (this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.INTLY_VERIFY_TIMEOUT_MS ?? 45_000)),
    });
    this.captureCookies(response);
    return this.parseResponse(response, options);
  }
  async parseResponse(response, options = {}) {
    const expectedStatuses = options.expectedStatuses ?? (options.expectedStatus ? [options.expectedStatus] : null);
    const text = await response.text();
    if (options.text) {
      this.assertExpected(response, expectedStatuses, text.slice(0, 500));
      return text;
    }
    const json = text ? tryParseJson(text) : null;
    this.assertExpected(response, expectedStatuses, json ?? text.slice(0, 500));
    return { ...(json ?? {}), __status: response.status };
  }
  assertExpected(response, expectedStatuses, body) {
    if (expectedStatuses) {
      if (!expectedStatuses.includes(response.status)) throw new HttpError(response.status, body);
      return;
    }
    if (response.status < 200 || response.status >= 300) throw new HttpError(response.status, body);
  }
  captureCookies(response) {
    const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : splitSetCookie(response.headers.get('set-cookie'));
    for (const cookie of setCookie) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function query(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params.toString();
}

function idsOf(items) {
  assert(Array.isArray(items), 'items should be an array');
  return items.map((item) => item.id);
}

function sameSet(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}


function assertCsvSections(csv, expectedSections, label) {
  const sections = new Set(csv.split(/\r?\n/).slice(1).map((line) => parseCsvFirstCell(line)).filter(Boolean));
  for (const section of expectedSections) assert(sections.has(section), `${label} missing aggregate section ${section}`);
}

function parseCsvFirstCell(line) {
  if (!line) return '';
  if (!line.startsWith('"')) return line.split(',')[0].replace(/^\uFEFF/, '');
  let value = '';
  for (let index = 1; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      value += '"';
      index += 1;
      continue;
    }
    if (char === '"') return value.replace(/^\uFEFF/, '');
    value += char;
  }
  return value.replace(/^\uFEFF/, '');
}

function findRow(rows, key, value) {
  return Array.isArray(rows) ? rows.find((row) => row[key] === value) : undefined;
}

async function loadAdminCredentials(env) {
  const email = process.env.INTLY_VERIFY_ADMIN_EMAIL ?? process.env.BOOTSTRAP_ADMIN_EMAIL ?? env.BOOTSTRAP_ADMIN_EMAIL;
  const passwordValue = process.env.INTLY_VERIFY_ADMIN_PASSWORD ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? env.BOOTSTRAP_ADMIN_PASSWORD;
  if (email && passwordValue) return { email, password: passwordValue, source: process.env.INTLY_VERIFY_ADMIN_EMAIL || process.env.INTLY_VERIFY_ADMIN_PASSWORD ? 'env-override' : 'backend-env-bootstrap' };
  throw new Error('Admin credentials not found. Set INTLY_VERIFY_ADMIN_EMAIL/INTLY_VERIFY_ADMIN_PASSWORD or backend BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD.');
}

async function loadEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  const text = await readFile(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    env[key] = rest.join('=').replace(/^["']|["']$/g, '');
  }
  return env;
}

function apiBase(env) {
  const direct = process.env.INTLY_API_BASE_URL ?? process.env.API_BASE_URL;
  if (direct) return direct.replace(/\/$/, '').endsWith('/api/v1') ? direct.replace(/\/$/, '') : `${direct.replace(/\/$/, '')}/api/v1`;
  const port = process.env.PORT ?? env.PORT ?? '3001';
  const host = process.env.HOST ?? env.HOST ?? '127.0.0.1';
  return `http://${host}:${port}/api/v1`;
}

function assertLoopbackUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid URL`); }
  assert(isLoopbackHost(parsed.hostname), `${label} must be loopback/local, got ${parsed.hostname}`);
}

function assertLoopbackMongoUri(value) {
  assert(value.startsWith('mongodb://'), 'MONGODB_URI must use mongodb:// for local analytics verification; mongodb+srv is refused');
  const authority = value.slice('mongodb://'.length).split('/')[0];
  const hosts = authority.split('@').at(-1).split(',').map((item) => item.trim()).filter(Boolean);
  assert(hosts.length > 0, 'MONGODB_URI must include a host');
  for (const hostPort of hosts) {
    const host = hostPort.startsWith('[') ? hostPort.slice(1, hostPort.indexOf(']')) : hostPort.split(':')[0];
    assert(isLoopbackHost(host), `MONGODB_URI must be loopback/local, got ${host}`);
  }
}

function isLoopbackHost(host) {
  const normalized = String(host ?? '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function requiredString(object, key) {
  const value = object?.[key];
  assert(typeof value === 'string' && value.length > 0, `${key} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;=]+=[^;]+)/g);
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function sanitizeError(error) {
  if (error instanceof HttpError) return { message: error.message, status: error.status, body: error.body };
  return { message: error instanceof Error ? error.message : String(error) };
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(projectRoot, '.local/reports'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  report.ok = false;
  report.failure = sanitizeError(error);
  process.exitCode = 1;
} finally {
  await writeReport();
  console.log(JSON.stringify({ ok: report.ok, runId: report.runId, reportPath, checks: report.checks.map(({ name, ok }) => ({ name, ok })), warnings: report.warnings }, null, 2));
}
