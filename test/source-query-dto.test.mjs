import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('reflect-metadata');

const { plainToInstance } = require('class-transformer');
const { validateSync } = require('class-validator');
const { ListRunsDto, ListSourcesDto } = require('../src/modules/sources/dto/source.dto.ts');
const { SOURCE_RUN_STATUSES } = require('../src/modules/sources/schemas/source-run.schema.ts');

function validateQuery(Dto, query) {
  const dto = plainToInstance(Dto, query);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }) };
}

test('source query DTOs transform valid numeric query strings and keep invalid limits rejected', () => {
  for (const Dto of [ListSourcesDto, ListRunsDto]) {
    const valid = validateQuery(Dto, { limit: '200' });
    assert.equal(valid.errors.length, 0);
    assert.equal(valid.dto.limit, 200);
    assert.equal(typeof valid.dto.limit, 'number');

    for (const limit of ['201', '0', 'text', '1.5']) {
      const invalid = validateQuery(Dto, { limit });
      assert.ok(invalid.errors.some((error) => error.property === 'limit'), `${Dto.name} should reject limit=${limit}`);
    }
  }
});

test('source run query DTO accepts only known run statuses', () => {
  for (const status of SOURCE_RUN_STATUSES) {
    const valid = validateQuery(ListRunsDto, { status });
    assert.equal(valid.errors.length, 0, `${status} should be accepted`);
    assert.equal(valid.dto.status, status);
  }

  const invalid = validateQuery(ListRunsDto, { status: 'Unknown' });
  assert.ok(invalid.errors.some((error) => error.property === 'status'));
});
