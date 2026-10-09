import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.TS_NODE_PROJECT = resolve(backend, 'tsconfig.json');
const require = createRequire(import.meta.url);
require('../node_modules/ts-node/register/transpile-only');
const { BuiltinConnector } = require('../src/modules/sources/connectors/builtin.connector.ts');
const { decodeBuiltinSeenIds, encodeBuiltinSeenIds } = require('../src/modules/sources/connectors/builtin-seen-ids.ts');
const { builtinListingTaxonomy } = require('../src/modules/sources/connectors/builtin-listing-contract.ts');
const { createBuiltinFrontier, recordBuiltinPartition } = require('../src/modules/sources/connectors/builtin-listing-frontier.ts');
const native = JSON.parse(readFileSync(resolve(backend, 'test/fixtures/builtin-native/frontier-taxonomy.json')));
const allUrl = 'https://builtin.com/jobs?city=&state=&country=USA&allLocations=true';
const since = '2026-09-06T01:23:21.429Z';
const until = '2026-10-06T01:23:21.429Z';
const jobUrl = id => `https://builtin.com/job/native-job/${id}`;

function context(checkpoint) {
  return { source: { _id: 'builtin', group: 'builtin', endpoint: { baseUrl: 'https://builtin.com/jobs' }, config: {}, limits: { perPage: 1 }, timeoutMs: 30000 }, requestId: 'same-original-run', checkpoint, backfillDays: 30, backfillSince: since };
}

function listing(url, ids, changes = {}) {
  const parsed = new URL(url);
  const aliases = parsed.pathname.split('/').filter(Boolean).slice(1);
  const category = native.categoriesFilterOptions.find(item => item.alias === aliases[0]);
  const criteria = { ...native.criteria, pageNumber: Number(parsed.searchParams.get('page') ?? 1), allLocations: parsed.searchParams.get('allLocations') === 'true', categories: category?.id ?? null, ...changes };
  const payload = { ...native, criteria };
  const next = new URL(url); next.searchParams.set('page', String(criteria.pageNumber + 1));
  const last = new URL(url); last.searchParams.set('page', '1000');
  return `<script>Builtin.jobBoardInit(${JSON.stringify(payload)});</script>${ids.map(id => `<article id="job-card-${id}"><a href="${jobUrl(id)}">Native job ${id}</a><p>Public job body.</p></article>`).join('')}<a href="${next.toString().replaceAll('&', '&amp;')}">Next</a><a href="${last.toString().replaceAll('&', '&amp;')}">Last</a>`;
}

function originalCheckpoint() {
  return { mode: 'builtin-public-html-jobs', hasMore: true, baseUrl: 'https://builtin.com/jobs', currentListUrl: 'https://builtin.com/jobs?page=433', nextListUrl: 'https://builtin.com/jobs?page=434', visitedListUrls: ['https://builtin.com/jobs?page=433'], seenExternalIds: ['100', '101'], detailQueue: [{ externalId: '101', url: jobUrl('101'), title: 'Native job 101', rawText: 'Native job 101', listUrl: 'https://builtin.com/jobs?page=433' }], backfillSince: since, windowUntil: until, perPage: 1, seen: 2, retained: 1, maxObservedPage: 1000, paginationCapObserved: true, listingCriteria: { ...native.criteria, allLocations: false, pageNumber: 433 }, listingCriteriaVersion: 1, criteriaVerifiedFromStart: false };
}

class NativeTransport {
  calls = [];
  wrongCountry = false;
  emptyAll = false;
  duplicateAll = false;
  failDetail = false;
  taxonomyDrift = false;
  async extractUrl(url) {
    this.calls.push(url);
    if (new URL(url).pathname.startsWith('/job/')) {
      if (this.failDetail) throw new Error('detail transport failed');
      const id = url.split('/').at(-1);
      return { finalUrl: url, metadata: {}, html: `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url, title: `Native job ${id}`, description: '<p>Full public job body.</p>', datePosted: '2026-10-05', identifier: { value: id } })}</script>` };
    }
    let html = listing(url, url === 'https://builtin.com/jobs?page=434' ? ['100', '103'] : url === allUrl ? this.emptyAll ? [] : this.duplicateAll ? ['100', '101'] : ['100', '104'] : ['205'], this.wrongCountry && url === allUrl ? { country: 'NLD' } : {});
    if (this.taxonomyDrift && url === allUrl) html = html.replace('"alias":"accounting"', '"alias":"accounting-changed"');
    return { finalUrl: url, metadata: {}, html };
  }
}

