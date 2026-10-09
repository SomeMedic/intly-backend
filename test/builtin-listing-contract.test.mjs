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

const {
  assertBuiltinCriteriaContinuation,
  builtinListingCriteria,
  builtinListingIsVerifiedEmpty,
  builtinListingTaxonomy,
  validatedBuiltinCriteria,
} = require('../src/modules/sources/connectors/builtin-listing-contract.ts');

const reportDir = resolve(backendDir, 'test/fixtures/builtin-native');

function reportFixture(name) {
  return readFileSync(resolve(reportDir, name), 'utf8');
}

function htmlFor({ criteria = {}, categoriesFilterOptions = [{ id: 9, alias: 'finance', urlName: 'finance' }], suffix = '' } = {}) {
  const baseCriteria = {
    remotePreferences: '',
    companySizes: '',
    categories: null,
    subCategories: '',
    experiences: '',
    industry: '',
    pageSize: 10,
    pageNumber: 1,
    search: '',
    isNational: true,
    isElite: false,
    isJobsBoard: true,
    searchArea: null,
    companyId: null,
    siteId: null,
    daysSinceUpdated: null,
    earlyApplicant: false,
    skills: '',
    city: null,
    state: null,
    country: 'USA',
    longitude: null,
    latitude: null,
    allLocations: false,
    industryCategoryIds: '',
    ...criteria,
  };
  return `<html><script>Builtin.jobBoardInit(${JSON.stringify({ criteria: baseCriteria, categoriesFilterOptions })});</script>${suffix}</html>`;
}

function partitionHtmlFor({ criteria = {}, subCategoriesFilterOptions, experiencesFilterOptions } = {}) {
  return htmlFor({
    criteria: {
      categories: 9,
      allLocations: true,
      ...criteria,
    },
    categoriesFilterOptions: [{ id: 9, alias: 'finance', urlName: 'finance' }],
    suffix: '',
  }).replace(
    '});</script>',
    `,"subCategoriesFilterOptions":${JSON.stringify(subCategoriesFilterOptions ?? {
      9: [
        { id: 69, alias: 'accounting', urlName: 'accounting' },
        { id: 70, alias: 'corporate-finance', urlName: 'corporate-finance' },
      ],
    })},"experiencesFilterOptions":${JSON.stringify(experiencesFilterOptions ?? [
      { alias: 'senior', filterValue: 'Senior-level' },
      { alias: 'junior', filterValue: 'Junior' },
    ])}});</script>`,
  );
}

test('parses real observed Built In native criteria from saved public HTML', () => {
  const finance = builtinListingCriteria(
    reportFixture('criteria-finance.html'),
    'https://builtin.com/jobs/finance',
  );
  assert.equal(finance.categories, 9);
  assert.equal(finance.search, 'finance');
  assert.equal(finance.country, 'USA');
  assert.equal(finance.pageSize, 25);
  assert.equal(finance.pageNumber, 1);
  assert.equal(finance.daysSinceUpdated, null);

  const monthPage2 = builtinListingCriteria(
    reportFixture('criteria-finance-month-page-2.html'),
    'https://builtin.com/jobs/finance?daysSinceUpdated=30&page=2',
  );
  assert.equal(monthPage2.categories, 9);
  assert.equal(monthPage2.search, null);
  assert.equal(monthPage2.country, 'NLD');
  assert.equal(monthPage2.pageSize, 10);
  assert.equal(monthPage2.pageNumber, 2);
  assert.equal(monthPage2.daysSinceUpdated, 30);

  const city = builtinListingCriteria(
    reportFixture('criteria-city-finance-month.html'),
    'https://builtin.com/jobs/salt-lake-city/finance?daysSinceUpdated=30',
  );
  assert.equal(city.categories, 9);
  assert.equal(city.city, 'Salt Lake City');
  assert.equal(city.state, 'Utah');
  assert.equal(city.country, 'USA');
  assert.equal(city.longitude, -111.88822);
  assert.equal(city.latitude, 40.76031);
});

