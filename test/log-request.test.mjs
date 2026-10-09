import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { redactFileDownloadTicket, serializeLogRequest } = require('../src/common/log-request.ts');

test('request logs redact duplicate and URL-encoded download ticket parameters', () => {
  const url = '/api/v1/files/file/download?%74icket=private-one&ticket=private-two&other=keep';
  const result = redactFileDownloadTicket(url);
  assert.ok(!result.includes('private-one') && !result.includes('private-two'));
  assert.equal(new URL(result, 'http://localhost').searchParams.get('ticket'), '[Redacted]');
  assert.equal(new URL(result, 'http://localhost').searchParams.get('other'), 'keep');
  const request = { id: 'id', url, method: 'GET', headers: { authorization: 'existing-redaction' } };
  assert.deepEqual(serializeLogRequest(request), { ...request, url: result });
  assert.equal(request.url, url);
  assert.equal(redactFileDownloadTicket('/api/v1/opportunities?q=Full+Stack'), '/api/v1/opportunities?q=Full+Stack');
  const nested = '/files/id/download?ticket[value]=private-nested&ticket[]=private-array&other=keep';
  assert.ok(!redactFileDownloadTicket(nested).includes('private-'));
});

test('parsed download ticket fields are redacted without mutating the request query', () => {
  for (const ticket of ['private-capability', ['private-one', 'private-two'], { value: 'private-capability' }]) {
    const query = { ticket, other: 'keep' };
    const original = structuredClone(query);
    const logged = serializeLogRequest({ url: '/files/id/download', query });
    assert.deepEqual(logged.query, { ticket: '[Redacted]', other: 'keep' });
    assert.deepEqual(query, original);
  }
  const query = { 'ticket[value]': 'private-nested', 'ticket[]': ['private-array'], other: 'keep' };
  assert.deepEqual(serializeLogRequest({ query }).query, { 'ticket[value]': '[Redacted]', 'ticket[]': '[Redacted]', other: 'keep' });
  assert.equal(query['ticket[value]'], 'private-nested');
});

test('actual HTTP request logs contain neither raw nor parsed file download capabilities', { timeout: 8000 }, async () => {
  const pinoHttp = createRequire(require.resolve('nestjs-pino'))('pino-http');
  const privateTicket = 'fdl1.unique-regression-capability';
  let logLine;
  const completed = new Promise(resolve => { logLine = resolve; });
  const logger = pinoHttp({ serializers: { req: serializeLogRequest } }, {
    write(chunk) {
      for (const line of String(chunk).trim().split('\n')) {
        const entry = JSON.parse(line);
        if (entry.msg === 'request completed') logLine(entry);
      }
    },
  });
  const server = createServer((request, response) => {
    request.query = Object.fromEntries(new URL(request.url, 'http://localhost').searchParams);
    logger(request, response);
    response.end('ok');
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/files/id/download?%74icket=${privateTicket}&other=keep`, { signal: AbortSignal.timeout(5000) });
    await response.text();
    const entry = await completed;
    assert.ok(!JSON.stringify(entry).includes(privateTicket));
    assert.equal(entry.req.query.ticket, '[Redacted]');
    assert.equal(new URL(entry.req.url, 'http://localhost').searchParams.get('ticket'), '[Redacted]');
    assert.equal(entry.req.query.other, 'keep');
    assert.equal(entry.res.statusCode, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