test('migrates after pending details, preserves frozen run and exact IDs, and rotates native seeds', async () => {
  const transport = new NativeTransport();
  const connector = new BuiltinConnector(transport);
  const original = originalCheckpoint();
  const frozenOriginal = JSON.stringify(original);
  const pending = await connector.fetchPage(context(original));
  assert.deepEqual(transport.calls, [jobUrl('101')]);
  assert.equal(pending.checkpoint.frontier, undefined);
  assert.equal(pending.checkpoint.nextListUrl, original.nextListUrl);
  assert.equal(pending.records[0].externalId, '101');

  const migrated = await connector.fetchPage(context(pending.checkpoint));
  assert.equal(migrated.records[0].externalId, '103');
  assert.equal(migrated.checkpoint.frontier.version, 1);
  assert.equal(migrated.checkpoint.nextListUrl, allUrl);
  assert.equal(migrated.checkpoint.seenExternalIds, undefined);
  assert.deepEqual(decodeBuiltinSeenIds(migrated.checkpoint), ['100', '101', '103']);
  assert.equal(migrated.checkpoint.backfillSince, since);
  assert.equal(migrated.checkpoint.windowUntil, until);
  assert.equal(migrated.checkpoint.criteriaVerifiedFromStart, false);
  assert.deepEqual(migrated.checkpoint.visitedListUrls, ['https://builtin.com/jobs?page=433', 'https://builtin.com/jobs?page=434']);
  const saved = JSON.stringify(migrated.checkpoint);

  const firstGlobal = await connector.fetchPage(context(migrated.checkpoint));
  assert.deepEqual(firstGlobal.records.map(record => record.externalId), ['104']);
  assert.equal(firstGlobal.records[0].sourceMetadata.sourceUrl, allUrl);
  assert.deepEqual(firstGlobal.records[0].sourceMetadata.collectionWindow, { since, until });
  assert.ok(firstGlobal.checkpoint.nextListUrl.includes('/jobs/ai-machine-learning?'));
  assert.match(firstGlobal.checkpoint.frontier.taxonomySha256, /^[a-f0-9]{64}$/);
  assert.equal(firstGlobal.checkpoint.frontier.taxonomySha256, migrated.checkpoint.frontier.taxonomySha256);
  assert.deepEqual(decodeBuiltinSeenIds(firstGlobal.checkpoint), ['100', '101', '103', '104']);
  assert.equal(transport.calls.includes(jobUrl('100')), false);
  assert.equal(JSON.stringify(migrated.checkpoint), saved, 'caller checkpoint mutated');
  assert.equal(JSON.stringify(original), frozenOriginal);
  assert.equal(firstGlobal.hasMore, true);
  assert.notEqual(firstGlobal.checkpoint.catalogComplete, true);
});

test('rejects seed criteria or taxonomy drift and detail failure without committing a partial frontier', async () => {
  const transport = new NativeTransport();
  const connector = new BuiltinConnector(transport);
  const checkpoint = originalCheckpoint(); checkpoint.detailQueue = [];
  const migrated = await connector.fetchPage(context(checkpoint));
  const before = JSON.stringify(migrated.checkpoint);
  transport.wrongCountry = true;
  await assert.rejects(() => connector.fetchPage(context(migrated.checkpoint)), /country/);
  transport.wrongCountry = false; transport.taxonomyDrift = true;
  await assert.rejects(() => connector.fetchPage(context(migrated.checkpoint)), /taxonomy/);
  transport.taxonomyDrift = false; transport.failDetail = true;
  await assert.rejects(() => connector.fetchPage(context(migrated.checkpoint)), /detail transport failed/);
  assert.equal(JSON.stringify(migrated.checkpoint), before);
});

