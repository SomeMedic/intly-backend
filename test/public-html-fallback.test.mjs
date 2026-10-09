import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { GenericPublicWebConnector } = require('../src/modules/sources/connectors/generic-public-web.connector.ts');
const { WebExtractionService } = require('../src/modules/sources/extraction/web-extraction.service.ts');

describe('generic public HTML fallback', () => {
  it('extracts all valid detail candidates from a listing without cardinality maxPages cap', async () => {
    const baseUrl = 'https://example.test/jobs/';
    const pages = {
      [baseUrl]: Array.from({ length: 12 }, (_, index) => `<a href="/jobs/backend-${index + 1}">Backend ${index + 1}</a>`).join(''),
      ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
        const id = index + 1;
        return [`https://example.test/jobs/backend-${id}`, jobDetail(`Backend ${id}`, `Example ${id}`)];
      })),
    };
    const result = await new GenericPublicWebConnector(new FakeWebExtraction(pages)).fetchPage(ctx(baseUrl, { maxPages: 2 }));

    assert.equal(result.records.length, 12);
    assert.equal(result.records[0].title, 'Backend 1');
    assert.equal(result.hasMore, false);
  });

  it('does not emit catalog, login, or marketing pages as fake opportunities', async () => {
    const baseUrl = 'https://example.test/jobs/';
    const pages = {
      [baseUrl]: `
        <h1>Jobs</h1>
        <a href="/login">Login</a>
        <a href="/catalog/jobs">Catalog</a>
        <a href="/marketing/careers">Marketing</a>
        <p>Find work with us.</p>
      `,
    };

    await assert.rejects(
      () => new GenericPublicWebConnector(new FakeWebExtraction(pages)).fetchPage(ctx(baseUrl)),
      /No concrete opportunity detail found/,
    );
  });

  it('rejects landing pages even when marketing copy contains apply and salary words', async () => {
    const service = new WebExtractionService();
    for (const document of [
      {
        finalUrl: 'https://example.test/careers',
        html: '<h1>Find your next job</h1><main><p>Apply now and explore salary benefits while you hire developers.</p></main>',
        metadata: {},
      },
      {
        finalUrl: 'https://example.test/vacancies',
        html: '<h1>Вакансии</h1><main><p>Зарплата, требования и откликнуться на лучшие предложения рынка.</p></main>',
        metadata: {},
      },
    ]) {
      assert.throws(
        () => service.documentToRecord(document, { sourceId: 'generic', sourceName: 'Generic', type: 'vacancy', requireOpportunitySignal: true }),
        /No concrete opportunity detail found/,
      );
    }
  });

  it('requires useful JobPosting fields but accepts real slug details without numeric ids', () => {
    const service = new WebExtractionService();

    assert.throws(
      () => service.documentToRecord(
        {
          finalUrl: 'https://example.test/jobs/backend-platform',
          html: '<script type="application/ld+json">{ "@type": "JobPosting", "title": "Backend Platform Engineer" }</script>',
          metadata: {},
        },
        { sourceId: 'generic', sourceName: 'Generic', type: 'vacancy', requireOpportunitySignal: true },
      ),
      /No concrete opportunity detail found/,
    );

    const record = service.documentToRecord(
      {
        finalUrl: 'https://example.test/jobs/backend-platform',
        html: '<h1>Backend Platform Engineer</h1><main><p>Apply to build APIs. Requirements: TypeScript, remote team, company product.</p></main>',
        metadata: {},
      },
      { sourceId: 'generic', sourceName: 'Generic', type: 'vacancy', requireOpportunitySignal: true },
    );

    assert.equal(record.title, 'Backend Platform Engineer');
  });

  it('selects JobPosting from JSON-LD arrays and @graph instead of Organization or breadcrumbs', () => {
    const record = new WebExtractionService().documentToRecord(
      {
        finalUrl: 'https://example.test/jobs/backend-1',
        html: `
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@graph": [
                { "@type": "Organization", "name": "Example Org" },
                { "@type": "BreadcrumbList", "name": "Jobs" },
                {
                  "@type": "JobPosting",
                  "title": "Senior Backend Engineer",
                  "description": "Build APIs",
                  "hiringOrganization": { "name": "Hiring Team" },
                  "datePosted": "2026-10-01"
                }
              ]
            }
          </script>
        `,
        metadata: {},
      },
      { sourceId: 'generic', sourceName: 'Generic', type: 'vacancy', requireOpportunitySignal: true },
    );

    assert.equal(record.title, 'Senior Backend Engineer');
    assert.equal(record.companyOrClient, 'Hiring Team');
    assert.equal(record.publishedAt?.toISOString(), '2026-10-01T00:00:00.000Z');
  });

  it('continues generic listing pagination durably until observed exhaustion', async () => {
    const baseUrl = 'https://example.test/jobs/';
    const webExtraction = new FakeWebExtraction({
      [baseUrl]: `
        <a href="/jobs/backend-1">Backend 1</a>
        <a href="/jobs/backend-2">Backend 2</a>
        <a rel="next" href="/jobs/?page=2">Next</a>
      `,
      'https://example.test/jobs/backend-1': jobDetail('Backend 1', 'Example 1'),
      'https://example.test/jobs/backend-2': jobDetail('Backend 2', 'Example 2'),
      'https://example.test/jobs/?page=2': '<a href="/jobs/backend-3">Backend 3</a>',
      'https://example.test/jobs/backend-3': jobDetail('Backend 3', 'Example 3'),
    });
    const connector = new GenericPublicWebConnector(webExtraction);

    const first = await connector.fetchPage(ctx(baseUrl, { maxPages: 1 }));
    const second = await connector.fetchPage(ctx(baseUrl, { maxPages: 1 }, first.checkpoint));

    assert.deepEqual(first.records.map((record) => record.title), ['Backend 1', 'Backend 2']);
    assert.equal(first.hasMore, true);
    assert.deepEqual(second.records.map((record) => record.title), ['Backend 3']);
    assert.equal(second.hasMore, false);
  });

  it('fails the page when a discovered detail fetch fails so the checkpoint can be retried', async () => {
    const baseUrl = 'https://example.test/jobs/';
    const webExtraction = new FakeWebExtraction({
      [baseUrl]: `
        <a href="/jobs/backend-1">Backend 1</a>
        <a href="/jobs/backend-2">Backend 2</a>
      `,
      'https://example.test/jobs/backend-1': jobDetail('Backend 1', 'Example 1'),
    });

    await assert.rejects(
      () => new GenericPublicWebConnector(webExtraction).fetchPage(ctx(baseUrl)),
      /Unexpected URL https:\/\/example\.test\/jobs\/backend-2/,
    );
    assert.deepEqual(webExtraction.requests, [
      baseUrl,
      'https://example.test/jobs/backend-1',
      'https://example.test/jobs/backend-2',
    ]);
  });
});

