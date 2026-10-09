import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { PublicApiFeedConnector } = require('../src/modules/sources/connectors/public-api-feed.connector.ts');

const HN_USER_URL = 'https://hacker-news.firebaseio.com/v0/user/whoishiring.json';
const BACKFILL_SINCE = '2026-09-05T00:00:00.000Z';

function source(overrides = {}) {
  return {
    _id: 'hackernews-native-test',
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
    requestId: 'hackernews-native-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: BACKFILL_SINCE,
    ...overrides,
  };
}

function unix(iso) {
  return Date.parse(iso) / 1000;
}

function story(id, overrides = {}) {
  return {
    id,
    type: 'story',
    by: 'whoishiring',
    title: 'Ask HN: Who is hiring? (October 2026)',
    time: unix('2026-10-01T00:00:00.000Z'),
    kids: [],
    ...overrides,
  };
}

function comment(id, parent, iso, overrides = {}) {
  return {
    id,
    type: 'comment',
    by: `user-${id}`,
    parent,
    time: unix(iso),
    text: `Company ${id} | Role`,
    ...overrides,
  };
}

function makeHarness({ submitted, items }) {
  const connector = new PublicApiFeedConnector('hackernews_whoishiring');
  const calls = [];
  connector.getJson = async (url) => {
    calls.push(url);
    if (url === HN_USER_URL) return { id: 'whoishiring', submitted };
    const match = url.match(/\/item\/(\d+)\.json$/);
    if (!match) throw new Error(`unexpected HN URL ${url}`);
    const id = Number(match[1]);
    if (!items.has(id)) throw new Error(`unexpected HN item ${id}`);
    return items.get(id);
  };
  return { connector, calls };
}

async function fetchWith(harness, overrides = {}) {
  return harness.connector.fetchPage(ctx(overrides));
}

async function drain(harness, options = {}) {
  const pages = [];
  let checkpoint = options.checkpoint ?? {};
  let pageNumber = options.page;
  for (let index = 0; index < 20; index += 1) {
    const page = await fetchWith(harness, { ...options, checkpoint, page: pageNumber });
    pages.push(page);
    if (!page.hasMore) return { pages, terminal: page, records: pages.flatMap((item) => item.records) };
    checkpoint = page.checkpoint;
    pageNumber = page.nextPage;
  }
  throw new Error('HN test drain exceeded page guard');
}

function itemCalls(calls, id) {
  return calls.filter((url) => url.endsWith(`/item/${id}.json`)).length;
}

function coverage(page) {
  return page.checkpoint.coverage ?? page.checkpoint;
}

function activeCheckpoint(overrides = {}) {
  return {
    version: 2,
    hasMore: true,
    page: 1,
    phase: 'comments',
    modifiedFrom: BACKFILL_SINCE,
    modifiedTo: '2026-10-05T00:00:00.000Z',
    perPage: 1,
    submittedIds: [1500],
    submissionOffset: 1,
    threads: [{ id: 1500, commentIds: [1501, 1502] }],
    threadOffset: 0,
    commentOffset: 1,
    observedCommentCount: 2,
    processedCommentCount: 1,
    acceptedCommentCount: 1,
    excludedByWindowCount: 0,
    unavailableItemCount: 0,
    unavailableCommentCount: 0,
    ...overrides,
  };
}

test('hackernews scans all submitted stories regardless of order or story age', async () => {
  const items = new Map([
    [100, story(100, { title: 'Ask HN: Who is hiring? (August 2026)', time: unix('2026-08-01T00:00:00.000Z'), kids: [1001] })],
    [200, story(200, { title: 'Not a hiring thread', kids: [2001] })],
    [300, story(300, { title: 'Ask HN: Who is hiring? (October 2026)', kids: [3001] })],
    [1001, comment(1001, 100, '2026-10-02T00:00:00.000Z')],
    [3001, comment(3001, 300, '2026-10-03T00:00:00.000Z')],
  ]);
  const harness = makeHarness({ submitted: [100, 200, 300], items });

  const result = await drain(harness, { source: { limits: { perPage: 2 } } });

  assert.deepEqual(result.records.map((record) => record.externalId).sort(), ['1001', '3001']);
  assert.equal(coverage(result.terminal).threadCount, 2);
  assert.equal(itemCalls(harness.calls, 300), 1);
});

