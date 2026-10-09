import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { AtsPublicBoardConnector } = require('../src/modules/sources/connectors/ats-public-board.connector.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');
const fixtures = new URL('./fixtures/personio/', import.meta.url);
const native = await readFile(new URL('codecentric-native-live.xml', fixtures), 'utf8');
const open = await readFile(new URL('open-native-live.xml', fixtures), 'utf8');

function context(tenants = ['codecentric.jobs.personio.com'], overrides = {}) {
  return {
    source: { _id: 'personio', name: 'Personio', connectorFamily: 'AtsPublicBoard', group: 'web', config: { tenants }, limits: { maxTenantsPerRun: 1 }, timeoutMs: 1000 },
    requestId: 'personio-regression', checkpoint: {}, backfillDays: 30, ...overrides,
  };
}

async function withFetch(handler, action) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await action(); } finally { globalThis.fetch = original; }
}

function xmlPosition(fields = '') {
  return `<workzag-jobs><position><id>123</id><name>Platform Engineer</name>${fields}</position></workzag-jobs>`;
}

test('Personio reads all observed native workzag-jobs positions with canonical individual URLs and full fields', async () => {
  await withFetch(async (url) => {
    assert.equal(String(url), 'https://codecentric.jobs.personio.com/xml');
    return new Response(native);
  }, async () => {
    const page = await new AtsPublicBoardConnector('personio').fetchPage(context());
    assert.equal(page.records.length, 17);
    assert.equal(new Set(page.records.map(record => record.externalId)).size, 17);
    assert.equal(page.hasMore, false);
    assert.equal(page.checkpoint.hasMore, false);
    assert.ok(page.records.every(record => record.description.length > 500));
    const first = page.records[0];
    assert.equal(first.externalId, 'codecentric.jobs.personio.com:2544098');
    assert.equal(first.url, 'https://codecentric.jobs.personio.com/job/2544098');
    assert.equal(first.companyOrClient, 'codecentric AG');
    assert.equal(first.publishedAt.toISOString(), '2026-02-25T13:29:40.000Z');
    assert.equal(first.sourceMetadata.sourceDateField, 'createdAt');
    const normalized = new SourceNormalizerService().normalize(context().source, first);
    assert.match(normalized.location, /München/);
    assert.match(normalized.location, /Frankfurt/);
    assert.equal(normalized.remoteType, 'Hybrid');
    assert.equal(normalized.employmentType, 'full-time, permanent');
    assert.equal(normalized.seniority, 'experienced');
    assert.ok(normalized.skills.includes('Key Account Management'));
    assert.deepEqual(first.rawPayload.additionalOffices.office, first.sourceMetadata.locations.slice(1));
    assert.doesNotMatch(first.description, /<p\b|<li\b|<!\[CDATA/);
    assert.equal(first.rawPayload.id, '2544098');
  });
});

test('Personio preserves full long descriptions, entities, native timestamps and distinct section headings', async () => {
  await withFetch(async () => new Response(open), async () => {
    const page = await new AtsPublicBoardConnector('personio').fetchPage(context(['open.jobs.personio.com']));
    assert.equal(page.records.length, 6);
    assert.match(page.records[0].description, /About &Open/);
    assert.match(page.records[0].description, /Enterprise Account Manager/);
    assert.ok(page.records[0].description.length > 4000);
    assert.match(page.records[0].description, /\n- /);
    const recent = page.records.filter(item => item.publishedAt >= new Date('2026-09-04T00:00:00Z'));
    assert.equal(recent.length, 2);
    assert.ok(recent.some(item => item.externalId.endsWith(':2825498')));
    assert.ok(recent.some(item => item.externalId.endsWith(':2815366')));
  });
});

test('Personio retains the final paragraph in descriptions exceeding the old extraction excerpt size', async () => {
  const text = 'Maintain reliable distributed systems. '.repeat(300);
  const body = xmlPosition(`<jobDescriptions><jobDescription><name>Responsibilities</name><value><![CDATA[<p>${text}</p><p>Final public application details remain visible.</p>]]></value></jobDescription></jobDescriptions>`);
  await withFetch(async () => new Response(body), async () => {
    const page = await new AtsPublicBoardConnector('personio').fetchPage(context());
    assert.ok(page.records[0].description.length > 10000);
    assert.match(page.records[0].description, /Final public application details remain visible\.$/);
  });
});

test('Personio discovery validates real XML feed structure and reports actual complete feed count', async () => {
  await withFetch(async (url) => String(url).endsWith('/xml') ? new Response(open) : new Response('<html>Careers</html>'), async () => {
    const ctx = context();
    ctx.source.config = { discoveryUrls: ['https://open.jobs.personio.com/'] };
    const result = await new AtsPublicBoardConnector('personio').discover(ctx);
    assert.equal(result.ok, true);
    assert.deepEqual(result.details.tenants, ['open.jobs.personio.com']);
    assert.equal(result.details.discovered[0].probe.records, 6);
  });
});

test('Personio health reflects current public feed responses and missing configuration', async () => {
  const connector = new AtsPublicBoardConnector('personio');
  await withFetch(async (url) => String(url).includes('codecentric') ? new Response(native) : new Response('', { status: 404 }), async () => {
    const healthy = await connector.healthCheck(context());
    assert.equal(healthy.state, 'Healthy');
    assert.equal(healthy.details.probes[0].records, 17);
    const degraded = await connector.healthCheck(context(['codecentric.jobs.personio.com', 'open.jobs.personio.com']));
    assert.equal(degraded.state, 'Degraded');
    assert.equal(degraded.details.probes.filter(probe => !probe.ok).length, 1);
    const missing = await connector.healthCheck(context([]));
    assert.equal(missing.state, 'Failed');
    assert.match(missing.message, /requires discovered/);
  });
});

test('Personio never accepts arbitrary hosts, IPs, URLs or marketing redirect bodies as feed success', async () => {
  const connector = new AtsPublicBoardConnector('personio');
  for (const host of ['careers.example.com', '127.0.0.1', 'https://open.jobs.personio.com', 'open.jobs.personio.com.evil.test', 'open.extra.jobs.personio.com']) {
    assert.equal((await connector.validateConfig({ tenants: [host] })).ok, false);
  }
  await withFetch(async () => new Response('', { status: 302, headers: { Location: 'https://www.personio.com' } }), async () => {
    await assert.rejects(() => connector.fetchPage(context()), /redirected outside its public XML feed/);
  });
  for (const body of ['<html><body>Marketing</body></html>', '<workzag-jobs><position>', '<!DOCTYPE workzag-jobs [<!ENTITY x SYSTEM "file:///etc/passwd">]><workzag-jobs/>']) {
    await withFetch(async () => new Response(body), async () => {
      await assert.rejects(() => connector.fetchPage(context()), /unexpected XML|malformed XML|declarations are unsupported/);
    });
  }
});

test('Personio accepts a safe same-company .de to .com XML redirect and a true empty feed', async () => {
  let requests = 0;
  await withFetch(async (url) => {
    requests += 1;
    return String(url).includes('.de/')
      ? new Response('', { status: 301, headers: { Location: 'https://open.jobs.personio.com/xml' } })
      : new Response('<workzag-jobs/>');
  }, async () => {
    const page = await new AtsPublicBoardConnector('personio').fetchPage(context(['open.jobs.personio.de']));
    assert.equal(requests, 2);
    assert.deepEqual(page.records, []);
    assert.equal(page.hasMore, false);
  });
});

test('Personio preserves unknown dates and absent source descriptions without placeholder data', async () => {
  await withFetch(async () => new Response(xmlPosition('<office>Berlin</office><createdAt>unknown</createdAt><jobDescriptions/>')), async () => {
    const page = await new AtsPublicBoardConnector('personio').fetchPage(context());
    assert.equal(page.records[0].publishedAt, undefined);
    assert.equal(page.records[0].description, '');
    assert.equal(page.records[0].sourceMetadata.descriptionAvailable, false);
    assert.equal(page.records[0].sourceMetadata.schedule, undefined);
  });
});

test('Personio rejects missing stable ids and unsafe detail links instead of inventing records', async () => {
  for (const body of ['<workzag-jobs><position><name>Engineer</name></position></workzag-jobs>', xmlPosition('<jobUrl>https://evil.test/job/123</jobUrl>')]) {
    await withFetch(async () => new Response(body), async () => {
      await assert.rejects(() => new AtsPublicBoardConnector('personio').fetchPage(context()), /missing its stable id|unexpected job URL/);
    });
  }
});

test('ATS page failure keeps the entire tenant batch retryable and never silently skips a failed board', async () => {
  const ctx = context(['open.jobs.personio.com', 'codecentric.jobs.personio.com']);
  ctx.source.limits.maxTenantsPerRun = 2;
  let failing = true;
  const connector = new AtsPublicBoardConnector('personio');
  await withFetch(async (url) => String(url).includes('codecentric') && failing ? new Response('', { status: 503 }) : new Response(open), async () => {
    await assert.rejects(() => connector.fetchPage(ctx), /returned 503/);
    assert.deepEqual(ctx.checkpoint, {});
    failing = false;
    const retried = await connector.fetchPage(ctx);
    assert.equal(retried.records.length, 12);
    assert.equal(retried.hasMore, false);
  });
});

test('ATS resumed tenant cycle freezes its upper window and detects changed configured hosts', async () => {
  const connector = new AtsPublicBoardConnector('personio');
  const ctx = context(['open.jobs.personio.com', 'codecentric.jobs.personio.com']);
  const body = xmlPosition('<createdAt>2099-01-01T00:00:00Z</createdAt>');
  await withFetch(async () => new Response(body), async () => {
    const first = await connector.fetchPage(ctx);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.records, []);
    const second = await connector.fetchPage({ ...ctx, checkpoint: first.checkpoint });
    assert.equal(second.hasMore, false);
    assert.equal(second.checkpoint.windowTo, first.checkpoint.windowTo);
    const changed = context(['open.jobs.personio.com', 'other.jobs.personio.com'], { checkpoint: first.checkpoint });
    await assert.rejects(() => connector.fetchPage(changed), /tenant catalog changed/);
  });
});

test('Personio fetch propagates cancellation through its XML request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled source collection'));
  await withFetch(async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw options.signal.reason;
  }, async () => {
    await assert.rejects(() => new AtsPublicBoardConnector('personio').fetchPage(context(undefined, { signal: controller.signal })), /cancelled source collection/);
  });
});
