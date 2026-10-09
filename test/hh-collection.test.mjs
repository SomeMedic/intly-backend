import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { ConnectorRateLimitError } = require('../src/modules/sources/connectors/connector.types.ts');
const { HhConnector } = require('../src/modules/sources/connectors/hh.connector.ts');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function source(overrides = {}) {
  return {
    _id: 'hh',
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

function jsonResponse(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => payload,
  };
}

function vacancy(id, publishedAt = '2026-10-04T10:00:00+0300') {
  return {
    id,
    name: `Vacancy ${id}`,
    alternate_url: `https://hh.ru/vacancy/${id}`,
    published_at: publishedAt,
    employer: { name: 'Example LLC' },
    snippet: { requirement: 'Node.js', responsibility: 'Build services' },
    salary: { from: 100000, to: 200000, currency: 'RUR', gross: true },
    area: { name: 'Москва' },
  };
}

test('HH connector pins fixed date window and per_page across durable continuation', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const page = Number(new URL(String(url)).searchParams.get('page'));
    return jsonResponse(200, {
      items: [vacancy(String(page))],
      page,
      pages: 3,
      per_page: 2,
      found: 3,
    });
  };

  const connector = new HhConnector();
  const first = await connector.fetchPage({
    source: source(),
    requestId: 'hh-window',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
  });
  const second = await connector.fetchPage({
    source: source({ limits: { perPage: 99 } }),
    requestId: 'hh-window',
    checkpoint: first.checkpoint,
    backfillDays: 1,
    backfillSince: '2026-10-04T00:00:00.000Z',
    page: first.nextPage,
  });

  const firstUrl = new URL(urls[0]);
  const secondUrl = new URL(urls[1]);
  assert.equal(firstUrl.searchParams.get('page'), '0');
  assert.equal(firstUrl.searchParams.get('per_page'), '2');
  assert.equal(firstUrl.searchParams.get('date_from'), '2026-09-04T00:00:00+0000');
  assert.match(firstUrl.searchParams.get('date_to'), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(secondUrl.searchParams.get('page'), '1');
  assert.equal(secondUrl.searchParams.get('per_page'), '2');
  assert.equal(secondUrl.searchParams.get('date_from'), firstUrl.searchParams.get('date_from'));
  assert.equal(secondUrl.searchParams.get('date_to'), firstUrl.searchParams.get('date_to'));
  assert.equal(first.hasMore, true);
  assert.equal(first.checkpoint.backfillSince, '2026-09-04T00:00:00.000Z');
  assert.equal(first.checkpoint.incomplete, undefined);
  assert.equal(first.checkpoint.limitation, undefined);
  assert.equal(second.hasMore, true);
});

test('HH connector resets terminal checkpoint but preserves observed window evidence', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return jsonResponse(200, { items: [], page: 0, pages: 1, per_page: 50, found: 0 });
  };

  const connector = new HhConnector();
  const result = await connector.fetchPage({
    source: source({ checkpoint: { page: 99, hasMore: false } }),
    requestId: 'hh-terminal',
    checkpoint: { page: 99, hasMore: false },
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
  });

  const url = new URL(urls[0]);
  assert.equal(url.searchParams.get('page'), '0');
  assert.equal(url.searchParams.get('date_from'), '2026-09-04T00:00:00+0000');
  assert.equal(url.searchParams.has('date_to'), true);
  assert.equal(result.checkpoint.page, 0);
  assert.equal(result.checkpoint.hasMore, false);
  assert.equal(result.checkpoint.backfillSince, undefined);
  assert.equal(result.checkpoint.incomplete, undefined);
  assert.equal(result.checkpoint.limitation, undefined);
  assert.equal(result.hasMore, false);
});

test('HH connector fails public search 403 with request diagnostics instead of empty success', async () => {
  globalThis.fetch = async () => jsonResponse(403, {
    errors: [{ type: 'forbidden' }],
    request_id: 'request-403',
  });

  const connector = new HhConnector();
  await assert.rejects(
    () => connector.fetchPage({ source: source(), requestId: 'hh-403', checkpoint: {}, backfillDays: 30 }),
    /HH vacancies search API returned 403.*anonymous public vacancies search.*request-403/,
  );
});

test('HH connector records official 2000-result search depth limitation at terminal boundary', async () => {
  globalThis.fetch = async (url) => {
    assert.equal(new URL(String(url)).searchParams.get('page'), '39');
    return jsonResponse(200, {
      items: [vacancy('reachable-2000')],
      page: 39,
      pages: 40,
      per_page: 50,
      found: 5000,
    });
  };

  const connector = new HhConnector();
  const result = await connector.fetchPage({
    source: source({ limits: { perPage: 50 } }),
    requestId: 'hh-cap',
    checkpoint: { hasMore: true, page: 39, perPage: 50, backfillSince: '2026-09-04T00:00:00.000Z', windowTo: '2026-10-04T00:00:00.000Z' },
    backfillDays: 30,
    page: 39,
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextPage, undefined);
  assert.equal(result.checkpoint.page, 0);
  assert.equal(result.checkpoint.hhSearchDepthLimit, 2000);
  assert.equal(result.checkpoint.hhReachableResultLimit, 2000);
  assert.equal(result.checkpoint.backfillSince, '2026-09-04T00:00:00.000Z');
  assert.equal(result.checkpoint.windowTo, '2026-10-04T00:00:00.000Z');
  assert.equal(result.checkpoint.incomplete, true);
  assert.match(result.checkpoint.limitation, /official API limits pageable search depth to 2000/);
  assert.equal(result.checkpoint.coverageLimitation, result.checkpoint.limitation);
});

test('HH connector does not continue into a page whose result range would exceed 2000', async () => {
  globalThis.fetch = async (url) => {
    assert.equal(new URL(String(url)).searchParams.get('page'), '65');
    return jsonResponse(200, {
      items: [vacancy('reachable-1980')],
      page: 65,
      pages: 80,
      per_page: 30,
      found: 2400,
    });
  };

  const connector = new HhConnector();
  const result = await connector.fetchPage({
    source: source({ limits: { perPage: 30 } }),
    requestId: 'hh-partial-cap-page',
    checkpoint: { hasMore: true, page: 65, perPage: 30, backfillSince: '2026-09-04T00:00:00.000Z', windowTo: '2026-10-04T00:00:00.000Z' },
    backfillDays: 30,
    page: 65,
  });

  assert.equal(result.hasMore, false);
  assert.equal(result.checkpoint.hhSearchDepthLimit, 2000);
  assert.equal(result.checkpoint.hhReachableResultLimit, 1980);
  assert.equal(result.checkpoint.incomplete, true);
  assert.match(result.checkpoint.limitation, /first 1980 results/);
});

test('HH connector parses retry-after HTTP date for rate limits', async () => {
  const retryAt = new Date(Date.now() + 90_000).toUTCString();
  globalThis.fetch = async () => jsonResponse(429, {}, { 'retry-after': retryAt });

  const connector = new HhConnector();
  await assert.rejects(
    () => connector.fetchPage({ source: source(), requestId: 'hh-429', checkpoint: {}, backfillDays: 30 }),
    (error) => error instanceof ConnectorRateLimitError && error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 90,
  );
});
