import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');
const { OpportunitiesService } = require('../src/modules/opportunities/opportunities.service.ts');
const input = { sourceId: 'workspace', externalId: '18970', url: 'https://workspace.ru/tenders/18970/', opportunityId: 'opp', observedAt: '2026-10-05T00:00:00Z', reason: 'HTTP 410', runId: 'run' };
const opportunity = () => ({ _id: 'opp', type: 'tender', title: 'Tender', sourceStatus: 'Active', sourceOccurrences: [{ sourceId: input.sourceId, externalId: input.externalId, url: input.url, status: 'Active' }], money: {}, adminCorrections: [] });
function service(repository) {
  const instance = new OpportunitiesService(repository, {}, {}, {}, {}, {});
  instance.events = [];
  instance.enqueueIngestionMatch = async (...args) => instance.events.push(['match', ...args]);
  instance.enqueueSearchIndex = async (...args) => instance.events.push(['search', ...args]);
  return instance;
}

test('retries an exact CAS conflict and indexes the actual confirmed status without touching personal state', async () => {
  const current = opportunity();
  let writes = 0;
  const instance = service({ getById: async () => current, markSourceOccurrenceRemovedExact: async (value) => {
    assert.equal(value.externalId, '18970');
    assert.ok(value.observedAt instanceof Date);
    return ++writes === 1 ? false : { ...current, sourceStatus: 'Removed' };
  } });
  assert.deepEqual(await instance.markSourceOccurrenceRemoved(input), { opportunityId: 'opp', sourceStatus: 'Removed' });
  assert.equal(writes, 2);
  assert.deepEqual(instance.events.map((event) => event[0]).sort(), ['match', 'search']);
});

test('a retry after an applied removal reindexes without changing the retained removal again', async () => {
  const current = opportunity();
  current.sourceOccurrences[0].status = 'Removed';
  current.sourceStatus = 'Removed';
  const instance = service({ getById: async () => current, markSourceOccurrenceRemovedExact: async () => assert.fail('must not rewrite an applied removal') });
  assert.equal((await instance.markSourceOccurrenceRemoved(input)).sourceStatus, 'Removed');
  assert.equal(instance.events.length, 2);
});

test('wrong identity, merged opportunities and invalid observations never write a removal', async () => {
  for (const value of [{ ...input, externalId: 'other' }, { ...input, url: 'https://workspace.ru/tenders/other/' }]) {
    const instance = service({ getById: async () => opportunity(), markSourceOccurrenceRemovedExact: async () => assert.fail('must not write') });
    await assert.rejects(instance.markSourceOccurrenceRemoved(value), /identity/);
    assert.equal(instance.events.length, 0);
  }
  const merged = service({ getById: async () => ({ ...opportunity(), mergedIntoOpportunityId: 'canonical' }) });
  await assert.rejects(merged.markSourceOccurrenceRemoved(input), /unmerged/);
  const invalid = service({ getById: async () => assert.fail('must validate first') });
  await assert.rejects(invalid.markSourceOccurrenceRemoved({ ...input, observedAt: 'invalid' }), /observation/);
});
