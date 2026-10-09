import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const {
  normalizeDuplicateText, normalizeDuplicateUrl, duplicateFingerprint, compareDuplicateOpportunities,
} = require('../src/modules/opportunities/opportunity-deduplication.ts');

const body = 'Our platform engineering team builds reliable distributed services for enterprise customers. You will design deployment workflows, improve observability, review infrastructure changes, collaborate with product teams, and document practical operational decisions. We value clear communication, thoughtful ownership, careful debugging, and proven experience shipping production software.';
const ruBody = 'Команда платформы разрабатывает надёжные распределённые сервисы для корпоративных клиентов. Вы будете проектировать процессы доставки, улучшать мониторинг, проверять изменения инфраструктуры, сотрудничать с продуктовыми командами и документировать технические решения. Нам важны понятная коммуникация, ответственность, внимательная диагностика и опыт разработки промышленного программного обеспечения.';
const occurrence = (sourceId, externalId, url = `https://${sourceId}.example/jobs/${externalId}`) => ({ sourceId, externalId, url });
const facts = (overrides = {}) => ({
  _id: 'canonical-a', type: 'vacancy', title: 'Senior Platform Engineer', companyOrClient: 'ACME',
  description: body, location: 'Berlin', publishedAt: new Date('2026-10-05T12:00:00Z'),
  sourceOccurrences: [occurrence('source-a', 'native-1')], tenderData: {}, ...overrides,
});
const copy = (overrides = {}) => facts({ _id: 'canonical-b', sourceOccurrences: [occurrence('source-b', 'native-2')], ...overrides });
const verdict = (left, right, expected, level) => {
  const result = compareDuplicateOpportunities(left, right);
  assert.equal(result.verdict, expected, JSON.stringify(result));
  if (level !== undefined) assert.equal(result.level, level);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.ok(result.reasons.length > 0);
  assert.deepEqual(compareDuplicateOpportunities(right, left), result, 'Comparison must be symmetric');
  return result;
};

test('text normalization supports RU/EN Unicode, whitespace, C++ / C# and numbers without conflation', () => {
  assert.equal(normalizeDuplicateText('  ＳＥＮＩＯＲ\u00a0 C++\nРазработчик  １２  '), 'senior c++ разработчик 12');
  assert.equal(normalizeDuplicateText('C# 12'), 'c# 12');
  assert.notEqual(normalizeDuplicateText('C++ 12'), normalizeDuplicateText('C# 12'));
  assert.notEqual(normalizeDuplicateText('Engineer 2'), normalizeDuplicateText('Engineer 3'));
  assert.equal(normalizeDuplicateText('е\u0308ж'), 'ёж');
});

test('URL normalization removes known tracking and fragment while preserving native queries and repeated values', () => {
  assert.equal(normalizeDuplicateUrl('HTTPS://EXAMPLE.COM:443/procedure?z=last&lot=2&UTM_Source=x&fbclid=y&gclid=z&id=42#detail'), 'https://example.com/procedure?id=42&lot=2&z=last');
  assert.notEqual(normalizeDuplicateUrl('https://example.com/procedure?id=42&lot=1'), normalizeDuplicateUrl('https://example.com/procedure?id=42&lot=2'));
  assert.notEqual(normalizeDuplicateUrl('https://example.com/job?id=1'), normalizeDuplicateUrl('https://example.com/job?id=2'));
  assert.equal(normalizeDuplicateUrl('https://example.com/?tag=b&x=1&tag=a'), 'https://example.com/?tag=b&tag=a&x=1');
  assert.notEqual(normalizeDuplicateUrl('https://example.com/job'), normalizeDuplicateUrl('https://example.com/job/'));
});

test('URL normalization rejects credentials, known secrets, invalid and non-HTTP URLs', () => {
  for (const value of [
    'https://user:password@example.com/job', 'https://example.com/job?access_token=secret',
    'https://example.com/job?apiKey=secret', 'https://example.com/job?%74oken=secret',
    'https://example.com/job?X-Amz-Signature=secret', 'javascript:alert(1)', 'file:///job', '/job', 'not a URL',
  ]) assert.equal(normalizeDuplicateUrl(value), null, value);
});

