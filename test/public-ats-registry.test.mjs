import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { SOURCE_CATALOG } = require('../src/modules/sources/catalog/source-catalog.ts');
const { ConnectorRegistryService } = require('../src/modules/sources/connectors/connector-registry.service.ts');
const { WebExtractionService } = require('../src/modules/sources/extraction/web-extraction.service.ts');

test('registered Personio and Workday expose usable public collectors for configured company career boards', async () => {
  const registry = new ConnectorRegistryService(new WebExtractionService());
  for (const [id, tenants] of [
    ['personio', ['open.jobs.personio.com']],
    ['workday', ['https://workday.wd5.myworkdayjobs.com/en-US/Workday']],
  ]) {
    const entry = SOURCE_CATALOG.find(value => value.id === id);
    const source = { ...entry, _id: id, config: { tenants } };
    const collector = registry.get(source);
    assert.equal(collector.id, id);
    assert.equal(collector.family, 'AtsPublicBoard');
    assert.equal(collector.capabilities().requiresCredentials, false);
    assert.equal(collector.capabilities().supportsBackfill, true);
    assert.equal((await collector.validateConfig({ ...entry.endpoint, tenants })).ok, true);
    assert.equal(typeof collector.discover, 'function');
  }
});
