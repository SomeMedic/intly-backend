import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { VkWallConnector } = require('../src/modules/sources/connectors/vk-wall.connector.ts');

test('VK ingestion accepts current and legacy groups.getById responses', async (t) => {
  for (const response of [{ groups: [{ id: 123 }], profiles: [] }, [{ id: 123 }]]) {
    await t.test(Array.isArray(response) ? 'legacy array' : 'API 5.199 object', async () => {
      const requests = [];
      t.mock.method(globalThis, 'fetch', async (url) => {
        requests.push(new URL(url));
        const payload = url.pathname.endsWith('/groups.getById')
          ? { response }
          : { response: { count: 1, items: [{ id: 7, date: Math.floor(Date.now() / 1000), text: 'Вакансия разработчика' }] } };
        return new Response(JSON.stringify(payload));
      });
      const result = await new VkWallConnector().fetchPage({
        source: { name: 'VK fixture', endpoint: { domain: 'fixture' }, limits: { perPage: 1 } },
        credentials: { accessToken: 'fixture-token' }, checkpoint: {}, backfillDays: 30,
      });
      assert.equal(requests[1].searchParams.get('owner_id'), '-123');
      assert.equal(result.records[0].externalId, '123:7');
      assert.equal(result.records[0].type, 'vacancy');
      t.mock.restoreAll();
    });
  }
});
