import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { SourcesService } = require('../src/modules/sources/sources.service.ts');

test('admin source access distinguishes a reference, stored values, and a public connector', async () => {
  const rows = [
    { _id: 'missing', authCredentialRef: 'catalog-reference' },
    { _id: 'stored', authCredentialRef: 'catalog-reference', credentialsEncrypted: 'encrypted-fixture' },
    { _id: 'public', authCredentialRef: 'optional-reference' },
  ];
  const service = new SourcesService(
    { list: async () => ({ items: rows, nextCursor: null }), get: async id => rows.find(row => row._id === id) },
    { get: source => ({ capabilities: () => ({ requiresCredentials: source._id !== 'public' }) }) },
    null, null, null, null, null, null, null,
  );
  const page = await service.list({});
  assert.deepEqual(page.items.map(row => [row._id, row.credentialsRequired, row.credentialsConfigured]), [
    ['missing', true, false], ['stored', true, true], ['public', false, false],
  ]);
  for (const row of page.items) assert.equal('credentialsEncrypted' in row, false);
  const detail = await service.get('stored');
  assert.equal(detail.credentialsConfigured, true);
  assert.equal('credentialsEncrypted' in detail, false);
});
