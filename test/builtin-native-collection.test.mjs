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

const { BuiltinConnector } = require('../src/modules/sources/connectors/builtin.connector.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

const fixtureDir = resolve(backendDir, 'test/fixtures/builtin-native');
const fixedNow = Date.parse('2026-10-06T04:00:00.000Z');
const oldDateNow = Date.now;
Date.now = () => fixedNow;

function fixture(name) {
  return readFileSync(resolve(fixtureDir, name), 'utf8');
}

const defaultFixtures = new Map([
  ['https://builtin.com/jobs', 'jobs-page-1.html'],
  ['https://builtin.com/jobs?page=2', 'jobs-page-2.html'],
  ['https://builtin.com/job/customer-solutions/8465710', 'detail-8465710.html'],
  ['https://builtin.com/job/finance-transformation-manager/11516371', 'detail-11516371.html'],
  ['https://builtin.com/job/staff-product-designer-mail-growth/11516136', 'detail-11516136.html'],
]);

function source(overrides = {}) {
  return {
    group: 'builtin',
    _id: 'builtin',
    name: 'Built In',
    enabled: true,
    runtimeState: 'Enabled',
    connectorFamily: 'PublicHtml',
    endpoint: { baseUrl: 'https://builtin.com/jobs' },
    config: {},
    limits: { perPage: 10 },
    timeoutMs: 30_000,
    opportunityTypes: ['vacancy'],
    ...overrides,
  };
}

function ctx(overrides = {}) {
  const { source: sourceOverrides, ...rest } = overrides;
  return {
    source: source(sourceOverrides),
    requestId: 'builtin-native-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-06T00:00:00.000Z',
    ...rest,
  };
}

class MockExtraction {
  constructor(fixtures = defaultFixtures) {
    this.fixtures = fixtures;
    this.calls = [];
  }

  async extractUrl(inputUrl, options = {}) {
    this.calls.push(inputUrl);
    assert.deepEqual(options.allowedHosts, ['builtin.com']);
    const name = this.fixtures.get(inputUrl);
    if (!name) throw new Error(`missing fixture for ${inputUrl}`);
    return { finalUrl: inputUrl, html: fixture(name), metadata: { firecrawl: false }, title: 'Built In' };
  }
}

class DynamicDetailExtraction extends MockExtraction {
  constructor({ failUrl, delayMs = 0 } = {}) {
    super(new Map());
    this.failUrl = failUrl;
    this.delayMs = delayMs;
  }

  async extractUrl(inputUrl, options = {}) {
    this.calls.push(inputUrl);
    assert.deepEqual(options.allowedHosts, ['builtin.com']);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (inputUrl === this.failUrl) throw new Error(`boom ${inputUrl}`);
    const id = inputUrl.match(/\/(\d+)$/)?.[1] ?? '0';
    return {
      finalUrl: inputUrl,
      html: `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: `Job ${id}`,
        description: `<p>Body ${id}</p>`,
        identifier: { '@type': 'PropertyValue', name: 'Acme', value: id },
        datePosted: '2026-10-06',
        hiringOrganization: { '@type': 'Organization', name: 'Acme' },
      })}</script></head><body></body></html>`,
      metadata: { firecrawl: false },
    };
  }
}

async function drain(connector, baseCtx) {
  const records = [];
  let current = { ...baseCtx, checkpoint: baseCtx.checkpoint ?? {} };
  let page;
  for (let index = 0; index < 10; index += 1) {
    page = await connector.fetchPage(current);
    records.push(...page.records);
    if (!page.hasMore) return { ...page, records };
    current = { ...baseCtx, checkpoint: page.checkpoint };
  }
  throw new Error('drain exceeded iteration guard');
}

function byExternalId(page, externalId) {
  const record = page.records.find((item) => item.externalId === externalId);
  assert.ok(record, `record ${externalId} should exist`);
  return record;
}

test.after(() => {
  Date.now = oldDateNow;
});

test('collects Built In public jobs through observed pagination and preserves native JobPosting facts', async () => {
  const extraction = new MockExtraction();
  const page = await drain(new BuiltinConnector(extraction), ctx());

  assert.equal(page.hasMore, false);
  assert.equal(page.records.length, 2);
  assert.deepEqual(page.records.map((item) => item.externalId).sort(), ['11516136', '8465710']);
  assert.equal(page.checkpoint.terminalReason, 'observed-pagination-frontier-exhausted-cap-unproven');
  assert.equal(page.checkpoint.incomplete, true);
  assert.match(page.checkpoint.limitation, /page=1000/);
  assert.equal(page.checkpoint.catalogComplete, false);
  assert.equal(page.checkpoint.criteriaVerifiedFromStart, true);
  assert.equal(page.checkpoint.listingCriteria.country, 'USA');
  assert.equal(page.checkpoint.fullWindowCompletenessProven, false);
  assert.equal(page.checkpoint.paginationCapObserved, true);
  assert.equal(page.checkpoint.maxObservedPage, 1000);
  assert.equal(page.checkpoint.seen, 3);
  assert.equal(page.checkpoint.uniqueSeen, 3);
  assert.equal(page.checkpoint.retained, 2);
  assert.equal(page.checkpoint.filteredKnownDateCount, 1);
  assert.match(page.checkpoint.scopeLimitation, /page=1000/);

  const customer = byExternalId(page, '8465710');
  assert.equal(customer.url, 'https://builtin.com/job/customer-solutions/8465710');
  assert.equal(customer.title, 'Customer Solutions');
  assert.equal(customer.companyOrClient, 'McMaster-Carr');
  assert.match(customer.description, /broadly skilled/);
  assert.match(customer.description, /team\.\n\nMake an impact/);
  assert.match(customer.description, /- Guide customers through the catalog\n- Solve urgent delivery needs/);
  assert.match(customer.description, /Cash Compensation/);
  assert.equal(customer.publishedAt.toISOString(), '2026-10-06T00:00:00.000Z');
  assert.equal(customer.sourceMetadata.extraction, 'builtin-native-html-v1');
  assert.equal(customer.sourceMetadata.nativeType, 'Full Time');
  assert.equal(customer.sourceMetadata.location, 'Elmhurst, Illinois, USA, Chicago, Illinois, USA');
  assert.deepEqual(customer.sourceMetadata.locations, ['Elmhurst, Illinois, USA', 'Chicago, Illinois, USA']);
  assert.deepEqual(customer.sourceMetadata.salary, { min: 103000, max: 118000, currency: 'USD', period: 'YEAR', originalText: '103000 – 118000 USD YEAR' });
  assert.deepEqual(customer.sourceMetadata.industries, ['eCommerce', 'Hardware', 'Information Technology', 'Logistics', 'Mobile', 'Software', 'App development']);
  assert.deepEqual(customer.sourceMetadata.benefits, ['Offers 401(K)', 'Offers health insurance']);
  assert.deepEqual(customer.sourceMetadata.skills, ['Customer support', 'Operations']);
  assert.deepEqual(customer.sourceMetadata.responsibilities, ['Guide customers', 'Solve delivery needs']);
  assert.deepEqual(customer.sourceMetadata.qualifications, ["Bachelor's degree"]);
  assert.equal(customer.sourceMetadata.seniority, 'Entry level');
  assert.equal(customer.sourceMetadata.deadlineAt, '2026-11-05T01:02:36.000Z');
  assert.equal(customer.rawPayload.jobPosting.identifier.value, '8465710');

  const normalized = new SourceNormalizerService().normalize(source(), customer);
  assert.deepEqual(normalized.money, { originalText: '103000 – 118000 USD YEAR', min: 103000, max: 118000, currency: 'USD', period: 'YEAR' });
  assert.equal(normalized.location, 'Elmhurst, Illinois, USA, Chicago, Illinois, USA');
  assert.equal(normalized.employmentType, 'Full Time');
  assert.equal(normalized.deadline.toISOString(), '2026-11-05T01:02:36.000Z');

  assert.deepEqual(extraction.calls, [
    'https://builtin.com/jobs',
    'https://builtin.com/job/customer-solutions/8465710',
    'https://builtin.com/job/finance-transformation-manager/11516371',
    'https://builtin.com/jobs?page=2',
    'https://builtin.com/job/staff-product-designer-mail-growth/11516136',
  ]);
});

test('bounds detail work by perPage and resumes frozen listing frontier', async () => {
  const extraction = new MockExtraction();
  const connector = new BuiltinConnector(extraction);
  const first = await connector.fetchPage(ctx({ source: { limits: { perPage: 1 } } }));

  assert.equal(first.records.length, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.checkpoint.perPage, 1);
  assert.equal(first.checkpoint.detailQueue.length, 1);
  assert.equal(first.checkpoint.nextListUrl, 'https://builtin.com/jobs?page=2');
  assert.deepEqual(extraction.calls, [
    'https://builtin.com/jobs',
    'https://builtin.com/job/customer-solutions/8465710',
  ]);

  const second = await connector.fetchPage(ctx({ source: { limits: { perPage: 1 } }, checkpoint: first.checkpoint }));
  assert.equal(second.records.length, 0);
  assert.equal(second.hasMore, true);
  assert.equal(second.checkpoint.filteredKnownDateCount, 1);
  assert.equal(extraction.calls.filter((url) => url === 'https://builtin.com/jobs').length, 1);
  assert.equal(extraction.calls.includes('https://builtin.com/jobs?page=2'), false);

  const third = await connector.fetchPage(ctx({ source: { limits: { perPage: 1 } }, checkpoint: second.checkpoint }));
  assert.equal(third.records.length, 1);
  assert.equal(third.records[0].externalId, '11516136');
  assert.equal(third.records[0].sourceMetadata.location, 'Tampa, Florida, USA');
  assert.deepEqual(third.records[0].sourceMetadata.locations, ['Tampa, Florida, USA']);
  assert.deepEqual(third.records[0].sourceMetadata.nativeJobLocations, ['Tampa, Florida, USA']);
  assert.deepEqual(third.records[0].sourceMetadata.applicantLocationRequirements, ['USA']);
  assert.equal(third.records[0].sourceMetadata.location.includes('USA, USA'), false);
  assert.equal(third.hasMore, false);
  assert.equal(third.checkpoint.visitedListUrls.includes('https://builtin.com/jobs?page=2'), true);
});

test('preserves native listing work format when detail omits it and prefers explicit detail remote', async () => {
  const urls = [
    'https://builtin.com/job/customer-solutions/8465710',
    'https://builtin.com/job/account-executive/3845439',
    'https://builtin.com/job/staff-product-designer-mail-growth/11516136',
  ];
  class WorkFormatExtraction extends MockExtraction {
    async extractUrl(url, options) {
      const document = await super.extractUrl(url, options);
      if (url === urls[2]) document.html = document.html.replace('"employmentType": "FULL_TIME"', '"employmentType": "FULL_TIME", "jobLocationType": "TELECOMMUTE"');
      return document;
    }
  }
  const extraction = new WorkFormatExtraction(new Map([
    [urls[0], 'detail-8465710.html'],
    [urls[1], 'detail-alias-3845439.html'],
    [urls[2], 'detail-11516136.html'],
  ]));
  const detailQueue = urls.map((url, index) => ({
    externalId: url.split('/').at(-1), url, title: 'Native listing card', rawText: 'Native listing card',
    listUrl: 'https://builtin.com/jobs', remoteType: index === 1 ? 'onsite' : 'hybrid',
  }));
  const checkpoint = {
    mode: 'builtin-public-html-jobs', hasMore: true, baseUrl: 'https://builtin.com/jobs', detailQueue,
    visitedListUrls: ['https://builtin.com/jobs'], seenExternalIds: detailQueue.map(card => card.externalId),
    backfillSince: '2026-09-06T00:00:00.000Z', windowUntil: new Date(fixedNow).toISOString(),
    perPage: 3, seen: 3, retained: 0, unknownDateCount: 0, filteredKnownDateCount: 0, maxObservedPage: 1,
  };
  const original = structuredClone(checkpoint);
  const page = await new BuiltinConnector(extraction).fetchPage(ctx({ checkpoint }));
  assert.equal(page.records.length, 3);
  for (const [index, expected] of ['hybrid', 'onsite', 'remote'].entries()) {
    const record = byExternalId(page, detailQueue[index].externalId);
    assert.equal(record.sourceMetadata.remoteType, expected);
    assert.equal(record.rawPayload.detail.remoteType, expected);
    assert.equal(new SourceNormalizerService().normalize(source(), record).remoteType, expected);
  }
  assert.deepEqual(checkpoint, original);
  assert.deepEqual(extraction.calls, urls);
});

test('rejects repeated observed pagination instead of silently truncating the frontier', async () => {
  const connector = new BuiltinConnector(new MockExtraction());
  const first = await connector.fetchPage(ctx({ source: { limits: { perPage: 1 } } }));

  await assert.rejects(
    () => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } }, checkpoint: { ...first.checkpoint, detailQueue: [], nextListUrl: 'https://builtin.com/jobs' } })),
    /pagination would revisit|pagination cycle detected/,
  );
});

