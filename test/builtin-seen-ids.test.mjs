import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.TS_NODE_PROJECT = resolve(backend, 'tsconfig.json');
const require = createRequire(import.meta.url);
require('../node_modules/ts-node/register/transpile-only');
const { encodeBuiltinSeenIds, decodeBuiltinSeenIds } = require('../src/modules/sources/connectors/builtin-seen-ids.ts');

test('round-trips exact ID history in original order, including IDs outside Number precision', () => {
  for (const ids of [[], ['11520105', '11179143', '99999999999999999999']]) {
    const checkpoint = encodeBuiltinSeenIds(ids);
    assert.deepEqual(decodeBuiltinSeenIds(checkpoint), ids);
    assert.equal(checkpoint.uniqueSeen, ids.length);
  }
  assert.equal(decodeBuiltinSeenIds({ seenExternalIds: ['11520105'] }), undefined);
});

test('compresses a large exact set without truncation or probabilistic dedup', () => {
  const ids = Array.from({ length: 100_000 }, (_, index) => String(10_000_000 + index));
  const checkpoint = encodeBuiltinSeenIds(ids);
  assert.ok(checkpoint.seenExternalIdsCompressed.length < JSON.stringify(ids).length / 2);
  assert.deepEqual(decodeBuiltinSeenIds(checkpoint), ids);
});

test('rejects corrupted, conflicting, duplicate, or unsupported ID history', () => {
  const checkpoint = encodeBuiltinSeenIds(['11520105']);
  assert.throws(() => encodeBuiltinSeenIds(['11520105', '11520105']), /duplicate/);
  assert.throws(() => encodeBuiltinSeenIds(['not-native']), /invalid/);
  assert.throws(() => decodeBuiltinSeenIds({ ...checkpoint, uniqueSeen: 0 }), /count/);
  assert.throws(() => decodeBuiltinSeenIds({ ...checkpoint, seenIdsEncoding: 'future' }), /unsupported/);
  assert.throws(() => decodeBuiltinSeenIds({ ...checkpoint, seenExternalIdsCompressed: '!!!!' }), /malformed/);
  assert.throws(() => decodeBuiltinSeenIds({ ...checkpoint, seenExternalIdsCompressed: Buffer.from('corrupt').toString('base64') }), /restored/);
  assert.throws(() => decodeBuiltinSeenIds({ ...checkpoint, seenExternalIds: ['11179143'] }), /conflicting/);
  assert.throws(() => decodeBuiltinSeenIds({ ...checkpoint, seenExternalIdsCompressed: deflateSync('11520105\n11520105').toString('base64'), uniqueSeen: 2 }), /duplicate/);
});
