import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
const testDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(testDir, '..');
process.env.TS_NODE_PROJECT = resolve(backendDir, 'tsconfig.json');

const require = createRequire(import.meta.url);
require('../node_modules/ts-node/register/transpile-only');

const { WeWorkRemotelyConnector } = require('../src/modules/sources/connectors/weworkremotely.connector.ts');
const { RssFeedConnector } = require('../src/modules/sources/connectors/rss-feed.connector.ts');
const { WebExtractionHttpError } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

const fixtureDir = resolve(backendDir, 'test/fixtures/wwr-catalog');
const fixedNow = Date.parse('2026-10-05T00:00:00.000Z');
const oldDateNow = Date.now;
Date.now = () => fixedNow;

function fixture(name) {
  return readFileSync(resolve(fixtureDir, name), 'utf8');
}

const fullCatalogFixtures = new Map([
  ['https://weworkremotely.com/', 'home.html'],
  ['https://weworkremotely.com/categories/remote-sales-and-marketing-jobs', 'sales.html'],
  ['https://weworkremotely.com/categories/remote-back-end-programming-jobs', 'backend.html'],
  ['https://weworkremotely.com/categories/all-other-remote-jobs', 'other.html'],
  ['https://weworkremotely.com/remote-jobs/acme-account-executive', 'detail-acme.html'],
  ['https://weworkremotely.com/remote-jobs/headway-content-marketing', 'detail-headway.html'],
  ['https://weworkremotely.com/remote-jobs/reddit-backend-engineer-iam', 'detail-reddit.html'],
  ['https://weworkremotely.com/remote-jobs/dataannotation-ai-prompt-engineering', 'detail-dataannotation.html'],
]);