test('hackernews resumes comments without refetching profile or thread items', async () => {
  const items = new Map([
    [500, story(500, { kids: [501, 502, 503] })],
    [501, comment(501, 500, '2026-10-02T00:00:00.000Z')],
    [502, comment(502, 500, '2026-10-02T00:01:00.000Z')],
    [503, comment(503, 500, '2026-10-02T00:02:00.000Z')],
  ]);
  const harness = makeHarness({ submitted: [500], items });

  const discovered = await fetchWith(harness, { source: { limits: { perPage: 1 } } });
  const first = await fetchWith(harness, { source: { limits: { perPage: 1 } }, checkpoint: discovered.checkpoint, page: discovered.nextPage });
  const second = await fetchWith(harness, { source: { limits: { perPage: 1 } }, checkpoint: first.checkpoint, page: first.nextPage });

  assert.deepEqual(second.records.map((record) => record.externalId), ['502']);
  assert.equal(harness.calls.filter((url) => url === HN_USER_URL).length, 1);
  assert.equal(itemCalls(harness.calls, 500), 1);
});

test('hackernews keeps the frozen comment snapshot when provider kids change later', async () => {
  const items = new Map([
    [600, story(600, { kids: [601, 602] })],
    [601, comment(601, 600, '2026-10-02T00:00:00.000Z')],
    [602, comment(602, 600, '2026-10-02T00:01:00.000Z')],
    [699, comment(699, 600, '2026-10-02T00:02:00.000Z')],
  ]);
  const harness = makeHarness({ submitted: [600], items });

  const discovered = await fetchWith(harness, { source: { limits: { perPage: 1 } } });
  const first = await fetchWith(harness, { source: { limits: { perPage: 1 } }, checkpoint: discovered.checkpoint, page: discovered.nextPage });
  items.set(600, { ...items.get(600), kids: [699] });
  const second = await fetchWith(harness, { source: { limits: { perPage: 1 } }, checkpoint: first.checkpoint, page: first.nextPage });

  assert.deepEqual(second.records.map((record) => record.externalId), ['602']);
  assert.equal(itemCalls(harness.calls, 699), 0);
});

test('hackernews filters comments by the frozen lower and upper collection window', async () => {
  const items = new Map([
    [700, story(700, { kids: [701, 702, 703] })],
    [701, comment(701, 700, '2026-09-04T23:59:59.000Z')],
    [702, comment(702, 700, '2026-10-02T00:00:00.000Z')],
    [703, comment(703, 700, '2099-01-01T00:00:00.000Z')],
  ]);
  const harness = makeHarness({ submitted: [700], items });

  const result = await drain(harness, { source: { limits: { perPage: 2 } } });

  assert.deepEqual(result.records.map((record) => record.externalId), ['702']);
  assert.equal(coverage(result.terminal).excludedByWindowCount, 2);
  assert.equal(result.pages[0].checkpoint.modifiedFrom, BACKFILL_SINCE);
  assert.equal(result.terminal.checkpoint.modifiedTo, result.pages[0].checkpoint.modifiedTo);
});

test('hackernews treats a legitimate hiring thread with empty kids as complete', async () => {
  const items = new Map([[800, story(800, { kids: [] })]]);
  const harness = makeHarness({ submitted: [800], items });

  const page = await fetchWith(harness, { source: { limits: { perPage: 2 } } });

  assert.equal(page.hasMore, false);
  assert.deepEqual(page.records, []);
  assert.equal(coverage(page).threadCount, 1);
  assert.equal(coverage(page).observedCommentCount, 0);
  assert.equal(coverage(page).terminalReason, 'all-observed-submissions-and-direct-comments-exhausted');
});

test('hackernews counts deleted dead and null comment items as unavailable', async () => {
  const items = new Map([
    [900, story(900, { kids: [901, 902, 903, 904] })],
    [901, comment(901, 900, '2026-10-02T00:00:00.000Z', { deleted: true })],
    [902, comment(902, 900, '2026-10-02T00:01:00.000Z', { dead: true })],
    [903, null],
    [904, comment(904, 900, '2026-10-02T00:02:00.000Z')],
  ]);
  const harness = makeHarness({ submitted: [900], items });

  const result = await drain(harness, { source: { limits: { perPage: 4 } } });

  assert.deepEqual(result.records.map((record) => record.externalId), ['904']);
  assert.equal(coverage(result.terminal).unavailableItemCount, 3);
  assert.equal(coverage(result.terminal).processedCommentCount, 4);
});