test('rejects ignored category query, missing contract, and ambiguous jobBoardInit contracts', () => {
  assert.throws(
    () => builtinListingCriteria(htmlFor({ criteria: { categories: 9 } }), 'https://builtin.com/jobs?categories=9'),
    /filter categories is not supported/,
  );
  assert.throws(
    () => builtinListingCriteria('<html></html>', 'https://builtin.com/jobs'),
    /no jobBoardInit contract/,
  );
  assert.throws(
    () => builtinListingCriteria(`${htmlFor()}${htmlFor()}`, 'https://builtin.com/jobs'),
    /ambiguous jobBoardInit contracts/,
  );
});

test('accepts the native location URL and rejects unreflected country or allLocations', () => {
  const url = 'https://builtin.com/jobs/finance?daysSinceUpdated=30&city=&state=&country=USA&allLocations=true';
  const html = reportFixture('criteria-finance-global-month.html');
  const criteria = builtinListingCriteria(html, url);
  assert.equal(criteria.categories, 9);
  assert.equal(criteria.country, 'USA');
  assert.equal(criteria.allLocations, true);
  assert.equal(criteria.city, null);
  assert.equal(criteria.daysSinceUpdated, 30);
  assert.throws(() => builtinListingCriteria(html, url.replace('country=USA', 'country=NLD')), /country does not match/);
  assert.throws(() => builtinListingCriteria(html.replace('"allLocations":true', '"allLocations":false'), url), /allLocations does not match/);
  assert.throws(() => builtinListingCriteria(html, `${url}&country=USA`), /ambiguous repeated filters/);
});

test('parses native partition taxonomy and category subcategory experience paths', () => {
  const accounting = builtinListingCriteria(
    reportFixture('criteria-accounting-partition.html'),
    'https://builtin.com/jobs/finance/accounting?city=&state=&country=USA&allLocations=true',
  );
  assert.equal(accounting.categories, 9);
  assert.equal(accounting.subCategories, '69');
  assert.equal(accounting.experiences, null);
  assert.equal(accounting.allLocations, true);

  const senior = builtinListingCriteria(
    reportFixture('criteria-senior-partition.html'),
    'https://builtin.com/jobs/finance/senior?city=&state=&country=USA&allLocations=true',
  );
  assert.equal(senior.categories, 9);
  assert.equal(senior.subCategories, null);
  assert.equal(senior.experiences, 'Senior-level');

  const accountingSenior = builtinListingCriteria(
    reportFixture('criteria-accounting-senior-partition.html'),
    'https://builtin.com/jobs/finance/accounting/senior?city=&state=&country=USA&allLocations=true',
  );
  assert.equal(accountingSenior.categories, 9);
  assert.equal(accountingSenior.subCategories, '69');
  assert.equal(accountingSenior.experiences, 'Senior-level');

  const taxonomy = builtinListingTaxonomy(reportFixture('criteria-accounting-senior-partition.html'));
  assert.deepEqual(taxonomy, {
    categories: [{ id: 9, alias: 'finance' }],
    subCategories: [
      { id: 68, categoryId: 9, alias: 'financial-planning-analysis' },
      { id: 69, categoryId: 9, alias: 'accounting' },
      { id: 70, categoryId: 9, alias: 'corporate-finance' },
    ],
    experiences: [
      { alias: 'junior', filterValue: 'Junior' },
      { alias: 'senior', filterValue: 'Senior-level' },
    ],
  });
});

test('rejects partition URL drift, unsupported native filters, and ambiguous path choices', () => {
  const accounting = reportFixture('criteria-accounting-partition.html');
  assert.throws(
    () => builtinListingCriteria(accounting, 'https://builtin.com/jobs/finance/corporate-finance?city=&state=&country=USA&allLocations=true'),
    /subCategories 69 does not match path 70/,
  );
  assert.throws(
    () => builtinListingCriteria(accounting, 'https://builtin.com/jobs/finance/accounting/senior?city=&state=&country=USA&allLocations=true'),
    /experiences null does not match path Senior-level/,
  );
  assert.throws(
    () => builtinListingCriteria(partitionHtmlFor({ criteria: { remotePreferences: '2' } }), 'https://builtin.com/jobs/finance/accounting?city=&state=&country=USA&allLocations=true'),
    /unexpected remotePreferences/,
  );
  assert.throws(
    () => builtinListingCriteria(partitionHtmlFor({ criteria: { subCategories: '69,70' } }), 'https://builtin.com/jobs/finance/accounting?city=&state=&country=USA&allLocations=true'),
    /unsupported multi-select subCategories/,
  );
  assert.throws(
    () => builtinListingCriteria(
      partitionHtmlFor({ subCategoriesFilterOptions: { 9: [{ id: 69, alias: 'senior' }] } }),
      'https://builtin.com/jobs/finance/senior?city=&state=&country=USA&allLocations=true',
    ),
    /partition path is ambiguous: senior/,
  );
});

