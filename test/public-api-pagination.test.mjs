import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { PublicApiFeedConnector } = require('../src/modules/sources/connectors/public-api-feed.connector.ts');

function source(overrides = {}) {
  return {
    _id: 'public-api-test',
    enabled: true,
    runtimeState: 'Enabled',
    checkpoint: {},
    connectorFamily: 'OfficialRestApi',
    endpoint: {},
    config: {},
    limits: { perPage: 2 },
    timeoutMs: 30_000,
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    source: source(overrides.source),
    requestId: 'public-api-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

function patchGetJson(connector, handler) {
  connector.getJson = handler;
}

test('public API paged connectors reset terminal page and use fixed run window', async () => {
  const cases = [
    {
      id: 'superjob',
      credentials: { apiKey: 'test' },
      source: { limits: { perPage: 2 } },
      handler: async (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get('page'), '0');
        assert.equal(parsed.searchParams.get('date_published_from'), String(Date.parse('2026-09-04T00:00:00.000Z') / 1000));
        return { objects: [{ id: 1, profession: 'A', link: 'https://example.test/a' }], more: false };
      },
      expectedPage: 0,
    },
    {
      id: 'freelancehunt',
      credentials: { token: 'test' },
      source: { limits: { perPage: 2 } },
      handler: async (url) => {
        assert.equal(new URL(url).searchParams.get('page[number]'), '1');
        return {
          data: [{ id: 1, attributes: { name: 'A', published_at: '2026-09-05T00:00:00.000Z' }, links: { self: 'https://example.test/a' } }],
          links: {},
        };
      },
      expectedPage: 1,
    },
    {
      id: 'adzuna',
      credentials: { appId: 'id', appKey: 'key' },
      source: { config: { country: 'gb' }, limits: { perPage: 2 } },
      handler: async (url) => {
        assert.match(url, /\/search\/1\?/);
        return {
          count: 2,
          results: [
            { id: 'old', title: 'Old', redirect_url: 'https://example.test/old', created: '2026-09-03T23:59:59.000Z' },
            { id: 'a', title: 'A', redirect_url: 'https://example.test/a', created: '2026-09-05T00:00:00.000Z' },
          ],
        };
      },
      expectedPage: 1,
    },
  ];

  for (const item of cases) {
    const connector = new PublicApiFeedConnector(item.id);
    patchGetJson(connector, item.handler);
    const page = await connector.fetchPage(ctx({ source: item.source, credentials: item.credentials, checkpoint: { page: 99, hasMore: false } }));
    assert.equal(page.hasMore, false, item.id);
    assert.equal(page.checkpoint.page, item.expectedPage, item.id);
    assert.equal(page.checkpoint.hasMore, false, item.id);
    assert.equal(page.records.length, 1, item.id);
  }
});

test('trudvsem sends fixed modified window, handles body status, and resets terminal page', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('offset'), '0');
    assert.equal(parsed.searchParams.get('limit'), '2');
    assert.equal(parsed.searchParams.get('modifiedFrom'), '2026-09-04T00:00:00Z');
    assert.ok(parsed.searchParams.get('modifiedTo'));
    return {
      status: '200',
      meta: { total: 1, limit: 2 },
      results: {
        vacancies: [
          {
            vacancy: {
              id: 'tv-1',
              'job-name': 'Engineer',
              vac_url: 'https://trudvsem.ru/vacancy/card/123456/tv-1',
              'creation-date': '2026-09-05T00:00:00.000Z',
              date_modify: '2026-09-05T00:00:00.000Z',
              duty: 'Build systems',
              requirements: 'Know TypeScript',
            },
          },
        ],
      },
    };
  });

  const page = await connector.fetchPage(ctx({ source: { limits: { perPage: 2 } }, checkpoint: { page: 7, hasMore: false } }));

  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.page, 0);
  assert.equal(page.checkpoint.hasMore, false);
  assert.equal(page.checkpoint.modifiedFrom, '2026-09-04T00:00:00.000Z');
  assert.ok(page.checkpoint.modifiedTo);
  assert.equal(page.checkpoint.terminalReason, 'all-date-partitions-exhausted');
  assert.equal(page.checkpoint.completedPartitionCount, 1);
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].description, 'Build systems\n\nKnow TypeScript');
});

