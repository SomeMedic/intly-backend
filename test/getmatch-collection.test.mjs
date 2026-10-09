import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { GetmatchConnector } = require('../src/modules/sources/connectors/getmatch.connector.ts');

function source(overrides = {}) {
  return {
    _id: 'getmatch',
    name: 'GetMatch',
    enabled: true,
    runtimeState: 'Enabled',
    checkpoint: {},
    connectorFamily: 'OfficialRestApi',
    endpoint: { baseUrl: 'https://getmatch.ru' },
    config: {},
    limits: { perPage: 5 },
    timeoutMs: 30_000,
    opportunityTypes: ['vacancy'],
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    source: source(overrides.source),
    requestId: 'getmatch-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T10:55:00.123Z',
    ...overrides,
  };
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    body: Buffer.from(JSON.stringify(payload), 'utf8'),
  };
}

function rawResponse(body, status = 200, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    body: Buffer.from(body, 'utf8'),
  };
}

function offer(id, overrides = {}) {
  return {
    id,
    published_at: '2026-10-04T09:00:42.572323',
    is_active: true,
    position: `Offer ${id}`,
    offer_type: 'vacancy',
    source: 'hh_import',
    url: `/vacancies/${id}-offer`,
    salary_description: '100 000 — 200 000 ₽/мес до налогов',
    salary_hidden: false,
    salary_display_from: 100000,
    salary_display_to: 200000,
    salary_currency: 'RUB',
    salary_taxes: 'gross',
    salary_is_total: false,
    offer_description: '',
    description_html: null,
    skills_objects: [{ name: 'TypeScript', slug: 'typescript' }],
    location_items: [{ label: 'Москва', format: 'hybrid', exclude: false }],
    company: { name: 'Acme', short_description: '<p>Company text</p>' },
    seniorities: ['middle'],
    specialization: 'Backend',
    required_years_of_experience: 3,
    ...overrides,
  };
}

function detail(id, overrides = {}) {
  return offer(id, {
    description: '<h2>Main description</h2>',
    short_description: '<p>Short description</p>',
    stack_description: '<p>Stack description</p>',
    offer_description: '<b>Offer description</b>',
    ...overrides,
  });
}

test('getmatch fetches all list offers including observed promos and advances by meta.limit, not returned offer count', async () => {
  const calls = [];
  const connector = new GetmatchConnector(async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') {
      assert.equal(parsed.searchParams.get('offset'), '0');
      assert.equal(parsed.searchParams.get('limit'), '50');
      assert.equal(parsed.searchParams.get('pa'), 'all');
      assert.equal(parsed.searchParams.has('from_date'), false);
      assert.equal(parsed.searchParams.has('to_date'), false);
      const offers = Array.from({ length: 53 }, (_, index) => offer(index + 1, index < 3 ? { offer_type: 'one_day_offer_v3' } : {}));
      return response({ meta: { total: 913, offset: 0, limit: 50 }, offers });
    }
    const id = parsed.pathname.match(/\/api\/offers\/(\d+)$/)?.[1];
    return response(detail(Number(id)));
  });

  const page = await connector.fetchPage(ctx({ source: { limits: { perPage: 50 } } }));

  assert.equal(page.records.length, 53);
  assert.deepEqual(page.records.slice(0, 3).map((record) => record.sourceMetadata.offerType), ['one_day_offer_v3', 'one_day_offer_v3', 'one_day_offer_v3']);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextPage, 50);
  assert.equal(page.checkpoint.offset, 50);
  assert.equal(page.checkpoint.total, 913);
  assert.deepEqual(page.checkpoint.visitedOffsets, [0]);
  assert.equal(page.checkpoint.seenIds.length, 53);
  assert.equal(page.checkpoint.hasMore, true);
  assert.equal(calls.filter((url) => new URL(url).pathname.startsWith('/api/offers/')).length, 53);
});

