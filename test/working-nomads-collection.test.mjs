import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const undici = require('undici');
const pinnedFetch = require('../src/modules/sources/extraction/pinned-fetch.ts');
const { WorkingNomadsConnector } = require('../src/modules/sources/connectors/working-nomads.connector.ts');

function ctx(overrides = {}) {
  return {
    source: {
      _id: 'workingnomads',
      name: 'Working Nomads',
      endpoint: {},
      config: {},
      limits: { perPage: 2 },
      timeoutMs: 1_000,
      opportunityTypes: ['vacancy'],
    },
    requestId: 'wn-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function response(payload, { status = 200, contentType = 'application/json' } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? contentType : null; } },
    async text() { return body; },
  };
}

function payload(hits, total = hits.length) {
  return rawPayload(hits.map((source) => ({ _index: 'jobsapi', _id: String(source.id), _source: source, sort: [source.premium ? 1 : 0, Date.parse(source.pub_date ?? '2026-09-01T00:00:00Z'), source.id] })), total);
}

function rawPayload(hits, total = hits.length) {
  return {
    took: 1,
    timed_out: false,
    hits: {
      total: { value: total, relation: 'eq' },
      hits,
    },
  };
}

function internalSearchDocument(sort = [0, 9999999999999, '_search']) {
  return { _index: 'jobsapi', _id: '_search', _source: {}, sort };
}

const liveLikeJob = {
  id: 1907058,
  title: 'Content Reviewer United States - English-speaking',
  slug: 'content-reviewer-united-states-telus-digital-1907058',
  company: 'TELUS Digital',
  company_slug: 'telus-digital',
  category_name: 'Administration',
  description: '<p><strong>TELUS Digital AI Community</strong></p><p>Review search results &amp; improve quality.</p>',
  position_type: 'pt',
  tags: ['quality', 'english', 'communication'],
  locations: ['USA'],
  location_base: 'United States',
  pub_date: '2026-10-01T14:04:06+00:00',
  apply_option: 'with_your_ats',
  apply_url: 'https://www.telusinternational.ai/cmp/contributor/jobs/available/128949',
  external_id: '',
  source: 'feed',
  premium: true,
  instructions: '',
  expired: false,
  salary_range: '$ 14 per hour',
  salary_range_short: '$14/h',
  annual_salary_usd: null,
  experience_level: 'ENTRY_LEVEL',
  number_of_applicants: 7,
  use_ats: true,
};

const secondJob = {
  id: 1901953,
  title: 'AI Content Analyst (No Experience Required)',
  slug: 'ai-content-analyst-no-experience-required-peroptyx-1901953',
  company: 'Peroptyx',
  category_name: 'Administration',
  description: '<h1>AI Analyst</h1><ol><li>Fluent in English and Korean</li></ol>',
  position_type: 'pt',
  tags: ['analyst', 'korean', 'english'],
  locations: ['South Korea'],
  location_base: 'South Korea',
  pub_date: '2026-09-29T17:13:38+00:00',
  apply_url: 'https://connect.peroptyx.ai/tracking/code/7fw3Ou',
  premium: true,
  expired: false,
  salary_range: '',
  salary_range_short: '',
  annual_salary_usd: null,
  experience_level: 'ENTRY_LEVEL',
};

const unknownDateJob = {
  id: 1900001,
  title: 'Undated Remote Role',
  slug: 'undated-remote-role-example-1900001',
  company: 'Example Co',
  description: '<p>Still a real job.</p>',
  premium: false,
  expired: true,
};

const oldKnownDateJob = {
  id: 1899000,
  title: 'Old Known Date Role',
  slug: 'old-known-date-role-example-1899000',
  company: 'Example Co',
  description: '<p>Old known date should be locally filtered.</p>',
  pub_date: '2026-08-01T00:00:00+00:00',
  premium: false,
  expired: false,
};

function generatedJob(id) {
  return {
    id,
    title: `Generated Role ${id}`,
    slug: `generated-role-${id}`,
    company: 'Example Co',
    description: `<p>Generated job ${id}.</p>`,
    pub_date: '2026-09-15T00:00:00+00:00',
    premium: false,
    expired: false,
  };
}

