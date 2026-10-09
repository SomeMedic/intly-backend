import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { WorkdayConnector } = require('../src/modules/sources/connectors/workday.connector.ts');
const { ConnectorRateLimitError } = require('../src/modules/sources/connectors/connector.types.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, 'fixtures', 'workday');
const boardUrl = 'https://workday.wd5.myworkdayjobs.com/en-US/Workday';
const apiUrl = 'https://workday.wd5.myworkdayjobs.com/wday/cxs/workday/Workday/jobs';
const listingFixture = JSON.parse(readFileSync(join(fixtureDir, 'workday-listing.json'), 'utf8'));
const detailFixture = JSON.parse(readFileSync(join(fixtureDir, 'workday-detail.json'), 'utf8'));

function ctx(overrides = {}) {
  return {
    source: {
      _id: 'workday',
      name: 'Workday',
      connectorFamily: 'AtsPublicBoard',
      endpoint: {},
      config: { tenants: [boardUrl] },
      limits: { perPage: 2 },
      timeoutMs: 30_000,
      ...overrides.source,
    },
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
    requestId: 'workday-test',
    ...overrides,
  };
}

function listing({ total, jobs }) {
  return { total, jobPostings: jobs, facets: [], userAuthenticated: false };
}

function job(id, overrides = {}) {
  return {
    title: `Engineer ${id}`,
    externalPath: `/job/USA-Remote/Engineer-${id}_JR-${id}`,
    locationsText: 'USA, Remote',
    postedOn: 'Posted Yesterday',
    remoteType: 'Remote',
    bulletFields: [`JR-${id}`],
    ...overrides,
  };
}

function detail(id, overrides = {}) {
  return {
    jobPostingInfo: {
      id: `wid-${id}`,
      title: `Engineer ${id}`,
      jobDescription: '<p>Build reliable services.</p><ul><li>Own public APIs</li><li>Keep systems healthy</li></ul><script>evil()</script>',
      location: 'USA, Remote',
      additionalLocations: ['USA, CA, Pleasanton'],
      postedOn: 'Posted Yesterday',
      startDate: '2026-10-03T10:00:00Z',
      timeType: 'Full Time',
      jobReqId: `JR-${id}`,
      jobPostingId: `Engineer-${id}_JR-${id}`,
      jobPostingSiteId: 'Workday',
      country: { descriptor: 'United States of America', id: 'us' },
      jobRequisitionLocation: { descriptor: 'USA, Remote', country: { descriptor: 'United States of America', alpha2Code: 'US' } },
      remoteType: 'Remote',
      externalUrl: `https://workday.wd5.myworkdayjobs.com/Workday/job/USA-Remote/Engineer-${id}_JR-${id}`,
      ...(overrides.jobPostingInfo ?? {}),
    },
    hiringOrganization: overrides.hiringOrganization ?? { name: `Company ${id}`, url: '' },
    similarJobs: overrides.similarJobs ?? [],
    userAuthenticated: overrides.userAuthenticated ?? false,
  };
}

function mockFetch(routes) {
  const previous = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const stringUrl = String(url);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    calls.push({ url: stringUrl, options, body });
    const route = typeof routes === 'function' ? routes(stringUrl, options, body) : routes.shift();
    if (!route) throw new Error(`Unexpected fetch ${stringUrl}`);
    if (route.error) throw route.error;
    const status = route.status ?? 200;
    const headers = new Headers(route.headers ?? { 'content-type': 'application/json' });
    return new Response(typeof route.body === 'string' ? route.body : JSON.stringify(route.body), { status, headers });
  };
  global.fetch.calls = calls;
  return () => {
    global.fetch = previous;
  };
}

