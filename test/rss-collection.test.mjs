import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { ConnectorRateLimitError } = require('../src/modules/sources/connectors/connector.types.ts');
const undici = require('undici');
const pinnedFetch = require('../src/modules/sources/extraction/pinned-fetch.ts');
const { RssFeedConnector } = require('../src/modules/sources/connectors/rss-feed.connector.ts');

function ctx(overrides = {}) {
  return {
    source: { name: 'WWR', timeoutMs: 1_000 },
    requestId: 'rss-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function response(body, { status = 200, contentType = 'application/rss+xml; charset=utf-8', headers = {} } = {}) {
  const normalizedHeaders = new Map(Object.entries({ 'content-type': contentType, ...headers }).map(([key, value]) => [key.toLowerCase(), value]));
  const buffer = Buffer.from(body, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return normalizedHeaders.get(name.toLowerCase()) ?? null; } },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function connector(bodyOrResponse) {
  const fetcher = async () => (typeof bodyOrResponse === 'string' ? response(bodyOrResponse) : bodyOrResponse);
  return new RssFeedConnector('weworkremotely', 'https://example.test/rss', fetcher);
}

test('rss connector treats rich description HTML as opaque text and does not parse nested HTML tags as feed XML', async () => {
  const nestedHtml = `<div>${'<section>'.repeat(180)}Deep role${'</section>'.repeat(180)}</div>`;
  const page = await connector(`<?xml version="1.0"?><rss><channel><item><guid>wwr-1</guid><title>Senior Backend</title><link>https://example.test/jobs/1</link><description>${nestedHtml}</description><pubDate>Fri, 02 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`).fetchPage(ctx());

  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].externalId, 'wwr-1');
  assert.match(page.records[0].description, /<section>/);
  assert.equal(page.records[0].sourceMetadata.feedWindow, 'finite_current_feed');
  assert.equal(page.checkpoint.feedWindow, 'finite_current_feed');
});

test('rss connector rejects HTML, unsupported APIs and rate limits truthfully instead of returning false empty collections', async () => {
  await assert.rejects(
    () => connector(response('<html><body>login</body></html>', { contentType: 'text/html' })).fetchPage(ctx()),
    /returned HTML instead of XML/,
  );

  await assert.rejects(
    () => connector(response('{"error":"forbidden"}', { contentType: 'application/json' })).fetchPage(ctx()),
    /unsupported content type application\/json/,
  );

  await assert.rejects(
    () => connector(response('slow down', { status: 429, contentType: 'text/plain', headers: { 'retry-after': '120' } })).fetchPage(ctx()),
    (error) => error instanceof ConnectorRateLimitError && error.retryAfterSeconds === 120,
  );
});

test('rss connector keeps stable record identities, skips non-record items and deduplicates duplicate feed ids', async () => {
  const oldDate = 'Fri, 01 Aug 2026 12:00:00 GMT';
  const recentDate = 'Fri, 02 Oct 2026 12:00:00 GMT';
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Missing identity</title><pubDate>${recentDate}</pubDate></item>
    <item><guid>dup</guid><title>First duplicate wins</title><link>https://example.test/a</link><pubDate>${recentDate}</pubDate></item>
    <item><guid>dup</guid><title>Second duplicate ignored</title><link>https://example.test/b</link><pubDate>${recentDate}</pubDate></item>
    <item><guid>old</guid><title>Old item</title><link>https://example.test/old</link><pubDate>${oldDate}</pubDate></item>
    <item><guid>unknown-date</guid><title>Unknown Date</title><link>https://example.test/unknown</link></item>
  </channel></rss>`;

  const page = await connector(xml).fetchPage(ctx({ backfillSince: '2026-09-15T00:00:00.000Z' }));

  assert.deepEqual(page.records.map((record) => record.externalId), ['dup', 'unknown-date']);
  assert.equal(page.records[0].title, 'First duplicate wins');
  assert.equal(page.records[1].publishedAt, undefined);
  assert.equal(page.stats.seen, 2);
});

test('rss connector treats backfillSince as a fixed run boundary across repeated fetches', async () => {
  const originalNow = Date.now;
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><guid>stable-window</guid><title>Stable Window</title><link>https://example.test/stable</link><pubDate>Tue, 15 Sep 2026 12:00:00 GMT</pubDate></item>
  </channel></rss>`;
  try {
    Date.now = () => Date.parse('2026-10-01T00:00:00.000Z');
    const first = await connector(xml).fetchPage(ctx({ backfillDays: 1, backfillSince: '2026-09-14T00:00:00.000Z' }));
    Date.now = () => Date.parse('2026-10-20T00:00:00.000Z');
    const second = await connector(xml).fetchPage(ctx({ backfillDays: 1, backfillSince: '2026-09-14T00:00:00.000Z' }));

    assert.deepEqual(first.records.map((record) => record.externalId), ['stable-window']);
    assert.deepEqual(second.records.map((record) => record.externalId), ['stable-window']);
    assert.equal(second.checkpoint.backfillSince, '2026-09-14T00:00:00.000Z');
  } finally {
    Date.now = originalNow;
  }
});



test('rss connector consumes a bounded body before closing the pinned dispatcher', async () => {
  const originalFetch = undici.fetch;
  const originalPinnedDispatcher = pinnedFetch.createPinnedDispatcher;
  let cancelled = false;
  let closed = false;
  try {
    pinnedFetch.createPinnedDispatcher = async () => ({ close: async () => { closed = true; } });
    undici.fetch = async () => new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(2_000_001));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { 'content-type': 'application/rss+xml' } });

    await assert.rejects(
      () => new RssFeedConnector('habr', 'https://example.test/rss').fetchPage(ctx()),
      /larger than the v1 safety limit/,
    );
    assert.equal(cancelled, true);
    assert.equal(closed, true);
  } finally {
    undici.fetch = originalFetch;
    pinnedFetch.createPinnedDispatcher = originalPinnedDispatcher;
  }
});

test('rss connector validates feed size and XML roots before parser work', async () => {
  await assert.rejects(
    () => connector(response('<notrss><item>bad</item></notrss>', { contentType: 'application/xml' })).fetchPage(ctx()),
    /did not return an RSS\/Atom XML document/,
  );

  const oversized = 'x'.repeat(2_000_001);
  await assert.rejects(
    () => connector(response(oversized, { contentType: 'application/rss+xml' })).fetchPage(ctx()),
    /larger than the v1 safety limit/,
  );
});
