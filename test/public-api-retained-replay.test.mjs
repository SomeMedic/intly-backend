import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { PublicApiFeedConnector } = require('../src/modules/sources/connectors/public-api-feed.connector.ts');
const fixture = path => JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8'));
const remoteOk = fixture('remote-public-feeds/remoteok.json');
const remotive = fixture('remote-public-feeds/remotive.json');
const trudvsem = fixture('trudvsem/vacancies-native.json');
const samples = {
  remoteok: remoteOk.find(item => item.id === 'remote-paid'),
  remotive: remotive.jobs[0],
  trudvsem: trudvsem.results.vacancies[0].vacancy,
};

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function localOnly(id) {
  const connector = new PublicApiFeedConnector(id);
  // Replay must not enter HTTP, source configuration, catalog collection or window state.
  for (const method of ['getJson', 'fetchPage', 'validateConfig', 'feedWindow', 'trudvsemPartitionState']) connector[method] = () => { throw new Error(`Retained replay entered ${method}`); };
  return connector;
}

test('Remote OK retained replay preserves current numeric salary, dates, tags and raw data without network', () => {
  const raw = freeze(structuredClone(samples.remoteok));
  const before = structuredClone(raw);
  const record = localOnly('remoteok').mapRetainedPayload(raw);
  assert.equal(record.externalId, 'remote-paid');
  assert.equal(record.url, 'https://remoteok.com/l/remote-paid');
  assert.equal(record.url, raw.apply_url);
  assert.equal(record.title, 'Platform Engineer');
  assert.equal(record.publishedAt.toISOString(), '2026-09-10T08:30:00.000Z');
  assert.equal(record.description, raw.description);
  assert.equal(record.companyOrClient, raw.company);
  assert.deepEqual(record.sourceMetadata.salary, { min: 120000, max: 180000 });
  assert.deepEqual(record.sourceMetadata.rawSalary, { salary_min: 120000, salary_max: 180000 });
  assert.equal(record.sourceMetadata.remoteType, 'remote');
  assert.deepEqual(record.sourceMetadata.tags, raw.tags);
  assert.equal(record.type, 'vacancy');
  assert.equal(record.rawPayload, raw);
  assert.deepEqual(raw, before);
});

test('Remotive retained replay preserves numeric native identity, original salary and unspecified date timezone', () => {
  const raw = freeze(structuredClone(samples.remotive));
  const before = structuredClone(raw);
  const record = localOnly('remotive').mapRetainedPayload(raw);
  assert.equal(record.externalId, '1001');
  assert.equal(record.url, raw.url);
  assert.equal(record.title, 'Backend Engineer');
  assert.equal(record.description, raw.description);
  assert.equal(record.publishedAt, undefined);
  assert.equal(record.sourceMetadata.publicationDateRaw, raw.publication_date);
  assert.equal(record.sourceMetadata.publicationDateTimezone, 'unspecified');
  assert.deepEqual(record.sourceMetadata.salary, { originalText: '$100k-$140k' });
  assert.deepEqual(record.sourceMetadata.skills, ['Python', 'Django']);
  assert.equal(record.sourceMetadata.employment, 'full_time');
  assert.equal(record.rawPayload, raw);
  assert.deepEqual(raw, before);
});

test('Trudvsem retained replay maps the native vacancy record without wrapper, date window or mutation', () => {
  const raw = freeze(structuredClone(samples.trudvsem));
  const before = structuredClone(raw);
  const record = localOnly('trudvsem').mapRetainedPayload(raw);
  assert.equal(record.externalId, raw.id);
  assert.equal(record.url, raw.vac_url);
  assert.equal(record.title, raw['job-name']);
  assert.equal(record.companyOrClient, raw.company.name);
  assert.equal(record.publishedAt.toISOString(), '2026-05-12T00:00:00.000Z');
  assert.equal(record.updatedAt.toISOString(), '2026-10-03T10:40:01.000Z');
  assert.match(record.description, /Выполнение сварки/);
  assert.deepEqual(record.sourceMetadata.salary, { min: 70000, max: 80000, currency: 'RUB', originalText: 'от 70000' });
  assert.equal(record.sourceMetadata.vacancyData.companyCode, raw.company.companycode);
  assert.equal(record.sourceMetadata.regionName, raw.region.name);
  assert.equal(record.sourceMetadata.locations[0].location, raw.addresses.address[0].location);
  assert.equal(record.sourceMetadata.skills.length, 5);
  assert.equal(record.rawPayload, raw);
  assert.deepEqual(raw, before);
});

