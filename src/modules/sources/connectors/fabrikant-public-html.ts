import { fetch as undiciFetch } from 'undici';

import { createPinnedDispatcher } from '../extraction/pinned-fetch';
import { assertAllowedHost, parseHttpUrl } from '../extraction/url-safety';
import { WebExtractionHttpError } from '../extraction/web-extraction.service';

export type FabrikantDocument = { finalUrl: string; html: string; metadata: Record<string, unknown> };
export type FabrikantLegacyTransport = (url: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<FabrikantDocument>;

/** Old public /trades pages declare Windows-1251; keep the existing DNS pinning boundary. */
export const fetchFabrikantLegacy: FabrikantLegacyTransport = async (input, options) => {
  let url = parseHttpUrl(input);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
  for (let redirects = 0; redirects <= 3; redirects++) {
    assertAllowedHost(url, ['fabrikant.ru']);
    if (url.protocol !== 'https:' || url.port || !url.pathname.startsWith('/trades/') || url.searchParams.get('action') !== 'view' || !/^\d+$/.test(url.searchParams.get('id') ?? '')) throw new Error('Fabrikant legacy transport requires a native public detail URL');
    const dispatcher = await createPinnedDispatcher(url);
    try {
      const response = await undiciFetch(url, { dispatcher, redirect: 'manual', signal, headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': process.env.INTLY_CRAWLER_USER_AGENT ?? 'INTLY/1.0' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Fabrikant detail redirect has no location');
        url = parseHttpUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new WebExtractionHttpError(response.status, url.toString(), { accessReason: response.status === 429 ? 'rate_limited' : [401, 403].includes(response.status) ? 'access_denied' : undefined, retryAfter: response.headers.get('retry-after') ?? undefined });
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml/i.test(contentType)) { await response.body?.cancel(); throw new Error('Fabrikant detail is not HTML'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Fabrikant detail has no response body');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 3_000_000) throw new Error('Fabrikant detail exceeds HTML byte limit');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const bytes = Buffer.concat(chunks);
      const declared = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(contentType)?.[1] ?? /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(bytes.subarray(0, 8192).toString('latin1'))?.[1] ?? 'utf-8';
      const encoding = /^(?:windows-1251|cp1251)$/i.test(declared) ? 'windows-1251' : /^(?:utf-8|utf8)$/i.test(declared) ? 'utf-8' : null;
      if (!encoding) throw new Error('Fabrikant detail declares an unsupported character encoding');
      return { finalUrl: url.toString(), html: new TextDecoder(encoding, { fatal: true }).decode(bytes), metadata: { firecrawl: false, contentType, encoding, byteLength: length } };
    } finally { await dispatcher.close().catch(() => undefined); }
  }
  throw new Error('Fabrikant detail exceeded redirect limit');
};
