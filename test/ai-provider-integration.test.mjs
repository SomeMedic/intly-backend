import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { z } = require('zod');
const { AiProviderRunnerService, AiProviderCallError, safeProviderError } = require('../src/modules/ai/ai-provider-runner.service.ts');
const { AiProviderHealthService } = require('../src/modules/ai/ai-provider-health.service.ts');
const { AiRepository } = require('../src/modules/ai/ai.repository.ts');

async function localGoogle(handler, action) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { return await action(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

function runnerInput(baseUrl, signal) {
  return {
    provider: { provider: 'gemini', enabled: true, apiKeyEncrypted: 'encrypted-test-only', baseUrl },
    route: { temperature: 0, maxOutputTokens: 128 }, modelId: 'fixture-model',
    schema: z.object({ ok: z.literal(true) }), prompt: 'Synthetic fixture only', abortSignal: signal,
  };
}

test('installed AI SDK/provider validates structured output and returns actual tokens from loopback Google protocol', async () => {
  let requests = 0;
  await localGoogle(async (req, res) => {
    requests++;
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    assert.match(req.url, /fixture-model:generateContent/);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } }));
  }, async baseUrl => {
    const runner = new AiProviderRunnerService({ decrypt: () => 'local-fixture-key' });
    const output = await runner.generateObject(runnerInput(baseUrl));
    assert.deepEqual(output.object, { ok: true });
    assert.equal(output.usage.inputTokens, 3); assert.equal(output.usage.outputTokens, 4);
  });
  assert.equal(requests, 1);
});

test('SDK automatic retries are disabled and raw provider secrets are not propagated', async () => {
  let requests = 0;
  await localGoogle((_req, res) => {
    requests++; res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'secret-in-sdk-body local-fixture-key', status: 'UNAVAILABLE' } }));
  }, async baseUrl => {
    const runner = new AiProviderRunnerService({ decrypt: () => 'local-fixture-key' });
    await assert.rejects(runner.generateObject(runnerInput(baseUrl)), error => {
      assert(error instanceof AiProviderCallError); assert.equal(error.retryable, true);
      assert.equal(error.code, 'AI_PROVIDER_UNAVAILABLE');
      assert(!JSON.stringify(error).includes('secret-in-sdk-body')); assert(!error.message.includes('local-fixture-key'));
      return true;
    });
  });
  assert.equal(requests, 1);
});

for (const provider of ['openai', 'deepseek']) test(`installed ${provider} adapter returns protected structured result through its actual loopback protocol`, async () => {
  let requests = 0;
  await localGoogle(async (req, res) => {
    requests++;
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); assert.equal(body.model, 'fixture-model');
    const response = provider === 'openai'
      ? { id: 'fixture-response', object: 'response', created_at: 1, status: 'completed', model: 'fixture-model', output: [{ id: 'fixture-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }] }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }
      : { id: 'fixture-completion', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
  }, async baseUrl => {
    const runner = new AiProviderRunnerService({ decrypt: () => 'local-fixture-key' });
    const input = runnerInput(baseUrl); input.provider.provider = provider;
    const output = await runner.generateObject(input);
    assert.deepEqual(output.object, { ok: true }); assert.equal(output.usage.totalTokens, 7);
  });
  assert.equal(requests, 1);
});

test('caller abort cancels the real SDK request with sanitized abort error', async () => {
  let received;
  const started = new Promise(resolve => { received = resolve; });
  await localGoogle((_req, _res) => received(), async baseUrl => {
    const controller = new AbortController();
    const runner = new AiProviderRunnerService({ decrypt: () => 'local-fixture-key' });
    const pending = runner.generateObject(runnerInput(baseUrl, controller.signal));
    await started; controller.abort();
    await assert.rejects(pending, error => error instanceof AiProviderCallError && error.code === 'AI_RUN_CANCELLED' && error.message === 'AI request cancelled');
  });
});

test('provider classifications never persist raw headers/response even for authentication failures', () => {
  const error = safeProviderError({ statusCode: 401, message: 'token=private', requestBodyValues: { apiKey: 'private' }, responseBody: 'private' });
  assert.equal(error.code, 'AI_AUTHENTICATION_FAILED'); assert.equal(error.retryable, false);
  assert(!JSON.stringify(error).includes('private')); assert(!error.message.includes('private'));
});

test('safeProviderError keeps sanitized usage from SDK output validation errors', () => {
  const error = safeProviderError({
    name: 'AI_NoObjectGeneratedError',
    message: 'raw secret should not be exposed',
    usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24, requestBody: 'secret' },
  });

  assert.equal(error.code, 'AI_OUTPUT_INVALID');
  assert.deepEqual(error.usage, { inputTokens: 11, outputTokens: 13, totalTokens: 24 });
  assert.equal(JSON.stringify(error).includes('secret'), false);
});

test('installed AI SDK retains usage when loopback provider returns invalid structured output', async () => {
  await localGoogle(async (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":false}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, totalTokenCount: 11 },
    }));
  }, async baseUrl => {
    const runner = new AiProviderRunnerService({ decrypt: () => 'local-fixture-key' });
    await assert.rejects(runner.generateObject(runnerInput(baseUrl)), error => {
      assert(error instanceof AiProviderCallError);
      assert.equal(error.code, 'AI_OUTPUT_INVALID');
      assert.deepEqual(error.usage, { inputTokens: 5, outputTokens: 6, totalTokens: 11, cachedInputTokens: 0 });
      return true;
    });
  });
});

