import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const {
  SEMANTIC_DUPLICATE_POLICY, semanticOpportunityFacts, semanticDuplicateFactHash,
  buildSemanticEmbeddingPlan, semanticDuplicateEligibility, compareSemanticDuplicateOpportunities,
  semanticCosineSimilarity,
} = require('../src/modules/opportunities/opportunity-semantic-duplicates.ts');

const body = 'Our platform engineering team builds reliable distributed services for enterprise customers. You will design deployment workflows, improve observability, review infrastructure changes, collaborate with product teams, and document practical operational decisions. We value clear communication, thoughtful ownership, careful debugging, and proven experience shipping production software.';
const paraphrase = 'Join our infrastructure group to deliver dependable software for business clients. The role covers release automation, system visibility, architectural reviews and collaboration across departments. Write useful operational guides, investigate production incidents and improve service quality through responsible technical decisions and effective communication with colleagues.';
const ruBody = 'Команда платформы разрабатывает надёжные распределённые сервисы для корпоративных клиентов. Вы будете проектировать процессы доставки, улучшать мониторинг, проверять изменения инфраструктуры, сотрудничать с продуктовыми командами и документировать технические решения. Нам важны понятная коммуникация, ответственность, внимательная диагностика и опыт разработки промышленного программного обеспечения.';
const occurrence = (sourceId, externalId, url = `https://${sourceId}.example/jobs/${externalId}`) => ({ sourceId, externalId, url });
const facts = (overrides = {}) => ({
  _id: 'canonical-a', type: 'vacancy', title: 'Senior Platform Engineer', companyOrClient: 'ACME',
  description: body, location: 'Berlin', publishedAt: new Date('2026-10-05T12:00:00Z'),
  sourceOccurrences: [occurrence('source-a', 'native-1')], tenderData: {}, ...overrides,
});
const copy = (overrides = {}) => facts({ _id: 'canonical-b', description: paraphrase, sourceOccurrences: [occurrence('source-b', 'native-2')], ...overrides });

// Deliberately synthetic unit vectors/token counts test the decision contract.
// They are not model outputs, calibration data or a live inference proof.
function attestedEvidence(input, options = {}, vector = [1, 0]) {
  const plan = buildSemanticEmbeddingPlan(input, options);
  assert.ok(plan);
  const embed = (chunk) => ({
    index: chunk.index, startByte: chunk.startByte, endByte: chunk.endByte, textHash: chunk.textHash,
    vector: [...vector],
    metadata: {
      model: 'unit-test-vectors', version: 'synthetic-v1', dimension: vector.length,
      inputHash: chunk.inputHash, inputKind: 'passage', inputTokenCount: 20,
      maxInputTokens: 512, consumedInputUtf8Bytes: chunk.inputUtf8Bytes, truncated: false,
      tokenizer: 'unit-test-tokenizer', tokenizerVersion: 'synthetic-v1',
    },
  });
  return { ...plan, title: plan.title.map(embed), description: plan.description.map(embed) };
}
const pair = (left, right, options = {}) => ({ left: attestedEvidence(left, options), right: attestedEvidence(right, options) });
function assertReview(left, right, evidence, reason) {
  const result = compareSemanticDuplicateOpportunities(left, right, evidence);
  assert.equal(result.verdict, 'ambiguous', JSON.stringify(result.reasons));
  assert.equal(result.semanticApplied, false);
  assert.equal(result.evidence, null);
  if (reason) assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
  return result;
}

test('only ambiguous candidates with every deterministic guard satisfied are eligible', () => {
  const eligibility = semanticDuplicateEligibility(facts(), copy());
  assert.equal(eligibility.baseDecision.verdict, 'ambiguous');
  assert.equal(eligibility.eligible, true, JSON.stringify(eligibility.reasons));
  assert.deepEqual(eligibility.reasons, []);
  assert.match(eligibility.factsHashes.left, /^[a-f0-9]{64}$/);
  const ru = copy({ description: ruBody });
  assert.equal(semanticDuplicateEligibility(facts(), ru).eligible, true);
});