test('getmatch continuation keeps fixed windowTo/backfillSince on terminal checkpoint and resets offset', async () => {
  const connector = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') {
      assert.equal(parsed.searchParams.get('offset'), '5');
      assert.equal(parsed.searchParams.get('pa'), 'all');
      return response({ meta: { total: 8, offset: 5, limit: 5 }, offers: [offer(9)] });
    }
    return response(detail(9));
  });

  const page = await connector.fetchPage(ctx({ checkpoint: { hasMore: true, offset: 5, limit: 5, windowTo: '2026-10-04T12:00:00.000Z', backfillSince: '2026-09-04T10:55:00.123Z' }, backfillSince: '2026-10-01T00:00:00.000Z', page: 5 }));

  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.offset, 0);
  assert.equal(page.checkpoint.hasMore, false);
  assert.equal(page.checkpoint.windowTo, '2026-10-04T12:00:00.000Z');
  assert.equal(page.checkpoint.backfillSince, '2026-09-04T10:55:00.123Z');
  assert.equal(page.checkpoint.limit, 5);
  assert.equal(page.checkpoint.total, 8);
  assert.deepEqual(page.checkpoint.visitedOffsets, [5]);
  assert.deepEqual(page.checkpoint.seenIds, ['9']);
});

test('getmatch detail provides full text when list description is empty', async () => {
  const connector = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') {
      return response({ meta: { total: 1, offset: 0, limit: 5 }, offers: [offer(36103, { description_html: null, offer_description: '' })] });
    }
    return response(detail(36103));
  });

  const page = await connector.fetchPage(ctx());
  const record = page.records[0];

  assert.match(record.description, /Main description/);
  assert.match(record.description, /Short description/);
  assert.match(record.description, /Stack description/);
  assert.match(record.description, /Offer description/);
  assert.deepEqual(record.sourceMetadata.detailTextSources.slice(0, 4), ['description', 'short_description', 'stack_description', 'offer_description']);
});

test('getmatch decodes native detail text entities once and removes executable markup', async () => {
  const connector = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') {
      return response({ meta: { total: 1, offset: 0, limit: 5 }, offers: [offer(777, { description_html: null, offer_description: '' })] });
    }
    return response(detail(777, {
      description: '<p>Alpha&emsp;Beta &amp; C</p><script>bad()</script><style>.x{}</style><p>Gamma&#8195;Delta</p>',
      short_description: 'Literal escaped ampersand: &amp;emsp;',
      stack_description: '<ul><li>Node&nbsp;22</li><li>TypeScript&#x2F;Nest</li></ul>',
      offer_description: '<div>Salary &lt; 5000 and quoted &quot;text&quot;</div>',
    }));
  });

  const page = await connector.fetchPage(ctx());
  const record = page.records[0];

  assert.equal(record.rawPayload.description.includes('&emsp;'), true);
  assert.match(record.description, /Alpha Beta & C\n\nGamma Delta/);
  assert.match(record.description, /Literal escaped ampersand: &emsp;/);
  assert.match(record.description, /Node 22\n\nTypeScript\/Nest/);
  assert.match(record.description, /Salary < 5000 and quoted "text"/);
  assert.doesNotMatch(record.description, /bad\(\)|\.x\{\}|<p>|<script>|&amp; C|&#8195;|&emsp;Beta/);
});

test('getmatch deduplicates repeated list ids and propagates detail failures before checkpoint', async () => {
  let detailCalls = 0;
  const connector = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') {
      return response({ meta: { total: 2, offset: 0, limit: 5 }, offers: [offer(1), offer(1)] });
    }
    detailCalls += 1;
    return response({ error: 'temporary' }, 503);
  });

  await assert.rejects(() => connector.fetchPage(ctx()), /GetMatch API returned 503/);
  assert.equal(detailCalls, 1);
});

test('getmatch keeps naive boundary day conservatively and filters explicitly zoned timestamps exactly', async () => {
  const connector = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') {
      return response({
        meta: { total: 5, offset: 0, limit: 5 },
        offers: [
          offer(1, { published_at: '2026-09-03T23:59:59.999999' }),
          offer(2, { published_at: '2026-09-04T10:55:00.123000' }),
          offer(3, { published_at: undefined }),
          offer(4, { published_at: '2026-09-04T10:55:00.122Z' }),
          offer(5, { published_at: '2026-08-20T12:00:00.000000' }),
        ],
      });
    }
    const id = Number(parsed.pathname.match(/\/api\/offers\/(\d+)$/)?.[1]);
    return response(detail(id, { published_at: id === 2 ? '2026-08-20T12:00:00.000000' : id === 4 ? '2026-09-04T10:55:00.122Z' : id === 5 ? '2026-08-20T12:00:00.000000' : undefined }));
  });

  const page = await connector.fetchPage(ctx());

  assert.deepEqual(page.records.map((record) => record.externalId), ['1', '3']);
  assert.equal(page.records[0].publishedAt, undefined);
  assert.equal(page.records[0].sourceMetadata.publishedAtRaw, '2026-09-03T23:59:59.999999');
  assert.equal(page.records[0].sourceMetadata.publishedAtTimezone, 'unspecified');
});

