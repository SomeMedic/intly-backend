import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');
const { mergePersonalStates, mergeSourceOccurrences } = require('../src/modules/opportunities/opportunity-merge.ts');
const date = value => new Date(`2026-10-${value}T00:00:00Z`);
const state = input => ({ _id: 'state', userId: 'user', profileId: 'profile', pipelineStatus: 'New', notes: [], checklist: [], tags: [], pipelineEvents: [], favorite: false, hidden: false, archived: false, pinned: false, responseState: {}, ...input });
test('same owner/profile retains independent notes, tags, earliest stages and explicit target decision', () => {
  const target = state({ pipelineStatus: 'Interested', tags: ['target'], favorite: true, notes: [{ id: 'shared', text: 'target' }], pipelineEvents: [{ status: 'Interested', firstReachedAt: date('05') }] });
  const duplicate = state({ _id: 'other', pipelineStatus: 'Applied', tags: ['other'], pinned: true, notes: [{ id: 'shared', text: 'different private note' }], pipelineEvents: [{ status: 'Interested', firstReachedAt: date('01') }, { status: 'Applied', firstReachedAt: date('04') }] });
  const merged = mergePersonalStates(target, duplicate, 'vacancy');
  assert.equal(merged.pipelineStatus, 'Interested'); assert.equal(merged.notes.length, 2);
  assert.notEqual(merged.notes[0].id, merged.notes[1].id); assert.deepEqual(merged.tags, ['target', 'other']);
  assert.equal(merged.favorite, true); assert.equal(merged.pinned, true);
  assert.equal(+merged.pipelineEvents.find(event => event.status === 'Interested').firstReachedAt, +date('01'));
  assert.deepEqual(target.notes, [{ id: 'shared', text: 'target' }]);
});
test('derived updatedAt never overwrites a meaningful stage; untouched New can inherit progress', () => {
  const duplicate = state({ pipelineStatus: 'Applied', updatedAt: date('06') });
  assert.equal(mergePersonalStates(state({ pipelineStatus: 'New', pipelineEvents: [{ status: 'Interested', firstReachedAt: date('01') }] }), duplicate, 'vacancy').pipelineStatus, 'New');
  assert.equal(mergePersonalStates(state({ updatedAt: date('06') }), duplicate, 'vacancy').pipelineStatus, 'Applied');
});
test('different users/profiles cannot share a merged personal state', () => {
  assert.throws(() => mergePersonalStates(state({}), state({ userId: 'another' }), 'vacancy'), /ownership/);
  assert.throws(() => mergePersonalStates(state({}), state({ profileId: 'another' }), 'vacancy'), /ownership/);
});
test('source union retains freshest native payload, earliest observation and exactly one selected primary', () => {
  const occurrence = (sourceId, primary, day, raw) => ({ sourceId, externalId: sourceId, url: `https://example.test/${sourceId}`, primary, firstSeenAt: date(day), lastSeenAt: date(day), rawPayload: raw, sourceMetadata: {}, status: 'Active' });
  const merged = mergeSourceOccurrences({ sourceOccurrences: [occurrence('a', true, '02', { older: true })] }, { sourceOccurrences: [occurrence('a', false, '05', { newer: true }), occurrence('b', true, '01', { other: true })] });
  assert.equal(merged.length, 2); assert.equal(merged.filter(item => item.primary).length, 1);
  assert.equal(merged[0].primary, true); assert.deepEqual(merged[0].rawPayload, { newer: true });
  assert.equal(+merged[0].firstSeenAt, +date('02')); assert.equal(+merged[0].lastSeenAt, +date('05'));
});