test('fingerprint requires type, normalized title/counterpart/location and an explicit real publication date', () => {
  const left = facts();
  const right = copy({ title: ' SENIOR  PLATFORM ENGINEER ', companyOrClient: 'ＡＣＭＥ', location: ' BERLIN ', publishedAt: '2026-10-05T16:00:00+03:00' });
  assert.equal(duplicateFingerprint(left), duplicateFingerprint(right));
  assert.match(duplicateFingerprint(left), /^[a-f0-9]{64}$/);
  assert.notEqual(duplicateFingerprint(left), duplicateFingerprint(copy({ type: 'freelance' })));
  assert.notEqual(duplicateFingerprint(left), duplicateFingerprint(copy({ publishedAt: '2026-10-06' })));
  for (const field of ['type', 'title', 'companyOrClient', 'location', 'publishedAt']) {
    assert.equal(duplicateFingerprint(facts({ [field]: undefined })), null, field);
  }
});

test('dates are never guessed from local strings, rollover, firstSeenAt or updatedAt', () => {
  for (const publishedAt of [null, '', '05.10.2026', '10/05/2026', '2026-02-30', '2026-10-05T24:00:00Z', '2026-10-05T12:00:00', new Date('invalid')]) {
    assert.equal(duplicateFingerprint(facts({ publishedAt })), null, String(publishedAt));
  }
  assert.equal(duplicateFingerprint(facts({ publishedAt: undefined, firstSeenAt: new Date(), updatedAt: new Date() })), null);
  assert.equal(duplicateFingerprint(facts({ publishedAt: '2026-10-06T00:30:00+03:00' })), duplicateFingerprint(facts({ publishedAt: '2026-10-05' })));
});

test('exact nonempty source + external ID survives content and publication updates', () => {
  verdict(facts(), copy({ title: 'Updated title', companyOrClient: '', description: '', publishedAt: '2025-01-01', sourceOccurrences: [occurrence('source-a', 'native-1', 'https://source-a.example/updated')] }), 'duplicate', 'source_identity');
  verdict(facts({ sourceOccurrences: [occurrence('source-a', 'CaseSensitive')] }), copy({ sourceOccurrences: [occurrence('source-a', 'casesensitive')] }), 'distinct', 'source_identity');
});

test('different opportunity types override even exact native identity and URL', () => {
  verdict(facts(), facts({ type: 'tender' }), 'distinct', null);
});

test('same source with different IDs remains distinct despite identical URL/title/body/fingerprint', () => {
  const sharedUrl = 'https://source-a.example/procedure/42';
  verdict(facts({ sourceOccurrences: [occurrence('source-a', '1', sharedUrl)] }), copy({ sourceOccurrences: [occurrence('source-a', '2', sharedUrl)] }), 'distinct', 'source_identity');
  verdict(facts({ sourceOccurrences: [occurrence('source-a', '1'), occurrence('other', 'A')] }), copy({ sourceOccurrences: [occurrence('source-a', '2'), occurrence('other', 'A')] }), 'distinct', 'source_identity');
});

test('empty external IDs do not create exact source identity or enable a same-source text merge', () => {
  verdict(facts({ sourceOccurrences: [occurrence('source-a', '')] }), copy({ sourceOccurrences: [occurrence('source-a', undefined, 'https://source-a.example/other')] }), 'ambiguous', 'fingerprint');
  verdict(facts({ sourceOccurrences: [] }), copy({ sourceOccurrences: [] }), 'ambiguous', 'fingerprint');
});

test('matching canonical URL tolerates tracking differences and sparse descriptions', () => {
  const url = 'https://employer.example/jobs/123?roleId=123';
  verdict(facts({ sourceOccurrences: [occurrence('source-a', '1', `${url}&utm_campaign=one#top`)], description: '', companyOrClient: '', location: undefined, publishedAt: undefined }), copy({ sourceOccurrences: [occurrence('source-b', '2', `${url}&fbclid=two`)], description: '', companyOrClient: '', location: undefined, publishedAt: undefined }), 'duplicate', 'canonical_url');
});