test('getmatch filters future explicit timestamps against fixed windowTo and stores zoned publishedAt', async () => {
  const connector = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') {
      return response({
        meta: { total: 2, offset: 0, limit: 5 },
        offers: [
          offer(6, { published_at: '2026-10-04T10:55:00.000Z' }),
          offer(7, { published_at: '2026-10-05T00:00:00.000Z' }),
        ],
      });
    }
    const id = Number(parsed.pathname.match(/\/api\/offers\/(\d+)$/)?.[1]);
    return response(detail(id, { published_at: id === 6 ? '2026-10-04T10:55:00.000Z' : '2026-10-05T00:00:00.000Z' }));
  });

  const page = await connector.fetchPage(ctx({ checkpoint: { hasMore: true, offset: 0, limit: 5, windowTo: '2026-10-04T12:00:00.000Z', backfillSince: '2026-09-04T10:55:00.123Z' }, page: 0 }));

  assert.deepEqual(page.records.map((record) => record.externalId), ['6']);
  assert.equal(page.records[0].publishedAt.toISOString(), '2026-10-04T10:55:00.000Z');
  assert.equal(page.records[0].sourceMetadata.publishedAtTimezone, 'specified');
});

test('getmatch continuation uses checkpoint backfillSince even when context changes', async () => {
  const connector = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') {
      assert.equal(parsed.searchParams.get('offset'), '5');
      return response({ meta: { total: 15, offset: 5, limit: 5 }, offers: [offer(1), offer(2), offer(8, { published_at: '2026-09-05T00:00:00.000000' })] });
    }
    return response(detail(8, { published_at: '2026-09-05T00:00:00.000000' }));
  });

  const page = await connector.fetchPage(ctx({
    checkpoint: { hasMore: true, offset: 5, limit: 5, windowTo: '2026-10-04T12:00:00.000Z', backfillSince: '2026-09-04T10:55:00.123Z', visitedOffsets: [0], seenIds: ['1', '2'] },
    backfillSince: '2026-09-20T00:00:00.000Z',
    page: 5,
  }));

  assert.deepEqual(page.records.map((record) => record.externalId), ['8']);
  assert.equal(page.hasMore, true);
  assert.equal(page.checkpoint.backfillSince, '2026-09-04T10:55:00.123Z');
  assert.equal(page.checkpoint.windowTo, '2026-10-04T12:00:00.000Z');
  assert.deepEqual(page.checkpoint.visitedOffsets, [0, 5]);
  assert.deepEqual(page.checkpoint.seenIds, ['1', '2', '8']);
});

test('getmatch preserves salary, company, location, skills and seniority public fields', async () => {
  const connector = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') {
      return response({ meta: { total: 1, offset: 0, limit: 5 }, offers: [offer(10)] });
    }
    return response(detail(10, { company: { name: 'MAGNIT TECH', industry: 'Продуктовая компания', size: '1001+' }, seniority: 'middle+' }));
  });

  const page = await connector.fetchPage(ctx());
  const metadata = page.records[0].sourceMetadata;

  assert.equal(page.records[0].companyOrClient, 'MAGNIT TECH');
  assert.equal(metadata.salary.min, 100000);
  assert.equal(metadata.salary.max, 200000);
  assert.equal(metadata.salary.taxes, 'gross');
  assert.deepEqual(metadata.locations, [{ label: 'Москва', format: 'hybrid', exclude: false }]);
  assert.deepEqual(metadata.skills, ['TypeScript']);
  assert.equal(metadata.seniority, 'middle');
});

test('getmatch validates config without fake catalog dependencies and reports anonymous public access', async () => {
  const connector = new GetmatchConnector(async () => response({ meta: { total: 0, offset: 0, limit: 5 }, offers: [] }));

  const validation = await connector.validateConfig({});
  const health = await connector.healthCheck(ctx({ source: { limits: { perPage: 5 } } }));

  assert.equal(validation.ok, true);
  assert.equal(validation.details.auth, 'anonymous-public');
  assert.equal(health.state, 'Healthy');
});

test('getmatch rejects unsupported searchText instead of sending unverified query params', async () => {
  const connector = new GetmatchConnector(async () => response({ meta: { total: 0, offset: 0, limit: 5 }, offers: [] }));

  await assert.rejects(() => connector.fetchPage(ctx({ source: { config: { searchText: 'python' } } })), /searchText is not supported/);
});