test('Working Nomads connector fetches current catalog pages with fixed date window and full source fields', async () => {
  const bodies = [];
  const replies = [payload([liveLikeJob, secondJob], 4), payload([unknownDateJob, oldKnownDateJob], 4)];
  const connector = new WorkingNomadsConnector(async (body) => {
    bodies.push(body);
    return response(replies.shift());
  });

  const first = await connector.fetchPage(ctx());
  const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));

  assert.equal(first.records.length, 2);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.checkpoint.searchAfter, [1, Date.parse(secondJob.pub_date), secondJob.id]);
  assert.equal(first.checkpoint.seenSoFar, 2);
  assert.equal(first.checkpoint.perPage, 2);
  assert.equal(first.checkpoint.maxObservedTotal, 4);
  assert.deepEqual(first.checkpoint.seenIds, ['1907058', '1901953']);
  assert.deepEqual(first.checkpoint.visitedSearchAfter, ['FIRST_PAGE']);
  assert.equal(first.checkpoint.window, 'finite_current_catalog');
  assert.match(first.checkpoint.publicSearchScope, /public jobsapi/);
  assert.equal(first.records[0].externalId, '1907058');
  assert.equal(first.records[0].url, 'https://www.workingnomads.com/jobs/content-reviewer-united-states-telus-digital-1907058');
  assert.equal(first.records[0].companyOrClient, 'TELUS Digital');
  assert.match(first.records[0].description, /Review search results & improve quality/);
  assert.deepEqual(first.records[0].sourceMetadata.locations, ['USA']);
  assert.deepEqual(first.records[0].sourceMetadata.skills, ['quality', 'english', 'communication']);
  assert.equal(first.records[0].sourceMetadata.salary.originalText, '$ 14 per hour');
  assert.equal(first.records[0].sourceMetadata.salary.shortText, '$14/h');
  assert.equal(first.records[0].sourceMetadata.remoteType, 'remote');
  assert.equal(first.records[0].sourceMetadata.remoteTypeSource, 'https://www.workingnomads.com/faq');
  assert.equal(first.records[0].sourceMetadata.applyUrl, liveLikeJob.apply_url);
  assert.equal(first.records[0].sourceMetadata.expired, false);
  assert.equal(first.records[0].rawPayload.source.title, liveLikeJob.title);

  assert.equal(second.records.length, 1);
  assert.equal(second.stats.seen, 2);
  assert.equal(second.hasMore, false);
  assert.equal(second.checkpoint.terminalReason, 'observed-search-exhausted');
  assert.equal(second.checkpoint.seenSoFar, 4);
  assert.equal(second.checkpoint.maxObservedTotal, 4);
  assert.deepEqual(second.checkpoint.seenIds, ['1907058', '1901953', '1900001', '1899000']);
  assert.deepEqual(second.checkpoint.visitedSearchAfter, ['FIRST_PAGE', JSON.stringify(first.checkpoint.searchAfter)]);
  assert.equal(second.records[0].externalId, '1900001');
  assert.equal(second.records[0].publishedAt, undefined);
  assert.equal(second.records[0].sourceStatus, 'Closed');
  assert.equal('from' in bodies[0], false);
  assert.equal('from' in bodies[1], false);
  assert.equal(bodies[0].size, 2);
  assert.equal(bodies[1].size, 2);
  assert.deepEqual(bodies[1].search_after, first.checkpoint.searchAfter);
  assert.deepEqual(bodies[0]._source.includes('description'), true);
  assert.equal(bodies[0].query.bool.filter[0].bool.should[0].range.pub_date.gte, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(bodies[0].query.bool.filter[0].bool.should[1], { bool: { must_not: { exists: { field: 'pub_date' } } } });
  assert.equal(bodies[1].query.bool.filter[0].bool.should[0].range.pub_date.lte, first.checkpoint.windowTo);
});

