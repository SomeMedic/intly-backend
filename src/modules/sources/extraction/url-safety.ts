import { isIP } from 'node:net';

export function parseHttpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }
  if (!url.hostname) throw new Error('URL host is required');
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  return url;
}

export async function assertPublicHttpUrl(url: URL): Promise<void> {
  const host = url.hostname.toLowerCase();
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Localhost URLs are not allowed');
  if (isPrivateAddress(host)) throw new Error('Private, loopback and link-local URLs are not allowed');

}

export function assertAllowedHost(url: URL, allowedHosts: string[]): void {
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.map((item) => item.toLowerCase());
  if (!allowed.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) {
    throw new Error(`URL host ${host} is outside the source allowlist`);
  }
}

function isPrivateAddress(value: string): boolean {
  const normalized = normalizeIpLiteral(value.toLowerCase());
  if (normalized === 'localhost') return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    if (normalized.startsWith('10.') || normalized.startsWith('127.') || normalized.startsWith('169.254.')) return true;
    if (normalized.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return true;
    if (normalized === '0.0.0.0') return true;
  }
  if (ipVersion === 6) {
    if (normalized.startsWith('::ffff:')) return true;
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  }
  return false;
}

function normalizeIpLiteral(value: string): string {
  value = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return mapped;
  }
  return value;
}
