import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');
const { decodeDuplicateReviewCursor, encodeDuplicateReviewCursor, duplicateReviewSearchPattern } = require('../src/modules/opportunities/opportunity-duplicate-review-list.ts');
const id = '11111111-1111-4111-8111-111111111111';

test('review cursor retains the exact tied timestamp and UUID sort key', () => {
  const checkedAt = new Date('2026-10-06T18:43:05.123Z');
  const cursor = encodeDuplicateReviewCursor({ _id: id, checkedAt });
  assert.deepEqual(decodeDuplicateReviewCursor(cursor), { checkedAt, id });
  assert.equal(decodeDuplicateReviewCursor(undefined), undefined);
});

test('untrusted review cursors cannot inject query operators or invalid dates', () => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const value of [
    'not-json', '%broken', 'a'.repeat(301),
    encode({ checkedAt: 'bad-date', id }),
    encode({ checkedAt: '2026-10-06', id }),
    encode({ checkedAt: '2026-10-06T18:43:05.123Z', id: { $gt: '' } }),
    encode({ checkedAt: { $gt: '' }, id }),
  ]) assert.throws(() => decodeDuplicateReviewCursor(value), /Invalid duplicate review cursor/);
});

test('review search treats punctuation and regex quantifiers as literal title text', () => {
  const input = 'C++ [remote] (QA) .* $500 \\';
  const pattern = new RegExp(duplicateReviewSearchPattern(input), 'i');
  assert.ok(pattern.test(`Position: ${input}`));
  assert.equal(pattern.test('C remote QA hello 500'), false);
});