test('rejects foreign JobPosting payloads instead of falling back to the first posting on the page', async () => {
  const fixtures = new Map([
    ['https://builtin.com/jobs', 'jobs-page-1.html'],
    ['https://builtin.com/job/customer-solutions/8465710', 'detail-foreign-posting.html'],
    ['https://builtin.com/job/finance-transformation-manager/11516371', 'detail-11516371.html'],
  ]);
  const connector = new BuiltinConnector(new MockExtraction(fixtures));

  await assert.rejects(
    () => connector.fetchPage(ctx()),
    /no JobPosting JSON-LD|identifier .* does not match/,
  );
});

test('uses Built In detail URL id as externalId while preserving mismatched native identifier when canonical URL is exact', async () => {
  const fixtures = new Map([
    ['https://builtin.com/job/account-executive/3845439', 'detail-alias-3845439.html'],
  ]);
  const checkpoint = {
    mode: 'builtin-public-html-jobs',
    hasMore: true,
    baseUrl: 'https://builtin.com/jobs',
    detailQueue: [{
      externalId: '3845439',
      url: 'https://builtin.com/job/account-executive/3845439',
      title: 'Account Executive',
      rawText: 'Snap! Mobile Account Executive',
      listUrl: 'https://builtin.com/jobs?page=4',
    }],
    visitedListUrls: ['https://builtin.com/jobs', 'https://builtin.com/jobs?page=2', 'https://builtin.com/jobs?page=3', 'https://builtin.com/jobs?page=4'],
    seenExternalIds: ['3845439'],
    backfillSince: '2026-09-06T00:00:00.000Z',
    windowUntil: new Date(fixedNow).toISOString(),
    perPage: 1,
    seen: 73,
    retained: 0,
    unknownDateCount: 0,
    filteredKnownDateCount: 0,
    maxObservedPage: 1000,
    paginationCapObserved: true,
  };
  const page = await new BuiltinConnector(new MockExtraction(fixtures)).fetchPage(ctx({ checkpoint }));

  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].externalId, '3845439');
  assert.equal(page.records[0].rawPayload.detail.nativeIdentifier, '5195243');
  assert.equal(page.records[0].sourceMetadata.nativeIdentifier, '5195243');
  assert.equal(page.records[0].sourceMetadata.location, 'Memphis, Tennessee, USA');
});