test('trudvsem wire dates omit milliseconds but local cutoff keeps exact milliseconds', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('modifiedFrom'), '2026-09-04T10:55:00Z');
    return {
      status: '200',
      meta: { total: 2, limit: 2 },
      results: {
        vacancies: [
          { vacancy: { id: 'before-ms', 'job-name': 'Before', vac_url: 'https://trudvsem.ru/vacancy/card/123456/before-ms', date_modify: '2026-09-04T10:55:00.122Z' } },
          { vacancy: { id: 'after-ms', 'job-name': 'After', vac_url: 'https://trudvsem.ru/vacancy/card/123456/after-ms', date_modify: '2026-09-04T10:55:00.123Z' } },
        ],
      },
    };
  });

  const page = await connector.fetchPage(ctx({ backfillSince: '2026-09-04T10:55:00.123Z' }));

  assert.deepEqual(page.records.map((record) => record.externalId), ['after-ms']);
});

test('trudvsem keeps outer modified bounds stable while exhausting single-response partitions', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  let calls = 0;
  const requestedWindows = [];
  patchGetJson(connector, async (url) => {
    const parsed = new URL(url);
    const call = calls++;
    assert.equal(parsed.searchParams.get('offset'), '0');
    requestedWindows.push({ from: parsed.searchParams.get('modifiedFrom'), to: parsed.searchParams.get('modifiedTo') });
    const count = call === 2 ? 2 : 4;
    return {
      status: '200',
      meta: { total: call === 0 ? 6 : count, limit: 4 },
      results: {
        vacancies: Array.from({ length: count }, (_, index) => ({ vacancy: { id: `partition-${call}-${index}`, 'job-name': 'Native vacancy', vac_url: `https://trudvsem.ru/vacancy/card/123456/partition-${call}-${index}` } })),
      },
    };
  });

  const first = await connector.fetchPage(ctx({
    source: { limits: { perPage: 4 } },
    checkpoint: { page: 0, hasMore: true, modifiedFrom: '2026-09-04T00:00:00.000Z', modifiedTo: '2026-10-04T12:00:00.000Z' },
  }));
  assert.equal(first.checkpoint.version, 4);
  assert.equal(first.nextPage, 0);
  assert.equal(first.records.length, 0);
  const left = await connector.fetchPage(ctx({ source: { limits: { perPage: 4 } }, checkpoint: first.checkpoint }));
  assert.equal(left.hasMore, true);
  assert.equal(left.records.length, 4);
  const page = await connector.fetchPage(ctx({ source: { limits: { perPage: 4 } }, checkpoint: left.checkpoint }));

  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.modifiedTo, '2026-10-04T12:00:00.000Z');
  assert.equal(page.checkpoint.terminalReason, 'all-date-partitions-exhausted');
  assert.equal(page.checkpoint.completedProviderRecords, 6);
  assert.equal(page.checkpoint.completedPartitionCount, 2);
  assert.equal(page.records.length, 2);
  for (const checkpoint of [first.checkpoint, left.checkpoint, page.checkpoint]) {
    assert.equal(checkpoint.modifiedFrom, '2026-09-04T00:00:00.000Z');
    assert.equal(checkpoint.modifiedTo, '2026-10-04T12:00:00.000Z');
  }
  assert.equal(requestedWindows[0].to, '2026-10-04T12:00:00Z');
  assert.equal(requestedWindows[2].to, requestedWindows[0].to);
  assert.equal(Date.parse(requestedWindows[1].to) - Date.parse(requestedWindows[2].from), 1_000);
  assert.equal(calls, 3);
});

test('trudvsem continues by splitting date ranges instead of requesting unstable offsets', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  let calls = 0;
  const requestedWindows = [];
  patchGetJson(connector, async (url) => {
    const parsed = new URL(url);
    const call = calls++;
    assert.equal(parsed.searchParams.get('offset'), '0');
    assert.equal(parsed.searchParams.get('limit'), '4');
    requestedWindows.push(`${parsed.searchParams.get('modifiedFrom')}/${parsed.searchParams.get('modifiedTo')}`);
    const count = call === 2 ? 3 : 4;
    return {
      status: '200',
      meta: { total: [10, 6, 3][call], limit: 4 },
      results: {
        vacancies: Array.from({ length: count }, (_, index) => ({ vacancy: { id: `split-${call}-${index}`, 'job-name': 'Native vacancy', vac_url: `https://trudvsem.ru/vacancy/card/123456/split-${call}-${index}` } })),
      },
    };
  });

  const first = await connector.fetchPage(ctx({ source: { limits: { perPage: 4 } } }));
  const second = await connector.fetchPage(ctx({ source: { limits: { perPage: 4 } }, checkpoint: first.checkpoint }));
  assert.equal(second.checkpoint.pendingPartitions.length, 2);
  const page = await connector.fetchPage(ctx({ source: { limits: { perPage: 4 } }, checkpoint: second.checkpoint }));

  assert.equal(page.hasMore, true);
  assert.equal(page.checkpoint.version, 4);
  assert.equal(page.checkpoint.page, 0);
  assert.equal(page.checkpoint.currentPartition.page, 0);
  assert.equal(page.checkpoint.splitCount, 2);
  assert.equal(page.checkpoint.pendingPartitions.length, 1);
  assert.equal(page.checkpoint.completedPartitionCount, 1);
  assert.equal(page.records.length, 3);
  assert.equal(new Set(requestedWindows).size, 3);
  assert.equal(page.checkpoint.modifiedTo, first.checkpoint.modifiedTo);
  assert.equal(calls, 3);
});