test('provider health only runs synthetic saved-config check, persists safe result and records audit', async () => {
  const calls = [], writes = [], audits = [];
  const config = { provider: 'gemini', enabled: true, apiKeyEncrypted: 'saved-test-only' };
  const service = new AiProviderHealthService(
    { getProvider: async () => config, recordProviderHealth: async (saved, health) => { writes.push({ saved, health }); return true; } },
    { generateObject: async input => { calls.push(input); return { object: { ok: true } }; } },
    { record: async (...args) => audits.push(args) },
  );
  const result = await service.test({ id: 'admin', role: 'Admin' }, 'gemini', ' fixture-model ');
  assert.equal(result.status, 'healthy'); assert.equal(result.persisted, true);
  assert.equal(result.modelId, 'fixture-model'); assert(result.latencyMs >= 0);
  assert.equal(calls.length, 1); assert.match(calls[0].prompt, /synthetic/); assert(!calls[0].prompt.includes('saved-test-only'));
  assert.equal(writes.length, 1); assert.equal(audits[0][1], 'ai.provider.test');
});

test('disabled provider health is truthful and does not call SDK', async () => {
  const service = new AiProviderHealthService(
    { getProvider: async () => ({ provider: 'openai', enabled: false }), recordProviderHealth: async () => true },
    { generateObject: async () => { throw new Error('must not call SDK'); } }, { record: async () => undefined },
  );
  const result = await service.test({ id: 'admin', role: 'Admin' }, 'openai', 'fixture');
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'AI_PROVIDER_UNAVAILABLE');
});

test('initial catalog preserves existing administrator routes/providers and inserts six routable task defaults', async () => {
  const providers = new Map([['gemini', { provider: 'gemini', enabled: true, apiKeyEncrypted: 'retained', baseUrl: 'https://saved.example' }]]);
  const routes = new Map([['response_generation', { taskType: 'response_generation', primaryProvider: 'deepseek', primaryModel: 'chosen', retryCount: 0 }]]);
  const update = (map, key) => ({ updateOne: async (query, update) => { if (!map.has(query[key])) map.set(query[key], update.$setOnInsert); } });
  const repository = new AiRepository({}, update(providers, 'provider'), update(routes, 'taskType'), {});
  await repository.initializeConfiguration(); await repository.initializeConfiguration();
  assert.equal(providers.size, 3); assert.equal(routes.size, 6);
  assert.equal(providers.get('gemini').apiKeyEncrypted, 'retained'); assert.equal(providers.get('openai').enabled, false);
  assert.equal(routes.get('response_generation').primaryModel, 'chosen'); assert.equal(routes.get('response_generation').retryCount, 0);
  assert.equal(routes.get('document_extraction').primaryProvider, 'gemini');
  assert.equal(routes.get('document_extraction').primaryModel, 'gemini-2.5-flash');
});

test('provider health cannot mark changed credential or newer configuration as healthy', async () => {
  let query;
  const repository = new AiRepository({}, { updateOne: async filter => { query = filter; return { matchedCount: 0 }; } }, {}, {});
  const persisted = await repository.recordProviderHealth({ provider: 'gemini', enabled: true, apiKeyEncrypted: 'old-encrypted-key', baseUrl: 'https://old.example' }, { checkedAt: '2026-10-06T00:00:00.000Z', status: 'healthy' });
  assert.equal(persisted, false); assert.equal(query.apiKeyEncrypted, 'old-encrypted-key'); assert.equal(query.baseUrl, 'https://old.example');
  assert.equal(query.$or[1]['health.checkedAt'].$lte, '2026-10-06T00:00:00.000Z');
});