test('getmatch rejects malformed list payloads and continuation mismatches', async () => {
  const malformed = new GetmatchConnector(async () => response({ offers: [] }));
  await assert.rejects(() => malformed.fetchPage(ctx()), /missing meta/);

  const offsetMismatch = new GetmatchConnector(async () => response({ meta: { total: 10, offset: 1, limit: 5 }, offers: [] }));
  await assert.rejects(() => offsetMismatch.fetchPage(ctx()), /does not match requested offset/);

  const pageMismatch = new GetmatchConnector(async () => response({ meta: { total: 10, offset: 5, limit: 5 }, offers: [] }));
  await assert.rejects(() => pageMismatch.fetchPage(ctx({ checkpoint: { hasMore: true, offset: 5, limit: 5 }, page: 0 })), /does not match checkpoint offset/);

  const emptyBeforeTotal = new GetmatchConnector(async () => response({ meta: { total: 10, offset: 5, limit: 5 }, offers: [] }));
  await assert.rejects(() => emptyBeforeTotal.fetchPage(ctx({ checkpoint: { hasMore: true, offset: 5, limit: 5, windowTo: '2026-10-04T12:00:00.000Z', backfillSince: '2026-09-04T10:55:00.123Z' }, page: 5 })), /empty offers before observed total/);

  const repeatedOffset = new GetmatchConnector(async () => response({ meta: { total: 10, offset: 5, limit: 5 }, offers: [offer(6)] }));
  await assert.rejects(() => repeatedOffset.fetchPage(ctx({ checkpoint: { hasMore: true, offset: 5, limit: 5, visitedOffsets: [5], windowTo: '2026-10-04T12:00:00.000Z', backfillSince: '2026-09-04T10:55:00.123Z' }, page: 5 })), /repeated offset/);

  const repeatedIds = new GetmatchConnector(async () => response({ meta: { total: 10, offset: 5, limit: 5 }, offers: [offer(1), offer(2)] }));
  await assert.rejects(() => repeatedIds.fetchPage(ctx({ checkpoint: { hasMore: true, offset: 5, limit: 5, seenIds: ['1', '2'], windowTo: '2026-10-04T12:00:00.000Z', backfillSince: '2026-09-04T10:55:00.123Z' }, page: 5 })), /repeated all offer ids/);
});



test('getmatch uses max observed total when provider total shrinks on continuation', async () => {
  const connector = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') {
      assert.equal(parsed.searchParams.get('offset'), '50');
      return response({ meta: { total: 0, offset: 50, limit: 50 }, offers: [offer(51)] });
    }
    return response(detail(51));
  });

  const page = await connector.fetchPage(ctx({
    checkpoint: {
      hasMore: true,
      offset: 50,
      limit: 50,
      initialObservedTotal: 913,
      maxObservedTotal: 913,
      total: 913,
      visitedOffsets: [0],
      seenIds: Array.from({ length: 50 }, (_, index) => String(index + 1)),
      windowTo: '2026-10-04T12:00:00.000Z',
      backfillSince: '2026-09-04T10:55:00.123Z',
    },
    page: 50,
  }));

  assert.equal(page.hasMore, true);
  assert.equal(page.nextPage, 100);
  assert.equal(page.checkpoint.offset, 100);
  assert.equal(page.checkpoint.total, 0);
  assert.equal(page.checkpoint.initialObservedTotal, 913);
  assert.equal(page.checkpoint.maxObservedTotal, 913);
  assert.deepEqual(page.records.map((record) => record.externalId), ['51']);
});

test('getmatch fails continuation when frozen window bounds are missing or invalid', async () => {
  const connector = new GetmatchConnector(async () => response({ meta: { total: 10, offset: 5, limit: 5 }, offers: [offer(6)] }));

  await assert.rejects(
    () => connector.fetchPage(ctx({ checkpoint: { hasMore: true, offset: 5, limit: 5, windowTo: '2026-10-04T12:00:00.000Z' }, page: 5 })),
    /missing fixed backfillSince/,
  );
  await assert.rejects(
    () => connector.fetchPage(ctx({ checkpoint: { hasMore: true, offset: 5, limit: 5, backfillSince: '2026-09-04T10:55:00.123Z' }, page: 5 })),
    /missing fixed windowTo/,
  );
});

