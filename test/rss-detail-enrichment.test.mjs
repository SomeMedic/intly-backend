import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { RssFeedConnector } = require('../src/modules/sources/connectors/rss-feed.connector.ts');

function ctx(overrides = {}) {
  return {
    source: { _id: 'habr', name: 'Habr Career', timeoutMs: 1_000 },
    requestId: 'rss-detail-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function response(body, { status = 200, contentType = 'application/rss+xml; charset=utf-8' } = {}) {
  const buffer = Buffer.from(body, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? contentType : null; } },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function feed(items) {
  return `<?xml version="1.0"?><rss><channel>${items.join('\n')}</channel></rss>`;
}

function item({ guid = 'feed-guid-1', title = 'Feed preview title', link = 'https://career.habr.com/vacancies/1000168348', description = 'Short preview', encoded, pubDate = 'Fri, 02 Oct 2026 12:00:00 GMT' } = {}) {
  return `<item><guid>${guid}</guid><title>${title}</title><link>${link}</link>${encoded ? `<content:encoded><![CDATA[${encoded}]]></content:encoded>` : ''}<description><![CDATA[${description}]]></description><pubDate>${pubDate}</pubDate></item>`;
}

function connector(xml, extraction, id = 'habr', url = 'https://career.habr.com/vacancies/rss') {
  const fetcher = async () => response(xml);
  return new RssFeedConnector(id, url, fetcher, extraction);
}

test('rss detail enrichment uses verified detail fields while preserving original feed identity, date and raw audit data', async () => {
  const calls = [];
  const extraction = {
    async extractOpportunityFromUrl(url, options) {
      calls.push({ url, options });
      return {
        externalId: 'detail-hash-must-not-win',
        url,
        type: 'vacancy',
        title: 'Senior Platform Engineer',
        companyOrClient: 'Verified Company',
        description: 'Full public detail body with responsibilities and requirements.',
        publishedAt: new Date('2026-10-04T00:00:00.000Z'),
        sourceStatus: 'Active',
        rawPayload: { url, jsonLd: { '@type': 'JobPosting', title: 'Senior Platform Engineer' } },
        sourceMetadata: { extraction: 'http-html', salary: { min: 1000, currency: 'USD' }, skills: ['TypeScript'] },
      };
    },
  };

  const page = await connector(feed([item({ encoded: 'Full encoded feed content', description: 'Short description' })]), extraction).fetchPage(ctx());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://career.habr.com/vacancies/1000168348');
  assert.deepEqual(calls[0].options.allowedHosts, ['career.habr.com']);
  assert.equal(calls[0].options.requireOpportunitySignal, true);
  assert.equal(page.records.length, 1);
  const record = page.records[0];
  assert.equal(record.externalId, 'feed-guid-1');
  assert.equal(record.title, 'Senior Platform Engineer');
  assert.equal(record.companyOrClient, 'Verified Company');
  assert.match(record.description, /Full public detail body/);
  assert.equal(record.publishedAt.toISOString(), '2026-10-02T12:00:00.000Z');
  assert.equal(record.sourceStatus, 'Active');
  assert.equal(record.rawPayload.feed.guid, 'feed-guid-1');
  assert.equal(record.rawPayload.feed['content:encoded'], '<![CDATA[Full encoded feed content]]>');
  assert.equal(record.rawPayload.feedDescription, 'Full encoded feed content');
  assert.equal(record.rawPayload.detail.jsonLd.title, 'Senior Platform Engineer');
  assert.equal(record.rawPayload.originalFeedExternalId, 'feed-guid-1');
  assert.equal(record.sourceMetadata.feedWindow, 'finite_current_feed');
  assert.equal(record.sourceMetadata.feedUrl, 'https://career.habr.com/vacancies/rss');
  assert.equal(record.sourceMetadata.descriptionCoverage, 'detail-full');
  assert.deepEqual(record.sourceMetadata.salary, { min: 1000, currency: 'USD' });
  assert.equal(page.stats.seen, 1);
});

test('rss detail enrichment validates host and concrete URL shape before any detail network call', async () => {
  let called = false;
  const extraction = { async extractOpportunityFromUrl() { called = true; throw new Error('should not call detail extraction'); } };

  await assert.rejects(
    () => connector(feed([item({ link: 'https://evil.example/vacancies/1000168348' })]), extraction).fetchPage(ctx()),
    /outside the allowed feed host/,
  );
  assert.equal(called, false);

  await assert.rejects(
    () => connector(feed([item({ link: 'https://career.habr.com/users/1000168348' })]), extraction).fetchPage(ctx()),
    /canonical Habr vacancy URL/,
  );
  assert.equal(called, false);
});

test('rss detail enrichment propagates detail failures instead of returning partial successful preview records', async () => {
  const extraction = {
    async extractOpportunityFromUrl(url) {
      if (url.endsWith('/1000168348')) throw new Error('URL returned HTTP 403');
      return {
        externalId: 'second-detail',
        url,
        type: 'vacancy',
        title: 'Second full detail',
        companyOrClient: 'Second Company',
        description: 'Second full body',
        sourceStatus: 'Active',
        rawPayload: { url },
        sourceMetadata: { extraction: 'http-html' },
      };
    },
  };

  await assert.rejects(
    () => connector(feed([
      item({ guid: 'first', link: 'https://career.habr.com/vacancies/1000168348' }),
      item({ guid: 'second', link: 'https://career.habr.com/vacancies/1000168349' }),
    ]), extraction).fetchPage(ctx()),
    /URL returned HTTP 403/,
  );
});

test('rss detail enrichment supports WWR concrete remote job URLs and rejects non-job paths', async () => {
  const extraction = {
    async extractOpportunityFromUrl(url) {
      return {
        externalId: 'wwr-detail',
        url,
        type: 'vacancy',
        title: 'Senior Research Engineer',
        companyOrClient: 'AssemblyAI',
        description: 'Full WWR detail body',
        sourceStatus: 'Active',
        rawPayload: { url },
        sourceMetadata: { extraction: 'http-html', area: 'Remote' },
      };
    },
  };
  const wwrCtx = ctx({ source: { _id: 'weworkremotely', name: 'We Work Remotely', timeoutMs: 1_000 } });

  const page = await connector(
    feed([item({ guid: 'wwr-guid', link: 'https://weworkremotely.com/remote-jobs/assemblyai-senior-research-engineer' })]),
    extraction,
    'weworkremotely',
    'https://weworkremotely.com/remote-jobs.rss',
  ).fetchPage(wwrCtx);

  assert.equal(page.records[0].externalId, 'wwr-guid');
  assert.equal(page.records[0].companyOrClient, 'AssemblyAI');
  assert.equal(page.records[0].sourceMetadata.area, 'Remote');

  await assert.rejects(
    () => connector(
      feed([item({ guid: 'bad-wwr', link: 'https://weworkremotely.com/categories/remote-programming-jobs' })]),
      extraction,
      'weworkremotely',
      'https://weworkremotely.com/remote-jobs.rss',
    ).fetchPage(wwrCtx),
    /canonical We Work Remotely job URL/,
  );
});

test('rss enrichment rejects insecure origins and detail redirects to another job', async () => {
  for (const link of ['http://career.habr.com/vacancies/1000168348', 'https://career.habr.com:8443/vacancies/1000168348']) {
    let calls = 0;
    await assert.rejects(connector(feed([item({ link })]), { async extractOpportunityFromUrl() { calls++; } }).fetchPage(ctx()), /outside the allowed feed host/);
    assert.equal(calls, 0);
  }
  await assert.rejects(connector(feed([item()]), { async extractOpportunityFromUrl() { return { url: 'https://career.habr.com/vacancies/999999' }; } }).fetchPage(ctx()), /different vacancy/);
});

test('Habr explicitly declared skills and qualification reach canonical source metadata without guessing prose', async () => {
  const extraction = {
    async extractOpportunityFromUrl(url) {
      return {
        url, externalId: 'detail', title: 'Backend developer', companyOrClient: 'Company',
        description: 'Навыки: Java, Java Spring Framework, .NET, Java. Квалификация: Senior. Специализации: Бэкенд разработчик.\nПолное описание работы.',
        rawPayload: { jsonLd: { description: 'Original source body' } }, sourceMetadata: {},
      };
    },
  };
  const page = await connector(feed([item()]), extraction).fetchPage(ctx());
  assert.deepEqual(page.records[0].sourceMetadata.skills, ['Java', 'Java Spring Framework', '.NET']);
  assert.equal(page.records[0].sourceMetadata.seniority, 'Senior');
  extraction.extractOpportunityFromUrl = async (url) => ({ url, title: 'Developer', description: 'Навыки: Oracle, Oracle PL/SQL, Git. Специализации: Разработчик баз данных.\nПолное описание работы.', rawPayload: {}, sourceMetadata: {} });
  const withoutQualification = await connector(feed([item()]), extraction).fetchPage(ctx());
  assert.deepEqual(withoutQualification.records[0].sourceMetadata.skills, ['Oracle', 'Oracle PL/SQL', 'Git']);
  assert.equal(withoutQualification.records[0].sourceMetadata.seniority, undefined);
  assert.equal(page.records[0].rawPayload.detail.jsonLd.description, 'Original source body');
  extraction.extractOpportunityFromUrl = async (url) => ({ url, title: 'Developer', description: 'We discuss skills and qualifications with every candidate.', rawPayload: {}, sourceMetadata: {} });
  const unstructured = await connector(feed([item()]), extraction).fetchPage(ctx());
  assert.equal(unstructured.records[0].sourceMetadata.skills, undefined);
  assert.equal(unstructured.records[0].sourceMetadata.seniority, undefined);
});

test('rss enrichment passes cancellation and waits for started workers before rejecting a failed page', async () => {
  const signal = new AbortController().signal;
  const calls = [];
  let finishInflight;
  const inflight = new Promise((resolve) => { finishInflight = resolve; });
  const extraction = {
    async extractOpportunityFromUrl(url, options) {
      calls.push(url);
      assert.equal(options.signal, signal);
      if (url.endsWith('/1000168348')) throw new Error('detail failed');
      await inflight;
      return { url, externalId: url, title: 'Full job', description: 'Full body', rawPayload: {}, sourceMetadata: {} };
    },
  };
  const xml = feed(Array.from({ length: 8 }, (_, index) => item({ guid: `job-${index}`, link: `https://career.habr.com/vacancies/${1000168348 + index}` })));
  let settled = false;
  const result = connector(xml, extraction).fetchPage(ctx({ signal })).catch((error) => { settled = true; return error; });
  while (calls.length < 4) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(calls.length, 4);
  finishInflight();
  assert.match((await result).message, /detail failed/);
  assert.equal(calls.length, 4);
});