test('strictly validates continuation config and checkpoint card integrity', async () => {
  const connector = new BuiltinConnector(new MockExtraction());
  const first = await connector.fetchPage(ctx({ source: { limits: { perPage: 1 } } }));

  await assert.rejects(
    () => connector.fetchPage(ctx({ source: { endpoint: { baseUrl: 'https://builtin.com/jobs?page=2' }, limits: { perPage: 1 } }, checkpoint: first.checkpoint })),
    /baseUrl does not match/,
  );
  await assert.rejects(
    () => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } }, checkpoint: { ...first.checkpoint, perPage: 999 } })),
    /invalid perPage/,
  );
  await assert.rejects(
    () => connector.fetchPage(ctx({ source: { limits: { perPage: 1 } }, checkpoint: { ...first.checkpoint, detailQueue: [{ ...first.checkpoint.detailQueue[0], externalId: '999' }] } })),
    /invalid native job card/,
  );
  class RedirectedListingExtraction extends MockExtraction {
    async extractUrl(url, options) {
      return { ...await super.extractUrl(url, options), finalUrl: 'https://builtin.com/jobs/finance' };
    }
  }
  await assert.rejects(() => new BuiltinConnector(new RedirectedListingExtraction()).fetchPage(ctx()), /redirected to a different listing scope/);
});