test('Working Nomads connector resets new runs, deduplicates page ids and returns empty terminal pages', async () => {
  const bodies = [];
  const connector = new WorkingNomadsConnector(async (body) => {
    bodies.push(body);
    if (bodies.length === 1) return response(payload([liveLikeJob, { ...liveLikeJob, title: 'Duplicate should not emit' }], 10001));
    if (bodies.length === 2) return response(payload([], 4));
    return response(payload([{ ...liveLikeJob, title: 'Fresh cycle updated title', description: '<p>Fresh full record.</p>' }], 1));
  });

  const first = await connector.fetchPage(ctx());
  const terminal = await connector.fetchPage(ctx({ source: { ...ctx().source, limits: { perPage: 99 } }, checkpoint: { hasMore: true, searchAfter: first.checkpoint.searchAfter, seenSoFar: 10_001, perPage: first.checkpoint.perPage, windowFrom: first.checkpoint.windowFrom, windowTo: first.checkpoint.windowTo, maxObservedTotal: 10001, seenIds: first.checkpoint.seenIds, visitedSearchAfter: first.checkpoint.visitedSearchAfter } }));
  const newRun = await connector.fetchPage(ctx({ checkpoint: terminal.checkpoint }));

  assert.deepEqual(first.records.map((record) => record.externalId), ['1907058']);
  assert.equal(terminal.records.length, 0);
  assert.equal(terminal.hasMore, false);
  assert.equal(terminal.checkpoint.seenSoFar, 10_001);
  assert.equal(terminal.checkpoint.maxObservedTotal, 10001);
  assert.equal(bodies[1].size, 2);
  assert.deepEqual(bodies[1].search_after, first.checkpoint.searchAfter);
  assert.deepEqual(newRun.records.map((record) => record.externalId), ['1907058']);
  assert.equal(newRun.records[0].title, 'Fresh cycle updated title');
  assert.match(newRun.records[0].description, /Fresh full record/);
  assert.equal(newRun.checkpoint.seenSoFar, 1);
  assert.deepEqual(newRun.checkpoint.seenIds, ['1907058']);
  assert.deepEqual(newRun.checkpoint.visitedSearchAfter, ['FIRST_PAGE']);
  assert.equal('search_after' in bodies[2], false);
});



test('Working Nomads connector rejects invalid continuations, total shrink false terminals, empty early pages and cursor loops', async () => {
  const cursor = [1, Date.parse(secondJob.pub_date), secondJob.id];
  const baseCheckpoint = {
    hasMore: true,
    searchAfter: cursor,
    seenSoFar: 2,
    perPage: 2,
    windowFrom: '2026-09-01T00:00:00.000Z',
    windowTo: '2026-10-04T00:00:00.000Z',
    maxObservedTotal: 4,
    seenIds: ['1907058', '1901953'],
    visitedSearchAfter: ['FIRST_PAGE'],
  };

  const shrink = new WorkingNomadsConnector(async () => response(payload([unknownDateJob], 0)));
  const shrinkPage = await shrink.fetchPage(ctx({ checkpoint: baseCheckpoint }));
  assert.equal(shrinkPage.hasMore, true);
  assert.equal(shrinkPage.checkpoint.maxObservedTotal, 4);
  assert.equal(shrinkPage.checkpoint.total, 0);
  assert.deepEqual(shrinkPage.records.map((record) => record.externalId), ['1900001']);

  const emptyEarly = new WorkingNomadsConnector(async () => response(payload([], 0)));
  await assert.rejects(() => emptyEarly.fetchPage(ctx({ checkpoint: baseCheckpoint })), /empty hits before observed total/);

  const repeatedCursor = new WorkingNomadsConnector(async () => response(payload([unknownDateJob], 4)));
  await assert.rejects(() => repeatedCursor.fetchPage(ctx({ checkpoint: { ...baseCheckpoint, visitedSearchAfter: ['FIRST_PAGE', JSON.stringify(cursor)] } })), /repeated search_after cursor/);

  const nonAdvancing = new WorkingNomadsConnector(async () => response({
    took: 1,
    timed_out: false,
    hits: { total: { value: 4, relation: 'eq' }, hits: [{ _index: 'jobsapi', _id: String(unknownDateJob.id), _source: unknownDateJob, sort: cursor }] },
  }));
  await assert.rejects(() => nonAdvancing.fetchPage(ctx({ checkpoint: baseCheckpoint })), /non-advancing search_after cursor/);

  const repeatedIds = new WorkingNomadsConnector(async () => response(payload([liveLikeJob, secondJob], 4)));
  await assert.rejects(() => repeatedIds.fetchPage(ctx({ checkpoint: baseCheckpoint })), /repeated all hit ids/);

  const previousFifty = Array.from({ length: 50 }, (_, index) => String(2000 + index));
  const overlapHits = [...previousFifty.slice(0, 49).map((id) => generatedJob(Number(id))), generatedJob(3000)];
  const overlapConnector = new WorkingNomadsConnector(async () => response(payload(overlapHits, 100)));
  const overlapPage = await overlapConnector.fetchPage(ctx({ checkpoint: { ...baseCheckpoint, searchAfter: [false, Date.parse('2026-09-20T00:00:00Z'), 2049], seenSoFar: 50, perPage: 50, maxObservedTotal: 100, seenIds: previousFifty, visitedSearchAfter: ['FIRST_PAGE'] } }));
  assert.equal(overlapPage.hasMore, true);
  assert.equal(overlapPage.checkpoint.seenSoFar, 51);
  assert.equal(overlapPage.checkpoint.maxObservedTotal, 100);
  assert.equal(overlapPage.records.length, 1);
  assert.equal(overlapPage.records[0].externalId, '3000');

  for (const checkpoint of [
    { ...baseCheckpoint, searchAfter: undefined },
    { ...baseCheckpoint, searchAfter: [1, 2] },
    { ...baseCheckpoint, seenSoFar: undefined },
    { ...baseCheckpoint, windowFrom: undefined },
    { ...baseCheckpoint, windowTo: 'not-a-date' },
    { ...baseCheckpoint, windowFrom: '2026-10-05T00:00:00.000Z', windowTo: '2026-10-04T00:00:00.000Z' },
  ]) {
    await assert.rejects(() => shrink.fetchPage(ctx({ checkpoint })), /continuation checkpoint/);
  }
});



