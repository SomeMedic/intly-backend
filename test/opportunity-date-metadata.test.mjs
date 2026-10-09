import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');
const { opportunityDateMetadata } = require('../src/modules/opportunities/opportunity-date-metadata.ts');
const { OpportunitiesService } = require('../src/modules/opportunities/opportunities.service.ts');
const native = () => ({
  sourceId: 'workspace', primary: true, url: 'https://workspace.ru/tenders/qa-18970/',
  publishedAt: new Date('2026-09-24T12:00:00.000Z'),
  normalizedSnapshot: { deadline: new Date('2026-10-08T12:00:00.000Z') },
  sourceMetadata: { datePrecision: 'day', dateTimezone: 'UTC', publishedText: '24 сентября 2026', deadlinePrecision: 'day', deadlineTimezone: 'UTC', deadlineText: '8 октября 2026' },
});
const record = () => ({ _id: 'qa', type: 'tender', money: {}, sourceStatus: 'Active', publishedAt: native().publishedAt, deadline: native().normalizedSnapshot.deadline, sourceOccurrences: [native()], adminCorrections: [] });

test('exposes native day precision through the same detail and list response without raw payload', () => {
  const opportunity = record();
  const service = new OpportunitiesService({}, {}, {}, {}, {}, {});
  const detail = service.toResponse(opportunity);
  const list = service.toListItem(opportunity);
  assert.deepEqual(detail.dateMetadata, list.dateMetadata);
  assert.deepEqual(detail.dateMetadata, {
    publishedAt: { precision: 'day', calendarDate: '2026-09-24', timezone: 'UTC', originalText: '24 сентября 2026' },
    deadline: { precision: 'day', calendarDate: '2026-10-08', timezone: 'UTC', originalText: '8 октября 2026' },
  });
  assert.equal(detail.sourceOccurrences[0].sourceMetadata, undefined);
});

test('pinned canonical date changes do not inherit a different source date precision', () => {
  const opportunity = record();
  opportunity.deadline = new Date('2026-10-08T14:00:00Z');
  opportunity.adminCorrections = [{ field: 'deadline', pinned: true, value: opportunity.deadline }];
  assert.equal(opportunityDateMetadata(opportunity).deadline, undefined);
});

test('exact source timestamps and unmarked noon or midnight are never inferred as days', () => {
  for (const value of ['2026-10-02T14:22:00Z', '2026-10-02T00:00:00Z', '2026-10-02T12:00:00Z']) {
    const opportunity = record();
    opportunity.publishedAt = new Date(value);
    opportunity.deadline = undefined;
    opportunity.sourceOccurrences[0].publishedAt = opportunity.publishedAt;
    opportunity.sourceOccurrences[0].sourceMetadata = { extraction: 'roseltorg-native' };
    assert.equal(opportunityDateMetadata(opportunity), undefined);
  }
});

test('canonical matching uses the contributing occurrence and its native timezone', () => {
  const opportunity = record();
  const secondary = native();
  secondary.primary = false;
  secondary.publishedAt = new Date('2026-10-01T14:30:00Z');
  secondary.sourceMetadata.dateTimezone = 'Pacific/Kiritimati';
  opportunity.publishedAt = secondary.publishedAt;
  opportunity.deadline = undefined;
  opportunity.sourceOccurrences.push(secondary);
  assert.equal(opportunityDateMetadata(opportunity).publishedAt.calendarDate, '2026-10-02');
});

test('malformed source dates, timezone and text cannot break the public response', () => {
  const opportunity = record();
  opportunity.sourceOccurrences[0].sourceMetadata.dateTimezone = 'Bad/Timezone';
  opportunity.sourceOccurrences[0].sourceMetadata.deadlineText = { secret: 'not public' };
  assert.equal(opportunityDateMetadata(opportunity).publishedAt, undefined);
  assert.equal(opportunityDateMetadata(opportunity).deadline.originalText, undefined);
  opportunity.deadline = new Date('invalid');
  assert.equal(opportunityDateMetadata(opportunity), undefined);
});