class FakeWebExtraction {
  requests = [];
  service = new WebExtractionService();

  constructor(pages) {
    this.pages = pages;
  }

  async extractUrl(url) {
    const finalUrl = new URL(url).toString();
    this.requests.push(finalUrl);
    const html = this.pages[finalUrl] ?? this.pages[url];
    if (!html) throw new Error(`Unexpected URL ${finalUrl}`);
    return { finalUrl, html, metadata: { firecrawl: false } };
  }

  extractOpportunityLinks(document, allowedHosts, limit) {
    return this.service.extractOpportunityLinks(document, allowedHosts, limit);
  }

  async extractOpportunityFromUrl(url, input) {
    const document = await this.extractUrl(url);
    return this.documentToRecord(document, input);
  }

  documentToRecord(document, input) {
    return this.service.documentToRecord(document, {
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      type: input.type ?? 'vacancy',
      requireOpportunitySignal: input.requireOpportunitySignal,
    });
  }
}

function ctx(baseUrl, limits = {}, checkpoint = {}) {
  return {
    source: {
      _id: 'generic_public',
      name: 'Generic Public',
      endpoint: { baseUrl },
      opportunityTypes: ['vacancy'],
      timeoutMs: 30_000,
      limits,
    },
    requestId: 'test-run',
    checkpoint,
    backfillDays: 30,
  };
}

function jobDetail(title, organization) {
  return `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "JobPosting",
            "title": "${title}",
            "description": "Build production systems",
            "hiringOrganization": { "name": "${organization}" },
            "datePosted": "2026-10-01"
          }
        </script>
      </head>
      <body><h1>${title}</h1><p>Apply now. Requirements: TypeScript.</p></body>
    </html>
  `;
}