test('getmatch rejects malformed details and unsafe public vacancy URLs', async () => {
  const wrongId = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') return response({ meta: { total: 1, offset: 0, limit: 5 }, offers: [offer(1)] });
    return response(detail(2));
  });
  await assert.rejects(() => wrongId.fetchPage(ctx()), /does not match list id/);

  const unsafeUrl = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') return response({ meta: { total: 1, offset: 0, limit: 5 }, offers: [offer(1)] });
    return response(detail(1, { url: 'javascript:alert(1)' }));
  });
  await assert.rejects(() => unsafeUrl.fetchPage(ctx()), /unsafe vacancy URL/);

  const missingDescription = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') return response({ meta: { total: 1, offset: 0, limit: 5 }, offers: [offer(1, { description: '<p>List text must not mask detail</p>' })] });
    return response({ ...offer(1), description: '', short_description: '', stack_description: '', offer_description: '', description_html: '' });
  });
  await assert.rejects(() => missingDescription.fetchPage(ctx()), /missing opportunity description/);

  const missingId = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') return response({ meta: { total: 1, offset: 0, limit: 5 }, offers: [offer(1)] });
    return response({ ...detail(1), id: undefined });
  });
  await assert.rejects(() => missingId.fetchPage(ctx()), /detail id missing/);

  const credentialUrl = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') return response({ meta: { total: 1, offset: 0, limit: 5 }, offers: [offer(1)] });
    return response(detail(1, { url: 'https://user:pass@getmatch.ru/vacancies/1-offer#fragment' }));
  });
  await assert.rejects(() => credentialUrl.fetchPage(ctx()), /unsafe vacancy URL/);

  const missingSlug = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') return response({ meta: { total: 1, offset: 0, limit: 5 }, offers: [offer(1)] });
    return response(detail(1, { url: 'https://getmatch.ru/vacancies/1-' }));
  });
  await assert.rejects(() => missingSlug.fetchPage(ctx()), /unsafe vacancy URL/);
});

test('getmatch derives promo semantic text from structured one-day content', async () => {
  const connector = new GetmatchConnector(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/offers') return response({ meta: { total: 1, offset: 0, limit: 5 }, offers: [offer(99, { offer_type: 'one_day_offer_v3' })] });
    return response(offer(99, {
      offer_type: 'one_day_offer_v3',
      offer_description: '',
      description: '',
      short_description: '',
      stack_description: '',
      one_day_offer_content_v3: { schedule: { header: 'Как пройдёт мероприятие', items: [{ header: 'Подайте заявку', text: 'Мы ответим в течение трёх дней' }] } },
    }));
  });

  const page = await connector.fetchPage(ctx());

  assert.match(page.records[0].description, /Как пройдёт мероприятие/);
  assert.match(page.records[0].description, /Подайте заявку/);
});

test('getmatch rejects non-json responses and parses numeric or date Retry-After safely', async () => {
  const nonJson = new GetmatchConnector(async () => rawResponse('<html></html>', 200, 'text/html'));
  await assert.rejects(() => nonJson.fetchPage(ctx()), /non-JSON/);

  const numeric = new GetmatchConnector(async () => ({ ok: false, status: 429, headers: { get: () => '7' }, body: Buffer.alloc(0) }));
  await assert.rejects(async () => {
    try {
      await numeric.fetchPage(ctx());
    } catch (error) {
      assert.equal(error.retryAfterSeconds, 7);
      throw error;
    }
  }, /rate limit/);

  const future = new Date(Date.now() + 5_000).toUTCString();
  const dated = new GetmatchConnector(async () => ({ ok: false, status: 429, headers: { get: () => future }, body: Buffer.alloc(0) }));
  await assert.rejects(async () => {
    try {
      await dated.fetchPage(ctx());
    } catch (error) {
      assert.ok(error.retryAfterSeconds >= 1);
      assert.ok(Number.isFinite(error.retryAfterSeconds));
      throw error;
    }
  }, /rate limit/);
});

test('getmatch ignores unsafe endpoint overrides and only calls public offers API paths', async () => {
  const called = [];
  const connector = new GetmatchConnector(async (url) => {
    called.push(url);
    assert.equal(new URL(url).origin, 'https://getmatch.ru');
    assert.match(new URL(url).pathname, /^\/api\/offers/);
    if (new URL(url).pathname === '/api/offers') {
      return response({ meta: { total: 0, offset: 0, limit: 5 }, offers: [] });
    }
    return response({});
  });

  const page = await connector.fetchPage(ctx({ source: { endpoint: { baseUrl: 'http://127.0.0.1/private' }, limits: { perPage: 5 } } }));

  assert.equal(page.records.length, 0);
  assert.equal(called.length, 1);
});
