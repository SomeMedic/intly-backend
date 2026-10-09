import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { OpportunitiesService } = require('../src/modules/opportunities/opportunities.service.ts');

test('changed canonical source facts enqueue fresh matching and search while an exact retry keeps its identity', async () => {
  const service = Object.create(OpportunitiesService.prototype);
  let stored;
  const isEmptyObject = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  service.opportunitiesRepository = {
    async findByOccurrence() { return stored; },
    async create(input) {
      const { money, ...rest } = input;
      stored = { _id: 'opportunity-1', ...rest, ...(isEmptyObject(money) ? {} : { money }) };
      return stored;
    },
    async upsertOccurrence(_id, occurrence, patch) {
      stored = { ...stored, ...patch, sourceOccurrences: [occurrence] };
      return stored;
    },
  };
  const calls = [];
  const retainedCompletedJobs = new Set();
  service.jobsService = {
    async enqueue(queue, name, data, options) {
      calls.push({ queue, name, data, jobId: options.jobId });
      retainedCompletedJobs.add(options.jobId);
    },
  };
  const input = {
    type: 'vacancy', title: 'Source role', description: 'Full body', companyOrClient: 'Acme',
    sourceId: 'workingnomads', externalId: '123', url: 'https://www.workingnomads.com/jobs/source-role-123',
    skills: ['Python'], technologies: ['Python'], location: 'USA', money: {},
    rawPayload: { id: 123 }, sourceMetadata: {}, sourceStatus: 'Active',
  };

  await service.ingestOrUpsert(input);
  const firstIds = calls.slice(-2).map(call => call.jobId);
  assert.equal(stored.money, undefined);
  await service.ingestOrUpsert({ ...input, rawPayload: { id: 123, fetchedAt: 'later' }, sourceMetadata: { refreshedAt: 'later' } });
  assert.deepEqual(stored.money, {});
  assert.deepEqual(calls.slice(-2).map(call => call.jobId), firstIds);
  assert.equal(retainedCompletedJobs.size, 2);

  await service.ingestOrUpsert({ ...input, remoteType: 'remote' });
  const changedIds = calls.slice(-2).map(call => call.jobId);
  assert.ok(changedIds.every(id => !firstIds.includes(id)));
  assert.equal(retainedCompletedJobs.size, 4);
  assert.equal(stored.remoteType, 'remote');
  assert.deepEqual(calls.slice(-2).map(call => call.queue), ['analytics', 'search']);

  await service.ingestOrUpsert({ ...input, remoteType: 'remote' });
  assert.deepEqual(calls.slice(-2).map(call => call.jobId), changedIds);
  assert.equal(retainedCompletedJobs.size, 4);

  await service.ingestOrUpsert({ ...input, remoteType: 'remote', money: { min: 1000, currency: 'USD' } });
  const changedMoneyIds = calls.slice(-2).map(call => call.jobId);
  assert.ok(changedMoneyIds.every(id => !changedIds.includes(id)));
  assert.equal(retainedCompletedJobs.size, 6);
  assert.deepEqual(stored.money, { min: 1000, currency: 'USD' });

  await service.ingestOrUpsert({ ...input, remoteType: 'remote', money: { min: 1000, currency: 'USD' }, sourceMetadata: { refreshedAt: 'again' } });
  assert.deepEqual(calls.slice(-2).map(call => call.jobId), changedMoneyIds);
  assert.equal(retainedCompletedJobs.size, 6);
});
