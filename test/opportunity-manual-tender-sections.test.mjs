import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { ManualOpportunityDto } = require('../src/modules/opportunities/dto/opportunity.dto.ts');
const { OpportunitiesService } = require('../src/modules/opportunities/opportunities.service.ts');

const actor = { id: 'user-1', role: 'User' };

function serviceHarness() {
  const inputs = [];
  const service = new OpportunitiesService({}, {}, {}, {}, {}, {});
  service.ingestOrUpsert = async (input) => {
    inputs.push(input);
    return { opportunity: { _id: 'opp-1', ...input }, created: true, occurrenceAdded: true, matchedProfileIds: [] };
  };
  return { service, inputs };
}

test('ManualOpportunityDto accepts tender required application sections from allowlist only', async () => {
  const valid = plainToInstance(ManualOpportunityDto, {
    type: 'tender',
    title: 'Tender',
    requiredApplicationSections: ['eligibility', 'technical-response'],
  });
  assert.deepEqual(await validate(valid), []);

  const invalid = plainToInstance(ManualOpportunityDto, {
    type: 'tender',
    title: 'Tender',
    requiredApplicationSections: ['unknown-section'],
  });
  const errors = await validate(invalid);
  assert.equal(errors.some((error) => error.property === 'requiredApplicationSections'), true);
});

test('manual tender create maps deduped required sections into canonical tenderData', async () => {
  const { service, inputs } = serviceHarness();

  const result = await service.manualCreate(actor, {
    type: 'tender',
    title: 'Tender',
    requiredApplicationSections: ['eligibility', 'technical-response', 'eligibility'],
  });

  assert.deepEqual(inputs[0].tenderData, { requiredApplicationSections: ['eligibility', 'technical-response'] });
  assert.equal('requiredApplicationSections' in inputs[0], false);
  assert.deepEqual(result.opportunity.tenderData.requiredApplicationSections, ['eligibility', 'technical-response']);
});

test('manual tender create stores empty canonical sections when no config is supplied', async () => {
  const { service, inputs } = serviceHarness();

  await service.manualCreate(actor, { type: 'tender', title: 'Tender without configured sections' });

  assert.deepEqual(inputs[0].tenderData, { requiredApplicationSections: [] });
});

test('manual create rejects non-tender and unknown required section config fail closed', async () => {
  const { service } = serviceHarness();

  await assert.rejects(
    () => service.manualCreate(actor, { type: 'vacancy', title: 'Vacancy', requiredApplicationSections: [] }),
    (error) => error?.response?.code === 'TENDER_APPLICATION_SECTIONS_NOT_ALLOWED' && error?.response?.details?.allowedTypes?.[0] === 'tender',
  );
  await assert.rejects(
    () => service.manualCreate(actor, { type: 'tender', title: 'Tender', requiredApplicationSections: ['unknown-section'] }),
    (error) => error?.response?.code === 'TENDER_APPLICATION_SECTIONS_INVALID' && Array.isArray(error?.response?.details?.allowed) && error?.response?.details?.invalid?.[0] === 'unknown-section',
  );
  await assert.rejects(
    () => service.manualCreate(actor, { type: 'tender', title: 'Tender', requiredApplicationSections: 'eligibility' }),
    (error) => error?.response?.code === 'TENDER_APPLICATION_SECTIONS_INVALID',
  );
});
