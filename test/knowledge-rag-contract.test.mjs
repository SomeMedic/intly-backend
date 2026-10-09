import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { EmbeddingsService } = require('../src/modules/knowledge/embeddings.service.ts');
const { KnowledgeService } = require('../src/modules/knowledge/knowledge.service.ts');
const { AiService } = require('../src/modules/ai/ai.service.ts');

function config(values) {
  return { get: (key) => values[key] };
}

function knowledgeService({ repository, profilesRepository, embeddings }) {
  return new KnowledgeService(
    repository,
    {},
    { registerHandler: () => undefined, enqueue: async () => undefined },
    { publish: () => undefined },
    profilesRepository ?? { getOwned: async () => ({ _id: 'profile-1' }), getById: async () => ({ _id: 'profile-1' }) },
    {},
    {},
    embeddings,
  );
}

test('TEI embeddings use /embed inputs with E5 query prefix and validate vector payloads', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options.body)) });
    return { ok: true, json: async () => [[0.1, 0.2, 0.3]] };
  };
  try {
    const service = new EmbeddingsService(config({ EMBEDDING_BASE_URL: 'http://embedding:80', EMBEDDING_TIMEOUT_MS: '5000' }));
    const result = await service.embedQuery('INTLY retrieval');
    assert.equal(requests[0].url, 'http://embedding:80/embed');
    assert.equal(requests[0].body.inputs, 'query: INTLY retrieval');
    assert.deepEqual(result.vector, [0.1, 0.2, 0.3]);
    assert.equal(result.metadata.dimension, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy embedding endpoint is preserved as explicit text-to-vector contract', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(String(options.body));
    return { ok: true, json: async () => ({ vector: [1, 0], model: 'legacy', version: 'v1' }) };
  };
  try {
    const service = new EmbeddingsService(config({ EMBEDDING_SERVICE_URL: 'http://legacy-vector' }));
    const result = await service.embedPassage('candidate chunk');
    assert.equal(body.text, 'passage: candidate chunk');
    assert.deepEqual(result.vector, [1, 0]);
    assert.equal(result.metadata.model, 'legacy');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('empty knowledge base returns empty evidence without embedding model call', async () => {
  let embedded = false;
  const service = knowledgeService({
    repository: {
      listAlwaysInclude: async () => [],
      searchChunks: async () => [],
      candidateChunks: async () => [],
    },
    embeddings: {
      embedQuery: async () => { embedded = true; throw new Error('should not embed empty KB'); },
      similarity: () => 0,
    },
  });

  const result = await service.retrieveForActor({ id: 'user-1', email: 'u@example.test', role: 'User' }, 'query', undefined, 5);
  assert.deepEqual(result.evidence, []);
  assert.equal(embedded, false);
});

test('retrieval keeps private evidence scoped to actor and profile ACL', async () => {
  const calls = [];
  const chunk = { _id: 'chunk-1', documentId: 'doc-1', userId: 'user-1', profileIds: ['profile-1'], text: 'Private TypeScript evidence', embedding: [1, 0] };
  const service = knowledgeService({
    repository: {
      listAlwaysInclude: async (userId, profileId) => { calls.push(['always', userId, profileId]); return []; },
      searchChunks: async ({ userId, profileId }) => { calls.push(['keyword', userId, profileId]); return [chunk]; },
      candidateChunks: async ({ userId, profileId }) => { calls.push(['vector', userId, profileId]); return [chunk]; },
      getDocument: async (id) => ({ _id: id, userId: 'user-1', title: 'Private CV', profileIds: ['profile-1'] }),
    },
    profilesRepository: {
      getOwned: async (profileId, userId) => {
        assert.equal(profileId, 'profile-1');
        assert.equal(userId, 'user-1');
        return { _id: profileId };
      },
    },
    embeddings: {
      embedQuery: async (text) => {
        assert.equal(text, 'typescript');
        return { vector: [1, 0], metadata: { model: 'test', version: 'test', dimension: 2, inputHash: 'hash' } };
      },
      similarity: (left, right) => left[0] === right[0] ? 1 : 0,
    },
  });

  const result = await service.retrieveForActor({ id: 'user-1', email: 'u@example.test', role: 'User' }, 'typescript', 'profile-1', 5);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].documentTitle, 'Private CV');
  assert.equal(result.evidence[0].chunkId, 'chunk-1');
  assert.ok(calls.every(([, userId, profileId]) => userId === 'user-1' && profileId === 'profile-1'));
});

test('AI prompt composition includes private RAG evidence and citations', async () => {
  let createdRun;
  const service = new AiService(
    {
      getPrompt: async () => null,
      createRun: async (input) => { createdRun = input; return { _id: 'run-1', ...input }; },
    },
    {},
    {},
    { getById: async () => ({ _id: 'opp-1', title: 'Backend TypeScript', description: 'Need NestJS', type: 'vacancy' }) },
    { getOwned: async () => ({ _id: 'profile-1', userId: 'user-1', name: 'Main profile', structuredExperienceSummary: 'NestJS work', aiPreferences: {} }) },
    { enqueue: async () => undefined },
    {},
    {},
    {
      retrieveContext: async (actor, query, profileId, topK, ownerUserId) => {
        assert.equal(actor.id, 'user-1');
        assert.equal(profileId, 'profile-1');
        assert.equal(ownerUserId, 'user-1');
        assert.equal(topK, 8);
        assert.match(query, /Backend TypeScript/);
        return {
          profile: { id: 'profile-1', name: 'Main profile' },
          alwaysInclude: [{ documentId: 'doc-1', title: 'Pinned facts', text: 'Pinned private fact' }],
          evidence: [{ documentId: 'doc-2', documentTitle: 'CV', chunkId: 'chunk-2', excerpt: 'NestJS evidence', score: 0.9, profileScope: ['profile-1'] }],
        };
      },
    },
  );

  await service.runOpportunityAnalysis({ id: 'user-1', email: 'u@example.test', role: 'User' }, { opportunityId: 'opp-1', profileId: 'profile-1' });
  assert.equal(createdRun.prompt.privateKnowledgeContext.alwaysInclude[0].documentId, 'doc-1');
  assert.equal(createdRun.prompt.privateKnowledgeContext.evidence[0].chunkId, 'chunk-2');
  assert.deepEqual(createdRun.prompt.privateKnowledgeContext.citations[0], { documentId: 'doc-2', documentTitle: 'CV', chunkId: 'chunk-2' });
});