test('rejects malformed partition taxonomy but returns undefined for old fixtures without it', () => {
  assert.equal(builtinListingTaxonomy(reportFixture('criteria-finance.html')), undefined);
  assert.throws(() => builtinListingTaxonomy(partitionHtmlFor({ subCategoriesFilterOptions: { 999: [{ id: 69, alias: 'accounting' }] } })), /parent is invalid/);
  assert.throws(() => builtinListingTaxonomy(partitionHtmlFor({ experiencesFilterOptions: [{ alias: 'senior' }] })), /invalid experience filterValue/);
  assert.throws(() => builtinListingTaxonomy(partitionHtmlFor({ subCategoriesFilterOptions: { 9: [{ id: 69, alias: 'accounting' }, { id: 69, alias: 'audit' }] } })), /duplicate subCategory id 69/);
});

test('rejects URL mismatches for page, month, category, and city criteria', () => {
  assert.throws(
    () => builtinListingCriteria(htmlFor({ criteria: { pageNumber: 2 } }), 'https://builtin.com/jobs'),
    /pageNumber 2 does not match URL page 1/,
  );
  assert.throws(
    () => builtinListingCriteria(htmlFor({ criteria: { daysSinceUpdated: 7 } }), 'https://builtin.com/jobs?daysSinceUpdated=30'),
    /daysSinceUpdated 7 does not match URL 30/,
  );
  assert.throws(
    () => builtinListingCriteria(htmlFor({ criteria: { categories: null } }), 'https://builtin.com/jobs/finance'),
    /category null does not match path finance/,
  );
  assert.throws(
    () => builtinListingCriteria(htmlFor({ criteria: { categories: 9, city: 'Salt Lake City' } }), 'https://builtin.com/jobs/new-york-city/finance'),
    /city does not match path new-york-city/,
  );
});

test('detects continuation drift across geo, search, page size, and added or removed fields', () => {
  const before = builtinListingCriteria(htmlFor(), 'https://builtin.com/jobs');
  const pageOnly = { ...before, pageNumber: 2 };
  assert.doesNotThrow(() => assertBuiltinCriteriaContinuation(before, pageOnly));

  assert.throws(() => assertBuiltinCriteriaContinuation(before, { ...before, country: 'NLD', pageNumber: 2 }), /country/);
  assert.throws(() => assertBuiltinCriteriaContinuation(before, { ...before, search: 'finance', pageNumber: 2 }), /search/);
  assert.throws(() => assertBuiltinCriteriaContinuation(before, { ...before, pageSize: 25, pageNumber: 2 }), /pageSize/);
  assert.throws(() => assertBuiltinCriteriaContinuation(before, { ...before, extra: true, pageNumber: 2 }), /key set changed/);
  const removed = { ...before, pageNumber: 2 };
  delete removed.skills;
  assert.throws(() => assertBuiltinCriteriaContinuation(before, removed), /key set changed|missing skills/);
});

test('parses balanced JSON with braces and escaped quotes inside strings', () => {
  const criteria = builtinListingCriteria(
    htmlFor({ criteria: { search: 'finance {platform} "quoted" \\\\ slash' } }),
    'https://builtin.com/jobs',
  );
  assert.equal(criteria.search, 'finance {platform} "quoted" \\\\ slash');
});

