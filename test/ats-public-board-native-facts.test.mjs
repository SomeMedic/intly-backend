import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { AtsPublicBoardConnector } = require('../src/modules/sources/connectors/ats-public-board.connector.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

function context(id, tenants, overrides = {}) {
  return {
    source: {
      _id: id,
      name: id,
      connectorFamily: 'AtsPublicBoard',
      group: 'web',
      config: { tenants, ...(overrides.config ?? {}) },
      limits: overrides.limits ?? {},
      timeoutMs: 1_000,
    },
    requestId: `${id}-native-facts`,
    checkpoint: overrides.checkpoint ?? {},
    backfillDays: 30,
    ...overrides,
  };
}

async function withFetch(handler, action) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  globalThis.fetch.calls = calls;
  try {
    return await action(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('Greenhouse preserves native list facts and enriches pay through bounded detail pages', async () => {
  const list = {
    jobs: [
      {
        id: 101,
        absolute_url: 'https://boards.greenhouse.io/acme/jobs/101',
        title: 'Platform Engineer',
        company_name: 'Acme',
        first_published: '2026-10-01T10:00:00-04:00',
        updated_at: '2026-10-04T10:00:00-04:00',
        application_deadline: '2026-11-01T00:00:00-04:00',
        location: { name: 'London, United Kingdom' },
        departments: [{ name: 'Engineering' }],
        offices: [{ name: 'London', location: 'London, United Kingdom' }],
        metadata: [{ name: 'Workplace Type', value: 'Hybrid' }],
        content: '&lt;p&gt;Build &amp;amp; operate reliable systems.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Keep the final paragraph visible.&lt;/li&gt;&lt;/ul&gt;',
      },
      {
        id: 102,
        absolute_url: 'https://boards.greenhouse.io/acme/jobs/102',
        title: 'Support Engineer',
        updated_at: '2026-10-04T10:00:00-04:00',
        content: '&lt;p&gt;No publication date promised here.&lt;/p&gt;',
      },
    ],
  };
  const detail = {
    ...list.jobs[0],
    pay_input_ranges: [{ min_cents: 4600000, max_cents: 5400000, currency_type: 'GBP', title: 'United Kingdom Annual Pay Range', blurb: '<p>Annualized base pay.</p>' }],
  };
  await withFetch(async (url) => {
    if (url.endsWith('/jobs?content=true')) return json(list);
    if (url.endsWith('/jobs/101?pay_transparency=true')) return json(detail);
    if (url.endsWith('/jobs/102?pay_transparency=true')) return json({}, 404);
    throw new Error(`unexpected ${url}`);
  }, async () => {
    const connector = new AtsPublicBoardConnector('greenhouse');
    const first = await connector.fetchPage(context('greenhouse', ['acme'], { limits: { greenhouseDetailLimit: 1 } }));
    assert.equal(first.records.length, 1);
    assert.equal(first.hasMore, true);
    assert.equal(first.checkpoint.greenhouseTenant, 'acme');
    assert.equal(first.checkpoint.greenhouseOffset, 1);
    assert.equal(first.records[0].externalId, 'acme:101');
    assert.equal(first.records[0].companyOrClient, 'Acme');
    assert.match(first.records[0].description, /Build & operate reliable systems/);
    assert.match(first.records[0].description, /Keep the final paragraph visible/);
    assert.equal(first.records[0].publishedAt.toISOString(), '2026-10-01T14:00:00.000Z');
    assert.equal(first.records[0].sourceMetadata.sourceDateField, 'first_published');
    assert.deepEqual(first.records[0].sourceMetadata.salary, { min: 46000, max: 54000, currency: 'GBP', period: 'YEAR', originalText: '46000 – 54000 GBP YEAR' });
    assert.equal(first.records[0].sourceMetadata.nativeSalaryText, 'United Kingdom Annual Pay Range\n\n46000 – 54000 GBP YEAR\n\nAnnualized base pay.');
    assert.equal(first.records[0].sourceMetadata.remoteType, 'Hybrid');
    assert.equal(first.records[0].sourceMetadata.location, 'London, United Kingdom');

    const second = await connector.fetchPage(context('greenhouse', ['acme'], { checkpoint: first.checkpoint, limits: { greenhouseDetailLimit: 1 } }));
    assert.equal(second.records.length, 1);
    assert.equal(second.hasMore, false);
    assert.equal(second.records[0].externalId, 'acme:102');
    assert.equal(second.records[0].publishedAt, undefined);
    assert.equal(second.records[0].sourceMetadata.sourceDateField, undefined);
    assert.equal(second.records[0].sourceMetadata.salary, undefined);
    assert.equal(second.records[0].sourceMetadata.updatedAtRaw, '2026-10-04T10:00:00-04:00');
  });
});

test('Greenhouse skips detail calls for known dates outside the frozen collection window', async () => {
  const list = {
    jobs: [
      { id: 201, absolute_url: 'https://boards.greenhouse.io/acme/jobs/201', title: 'Old Role', first_published: '2026-08-01T10:00:00Z', content: '&lt;p&gt;Old retained list body.&lt;/p&gt;' },
      { id: 202, absolute_url: 'https://boards.greenhouse.io/acme/jobs/202', title: 'Future Role', first_published: '2026-12-01T10:00:00Z', content: '&lt;p&gt;Future retained list body.&lt;/p&gt;' },
    ],
  };
  await withFetch(async (url) => {
    if (url.endsWith('/jobs?content=true')) return json(list);
    throw new Error(`detail should not be requested for out-of-window job: ${url}`);
  }, async (calls) => {
    const page = await new AtsPublicBoardConnector('greenhouse').fetchPage(context('greenhouse', ['acme'], {
      backfillSince: '2026-09-01T00:00:00.000Z',
      checkpoint: { windowTo: '2026-10-06T00:00:00.000Z' },
    }));
    assert.equal(calls.length, 1);
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0].externalId, 'acme:201');
    assert.match(page.records[0].description, /Old retained list body/);
    assert.equal(page.records[0].sourceMetadata.salary, undefined);
  });
});

test('Lever maps native opening, lists, additional text, salary and remote facts without publication guesses', async () => {
  const payload = [{
    id: 'lev-1',
    text: 'Staff Engineer',
    hostedUrl: 'https://jobs.lever.co/acme/lev-1',
    description: '<p>Opening &amp; overview.</p>',
    descriptionPlain: 'Opening & overview.',
    additional: '<p>Additional details stay in the tail.</p>',
    additionalPlain: 'Additional details stay in the tail.',
    salaryDescription: '$200,000 - $250,000 USD',
    salaryRange: { min: 200000, max: 250000, currency: 'USD', interval: 'per-year-salary' },
    workplaceType: 'remote',
    createdAt: 1720000000000,
    categories: { location: 'Remote - US', allLocations: ['Remote - Canada'], commitment: 'Full-time', team: 'Engineering', department: 'Product' },
    lists: [
      { text: 'Requirements', content: '<ul><li>TypeScript</li><li>Distributed systems</li></ul>' },
      { text: 'Benefits', content: '<p>Useful benefits text.</p>' },
    ],
  }];
  await withFetch(async () => json(payload), async () => {
    const page = await new AtsPublicBoardConnector('lever').fetchPage(context('lever', ['acme']));
    const record = page.records[0];
    assert.equal(record.externalId, 'acme:lev-1');
    assert.equal(record.publishedAt, undefined);
    assert.match(record.description, /Opening & overview/);
    assert.equal(record.description.match(/Opening & overview/g).length, 1);
    assert.match(record.description, /Requirements/);
    assert.match(record.description, /Distributed systems/);
    assert.match(record.description, /Additional details stay in the tail/);
    assert.equal(record.sourceMetadata.createdAtRaw, 1720000000000);
    assert.equal(record.sourceMetadata.remoteType, 'remote');
    assert.equal(record.sourceMetadata.employment, 'Full-time');
    assert.deepEqual(record.sourceMetadata.locations, ['Remote - US', 'Remote - Canada']);
    assert.deepEqual(record.sourceMetadata.salary, { min: 200000, max: 250000, currency: 'USD', period: 'YEAR', originalText: '200000 – 250000 USD YEAR' });
    assert.equal(record.sourceMetadata.nativeSalaryText, '$200,000 - $250,000 USD');
    assert.equal(record.sourceMetadata.salaryIntervalRaw, 'per-year-salary');
    const normalized = new SourceNormalizerService().normalize(context('lever', ['acme']).source, record);
    assert.deepEqual(normalized.money, { min: 200000, max: 250000, currency: 'USD', period: 'YEAR', originalText: '200000 – 250000 USD YEAR' });
  });
});

test('Ashby requests compensation and maps publishedAt, compensation salary and non-salary tiers separately', async () => {
  const payload = { jobs: [{
    id: 'ash-1',
    title: 'Design Engineer',
    department: 'Design',
    team: 'Magic',
    employmentType: 'FullTime',
    location: 'North America',
    secondaryLocations: [{ location: 'Europe' }],
    publishedAt: '2026-03-04T02:08:44.483+00:00',
    isRemote: true,
    workplaceType: 'Remote',
    jobUrl: 'https://jobs.ashbyhq.com/acme/ash-1',
    descriptionHtml: '<p>Build polished product surfaces.</p>',
    compensation: {
      compensationTiers: [{ name: 'US tier', summaryComponents: [{ type: 'Equity', minValue: 1, maxValue: 2 }] }],
      summaryComponents: [{ type: 'Salary', minValue: 180000, maxValue: 220000, currencyCode: 'USD', interval: 'YEAR' }, { type: 'Equity', minValue: 1, maxValue: 2 }],
    },
  }] };
  await withFetch(async () => json(payload), async (calls) => {
    const page = await new AtsPublicBoardConnector('ashby').fetchPage(context('ashby', ['acme']));
    assert.equal(calls[0].url, 'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true');
    const record = page.records[0];
    assert.equal(record.externalId, 'acme:ash-1');
    assert.equal(record.publishedAt.toISOString(), '2026-03-04T02:08:44.483Z');
    assert.equal(record.sourceMetadata.sourceDateField, 'publishedAt');
    assert.match(record.description, /Build polished product surfaces/);
    assert.deepEqual(record.sourceMetadata.locations, ['North America', 'Europe']);
    assert.equal(record.sourceMetadata.remoteType, 'Remote');
    assert.deepEqual(record.sourceMetadata.salary, { min: 180000, max: 220000, currency: 'USD', period: 'YEAR', originalText: '180000 – 220000 USD YEAR' });
    assert.deepEqual(record.sourceMetadata.compensationTiers, payload.jobs[0].compensation.compensationTiers);
  });
});

test('ATS salary metadata keeps canonical originalText compact for UI badges and preserves verbose native text separately', async () => {
  const longDescription = `<p>${'Legal pay disclosure sentence. '.repeat(30)}</p>`;
  const greenhousePayload = { jobs: [{
    id: 301,
    absolute_url: 'https://boards.greenhouse.io/acme/jobs/301',
    title: 'Money Role',
    first_published: '2026-10-01T10:00:00Z',
    content: '&lt;p&gt;Body with pay disclosure retained.&lt;/p&gt;',
  }] };
  const greenhouseDetail = {
    ...greenhousePayload.jobs[0],
    pay_input_ranges: [{ min_cents: 12000000, max_cents: 15000000, currency_type: 'USD', title: 'United States Annual Range', blurb: longDescription }],
  };
  await withFetch(async (url) => url.endsWith('/jobs?content=true') ? json(greenhousePayload) : json(greenhouseDetail), async () => {
    const record = (await new AtsPublicBoardConnector('greenhouse').fetchPage(context('greenhouse', ['acme']))).records[0];
    assert.deepEqual(record.sourceMetadata.salary, { min: 120000, max: 150000, currency: 'USD', period: 'YEAR', originalText: '120000 – 150000 USD YEAR' });
    assert.ok(record.sourceMetadata.nativeSalaryText.length > 600);
    assert.equal(record.sourceMetadata.salary.originalText.length < 32, true);
  });

  const leverPayload = [{
    id: 'lev-compact',
    text: 'Compact Lever',
    hostedUrl: 'https://jobs.lever.co/acme/lev-compact',
    description: '<p>Role.</p>',
    salaryDescription: longDescription,
    salaryRange: { min: 5000, max: 7000, currency: 'USD', interval: 'per-month-salary' },
  }];
  await withFetch(async () => json(leverPayload), async () => {
    const record = (await new AtsPublicBoardConnector('lever').fetchPage(context('lever', ['acme']))).records[0];
    assert.deepEqual(record.sourceMetadata.salary, { min: 5000, max: 7000, currency: 'USD', period: 'MONTH', originalText: '5000 – 7000 USD MONTH' });
    assert.ok(record.sourceMetadata.nativeSalaryText.length > 600);
    assert.equal(record.sourceMetadata.salaryIntervalRaw, 'per-month-salary');
  });
});

test('ATS salary fallback uses human text when numeric range is absent and ignores equity-only tier summaries', async () => {
  const leverPayload = [{
    id: 'lev-human',
    text: 'Human Salary Text',
    hostedUrl: 'https://jobs.lever.co/acme/lev-human',
    description: '<p>Role.</p>',
    salaryDescription: '<p>Competitive salary based on location and experience.</p>',
    salaryRange: { currency: 'USD', interval: 'per-year-salary' },
  }];
  await withFetch(async () => json(leverPayload), async () => {
    const record = (await new AtsPublicBoardConnector('lever').fetchPage(context('lever', ['acme']))).records[0];
    assert.deepEqual(record.sourceMetadata.salary, { currency: 'USD', period: 'YEAR', originalText: 'Competitive salary based on location and experience.' });
    assert.equal(record.sourceMetadata.nativeSalaryText, 'Competitive salary based on location and experience.');
  });

  const ashbyPayload = { jobs: [{
    id: 'ash-tier-summary',
    title: 'Tier Summary Only',
    location: 'Remote',
    publishedAt: '2026-03-04T02:08:44.483+00:00',
    isRemote: true,
    workplaceType: 'Remote',
    jobUrl: 'https://jobs.ashbyhq.com/acme/ash-tier-summary',
    descriptionHtml: '<p>Equity tier summary only.</p>',
    compensation: {
      compensationTierSummary: 'Equity and bonus vary by tier.',
      compensationTiers: [{ name: 'Equity tier', summaryComponents: [{ type: 'Equity', minValue: 1, maxValue: 2 }] }],
      summaryComponents: [{ type: 'Equity', minValue: 1, maxValue: 2, currencyCode: 'USD' }],
    },
  }] };
  await withFetch(async () => json(ashbyPayload), async () => {
    const record = (await new AtsPublicBoardConnector('ashby').fetchPage(context('ashby', ['acme']))).records[0];
    assert.equal(record.sourceMetadata.salary, undefined);
    assert.equal(record.sourceMetadata.nativeSalaryText, undefined);
    assert.equal(record.sourceMetadata.nativeCompensationSummary, 'Equity and bonus vary by tier.');
  });
});

test('Ashby does not promote equity or bonus components into salary', async () => {
  const payload = { jobs: [{
    id: 'ash-equity',
    title: 'Equity Only Role',
    location: 'Remote',
    publishedAt: '2026-03-04T02:08:44.483+00:00',
    isRemote: true,
    workplaceType: 'Remote',
    jobUrl: 'https://jobs.ashbyhq.com/acme/ash-equity',
    descriptionHtml: '<p>Equity only public compensation.</p>',
    compensation: {
      compensationTiers: [{ name: 'Tier A', summaryComponents: [{ type: 'Equity', minValue: 1, maxValue: 2 }] }],
      summaryComponents: [{ type: 'Equity', minValue: 1, maxValue: 2, currencyCode: 'USD' }, { type: 'Bonus', minValue: 1000, maxValue: 2000, currencyCode: 'USD' }],
    },
  }] };
  await withFetch(async () => json(payload), async () => {
    const record = (await new AtsPublicBoardConnector('ashby').fetchPage(context('ashby', ['acme']))).records[0];
    assert.equal(record.sourceMetadata.salary, undefined);
    assert.equal(record.sourceMetadata.nativeSalaryText, undefined);
    assert.deepEqual(record.sourceMetadata.compensationSummaryComponents, payload.jobs[0].compensation.summaryComponents);
    assert.deepEqual(record.sourceMetadata.compensationTiers, payload.jobs[0].compensation.compensationTiers);
  });
});

test('ATS native records normalize source facts into canonical fields', async () => {
  await withFetch(async () => json([{ id: 'lev-2', text: 'Backend Engineer', hostedUrl: 'https://jobs.lever.co/acme/lev-2', description: '<p>Backend role.</p>', workplaceType: 'remote', categories: { location: 'Remote', commitment: 'Contract' } }]), async () => {
    const record = (await new AtsPublicBoardConnector('lever').fetchPage(context('lever', ['acme']))).records[0];
    const normalized = new SourceNormalizerService().normalize(context('lever', ['acme']).source, record);
    assert.equal(normalized.location, 'Remote');
    assert.equal(normalized.remoteType, 'remote');
    assert.equal(normalized.employmentType, 'Contract');
  });
});

test('ATS providers reject missing stable ids and unexpected payload shapes instead of inventing records', async () => {
  await withFetch(async () => json([{ text: 'No stable id', hostedUrl: 'https://jobs.lever.co/acme/no-id' }]), async () => {
    await assert.rejects(() => new AtsPublicBoardConnector('lever').fetchPage(context('lever', ['acme'])), /missing its stable id/);
  });
  await withFetch(async () => json({ jobs: [{ title: 'No stable id', jobUrl: 'https://jobs.ashbyhq.com/acme/no-id' }] }), async () => {
    await assert.rejects(() => new AtsPublicBoardConnector('ashby').fetchPage(context('ashby', ['acme'])), /missing its stable id/);
  });
  await withFetch(async () => json({ jobs: [{ title: 'No stable id', absolute_url: 'https://boards.greenhouse.io/acme/jobs/no-id' }] }), async () => {
    await assert.rejects(() => new AtsPublicBoardConnector('greenhouse').fetchPage(context('greenhouse', ['acme'])), /missing its stable id/);
  });
});
