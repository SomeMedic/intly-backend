import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { RssFeedConnector } = require('../src/modules/sources/connectors/rss-feed.connector.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

function ctx(overrides = {}) {
  return {
    source: { _id: 'weworkremotely', name: 'We Work Remotely', timeoutMs: 1_000 },
    requestId: 'rss-wwr-native-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function response(body) {
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

function connector(xml) {
  return new RssFeedConnector('weworkremotely', 'https://weworkremotely.com/remote-jobs.rss', async () => response(xml));
}

function feed(items) {
  return `<?xml version="1.0"?><rss><channel>${items.join('\n')}</channel></rss>`;
}

function item({
  title = 'AssemblyAI: Senior Research Engineer',
  guid = 'https://weworkremotely.com/remote-jobs/assemblyai-senior-research-engineer',
  type = 'Full-Time',
  skills = 'JAX, TPUs, and Python',
  category = 'Design',
  region = 'Anywhere in the World',
  country = '',
  state = '',
  description = '&lt;p&gt;&lt;strong&gt;Headquarters:&lt;/strong&gt; Remote&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Own JAX training&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;&lt;strong&gt;To apply:&lt;/strong&gt; &lt;a href="https://weworkremotely.com/remote-jobs/assemblyai-senior-research-engineer"&gt;Apply&lt;/a&gt;&lt;/p&gt;',
  pubDate = 'Sun, 04 Oct 2026 07:31:28 +0000',
  expiresAt = 'Tue, 03 Nov 2026 07:31:28 +0000',
} = {}) {
  return `<item>
    <title>${title}</title>
    <region>${region}</region>
    <country>${country}</country>
    <state>${state}</state>
    <skills>${skills}</skills>
    <category>${category}</category>
    <type>${type}</type>
    <description>${description}</description>
    <pubDate>${pubDate}</pubDate>
    <expires_at>${expiresAt}</expires_at>
    <guid>${guid}</guid>
    <link>${guid}</link>
  </item>`;
}

test('WWR RSS maps declared native fields without losing rich feed body or mutating raw payload', async () => {
  const page = await connector(feed([item()])).fetchPage(ctx());

  assert.equal(page.hasMore, false);
  assert.equal(page.checkpoint.hasMore, false);
  assert.equal(page.checkpoint.terminalReason, 'finite-feed-exhausted');
  assert.equal(page.checkpoint.backfillSince, '2026-09-01T00:00:00.000Z');
  assert.equal(page.checkpoint.seen, 1);
  assert.equal(page.checkpoint.retained, 1);
  assert.equal(typeof page.checkpoint.windowUntil, 'string');
  assert.equal(page.records.length, 1);
  const record = page.records[0];
  assert.equal(record.externalId, 'https://weworkremotely.com/remote-jobs/assemblyai-senior-research-engineer');
  assert.equal(record.title, 'Senior Research Engineer');
  assert.equal(record.companyOrClient, 'AssemblyAI');
  assert.match(record.description, /^<p><strong>Headquarters:<\/strong> Remote<\/p>/);
  assert.match(record.description, /<ul><li>Own JAX training<\/li><\/ul>/);
  assert.match(record.description, /<strong>To apply:<\/strong>/);
  assert.doesNotMatch(record.description, /&lt;p&gt;/);
  assert.equal(record.rawPayload.title, 'AssemblyAI: Senior Research Engineer');
  assert.match(record.rawPayload.description, /&lt;p&gt;/);
  assert.equal(record.sourceMetadata.remoteType, 'remote');
  assert.equal(record.sourceMetadata.area, 'Anywhere in the World');
  assert.equal(record.sourceMetadata.region, 'Anywhere in the World');
  assert.equal(record.sourceMetadata.category, 'Design');
  assert.equal(record.sourceMetadata.nativeCategory, 'Design');
  assert.equal(record.sourceMetadata.employment, 'Full-Time');
  assert.equal(record.sourceMetadata.nativeType, 'Full-Time');
  assert.deepEqual(record.sourceMetadata.skills, ['JAX', 'TPUs', 'Python']);
  assert.deepEqual(record.sourceMetadata.nativeSkills, ['JAX', 'TPUs', 'Python']);
  assert.equal(record.sourceMetadata.nativeSkillsText, 'JAX, TPUs, and Python');
  assert.equal(record.sourceMetadata.deadlineAt, '2026-11-03T07:31:28.000Z');

  const normalized = new SourceNormalizerService().normalize({
    _id: 'weworkremotely',
    connectorFamily: 'OfficialFeed',
    group: 'vacancies',
    name: 'We Work Remotely',
  }, record);
  assert.equal(normalized.employmentType, 'Full-Time');
  assert.equal(normalized.remoteType, 'remote');
  assert.equal(normalized.location, 'Anywhere in the World');
  assert.deepEqual(normalized.skills, ['JAX', 'TPUs', 'Python']);
  assert.equal(normalized.deadline.toISOString(), '2026-11-03T07:31:28.000Z');
});

test('WWR RSS only splits company from a declared title prefix and preserves declared Contract type', async () => {
  const page = await connector(feed([
    item({
      title: 'Principal Product Designer',
      guid: 'https://weworkremotely.com/remote-jobs/acme-principal-product-designer',
      type: 'Contract',
      skills: '',
      category: 'Product',
      region: 'Remote, US',
      country: 'United States',
      state: 'CA',
    }),
  ])).fetchPage(ctx());

  const record = page.records[0];
  assert.equal(record.title, 'Principal Product Designer');
  assert.equal(record.companyOrClient, undefined);
  assert.equal(record.sourceMetadata.employment, 'Contract');
  assert.equal(record.sourceMetadata.country, 'United States');
  assert.equal(record.sourceMetadata.state, 'CA');
  assert.equal(record.sourceMetadata.skills, undefined);

  const normalized = new SourceNormalizerService().normalize({
    _id: 'weworkremotely',
    connectorFamily: 'OfficialFeed',
    group: 'vacancies',
    name: 'We Work Remotely',
  }, record);
  assert.equal(normalized.employmentType, 'Contract');
  assert.equal(normalized.location, 'Remote, US');
});

test('WWR RSS reuses checkpoint windowUntil, filters known future timestamps and keeps unknown dates', async () => {
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-04T12:00:00.000Z');
    const first = await connector(feed([
      item({
        title: 'Acme: Current Role',
        guid: 'https://weworkremotely.com/remote-jobs/acme-current-role',
        pubDate: 'Sun, 04 Oct 2026 11:30:00 +0000',
      }),
    ])).fetchPage(ctx({ backfillSince: '2026-09-04T00:00:00.000Z' }));

    assert.equal(first.checkpoint.windowUntil, '2026-10-04T12:00:00.000Z');
    assert.equal(first.checkpoint.backfillSince, '2026-09-04T00:00:00.000Z');

    Date.now = () => Date.parse('2026-10-20T12:00:00.000Z');
    const second = await connector(feed([
      item({
        title: 'Acme: Future Role',
        guid: 'https://weworkremotely.com/remote-jobs/acme-future-role',
        pubDate: 'Sun, 04 Oct 2026 12:00:01 +0000',
      }),
      item({
        title: 'Acme: Unknown Date Role',
        guid: 'https://weworkremotely.com/remote-jobs/acme-unknown-date-role',
        pubDate: '',
      }),
      item({
        title: 'Acme: Current Role',
        guid: 'https://weworkremotely.com/remote-jobs/acme-current-role',
        pubDate: 'Sun, 04 Oct 2026 11:30:00 +0000',
      }),
    ])).fetchPage(ctx({
      checkpoint: first.checkpoint,
      backfillSince: '2026-09-04T00:00:00.000Z',
    }));

    assert.deepEqual(second.records.map((record) => record.title), ['Unknown Date Role', 'Current Role']);
    assert.equal(second.records[0].publishedAt, undefined);
    assert.equal(second.checkpoint.windowUntil, '2026-10-04T12:00:00.000Z');
    assert.equal(second.checkpoint.backfillSince, '2026-09-04T00:00:00.000Z');
    assert.equal(second.checkpoint.hasMore, false);
    assert.equal(second.checkpoint.terminalReason, 'finite-feed-exhausted');
    assert.equal(second.checkpoint.seen, 3);
    assert.equal(second.checkpoint.retained, 2);
    assert.equal(second.stats.seen, 2);
  } finally {
    Date.now = originalNow;
  }
});

test('WWR RSS starts a new terminal window when requested lower bound changes', async () => {
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-04T12:00:00.000Z');
    const oldWindow = await connector(feed([
      item({
        title: 'Acme: Old Window Role',
        guid: 'https://weworkremotely.com/remote-jobs/acme-old-window-role',
        pubDate: 'Sun, 04 Oct 2026 11:30:00 +0000',
      }),
    ])).fetchPage(ctx({ backfillSince: '2026-09-04T00:00:00.000Z' }));

    assert.equal(oldWindow.checkpoint.windowUntil, '2026-10-04T12:00:00.000Z');

    Date.now = () => Date.parse('2026-10-20T12:00:00.000Z');
    const newWindow = await connector(feed([
      item({
        title: 'Acme: Newly Published Role',
        guid: 'https://weworkremotely.com/remote-jobs/acme-newly-published-role',
        pubDate: 'Sun, 04 Oct 2026 12:00:01 +0000',
      }),
    ])).fetchPage(ctx({
      checkpoint: oldWindow.checkpoint,
      backfillSince: '2026-10-01T00:00:00.000Z',
    }));

    assert.deepEqual(newWindow.records.map((record) => record.title), ['Newly Published Role']);
    assert.equal(newWindow.checkpoint.backfillSince, '2026-10-01T00:00:00.000Z');
    assert.equal(newWindow.checkpoint.windowUntil, '2026-10-20T12:00:00.000Z');
    assert.equal(newWindow.checkpoint.seen, 1);
    assert.equal(newWindow.checkpoint.retained, 1);
  } finally {
    Date.now = originalNow;
  }
});
