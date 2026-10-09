import assert from 'node:assert/strict';
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

const {
  assertBuiltinFrontierTaxonomy,
  builtinFrontierSummary,
  createBuiltinFrontier,
  nextBuiltinPartition,
  recordBuiltinPartition,
  refineBuiltinFrontier,
  suspendBuiltinPartition,
  validatedBuiltinFrontier,
} = require('../src/modules/sources/connectors/builtin-listing-frontier.ts');

const taxonomy = {
  categories: [
    { id: 9, alias: 'finance' },
    { id: 8, alias: 'engineering' },
  ],
  subCategories: [
    { id: 69, categoryId: 9, alias: 'accounting' },
    { id: 70, categoryId: 9, alias: 'corporate-finance' },
    { id: 88, categoryId: 8, alias: 'backend' },
  ],
  experiences: [
    { alias: 'senior', filterValue: 'Senior-level' },
    { alias: 'entry-level', filterValue: 'Entry-level' },
  ],
};

function criteria(overrides = {}) {
  return {
    remotePreferences: null,
    companySizes: null,
    categories: null,
    subCategories: null,
    experiences: null,
    industry: null,
    pageSize: 10,
    pageNumber: 1,
    search: null,
    isNational: true,
    isElite: false,
    isJobsBoard: true,
    searchArea: null,
    companyId: null,
    siteId: null,
    daysSinceUpdated: null,
    earlyApplicant: false,
    skills: null,
    city: null,
    state: null,
    country: 'USA',
    longitude: null,
    latitude: null,
    allLocations: true,
    industryCategoryIds: null,
    ...overrides,
  };
}

function observe(partition, overrides = {}) {
  const page = overrides.pageNumber ?? 1;
  return {
    requestedUrl: partition.currentListUrl,
    finalUrl: partition.currentListUrl,
    criteria: criteria({ ...partition.expectedCriteria, pageNumber: page, ...(overrides.criteria ?? {}) }),
    nativeIds: overrides.nativeIds ?? [`${1000 + page}`],
    nextListUrl: Object.hasOwn(overrides, 'nextListUrl') ? overrides.nextListUrl : pageUrl(partition.currentListUrl, page + 1),
    maxObservedPage: overrides.maxObservedPage ?? page,
    terminal: overrides.terminal ?? false,
  };
}

function pageUrl(url, page) {
  const next = new URL(url);
  if (page <= 1) next.searchParams.delete('page');
  else next.searchParams.set('page', String(page));
  return next.toString();
}

test('seeds canonical baseline and categories, then advances round-robin only after observation', () => {
  let frontier = createBuiltinFrontier(taxonomy);

  const first = nextBuiltinPartition(frontier);
  assert.equal(first.id, 'baseline');
  assert.equal(first.currentListUrl, 'https://builtin.com/jobs?city=&state=&country=USA&allLocations=true');
  assert.equal(nextBuiltinPartition(frontier).id, 'baseline');

  frontier = recordBuiltinPartition(frontier, 'baseline', observe(first));
  assert.equal(nextBuiltinPartition(frontier).id, 'category:9');

  const summary = builtinFrontierSummary(frontier);
  assert.equal(summary.total, 3);
  assert.equal(summary.pending, 3);
  assert.equal(summary.observedPages, 1);
  assert.equal(summary.coverageComplete, false);
});

test('restores by deep clone and rejects tampered version or taxonomy hash', () => {
  const frontier = createBuiltinFrontier(taxonomy);
  const restored = validatedBuiltinFrontier(frontier);
  frontier.partitions.baseline.status = 'Complete';

  assert.equal(restored.partitions.baseline.status, 'Pending');
  assert.throws(() => validatedBuiltinFrontier({ ...restored, version: 2 }), /unsupported version/);
  assert.throws(() => validatedBuiltinFrontier({ ...restored, taxonomySha256: 'bad' }), /taxonomy hash/);
  assert.throws(
    () => assertBuiltinFrontierTaxonomy(restored, { ...taxonomy, categories: taxonomy.categories.map(item => ({ ...item, alias: item.id === 9 ? 'finance-changed' : item.alias })) }),
    /taxonomy changed/,
  );
});