test('unverified empty native branch stays unresolved while other partitions can progress', async () => {
  const transport = new NativeTransport();
  const connector = new BuiltinConnector(transport);
  const checkpoint = originalCheckpoint(); checkpoint.detailQueue = [];
  const migrated = await connector.fetchPage(context(checkpoint));
  transport.emptyAll = true;
  const empty = await connector.fetchPage(context(migrated.checkpoint));
  assert.equal(empty.records.length, 0);
  assert.equal(empty.hasMore, true);
  assert.ok(empty.checkpoint.nextListUrl.includes('/jobs/ai-machine-learning?'));
  assert.ok(JSON.stringify(empty.checkpoint.frontier).includes('unverified-native-empty'));
  assert.notEqual(empty.checkpoint.catalogComplete, true);
  assert.equal(empty.checkpoint.retained, migrated.checkpoint.retained);
  const next = await connector.fetchPage(context(empty.checkpoint));
  assert.equal(next.records[0].externalId, '205');
});

test('advances an overlapping native partition even when every card was already collected elsewhere', async () => {
  const transport = new NativeTransport();
  const connector = new BuiltinConnector(transport);
  const checkpoint = originalCheckpoint(); checkpoint.detailQueue = [];
  const migrated = await connector.fetchPage(context(checkpoint));
  transport.duplicateAll = true;
  const beforeCalls = transport.calls.length;
  const duplicate = await connector.fetchPage(context(migrated.checkpoint));
  assert.deepEqual(transport.calls.slice(beforeCalls), [allUrl]);
  assert.equal(duplicate.records.length, 0);
  assert.equal(duplicate.hasMore, true);
  assert.deepEqual(decodeBuiltinSeenIds(duplicate.checkpoint), decodeBuiltinSeenIds(migrated.checkpoint));
  assert.equal(duplicate.checkpoint.frontier.partitions.baseline.observedPages, 1);
  assert.equal(duplicate.checkpoint.frontierSummary.coverageComplete, false);
});

test('finishes an actual positively empty native Not Specified seed without adding IDs or changing the frozen run', async () => {
  const proof = JSON.parse(readFileSync(resolve(backend, 'test/fixtures/builtin-native/native-remote-empty-proof.json')));
  const empty = proof.cases.find(item => item.key === 'not-specified');
  const html = `<script>Builtin.jobBoardInit(${JSON.stringify({ criteria: empty.criteria, ...empty.taxonomy })});</script><div id="jobs-list">${empty.jobListHtml}</div>`;
  let frontier = createBuiltinFrontier(builtinListingTaxonomy(html));
  const category = frontier.partitions['category:8'];
  const nextCategory = new URL(category.currentListUrl); nextCategory.searchParams.set('page', '2');
  frontier = recordBuiltinPartition(frontier, category.id, {
    requestedUrl: category.currentListUrl, finalUrl: category.currentListUrl,
    criteria: category.expectedCriteria, nativeIds: ['100'], maxObservedPage: 1000, nextListUrl: nextCategory.toString(),
  });
  const partitionId = 'category-experience:8:not-specified';
  assert.equal(frontier.partitions[partitionId].currentListUrl, empty.sourceUrl);
  frontier.cursor = frontier.order.indexOf(partitionId);
  const checkpoint = { ...originalCheckpoint(), frontier, detailQueue: [], nextListUrl: empty.sourceUrl, ...encodeBuiltinSeenIds(['100', '101']) };
  delete checkpoint.seenExternalIds;
  const saved = JSON.stringify(checkpoint);
  const transport = new NativeTransport();
  const originalExtract = transport.extractUrl.bind(transport);
  transport.extractUrl = async url => {
    if (url !== empty.sourceUrl) return originalExtract(url);
    transport.calls.push(url);
    return { finalUrl: url, metadata: {}, html };
  };
  const result = await new BuiltinConnector(transport).fetchPage(context(checkpoint));
  assert.deepEqual(transport.calls, [empty.sourceUrl]);
  assert.equal(result.records.length, 0);
  assert.equal(result.hasMore, true);
  assert.deepEqual(decodeBuiltinSeenIds(result.checkpoint), ['100', '101']);
  assert.equal(result.checkpoint.backfillSince, since);
  assert.equal(result.checkpoint.windowUntil, until);
  assert.equal(result.checkpoint.retained, checkpoint.retained);
  assert.equal(result.checkpoint.frontier.partitions[partitionId].status, 'Complete');
  assert.equal(result.checkpoint.frontier.partitions[partitionId].observedNativeIds, 0);
  assert.equal(result.checkpoint.frontier.partitions[partitionId].observedPages, 1);
  assert.equal(JSON.stringify(checkpoint), saved);
  assert.notEqual(result.checkpoint.catalogComplete, true);
});