test('ordinary exact identity, fingerprint and successful fuzzy duplicates never apply semantics', () => {
  for (const [left, right] of [
    [facts(), facts({ description: paraphrase })],
    [facts(), copy({ description: body })],
    [facts(), copy({ title: 'Senior Platform Engineer.', description: body, publishedAt: '2026-10-06' })],
  ]) {
    assert.equal(semanticDuplicateEligibility(left, right).eligible, false);
    const result = compareSemanticDuplicateOpportunities(left, right);
    assert.equal(result.verdict, 'duplicate');
    assert.equal(result.semanticApplied, false);
    assert.equal(result.evidence, null);
  }
});

test('native/type/tender lot and far-date distinct decisions cannot be overridden by perfect vectors', () => {
  const base = facts();
  for (const right of [
    copy({ type: 'freelance' }),
    copy({ sourceOccurrences: [occurrence('source-a', 'different-native-id')] }),
    copy({ publishedAt: '2026-09-01' }),
  ]) {
    const result = compareSemanticDuplicateOpportunities(base, right, pair(base, right));
    assert.equal(result.verdict, 'distinct');
    assert.equal(result.semanticApplied, false);
  }
  const tender = facts({ type: 'tender', tenderData: { lotNumber: '1', noticeNumber: 'N-100' } });
  for (const tenderData of [{ lotNumber: '2', noticeNumber: 'N-100' }, { lotNumber: '1', noticeNumber: 'N-200' }]) {
    const right = copy({ type: 'tender', tenderData });
    assert.equal(compareSemanticDuplicateOpportunities(tender, right, pair(tender, right)).verdict, 'distinct');
  }
});

test('ambiguous company/location conflicts remain blocked even when the body and vectors agree', () => {
  for (const overrides of [{ companyOrClient: 'Other Company' }, { location: 'Tokyo' }]) {
    const left = facts();
    const right = copy({ ...overrides, description: body, publishedAt: '2026-10-06' });
    assert.equal(semanticDuplicateEligibility(left, right).baseDecision.verdict, 'ambiguous');
    assert.equal(semanticDuplicateEligibility(left, right).eligible, false);
    assertReview(left, right, pair(left, right));
  }
});

test('title technologies/numbers and body numeric/negation conflicts cannot be overridden', () => {
  const shared = 'https://employer.example/jobs/123';
  for (const [titleA, titleB] of [
    ['Senior C++ Platform Engineer', 'Senior C# Platform Engineer'],
    ['Разработчик C++ 17', 'Разработчик C++ 20'],
  ]) {
    const left = facts({ title: titleA, sourceOccurrences: [occurrence('a', '1', shared)] });
    const right = copy({ title: titleB, sourceOccurrences: [occurrence('b', '2', shared)] });
    assert.equal(semanticDuplicateEligibility(left, right).eligible, false);
    assertReview(left, right, pair(left, right));
  }
  for (const [bodyA, bodyB] of [
    [`${body} Salary is 100000 per year.`, `${body} Salary is 120000 per year.`],
    [`${body} We do not require relocation.`, `${body} We require relocation.`],
  ]) {
    const left = facts({ description: bodyA });
    const right = copy({ description: bodyB });
    assertReview(left, right, pair(left, right), 'descriptions_incompatible');
  }
});

test('additional explicit Java/Python, frontend and cloud stack conflicts remain review', () => {
  const shared = 'https://employer.example/jobs/123';
  for (const [a, b] of [['Java', 'Python'], ['React', 'Angular'], ['AWS', 'Azure']]) {
    const left = facts({ title: `Senior ${a} Platform Engineer`, sourceOccurrences: [occurrence('a', '1', shared)] });
    const right = copy({ title: `Senior ${b} Platform Engineer`, sourceOccurrences: [occurrence('b', '2', shared)] });
    assert.equal(semanticDuplicateEligibility(left, right).eligible, false);
    assertReview(left, right, pair(left, right), 'explicit_title_technologies_incompatible');
  }
  const left = facts({ description: `${body} The required language is Java.` });
  const right = copy({ description: `${paraphrase} The required language is Python.` });
  assertReview(left, right, pair(left, right), 'explicit_body_technologies_incompatible');
});

