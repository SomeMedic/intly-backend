import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('reflect-metadata');
const { SourcesRepository } = require('../src/modules/sources/sources.repository.ts');

function setup(run) {
  const calls = [];
  const repository = new SourcesRepository({}, {
    findById: id => ({ lean: async () => id === run._id ? structuredClone(run) : null }),
  }, {
    updateMany: async (filter, update) => { calls.push({ filter, update }); return { modifiedCount: 1 }; },
  });
  return { repository, calls };
}

test('only open errors of the exact completed run are recovered, without deleting error details', async () => {
  const { repository, calls } = setup({ _id: 'run-1', sourceId: 'greenhouse', status: 'Succeeded', stats: { failed: 1 }, requestMetadata: {}, checkpointAfter: { hasMore: false } });
  assert.equal(await repository.recoverRunDlq('run-1'), 1);
  assert.deepEqual(calls[0].filter, { runId: 'run-1', sourceId: 'greenhouse', status: 'Open' });
  assert.equal(calls[0].update.$set.status, 'Recovered');
  assert.ok(calls[0].update.$set.recoveredAt instanceof Date);
  assert.deepEqual(Object.keys(calls[0].update.$set).sort(), ['recoveredAt', 'status']);
});

test('failed, active, stopped, pending and incomplete runs retain open errors', async () => {
  for (const patch of [
    { status: 'Failed' }, { status: 'Queued' }, { status: 'Running' }, { status: 'Cancelled' },
    { requestedStopAt: new Date() }, { requestMetadata: { pendingIngest: { records: [] } } },
    { requestMetadata: { pendingRefreshIngest: { records: [] } } }, { checkpointAfter: { hasMore: true } },
    { checkpointAfter: { incomplete: true, hasMore: false } },
  ]) {
    const { repository, calls } = setup({ _id: 'run-1', sourceId: 'greenhouse', status: 'Succeeded', requestMetadata: {}, checkpointAfter: {}, ...patch });
    assert.equal(await repository.recoverRunDlq('run-1'), 0);
    assert.equal(calls.length, 0);
  }
});

test('checkpoint progress write does not mark source healthy or clear diagnostics', async () => {
  const calls = [];
  const repository = new SourcesRepository({ updateOne: async (filter, update) => calls.push({ filter, update }) }, {}, {});
  await repository.updateCheckpoint('greenhouse', { hasMore: false });
  assert.deepEqual(calls[0].filter, { _id: 'greenhouse' });
  assert.deepEqual(calls[0].update, { $set: { checkpoint: { hasMore: false } } });
});

test('source health update unsets undefined diagnostics explicitly', async () => {
  const calls = [];
  const repository = new SourcesRepository({ updateOne: async (filter, update) => calls.push({ filter, update }) }, {}, {});
  await repository.updateHealth('greenhouse', { healthState: 'Healthy', healthMessage: undefined, lastError: undefined, lastSuccessAt: new Date('2026-10-07T10:00:00.000Z') });
  assert.deepEqual(calls[0].filter, { _id: 'greenhouse' });
  assert.equal(calls[0].update.$set.healthState, 'Healthy');
  assert.deepEqual(calls[0].update.$unset, { healthMessage: '', lastError: '' });
});