test('URL matches with conflicting explicit facts require review, and a homepage is not a job identity', () => {
  const sourceOccurrences = [occurrence('source-b', '2', 'https://source-a.example/jobs/native-1')];
  verdict(facts(), copy({ companyOrClient: 'OTHER COMPANY', sourceOccurrences }), 'ambiguous', 'canonical_url');
  verdict(facts(), copy({ location: 'Tokyo', sourceOccurrences }), 'ambiguous', 'canonical_url');
  verdict(facts({ sourceOccurrences: [occurrence('source-a', '1', 'https://employer.example')] }), copy({ sourceOccurrences: [occurrence('source-b', '2', 'https://employer.example/')] }), 'ambiguous', 'canonical_url');
});

test('true cross-source English and Russian copies merge through exact fingerprints', () => {
  verdict(facts(), copy(), 'duplicate', 'fingerprint');
  const ru = { title: 'Старший разработчик платформы', companyOrClient: 'Титан', location: 'Москва', description: ruBody };
  verdict(facts(ru), copy({ ...ru, title: ' СТАРШИЙ  разработчик платформы ', companyOrClient: 'ТИТАН', location: ' МОСКВА ' }), 'duplicate', 'fingerprint');
});

test('matching fingerprint with absent, short or conflicting descriptions stays ambiguous', () => {
  for (const description of ['', 'Great opportunity! Apply today.', 'Мы ищем разработчика. Хорошая команда.']) {
    verdict(facts({ description }), copy({ description }), 'ambiguous', 'fingerprint');
  }
  verdict(facts(), copy({ description: 'A restaurant service team welcomes an experienced cook to prepare breakfast, coordinate kitchen supplies, plan seasonal menus, train staff on hygiene procedures, manage customer requests, maintain equipment, and organize food delivery for local celebrations.' }), 'ambiguous', 'fingerprint');
  verdict(facts({ description: `${body} Salary is 100000 per year.` }), copy({ description: `${body} Salary is 120000 per year.` }), 'ambiguous', 'fingerprint');
  verdict(facts({ description: `${body} We do not require relocation.` }), copy({ description: `${body} We require relocation.` }), 'ambiguous', 'fingerprint');
});

test('close-date copies with slight title/body formatting differences can merge through fuzzy evidence', () => {
  verdict(facts(), copy({ title: 'Senior Platform Engineer.', description: `${body} Contact our team.`, publishedAt: '2026-10-06T10:00:00Z' }), 'duplicate', 'fuzzy');
});

test('fuzzy text cannot merge without counterpart, reliable body, publication or location', () => {
  for (const overrides of [
    { companyOrClient: '' }, { description: '' }, { publishedAt: undefined }, { location: undefined },
    { companyOrClient: '', description: '', publishedAt: undefined, title: 'Developer' },
  ]) verdict(facts(overrides), copy(overrides), 'ambiguous');
});

test('generic titles and shared boilerplate do not merge across different employers or levels', () => {
  verdict(facts({ title: 'Developer', companyOrClient: 'Alpha', description: '', publishedAt: undefined }), copy({ title: 'Developer', companyOrClient: 'Beta', description: '', publishedAt: undefined }), 'distinct', 'fuzzy');
  verdict(facts(), copy({ title: 'Junior Platform Engineer' }), 'distinct', 'fuzzy');
  verdict(facts({ title: 'Warehouse Supervisor', description: '' }), copy({ title: 'Database Administrator', description: '' }), 'distinct', 'fuzzy');
});

test('C++ / C# and explicit title numbers remain incompatible despite copied body', () => {
  verdict(facts({ title: 'Senior C++ Platform Engineer' }), copy({ title: 'Senior C# Platform Engineer' }), 'distinct', 'fuzzy');
  verdict(facts({ title: 'Разработчик C++ 17' }), copy({ title: 'Разработчик C++ 20' }), 'distinct', 'fuzzy');
});

