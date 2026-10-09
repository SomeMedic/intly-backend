#!/usr/bin/env node
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import mongoose from 'mongoose';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const env = parse(await readFile(new URL('../.env', import.meta.url)));
assert.notEqual(env.NODE_ENV, 'production', 'Source acceptance refuses production');
for (const value of [env.MONGODB_URI, env.REDIS_URL]) {
  assert.ok(value && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname), 'Source acceptance requires local infrastructure');
}
const sourceId = process.argv[2];
const acceptedSources = {
  geekjob: 'https://geekjob.ru/vacancies',
  habr: 'https://career.habr.com/vacancies',
  yc_jobs: 'https://www.ycombinator.com/jobs',
  rabota_ru: 'https://www.rabota.ru/vacancy/?sort=date',
};
assert.ok(Object.hasOwn(acceptedSources, sourceId), 'Source acceptance is scoped to public GeekJob, Habr, YC Jobs and configured Rabota.ru listings');
const finiteFeed = sourceId === 'habr';
const defaultReports = {
  geekjob: 'source-queue-backfill-20261004.json',
  habr: 'source-habr-queue-feed-20261004.json',
  yc_jobs: 'source-yc-queue-public-20261004.json',
  rabota_ru: 'source-rabota-queue-configured-20261004.json',
};
const reportName = process.argv.find((value) => value.startsWith('--report='))?.slice('--report='.length) ?? defaultReports[sourceId];
assert.match(reportName, /^[a-zA-Z0-9_-]+\.json$/, 'Report must be a JSON filename');
const existingRunId = process.argv.find((value) => value.startsWith('--verify-run='))?.slice('--verify-run='.length);
if (existingRunId) assert.match(existingRunId, /^[0-9a-f-]{36}$/i, 'Existing run must have a concrete UUID');
const retryRunId = process.argv.find((value) => value.startsWith('--retry-run='))?.slice('--retry-run='.length);
if (retryRunId) assert.match(retryRunId, /^[0-9a-f-]{36}$/i, 'Retry must have a concrete UUID');
assert.ok(!(existingRunId && retryRunId), 'Observation and retry modes cannot be combined');
const priorReportName = process.argv.find((value) => value.startsWith('--prior-report='))?.slice('--prior-report='.length) ?? defaultReports[sourceId];
assert.match(priorReportName, /^[a-zA-Z0-9_-]+\.json$/, 'Prior report must be a JSON filename');
if (retryRunId) assert.notEqual(reportName, priorReportName, 'Recovery preserves the original failed report');
const base = `http://127.0.0.1:${env.PORT ?? 3001}/api/v1`;
const origin = env.FRONTEND_URL ?? 'http://localhost:3000';
const reportPath = resolve(new URL(`../../.local/reports/${reportName}`, import.meta.url).pathname);
const report = { startedAt: new Date().toISOString(), sourceId, passed: false, scope: finiteFeed ? 'One finite public Habr RSS feed with full detail enrichment, real HTTP run request, BullMQ, normalized shared records and API; not all Habr vacancies from the requested 30 days' : 'One public source, real HTTP run request, BullMQ continuation, normalized shared records; not acceptance of other platforms', platformWindowCompletenessProven: false, checks: [], observations: [] };
if (sourceId === 'yc_jobs') report.scope = 'Confirmed YC public SEO listing catalog, full available continuation, real HTTP run request, BullMQ, normalized shared records and API; account-gated Work at a Startup listings and whole-platform completeness are not proven';
if (sourceId === 'rabota_ru') report.scope = 'Configured Rabota.ru public regional listing URLs with a fixed 30-day window, real HTTP run request, BullMQ continuation, normalized shared records and API; all-region discovery and whole-platform completeness are not proven';
let token;
let original;
let runId;
let terminal = false;
let limitsChanged = false;
let recoveryBaseline;
let recoveryObserved = false;

async function save() {
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}