test('detail concurrency stops scheduling new detail work after the first failure and preserves caller checkpoint object', async () => {
  const detailQueue = [1, 2, 3, 4, 5].map((id) => ({
    externalId: String(id),
    url: `https://builtin.com/job/job-${id}/${id}`,
    title: `Job ${id}`,
    rawText: `Job ${id}`,
    listUrl: 'https://builtin.com/jobs',
  }));
  const checkpoint = {
    mode: 'builtin-public-html-jobs',
    hasMore: true,
    baseUrl: 'https://builtin.com/jobs',
    detailQueue,
    visitedListUrls: ['https://builtin.com/jobs'],
    seenExternalIds: ['1', '2', '3', '4', '5'],
    backfillSince: '2026-09-06T00:00:00.000Z',
    windowUntil: new Date(fixedNow).toISOString(),
    perPage: 5,
    seen: 5,
    retained: 0,
    unknownDateCount: 0,
    filteredKnownDateCount: 0,
    maxObservedPage: 1,
  };
  const originalCheckpoint = structuredClone(checkpoint);
  const extraction = new DynamicDetailExtraction({ failUrl: 'https://builtin.com/job/job-1/1', delayMs: 5 });
  const connector = new BuiltinConnector(extraction);

  await assert.rejects(
    () => connector.fetchPage(ctx({ checkpoint })),
    /boom/,
  );
  assert.deepEqual(checkpoint, originalCheckpoint);
  assert.deepEqual(extraction.calls.sort(), [
    'https://builtin.com/job/job-1/1',
    'https://builtin.com/job/job-2/2',
    'https://builtin.com/job/job-3/3',
    'https://builtin.com/job/job-4/4',
  ]);
});