test('detects criteria, page, next URL, and repeated native-ID page drift', () => {
  let frontier = createBuiltinFrontier(taxonomy);
  const baseline = nextBuiltinPartition(frontier);
  assert.throws(
    () => recordBuiltinPartition(frontier, 'baseline', observe(baseline, { criteria: { country: 'NLD' } })),
    /criteria drifted.*country/,
  );

  frontier = recordBuiltinPartition(frontier, 'baseline', observe(baseline, { nativeIds: ['111'] }));
  const again = nextBuiltinPartition(frontier);
  assert.equal(again.id, 'category:9');
  assert.throws(
    () => recordBuiltinPartition(frontier, 'baseline', observe({ ...baseline, currentListUrl: pageUrl(baseline.currentListUrl, 2) }, { pageNumber: 3 })),
    /requested URL drifted|page drifted/,
  );

  const category = again;
  assert.throws(
    () => recordBuiltinPartition(frontier, category.id, observe(category, { nextListUrl: 'https://builtin.com/jobs/engineering?city=&state=&country=USA&allLocations=true&page=5' })),
    /next URL (page|scope) drifted/,
  );

  frontier = recordBuiltinPartition(frontier, category.id, observe(category, { nativeIds: ['222'] }));
  const categoryPage2 = nextBuiltinPartition(frontier);
  assert.equal(categoryPage2.id, 'category:8');
  const baselinePage2 = frontier.partitions.baseline;
  const repeated = recordBuiltinPartition(frontier, 'baseline', observe(baselinePage2, { pageNumber: 2, nativeIds: ['111'] }));
  assert.equal(repeated.partitions.baseline.status, 'Unresolved');
  assert.equal(repeated.partitions.baseline.suspendedReason, 'repeated-native-page-fingerprint');
  assert.equal(repeated.partitions.baseline.observedPages, 1);
  assert.equal(repeated.partitions.baseline.currentListUrl, baselinePage2.currentListUrl);
  assert.equal(nextBuiltinPartition(repeated).id, 'category:9');
  assert.throws(() => recordBuiltinPartition(frontier, categoryPage2.id, observe(categoryPage2, { terminal: true })), /terminal observation still has a next URL/);
});

test('expands capped categories into subcategories and category-experience partitions while allowing global overlaps', () => {
  let frontier = createBuiltinFrontier(taxonomy);
  frontier = recordBuiltinPartition(frontier, 'baseline', observe(nextBuiltinPartition(frontier), { terminal: true, nextListUrl: null }));

  const finance = nextBuiltinPartition(frontier);
  assert.equal(finance.id, 'category:9');
  frontier = recordBuiltinPartition(frontier, finance.id, observe(finance, { maxObservedPage: 1000, nativeIds: ['9001'] }));

  assert.ok(frontier.partitions['subcategory:9:69']);
  assert.ok(frontier.partitions['subcategory:9:70']);
  assert.ok(frontier.partitions['category-experience:9:senior']);
  assert.ok(frontier.partitions['category-experience:9:entry-level']);
  assert.equal(frontier.partitions['category:9'].status, 'Pending');
  assert.equal(frontier.partitions['category:9'].capObserved, true);

  const subCategory = frontier.partitions['subcategory:9:69'];
  frontier = recordBuiltinPartition(frontier, subCategory.id, observe(subCategory, {
    nativeIds: ['9001'],
    terminal: true,
    nextListUrl: null,
  }));
  assert.equal(frontier.partitions[subCategory.id].observedNativeIds, 1);
});

test('expands capped subcategories into experience leaves and records unresolved leaf caps honestly', () => {
  let frontier = createBuiltinFrontier(taxonomy);
  const finance = frontier.partitions['category:9'];
  frontier = recordBuiltinPartition(frontier, finance.id, observe(finance, { maxObservedPage: 1000 }));

  const accounting = frontier.partitions['subcategory:9:69'];
  frontier = recordBuiltinPartition(frontier, accounting.id, observe(accounting, { maxObservedPage: 1000, nativeIds: ['6900'] }));

  assert.ok(frontier.partitions['subcategory-experience:9:69:senior']);
  assert.ok(frontier.partitions['subcategory-experience:9:69:entry-level']);

  const leaf = frontier.partitions['subcategory-experience:9:69:senior'];
  frontier = recordBuiltinPartition(frontier, leaf.id, observe(leaf, { maxObservedPage: 1000, nativeIds: ['6901'] }));
  assert.equal(frontier.partitions[leaf.id].unresolvedLeafCap, true);
  assert.equal(builtinFrontierSummary(frontier).unresolvedLeafCaps, 1);
});