async function request(method, path, body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${path} returned ${response.status}`);
  return data;
}

function check(name, condition, details) {
  report.checks.push({ name, passed: Boolean(condition), ...(details === undefined ? {} : { details }) });
  assert.ok(condition, name);
}

try {
  const health = await request('GET', '/health/ready');
  check('Local native backend is ready', health.status === 'ok');
  const login = await request('POST', '/auth/login', { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD }, 201);
  assert.equal(login.user.role, 'Admin');
  token = login.accessToken;
  original = await request('GET', `/admin/sources/${sourceId}`);
  check('Persisted source uses current public listing endpoint', original.endpoint?.baseUrl === acceptedSources[sourceId]);
  check('Source is already enabled', original.enabled === true && original.runtimeState === 'Enabled');
  const beforeRuns = await request('GET', `/admin/sources/runs?sourceId=${sourceId}&limit=200`);
  check('No competing source run is active', !beforeRuns.items.some((run) => ['Queued', 'Running'].includes(run.status)));

  if (retryRunId) {
    const priorPath = resolve(new URL(`../../.local/reports/${priorReportName}`, import.meta.url).pathname);
    const prior = JSON.parse(await readFile(priorPath, 'utf8'));
    const existing = beforeRuns.items.find((item) => (item.id ?? item._id) === retryRunId);
    check('Recovery belongs to the same recorded failed acceptance attempt', prior.sourceId === sourceId && prior.runId === retryRunId && prior.passed === false && existing?.sourceId === sourceId && existing.status === 'Failed' && existing.requestedByUserId === login.user.id && Date.parse(existing.createdAt) >= Date.parse(prior.startedAt) && Date.parse(existing.createdAt) <= Date.parse(prior.completedAt));
    check('Original HTTP queued-run evidence is retained', prior.checks.some((item) => item.name === 'HTTP request creates a queued source run' && item.passed));
    check('Source checkpoint still belongs to the recorded failed run', JSON.stringify(original.checkpoint) === JSON.stringify(existing.checkpointAfter));
    check('Original run has a fixed collection window', Number.isFinite(Date.parse(existing.requestMetadata?.backfillSince)) && Number.isFinite(Date.parse(existing.checkpointAfter?.windowTo)));
    const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue('ingestion', { connection: redis });
    let failedJob;
    try {
      const jobs = (await queue.getJobs(['failed', 'active', 'waiting', 'delayed'], 0, 1999, false)).filter((job) => job.data.runId === retryRunId);
      const states = await Promise.all(jobs.map(async (job) => ({ job, state: await job.getState() })));
      check('Owned failed run has no pending automatic queue retry', states.every((item) => item.state === 'failed'));
      failedJob = states.filter((item) => item.state === 'failed').sort((a, b) => (b.job.finishedOn ?? 0) - (a.job.finishedOn ?? 0))[0]?.job;
      check('Concrete failed ingestion job belongs to the recorded source run', failedJob?.data.sourceId === sourceId && failedJob?.data.runId === retryRunId && typeof failedJob?.id === 'string');
    } finally {
      await queue.close();
      await redis.quit();
    }
    const job = await request('GET', `/admin/jobs/ingestion/${encodeURIComponent(failedJob.id)}`);
    check('Admin API confirms the same failed job before retry', job.state === 'failed' && job.data.runId === retryRunId && job.data.sourceId === sourceId);
    recoveryBaseline = existing;
    report.recovery = { priorReport: priorPath, runId: retryRunId, jobId: failedJob.id, previousStats: existing.stats, originalWindowFrom: existing.requestMetadata.backfillSince, originalWindowTo: existing.checkpointAfter.windowTo };
    await request('PATCH', `/admin/sources/${sourceId}`, { maxPages: 1 });
    limitsChanged = true;
    runId = retryRunId;
    const retry = await request('POST', `/admin/jobs/ingestion/${encodeURIComponent(failedJob.id)}/retry`, {}, 201);
    check('Admin HTTP retry queues the original owned run', retry.success === true);
  } else if (existingRunId) {
    const previousReport = JSON.parse(await readFile(reportPath, 'utf8'));
    await copyFile(reportPath, reportPath.replace(/\.json$/, '-initial-verifier.json'));
    const existing = beforeRuns.items.find((item) => (item.id ?? item._id) === existingRunId);
    check('Existing run belongs to the same recorded acceptance attempt', existing?.sourceId === sourceId && existing.requestedByUserId === login.user.id && Date.parse(existing.createdAt) >= Date.parse(previousReport.startedAt) && Date.parse(existing.createdAt) <= Date.parse(previousReport.completedAt));
    check('Original HTTP queued-run evidence is retained', previousReport.checks.some((item) => item.name === 'HTTP request creates a queued source run' && item.passed));
    report.initialVerifier = { report: reportPath.replace(/\.json$/, '-initial-verifier.json'), error: previousReport.error };
    report.startedAt = previousReport.startedAt;
    report.observations = previousReport.observations;
    report.limitsRestored = previousReport.limitsRestored;
    runId = existingRunId;
  } else {
    check('No incomplete prior checkpoint is reused', original.checkpoint?.hasMore !== true);
    await request('PATCH', `/admin/sources/${sourceId}`, { maxPages: 1 });
    limitsChanged = true;
    const initial = await request('POST', `/admin/sources/${sourceId}/run`, { runType: 'backfill', backfillDays: 30 }, 201);
    runId = initial.id ?? initial._id;
    check('HTTP request creates a queued source run', initial.status === 'Queued' && initial.sourceId === sourceId && typeof runId === 'string');
  }
  report.runId = runId;
  const deadline = Date.now() + 15 * 60_000;
  let previous;
  let run;
  while (Date.now() < deadline) {
    const runs = await request('GET', `/admin/sources/runs?sourceId=${sourceId}&limit=200`);
    run = runs.items.find((item) => (item.id ?? item._id) === runId);
    assert.ok(run, 'Owned run remains visible through admin API');
    if (recoveryBaseline && (run.status !== recoveryBaseline.status || run.updatedAt !== recoveryBaseline.updatedAt)) recoveryObserved = true;
    const signature = JSON.stringify({ status: run.status, stats: run.stats });
    if (signature !== previous) {
      const observation = { at: new Date().toISOString(), status: run.status, stats: run.stats, checkpointHasMore: run.checkpointAfter?.hasMore, windowFrom: run.requestMetadata?.backfillSince };
      report.observations.push(observation);
      await save();
      process.stdout.write(`${sourceId} ${run.status}: ${run.stats?.upserted ?? 0} upserted\n`);
      previous = signature;
    }
    if (['Succeeded', 'Failed', 'Cancelled'].includes(run.status) && (!recoveryBaseline || recoveryObserved)) { terminal = true; break; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  }
  check(finiteFeed ? 'Finite public feed run finishes within acceptance timeout' : 'Full public listing run finishes within acceptance timeout', terminal);
  report.result = { status: run.status, stats: run.stats, checkpoint: run.checkpointAfter, requestMetadata: run.requestMetadata, error: run.error };
  check(recoveryBaseline ? 'Recovered run succeeds without additional ingestion errors' : 'Run succeeds with no ingestion errors', run.status === 'Succeeded' && (run.stats?.failed ?? 0) === (recoveryBaseline?.stats?.failed ?? 0), run.error);
  if (recoveryBaseline) check('Recovered run retains its original fixed collection window', run.requestMetadata?.backfillSince === recoveryBaseline.requestMetadata.backfillSince && run.checkpointAfter?.windowTo === recoveryBaseline.checkpointAfter.windowTo);
  check(finiteFeed ? 'Run records the finite current-feed scope' : 'Finite pagination is fully exhausted', finiteFeed ? run.checkpointAfter?.feedWindow === 'finite_current_feed' && run.checkpointAfter?.hasMore !== true : run.checkpointAfter?.hasMore === false);
  check('Run keeps the requested 30-day window', run.requestMetadata?.backfillDays === 30 && Number.isFinite(Date.parse(run.requestMetadata?.backfillSince)));
  check('Real records pass normalization and shared ingestion', run.stats?.normalized > 0 && run.stats?.upserted > 0);

  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue('ingestion', { connection: redis });
  try {
    const jobs = (await queue.getJobs(['completed', 'active', 'waiting', 'delayed', 'failed'], 0, 1999, false)).filter((job) => job.data.runId === runId);
    report.queueJobs = await Promise.all(jobs.map(async (job) => ({ id: job.id, state: await job.getState(), attemptsMade: job.attemptsMade, name: job.name })));
    check(finiteFeed ? 'Actual BullMQ job executes the finite feed run' : 'More than one actual BullMQ job continues the same run', finiteFeed ? jobs.length >= 1 : jobs.length > 1, jobs.length);
    check('All observed continuation jobs completed', report.queueJobs.every((job) => job.state === 'completed'));
  } finally {
    await queue.close();
    await redis.quit();
  }

  const page = await request('GET', `/opportunities?sourceIds=${sourceId}&limit=100`);
  check('Imported records are exposed in the application API', Array.isArray(page.items) && page.items.length > 0);
  if (finiteFeed) check('Published structured skills survive normalization and shared ingestion', page.items.some((item) => item.skills?.length > 0));
  report.sample = page.items.slice(0, 3).map((item) => ({ id: item.id ?? item._id, title: item.title, publishedAt: item.publishedAt, descriptionLength: item.description?.length, skills: item.skills, seniority: item.seniority, money: item.money, remoteType: item.remoteType, employmentType: item.employmentType }));
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (runId && !terminal && !existingRunId) {
    try {
      const runs = await request('GET', `/admin/sources/runs?sourceId=${sourceId}&limit=200`);
      const current = runs.items.find((item) => (item.id ?? item._id) === runId);
      if (current && ['Queued', 'Running'].includes(current.status)) {
        await request('POST', `/admin/sources/runs/${runId}/stop`, {}, 201);
        report.ownedRunStopped = true;
      }
    }
    catch (error) { report.stopError = error instanceof Error ? error.message : String(error); }
  }
  if (limitsChanged) {
    try {
      await mongoose.connect(env.MONGODB_URI);
      const priorMaxPages = original.limits?.maxPages;
      const update = priorMaxPages === undefined ? { $unset: { 'limits.maxPages': '' } } : { $set: { 'limits.maxPages': priorMaxPages } };
      const restored = await mongoose.connection.collection('sources').updateOne({ _id: sourceId, 'limits.maxPages': 1 }, update);
      report.limitsRestored = restored.matchedCount === 1;
      assert.ok(report.limitsRestored, 'Source limits changed concurrently; no unrelated settings overwritten');
    } catch (error) {
      report.restoreError = error instanceof Error ? error.message : String(error);
      report.passed = false;
      process.exitCode = 1;
    } finally { await mongoose.disconnect(); }
  }
  report.completedAt = new Date().toISOString();
  await save();
  process.stdout.write(JSON.stringify({ passed: report.passed, runId, checks: report.checks.length, report: reportPath, error: report.error, restoreError: report.restoreError }) + '\n');
}