test('validates only the supported public Built In jobs URL surface', async () => {
  const connector = new BuiltinConnector(new MockExtraction());
  assert.equal((await connector.validateConfig({ baseUrl: 'https://builtin.com/jobs' })).ok, true);
  assert.equal((await connector.validateConfig({ baseUrl: 'https://builtin.com/jobs?page=2' })).ok, true);
  assert.equal((await connector.validateConfig({ baseUrl: 'https://builtin.com/jobs/finance?daysSinceUpdated=30&page=2' })).ok, true);
  assert.equal((await connector.validateConfig({ baseUrl: 'https://builtin.com/jobs?categories=9' })).ok, false);
  assert.equal((await connector.validateConfig({ baseUrl: 'https://builtin.com/jobs?daysSinceUpdated=90' })).ok, false);
  assert.equal((await connector.validateConfig({ baseUrl: 'https://builtin.com/auth/login?destination=%2fjobs' })).ok, false);
  assert.equal((await connector.validateConfig({ baseUrl: 'https://example.com/jobs' })).ok, false);
});

test('ignores page=N+1 anchors on another jobs pathname instead of switching catalogs', async () => {
  const fixtures = new Map([
    ['https://builtin.com/jobs', 'jobs-cross-path-next.html'],
    ['https://builtin.com/job/customer-solutions/8465710', 'detail-8465710.html'],
  ]);
  const extraction = new MockExtraction(fixtures);
  const page = await new BuiltinConnector(extraction).fetchPage(ctx());

  assert.equal(page.hasMore, false);
  assert.equal(page.records.length, 1);
  assert.equal(page.checkpoint.visitedListUrls.includes('https://builtin.com/jobs'), true);
  assert.equal(page.checkpoint.currentListUrl, 'https://builtin.com/jobs');
  assert.equal(page.checkpoint.nextListUrl, undefined);
  assert.equal(page.checkpoint.paginationCapObserved, false);
  assert.equal(page.checkpoint.observedListingScopeComplete, true);
  assert.equal(page.checkpoint.catalogComplete, false);
  assert.equal(page.checkpoint.fullWindowCompletenessProven, false);
  assert.equal(page.checkpoint.incomplete, true);
  assert.equal(extraction.calls.includes('https://builtin.com/jobs/remote?page=2'), false);
});

test('rejects changed native geography before fetching or ingesting the next page details', async () => {
  class ChangedGeographyExtraction extends MockExtraction {
    async extractUrl(url, options) {
      const document = await super.extractUrl(url, options);
      if (url.endsWith('page=2')) document.html = document.html.replace('"country":"USA"', '"country":"NLD"');
      return document;
    }
  }
  const extraction = new ChangedGeographyExtraction();
  const connector = new BuiltinConnector(extraction);
  const first = await connector.fetchPage(ctx());
  const original = structuredClone(first.checkpoint);
  await assert.rejects(() => connector.fetchPage(ctx({ checkpoint: first.checkpoint })), /criteria.*country|country.*criteria/i);
  assert.deepEqual(first.checkpoint, original);
  assert.equal(extraction.calls.includes('https://builtin.com/job/staff-product-designer-mail-growth/11516136'), false);
});

