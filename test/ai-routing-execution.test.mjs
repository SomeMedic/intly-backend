import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { AiService } = require('../src/modules/ai/ai.service.ts');

const actor = { id: 'user-1', email: 'user@example.test', role: 'User' };
const validOutput = {
  aiScore: 87,
  recommendation: 'Proceed',
  summary: 'The opportunity matches the profile.',
};

test('processRun treats retryCount as retries after the first primary call and uses one fallback after backoff', async () => {
  const calls = [];
  const { service, state } = processHarness({
    route: route({ retryCount: 1, fallbackProvider: 'gemini', fallbackModel: 'gemini-1' }),
    generateObject: async (input) => {
      calls.push({ provider: input.provider.provider, modelId: input.modelId });
      if (calls.length < 3) {
        const error = new Error(`retryable ${calls.length}`);
        error.code = 'AI_PROVIDER_RETRYABLE';
        error.retryable = true;
        throw error;
      }
      return { object: validOutput, usage: { inputTokens: 5, outputTokens: 7 } };
    },
  });
  service.routeAttemptDelayMs = () => 1;

  await service.processRun('run-1');

  assert.deepEqual(calls, [
    { provider: 'openai', modelId: 'primary-1' },
    { provider: 'openai', modelId: 'primary-1' },
    { provider: 'gemini', modelId: 'gemini-1' },
  ]);
  assert.equal(state.run.status, 'completed');
  assert.equal(state.run.provider, 'gemini');
  assert.equal(state.run.modelId, 'gemini-1');
  assert.equal(state.run.fallbackUsed, true);
  assert.equal(state.run.metadata.aiRouting.attemptCount, 3);
  assert.equal(typeof state.run.metadata.aiRouting.durationMs, 'number');
});

test('processRun skips repeated unavailable credentials and does not waste primary retries before fallback', async () => {
  const providerLookups = [];
  const calls = [];
  const { service, state } = processHarness({
    route: route({ retryCount: 3, fallbackProvider: 'gemini', fallbackModel: 'gemini-1' }),
    providers: {
      openai: { provider: 'openai', enabled: false },
      gemini: { provider: 'gemini', enabled: true, apiKeyEncrypted: 'secret' },
    },
    onProviderLookup: (provider) => providerLookups.push(provider),
    generateObject: async (input) => {
      calls.push(input.provider.provider);
      return { object: validOutput };
    },
  });
  service.routeAttemptDelayMs = () => 1;

  await service.processRun('run-1');

  assert.deepEqual(providerLookups, ['openai', 'gemini']);
  assert.deepEqual(calls, ['gemini']);
  assert.equal(state.run.status, 'completed');
  assert.equal(state.run.fallbackUsed, true);
});

test('processRun cancels during retry backoff without starting the next provider call', async () => {
  const calls = [];
  const { service, state, notifications } = processHarness({
    route: route({ retryCount: 1, fallbackProvider: 'gemini', fallbackModel: 'gemini-1' }),
    generateObject: async (input) => {
      calls.push(input.provider.provider);
      setTimeout(() => {
        void service.cancel(actor, 'run-1');
      }, 0);
      const error = new Error('temporary upstream failure');
      error.retryable = true;
      throw error;
    },
  });
  service.routeAttemptDelayMs = () => 50;

  await service.processRun('run-1');

  assert.deepEqual(calls, ['openai']);
  assert.equal(state.run.status, 'cancelled');
  assert.equal(notifications.at(-1).status, 'cancelled');
});

test('processRun records final provider metadata before terminal provider failure', async () => {
  const { service, state } = processHarness({
    route: route({ retryCount: 0 }),
    generateObject: async () => {
      const error = new Error('safe provider message');
      error.code = 'AI_PROVIDER_BAD_REQUEST';
      error.retryable = false;
      throw error;
    },
  });

  await service.processRun('run-1');

  assert.equal(state.run.status, 'failed');
  assert.equal(state.run.errorCode, 'AI_PROVIDER_BAD_REQUEST');
  assert.equal(state.run.provider, 'openai');
  assert.equal(state.run.modelId, 'primary-1');
  assert.equal(state.run.fallbackUsed, false);
  assert.equal(state.run.metadata.aiRouting.provider, 'openai');
});