test('suspends guarded zero-card partitions without marking coverage complete', () => {
  let frontier = createBuiltinFrontier(taxonomy);
  const baseline = nextBuiltinPartition(frontier);

  frontier = suspendBuiltinPartition(frontier, baseline.id, 'guarded zero-card listing');
  assert.equal(frontier.partitions.baseline.status, 'Unresolved');
  assert.equal(frontier.partitions.baseline.currentListUrl, baseline.currentListUrl);
  assert.equal(nextBuiltinPartition(frontier).id, 'category:9');

  const summary = builtinFrontierSummary(frontier);
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.coverageComplete, false);
  assert.throws(() => suspendBuiltinPartition(frontier, baseline.id, 'again'), /Unresolved/);
});

test('initializes legacy on the next pointer and completes legacy without one', () => {
  const legacyCriteria = criteria({ pageNumber: 434 });
  const frontier = createBuiltinFrontier(taxonomy, {
    currentListUrl: 'https://builtin.com/jobs?city=&state=&country=USA&allLocations=true&page=434',
    nextListUrl: 'https://builtin.com/jobs?city=&state=&country=USA&allLocations=true&page=435',
    listingCriteria: legacyCriteria,
    maxObservedPage: 1000,
  });

  const legacy = frontier.partitions.legacy;
  assert.equal(legacy.status, 'Pending');
  assert.equal(legacy.currentListUrl, 'https://builtin.com/jobs?city=&state=&country=USA&allLocations=true&page=435');
  assert.equal(legacy.lastPageNumber, 434);

  const completeLegacy = createBuiltinFrontier(taxonomy, {
    currentListUrl: 'https://builtin.com/jobs?city=&state=&country=USA&allLocations=true&page=434',
    listingCriteria: legacyCriteria,
  }).partitions.legacy;
  assert.equal(completeLegacy.status, 'Complete');
  assert.equal(completeLegacy.currentListUrl, null);
});

test('restore validation rejects omitted partitions, invalid complete status, and empty native pages', () => {
  const frontier = createBuiltinFrontier(taxonomy);
  const missing = structuredClone(frontier);
  delete missing.partitions['category:8'];
  assert.throws(() => validatedBuiltinFrontier(missing), /order does not cover|missing partition/);

  const invalidComplete = structuredClone(frontier);
  invalidComplete.partitions.baseline.status = 'Complete';
  assert.throws(() => validatedBuiltinFrontier(invalidComplete), /complete partition baseline still has current URL/);

  const baseline = nextBuiltinPartition(frontier);
  assert.throws(() => recordBuiltinPartition(frontier, baseline.id, observe(baseline, { nativeIds: [] })), /empty native ID page/);
});

const remoteTaxonomy = { ...taxonomy, remotePreferences: [
  { id: 2, alias: 'remote' }, { id: 3, alias: 'hybrid' }, { id: 1, alias: 'office' },
] };

test('expands native remote children while retaining the capped parent and missing-work-mode residual', () => {
  let frontier = createBuiltinFrontier(remoteTaxonomy);
  frontier = recordBuiltinPartition(frontier, 'category:9', observe(frontier.partitions['category:9'], { maxObservedPage: 1000 }));
  const parent = frontier.partitions['category-experience:9:senior'];
  frontier = recordBuiltinPartition(frontier, parent.id, observe(parent, { maxObservedPage: 1000 }));
  const childIds = [2, 3, 1].map(id => `category-experience-remote:9:senior:${id}`);
  assert.deepEqual(childIds.map(id => frontier.partitions[id].expectedCriteria.remotePreferences), ['2', '3', '1']);
  assert.equal(frontier.partitions[childIds[0]].currentListUrl, 'https://builtin.com/jobs/remote/finance/senior?city=&state=&country=USA&allLocations=true');
  for (const id of childIds) frontier = recordBuiltinPartition(frontier, id, observe(frontier.partitions[id], { terminal: true, nextListUrl: null }));
  assert.equal(frontier.partitions[parent.id].unresolvedLeafCap, true);
  assert.equal(frontier.partitions[parent.id].capObserved, true);
  assert.equal(frontier.partitions[parent.id].currentListUrl, pageUrl(parent.currentListUrl, 2));
  assert.equal(builtinFrontierSummary(frontier).coverageComplete, false);
  assert.equal(builtinFrontierSummary(frontier).scopedTraversalExhausted, false);

  const accounting = frontier.partitions['subcategory:9:69'];
  frontier = recordBuiltinPartition(frontier, accounting.id, observe(accounting, { maxObservedPage: 1000 }));
  const accountingSenior = frontier.partitions['subcategory-experience:9:69:senior'];
  frontier = recordBuiltinPartition(frontier, accountingSenior.id, observe(accountingSenior, { maxObservedPage: 1000 }));
  const office = frontier.partitions['subcategory-experience-remote:9:69:senior:1'];
  assert.equal(office.currentListUrl, 'https://builtin.com/jobs/office/finance/accounting/senior?city=&state=&country=USA&allLocations=true');
  frontier = recordBuiltinPartition(frontier, office.id, observe(office, { maxObservedPage: 1000 }));
  assert.equal(frontier.partitions[office.id].unresolvedLeafCap, true);
  const tampered = structuredClone(frontier);
  tampered.partitions[office.id].parentId = 'category-experience:9:senior';
  assert.throws(() => validatedBuiltinFrontier(tampered), /invalid remote parent/);
});

