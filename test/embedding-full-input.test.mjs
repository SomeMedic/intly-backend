import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');
const { ConfigService } = require('@nestjs/config');
const { EmbeddingsService } = require('../src/modules/knowledge/embeddings.service.ts');

function fixture({ complete = [1, 2, 3], consumed = complete, limit = 512, config = {} } = {}) {
  const inputs = [], tokens = [];
  const extractor = async input => { inputs.push(input); return { data: new Float32Array([1, 0]) }; };
  extractor.tokenizer = async (input, options) => { tokens.push({ input, options }); return { input_ids: options.truncation ? consumed : complete }; };
  extractor.tokenizer.model_max_length = limit;
  extractor.tokenizer.config = { tokenizer_class: 'test-tokenizer', model_max_length: limit };
  const service = new EmbeddingsService(new ConfigService(config));
  service.extractor = Promise.resolve(extractor);
  return { service, inputs, tokens };
}

test('full embedding attests the exact tokenizer input and does not cut an 8000-character tail', async () => {
  const f = fixture();
  const text = `${'А'.repeat(9000)} конец`;
  const result = await f.service.embedAttestedPassage(text);
  assert.equal(f.inputs[0], `passage: ${text}`);
  assert.equal(result.metadata.consumedInputUtf8Bytes, Buffer.byteLength(`passage: ${text}`));
  assert.equal(result.metadata.inputTokenCount, 3);
  assert.equal(result.metadata.truncated, false);
  assert.equal(f.tokens[0].options.truncation, false);
  assert.equal(f.tokens[1].options.truncation, true);
  await f.service.embedAttestedPassage(text);
  assert.equal(f.inputs.length, 1);
});

test('tokenizer truncation or token changes cannot authorize a full semantic embedding', async () => {
  for (const options of [{ complete: [1, 2, 3], consumed: [1, 2], limit: 2 }, { complete: [1, 2, 3], consumed: [1, 2, 4] }]) {
    const f = fixture(options);
    await assert.rejects(f.service.embedAttestedPassage('entire segment'), /exceeds tokenizer context/);
    assert.equal(f.inputs.length, 0);
  }
});

test('unattested HTTP embeddings remain unavailable for automatic semantic decisions', async () => {
  const f = fixture({ config: { EMBEDDING_BASE_URL: 'https://embedding.example.test' } });
  await assert.rejects(f.service.embedAttestedPassage('entire segment'), /completeness evidence/);
  assert.equal(f.inputs.length, 0);
});

test('cosine rejects unequal dimensions and nonfinite values rather than comparing a common prefix', () => {
  const f = fixture();
  assert.equal(f.service.similarity([1, 0], [1, 0, 5]), 0);
  assert.equal(f.service.similarity([1, NaN], [1, 0]), 0);
  assert.equal(f.service.similarity([1, 0], [1, 0]), 1);
});