test('hackernews counts native comments with unavailable text as unavailable without dropping other records', async () => {
  const items = new Map([
    [46108941, story(46108941, { kids: [46113096, 46113097, 46113098] })],
    [46113096, comment(46113096, 46108941, '2026-10-02T00:00:00.000Z')],
    [46113097, { id: 46113097, kids: [46113888, 46221064, 46202403], parent: 46108941, time: 1764622573, type: 'comment' }],
    [46113098, comment(46113098, 46108941, '2026-10-02T00:02:00.000Z')],
  ]);
  const harness = makeHarness({ submitted: [46108941], items });

  const result = await drain(harness, { source: { limits: { perPage: 3 } } });

  assert.deepEqual(result.records.map((record) => record.externalId), ['46113096', '46113098']);
  assert.equal(coverage(result.terminal).unavailableItemCount, 1);
  assert.equal(coverage(result.terminal).unavailableCommentCount, 1);
  assert.equal(coverage(result.terminal).processedCommentCount, 3);
  assert.equal(coverage(result.terminal).acceptedCommentCount, 2);
});

test('hackernews rejects comments with malformed text types', async () => {
  const malformedTexts = [123, { value: 'Company' }, ['Company']];

  for (const text of malformedTexts) {
    const items = new Map([
      [46108941, story(46108941, { kids: [46113097] })],
      [46113097, { id: 46113097, parent: 46108941, time: 1764622573, type: 'comment', text }],
    ]);
    const harness = makeHarness({ submitted: [46108941], items });

    await assert.rejects(() => drain(harness, { source: { limits: { perPage: 1 } } }), /text is malformed/i);
  }
});

test('hackernews rejects item identity mismatches from the provider', async () => {
  const items = new Map([[1000, story(999, { kids: [] })]]);
  const harness = makeHarness({ submitted: [1000], items });

  await assert.rejects(() => fetchWith(harness), /identity|id/i);
});

test('hackernews rejects direct comment parent mismatches', async () => {
  const items = new Map([
    [1100, story(1100, { kids: [1101] })],
    [1101, comment(1101, 9999, '2026-10-02T00:00:00.000Z')],
  ]);
  const harness = makeHarness({ submitted: [1100], items });

  await assert.rejects(() => drain(harness), /parent|thread/i);
});

test('hackernews rejects duplicate submitted ids before item fetches', async () => {
  const items = new Map([[1200, story(1200, { kids: [] })]]);
  const harness = makeHarness({ submitted: [1200, 1200], items });

  await assert.rejects(() => fetchWith(harness), /duplicate|submitted/i);
  assert.equal(itemCalls(harness.calls, 1200), 0);
});

test('hackernews rejects malformed active checkpoints before network requests', async () => {
  const harness = makeHarness({ submitted: [1300], items: new Map([[1300, story(1300, { kids: [] })]]) });

  await assert.rejects(
    () => fetchWith(harness, { checkpoint: { version: 1, hasMore: true, page: 1, threadIds: [1300], commentRefs: [{ threadId: 1300, id: 1301 }] } }),
    /checkpoint|version/i,
  );
  assert.equal(harness.calls.length, 0);
});

test('hackernews rejects changed perPage continuation before network requests', async () => {
  const items = new Map([
    [1400, story(1400, { kids: [1401, 1402] })],
    [1401, comment(1401, 1400, '2026-10-02T00:00:00.000Z')],
    [1402, comment(1402, 1400, '2026-10-02T00:01:00.000Z')],
  ]);
  const harness = makeHarness({ submitted: [1400], items });
  const first = await fetchWith(harness, { source: { limits: { perPage: 1 } } });
  const callCount = harness.calls.length;

  await assert.rejects(() => fetchWith(harness, { source: { limits: { perPage: 2 } }, checkpoint: first.checkpoint, page: first.nextPage }), /perPage/i);
  assert.equal(harness.calls.length, callCount);
});