function source(overrides = {}) {
  return {
    _id: 'weworkremotely',
    name: 'We Work Remotely',
    timeoutMs: 1_000,
    endpoint: { baseUrl: 'https://weworkremotely.com/' },
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    source: source(),
    requestId: 'wwr-catalog-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

class FakeExtraction {
  constructor(fixtures = fullCatalogFixtures, options = {}) {
    this.fixtures = fixtures;
    this.options = options;
    this.calls = [];
  }

  async extractUrl(inputUrl) {
    const url = new URL(inputUrl, 'https://weworkremotely.com/').toString().replace(/\/$/, inputUrl === 'https://weworkremotely.com/' ? '/' : '');
    this.calls.push(url);
    if (this.options.throwFor?.has(url)) throw this.options.throwFor.get(url);
    const name = this.fixtures.get(url);
    if (!name) throw new Error(`missing fixture for ${url}`);
    const finalUrl = this.options.redirects?.get(url) ?? url;
    return { finalUrl, html: fixture(name), metadata: {} };
  }
}

class FakeRssFallback {
  constructor(page, name = 'rss') {
    this.page = page;
    this.name = name;
    this.fetchCalls = 0;
    this.healthCalls = 0;
  }

  async fetchPage() {
    this.fetchCalls += 1;
    return this.page;
  }

  async healthCheck() {
    this.healthCalls += 1;
    return { state: 'Healthy', message: `${this.name} ok`, checkedAt: new Date(fixedNow) };
  }
}

function rssResponse(body) {
  const buffer = Buffer.from(body, 'utf8');
  return {
    ok: true,
    status: 200,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? 'application/rss+xml; charset=utf-8' : null; } },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

async function drain(connector, baseCtx) {
  const records = [];
  let current = { ...baseCtx, checkpoint: baseCtx.checkpoint ?? {} };
  let page;
  for (let i = 0; i < 40; i += 1) {
    page = await connector.fetchPage(current);
    records.push(...page.records);
    if (!page.hasMore) return { ...page, records };
    current = { ...baseCtx, checkpoint: page.checkpoint };
  }
  throw new Error('drain exceeded iteration guard');
}

function nativeWindow() {
  return { since: '2026-09-05T00:00:00.000Z', until: new Date(fixedNow).toISOString(), sinceDate: new Date('2026-09-05T00:00:00.000Z'), untilDate: new Date(fixedNow) };
}

function byExternalId(page, url) {
  const record = page.records.find((item) => item.externalId === url);
  assert.ok(record, `record ${url} should exist`);
  return record;
}

test.after(() => {
  Date.now = oldDateNow;
});

test('collects discovered category catalog, dedupes overlaps, fetches full detail fields, and preserves RSS-compatible externalId URLs', async () => {
  const extraction = new FakeExtraction();
  const page = await drain(new WeWorkRemotelyConnector(extraction), ctx());

  assert.equal(page.hasMore, false);
  assert.equal(page.records.length, 4);
  assert.equal(page.checkpoint.terminalReason, 'html-catalog-frontier-exhausted');
  assert.equal(page.checkpoint.homepageCount, 4);
  assert.equal(page.checkpoint.discoveredCategories, 3);
  assert.equal(page.checkpoint.uniqueSeen, 4);
  assert.equal(page.checkpoint.retained, 4);
  assert.equal(page.checkpoint.unknownDateCount, 0);
  assert.equal(page.checkpoint.catalogComplete, true);
  assert.ok(page.checkpoint.approximateDateCount > 0);
  assert.equal(page.checkpoint.fullWindowCompletenessProven, false);
  assert.equal(page.checkpoint.windowIncompleteReason, 'approximate_dates');
  assert.ok(page.checkpoint.categoryUrls.includes('https://weworkremotely.com/categories/all-other-remote-jobs'));

  const redditUrl = 'https://weworkremotely.com/remote-jobs/reddit-backend-engineer-iam';
  const reddit = byExternalId(page, redditUrl);
  assert.equal(reddit.url, redditUrl);
  assert.equal(reddit.title, 'Backend Engineer, IAM');
  assert.equal(reddit.companyOrClient, 'Reddit');
  assert.match(reddit.description, /Reddit is a community of communities/);
  assert.match(reddit.description, /base salary range for this position/);
  assert.match(reddit.description, /\$164,200—\$229,900 USD/);
  assert.equal(reddit.sourceMetadata.nativeSalaryText, '$164,200—$229,900 USD');
  assert.deepEqual(reddit.sourceMetadata.salary, { min: 164200, max: 229900, currency: 'USD', originalText: '$164,200—$229,900 USD' });
  assert.equal(reddit.sourceMetadata.deadlineAt, '2026-10-14T23:59:59.000Z');
  assert.equal(reddit.sourceMetadata.nativeType, 'Full-Time');
  assert.equal(reddit.sourceMetadata.nativeCategory, 'Back-End Programming');
  assert.equal(reddit.sourceMetadata.nativeRegion, 'Anywhere in the World');
  assert.equal(reddit.sourceMetadata.remoteType, 'remote');

  const acme = byExternalId(page, 'https://weworkremotely.com/remote-jobs/acme-account-executive');
  assert.equal(acme.sourceMetadata.nativeSalaryText, '$100,000 or more USD');
  assert.deepEqual(acme.sourceMetadata.salary, { min: 100000, currency: 'USD', originalText: '$100,000 or more USD' });

  const other = byExternalId(page, 'https://weworkremotely.com/remote-jobs/dataannotation-ai-prompt-engineering');
  assert.equal(other.sourceMetadata.nativeCategory, 'All Other');
  assert.equal(other.sourceMetadata.nativeRegion, 'North America Only');
  assert.equal(other.sourceMetadata.nativeType, 'Contract');

  assert.equal(extraction.calls.filter((item) => item === 'https://weworkremotely.com/remote-jobs/acme-account-executive').length, 1);
});

test('traverses observed next controls, filters known dates to the fixed window, and records actual seen versus retained counts', async () => {
  const fixtures = new Map([
    ['https://weworkremotely.com/', 'home-single-sales.html'],
    ['https://weworkremotely.com/categories/remote-sales-and-marketing-jobs', 'sales-with-next.html'],
    ['https://weworkremotely.com/categories/remote-sales-and-marketing-jobs?page=2', 'sales-page-2.html'],
    ['https://weworkremotely.com/remote-jobs/acme-account-executive', 'detail-acme.html'],
    ['https://weworkremotely.com/remote-jobs/late-sales-role', 'detail-late.html'],
    ['https://weworkremotely.com/remote-jobs/ancient-sales-role', 'detail-ancient.html'],
  ]);
  const extraction = new FakeExtraction(fixtures);

  const page = await drain(new WeWorkRemotelyConnector(extraction), ctx());

  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.homepageCount, 3);
  assert.equal(page.checkpoint.uniqueSeen, 3);
  assert.equal(page.checkpoint.retained, 2);
  assert.ok(page.checkpoint.categories[0].visitedUrls.includes('https://weworkremotely.com/categories/remote-sales-and-marketing-jobs?page=2'));
  assert.deepEqual(page.records.map((item) => item.externalId).sort(), [
    'https://weworkremotely.com/remote-jobs/acme-account-executive',
    'https://weworkremotely.com/remote-jobs/late-sales-role',
  ]);
});



test('bounds HTML work by perPage and resumes frozen detail/category frontier without refetching all categories', async () => {
  const extraction = new FakeExtraction();
  const connector = new WeWorkRemotelyConnector(extraction);
  const first = await connector.fetchPage(ctx({ source: source({ limits: { perPage: 1 } }) }));
  assert.equal(first.records.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.checkpoint.perPage, 1);
  assert.ok(first.checkpoint.detailQueue.length <= 1);
  assert.ok(extraction.calls.includes('https://weworkremotely.com/categories/remote-sales-and-marketing-jobs'));
  assert.ok(!extraction.calls.includes('https://weworkremotely.com/categories/remote-back-end-programming-jobs'));

  const beforeSecond = extraction.calls.length;
  const second = await connector.fetchPage(ctx({ source: source({ limits: { perPage: 1 } }), checkpoint: first.checkpoint }));
  assert.equal(second.records.length, 1);
  assert.equal(second.hasMore, true);
  assert.equal(extraction.calls.filter((item) => item === 'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs').length, 1);
  assert.ok(extraction.calls.length > beforeSecond);
});

test('finished HTML and RSS windows stay terminal on retry and collect afresh for a new polling window', async () => {
  const extraction = new FakeExtraction();
  const htmlConnector = new WeWorkRemotelyConnector(extraction);
  const terminal = await drain(htmlConnector, ctx());
  const callsBeforeRetry = extraction.calls.length;
  const retry = await htmlConnector.fetchPage(ctx({ checkpoint: terminal.checkpoint }));
  assert.deepEqual(retry.records, []);
  assert.equal(retry.hasMore, false);
  assert.equal(extraction.calls.length, callsBeforeRetry);
  const fresh = await drain(htmlConnector, ctx({ checkpoint: terminal.checkpoint, backfillSince: '2026-09-06T00:00:00.000Z' }));
  assert.equal(fresh.records.length, 4);
  assert.equal(fresh.checkpoint.backfillSince, '2026-09-06T00:00:00.000Z');
  assert.equal(extraction.calls.filter(url => url === 'https://weworkremotely.com/').length, 2);

  const blocked = new FakeExtraction(fullCatalogFixtures, { throwFor: new Map([['https://weworkremotely.com/', new WebExtractionHttpError(403, 'https://weworkremotely.com/')]]) });
  const rss = new FakeRssFallback({ records: [], hasMore: false, checkpoint: {}, stats: { seen: 0 } });
  const rssConnector = new WeWorkRemotelyConnector(blocked, [rss]);
  const rssTerminal = await rssConnector.fetchPage(ctx());
  assert.equal(rssTerminal.hasMore, false);
  await rssConnector.fetchPage(ctx({ checkpoint: rssTerminal.checkpoint }));
  assert.equal(rss.fetchCalls, 1);
  Date.now = () => fixedNow + 60_000;
  try {
    const freshRss = await rssConnector.fetchPage(ctx({ checkpoint: rssTerminal.checkpoint, backfillSince: '2026-09-06T00:00:00.000Z' }));
    assert.equal(rss.fetchCalls, 2);
    assert.equal(blocked.calls.length, 2);
    assert.equal(freshRss.checkpoint.windowUntil, new Date(fixedNow + 60_000).toISOString());
    assert.equal(freshRss.checkpoint.backfillSince, '2026-09-06T00:00:00.000Z');
  } finally {
    Date.now = () => fixedNow;
  }
});

test('reports incomplete instead of claiming full catalog when counts or dates are not provable', async () => {
  const fixtures = new Map(fullCatalogFixtures);
  fixtures.set('https://weworkremotely.com/', 'home-count-mismatch.html');
  const mismatch = await drain(new WeWorkRemotelyConnector(new FakeExtraction(fixtures)), ctx());
  assert.equal(mismatch.hasMore, false);
  assert.equal(mismatch.checkpoint.terminalReason, 'html-catalog-frontier-exhausted-incomplete');
  assert.equal(mismatch.checkpoint.incompleteReason, 'homepage_count_reconciliation');
  assert.equal(mismatch.checkpoint.catalogComplete, false);
  assert.equal(mismatch.checkpoint.fullWindowCompletenessProven, false);

  const unknownFixtures = new Map([
    ['https://weworkremotely.com/', 'home-unknown-date.html'],
    ['https://weworkremotely.com/categories/remote-sales-and-marketing-jobs', 'sales-unknown-date.html'],
    ['https://weworkremotely.com/remote-jobs/unknown-date-role', 'detail-unknown-date.html'],
  ]);
  const unknown = await drain(new WeWorkRemotelyConnector(new FakeExtraction(unknownFixtures)), ctx());
  assert.equal(unknown.hasMore, false);
  assert.equal(unknown.checkpoint.incompleteReason, 'unknown_dates');
  assert.equal(unknown.checkpoint.unknownDateCount, 1);
  assert.equal(unknown.records.length, 1);
});

test('uses bounded category RSS fallback only when initial homepage HTML access fails before catalog progress exists', async () => {
  const firstRssPage = {
    records: [
      { externalId: 'https://weworkremotely.com/remote-jobs/rss-1', url: 'https://weworkremotely.com/remote-jobs/rss-1', type: 'vacancy', title: 'RSS role', description: '<p>Salary $120,000—$150,000 USD</p>', sourceStatus: 'Unknown', rawPayload: {}, sourceMetadata: {} },
      { externalId: 'https://weworkremotely.com/remote-jobs/duplicate', url: 'https://weworkremotely.com/remote-jobs/duplicate', type: 'vacancy', title: 'Duplicate', sourceStatus: 'Unknown', rawPayload: {}, sourceMetadata: {} },
    ],
    checkpoint: { terminalReason: 'finite-feed-exhausted', retained: 2 },
    hasMore: false,
    stats: { seen: 2 },
  };
  const secondRssPage = {
    records: [
      { externalId: 'https://weworkremotely.com/remote-jobs/duplicate', url: 'https://weworkremotely.com/remote-jobs/duplicate', type: 'vacancy', title: 'Duplicate again', sourceStatus: 'Unknown', rawPayload: {}, sourceMetadata: {} },
      { externalId: 'https://weworkremotely.com/remote-jobs/rss-2', url: 'https://weworkremotely.com/remote-jobs/rss-2', type: 'vacancy', title: 'RSS role 2', sourceStatus: 'Unknown', rawPayload: {}, sourceMetadata: {} },
    ],
    checkpoint: { terminalReason: 'finite-feed-exhausted', retained: 2 },
    hasMore: false,
    stats: { seen: 2 },
  };
  const rssOne = new FakeRssFallback(firstRssPage, 'rss one');
  const rssTwo = new FakeRssFallback(secondRssPage, 'rss two');
  const rss = [rssOne, rssTwo];
  const error = new WebExtractionHttpError(403, 'https://weworkremotely.com/', { accessReason: 'bot_challenge' });
  const extraction = new FakeExtraction(fullCatalogFixtures, { throwFor: new Map([['https://weworkremotely.com/', error]]) });

  const page = await new WeWorkRemotelyConnector(extraction, rss).fetchPage(ctx());

  assert.equal(rssOne.fetchCalls, 1);
  assert.equal(rssTwo.fetchCalls, 0);
  assert.equal(page.records.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.checkpoint.collectionScope, 'finite-category-feed-fallback');
  assert.equal(page.checkpoint.catalogComplete, false);
  assert.equal(page.checkpoint.fullWindowCompletenessProven, false);
  assert.equal(page.checkpoint.accessReason, 'http_403');
  assert.equal(page.checkpoint.terminalReason, undefined);
  assert.equal(page.checkpoint.feedCount, 2);
  assert.equal(page.checkpoint.feedIndex, 1);
  assert.equal(page.checkpoint.seen, 2);
  assert.equal(page.checkpoint.uniqueSeen, 2);
  assert.equal(page.records.find((item) => item.externalId === 'https://weworkremotely.com/remote-jobs/rss-1').sourceMetadata.nativeSalaryText, '$120,000—$150,000 USD');

  const finalFallback = await new WeWorkRemotelyConnector(extraction, rss).fetchPage(ctx({ checkpoint: page.checkpoint }));
  assert.equal(rssTwo.fetchCalls, 1);
  assert.equal(finalFallback.hasMore, false);
  assert.equal(finalFallback.checkpoint.terminalReason, 'finite-category-feed-fallback-exhausted');
  assert.equal(finalFallback.records.length, 1);

  const categoryError = new WebExtractionHttpError(403, 'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs', { accessReason: 'bot_challenge' });
  const progressedExtraction = new FakeExtraction(fullCatalogFixtures, { throwFor: new Map([['https://weworkremotely.com/categories/remote-sales-and-marketing-jobs', categoryError]]) });
  await assert.rejects(
    () => new WeWorkRemotelyConnector(progressedExtraction, rss).fetchPage(ctx({ checkpoint: { mode: 'wwr-public-html-catalog', categories: [{ url: 'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs', label: 'Sales' }], backfillSince: '2026-09-05T00:00:00.000Z', windowUntil: new Date(fixedNow).toISOString(), hasMore: true } })),
    /HTTP 403|bot challenge/i,
  );
  assert.equal(rssOne.fetchCalls, 1);
  assert.equal(rssTwo.fetchCalls, 1);
});







test('native job card parser stays inside .jobs sections and excludes nav/post-job anchors', async () => {
  const connector = new WeWorkRemotelyConnector(new FakeExtraction());
  const window = nativeWindow();
  const html = `<!doctype html><body>
    <nav><a href="/remote-jobs/new">Post a job</a></nav>
    <section class="listing-ad jobs"><a href="/remote-jobs/ad-not-a-job">Ad</a></section>
    <section class="jobs promoted-jobs"><ul><li><a href="/remote-jobs/real-homepage-job">Real Homepage Job New RealCo HQ: Remote Full-Time Anywhere in the World</a></li></ul></section>
    <main><a href="/remote-jobs/outside-jobs-section">Outside job-shaped anchor New</a></main>
  </body>`;
  const discovered = connector.discoverCategories(`<a href="/categories/remote-sales-and-marketing-jobs">Sales and Marketing</a>${html}`, 'https://weworkremotely.com/', window);
  assert.deepEqual(discovered.homepageCards.map((item) => item.externalId), ['https://weworkremotely.com/remote-jobs/real-homepage-job']);
});

test('parses corrected native browser DOM fixtures for category discovery, category job cards, and malformed JSON-LD detail fallback', async () => {
  const connector = new WeWorkRemotelyConnector(new FakeExtraction());
  const homepage = connector.discoverCategories(fixture('native-homepage.html'), 'https://weworkremotely.com/', nativeWindow());
  assert.equal(homepage.homepageCount, 310);
  assert.equal(homepage.categories.length, 12);
  assert.ok(homepage.categories.some((item) => item.url === 'https://weworkremotely.com/categories/all-other-remote-jobs'));
  assert.ok(!homepage.categories.some((item) => item.url === 'https://weworkremotely.com/categories/remote-other-jobs'));
  assert.ok(homepage.homepageCards.some((item) => item.externalId === 'https://weworkremotely.com/remote-jobs/toptal-client-advisor'));
  assert.ok(homepage.homepageCards.some((item) => item.externalId === 'https://weworkremotely.com/remote-jobs/toptal-enterprise-sales-development-representative'));

  const fullStack = connector.parseCategory(
    fixture('native-remote-full-stack-programming-jobs.html'),
    'https://weworkremotely.com/categories/remote-full-stack-programming-jobs',
    { url: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs', label: 'Full-Stack Programming' },
    nativeWindow(),
  );
  assert.equal(fullStack.cards.length, 41);
  assert.equal(fullStack.unparsedPaginationControl, false);

  const other = connector.parseCategory(
    fixture('native-all-other-remote-jobs.html'),
    'https://weworkremotely.com/categories/all-other-remote-jobs',
    { url: 'https://weworkremotely.com/categories/all-other-remote-jobs', label: 'All Other' },
    nativeWindow(),
  );
  assert.equal(other.cards.length, 66);
  assert.equal(other.unparsedPaginationControl, false);

  const reddit = connector.parseDetail(
    fixture('native-reddit-backend-engineer-iam.html'),
    'https://weworkremotely.com/remote-jobs/reddit-backend-engineer-iam',
    { url: 'https://weworkremotely.com/remote-jobs/reddit-backend-engineer-iam', externalId: 'https://weworkremotely.com/remote-jobs/reddit-backend-engineer-iam', title: '', rawText: '', categoryUrl: 'https://weworkremotely.com/categories/remote-back-end-programming-jobs', categoryLabel: 'Back-End Programming' },
    nativeWindow(),
  );
  assert.equal(reddit.title, 'Backend Engineer, IAM');
  assert.equal(reddit.company, 'Reddit');
  assert.equal(reddit.salaryText, '$164,200—$229,900 USD');
  assert.deepEqual(reddit.money, { min: 164200, max: 229900, currency: 'USD' });
  assert.equal(reddit.category, 'Back-End Programming');
  assert.equal(reddit.employment, 'Full-Time');
  assert.equal(reddit.region, 'Anywhere in the World');
});



test('RSS fallback propagates feed failures and health is failed when fallback is unusable', async () => {
  const error = new WebExtractionHttpError(403, 'https://weworkremotely.com/', { accessReason: 'bot_challenge' });
  const extraction = new FakeExtraction(fullCatalogFixtures, { throwFor: new Map([['https://weworkremotely.com/', error]]) });
  const failingRss = {
    async fetchPage() { throw new Error('rss unavailable'); },
    async healthCheck() { return { state: 'Failed', message: 'rss unavailable', checkedAt: new Date(fixedNow) }; },
  };
  await assert.rejects(() => new WeWorkRemotelyConnector(extraction, failingRss).fetchPage(ctx()), /rss unavailable/);
  const health = await new WeWorkRemotelyConnector(extraction, failingRss).healthCheck(ctx());
  assert.equal(health.state, 'Failed');
  assert.match(health.message, /fallback is Failed|fallback failed|unavailable/);
});

test('finite category RSS fallback can consume grounded official category feed fixtures without global-feed scope claims', async () => {
  const error = new WebExtractionHttpError(403, 'https://weworkremotely.com/', { accessReason: 'bot_challenge' });
  const extraction = new FakeExtraction(fullCatalogFixtures, { throwFor: new Map([['https://weworkremotely.com/', error]]) });
  const feeds = [
    new RssFeedConnector('weworkremotely', 'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss', async () => rssResponse(fixture('remote-sales-and-marketing-jobs.rss.xml'))),
    new RssFeedConnector('weworkremotely', 'https://weworkremotely.com/categories/all-other-remote-jobs.rss', async () => rssResponse(fixture('all-other-remote-jobs.rss.xml'))),
  ];

  const first = await new WeWorkRemotelyConnector(extraction, feeds).fetchPage(ctx());
  const page = await new WeWorkRemotelyConnector(extraction, feeds).fetchPage(ctx({ checkpoint: first.checkpoint }));

  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.collectionScope, 'finite-category-feed-fallback');
  assert.equal(page.checkpoint.catalogComplete, false);
  assert.equal(page.checkpoint.fullWindowCompletenessProven, false);
  assert.equal(page.checkpoint.feedCount, 2);
  assert.ok(first.records.length + page.records.length > 100);
  assert.equal(new Set([...first.records, ...page.records].map((item) => item.externalId)).size, first.records.length + page.records.length);
  assert.ok([...first.records, ...page.records].some((item) => item.externalId.includes('/remote-jobs/')));
});



test('normalizer consumes WWR salary metadata as canonical money fields', async () => {
  const page = await drain(new WeWorkRemotelyConnector(new FakeExtraction()), ctx());
  const reddit = byExternalId(page, 'https://weworkremotely.com/remote-jobs/reddit-backend-engineer-iam');
  const normalized = new SourceNormalizerService().normalize({ _id: 'weworkremotely', name: 'We Work Remotely', connectorFamily: 'PublicHtml', group: 'web' }, reddit);
  assert.deepEqual(normalized.money, { originalText: '$164,200—$229,900 USD', min: 164200, max: 229900, currency: 'USD' });
});

test('native Reddit RSS salary markup retains both bounds through fallback and normalization', async () => {
  const error = new WebExtractionHttpError(403, 'https://weworkremotely.com/', { accessReason: 'bot_challenge' });
  const extraction = new FakeExtraction(fullCatalogFixtures, { throwFor: new Map([['https://weworkremotely.com/', error]]) });
  const feedUrl = 'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss';
  const feed = new RssFeedConnector('weworkremotely', feedUrl, async () => rssResponse(fixture('remote-back-end-programming-jobs.rss.xml')));
  const page = await new WeWorkRemotelyConnector(extraction, [feed]).fetchPage(ctx());
  const reddit = byExternalId(page, 'https://weworkremotely.com/remote-jobs/reddit-backend-engineer-iam');
  const normalized = new SourceNormalizerService().normalize({ ...source(), connectorFamily: 'PublicHtml', group: 'web' }, reddit);
  assert.deepEqual(normalized.money, { min: 164200, max: 229900, currency: 'USD', originalText: '$164,200—$229,900 USD' });
  assert.equal(reddit.publishedAt.toISOString(), '2026-09-14T07:31:07.000Z');
  assert.match(reddit.description, /<span>\$164,200<\/span>/);
  assert.equal(page.checkpoint.fullWindowCompletenessProven, false);
});

test('fetchById and refresh use the exact public detail URL as the native record identity', async () => {
  const detailUrl = 'https://weworkremotely.com/remote-jobs/reddit-backend-engineer-iam';
  const extraction = new FakeExtraction(new Map([[detailUrl, 'detail-reddit.html']]));
  const connector = new WeWorkRemotelyConnector(extraction);

  const direct = await connector.fetchById(detailUrl, ctx());
  assert.equal(direct.externalId, detailUrl);
  assert.equal(direct.companyOrClient, 'Reddit');
  assert.equal(direct.sourceMetadata.nativeSalaryText, '$164,200—$229,900 USD');

  const refreshed = await connector.refresh({ externalId: detailUrl }, ctx());
  assert.equal(refreshed.record.externalId, detailUrl);
  const beforeInvalid = extraction.calls.length;
  assert.equal(await connector.fetchById('https://weworkremotely.com/remote-jobs/new', ctx()), null);
  assert.equal((await connector.refresh({ externalId: 'https://weworkremotely.com/remote-jobs/new' }, ctx())).record, null);
  assert.equal(extraction.calls.length, beforeInvalid);
});