test('processRun records billed invalid primary output before using fallback', async () => {
  const calls = [];
  const { service, state } = processHarness({
    run: {
      taskType: 'response_generation',
      metadata: { responseDraftId: 'draft-1', baseRevision: 1 },
    },
    route: route({ retryCount: 0, fallbackProvider: 'gemini', fallbackModel: 'gemini-1' }),
    providers: pricedProviders(),
    generateObject: async (input) => {
      calls.push(input.provider.provider);
      if (input.provider.provider === 'openai') {
        return {
          object: { documentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph', content: [] }] }] } },
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      }
      return {
        object: { documentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fallback.' }] }] } },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  });
  service.routeAttemptDelayMs = () => 1;

  await service.processRun('run-1');

  assert.deepEqual(calls, ['openai', 'gemini']);
  assert.equal(state.run.status, 'completed');
  assert.equal(state.run.attempts[0].status, 'failed');
  assert.equal(state.run.attempts[0].errorCode, 'AI_OUTPUT_INVALID');
  assert.equal(state.run.attempts[0].usage.estimatedCost, 0.00014);
  assert.equal(state.run.attempts[1].status, 'completed');
});

test('processRun preserves usage from retryable provider errors', async () => {
  const { service, state } = processHarness({
    route: route({ retryCount: 1 }),
    providers: pricedProviders(),
    generateObject: async () => {
      if (!state.run.attempts.some((attempt) => attempt.status === 'failed')) {
        const error = new Error('rate limited');
        error.code = 'AI_RATE_LIMITED';
        error.retryable = true;
        error.usage = { inputTokens: 12, outputTokens: 3 };
        throw error;
      }
      return { object: validOutput, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  service.routeAttemptDelayMs = () => 1;

  await service.processRun('run-1');

  assert.equal(state.run.status, 'completed');
  assert.equal(state.run.attempts[0].errorCode, 'AI_RATE_LIMITED');
  assert.equal(state.run.attempts[0].usage.estimatedCost, 0.000018);
});

test('processRun accounts late provider usage without reviving a cancelled run', async () => {
  let serviceRef;
  const { service, state } = processHarness({
    providers: pricedProviders(),
    generateObject: async () => {
      await serviceRef.cancel(actor, 'run-1');
      return { object: validOutput, usage: { inputTokens: 9, outputTokens: 4 } };
    },
  });
  serviceRef = service;

  await service.processRun('run-1');

  assert.equal(state.run.status, 'cancelled');
  assert.equal(state.run.attempts[0].status, 'cancelled');
  assert.equal(state.run.attempts[0].usage.estimatedCost, 0.000017);
});

test('processRun does not record an attempt for disabled provider credentials', async () => {
  const { service, state } = processHarness({
    route: route({ retryCount: 1, fallbackProvider: 'gemini', fallbackModel: 'gemini-1' }),
    providers: {
      openai: { provider: 'openai', enabled: false, pricing: [{ modelId: 'primary-1', inputPerMillion: 1, outputPerMillion: 1 }] },
      gemini: { provider: 'gemini', enabled: true, apiKeyEncrypted: 'secret' },
    },
    generateObject: async () => ({ object: validOutput }),
  });
  service.routeAttemptDelayMs = () => 1;

  await service.processRun('run-1');

  assert.deepEqual(state.run.attempts.map((attempt) => attempt.provider), ['gemini']);
});

test('patchRouteAdmin merges saved routes, trims model ids, and clears fallback as an explicit pair', async () => {
  const savedPatches = [];
  const service = adminService({
    aiRepository: {
      getTaskConfig: async () => route({ retryCount: 2, fallbackProvider: 'gemini', fallbackModel: ' gemini-old ' }),
      upsertTaskConfig: async (patch) => {
        savedPatches.push(patch);
        return patch;
      },
    },
  });

  await service.patchRouteAdmin({ ...actor, role: 'Admin' }, {
    taskType: 'opportunity_analysis',
    primaryProvider: 'openai',
    primaryModel: ' primary-new ',
    fallbackProvider: null,
    fallbackModel: null,
    retryCount: 0,
  });

  assert.equal(savedPatches[0].primaryModel, 'primary-new');
  assert.equal(savedPatches[0].fallbackProvider, null);
  assert.equal(savedPatches[0].fallbackModel, null);
  assert.equal(savedPatches[0].retryCount, 0);

  await assert.rejects(
    () => service.patchRouteAdmin({ ...actor, role: 'Admin' }, {
      taskType: 'opportunity_analysis',
      primaryProvider: 'openai',
      primaryModel: 'primary-new',
      fallbackProvider: null,
    }),
    /fallback requires both/,
  );
});

test('patchProviderAdmin resets stale health when provider config changes and preserves it for no-op patches', async () => {
  const savedPatches = [];
  const existing = { provider: 'openai', enabled: true, baseUrl: 'https://old.example', health: { status: 'healthy' } };
  const service = adminService({
    aiRepository: {
      getProvider: async () => existing,
      upsertProvider: async (patch) => {
        savedPatches.push(patch);
        return patch;
      },
    },
    cryptoService: { encrypt: (value) => `encrypted:${value}` },
  });

  await service.patchProviderAdmin({ ...actor, role: 'Admin' }, { provider: 'openai', baseUrl: 'https://new.example' });
  await service.patchProviderAdmin({ ...actor, role: 'Admin' }, { provider: 'openai', baseUrl: 'https://old.example' });
  await service.patchProviderAdmin({ ...actor, role: 'Admin' }, { provider: 'openai', apiKey: 'fresh-secret' });

  assert.deepEqual(savedPatches[0].health, {});
  assert.equal('health' in savedPatches[1], false);
  assert.deepEqual(savedPatches[2].health, {});
});

test('patchProviderAdmin preserves provider health when only pricing changes', async () => {
  const savedPatches = [];
  const existing = { provider: 'openai', enabled: true, apiKeyEncrypted: 'saved', baseUrl: 'https://old.example', health: { status: 'healthy' } };
  const service = adminService({
    aiRepository: {
      getProvider: async () => existing,
      upsertProvider: async (patch) => {
        savedPatches.push(patch);
        return { ...existing, ...patch };
      },
    },
  });

  await service.patchProviderAdmin({ ...actor, role: 'Admin' }, {
    provider: 'openai',
    pricing: [{ modelId: ' primary-1 ', inputPerMillion: 2, outputPerMillion: 8 }],
  });

  assert.equal('health' in savedPatches[0], false);
  assert.deepEqual(savedPatches[0].pricing, [{ modelId: 'primary-1', inputPerMillion: 2, outputPerMillion: 8 }]);
});

test('patchProviderAdmin rejects duplicate model prices after trimming model ids', async () => {
  const service = adminService({
    aiRepository: {
      getProvider: async () => ({ provider: 'openai', enabled: true }),
      upsertProvider: async () => assert.fail('duplicate pricing must not be saved'),
    },
  });

  await assert.rejects(
    () => service.patchProviderAdmin({ ...actor, role: 'Admin' }, {
      provider: 'openai',
      pricing: [
        { modelId: 'model-a', inputPerMillion: 1, outputPerMillion: 1 },
        { modelId: ' model-a ', inputPerMillion: 1, outputPerMillion: 1 },
      ],
    }),
    /unique non-empty model ids/,
  );
});

test('patchProviderAdmin rejects malformed cached input rates without saving partial pricing', async () => {
  const service = adminService({
    aiRepository: {
      getProvider: async () => ({ provider: 'openai', enabled: true }),
      upsertProvider: async () => assert.fail('malformed pricing must not be saved'),
    },
  });

  await assert.rejects(
    () => service.patchProviderAdmin({ ...actor, role: 'Admin' }, {
      provider: 'openai',
      pricing: [{ modelId: 'model-a', inputPerMillion: 1, outputPerMillion: 1, cachedInputPerMillion: Number.POSITIVE_INFINITY }],
    }),
    /finite non-negative USD rates/,
  );
});

function processHarness({
  route: taskRoute = route({}),
  providers = {
    openai: { provider: 'openai', enabled: true, apiKeyEncrypted: 'secret' },
    gemini: { provider: 'gemini', enabled: true, apiKeyEncrypted: 'secret' },
  },
  run: runPatch = {},
  generateObject,
  onProviderLookup = () => undefined,
} = {}) {
  const state = {
    run: {
      _id: 'run-1',
      userId: actor.id,
      profileId: 'profile-1',
      opportunityId: 'opp-1',
      taskType: 'opportunity_analysis',
      status: 'queued',
      prompt: { ready: true },
      metadata: { source: 'test' },
      usage: {},
      attempts: [],
      ...runPatch,
    },
  };
  const notifications = [];
  const aiRepository = {
    markRunning: async () => {
      if (state.run.status !== 'queued') return null;
      state.run = { ...state.run, status: 'running', startedAt: new Date() };
      return state.run;
    },
    getTaskConfig: async () => taskRoute,
    getProvider: async (provider) => {
      onProviderLookup(provider);
      return providers[provider] ?? null;
    },
    updateRunningRun: async (_id, input) => {
      if (state.run.status !== 'running') return null;
      state.run = { ...state.run, ...input };
      return state.run;
    },
    recordAttempts: async (_id, attempts) => {
      if (!['running', 'cancelled'].includes(state.run.status)) return null;
      state.run = { ...state.run, attempts: structuredClone(attempts) };
      return state.run;
    },
    updateRunStage: async (_id, stage) => {
      if (state.run.status !== 'running') return null;
      state.run = { ...state.run, stage };
      return state.run;
    },
    updateRunTerminal: async (_id, input) => {
      if (state.run.status !== 'running') return null;
      state.run = { ...state.run, ...input };
      return state.run;
    },
    getRun: async () => state.run,
    cancelRun: async () => {
      if (!['queued', 'running'].includes(state.run.status)) return null;
      state.run = { ...state.run, status: 'cancelled', completedAt: new Date() };
      return state.run;
    },
    getPrompt: async () => null,
  };
  const service = serviceWith({
    aiRepository,
    providerRunner: { generateObject },
    runCompletionRegistry: { notify: async (run) => { notifications.push(run); } },
  });
  return { service, state, notifications };
}

function pricedProviders() {
  return {
    openai: { provider: 'openai', enabled: true, apiKeyEncrypted: 'secret', pricing: [{ modelId: 'primary-1', inputPerMillion: 1, outputPerMillion: 2 }] },
    gemini: { provider: 'gemini', enabled: true, apiKeyEncrypted: 'secret', pricing: [{ modelId: 'gemini-1', inputPerMillion: 3, outputPerMillion: 5 }] },
  };
}

function adminService(overrides = {}) {
  return serviceWith({
    providerRunner: {},
    runCompletionRegistry: { notify: async () => undefined },
    auditService: { record: async () => undefined },
    jobsService: { registerHandler: () => undefined, enqueue: async () => undefined },
    cryptoService: { encrypt: (value) => `encrypted:${value}` },
    ...overrides,
  });
}

function serviceWith(overrides = {}) {
  return new AiService(
    overrides.aiRepository ?? {},
    overrides.providerRunner ?? {},
    overrides.runCompletionRegistry ?? { notify: async () => undefined },
    overrides.opportunitiesRepository ?? {},
    overrides.profilesRepository ?? {},
    overrides.jobsService ?? { registerHandler: () => undefined, enqueue: async () => undefined },
    overrides.cryptoService ?? {},
    overrides.auditService ?? {},
    overrides.documentsService,
    overrides.usersService,
  );
}

function route(patch) {
  return {
    _id: 'route-1',
    taskType: 'opportunity_analysis',
    primaryProvider: 'openai',
    primaryModel: 'primary-1',
    retryCount: 0,
    ...patch,
  };
}
