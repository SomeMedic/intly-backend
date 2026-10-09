#!/usr/bin/env node
// Reversible fixtures for direct browser verification of the local QA response.
// This never configures a provider or claims a fixture is a provider response.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mongoose from 'mongoose';

const backend = resolve(new URL('..', import.meta.url).pathname);
const root = resolve(backend, '..');
const env = Object.fromEntries((await readFile(resolve(backend, '.env'), 'utf8')).split('\n').flatMap(line => {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, '')]] : [];
}));
assert(env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'production');
const uri = process.env.MONGODB_URI ?? env.MONGODB_URI;
assert(uri?.startsWith('mongodb://'), 'Only local MongoDB is permitted');
const hosts = uri.slice('mongodb://'.length).split('/')[0].split('@').at(-1).split(',');
assert(hosts.every(host => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?$/.test(host)), 'Only loopback MongoDB hosts are permitted');
await mongoose.connect(uri);
try {
  const db = mongoose.connection.db;
  const draft = await db.collection('responses').findOne({ opportunityId: '4a2f887c-345e-4d1b-9f21-58a89a0e90a9', profileId: '3ec405da-0d20-4821-b522-fe6b0c530ae6', format: 'commercial_proposal' });
  assert(draft);
  const user = await db.collection('users').findOne({ _id: draft.userId });
  assert.equal(user?.email, 'intly-qa-1790971959319-a@intly.local');
  const configs = await db.collection('ai_provider_configs').find({ enabled: true }).toArray();
  const providerConfigured = configs.some(config => !!config.apiKeyEncrypted);
  const command = process.argv[2] ?? 'inspect';
  const runId = process.argv[3];
  const runFilter = { userId: draft.userId, profileId: draft.profileId, opportunityId: draft.opportunityId, taskType: 'editor_transform', 'metadata.responseDraftId': draft._id };
  const run = runId ? await db.collection('ai_analyses').findOne({ ...runFilter, _id: runId }) : await db.collection('ai_analyses').find(runFilter).sort({ createdAt: -1 }).limit(1).next();
  if (command === 'inspect') {
    console.log(JSON.stringify({ draftId: draft._id, revision: draft.revision, status: draft.status, providerConfigured, activeFixtureRunCount: await db.collection('ai_analyses').countDocuments({ ...runFilter, 'metadata.browserVerificationFixture': true }), blocks: draft.documentJson.content?.map(node => ({ type: node.type, attrs: node.attrs })), run: run ? { id: run._id, status: run.status, baseRevision: run.metadata.baseRevision, errorCode: run.errorCode, target: run.prompt?.editorTransform?.target, fixture: run.metadata.browserVerificationFixture } : null }));
  } else if (command === 'complete-run') {
    assert(!providerConfigured, 'Do not stage a fixture while real providers are configured');
    assert(run && runId, 'An exact owned run ID is required');
    assert.equal(run.status, 'failed', 'Only a terminal failed QA run can be staged');
    assert.equal(run.metadata.baseRevision, draft.revision, 'Draft must still match the requested version');
    const target = run.prompt?.editorTransform?.target;
    assert.equal(target?.kind, 'block');
    assert(draft.documentJson.content.some(node => (node.attrs?.blockId ?? node.attrs?.id) === target.blockId));
    const file = resolve(root, `.local/response-browser-fixture-${runId}.json`);
    await writeFile(file, JSON.stringify(mongoose.mongo.BSON.EJSON.serialize(run)), { flag: 'wx', mode: 0o600 });
    const structuredOutput = { draftId: draft._id, baseRevision: draft.revision, explanation: 'Локальная проверочная фикстура: две операции; внешний AI не вызывался.', operations: [
      { tool: 'replaceBlock', baseRevision: draft.revision, target, content: { nodeType: 'paragraph', text: 'QA-предложение: подготовим портал на Python и PostgreSQL. Это временная фикстура проверки редактора.' } },
      { tool: 'insertAfter', baseRevision: draft.revision, target, content: { text: 'QA-дополнение: обе операции должны примениться вместе и отмениться одним Undo.' } },
    ] };
    const variant = process.argv[4];
    assert(variant === undefined || variant === 'with-removal', 'Unknown fixture variant');
    if (variant === 'with-removal') {
      structuredOutput.operations.push({ tool: 'removeBlock', baseRevision: draft.revision, target });
      structuredOutput.explanation = 'Локальная проверочная фикстура: замена, вставка и удаление; внешний AI не вызывался. Для осмотра diff без принятия.';
    }
    const result = await db.collection('ai_analyses').updateOne({ ...runFilter, _id: runId, status: 'failed' }, { $set: { status: 'completed', stage: 'completed', updatedAt: new Date(), structuredOutput, 'metadata.browserVerificationFixture': true }, $unset: { errorCode: '', errorSummary: '' } });
    assert.equal(result.modifiedCount, 1);
    console.log(JSON.stringify({ stagedRunId: runId, operations: structuredOutput.operations.length, backup: file, providerWasCalled: false }));
  } else if (command === 'restore-run') {
    assert(runId && run?.metadata.browserVerificationFixture === true);
    const original = mongoose.mongo.BSON.EJSON.deserialize(JSON.parse(await readFile(resolve(root, `.local/response-browser-fixture-${runId}.json`), 'utf8')));
    assert.equal(original._id, runId); assert.equal(original.userId, draft.userId);
    const result = await db.collection('ai_analyses').replaceOne({ ...runFilter, _id: runId, 'metadata.browserVerificationFixture': true }, original);
    assert.equal(result.modifiedCount, 1);
    console.log(JSON.stringify({ restoredRunId: runId, status: original.status }));
  } else if (command === 'bump-revision') {
    const result = await db.collection('responses').updateOne({ _id: draft._id, userId: draft.userId, revision: draft.revision }, { $inc: { revision: 1 } });
    assert.equal(result.modifiedCount, 1);
    console.log(JSON.stringify({ draftId: draft._id, revision: draft.revision + 1, textChanged: false }));
  } else throw new Error('Unknown fixture command');
} finally { await mongoose.disconnect(); }