test('hackernews preserves continuation checkpoint when a later item request fails', async () => {
  const connector = new PublicApiFeedConnector('hackernews_whoishiring');
  const calls = [];
  connector.getJson = async (url) => {
    calls.push(url);
    if (url.endsWith('/item/1502.json')) throw new Error('intermittent Firebase failure');
    throw new Error(`unexpected HN URL ${url}`);
  };
  const checkpoint = activeCheckpoint();

  await assert.rejects(() => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } }, checkpoint, page: 1 })), /intermittent Firebase failure/);
  assert.deepEqual(checkpoint, activeCheckpoint());
  assert.deepEqual(calls, ['https://hacker-news.firebaseio.com/v0/item/1502.json']);
});

test('hackernews preserves active checkpoint when collection is already aborted', async () => {
  const connector = new PublicApiFeedConnector('hackernews_whoishiring');
  const calls = [];
  connector.getJson = async (url) => {
    calls.push(url);
    throw new Error(`unexpected HN URL ${url}`);
  };
  const checkpoint = activeCheckpoint();
  const controller = new AbortController();
  controller.abort(new Error('manual abort'));

  await assert.rejects(() => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } }, checkpoint, page: 1, signal: controller.signal })), /manual abort/);
  assert.deepEqual(checkpoint, activeCheckpoint());
  assert.deepEqual(calls, []);
});

test('hackernews rejects string hasMore checkpoints before silently restarting', async () => {
  for (const value of ['true', 'false']) {
    const harness = makeHarness({ submitted: [1600], items: new Map([[1600, story(1600, { kids: [] })]]) });

    await assert.rejects(
      () => fetchWith(harness, { checkpoint: { ...activeCheckpoint(), hasMore: value } }),
      /checkpoint|hasMore/i,
    );
    assert.deepEqual(harness.calls, []);
  }
});

test('hackernews rejects inconsistent checkpoint coverage and cursor counts before network requests', async () => {
  const cases = [
    activeCheckpoint({ processedCommentCount: 0 }),
    activeCheckpoint({ unavailableItemCount: 0, unavailableCommentCount: 1 }),
  ];

  for (const checkpoint of cases) {
    const harness = makeHarness({ submitted: [1700], items: new Map([[1700, story(1700, { kids: [] })]]) });
    await assert.rejects(() => fetchWith(harness, { source: { limits: { perPage: 1 } }, checkpoint, page: 1 }), /coverage|cursor|count/i);
    assert.deepEqual(harness.calls, []);
  }
});

test('hackernews rejects duplicate child ids observed across different threads', async () => {
  const items = new Map([
    [1800, story(1800, { kids: [1801] })],
    [1900, story(1900, { kids: [1801] })],
  ]);
  const harness = makeHarness({ submitted: [1800, 1900], items });

  await assert.rejects(() => fetchWith(harness, { source: { limits: { perPage: 2 } } }), /duplicate|cyclic/i);
});

test('hackernews limits concurrent item requests to four during discovery and comments', async () => {
  const submitted = Array.from({ length: 10 }, (_, index) => 2000 + index);
  const items = new Map();
  for (const id of submitted) {
    items.set(id, story(id, { kids: [id + 1000] }));
    items.set(id + 1000, comment(id + 1000, id, '2026-10-02T00:00:00.000Z'));
  }
  const connector = new PublicApiFeedConnector('hackernews_whoishiring');
  const calls = [];
  let active = 0;
  let maxActive = 0;
  connector.getJson = async (url) => {
    calls.push(url);
    if (url === HN_USER_URL) return { id: 'whoishiring', submitted };
    const match = url.match(/\/item\/(\d+)\.json$/);
    assert.ok(match, `unexpected HN URL ${url}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return items.get(Number(match[1]));
  };

  const discovered = await connector.fetchPage(ctx({ source: { limits: { perPage: 10 } } }));
  const page = await connector.fetchPage(ctx({ source: { limits: { perPage: 10 } }, checkpoint: discovered.checkpoint, page: discovered.nextPage }));

  assert.equal(page.records.length, 10);
  assert.equal(maxActive, 4);
  assert.equal(calls.filter((url) => /\/item\/\d+\.json$/.test(url)).length, 20);
});