test('adopts the current native criteria for legacy continuation without certifying its earlier pages', async () => {
  const connector = new BuiltinConnector(new MockExtraction());
  const first = await connector.fetchPage(ctx());
  const legacy = structuredClone(first.checkpoint);
  delete legacy.listingCriteria;
  delete legacy.listingCriteriaVersion;
  delete legacy.criteriaVerifiedFromStart;
  const page = await connector.fetchPage(ctx({ checkpoint: legacy }));
  assert.equal(page.records.length, 1);
  assert.equal(page.checkpoint.listingCriteria.country, 'USA');
  assert.equal(page.checkpoint.criteriaVerifiedFromStart, false);
  assert.equal(page.checkpoint.observedListingScopeComplete, false);
  assert.match(page.checkpoint.incompleteReason, /legacy_criteria_prefix_unverified/);
  assert.equal(page.checkpoint.backfillSince, legacy.backfillSince);
  assert.equal(page.checkpoint.windowUntil, legacy.windowUntil);
});

test('preserves the confirmed month filter in pagination and ignores links that drop it', async () => {
  class MonthExtraction extends MockExtraction {
    async extractUrl(url, options) {
      if (!url.includes('/jobs')) return super.extractUrl(url, options);
      this.calls.push(url);
      assert.deepEqual(options.allowedHosts, ['builtin.com']);
      const page2 = new URL(url).searchParams.get('page') === '2';
      let html = fixture(page2 ? 'jobs-page-2.html' : 'jobs-page-1.html');
      html = html.replace('"daysSinceUpdated":null', '"daysSinceUpdated":30');
      if (!page2) html = html.replaceAll('/jobs?page=2', '/jobs?daysSinceUpdated=30&amp;page=2');
      return { finalUrl: url, html, metadata: { firecrawl: false } };
    }
  }
  const extraction = new MonthExtraction();
  const page = await drain(new BuiltinConnector(extraction), ctx({ source: { endpoint: { baseUrl: 'https://builtin.com/jobs?daysSinceUpdated=30' } } }));
  assert.equal(page.checkpoint.listingCriteria.daysSinceUpdated, 30);
  assert.equal(page.checkpoint.maxObservedPage, 2);
  assert.equal(page.checkpoint.paginationCapObserved, false);
  assert.equal(page.checkpoint.observedListingScopeComplete, true);
  assert.equal(page.checkpoint.catalogComplete, false);
  assert.equal(extraction.calls.includes('https://builtin.com/jobs?daysSinceUpdated=30&page=2'), true);
  assert.equal(extraction.calls.includes('https://builtin.com/jobs?page=2'), false);
});

test('keeps Built In JobPosting headings and bullets readable for real card 11515543 shape', async () => {
  const fixtures = new Map([
    ['https://builtin.com/job/senior-platform-engineer/11515543', 'detail-11515543.html'],
  ]);
  const checkpoint = {
    mode: 'builtin-public-html-jobs',
    hasMore: true,
    baseUrl: 'https://builtin.com/jobs',
    detailQueue: [{
      externalId: '11515543',
      url: 'https://builtin.com/job/senior-platform-engineer/11515543',
      title: 'Senior Platform Engineer',
      rawText: 'Senior Platform Engineer',
      listUrl: 'https://builtin.com/jobs',
    }],
    visitedListUrls: ['https://builtin.com/jobs'],
    seenExternalIds: ['11515543'],
    backfillSince: '2026-09-06T00:00:00.000Z',
    windowUntil: new Date(fixedNow).toISOString(),
    perPage: 1,
    seen: 1,
    retained: 0,
    unknownDateCount: 0,
    filteredKnownDateCount: 0,
    maxObservedPage: 1,
  };
  const page = await new BuiltinConnector(new MockExtraction(fixtures)).fetchPage(ctx({ checkpoint }));

  assert.equal(page.records.length, 1);
  assert.doesNotMatch(page.records[0].description, /RoleWe/);
  assert.doesNotMatch(page.records[0].description, /Expectations\)- Build/);
  assert.doesNotMatch(page.records[0].description, /Profile\)You/);
  assert.match(page.records[0].description, /Role\n\nWe are looking/);
  assert.match(page.records[0].description, /What You’ll Do \(Role Expectations\)\n\n- Build reliable services\n- Improve deployment workflows/);
  assert.match(page.records[0].description, /Who You Are \(Success Profile\)\n\nYou enjoy production ownership/);
  assert.equal(page.records[0].sourceMetadata.location, 'Tampa, Florida, USA');
  assert.deepEqual(page.records[0].sourceMetadata.applicantLocationRequirements, ['USA']);
});