test('missing publication/body/counterpart/location/native provenance and loose dates stay review', () => {
  for (const overrides of [
    { companyOrClient: '' }, { location: undefined }, { publishedAt: null },
    { publishedAt: '05.10.2026' }, { description: 'A good job.' }, { sourceOccurrences: [] },
  ]) {
    const left = facts(overrides);
    const right = copy(overrides);
    assert.equal(semanticDuplicateEligibility(left, right).eligible, false);
    assertReview(left, right);
  }
  assertReview(facts(), copy({ publishedAt: '2026-10-09' }), undefined, 'publication_dates_not_close');
});

test('text-only tender semantics requires the same verified notice and lot', () => {
  const left = facts({ type: 'tender', tenderData: { procedureNumber: '123', lotNumber: '1' } });
  const right = copy({ type: 'tender', tenderData: { procedureNumber: '123', lotNumber: '1' } });
  assertReview(left, right, pair(left, right), 'tender_notice_and_lot_identity_unverified');
  left.tenderData.noticeNumber = 'N-100';
  right.tenderData.officialNoticeNumber = 'N-100';
  assert.equal(semanticDuplicateEligibility(left, right).eligible, true);
});

test('full document and candidate projection share one relevant hash with stable absent fields', () => {
  const projection = facts();
  const full = {
    ...projection, updatedAt: new Date(), firstSeenAt: new Date(), money: { min: 1000 }, privateRevision: 42,
    sourceOccurrences: [{ ...projection.sourceOccurrences[0], rawPayload: { secret: 'excluded' }, sourceMetadata: { private: true }, firstSeenAt: new Date() }],
  };
  assert.equal(semanticDuplicateFactHash(full), semanticDuplicateFactHash(projection));
  const snapshot = semanticOpportunityFacts(full);
  assert.deepEqual(Object.keys(snapshot.sourceOccurrences[0]).sort(), ['externalId', 'sourceId', 'url']);
  assert.equal(snapshot.updatedAt, undefined);
  assert.equal(snapshot.privateRevision, undefined);
  assert.equal(snapshot.description, body);
  assert.equal(semanticDuplicateFactHash({ ...projection, publishedAt: projection.publishedAt.toISOString() }), semanticDuplicateFactHash(projection));
  const absent = { ...projection, location: undefined, publishedAt: undefined, tenderData: undefined, sourceOccurrences: [occurrence('a', undefined, 'https://a.example/job')] };
  const nulls = { ...absent, location: null, publishedAt: null, tenderData: null, sourceOccurrences: [{ ...absent.sourceOccurrences[0], externalId: null }] };
  assert.equal(semanticDuplicateFactHash(absent), semanticDuplicateFactHash(nulls));
});

test('full body tail, tender facts and source identity/URL changes invalidate the relevant hash', () => {
  const long = facts({ description: body.repeat(30) });
  assert.ok(long.description.length > 8000);
  assert.notEqual(semanticDuplicateFactHash(long), semanticDuplicateFactHash({ ...long, description: `${long.description} Changed final requirement.` }));
  for (const overrides of [
    { tenderData: { lotNumber: '2' } }, { sourceOccurrences: [occurrence('a', 'other')] },
    { sourceOccurrences: [occurrence('source-a', 'native-1', 'https://source-a.example/jobs/other')] },
  ]) assert.notEqual(semanticDuplicateFactHash(facts()), semanticDuplicateFactHash(facts(overrides)));
  assert.equal(semanticDuplicateFactHash(facts({ tenderData: { a: 1, b: { x: 2, y: 3 } } })), semanticDuplicateFactHash(facts({ tenderData: { b: { y: 3, x: 2 }, a: 1 } })));
});

test('chunk layout is deterministic, contiguous and lossless across RU/emoji/C++/UTF-8 boundaries', () => {
  const input = facts({ title: ' Разработчик C++ 🚀 ', description: `${ruBody} 🧑‍💻 ${ruBody}` });
  const plan = buildSemanticEmbeddingPlan(input, { chunkBytes: 64 });
  assert.ok(plan);
  assert.deepEqual(plan, buildSemanticEmbeddingPlan(input, { chunkBytes: 64 }));
  for (const field of ['title', 'description']) {
    assert.equal(plan[field].map((chunk) => chunk.text).join(''), input[field]);
    let end = 0;
    for (const [index, chunk] of plan[field].entries()) {
      assert.equal(chunk.index, index);
      assert.equal(chunk.startByte, end);
      assert.equal(Buffer.byteLength(chunk.text), chunk.endByte - chunk.startByte);
      assert.ok(Buffer.byteLength(chunk.text) <= 64);
      assert.equal(Buffer.from(input[field]).subarray(chunk.startByte, chunk.endByte).toString(), chunk.text);
      assert.ok(chunk.input.length < 8000);
      end = chunk.endByte;
    }
    assert.equal(end, Buffer.byteLength(input[field]));
  }
});

