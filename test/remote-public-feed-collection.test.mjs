import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { PublicApiFeedConnector } = require('../src/modules/sources/connectors/public-api-feed.connector.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, 'fixtures', 'remote-public-feeds');
const remoteOkFixture = JSON.parse(readFileSync(join(fixtures, 'remoteok.json'), 'utf8'));
const remotiveFixture = JSON.parse(readFileSync(join(fixtures, 'remotive.json'), 'utf8'));

function ctx(overrides = {}) {
  return {
    source: {
      _id: 'remote-feed-test',
      name: 'Remote feed test',
      connectorFamily: 'OfficialRestApi',
      endpoint: {},
      config: {},
      timeoutMs: 30_000,
      ...overrides.source,
    },
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
    requestId: 'remote-feed-test',
    ...overrides,
  };
}

function connector(id, payload) {
  const instance = new PublicApiFeedConnector(id);
  instance.getJson = async () => payload;
  return instance;
}

describe('Remote public finite feeds', () => {
  it('collects RemoteOK valid records without fabricated salary and with frozen finite-feed checkpoint', async () => {
    const page = await connector('remoteok', remoteOkFixture).fetchPage(ctx());

    assert.deepEqual(page.records.map((record) => record.externalId), ['remote-new', 'remote-paid', 'remote-epoch', 'remote-naive', 'remote-unknown']);
    const first = page.records[0];
    assert.equal(first.title, 'Senior Backend Engineer');
    assert.equal(first.description, 'Build public APIs.');
    assert.equal(first.publishedAt.toISOString(), '2026-10-01T12:00:00.000Z');
    assert.deepEqual(first.sourceMetadata.skills, ['node', 'typescript']);
    assert.equal(first.sourceMetadata.remoteType, 'remote');
    assert.equal(first.sourceMetadata.salary, undefined);

    const paid = page.records[1];
    assert.deepEqual(paid.sourceMetadata.salary, { min: 120000, max: 180000 });
    assert.deepEqual(paid.sourceMetadata.rawSalary, { salary_min: 120000, salary_max: 180000 });
    assert.equal(paid.sourceMetadata.location, 'Europe');
    assert.deepEqual(normalize('remoteok', paid).money, { min: 120000, max: 180000 });

    const epoch = page.records[2];
    assert.equal(epoch.publishedAt.toISOString(), '2026-09-21T14:13:20.000Z');

    const naive = page.records[3];
    assert.equal(naive.publishedAt, undefined);
    assert.equal(naive.sourceMetadata.location, undefined);

    assert.equal(page.hasMore, false);
    assert.equal(page.checkpoint.provider, 'remoteok');
    assert.equal(page.checkpoint.scope, 'official-public-finite-feed');
    assert.equal(page.checkpoint.windowFrom, '2026-09-04T00:00:00.000Z');
    assert.match(page.checkpoint.windowTo, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(page.checkpoint.seen, 7);
    assert.equal(page.checkpoint.retained, 5);
    assert.equal(page.checkpoint.terminalReason, 'finite-feed-exhausted');
    assert.equal(page.checkpoint.nativeFeedMetadata.legal, 'remoteok public api metadata');
  });

  it('collects Remotive records while treating naive publication_date as raw unknown-date metadata', async () => {
    const page = await connector('remotive', remotiveFixture).fetchPage(ctx());

    assert.deepEqual(page.records.map((record) => record.externalId), ['1001', '1002']);
    const first = page.records[0];
    assert.equal(first.publishedAt, undefined);
    assert.equal(first.sourceMetadata.publicationDateRaw, '2026-10-02T09:15:00');
    assert.equal(first.sourceMetadata.publicationDateTimezone, 'unspecified');
    assert.deepEqual(first.sourceMetadata.skills, ['Python', 'Django']);
    assert.equal(first.sourceMetadata.category, 'Software Development');
    assert.equal(first.sourceMetadata.categories, undefined);
    assert.deepEqual(normalize('remotive', first).skills, ['Python', 'Django']);
    assert.equal(first.sourceMetadata.location, 'Worldwide');
    assert.equal(first.sourceMetadata.employment, 'full_time');
    assert.equal(first.sourceMetadata.remoteType, 'remote');
    assert.deepEqual(first.sourceMetadata.salary, { originalText: '$100k-$140k' });

    const oldNaive = page.records[1];
    assert.equal(oldNaive.publishedAt, undefined);
    assert.equal(oldNaive.sourceMetadata.publicationDateTimezone, 'unspecified');
    assert.equal(page.checkpoint.provider, 'remotive');
    assert.equal(page.checkpoint.seen, 3);
    assert.equal(page.checkpoint.retained, 2);
    assert.equal(page.checkpoint.nativeFeedMetadata['job-count'], 3);
  });

  it('accepts genuinely empty valid feeds but rejects malformed provider payloads and fabricated jobs', async () => {
    assert.deepEqual((await connector('remoteok', []).fetchPage(ctx())).records, []);
    assert.deepEqual((await connector('remotive', { jobs: [] }).fetchPage(ctx())).records, []);

    await assert.rejects(() => connector('remoteok', { jobs: [] }).fetchPage(ctx()), /remoteok API returned malformed payload/);
    await assert.rejects(() => connector('remoteok', [{ id: 'x', position: 'Missing description' }]).fetchPage(ctx()), /missing required description/);
    await assert.rejects(() => connector('remoteok', [null]).fetchPage(ctx()), /malformed item/);

    await assert.rejects(() => connector('remotive', {}).fetchPage(ctx()), /jobs must be an array/);
    await assert.rejects(() => connector('remotive', { jobs: [{ id: 1, title: 'Missing description' }] }).fetchPage(ctx()), /missing required description/);
    await assert.rejects(() => connector('remotive', { jobs: [null] }).fetchPage(ctx()), /malformed job/);
    await assert.rejects(() => connector('remotive', { 'job-count': 2, jobs: [{ id: 1, title: 'One', description: 'One description' }] }).fetchPage(ctx()), /declared job-count 2/);
  });
});

function normalize(sourceId, record) {
  return new SourceNormalizerService().normalize({ _id: sourceId, name: sourceId, connectorFamily: 'OfficialRestApi', group: 'web' }, record);
}
