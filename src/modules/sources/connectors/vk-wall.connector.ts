import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { firstTextLine, numberValue, stringValue } from './connector-utils';

export class VkWallConnector implements Connector {
  readonly id = 'vk-wall';
  readonly family = 'VkWall' as const;

  capabilities(): ConnectorCapabilities {
    return {
      supportsBackfill: true,
      supportsIncremental: true,
      supportsRefresh: true,
      requiresCredentials: true,
      maxBackfillDays: 30,
    };
  }

  async validateConfig(config: Record<string, unknown>): Promise<ValidationResult> {
    if (!stringValue(config.domain)) return { ok: false, message: 'VK domain is required' };
    if (!this.token(config.credentials as Record<string, unknown> | undefined)) return { ok: false, message: 'VK access token is required' };
    return { ok: true, message: 'VK token present' };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const validation = await this.validateConfig({ ...ctx.source.endpoint, credentials: ctx.credentials });
    if (!validation.ok) return { state: 'Failed', message: validation.message, checkedAt: new Date() };
    try {
      const group = await this.resolveGroup(String(ctx.source.endpoint.domain), this.token(ctx.credentials)!);
      return { state: 'Healthy', message: `Resolved VK group ${group.id}`, checkedAt: new Date(), details: group };
    } catch (error) {
      return { state: 'Failed', message: error instanceof Error ? error.message : 'VK group resolution failed', checkedAt: new Date() };
    }
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const domain = stringValue(ctx.source.endpoint?.domain);
    const token = this.token(ctx.credentials);
    if (!domain) throw new Error('VK domain is required');
    if (!token) throw new Error('VK access token is required');
    const group = await this.resolveGroup(domain, token);
    const posts = await this.fetchWall(group.id, token, Math.min(numberValue(ctx.source.limits?.perPage) ?? 50, 100));
    const cutoff = Date.now() - Math.min(ctx.backfillDays, 30) * 86_400_000;
    const lastPostId = numberValue(ctx.checkpoint.lastPostId) ?? 0;
    const filtered = posts
      .filter((post) => post.id > lastPostId && post.date.getTime() >= cutoff)
      .sort((left, right) => left.id - right.id);
    const records = filtered.map<RawOpportunityRecord>((post) => ({
      externalId: `${group.id}:${post.id}`,
      url: `https://vk.com/wall-${group.id}_${post.id}`,
      type: post.text.toLowerCase().includes('вакан') ? 'vacancy' : 'freelance',
      title: firstTextLine(post.text, `${ctx.source.name} post ${post.id}`),
      companyOrClient: ctx.source.name,
      description: post.text,
      publishedAt: post.date,
      sourceStatus: 'Unknown',
      rawPayload: post.raw,
      sourceMetadata: { domain, groupId: group.id, postId: post.id, links: this.extractLinks(post.text) },
    }));
    return {
      records,
      checkpoint: {
        ownerId: -group.id,
        lastPostId: filtered.at(-1)?.id ?? lastPostId,
        lastFetchedAt: new Date().toISOString(),
      },
      hasMore: false,
      stats: { seen: records.length },
    };
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private token(input?: Record<string, unknown>): string | undefined {
    return stringValue(input?.accessToken ?? process.env.VK_API_TOKEN);
  }

  private async resolveGroup(domain: string, token: string): Promise<{ id: number; name?: string }> {
    const url = new URL('https://api.vk.com/method/groups.getById');
    url.searchParams.set('group_id', domain);
    url.searchParams.set('access_token', token);
    url.searchParams.set('v', '5.199');
    const payload = await this.fetchVk(url);
    const groups = Array.isArray(payload.response) ? payload.response : payload.response?.groups;
    const group = Array.isArray(groups) ? groups[0] : undefined;
    const id = numberValue(group?.id);
    if (!id) throw new Error(`VK group ${domain} did not resolve`);
    return { id, name: stringValue(group.name) };
  }

  private async fetchWall(groupId: number, token: string, count: number): Promise<Array<{ id: number; text: string; date: Date; raw: Record<string, unknown> }>> {
    const url = new URL('https://api.vk.com/method/wall.get');
    url.searchParams.set('owner_id', String(-groupId));
    url.searchParams.set('count', String(count));
    url.searchParams.set('access_token', token);
    url.searchParams.set('v', '5.199');
    const payload = await this.fetchVk(url);
    const items = Array.isArray(payload.response?.items) ? payload.response.items : [];
    return items.map((raw: Record<string, unknown>) => ({
      id: numberValue(raw.id) ?? 0,
      text: stringValue(raw.text) ?? '',
      date: new Date((numberValue(raw.date) ?? Math.floor(Date.now() / 1000)) * 1000),
      raw,
    }));
  }

  private async fetchVk(url: URL): Promise<Record<string, any>> {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const payload = (await response.json()) as Record<string, any>;
    if (payload.error) {
      const code = numberValue(payload.error.error_code);
      const message = stringValue(payload.error.error_msg) ?? 'VK API error';
      if (code === 6) throw new ConnectorRateLimitError(message, 3);
      throw new Error(message);
    }
    if (!response.ok) throw new Error(`VK API returned ${response.status}`);
    return payload;
  }

  private extractLinks(text: string): string[] {
    return Array.from(text.matchAll(/https?:\/\/\S+/g)).map((match) => match[0].replace(/[),.;]+$/, ''));
  }
}