test('passage prefix hashes match the exact service contract including configured and pre-existing prefix', () => {
  for (const passagePrefix of ['passage: ', '', 'document: ']) {
    const input = facts({ title: ` ${passagePrefix}Engineer ` });
    const plan = buildSemanticEmbeddingPlan(input, { passagePrefix });
    assert.equal(plan.title[0].input, `${passagePrefix}Engineer`);
    assert.equal(plan.title[0].inputUtf8Bytes, Buffer.byteLength(`${passagePrefix}Engineer`));
  }
});

test('planning rejects oversized budgets, invalid UTF-8 and unhashable relevant facts without clipping', () => {
  assert.equal(buildSemanticEmbeddingPlan(facts(), { chunkBytes: 16 }), null);
  assert.equal(buildSemanticEmbeddingPlan(facts({ description: 'x'.repeat(512 * 129) })), null);
  assert.equal(buildSemanticEmbeddingPlan(facts({ title: 'Bad\ud800title' })), null);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(semanticDuplicateFactHash(facts({ tenderData: cyclic })), null);
  assert.equal(semanticDuplicateEligibility(facts({ tenderData: cyclic }), copy()).eligible, false);
});

test('strict cosine rejects mismatched dimensions, invalid/zero vectors and remains numerically stable', () => {
  assert.equal(semanticCosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(semanticCosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(semanticCosineSimilarity([1, 0], [-1, 0]), -1);
  assert.ok(Math.abs(semanticCosineSimilarity([1e308, 1e308], [1e308, 1e308]) - 1) < 1e-12);
  for (const [left, right] of [[[], []], [[0, 0], [1, 0]], [[1], [1, 0]], [[NaN, 0], [1, 0]], [[Infinity], [1]], [['1'], [1]]]) assert.equal(semanticCosineSimilarity(left, right), null);
});

test('complete attested title/body evidence can resolve an eligible ambiguous pair with a durable audit', () => {
  const left = facts(); const right = copy();
  const evidence = pair(left, right);
  const result = compareSemanticDuplicateOpportunities(left, right, evidence);
  assert.equal(result.verdict, 'duplicate');
  assert.equal(result.level, 'semantic');
  assert.equal(result.semanticApplied, true);
  assert.equal(result.evidence.policyVersion, SEMANTIC_DUPLICATE_POLICY.version);
  assert.equal(result.evidence.model, 'unit-test-vectors');
  assert.equal(result.evidence.description.minimum, 1);
  assert.equal(result.evidence.left.factsHash, semanticDuplicateFactHash(left));
  assert.equal(result.evidence.left.description[0].metadata.inputHash, evidence.left.description[0].metadata.inputHash);
  assert.equal(result.evidence.left.description[0].vector, undefined);
  const reverse = compareSemanticDuplicateOpportunities(right, left, { left: evidence.right, right: evidence.left });
  assert.equal(reverse.verdict, result.verdict);
  assert.equal(reverse.evidence.description.minimum, result.evidence.description.minimum);
});

test('missing evidence/current service metadata without tokenizer attestation remains review', () => {
  assertReview(facts(), copy(), undefined, 'semantic_evidence_missing');
  const evidence = pair(facts(), copy());
  for (const field of ['title', 'description']) for (const entry of evidence.left[field]) {
    const { model, version, dimension, inputHash } = entry.metadata;
    entry.metadata = { model, version, dimension, inputHash, inputKind: 'passage' };
  }
  assertReview(facts(), copy(), evidence, 'semantic_model_metadata_incomplete');
});

test('truncation, token overflow, absent tokenizer count or partial consumed bytes blocks perfect cosine', () => {
  for (const metadata of [
    { truncated: true }, { truncated: undefined }, { inputTokenCount: 513 }, { inputTokenCount: undefined },
    { maxInputTokens: 0 }, { consumedInputUtf8Bytes: 1 }, { inputKind: 'query' }, { inputHash: 'wrong' },
  ]) {
    const evidence = pair(facts(), copy());
    Object.assign(evidence.right.description[0].metadata, metadata);
    assertReview(facts(), copy(), evidence);
  }
});

test('wrong models/versions/tokenizers/dimensions and nonfinite vectors cannot authorize a merge', () => {
  for (const metadata of [
    { model: 'other-model' }, { version: 'other-version' }, { tokenizerVersion: 'other-tokenizer' },
    { dimension: 3 }, { tokenizer: '' },
  ]) {
    const evidence = pair(facts(), copy());
    Object.assign(evidence.right.description[0].metadata, metadata);
    assertReview(facts(), copy(), evidence);
  }
  const evidence = pair(facts(), copy());
  evidence.left.description[0].vector = [NaN, 0];
  assertReview(facts(), copy(), evidence, 'semantic_embedding_vector_invalid');
});

test('stale full fact hashes and mismatched segment layout/prefix cannot be replayed', () => {
  const left = facts(); const right = copy();
  assertReview(left, { ...right, description: `${paraphrase} Additional distinct content.` }, pair(left, right), 'semantic_facts_hash_stale');
  assertReview(left, { ...right, sourceOccurrences: [occurrence('source-b', 'changed-native-id')] }, pair(left, right), 'semantic_facts_hash_stale');
  for (const change of [
    (e) => { e.right.description[0].endByte -= 1; },
    (e) => { e.right.description[0].textHash = 'wrong'; },
    (e) => { e.right.passagePrefix = 'query: '; },
    (e) => { e.right.chunkBytes = 128; },
  ]) {
    const evidence = pair(left, right); change(evidence);
    assertReview(left, right, evidence);
  }
});

test('a single capped vector never substitutes for all body chunks beyond 8000 characters', () => {
  const left = facts({ description: body.repeat(25) });
  const right = copy({ description: paraphrase.repeat(25) });
  assert.ok(left.description.length > 8000);
  const evidence = pair(left, right);
  assert.ok(evidence.left.description.length > 1);
  evidence.left.description = evidence.left.description.slice(0, 1);
  assertReview(left, right, evidence, 'semantic_full_text_coverage_incomplete');
});

test('bidirectional full-body matching keeps an unmatched final tail on review despite a strong average', () => {
  const left = facts({ description: body.repeat(25) });
  const right = copy({ description: paraphrase.repeat(25) });
  const evidence = pair(left, right);
  evidence.right.description.at(-1).vector = [0, 1];
  const result = compareSemanticDuplicateOpportunities(left, right, evidence);
  assert.equal(result.verdict, 'ambiguous');
  assert.equal(result.semanticApplied, true);
  assert.equal(result.evidence.description.minimum, 0);
  assert.ok(result.evidence.description.weightedMean > 0.9);
});

test('negative semantic verdict needs fully attested low similarity for both title and every body segment', () => {
  const left = facts(); const right = copy();
  const evidence = { left: attestedEvidence(left), right: attestedEvidence(right, {}, [0, 1]) };
  const result = compareSemanticDuplicateOpportunities(left, right, evidence);
  assert.equal(result.verdict, 'distinct');
  assert.equal(result.semanticApplied, true);
  evidence.right.title[0].vector = [1, 0];
  assert.equal(compareSemanticDuplicateOpportunities(left, right, evidence).verdict, 'ambiguous');
});

test('pure helpers never call inference/network or mutate facts/evidence; audit metadata is detached', () => {
  const left = facts(); const right = copy(); const evidence = pair(left, right);
  const before = JSON.stringify({ left, right, evidence });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Pure semantic helpers must not use network'); };
  try {
    const result = compareSemanticDuplicateOpportunities(left, right, evidence);
    assert.equal(JSON.stringify({ left, right, evidence }), before);
    assert.equal(typeof result.then, 'undefined');
    evidence.left.description[0].metadata.model = 'mutated later';
    assert.equal(result.evidence.left.description[0].metadata.model, 'unit-test-vectors');
  } finally {
    globalThis.fetch = oldFetch;
  }
});
