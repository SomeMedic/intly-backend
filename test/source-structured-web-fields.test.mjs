import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { WebExtractionService } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

const extraction = new WebExtractionService();
const normalizer = new SourceNormalizerService();

describe('structured public web JobPosting fields', () => {
  it('extracts JobPosting structured fields and normalizes them to canonical fields', () => {
    const job = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Backend Platform Engineer',
      description: '<p>Build APIs</p><ul><li>Own Node.js services</li><li>Improve Postgres</li></ul',
      datePosted: '2026-10-01T10:00:00+03:00',
      validThrough: '2026-10-30T23:59:59+03:00',
      hiringOrganization: { '@type': 'Organization', name: 'Acme Tech' },
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: { '@type': 'QuantitativeValue', minValue: 5000, maxValue: 7000, unitText: 'MONTH' },
      },
      jobLocation: {
        '@type': 'Place',
        address: { '@type': 'PostalAddress', addressLocality: 'Berlin', addressCountry: 'DE' },
      },
      applicantLocationRequirements: { '@type': 'Country', name: 'Germany' },
      employmentType: ['FULL_TIME', 'CONTRACTOR'],
      jobLocationType: 'TELECOMMUTE',
      skills: ['Node.js', 'Postgres'],
    };

    const record = extraction.documentToRecord(documentWithJsonLd(job), sourceInput());
    const normalized = normalizer.normalize(source(), record);

    assert.equal(record.title, 'Backend Platform Engineer');
    assert.equal(record.companyOrClient, 'Acme Tech');
    assert.match(record.description, /Build APIs/);
    assert.match(record.description, /- Own Node\.js services/);
    assert.doesNotMatch(record.description, /<\/ul/);
    assert.deepEqual(record.rawPayload.jsonLd, job);
    assert.equal(record.rawPayload.rawDescription, job.description);
    assert.deepEqual(record.sourceMetadata.salary, { originalText: '5000 – 7000 USD MONTH', min: 5000, max: 7000, currency: 'USD', period: 'MONTH' });
    assert.deepEqual(record.sourceMetadata.skills, ['Node.js', 'Postgres']);
    assert.equal(record.sourceMetadata.deadlineAt, '2026-10-30T20:59:59.000Z');

    assert.deepEqual(normalized.money, { originalText: '5000 – 7000 USD MONTH', min: 5000, max: 7000, currency: 'USD', period: 'MONTH' });
    assert.equal(normalized.location, 'Berlin, DE, Germany');
    assert.equal(normalized.remoteType, 'TELECOMMUTE');
    assert.equal(normalized.employmentType, 'FULL_TIME, CONTRACTOR');
    assert.deepEqual(normalized.skills, ['Node.js', 'Postgres']);
    assert.equal(normalized.deadline.toISOString(), '2026-10-30T20:59:59.000Z');
  });

  it('strips placeholder location parts while preserving valid country', () => {
    const record = extraction.documentToRecord(documentWithJsonLd({
      '@type': 'JobPosting',
      title: 'Budu Backend',
      description: 'Build marketplace services',
      baseSalary: { '@type': 'MonetaryAmount', currency: 'RUB', value: { '@type': 'QuantitativeValue', value: 50000, unitText: 'MONTH' } },
      jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: '—', addressCountry: 'Россия' } },
      employmentType: 'FULL_TIME',
      jobLocationType: 'TELECOMMUTE',
      validThrough: '2026-10-30',
    }), sourceInput());
    const normalized = normalizer.normalize(source(), record);

    assert.equal(record.sourceMetadata.area, 'Россия');
    assert.deepEqual(record.sourceMetadata.locations, ['Россия']);
    assert.deepEqual(record.sourceMetadata.salary, { originalText: '50000 RUB MONTH', min: 50000, max: 50000, currency: 'RUB', period: 'MONTH' });
    assert.equal(record.sourceMetadata.employment, 'FULL_TIME');
    assert.equal(record.sourceMetadata.schedule, 'TELECOMMUTE');
    assert.equal(record.sourceMetadata.deadlineAt, undefined);
    assert.equal(normalized.location, 'Россия');
  });

  it('keeps ordinary less-than prose and decodes numeric entities while removing real tags', () => {
    const record = extraction.documentToRecord(documentWithJsonLd({
      '@type': 'JobPosting',
      title: 'Language Runtime Engineer',
      description: '<p>TypeScript &lt; JavaScript for this role and latency &#60; 10 ms.</p><ul><li>Keep <strong>APIs</strong> fast</li></ul',
    }), sourceInput());

    assert.match(record.description, /TypeScript < JavaScript/);
    assert.match(record.description, /latency < 10 ms/);
    assert.match(record.description, /- Keep APIs fast/);
    assert.doesNotMatch(record.description, /strong/);
    assert.match(record.rawPayload.rawDescription, /&lt; JavaScript/);
  });

  it('selects a real JobPosting across all JSON-LD scripts and graphs', () => {
    const html = `
      <script type="application/ld+json">{"@type":"Organization","name":"Wrong Org"}</script>
      <script type="application/ld+json">{
        "@context":"https://schema.org",
        "@graph":[
          {"@type":"BreadcrumbList","name":"Breadcrumbs"},
          {"@type":"JobPosting","title":"Frontend Engineer","description":"Build UI","hiringOrganization":{"name":"Right Org"}}
        ]
      }</script>
    `;

    const record = extraction.documentToRecord({ finalUrl: 'https://jobs.example.test/jobs/frontend-engineer', html, metadata: { firecrawl: false } }, sourceInput());

    assert.equal(record.title, 'Frontend Engineer');
    assert.equal(record.companyOrClient, 'Right Org');
    assert.equal(record.description, 'Build UI');
    assert.equal(record.rawPayload.jsonLd['@type'], 'JobPosting');
  });

  it('keeps unknown structured dates and nonnumeric money absent without inference', () => {
    const record = extraction.documentToRecord(documentWithJsonLd({
      '@type': 'JobPosting',
      title: 'QA Analyst',
      description: 'Test product quality',
      validThrough: '2026-10-30T12:00:00',
      baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', unitText: 'LIGHTYEAR' } },
      jobLocationType: 'TELECOMMUTE',
      skills: 'Testing, QA',
    }), sourceInput());
    const normalized = normalizer.normalize(source(), record);

    assert.equal(record.sourceMetadata.deadlineAt, undefined);
    assert.deepEqual(record.sourceMetadata.salary, { originalText: 'USD LIGHTYEAR', currency: 'USD', period: 'LIGHTYEAR' });
    assert.deepEqual(normalized.money, { originalText: 'USD LIGHTYEAR', currency: 'USD', period: 'LIGHTYEAR' });
    assert.equal(normalized.deadline, undefined);
    assert.deepEqual(normalized.skills, ['Testing', 'QA']);
  });

  it('cleans malformed HTML descriptions without pulling navigation boilerplate', () => {
    const record = extraction.documentToRecord({
      finalUrl: 'https://jobs.example.test/jobs/geekjob-like-backend',
      metadata: { firecrawl: false },
      html: `
        <script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title: 'GeekJob Backend',
          description: '<nav>Jobs Login</nav><p>Main responsibility</p><ul><li>TypeScript</li><li>Queues</li></ul',
        })}</script>
      `,
    }, sourceInput());

    assert.match(record.description, /Main responsibility/);
    assert.match(record.description, /- TypeScript/);
    assert.doesNotMatch(record.description, /Jobs Login/);
    assert.doesNotMatch(record.description, /<\/ul/);
  });
});

function documentWithJsonLd(jsonLd) {
  return {
    finalUrl: 'https://jobs.example.test/jobs/backend-platform-engineer',
    html: `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
    metadata: { firecrawl: false },
  };
}

function sourceInput() {
  return { sourceId: 'structured-web', sourceName: 'Structured Web', type: 'vacancy', requireOpportunitySignal: true };
}

function source() {
  return { _id: 'structured-web', name: 'Structured Web', connectorFamily: 'PublicHtml', group: 'jobs' };
}
