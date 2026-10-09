import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { YcJobsConnector } = require('../src/modules/sources/connectors/yc-jobs.connector.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

function source(overrides = {}) {
  return {
    group: 'yc-jobs',
    _id: 'yc-jobs',
    name: 'YC Jobs',
    enabled: true,
    runtimeState: 'Enabled',
    checkpoint: {},
    connectorFamily: 'PublicHtml',
    endpoint: { baseUrl: 'https://www.ycombinator.com/jobs' },
    config: {},
    limits: { perPage: 20 },
    timeoutMs: 30_000,
    opportunityTypes: ['vacancy'],
    ...overrides,
  };
}

function ctx(overrides = {}) {
  const { source: sourceOverrides, ...rest } = overrides;
  return {
    source: source(sourceOverrides),
    requestId: 'yc-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T10:55:00.123Z',
    ...rest,
  };
}

function listingPage({ jobs = [job(101)], anchors = ['/jobs/role/software-engineer', '/jobs/location/san-francisco'], component = 'WaasJobListingsPage', extraProps = {}, includeDefaultRoleLocation = true } = {}) {
  const data = {
    component,
    props: {
      jobPostings: jobs,
      sidebarLinks: anchors.map((href, index) => [`Link ${index}`, href]),
      jobRoles: includeDefaultRoleLocation ? [{ slug: 'designer', name: 'Design' }] : [],
      jobLocations: includeDefaultRoleLocation ? [{ slug: 'new-york', name: 'New York' }] : [],
      createProfileUrl: 'https://account.ycombinator.com/authenticate?continue=https%3A%2F%2Fwww.workatastartup.com%2Fapplication',
      ...extraProps,
    },
  };
  const html = escapeAttr(JSON.stringify(data));
  const links = anchors.map((href) => `<a href="${href}">listing</a>`).join('');
  const detailLinks = jobs.map((posting) => `<a href="${posting.url}">${posting.title}</a>`).join('');
  return `<!doctype html><html><body>${includeDefaultRoleLocation ? '<a href="/jobs/role/designer">role</a>' : ''}${links}${detailLinks}<a href="https://account.ycombinator.com/authenticate?continue=x">See more jobs</a><div data-page="${html}"></div></body></html>`;
}

function job(id, overrides = {}) {
  return {
    id,
    title: `Engineer ${id}`,
    url: `/companies/acme/jobs/AB${id}CD-engineer-${id}`,
    applyUrl: `https://account.ycombinator.com/authenticate?continue=https%3A%2F%2Fwww.workatastartup.com%2Fapplication%3Fsignup_job_id%3D${id}`,
    location: 'New York, NY',
    type: 'Full-time',
    role: 'eng',
    roleSpecificType: 'Full stack',
    prettyRole: 'Engineering',
    salaryRange: '$140K - $250K',
    equityRange: '0.1% - 0.2%',
    minExperience: '3+ years',
    visa: 'US citizen/visa only',
    skills: ['Node.js', 'React'],
    companyUrl: '/companies/acme',
    companyLogoUrl: 'https://bookface-images.s3.amazonaws.com/small_logos/acme.png',
    companyName: 'Acme',
    companyBatchName: 'S26',
    companyOneLiner: 'Builds rockets',
    createdAt: '2 days',
    lastActive: '1 day',
    ctaText: 'Apply',
    ctaUrl: 'https://account.ycombinator.com/authenticate?continue=x',
    ...overrides,
  };
}

function detailHtml(id, { datePosted = '2026-09-30T12:00:00Z', description = `<p><strong>About Acme</strong></p><p>Full public job body ${id}</p>`, baseSalary, jobLocationType } = {}) {
  const data = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: `Engineer ${id}`,
    url: `https://www.ycombinator.com/companies/acme/jobs/AB${id}CD-engineer-${id}`,
    description,
    ...(datePosted === null ? {} : { datePosted }),
    employmentType: 'FULL_TIME',
    hiringOrganization: { '@type': 'Organization', name: 'Acme', sameAs: 'https://acme.example', logo: 'https://bookface-images.s3.amazonaws.com/small_logos/acme.png' },
    baseSalary: baseSalary ?? { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', unitText: 'YEAR', minValue: 140000, maxValue: 250000 } },
    jobLocation: [{ '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'New York', addressRegion: 'New York', addressCountry: 'US' } }],
    ...(jobLocationType ? { jobLocationType } : {}),
  };
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head><body></body></html>`;
}


function graphDetailHtml(id) {
  const matchingUrl = `https://www.ycombinator.com/companies/acme/jobs/AB${id}CD-engineer-${id}`;
  const wrongUrl = `https://www.ycombinator.com/companies/other/jobs/WRONG${id}-wrong-${id}`;
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org/',
    '@graph': [
      { '@type': 'Organization', name: 'Acme' },
      { '@type': 'JobPosting', title: 'Wrong job', url: wrongUrl, description: '<p>Wrong body</p>' },
      { '@type': 'JobPosting', title: `Engineer ${id}`, url: matchingUrl, description: `<p>Matched graph body ${id}</p>`, datePosted: '2026-09-30T12:00:00Z' },
    ],
  })}</script></head><body></body></html>`;
}

function escapeAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

class MockExtraction {
  constructor({ pages = {}, details = {}, finalUrls = {}, errors = {} } = {}) {
    this.pages = pages;
    this.details = details;
    this.finalUrls = finalUrls;
    this.errors = errors;
    this.calls = [];
    this.options = [];
  }

  async extractUrl(url, options = {}) {
    this.calls.push(url);
    if (this.errors[url]) throw this.errors[url];
    this.options.push(options);
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/companies/')) {
      const id = parsed.pathname.match(/AB(\d+)CD/)?.[1] ?? parsed.pathname.match(/signup_job_id%3D(\d+)/)?.[1] ?? 'unknown';
      return { finalUrl: this.finalUrls[url] ?? url, html: this.details[url] ?? this.details[id] ?? detailHtml(id), metadata: { firecrawl: false }, title: `Engineer ${id}` };
    }
    const html = this.pages[url] ?? this.pages[parsed.pathname] ?? listingPage({ jobs: [job(101)], anchors: [] });
    return { finalUrl: this.finalUrls[url] ?? url, html, metadata: { firecrawl: false }, title: 'YC Jobs' };
  }
}

test('yc jobs collects concrete public postings from SSR data-page and fetches full JSON-LD details', async () => {
  const extraction = new MockExtraction({ pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [job(101), job(202)], anchors: ['/jobs/role/software-engineer'] }) } });
  const connector = new YcJobsConnector(extraction);

  const page = await connector.fetchPage(ctx());

  assert.deepEqual(page.records.map((record) => record.externalId), ['101', '202']);
  assert.equal(page.records[0].description, 'About Acme Full public job body 101');
  assert.equal(page.records[0].companyOrClient, 'Acme');
  assert.equal(page.records[0].publishedAt.toISOString(), '2026-09-30T12:00:00.000Z');
  assert.equal(page.records[0].sourceMetadata.salaryRange, '$140K - $250K');
  assert.deepEqual(page.records[0].sourceMetadata.salary, { min: 140000, max: 250000, currency: 'USD', period: 'YEAR', originalText: '140000 – 250000 USD YEAR' });
  assert.equal(page.records[0].sourceMetadata.area, 'New York, New York, US');
  assert.deepEqual(page.records[0].sourceMetadata.skills, ['Node.js', 'React']);
  const normalized = new SourceNormalizerService().normalize(source(), page.records[0]);
  assert.deepEqual(normalized.money, { originalText: '140000 – 250000 USD YEAR', min: 140000, max: 250000, currency: 'USD', period: 'YEAR' });
  assert.equal(normalized.location, 'New York, New York, US');
  assert.equal(extraction.calls.includes('https://www.ycombinator.com/jobs/role/designer'), false);
  assert.equal(extraction.calls.filter((url) => url.includes('/companies/acme/jobs/')).length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.checkpoint.listingQueue.includes('https://www.ycombinator.com/jobs/role/software-engineer'), true);
  assert.equal(page.checkpoint.listingQueue.includes('https://www.ycombinator.com/jobs/role/designer'), true);
  assert.equal(page.records[0].sourceMetadata.observedScope, 'public-yc-jobs-seo-listings');
  assert.match(page.records[0].sourceMetadata.scopeLimitation, /account\.ycombinator\.com/);
});

test('yc jobs continuation keeps fixed window and deduplicates overlapping listing pages', async () => {
  const extraction = new MockExtraction({
    pages: { 'https://www.ycombinator.com/jobs/role/software-engineer': listingPage({ jobs: [job(101), job(303)], anchors: [], includeDefaultRoleLocation: false }) },
    details: { 303: detailHtml(303) },
  });
  const connector = new YcJobsConnector(extraction);

  const page = await connector.fetchPage(ctx({
    checkpoint: {
      hasMore: true,
      listingQueue: ['https://www.ycombinator.com/jobs/role/software-engineer'],
      visitedListingUrls: ['https://www.ycombinator.com/jobs'],
      seenJobIds: ['101'],
      backfillSince: '2026-09-04T10:55:00.123Z',
      windowTo: '2026-10-04T08:00:00.000Z',
      nextPage: 1,
    },
    backfillSince: '2026-10-01T00:00:00.000Z',
    page: 1,
  }));

  assert.deepEqual(page.records.map((record) => record.externalId), ['303']);
  assert.equal(page.records[0].sourceMetadata.publicationWindow.backfillSince, '2026-09-04T10:55:00.123Z');
  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.hasMore, false);
  assert.equal(page.checkpoint.backfillSince, '2026-09-04T10:55:00.123Z');
  assert.equal(page.checkpoint.windowTo, '2026-10-04T08:00:00.000Z');
  assert.deepEqual(page.checkpoint.visitedListingUrls.sort(), ['https://www.ycombinator.com/jobs', 'https://www.ycombinator.com/jobs/role/software-engineer']);
  assert.deepEqual(page.checkpoint.seenJobIds.sort(), ['101', '303']);
});

test('yc jobs filters exact old and future dates while retaining unknown dates', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-04T12:00:00Z') });
  const extraction = new MockExtraction({
    pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [job(1), job(2), job(3)], anchors: [], includeDefaultRoleLocation: false }) },
    details: {
      1: detailHtml(1, { datePosted: '2026-09-01T00:00:00Z' }),
      2: detailHtml(2, { datePosted: null }),
      3: detailHtml(3, { datePosted: '2026-10-05T00:00:00Z' }),
    },
  });
  const connector = new YcJobsConnector(extraction);

  const page = await connector.fetchPage(ctx({ checkpoint: {}, backfillSince: '2026-09-04T10:55:00.123Z' }));

  assert.deepEqual(page.records.map((record) => record.externalId), ['2']);
  assert.equal(page.records[0].publishedAt, undefined);
  assert.equal(page.records[0].sourceMetadata.createdAtRaw, '2 days');
  assert.equal(page.records[0].sourceMetadata.lastActiveRaw, '1 day');
});

test('yc jobs rejects malformed listing/detail payloads and unsafe URLs', async () => {
  const noData = new YcJobsConnector(new MockExtraction({ pages: { 'https://www.ycombinator.com/jobs': '<html></html>' } }));
  await assert.rejects(() => noData.fetchPage(ctx()), /did not expose parseable SSR/);

  const noPostings = new YcJobsConnector(new MockExtraction({ pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [], anchors: [] }) } }));
  await assert.rejects(() => noPostings.fetchPage(ctx()), /contains no concrete jobPostings/);

  const badPosting = new YcJobsConnector(new MockExtraction({ pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [job(4, { url: '/jobs/role/designer' })], anchors: [] }) } }));
  await assert.rejects(() => badPosting.fetchPage(ctx()), /malformed concrete posting/);

  const badDetail = new YcJobsConnector(new MockExtraction({ pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [job(5)], anchors: [] }) }, details: { 5: '<html><script type="application/ld+json">{"@type":"JobPosting","title":"No body","description":"<p></p>"}</script></html>' } }));
  await assert.rejects(() => badDetail.fetchPage(ctx()), /does not expose a usable public JobPosting body/);

  const redirect = new YcJobsConnector(new MockExtraction({ pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [job(6)], anchors: [] }) }, finalUrls: { 'https://www.ycombinator.com/companies/acme/jobs/AB6CD-engineer-6': 'https://www.ycombinator.com:444/companies/acme/jobs/AB6CD-engineer-6' } }));
  await assert.rejects(() => redirect.fetchPage(ctx()), /redirected outside its public job page/);

  const wrongCompanyRedirect = new YcJobsConnector(new MockExtraction({ pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [job(9)], anchors: [] }) }, finalUrls: { 'https://www.ycombinator.com/companies/acme/jobs/AB9CD-engineer-9': 'https://www.ycombinator.com/companies/evil/jobs/AB9CD-engineer-9' } }));
  await assert.rejects(() => wrongCompanyRedirect.fetchPage(ctx()), /redirected to a different job slug/);
});


test('yc jobs uses @graph JobPosting matching the current detail URL and falls back to raw salary range without guessing', async () => {
  const extraction = new MockExtraction({
    pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [job(404, { salaryRange: '$90K - $130K', location: 'Remote' })], anchors: [], includeDefaultRoleLocation: false }) },
    details: { 404: graphDetailHtml(404) },
  });
  const connector = new YcJobsConnector(extraction);

  const page = await connector.fetchPage(ctx());

  assert.equal(page.records[0].title, 'Engineer 404');
  assert.equal(page.records[0].description, 'Matched graph body 404');
  assert.deepEqual(page.records[0].sourceMetadata.salary, { originalText: '$90K - $130K' });
  assert.equal(page.records[0].sourceMetadata.remoteType, 'Remote');
  const normalized = new SourceNormalizerService().normalize(source(), page.records[0]);
  assert.deepEqual(normalized.money, { originalText: '$90K - $130K' });
  assert.equal(normalized.remoteType, 'Remote');
});

test('yc jobs parses saved live YC fixtures for datePosted, skills, salary and full body', async () => {
  const listFixture = readFileSync(new URL('./fixtures/yc-jobs/yc-jobs.html', import.meta.url), 'utf8');
  const detailFixture = readFileSync(new URL('./fixtures/yc-jobs/yc-detail-boldvoice.html', import.meta.url), 'utf8');
  const ids = Array.from(listFixture.matchAll(/&quot;id&quot;:(\d+)/g)).map((match) => match[1]);
  assert.equal(ids.includes('45768'), true);
  const extraction = new MockExtraction({
    pages: { 'https://www.ycombinator.com/jobs': listFixture },
    details: { 'https://www.ycombinator.com/companies/boldvoice/jobs/BSms6T6-fullstack-engineer-nyc': detailFixture },
  });
  const connector = new YcJobsConnector(extraction);

  const page = await connector.fetchPage(ctx({
    checkpoint: {
      hasMore: true,
      listingQueue: ['https://www.ycombinator.com/jobs'],
      visitedListingUrls: [],
      seenJobIds: ids.filter((id) => id !== '45768'),
      backfillSince: '2021-08-01T00:00:00.000Z',
      windowTo: '2021-09-01T00:00:00.000Z',
      nextPage: 0,
    },
    backfillSince: '2026-10-01T00:00:00.000Z',
  }));

  assert.equal(page.records.length, 1);
  const record = page.records[0];
  assert.equal(record.externalId, '45768');
  assert.equal(record.title, 'Fullstack Engineer (NYC)');
  assert.equal(record.publishedAt.toISOString(), '2021-08-14T16:42:11.000Z');
  assert.deepEqual(record.sourceMetadata.skills, ['Express']);
  assert.deepEqual(record.sourceMetadata.salary, { min: 140000, max: 250000, currency: 'USD', period: 'YEAR', originalText: '140000 – 250000 USD YEAR' });
  assert.equal(record.sourceMetadata.area, 'New York, New York, US');
  assert.match(record.description, /About BoldVoice/);
});


test('yc jobs records stale public detail 404 coverage and keeps collecting other jobs', async () => {
  const staleUrl = 'https://www.ycombinator.com/companies/octavian-robotics/jobs/PTAXI4y-hardware-robotics-engineer';
  const liveUrl = 'https://www.ycombinator.com/companies/acme/jobs/AB707CD-engineer-707';
  const extraction = new MockExtraction({
    pages: { 'https://www.ycombinator.com/jobs/location/los-angeles': listingPage({ jobs: [job(111687, { title: 'Hardware Robotics Engineer', url: '/companies/octavian-robotics/jobs/PTAXI4y-hardware-robotics-engineer' }), job(707)], anchors: [], includeDefaultRoleLocation: false }) },
    errors: { [staleUrl]: new Error('URL returned HTTP 404') },
  });
  const connector = new YcJobsConnector(extraction);

  const page = await connector.fetchPage(ctx({
    checkpoint: {
      hasMore: true,
      listingQueue: ['https://www.ycombinator.com/jobs/location/los-angeles'],
      visitedListingUrls: ['https://www.ycombinator.com/jobs'],
      seenJobIds: [],
      backfillSince: '2026-09-04T12:42:04.637Z',
      windowTo: '2026-10-04T12:42:04.637Z',
      nextPage: 4,
    },
  }));

  assert.deepEqual(page.records.map((record) => record.externalId), ['707']);
  assert.equal(extraction.calls.includes(staleUrl), true);
  assert.equal(extraction.calls.includes(liveUrl), true);
  assert.equal(page.checkpoint.hasMore, false);
  assert.deepEqual(page.checkpoint.coverageIssues, [{
    kind: 'stale-detail-404',
    url: staleUrl,
    listingUrl: 'https://www.ycombinator.com/jobs/location/los-angeles',
    jobId: '111687',
    title: 'Hardware Robotics Engineer',
    observedAt: page.checkpoint.coverageIssues[0].observedAt,
  }]);
  assert.equal(page.checkpoint.seenJobIds.includes('111687'), true);
  assert.equal(page.checkpoint.seenJobIds.includes('707'), true);
});

test('yc jobs records stale public listing 404 but does not hide 5xx detail failures', async () => {
  const staleListing = 'https://www.ycombinator.com/jobs/location/los-angeles';
  const nextListing = 'https://www.ycombinator.com/jobs/role/software-engineer';
  const listing404 = new YcJobsConnector(new MockExtraction({
    pages: { [nextListing]: listingPage({ jobs: [job(808)], anchors: [], includeDefaultRoleLocation: false }) },
    errors: { [staleListing]: new Error('URL returned HTTP 404') },
  }));

  const skipped = await listing404.fetchPage(ctx({
    checkpoint: {
      hasMore: true,
      listingQueue: [staleListing, nextListing],
      visitedListingUrls: ['https://www.ycombinator.com/jobs'],
      seenJobIds: [],
      backfillSince: '2026-09-04T12:42:04.637Z',
      windowTo: '2026-10-04T12:42:04.637Z',
      nextPage: 4,
    },
  }));

  assert.equal(skipped.records.length, 0);
  assert.equal(skipped.hasMore, true);
  assert.deepEqual(skipped.checkpoint.listingQueue, [nextListing]);
  assert.equal(skipped.checkpoint.visitedListingUrls.includes(staleListing), true);
  assert.equal(skipped.checkpoint.coverageIssues[0].kind, 'stale-listing-404');

  const detail500Url = 'https://www.ycombinator.com/companies/acme/jobs/AB909CD-engineer-909';
  const failing = new YcJobsConnector(new MockExtraction({
    pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [job(909)], anchors: [], includeDefaultRoleLocation: false }) },
    errors: { [detail500Url]: new Error('URL returned HTTP 500') },
  }));
  await assert.rejects(() => failing.fetchPage(ctx()), /HTTP 500/);
});

test('yc jobs passes ctx.signal to listing and detail fetches and rejects unsupported searchText', async () => {
  const signal = AbortSignal.timeout(30_000);
  const extraction = new MockExtraction({ pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [job(7)], anchors: [] }) } });
  const connector = new YcJobsConnector(extraction);

  const validation = await connector.validateConfig({ searchText: 'founder mode' });
  assert.equal(validation.ok, false);

  await connector.fetchPage(ctx({ signal }));

  assert.equal(extraction.options.length >= 2, true);
  assert.equal(extraction.options.every((options) => options.signal === signal), true);
});

test('yc jobs health exposes public endpoint metadata without claiming gated search access', async () => {
  const connector = new YcJobsConnector(new MockExtraction({ pages: { 'https://www.ycombinator.com/jobs': listingPage({ jobs: [job(8)], anchors: [] }) } }));

  const validation = await connector.validateConfig({});
  const health = await connector.healthCheck(ctx());

  assert.equal(validation.ok, true);
  assert.equal(validation.details.parser, 'yc-jobs-public-html-v1');
  assert.equal(validation.details.baseUrl, 'https://www.ycombinator.com/jobs');
  assert.match(validation.details.scopeLimitation, /gated search/);
  assert.equal(health.state, 'Healthy', health.message);
});
