import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { normalizeAiCallUsage, priceAiCall } = require('../src/modules/ai/ai-cost.ts');

test('normalizeAiCallUsage persists only safe numeric usage counters', () => {
  const usage = normalizeAiCallUsage({
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    inputTokenDetails: { cacheReadTokens: 30 },
    apiKey: 'secret',
    requestHeaders: { authorization: 'Bearer secret' },
    providerResponse: { id: 'raw-response' },
    negativeTokens: -1,
  });

  assert.deepEqual(usage, {
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    cachedInputTokens: 30,
  });
  assert.equal(JSON.stringify(usage).includes('secret'), false);
  assert.equal(JSON.stringify(usage).includes('raw-response'), false);
});

test('priceAiCall applies cached input discount and does not add reasoning tokens twice', () => {
  const usage = priceAiCall({
    inputTokens: 1_000,
    outputTokens: 200,
    totalTokens: 1_230,
    reasoningTokens: 30,
    inputTokenDetails: { cacheReadTokens: 400 },
  }, {
    modelId: 'priced-model',
    inputPerMillion: 10,
    cachedInputPerMillion: 1,
    outputPerMillion: 20,
  });

  assert.equal(usage.estimatedCost, 0.0104);
  assert.equal(usage.outputTokens, 200);
  assert.equal(usage.totalTokens, 1_230);
  assert.equal(usage.costBasis, 'reported-cache');
});

test('priceAiCall returns null cost when pricing is unknown', () => {
  const usage = priceAiCall({ inputTokens: 5, outputTokens: 7 });

  assert.equal(usage.estimatedCost, null);
  assert.equal('pricing' in usage, false);
});

test('priceAiCall returns null cost when billable tokens are incomplete', () => {
  const usage = priceAiCall({ inputTokens: 5 }, {
    modelId: 'priced-model',
    inputPerMillion: 1,
    outputPerMillion: 1,
  });

  assert.equal(usage.estimatedCost, null);
  assert.equal(usage.pricing.modelId, 'priced-model');
});

test('priceAiCall returns zero cost for explicit zero model prices', () => {
  const usage = priceAiCall({ inputTokens: 5, outputTokens: 7 }, {
    modelId: 'free-model',
    inputPerMillion: 0,
    outputPerMillion: 0,
  });

  assert.equal(usage.estimatedCost, 0);
});

test('priceAiCall snapshots the exact model price for the attempt', () => {
  const pricing = {
    modelId: 'snapshot-model',
    inputPerMillion: 3,
    outputPerMillion: 9,
    sourceUrl: 'https://prices.example/snapshot',
  };
  const usage = priceAiCall({ inputTokens: 1, outputTokens: 1 }, pricing);
  pricing.inputPerMillion = 300;
  pricing.sourceUrl = 'https://prices.example/changed';

  assert.deepEqual(usage.pricing, {
    modelId: 'snapshot-model',
    inputPerMillion: 3,
    outputPerMillion: 9,
    sourceUrl: 'https://prices.example/snapshot',
  });
});
