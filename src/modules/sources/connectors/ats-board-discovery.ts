import { safePublicHostOrSlug } from './connector-utils';

export type AtsBoardFamily = 'greenhouse' | 'lever' | 'ashby' | 'personio';

export type AtsDiscoverySeed = {
  url: string;
  source: 'discoveryUrls' | 'discoveryHosts';
};

export type AtsDiscoveryCandidate = {
  tenant: string;
  evidenceUrl: string;
  evidenceType: 'direct-url' | 'html-link';
};

const HOST_DISCOVERY_PATHS = ['', '/careers', '/jobs', '/work-with-us'];

export class AtsBoardDiscovery {
  constructor(private readonly family: AtsBoardFamily) {}

  seedsFromConfig(config: Record<string, unknown>): AtsDiscoverySeed[] {
    const seeds = new Map<string, AtsDiscoverySeed>();
    for (const value of this.readStrings(config.discoveryUrls)) {
      const url = this.normalizeHttpsUrl(value);
      if (url) seeds.set(url, { url, source: 'discoveryUrls' });
    }
    for (const value of this.readStrings(config.discoveryHosts)) {
      const exactUrl = this.normalizeHttpsUrl(value);
      if (exactUrl && /\/|\?/.test(value.replace(/^https?:\/\//i, ''))) {
        seeds.set(exactUrl, { url: exactUrl, source: 'discoveryHosts' });
        continue;
      }
      const host = this.normalizeHost(value);
      if (!host) continue;
      for (const path of HOST_DISCOVERY_PATHS) {
        const url = `https://${host}${path}`;
        seeds.set(url, { url, source: 'discoveryHosts' });
      }
    }
    return [...seeds.values()];
  }

  candidatesFromUrl(url: string): AtsDiscoveryCandidate[] {
    const parsed = this.parseUrl(url);
    if (!parsed) return [];
    const tenant = this.tenantFromParsedUrl(parsed);
    return tenant ? [{ tenant, evidenceUrl: parsed.toString(), evidenceType: 'direct-url' }] : [];
  }

  candidatesFromHtml(html: string, evidenceUrl: string): AtsDiscoveryCandidate[] {
    const candidates = new Map<string, AtsDiscoveryCandidate>();
    for (const pattern of this.htmlPatterns()) {
      for (const match of html.matchAll(pattern)) {
        const raw = match[1] ?? match[2];
        const tenant = raw?.toLowerCase();
        if (tenant && safePublicHostOrSlug(tenant)) {
          candidates.set(tenant, { tenant, evidenceUrl, evidenceType: 'html-link' });
        }
      }
    }
    return [...candidates.values()];
  }

  private readStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  }

  private normalizeHttpsUrl(value: string): string | null {
    const withScheme = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
    const parsed = this.parseUrl(withScheme);
    if (!parsed || parsed.protocol !== 'https:' || !safePublicHostOrSlug(parsed.hostname)) return null;
    parsed.hash = '';
    return parsed.toString();
  }

  private normalizeHost(value: string): string | null {
    const host = value.trim().replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0]?.toLowerCase();
    return host && safePublicHostOrSlug(host) ? host : null;
  }

  private parseUrl(value: string): URL | null {
    try {
      const parsed = new URL(value);
      return safePublicHostOrSlug(parsed.hostname) ? parsed : null;
    } catch {
      return null;
    }
  }

  private tenantFromParsedUrl(url: URL): string | null {
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    if (this.family === 'greenhouse') {
      if (host === 'job-boards.greenhouse.io' && url.pathname === '/embed/job_board') return this.safeTenant(url.searchParams.get('for') ?? '');
      if (host === 'boards.greenhouse.io' && parts[0]) return this.safeTenant(parts[0]);
      if (host === 'job-boards.greenhouse.io' && parts[0] && parts[0] !== 'embed') return this.safeTenant(parts[0]);
      if (host === 'boards-api.greenhouse.io' && parts[0] === 'v1' && parts[1] === 'boards' && parts[2]) return this.safeTenant(parts[2]);
    }
    if (this.family === 'lever') {
      if (host === 'jobs.lever.co' && parts[0]) return this.safeTenant(parts[0]);
      if (host === 'api.lever.co' && parts[0] === 'v0' && parts[1] === 'postings' && parts[2]) return this.safeTenant(parts[2]);
    }
    if (this.family === 'ashby') {
      if (host === 'jobs.ashbyhq.com' && parts[0]) return this.safeTenant(parts[0]);
      if (host === 'api.ashbyhq.com' && parts[0] === 'posting-api' && parts[1] === 'job-board' && parts[2]) return this.safeTenant(parts[2]);
    }
    if (this.family === 'personio') {
      if (/\.jobs\.personio\.(de|com)$/i.test(host)) return this.safeTenant(host);
    }
    return null;
  }

  private htmlPatterns(): RegExp[] {
    const patterns: Record<AtsBoardFamily, RegExp[]> = {
      greenhouse: [
        /https?:\/\/boards\.greenhouse\.io\/([a-z0-9.-]+)/gi,
        /https?:\/\/job-boards\.greenhouse\.io\/(?!embed\b)([a-z0-9.-]+)/gi,
        /https?:\/\/job-boards\.greenhouse\.io\/embed\/job_board\?[^"'<>\s]*for=([a-z0-9.-]+)/gi,
        /https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9.-]+)/gi,
      ],
      lever: [/https?:\/\/jobs\.lever\.co\/([a-z0-9.-]+)/gi, /https?:\/\/api\.lever\.co\/v0\/postings\/([a-z0-9.-]+)/gi],
      ashby: [/https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9.-]+)/gi, /https?:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9.-]+)/gi],
      personio: [/https?:\/\/([a-z0-9.-]+\.jobs\.personio\.(?:de|com))\/xml/gi, /https?:\/\/([a-z0-9.-]+\.jobs\.personio\.(?:de|com))/gi],
    };
    return patterns[this.family];
  }

  private safeTenant(value: string): string | null {
    const tenant = value.trim().toLowerCase();
    return tenant && safePublicHostOrSlug(tenant) ? tenant : null;
  }
}