test('refines old v1 checkpoints once without changing the pending pointer or observed history', () => {
  let frontier = createBuiltinFrontier(taxonomy);
  delete frontier.nativeContractRevision;
  frontier = recordBuiltinPartition(frontier, 'category:9', observe(frontier.partitions['category:9'], { maxObservedPage: 1000 }));
  const parent = frontier.partitions['category-experience:9:senior'];
  frontier = recordBuiltinPartition(frontier, parent.id, observe(parent, { maxObservedPage: 1000, nativeIds: ['9898'] }));
  const emptyId = 'category-experience:9:entry-level';
  frontier = suspendBuiltinPartition(frontier, emptyId, 'unverified-native-empty');
  const priorNext = nextBuiltinPartition(frontier);
  const saved = JSON.stringify(frontier);
  const refined = refineBuiltinFrontier(frontier, remoteTaxonomy);
  assert.equal(JSON.stringify(frontier), saved);
  assert.equal(nextBuiltinPartition(refined).currentListUrl, priorNext.currentListUrl);
  assert.equal(refined.version, 1);
  assert.equal(refined.nativeContractRevision, 1);
  for (const [id, partition] of Object.entries(frontier.partitions)) {
    if (id !== emptyId) assert.deepEqual(refined.partitions[id], partition);
    else assert.deepEqual(refined.partitions[id], { ...partition, status: 'Pending', suspendedReason: null });
  }
  assert.equal(refined.order.at(-1), emptyId);
  assert.ok(refined.partitions['category-experience-remote:9:senior:2']);
  assert.deepEqual(refineBuiltinFrontier(refined, remoteTaxonomy), refined);
  const suspendedAgain = suspendBuiltinPartition(refined, emptyId, 'unverified-native-empty');
  assert.equal(refineBuiltinFrontier(suspendedAgain, remoteTaxonomy).partitions[emptyId].status, 'Unresolved');
  assert.throws(() => refineBuiltinFrontier(refined, { ...remoteTaxonomy, remotePreferences: [{ id: 2, alias: 'changed' }] }), /remote taxonomy changed/);
});

test('completes only positively verified initial empty pages, preserving exact terminal evidence', () => {
  const frontier = createBuiltinFrontier(taxonomy);
  const baseline = nextBuiltinPartition(frontier);
  const empty = { ...observe(baseline, { nativeIds: [], terminal: true, nextListUrl: null }), verifiedEmpty: true };
  const completed = recordBuiltinPartition(frontier, baseline.id, empty);
  assert.equal(completed.partitions.baseline.status, 'Complete');
  assert.equal(completed.partitions.baseline.observedPages, 1);
  assert.equal(completed.partitions.baseline.observedNativeIds, 0);
  assert.equal(completed.partitions.baseline.lastPageNumber, 1);
  assert.equal(completed.partitions.baseline.currentListUrl, null);
  assert.throws(() => recordBuiltinPartition(frontier, baseline.id, { ...empty, verifiedEmpty: false }), /empty native ID page/);
  assert.throws(() => recordBuiltinPartition(frontier, baseline.id, { ...empty, terminal: false }), /empty native ID page/);
  assert.throws(() => recordBuiltinPartition(frontier, baseline.id, { ...empty, maxObservedPage: 1000 }), /empty native ID page/);
  assert.throws(() => recordBuiltinPartition(frontier, baseline.id, { ...empty, nextListUrl: pageUrl(baseline.currentListUrl, 2) }), /empty native ID page/);
});