test('different explicit stacks cannot be hidden by a shared title or boilerplate', () => {
  verdict(facts({ title: 'Python Backend Engineer' }), copy({ title: 'Java Backend Engineer' }), 'distinct', 'fuzzy');
  verdict(facts({ description: `${body} Develop services using Python and PostgreSQL.` }), copy({ description: `${body} Develop services using Java and Oracle.` }), 'ambiguous', 'fingerprint');
  verdict(facts({ description: `${body} Develop services using Python and PostgreSQL.` }), copy({ description: `${body} Develop services using Python and Postgres.` }), 'duplicate', 'fingerprint');
});

test('old/new postings are distinct even with the same URL; smaller date uncertainty requires review', () => {
  const sourceOccurrences = [occurrence('source-b', '2', 'https://source-a.example/jobs/native-1')];
  verdict(facts(), copy({ publishedAt: '2026-09-05', sourceOccurrences }), 'distinct', null);
  verdict(facts(), copy({ publishedAt: '2026-10-09' }), 'ambiguous', 'fuzzy');
});

test('different explicit tender lots/notices override copied text, procedure URL and native ID', () => {
  const base = facts({ type: 'tender', tenderData: { procedureNumber: 'P-100', lotNumber: '1', noticeNumber: 'N-100' } });
  verdict(base, facts({ type: 'tender', tenderData: { procedureNumber: 'P-100', lotNumber: '2', noticeNumber: 'N-100' } }), 'distinct', null);
  verdict(base, facts({ type: 'tender', tenderData: { procedureNumber: 'P-100', lotNumber: '1', officialNoticeNumber: 'N-200' } }), 'distinct', null);
  verdict(base, copy({ type: 'tender', sourceOccurrences: base.sourceOccurrences, tenderData: { procedureNumber: 'P-200', lotNumber: '1', noticeNumber: 'N-100' } }), 'distinct', null);
});

test('native lot query distinctions survive URL normalization and block tender fingerprint merge', () => {
  verdict(facts({ type: 'tender', sourceOccurrences: [occurrence('a', '1', 'https://tender.example/procedure?id=42&lot=1')] }), copy({ type: 'tender', sourceOccurrences: [occurrence('b', '2', 'https://tender.example/procedure?id=42&lot=2')] }), 'distinct', null);
});

test('same procedure URL without a verified lot is ambiguous; lot-specific URL can identify the same lot', () => {
  const shared = 'https://tender.example/procedure/42';
  verdict(facts({ type: 'tender', sourceOccurrences: [occurrence('a', '1', shared)] }), copy({ type: 'tender', sourceOccurrences: [occurrence('b', '2', shared)] }), 'ambiguous', 'canonical_url');
  verdict(facts({ type: 'tender', sourceOccurrences: [occurrence('a', '1', `${shared}?lot=1`)] }), copy({ type: 'tender', sourceOccurrences: [occurrence('b', '2', `${shared}?lot=1&utm_source=mirror`)] }), 'duplicate', 'canonical_url');
});

test('text-only tender copies require matching official notice and lot, not coincident local procedure IDs', () => {
  verdict(facts({ type: 'tender', tenderData: { procedureNumber: '123', lotNumber: '1' } }), copy({ type: 'tender', tenderData: { procedureNumber: '123', lotNumber: '1' } }), 'ambiguous', 'fingerprint');
  verdict(facts({ type: 'tender', tenderData: { procedureNumber: '123', lotNumber: '1', nativeNoticeNumber: '00123456' } }), copy({ type: 'tender', tenderData: { procedureNumber: '987', lotNumber: 1, noticeNumber: '00123456' } }), 'duplicate', 'fingerprint');
});

test('results are deterministic, symmetric, synchronous, do not mutate retained facts and do not call fetch', () => {
  const left = facts();
  const right = copy();
  const snapshot = JSON.stringify({ left, right });
  Object.freeze(left.sourceOccurrences[0]);
  Object.freeze(left.sourceOccurrences);
  Object.freeze(left.tenderData);
  Object.freeze(left);
  Object.freeze(right);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Deduplication must not use network'); };
  try {
    const result = verdict(left, right, 'duplicate', 'fingerprint');
    assert.deepEqual(compareDuplicateOpportunities(left, right), result);
    assert.equal(typeof result.then, 'undefined');
    assert.equal(JSON.stringify({ left, right }), snapshot);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