test('rejects unsupported checkpoint values without URL context', () => {
  assert.throws(() => validatedBuiltinCriteria(null), /not an object/);
  assert.throws(() => validatedBuiltinCriteria({ ...builtinListingCriteria(htmlFor(), 'https://builtin.com/jobs'), pageSize: '10' }), /invalid pageSize/);
  assert.throws(() => validatedBuiltinCriteria({ ...builtinListingCriteria(htmlFor(), 'https://builtin.com/jobs'), nested: { nope: true } }), /non-scalar field nested/);
});

const remoteProof = JSON.parse(reportFixture('native-remote-empty-proof.json'));
function nativeProofHtml(item, criteria = item.criteria, listHtml = item.jobListHtml ?? '') {
  return `<script>Builtin.jobBoardInit(${JSON.stringify({ criteria, ...item.taxonomy })});</script><div id="jobs-list">${listHtml}</div>`;
}

test('reflects actual native remote aliases before category, subcategory and experience', () => {
  for (const item of remoteProof.cases.filter(item => item.key !== 'not-specified')) {
    const html = nativeProofHtml(item);
    const parsed = builtinListingCriteria(html, item.sourceUrl);
    assert.equal(parsed.remotePreferences, item.criteria.remotePreferences);
    assert.equal(parsed.categories, 8);
    assert.equal(parsed.subCategories, item.criteria.subCategories || null);
    assert.equal(parsed.experiences, 'Senior-level');
    assert.equal(parsed.country, 'USA');
    assert.equal(parsed.allLocations, true);
    assert.equal(parsed.daysSinceUpdated, null);
    assert.deepEqual(builtinListingTaxonomy(html).remotePreferences, [
      { id: 2, alias: 'remote' }, { id: 3, alias: 'hybrid' }, { id: 1, alias: 'office' },
    ]);
    assert.throws(() => builtinListingCriteria(nativeProofHtml(item, { ...item.criteria, remotePreferences: '4' }), item.sourceUrl), /remotePreferences does not match path/);
    assert.throws(() => builtinListingCriteria(html, item.sourceUrl.replace(/\/jobs\/(remote|hybrid|office)\//, '/jobs/')), /unexpected remotePreferences/);
    assert.throws(() => builtinListingCriteria(html, `${item.sourceUrl}&remotePreferences=2`), /filter remotePreferences is not supported/);
    assert.throws(() => builtinListingCriteria(nativeProofHtml(item, { ...item.criteria, remotePreferences: '2,3' }), item.sourceUrl), /multi-select remotePreferences/);
  }
});

test('accepts the observed positive native empty template only with exact first-page criteria', () => {
  const item = remoteProof.cases.find(item => item.key === 'not-specified');
  const html = nativeProofHtml(item);
  assert.equal(builtinListingIsVerifiedEmpty(html, item.sourceUrl), true);
  // The skill facet counts are nonzero even on the genuine zero-job response.
  assert.ok(item.jobListHtml.includes('"count":64527'));
  const rejected = [
    '<html>Access denied. No job results.</html>',
    nativeProofHtml(item, item.criteria, ''),
    html.replace('No job results. To see more jobs, try:', 'Something went wrong. Try again.'),
    html.replace('id="expand-area-link"', 'id="different-link"'),
    html.replace('href="/jobs">Reset all', 'href="/blocked">Reset all'),
    html.replace('Adjusting other filters', 'Checking your browser'),
    html.replace('[{"count":64527', 'malformed-json[{"count":64527'),
    `${html}<article id="job-card-123"></article>`,
    `${html}<a href="${item.sourceUrl}&page=2">Next</a>`,
    `${html}<div id="jobs-list"></div>`,
    nativeProofHtml(item, { ...item.criteria, country: 'NLD' }),
    nativeProofHtml(item, { ...item.criteria, experiences: 'Senior-level' }),
  ];
  for (const candidate of rejected) assert.equal(builtinListingIsVerifiedEmpty(candidate, item.sourceUrl), false);
  assert.equal(builtinListingIsVerifiedEmpty(nativeProofHtml(item, { ...item.criteria, pageNumber: 2 }), `${item.sourceUrl}&page=2`), false);
});