test('trudvsem body error is not reported as an empty success', async () => {
  const connector = new PublicApiFeedConnector('trudvsem');
  patchGetJson(connector, async () => ({ status: '500', message: 'bad request body status' }));

  await assert.rejects(() => connector.fetchPage(ctx()), /body status 500|bad request body status/);
});

test('remoteok and remotive use fixed backfillSince for local filtering', async () => {
  const remoteok = new PublicApiFeedConnector('remoteok');
  patchGetJson(remoteok, async () => [
    { id: 'old', position: 'Old', description: 'old remoteok', url: 'https://example.test/old', date: '2026-09-03T23:59:59.000Z' },
    { id: 'new', position: 'New', description: 'new remoteok', url: 'https://example.test/new', date: '2026-09-04T00:00:00.000Z' },
    { id: 'unknown', position: 'Unknown', description: 'unknown remoteok', url: 'https://example.test/unknown' },
  ]);
  const remoteokPage = await remoteok.fetchPage(ctx());
  assert.deepEqual(remoteokPage.records.map((item) => item.externalId), ['new', 'unknown']);

  const remotive = new PublicApiFeedConnector('remotive');
  patchGetJson(remotive, async () => ({
    jobs: [
      { id: 'old', title: 'Old', description: 'old remotive', url: 'https://example.test/old', publication_date: '2026-09-03T23:59:59.000Z' },
      { id: 'new', title: 'New', description: 'new remotive', url: 'https://example.test/new', publication_date: '2026-09-04T00:00:00.000Z' },
      { id: 'unknown', title: 'Unknown', description: 'unknown remotive', url: 'https://example.test/unknown' },
    ],
  }));
  const remotivePage = await remotive.fetchPage(ctx());
  assert.deepEqual(remotivePage.records.map((item) => item.externalId), ['new', 'unknown']);
});

