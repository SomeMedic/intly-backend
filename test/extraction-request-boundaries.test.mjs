import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { WebExtractionHttpError, WebExtractionService } = require('../src/modules/sources/extraction/web-extraction.service.ts');

const service = new WebExtractionService();
const originalFetch = globalThis.fetch;
const originalFirecrawlApiUrl = process.env.FIRECRAWL_API_URL;
const originalFirecrawlApiKey = process.env.FIRECRAWL_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalFirecrawlApiUrl === undefined) delete process.env.FIRECRAWL_API_URL;
  else process.env.FIRECRAWL_API_URL = originalFirecrawlApiUrl;
  if (originalFirecrawlApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = originalFirecrawlApiKey;
});

describe('web extraction request boundaries', () => {
  it('reads bounded response streams without consuming oversized bodies fully', async () => {
    let cancelled = false;
    let requestedSecondChunk = false;
    const response = new Response(new ReadableStream({
      pull(controller) {
        if (!requestedSecondChunk) {
          requestedSecondChunk = true;
          controller.enqueue(new TextEncoder().encode('12345'));
          return;
        }
        controller.enqueue(new TextEncoder().encode('67890'));
      },
      cancel() {
        cancelled = true;
      },
    }));

    await assert.rejects(() => service.readLimited(response, 6), /Response exceeds v1 size limit/);
    assert.equal(cancelled, true);
  });

  it('returns bounded response stream text when it is within the byte limit', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('safe body'));
        controller.close();
      },
    }));

    assert.equal(await service.readLimited(response, 32), 'safe body');
  });

  it('rejects Firecrawl final URLs outside the source allowlist before accepting extracted HTML', async () => {
    process.env.FIRECRAWL_API_URL = 'https://firecrawl.example.test';
    delete process.env.FIRECRAWL_API_KEY;
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: {
        html: '<main>Off-host content</main>',
        markdown: 'Off-host content',
        metadata: { sourceURL: 'https://evil.example.test/jobs/backend-engineer' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    await assert.rejects(
      () => service.tryFirecrawl(new URL('https://allowed.example.test/jobs/backend-engineer'), {
        allowedHosts: ['allowed.example.test'],
        timeoutMs: 1000,
        maxBytes: 1000,
      }),
      /outside the source allowlist/,
    );
  });

  it('passes caller abort signals into Firecrawl requests', async () => {
    process.env.FIRECRAWL_API_URL = 'https://firecrawl.example.test';
    const controller = new AbortController();
    controller.abort();
    let sawAbortedSignal = false;
    globalThis.fetch = async (_url, init) => {
      sawAbortedSignal = init.signal.aborted;
      throw new DOMException('request aborted', 'AbortError');
    };

    await assert.rejects(
      () => service.tryFirecrawl(new URL('https://allowed.example.test/jobs/backend-engineer'), {
        allowedHosts: ['allowed.example.test'],
        timeoutMs: 1000,
        maxBytes: 1000,
        signal: controller.signal,
      }),
      /request aborted/,
    );
    assert.equal(sawAbortedSignal, true);
  });

  it('applies the same allowlist guard used by HTML redirects and AJAX redirects', () => {
    assert.doesNotThrow(() => service.assertAllowedFinalUrl(new URL('https://jobs.allowed.example.test/vacancy/123'), {
      allowedHosts: ['allowed.example.test'],
    }));
    assert.throws(() => service.assertAllowedFinalUrl(new URL('https://jobs.evil.example.test/vacancy/123'), {
      allowedHosts: ['allowed.example.test'],
    }), /outside the source allowlist/);
  });

  it('classifies public-site HTTP denial responses without storing unsafe response data', async () => {
    const challenge = await service.httpError(
      new Response('<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/jsch/v1"></script></body></html>', {
        status: 403,
        headers: { 'content-type': 'text/html', server: 'cloudflare', 'set-cookie': 'clearance=secret' },
      }),
      'https://www.weblancer.net/freelance/',
      { maxBytes: 4096 },
    );
    assert.equal(challenge instanceof WebExtractionHttpError, true);
    assert.equal(challenge.status, 403);
    assert.equal(challenge.url, 'https://www.weblancer.net/freelance/');
    assert.equal(challenge.accessReason, 'bot_challenge');
    assert.match(challenge.message, /bot challenge blocked the extraction client/);
    assert.match(challenge.message, /parser success was not established/);
    assert.doesNotMatch(challenge.message, /clearance=secret|cdn-cgi\/challenge-platform/);

    const ordinary = await service.httpError(
      new Response('<html><head><title>Forbidden</title></head><body>not allowed</body></html>', { status: 403 }),
      'https://example.test/private',
      { maxBytes: 4096 },
    );
    assert.equal(ordinary.status, 403);
    assert.equal(ordinary.accessReason, 'access_denied');
    assert.match(ordinary.message, /access denied/);
    assert.doesNotMatch(ordinary.message, /bot challenge/);

    const rateLimited = await service.httpError(
      new Response('Too many requests', { status: 429, headers: { 'retry-after': '120' } }),
      'https://example.test/list',
      { maxBytes: 4096 },
    );
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.accessReason, 'rate_limited');
    assert.equal(rateLimited.retryAfter, '120');
    assert.match(rateLimited.message, /rate limit/);
  });

  it('limits HTTP error body reads and preserves abort semantics', async () => {
    let cancelled = false;
    let secondChunkRequested = false;
    const oversized = new Response(new ReadableStream({
      pull(controller) {
        if (!secondChunkRequested) {
          secondChunkRequested = true;
          controller.enqueue(new TextEncoder().encode('x'.repeat(65_536)));
          return;
        }
        controller.enqueue(new TextEncoder().encode('overflow'));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 403 });

    const error = await service.httpError(oversized, 'https://example.test/huge-403', { maxBytes: 2_000_000 });
    assert.equal(error.status, 403);
    assert.equal(error.accessReason, 'access_denied');
    assert.equal(cancelled, true);
    assert.match(error.cause.message, /Response exceeds v1 size limit/);

    const aborted = new Response(new ReadableStream({
      pull(controller) {
        controller.error(new DOMException('caller aborted', 'AbortError'));
      },
    }), { status: 403 });

    await assert.rejects(
      () => service.httpError(aborted, 'https://example.test/abort-403', { maxBytes: 4096 }),
      /caller aborted/,
    );
  });
});