describe('Workday public CXS collection', () => {
  it('maps real public listing and detail payloads into full records with raw audit data', async () => {
    const restoreFetch = mockFetch((url, _options, body) => {
      if (url === apiUrl) {
        assert.deepEqual(body, { appliedFacets: {}, limit: 2, offset: 0, searchText: '' });
        return { body: listing({ total: 1, jobs: [listingFixture.jobPostings[0]] }) };
      }
      if (url.endsWith(listingFixture.jobPostings[0].externalPath)) return { body: detailFixture };
      return null;
    });
    try {
      const result = await new WorkdayConnector().fetchPage(ctx());

      assert.equal(result.records.length, 1);
      const [record] = result.records;
      assert.equal(record.externalId, 'workday.wd5.myworkdayjobs.com/workday/Workday:JR-0107491');
      assert.equal(record.type, 'vacancy');
      assert.equal(record.title, detailFixture.jobPostingInfo.title);
      assert.equal(record.companyOrClient, 'Workday, Inc.');
      assert.match(record.url, /^https:\/\/workday\.wd5\.myworkdayjobs\.com\/Workday\/job\//);
      assert.match(record.description, /Your work days are brighter here/);
      assert.match(record.description, /About the Team\nWorkday's Managing Partner practice/);
      assert.doesNotMatch(record.description, /<p>|<li>|<script/);
      assert.equal(record.publishedAt, undefined, 'date-only startDate stays raw instead of invented timezone');
      assert.equal(record.sourceMetadata.ats, 'workday');
      assert.equal(record.sourceMetadata.tenant, 'workday');
      assert.equal(record.sourceMetadata.site, 'Workday');
      assert.equal(record.sourceMetadata.timeType, 'Full Time');
      assert.equal(record.sourceMetadata.remoteType, 'Flex');
      assert.deepEqual(record.sourceMetadata.locations.slice(0, 2), ['USA, NY, New York City', 'USA, TX, Frisco']);
      assert.equal(record.sourceMetadata.startDate, '2026-10-03');
      assert.deepEqual(record.sourceMetadata.salary, {
        min: 176200,
        max: 264400,
        currency: 'USD',
        period: 'YEAR',
        originalText: 'Primary Location Base Pay Range: $176,200 USD - $264,400 USD',
        otherRanges: ['Additional US Location(s) Base Pay Range: $148,900 USD - $264,400 USD'],
      });
      const normalized = new SourceNormalizerService().normalize({ _id: 'workday', name: 'Workday', connectorFamily: 'AtsPublicBoard', group: 'web' }, record);
      assert.deepEqual(normalized.money, { min: 176200, max: 264400, currency: 'USD', period: 'YEAR', originalText: 'Primary Location Base Pay Range: $176,200 USD - $264,400 USD' });
      assert.ok(record.rawPayload.detail.jobPostingInfo.jobDescription.includes('<p>'));
      assert.equal(result.hasMore, false);
      assert.equal(result.stats.seen, 1);
      assert.deepEqual(result.checkpoint.visitedOffsets, ['workday.wd5.myworkdayjobs.com/workday/Workday:0']);
    } finally {
      restoreFetch();
    }
  });

  it('walks non-overlapping offsets to terminal without arbitrary page caps', async () => {
    const routes = [
      { body: listing({ total: 3, jobs: [job(1), job(2)] }) },
      { body: detail(1) },
      { body: detail(2) },
      { body: listing({ total: 3, jobs: [job(3)] }) },
      { body: detail(3) },
    ];
    const restoreFetch = mockFetch(routes);
    try {
      const connector = new WorkdayConnector();
      const first = await connector.fetchPage(ctx());
      const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));

      assert.deepEqual(global.fetch.calls.filter((call) => call.url === apiUrl).map((call) => call.body.offset), [0, 2]);
      assert.deepEqual(first.records.map((record) => record.externalId), [
        'workday.wd5.myworkdayjobs.com/workday/Workday:JR-1',
        'workday.wd5.myworkdayjobs.com/workday/Workday:JR-2',
      ]);
      assert.equal(first.hasMore, true);
      assert.equal(first.checkpoint.offset, 2);
      assert.equal(second.hasMore, false);
      assert.deepEqual(second.records.map((record) => record.externalId), ['workday.wd5.myworkdayjobs.com/workday/Workday:JR-3']);
      assert.deepEqual(second.checkpoint.visitedOffsets, [
        'workday.wd5.myworkdayjobs.com/workday/Workday:0',
        'workday.wd5.myworkdayjobs.com/workday/Workday:2',
      ]);
    } finally {
      restoreFetch();
    }
  });

  it('continues across multiple configured boards with a frozen board set', async () => {
    const secondBoard = 'https://acme.wd1.myworkdayjobs.com/en-US/External';
    const secondApi = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/jobs';
    const restoreFetch = mockFetch((url) => {
      if (url === apiUrl) return { body: listing({ total: 1, jobs: [job(1)] }) };
      if (url.endsWith('/Engineer-1_JR-1')) return { body: detail(1) };
      if (url === secondApi) return { body: listing({ total: 1, jobs: [job(9)] }) };
      if (url.endsWith('/Engineer-9_JR-9')) return { body: detail(9, { jobPostingInfo: { externalUrl: 'https://acme.wd1.myworkdayjobs.com/External/job/USA-Remote/Engineer-9_JR-9' }, hiringOrganization: { name: 'Acme' } }) };
      return null;
    });
    try {
      const connector = new WorkdayConnector();
      const first = await connector.fetchPage(ctx({ source: { config: { tenants: [boardUrl, secondBoard] } } }));
      const second = await connector.fetchPage(ctx({ source: { config: { tenants: [boardUrl, secondBoard] } }, checkpoint: first.checkpoint }));

      assert.equal(first.hasMore, true);
      assert.equal(first.checkpoint.boardIndex, 1);
      assert.equal(first.checkpoint.offset, 0);
      assert.deepEqual(first.checkpoint.boardKeys, ['workday.wd5.myworkdayjobs.com/workday/Workday', 'acme.wd1.myworkdayjobs.com/acme/External']);
      assert.equal(second.records[0].externalId, 'acme.wd1.myworkdayjobs.com/acme/External:JR-9');
      assert.equal(second.hasMore, false);
      await assert.rejects(
        () => connector.fetchPage(ctx({ source: { config: { tenants: [secondBoard, boardUrl] } }, checkpoint: first.checkpoint })),
        /configured board set changed/,
      );
    } finally {
      restoreFetch();
    }
  });

  it('rejects unsafe board URLs and unsafe detail paths before reading wrong hosts', async () => {
    const connector = new WorkdayConnector();
    assert.equal((await connector.validateConfig({ tenants: ['https://evil.example.com/en-US/Workday'] })).ok, false);
    assert.equal((await connector.validateConfig({ tenants: ['https://workday.wd5.myworkdayjobs.com/en-US/Workday/job/foo'] })).ok, false);
    await assert.rejects(
      () => connector.fetchPage(ctx({ source: { endpoint: { baseUrl: 'https://www.workday.com' }, config: {} } })),
      /no configured public board URLs/,
    );

    const restoreFetch = mockFetch([{ body: listing({ total: 1, jobs: [job(1, { externalPath: 'https://evil.example.com/job/JR-1' })] }) }]);
    try {
      await assert.rejects(() => connector.fetchPage(ctx()), /unsafe externalPath/);
      assert.equal(global.fetch.calls.length, 1);
    } finally {
      restoreFetch();
    }
  });

  it('keeps errors retryable for truncated pages, 5xx, rate limits, and cancellation', async () => {
    const connector = new WorkdayConnector();
    let restoreFetch = mockFetch([{ body: listing({ total: 2, jobs: [] }) }]);
    try {
      await assert.rejects(() => connector.fetchPage(ctx()), /empty page before total/);
    } finally {
      restoreFetch();
    }

    restoreFetch = mockFetch([{ status: 500, body: { error: 'boom' } }]);
    try {
      await assert.rejects(() => connector.fetchPage(ctx()), /returned 500/);
    } finally {
      restoreFetch();
    }

    restoreFetch = mockFetch([{ status: 429, headers: { 'retry-after': '12' }, body: { error: 'rate' } }]);
    try {
      await assert.rejects(async () => connector.fetchPage(ctx()), (error) => error instanceof ConnectorRateLimitError && error.retryAfterSeconds === 12);
    } finally {
      restoreFetch();
    }

    const abort = new AbortController();
    restoreFetch = mockFetch([{ body: listing({ total: 0, jobs: [] }) }]);
    try {
      await connector.fetchPage(ctx({ signal: abort.signal }));
      assert.ok(global.fetch.calls[0].options.signal instanceof AbortSignal);
    } finally {
      restoreFetch();
    }
  });

  it('filters known zoned and day-precision dates without fabricating date-only publishedAt', async () => {
    const restoreFetch = mockFetch([
      { body: listing({ total: 5, jobs: [job(1), job(2), job(3), job(4), job(5)] }) },
      { body: detail(1, { jobPostingInfo: { startDate: '2026-08-01T00:00:00Z' } }) },
      { body: detail(2, { jobPostingInfo: { startDate: '2026-10-03T00:00:00Z' } }) },
      { body: detail(3, { jobPostingInfo: { startDate: '2026-10-03' } }) },
      { body: detail(4, { jobPostingInfo: { startDate: '2026-08-01' } }) },
      { body: detail(5, { jobPostingInfo: { startDate: '2099-01-01' } }) },
    ]);
    try {
      const result = await new WorkdayConnector().fetchPage(ctx({ source: { config: { tenants: [boardUrl] }, limits: { perPage: 20 } } }));

      assert.deepEqual(result.records.map((record) => record.externalId), [
        'workday.wd5.myworkdayjobs.com/workday/Workday:JR-2',
        'workday.wd5.myworkdayjobs.com/workday/Workday:JR-3',
      ]);
      assert.equal(result.records[0].publishedAt.toISOString(), '2026-10-03T00:00:00.000Z');
      assert.equal(result.records[0].sourceMetadata.datePrecision, 'instant');
      assert.equal(result.records[1].publishedAt, undefined);
      assert.equal(result.records[1].sourceMetadata.startDate, '2026-10-03');
      assert.equal(result.records[1].sourceMetadata.datePrecision, 'day');
    } finally {
      restoreFetch();
    }
  });


  it('clamps registry default perPage 50 to the observed public CXS limit 20 and rejects repeated offset pages', async () => {
    const firstJobs = Array.from({ length: 20 }, (_, index) => job(index + 1));
    const restoreFetch = mockFetch([
      { body: listing({ total: 25, jobs: firstJobs }) },
      ...firstJobs.map((entry, index) => ({ body: detail(index + 1, { jobPostingInfo: { jobReqId: entry.bulletFields[0], externalUrl: `https://workday.wd5.myworkdayjobs.com/Workday${entry.externalPath}` } }) })),
      { body: listing({ total: 25, jobs: firstJobs }) },
      ...firstJobs.map((entry, index) => ({ body: detail(index + 1, { jobPostingInfo: { jobReqId: entry.bulletFields[0], externalUrl: `https://workday.wd5.myworkdayjobs.com/Workday${entry.externalPath}` } }) })),
    ]);
    try {
      const connector = new WorkdayConnector();
      const first = await connector.fetchPage(ctx({ source: { endpoint: { baseUrl: 'https://www.workday.com' }, config: { tenants: [boardUrl] }, limits: { perPage: 50 } } }));
      assert.equal(global.fetch.calls[0].body.limit, 20);
      assert.equal(first.hasMore, true);
      await assert.rejects(
        () => connector.fetchPage(ctx({ source: { endpoint: { baseUrl: 'https://www.workday.com' }, config: { tenants: [boardUrl] }, limits: { perPage: 50 } }, checkpoint: first.checkpoint })),
        /repeated listing page/,
      );
    } finally {
      restoreFetch();
    }
  });


  it('keeps initial Workday total across continuation pages whose CXS total resets to zero', async () => {
    const firstJobs = Array.from({ length: 20 }, (_, index) => job(index + 1));
    const secondJobs = Array.from({ length: 20 }, (_, index) => job(index + 21));
    const finalJobs = Array.from({ length: 12 }, (_, index) => job(index + 361));
    const allDetails = (items) => items.map((entry) => ({ body: detail(entry.bulletFields[0].replace('JR-', ''), { jobPostingInfo: { jobReqId: entry.bulletFields[0], externalUrl: `https://workday.wd5.myworkdayjobs.com/Workday${entry.externalPath}` } }) }));
    const restoreFetch = mockFetch([
      { body: listing({ total: 372, jobs: firstJobs }) },
      ...allDetails(firstJobs),
      { body: listing({ total: 0, jobs: secondJobs }) },
      ...allDetails(secondJobs),
      { body: listing({ total: 0, jobs: finalJobs }) },
      ...allDetails(finalJobs),
    ]);
    try {
      const connector = new WorkdayConnector();
      const first = await connector.fetchPage(ctx({ source: { config: { tenants: [boardUrl] }, limits: { perPage: 50 } } }));
      const second = await connector.fetchPage(ctx({ source: { config: { tenants: [boardUrl] }, limits: { perPage: 50 } }, checkpoint: first.checkpoint }));
      const final = await connector.fetchPage(ctx({ source: { config: { tenants: [boardUrl] }, limits: { perPage: 50 } }, checkpoint: { ...second.checkpoint, offset: 360 } }));

      assert.deepEqual(global.fetch.calls.filter((call) => call.url === apiUrl).map((call) => call.body), [
        { appliedFacets: {}, limit: 20, offset: 0, searchText: '' },
        { appliedFacets: {}, limit: 20, offset: 20, searchText: '' },
        { appliedFacets: {}, limit: 20, offset: 360, searchText: '' },
      ]);
      assert.equal(first.checkpoint.totals['workday.wd5.myworkdayjobs.com/workday/Workday'], 372);
      assert.equal(second.hasMore, true);
      assert.equal(second.checkpoint.offset, 40);
      assert.equal(second.checkpoint.totals['workday.wd5.myworkdayjobs.com/workday/Workday'], 372);
      assert.equal(final.records.length, 12);
      assert.equal(final.hasMore, false);
      assert.equal(final.checkpoint.totals['workday.wd5.myworkdayjobs.com/workday/Workday'], 372);
    } finally {
      restoreFetch();
    }
  });

  it('keeps Workday continuation boundary failures retryable when total resets to zero', async () => {
    const firstJobs = Array.from({ length: 20 }, (_, index) => job(index + 1));
    const allDetails = firstJobs.map((entry, index) => ({ body: detail(index + 1, { jobPostingInfo: { jobReqId: entry.bulletFields[0], externalUrl: `https://workday.wd5.myworkdayjobs.com/Workday${entry.externalPath}` } }) }));
    let restoreFetch = mockFetch([
      { body: listing({ total: 372, jobs: firstJobs }) },
      ...allDetails,
      { body: listing({ total: 0, jobs: [] }) },
    ]);
    try {
      const connector = new WorkdayConnector();
      const first = await connector.fetchPage(ctx({ source: { config: { tenants: [boardUrl] }, limits: { perPage: 50 } } }));
      await assert.rejects(
        () => connector.fetchPage(ctx({ source: { config: { tenants: [boardUrl] }, limits: { perPage: 50 } }, checkpoint: first.checkpoint })),
        /empty page before total 372/,
      );
    } finally {
      restoreFetch();
    }

    restoreFetch = mockFetch([
      { body: listing({ total: 372, jobs: firstJobs }) },
      ...allDetails,
      { body: listing({ total: 372, jobs: firstJobs }) },
      ...allDetails,
    ]);
    try {
      const connector = new WorkdayConnector();
      const first = await connector.fetchPage(ctx({ source: { config: { tenants: [boardUrl] }, limits: { perPage: 50 } } }));
      await assert.rejects(
        () => connector.fetchPage(ctx({ source: { config: { tenants: [boardUrl] }, limits: { perPage: 50 } }, checkpoint: { ...first.checkpoint, offset: 380 } })),
        /repeated listing page/,
      );
    } finally {
      restoreFetch();
    }
  });

  it('discovers only explicit public Workday board links from configured seed pages', async () => {
    const seed = 'https://example.com/careers';
    const restoreFetch = mockFetch((url) => {
      if (url === seed) return { body: `<a href="${boardUrl}">Workday</a><a href="https://evil.example.com/en-US/jobs">Wrong</a>` };
      if (url === apiUrl) return { body: listing({ total: 1, jobs: [job(1)] }) };
      return null;
    });
    try {
      const result = await new WorkdayConnector().discover(ctx({ source: { config: { tenants: [], discoveryUrls: [seed] } } }));

      assert.equal(result.ok, true);
      assert.deepEqual(result.details.tenants, [boardUrl]);
      assert.deepEqual(global.fetch.calls.map((call) => call.url), [seed, apiUrl]);
    } finally {
      restoreFetch();
    }
  });
});