test('Working Nomads connector counts only the observed internal search sentinel as excluded catalog provenance', async () => {
  const sentinelSort = [0, Date.parse('2026-09-28T00:00:00Z'), '_search'];
  const bodies = [];
  const connector = new WorkingNomadsConnector(async (body) => {
    bodies.push(body);
    if (bodies.length === 1) return response(rawPayload([
      { _index: 'jobsapi', _id: String(liveLikeJob.id), _source: liveLikeJob, sort: [1, Date.parse(liveLikeJob.pub_date), liveLikeJob.id] },
      internalSearchDocument(sentinelSort),
    ], 3));
    return response(payload([secondJob], 3));
  });

  const first = await connector.fetchPage(ctx());
  assert.deepEqual(first.records.map((record) => record.externalId), ['1907058']);
  assert.equal(first.hasMore, true);
  assert.equal(first.checkpoint.seenSoFar, 2);
  assert.deepEqual(first.checkpoint.seenIds, ['1907058', 'jobsapi:internal:_search']);
  assert.deepEqual(first.checkpoint.searchAfter, sentinelSort);
  assert.deepEqual(first.checkpoint.excludedInternalDocuments, [{
    identity: 'jobsapi:internal:_search',
    reason: 'working-nomads-internal-search-document',
    index: 'jobsapi',
    hitId: '_search',
    sort: sentinelSort,
  }]);

  const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));
  assert.deepEqual(bodies[1].search_after, sentinelSort);
  assert.deepEqual(second.records.map((record) => record.externalId), ['1901953']);
  assert.equal(second.hasMore, false);
  assert.equal(second.checkpoint.terminalReason, 'observed-search-exhausted');
  assert.equal(second.checkpoint.seenSoFar, 3);
  assert.deepEqual(second.checkpoint.seenIds, ['1907058', 'jobsapi:internal:_search', '1901953']);
  assert.deepEqual(second.checkpoint.excludedInternalDocuments, first.checkpoint.excludedInternalDocuments);

  const terminalSentinel = new WorkingNomadsConnector(async () => response(rawPayload([
    { _index: 'jobsapi', _id: String(liveLikeJob.id), _source: liveLikeJob, sort: [1, Date.parse(liveLikeJob.pub_date), liveLikeJob.id] },
    internalSearchDocument(sentinelSort),
  ], 2)));
  const terminal = await terminalSentinel.fetchPage(ctx());
  assert.equal(terminal.hasMore, false);
  assert.equal(terminal.checkpoint.seenSoFar, 2);
  assert.equal(terminal.checkpoint.terminalReason, 'observed-search-exhausted');
  assert.deepEqual(terminal.checkpoint.seenIds, ['1907058', 'jobsapi:internal:_search']);
});