test('hackernews freezes all observed native threads and completes direct-comment pagination', async () => {
  const connector = new PublicApiFeedConnector('hackernews_whoishiring');
  const calls = [];
  const time = value => Date.parse(value) / 1000;
  const items = new Map([
    [49922569, { id: 49922569, type: 'story', by: 'whoishiring', title: 'Ask HN: Who is hiring? (October 2026)', time: time('2026-10-01T00:00:00Z'), kids: [11, 12, 13] }],
    [49922568, { id: 49922568, type: 'story', by: 'whoishiring', title: 'Ask HN: Who wants to be hired? (October 2026)', time: time('2026-10-01T00:00:00Z'), kids: [99] }],
    [49522897, { id: 49522897, type: 'story', by: 'whoishiring', title: 'Ask HN: Who is hiring? (September 2026)', time: time('2026-09-01T00:00:00Z'), kids: [21, 22, 23] }],
    [49000000, { id: 49000000, type: 'story', by: 'whoishiring', title: 'Ask HN: Who is hiring? (August 2026)', time: time('2026-08-01T00:00:00Z'), kids: [31] }],
    [11, { id: 11, type: 'comment', by: 'a', parent: 49922569, time: time('2026-10-01T01:00:00Z'), text: 'Acme | Engineer' }],
    [12, { id: 12, type: 'comment', deleted: true }],
    [13, { id: 13, type: 'comment', dead: true }],
    [21, { id: 21, type: 'comment', parent: 49522897, time: time('2026-09-02T01:00:00Z'), text: 'Old comment outside window' }],
    [22, { id: 22, type: 'comment', parent: 49522897, time: time('2026-10-02T01:01:00Z'), text: 'Gamma | PM' }],
    [23, { id: 23, type: 'comment', parent: 49522897, time: time('2026-10-05T01:00:00Z'), text: 'After frozen upper bound' }],
    [31, { id: 31, type: 'comment', parent: 49000000, time: time('2026-08-02T01:00:00Z'), text: 'Old August post' }],
  ]);
  patchGetJson(connector, async url => {
    calls.push(url);
    if (url.endsWith('/user/whoishiring.json')) return { id: 'whoishiring', submitted: [49922569, 49922568, 49522897, 49000000] };
    return items.get(Number(url.match(/\/item\/(\d+)\.json$/)[1])) ?? null;
  });
  const first = await connector.fetchPage(ctx());
  assert.equal(first.checkpoint.phase, 'discover');
  assert.equal(first.checkpoint.submissionOffset, 2);
  assert.deepEqual(first.records, []);
  const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint, page: first.nextPage }));
  assert.equal(second.checkpoint.phase, 'comments');
  assert.deepEqual(second.checkpoint.threads.map(thread => thread.id), [49922569, 49522897, 49000000]);
  items.set(49922569, { ...items.get(49922569), kids: [999] });
  const records = [];
  let page = second;
  let pages = 0;
  while (page.hasMore) {
    assert.ok(pages++ < 10, 'finite native frontier');
    page = await connector.fetchPage(ctx({ checkpoint: page.checkpoint, page: page.nextPage }));
    records.push(...page.records);
  }
  assert.deepEqual(records.map(item => item.externalId), ['11', '22']);
  assert.equal(page.checkpoint.page, 0);
  assert.equal(page.checkpoint.phase, 'complete');
  assert.equal(page.checkpoint.threads, undefined);
  assert.equal(page.checkpoint.submittedIds, undefined);
  assert.equal(page.checkpoint.coverage.observedCommentCount, 7);
  assert.equal(page.checkpoint.coverage.processedCommentCount, 7);
  assert.equal(page.checkpoint.coverage.unavailableCommentCount, 2);
  assert.equal(page.checkpoint.coverage.excludedByWindowCount, 3);
  assert.equal(calls.filter(url => url.includes('/user/')).length, 1);
  assert.ok(!calls.some(url => url.endsWith('/item/999.json') || url.endsWith('/item/99.json')));
});

test('hackernews refuses legacy active checkpoints instead of silently resetting coverage', async () => {
  const connector = new PublicApiFeedConnector('hackernews_whoishiring');
  patchGetJson(connector, async () => { assert.fail('unsupported continuation must fail before network'); });
  await assert.rejects(() => connector.fetchPage(ctx({
    checkpoint: { hasMore: true, page: 1, threadIds: [49522897], commentRefs: [{ threadId: 49522897, id: 21 }] }, page: 1,
  })), /active checkpoint version is unsupported/);
});

test('hackernews discovery errors instead of returning false empty success', async () => {
  const connector = new PublicApiFeedConnector('hackernews_whoishiring');
  patchGetJson(connector, async url => {
    if (url.endsWith('/user/whoishiring.json')) return { id: 'whoishiring', submitted: [1, 2] };
    return { id: Number(url.match(/\/item\/(\d+)\.json$/)[1]), type: 'story', by: 'someone', title: 'Not hiring' };
  });
  await assert.rejects(() => connector.fetchPage(ctx()), /no valid Who Is Hiring threads/);
});

test('hackernews propagates submitted item fetch errors instead of silently dropping a thread', async () => {
  const connector = new PublicApiFeedConnector('hackernews_whoishiring');
  patchGetJson(connector, async url => {
    if (url.endsWith('/user/whoishiring.json')) return { id: 'whoishiring', submitted: [49922569] };
    throw new Error('intermittent Firebase failure');
  });
  await assert.rejects(() => connector.fetchPage(ctx()), /intermittent Firebase failure/);
});

test('hackernews excludes spoofed author and accepts legitimate hiring thread without kids', async () => {
  const connector = new PublicApiFeedConnector('hackernews_whoishiring');
  patchGetJson(connector, async url => {
    if (url.endsWith('/user/whoishiring.json')) return { id: 'whoishiring', submitted: [1, 2] };
    if (url.endsWith('/item/1.json')) return { id: 1, type: 'story', by: 'notwhoishiring', title: 'Ask HN: Who is hiring?', time: 1790812800, kids: [10] };
    if (url.endsWith('/item/2.json')) return { id: 2, type: 'story', by: 'whoishiring', title: 'Ask HN: Who is hiring?', time: 1790812800 };
    assert.fail('spoofed children must not be fetched');
  });
  const page = await connector.fetchPage(ctx());
  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.coverage.threadCount, 1);
  assert.equal(page.checkpoint.coverage.observedCommentCount, 0);
});
