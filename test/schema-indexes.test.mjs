import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { ApiTokenSchema } = require('../src/modules/api-tokens/schemas/api-token.schema.ts');
const { OpportunitySchema } = require('../src/modules/opportunities/schemas/opportunity.schema.ts');
const { CalendarEventSchema } = require('../src/modules/calendar/schemas/calendar-event.schema.ts');
const { AiProviderConfigSchema, AiTaskConfigSchema, AiPromptTemplateSchema } = require('../src/modules/ai/schemas/ai-config.schema.ts');

describe('schema index contracts', () => {
  it('keeps one TTL index for API token expiration', () => {
    assertSingleIndex(ApiTokenSchema, { expiresAt: 1 }, (options) => options.expireAfterSeconds === 0);
  });

  it('keeps one deadline index for opportunity sorting and filters', () => {
    assertSingleIndex(OpportunitySchema, { deadline: 1 });
  });

  it('keeps one taskId index for calendar task lookups', () => {
    assertSingleIndex(CalendarEventSchema, { taskId: 1 });
  });

  it('keeps one unique admin AI config index per natural key', () => {
    assertSingleIndex(AiProviderConfigSchema, { provider: 1 }, (options) => options.unique === true);
    assertSingleIndex(AiTaskConfigSchema, { taskType: 1 }, (options) => options.unique === true);
    assertSingleIndex(AiPromptTemplateSchema, { taskType: 1 }, (options) => options.unique === true);
  });
});

function assertSingleIndex(schema, expectedFields, validateOptions = () => true) {
  const matches = schema.indexes().filter(([fields]) => sameFields(fields, expectedFields));
  assert.equal(matches.length, 1, `expected exactly one index for ${JSON.stringify(expectedFields)}, got ${matches.length}`);
  assert.equal(validateOptions(matches[0][1] ?? {}), true, `unexpected index options for ${JSON.stringify(expectedFields)}: ${JSON.stringify(matches[0][1] ?? {})}`);
}

function sameFields(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