test('Working Nomads connector accepts the real catalog listing and api URLs', async () => {
  const bodies = [];
  const connector = new WorkingNomadsConnector(async (body) => {
    bodies.push(body);
    return response(payload([liveLikeJob]));
  });

  const page = await connector.fetchPage(ctx({
    source: {
      ...ctx().source,
      endpoint: {
        baseUrl: 'https://www.workingnomads.com/jobs',
        apiUrl: 'https://www.workingnomads.com/jobsapi/_search',
      },
    },
  }));

  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].url, 'https://www.workingnomads.com/jobs/content-reviewer-united-states-telus-digital-1907058');
  assert.equal(bodies.length, 1);
});

test('Working Nomads connector rejects unsafe config and non-JSON or malformed API responses', async () => {
  const connector = new WorkingNomadsConnector(async () => response('<html>blocked</html>', { contentType: 'text/html' }));
  for (const endpoint of [
    { baseUrl: 'https://evil.example' },
    { baseUrl: 'https://user:pass@www.workingnomads.com' },
    { baseUrl: 'https://www.workingnomads.com/jobsapi' },
    { baseUrl: 'https://www.workingnomads.com/jobs?x=1' },
    { apiUrl: 'https://www.workingnomads.com/jobsapi/_search?x=1' },
  ]) {
    await assert.rejects(
      () => connector.fetchPage(ctx({ source: { ...ctx().source, endpoint } })),
      /only supports https:\/\/www\.workingnomads\.com/,
    );
  }
  await assert.rejects(
    () => connector.fetchPage(ctx()),
    /unsupported content type text\/html/,
  );

  const badPayload = new WorkingNomadsConnector(async () => response({ ok: true }));
  await assert.rejects(() => badPayload.fetchPage(ctx()), /missing hits/);

  const timedOut = new WorkingNomadsConnector(async () => response({ timed_out: true, hits: { total: { value: 1, relation: 'eq' }, hits: [] } }));
  await assert.rejects(() => timedOut.fetchPage(ctx()), /timed out partial payload/);

  const inexactTotal = new WorkingNomadsConnector(async () => response({ hits: { total: { value: 10000, relation: 'gte' }, hits: [] } }));
  await assert.rejects(() => inexactTotal.fetchPage(ctx()), /inexact total/);

  const missingDescription = new WorkingNomadsConnector(async () => response(payload([{ ...liveLikeJob, description: '' }])));
  await assert.rejects(() => missingDescription.fetchPage(ctx()), /missing full description/);

  const malformedSearchLikeJob = new WorkingNomadsConnector(async () => response(rawPayload([{ _index: 'jobsapi', _id: '_search', _source: { title: 'Not the exact internal sentinel' }, sort: [0, 1, '_search'] }])));
  await assert.rejects(() => malformedSearchLikeJob.fetchPage(ctx()), /missing stable id title or slug/);

  const sentinelWithoutSort = new WorkingNomadsConnector(async () => response(rawPayload([{ _index: 'jobsapi', _id: '_search', _source: {} }])));
  await assert.rejects(() => sentinelWithoutSort.fetchPage(ctx()), /missing stable id title or slug/);

  const httpError = new WorkingNomadsConnector(async () => response({ error: 'nope' }, { status: 503 }));
  await assert.rejects(() => httpError.fetchPage(ctx()), /returned 503/);
});

test('Working Nomads connector uses the fixed public origin and bounded default response body', async () => {
  const originalFetch = undici.fetch;
  const originalPinnedDispatcher = pinnedFetch.createPinnedDispatcher;
  let cancelled = false;
  let closed = false;
  let requestedUrl = '';
  try {
    pinnedFetch.createPinnedDispatcher = async (url) => {
      requestedUrl = url.toString();
      return { close: async () => { closed = true; } };
    };
    undici.fetch = async () => new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(5_000_001));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    await assert.rejects(
      () => new WorkingNomadsConnector().fetchPage(ctx()),
      /larger than the v1 safety limit/,
    );
    assert.equal(requestedUrl, 'https://www.workingnomads.com/jobsapi/_search');
    assert.equal(cancelled, true);
    assert.equal(closed, true);
  } finally {
    undici.fetch = originalFetch;
    pinnedFetch.createPinnedDispatcher = originalPinnedDispatcher;
  }
});
