import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { AiRepository } = require('../src/modules/ai/ai.repository.ts');
const { AiService } = require('../src/modules/ai/ai.service.ts');
const { AdminAiUsageQueryDto } = require('../src/modules/ai/dto/ai.dto.ts');
const { AiAnalysis, AiAnalysisSchema } = require('../src/modules/ai/schemas/ai-analysis.schema.ts');

async function resolveMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  try {
    const env = require('dotenv').parse(await readFile(new URL('../.env', import.meta.url)));
    if (env.MONGODB_URI) return env.MONGODB_URI;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  throw new Error('MONGODB_URI is required for AI usage analytics integration test');
}

test('AI usage analytics in isolated real Mongo database', async t => {
  const mongoUri = await resolveMongoUri();
  const uri = new URL(mongoUri);
  assert.ok(['localhost', '127.0.0.1'].includes(uri.hostname), 'Only a loopback QA database is allowed');
  const connection = await mongoose.createConnection(mongoUri, { dbName: `intly_ai_usage_qa_${randomUUID().replaceAll('-', '')}`, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const model = connection.model(AiAnalysis.name, AiAnalysisSchema);
    const repository = new AiRepository(model);
    const a = randomUUID(), b = randomUUID(), orphan = randomUUID();
    await connection.db.collection('users').insertMany([
      { _id: a, name: 'User A', email: 'a@fixture.invalid', passwordHash: 'SECRET_CANARY', aiPreferences: { private: 'SECRET_CANARY' } },
      { _id: b, name: 'User B', email: 'b@fixture.invalid', deletedAt: new Date() },
    ]);
    const from = new Date('2026-10-01T00:00:00Z');
    const fixture = (userId, status, extra = {}) => ({ _id: randomUUID(), userId, profileId: 'synthetic', opportunityId: 'synthetic', taskType: 'response_generation', provider: 'openai', modelId: 'fixture-model', status, createdAt: new Date('2026-10-04T00:00:00Z'), completedAt: new Date('2026-10-04T01:00:00Z'), ...extra });
    const rows = [
      fixture(a, 'completed', { usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, estimatedCost: 0 }, startedAt: new Date('2026-10-04T00:59:59Z') }),
      fixture(a, 'failed', { usage: { inputTokens: 4, outputTokens: 6, estimatedCost: 0.01 }, errorCode: 'AI_PROVIDER_RATE_LIMITED', startedAt: new Date('2026-10-04T00:59:57Z') }),
      fixture(a, 'cancelled'),
      fixture(b, 'completed', { provider: 'gemini', taskType: 'opportunity_analysis', usage: { inputTokens: 5, outputTokens: 7 } }),
      fixture(b, 'failed', { provider: 'gemini', taskType: 'opportunity_analysis', usage: { inputTokens: -5, outputTokens: 'oops', totalTokens: -1, estimatedCost: -1 }, startedAt: new Date('2026-10-04T01:00:05Z') }),
      fixture(a, 'completed', { createdAt: new Date('2026-09-01T00:00:00Z'), usage: { inputTokens: 2, outputTokens: 3, estimatedCost: 0.02 }, startedAt: new Date('2026-10-04T01:00:00Z') }),
      fixture(orphan, 'completed', { provider: 'deepseek', taskType: 'editor_transform', usage: { inputTokens: 1, outputTokens: 1, estimatedCost: 0.03 }, startedAt: new Date('2026-10-04T00:59:50Z') }),
      fixture(a, 'queued'), fixture(a, 'running'),
    ];
    await model.collection.insertMany(rows);

    await t.test('counts all terminal runs, errors and cancellation without charging unknown prices', async () => {
      const report = await repository.usageSummary();
      const s = report.summary;
      assert.equal(s.runs, 7); assert.equal(s.completed, 4); assert.equal(s.failed, 2); assert.equal(s.cancelled, 1);
      assert.equal(s.inputTokens, 22); assert.equal(s.outputTokens, 37); assert.equal(s.totalTokens, 59);
      assert.equal(s.costKnownRuns, 4); assert.equal(s.costUnknownRuns, 3); assert.ok(Math.abs(s.estimatedCost - 0.06) < 1e-10);
      assert.equal(s.errorRate, 2 / 6); assert.equal(s.latencySamples, 4); assert.equal(s.avgLatencyMs, 3500);
      assert.equal(report.items.reduce((sum, item) => sum + item.runs, 0), s.runs);
      assert.equal(report.nextCursor, null);
    });
    await t.test('grouped user metadata exposes only identity and preserves orphan history', async () => {
      const report = await repository.usageSummary();
      assert.equal(report.users.length, 3);
      assert.deepEqual(report.users.find(u => u.userId === a), { userId: a, name: 'User A', email: 'a@fixture.invalid' });
      assert.equal(report.items.find(row => row._id.userId === a).user.name, 'User A');
      assert.equal(report.users.find(u => u.userId === orphan).name, undefined);
      assert.ok(!JSON.stringify(report).includes('SECRET_CANARY'));
    });
    await t.test('selected user does not remove other user choices; dates are half-open', async () => {
      const report = await repository.usageSummary({ userId: a, dateFrom: from.toISOString(), dateTo: '2026-10-05T00:00:00Z' });
      assert.equal(report.summary.runs, 3); assert.equal(report.summary.errorRate, 0.5);
      assert.equal(report.users.length, 3); assert.ok(report.items.every(row => row._id.userId === a));
      assert.equal((await repository.usageSummary({ dateTo: '2026-10-04T00:00:00Z' })).summary.runs, 1);
    });
    await t.test('provider/task/model/status filters apply to every metric and error', async () => {
      const report = await repository.usageSummary({ provider: 'gemini', taskType: 'opportunity_analysis', modelId: 'fixture-model', status: 'failed' });
      assert.equal(report.summary.runs, 1); assert.equal(report.summary.errorRate, 1);
      assert.equal(report.summary.estimatedCost, null); assert.equal(report.summary.avgLatencyMs, null);
      assert.equal(report.summary.latencySamples, 0); assert.equal(report.summary.inputTokens, 0);
      assert.equal(report.errors[0].errorCode, 'AI_RUN_FAILED'); assert.equal(report.errors[0].lastRunId, rows[4]._id);
    });
    await t.test('known zero price stays zero and missing measurements stay null', async () => {
      const zero = await repository.usageSummary({ userId: a, status: 'completed', dateFrom: from.toISOString() });
      assert.equal(zero.summary.estimatedCost, 0); assert.equal(zero.items[0].estimatedCost, 0);
      const cancelled = await repository.usageSummary({ status: 'cancelled' });
      assert.equal(cancelled.summary.errorRate, null); assert.equal(cancelled.summary.estimatedCost, null);
      assert.equal(cancelled.summary.avgLatencyMs, null); assert.deepEqual(cancelled.errors, []);
    });
    await t.test('empty report is truthful and predictable', async () => {
      const report = await repository.usageSummary({ modelId: 'no-such-model' });
      assert.equal(report.summary.runs, 0); assert.equal(report.summary.errorRate, null);
      assert.equal(report.summary.estimatedCost, null); assert.equal(report.summary.avgLatencyMs, null);
      assert.deepEqual(report.items, []); assert.deepEqual(report.users, []); assert.deepEqual(report.errors, []);
    });
    await t.test('invalid query fields are rejected and reversed period never reaches repository', async () => {
      for (const query of [{ provider: 'not-a-provider' }, { taskType: 'not-a-task' }, { status: 'queued' }, { dateFrom: '2026-02-30' }, { userId: 'not-an-id' }, { modelId: 'x'.repeat(161) }]) {
        assert.ok((await validate(plainToInstance(AdminAiUsageQueryDto, query))).length > 0);
      }
      assert.equal((await validate(plainToInstance(AdminAiUsageQueryDto, { userId: a, dateFrom: from.toISOString(), provider: 'openai' }))).length, 0);
      assert.throws(() => AiService.prototype.usageAdmin.call({ aiRepository: { usageSummary: () => assert.fail('Invalid dates queried Mongo') } }, { dateFrom: '2026-10-05', dateTo: '2026-10-01' }), /dateFrom/);
    });
    await t.test('actual call facets keep billed primary errors separate from fallback results and legacy history', async () => {
      const callUser = randomUUID();
      const run = fixture(callUser, 'completed', {
        provider: 'gemini', modelId: 'fallback-accounting', usage: { inputTokens: 3, outputTokens: 4, estimatedCost: 0.002 },
        attempts: [
          { number: 1, provider: 'openai', modelId: 'primary-accounting', fallbackUsed: false, status: 'failed', startedAt: '2026-10-04T00:00:00Z', completedAt: '2026-10-04T00:00:00.100Z', usage: { inputTokens: 11, outputTokens: 2, estimatedCost: 0.01 } },
          { number: 2, provider: 'openai', modelId: 'primary-accounting', fallbackUsed: false, status: 'failed', startedAt: '2026-10-04T00:00:01Z', completedAt: '2026-10-04T00:00:01.200Z', usage: { estimatedCost: null } },
          { number: 3, provider: 'gemini', modelId: 'fallback-accounting', fallbackUsed: true, status: 'completed', startedAt: '2026-10-04T00:00:02Z', completedAt: '2026-10-04T00:00:02.300Z', usage: { inputTokens: 3, outputTokens: 4, estimatedCost: 0.002 } },
        ],
      });
      await model.collection.insertOne(run);
      try {
        const all = await repository.usageSummary({ userId: callUser });
        assert.equal(all.summary.runs, 1); assert.equal(all.summary.inputTokens, 3);
        assert.equal(all.callSummary.calls, 3); assert.equal(all.callSummary.inputTokens, 14); assert.equal(all.callSummary.outputTokens, 6);
        assert.equal(all.callSummary.costKnownCalls, 2); assert.equal(all.callSummary.costUnknownCalls, 1);
        assert.ok(Math.abs(all.callSummary.estimatedCost - 0.012) < 1e-10);
        const primary = await repository.usageSummary({ userId: callUser, provider: 'openai', modelId: 'primary-accounting' });
        assert.equal(primary.summary.runs, 0); assert.equal(primary.callSummary.calls, 2);
        assert.equal(primary.callSummary.avgLatencyMs, 150); assert.equal(primary.callItems[0]._id.provider, 'openai');
        assert.equal(primary.callItems[0]._id.status, 'failed');
        assert.equal(primary.callItems[0].lastRunId, run._id);
        assert.equal(primary.callItems[0].lastOccurredAt.toISOString(), '2026-10-04T00:00:01.200Z');
        assert.equal((await repository.usageSummary({ userId: callUser, dateTo: '2026-10-04T00:00:00Z' })).callSummary.calls, 0);
        assert.equal((await repository.usageSummary({ userId: callUser, status: 'failed' })).callSummary.calls, 0);
        assert.equal((await repository.usageSummary({ userId: a })).callSummary.calls, 0, 'Legacy history must not invent provider attempts');
        assert.equal((await repository.usageSummary({ userId: a })).callSummary.estimatedCost, null);
      } finally { await model.deleteOne({ _id: run._id }); }
    });
    await t.test('late usage recording preserves cancellation and never rewrites completed runs', async () => {
      const run = await repository.createRun(fixture(a, 'running'));
      const cancelled = await repository.cancelRun(run._id);
      assert.equal(cancelled.status, 'cancelled');
      const attempts = [{ number: 1, provider: 'openai', modelId: 'late-accounting', fallbackUsed: false, status: 'completed', startedAt: '2026-10-04T00:00:00Z', completedAt: '2026-10-04T00:00:00.100Z', usage: { inputTokens: 10, outputTokens: 20, estimatedCost: 0.001 } }];
      const recorded = await repository.recordAttempts(run._id, attempts);
      assert.equal(recorded.status, 'cancelled'); assert.deepEqual(recorded.completedAt, cancelled.completedAt);
      assert.equal(recorded.attempts[0].usage.estimatedCost, 0.001);
      await repository.updateRun(run._id, { status: 'completed' });
      assert.equal(await repository.recordAttempts(run._id, []), null);
      assert.equal((await repository.getRun(run._id)).attempts.length, 1);
    });
  } finally {
    await connection.dropDatabase();
    await connection.close();
  }
});