test('retained replay handles BSON optional null according to the unchanged native mappers', () => {
  const optionalFields = {
    remoteok: ['company', 'location', 'tags', 'date', 'epoch', 'salary_min', 'salary_max', 'salary_currency'],
    remotive: ['company_name', 'candidate_required_location', 'tags', 'publication_date', 'salary', 'category', 'job_type'],
    trudvsem: ['company', 'region', 'requirement', 'addresses', 'skills', 'salary', 'salary_min', 'salary_max', 'currency', 'schedule'],
  };
  for (const [id, fields] of Object.entries(optionalFields)) {
    const missing = structuredClone(samples[id]);
    for (const field of fields) missing[field] = undefined;
    const raw = freeze(JSON.parse(JSON.stringify(missing, (_, value) => value === undefined ? null : value)));
    const before = structuredClone(raw);
    const record = localOnly(id).mapRetainedPayload(raw);
    assert.equal(record.externalId, String(raw.id));
    assert.equal(record.companyOrClient, undefined);
    assert.equal(record.sourceMetadata.salary?.min, undefined);
    assert.equal(record.sourceMetadata.salary?.max, undefined);
    assert.equal(record.sourceMetadata.salary?.currency, undefined);
    assert.equal(record.rawPayload, raw);
    assert.deepEqual(raw, before);
    for (const field of fields) assert.equal(raw[field], null);
  }
});

test('retained replay keeps required native identity, title and description failures', () => {
  for (const [id, native] of Object.entries(samples)) {
    const connector = localOnly(id);
    for (const value of [undefined, null, '', '   ', {}, [], Number.NaN]) assert.throws(() => connector.mapRetainedPayload({ ...native, id: value }), /missing required.*id/);
    const missingTitle = { ...native };
    for (const title of id === 'remoteok' ? ['position', 'title'] : id === 'trudvsem' ? ['job-name', 'job_name', 'name'] : ['title']) missingTitle[title] = null;
    assert.throws(() => connector.mapRetainedPayload(missingTitle), /missing required title/);
    if (id !== 'trudvsem') assert.throws(() => connector.mapRetainedPayload({ ...native, description: null }), /missing required description/);
  }
});

test('Trudvsem replay preserves strict native URL identity and supported company-code fallback', () => {
  const connector = localOnly('trudvsem');
  const native = samples.trudvsem;
  const reconstructed = connector.mapRetainedPayload({ ...native, vac_url: null });
  assert.equal(reconstructed.url, native.vac_url);
  for (const vac_url of ['https://another.example/vacancy/card/123/' + native.id, native.vac_url.replace(native.id, 'another-id'), native.vac_url + '?redirect=1']) assert.throws(() => connector.mapRetainedPayload({ ...native, company: null, vac_url }), /missing valid vac_url and companycode/);
  assert.throws(() => connector.mapRetainedPayload({ ...native, id: '../escape', company: null }), /missing valid vac_url and companycode/);
});

test('replay rejects unsupported connector IDs and feed envelopes instead of guessing a record', () => {
  for (const id of ['superjob', 'freelancehunt', 'adzuna', 'hackernews_whoishiring', 'another-source']) assert.throws(() => localOnly(id).mapRetainedPayload(samples.remoteok), new RegExp(`unsupported for ${id}`));
  for (const id of Object.keys(samples)) {
    const connector = localOnly(id);
    for (const payload of [null, undefined, [], 'invalid', 42]) assert.throws(() => connector.mapRetainedPayload(payload), /must be a native record object/);
  }
  assert.throws(() => localOnly('remoteok').mapRetainedPayload(remoteOk[0]), /missing required.*id/);
  assert.throws(() => localOnly('remotive').mapRetainedPayload(remotive), /missing required.*id/);
  assert.throws(() => localOnly('trudvsem').mapRetainedPayload(trudvsem.results.vacancies[0]), /missing required.*id/);
});
