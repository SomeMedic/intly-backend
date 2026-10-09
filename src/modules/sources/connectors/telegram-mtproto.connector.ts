import { Connector, ConnectorCapabilities, ConnectorContext, ConnectorHealth, ConnectorRateLimitError, FetchContext, FetchPage, RawOpportunityRecord, ValidationResult } from './connector.types';
import { firstTextLine, loadRuntimePackage, numberValue, stringValue } from './connector-utils';

type TelegramCredentials = {
  apiId?: number;
  apiHash?: string;
  session?: string;
};

type TelegramClientCtor = new (session: unknown, apiId: number, apiHash: string, options: Record<string, unknown>) => {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getEntity(peer: string): Promise<unknown>;
  invoke(request: unknown): Promise<{ messages?: unknown[] }>;
};

export class TelegramMtprotoConnector implements Connector {
  readonly id = 'telegram-mtproto';
  readonly family = 'TelegramMtproto' as const;

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
    const handle = stringValue(config.handle);
    if (!handle?.startsWith('@')) return { ok: false, message: 'Telegram source handle is required' };
    const credentials = this.credentials(config.credentials as Record<string, unknown> | undefined);
    if (!credentials.apiId || !credentials.apiHash || !credentials.session) {
      return { ok: false, message: 'Telegram apiId, apiHash and encrypted MTProto session are required' };
    }
    return { ok: true, message: 'Telegram MTProto credentials present' };
  }

  async healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth> {
    const validation = await this.validateConfig({ ...ctx.source.endpoint, credentials: ctx.credentials });
    if (!validation.ok) return { state: 'Failed', message: validation.message, checkedAt: new Date() };
    return { state: 'Unknown', message: 'Telegram credentials present; run source check/fetch to resolve channel.', checkedAt: new Date() };
  }

  async fetchPage(ctx: FetchContext): Promise<FetchPage> {
    const handle = stringValue(ctx.source.endpoint?.handle);
    if (!handle) throw new Error('Telegram source handle is required');
    const credentials = this.credentials(ctx.credentials);
    if (!credentials.apiId || !credentials.apiHash || !credentials.session) {
      throw new Error('Telegram apiId, apiHash and session are required');
    }

    const { TelegramClient, Api, StringSession } = await this.loadGramJs();
    const client = new TelegramClient(new StringSession(credentials.session), credentials.apiId, credentials.apiHash, {
      connectionRetries: 3,
    });

    try {
      await client.connect();
      const entity = await client.getEntity(handle);
      const minId = numberValue(ctx.checkpoint.lastMessageId) ?? 0;
      const limit = Math.min(numberValue(ctx.source.limits?.perPage) ?? 100, 100);
      const result = await client.invoke(
        new Api.messages.GetHistory({
          peer: entity,
          minId,
          limit,
          offsetId: 0,
          addOffset: 0,
          maxId: 0,
          hash: BigInt(0),
        }),
      );
      const cutoff = Date.now() - Math.min(ctx.backfillDays, 30) * 86_400_000;
      const messages = (result.messages ?? [])
        .map((message) => this.readMessage(message))
        .filter((message) => message.text && message.date.getTime() >= cutoff)
        .sort((left, right) => left.id - right.id);
      const records = messages.map<RawOpportunityRecord>((message) => ({
        externalId: `${handle}:${message.id}`,
        url: `https://t.me/${handle.replace('@', '')}/${message.id}`,
        type: message.text.toLowerCase().includes('тендер') || message.text.toLowerCase().includes('tender') ? 'tender' : 'vacancy',
        title: firstTextLine(message.text, `${ctx.source.name} message ${message.id}`),
        companyOrClient: ctx.source.name,
        description: message.text,
        publishedAt: message.date,
        updatedAt: message.editDate,
        sourceStatus: 'Unknown',
        rawPayload: message.raw,
        sourceMetadata: {
          handle,
          messageId: message.id,
          editDate: message.editDate?.toISOString(),
          links: this.extractLinks(message.text),
        },
      }));
      return {
        records,
        checkpoint: {
          lastMessageId: messages.at(-1)?.id ?? minId,
          lastFetchedAt: new Date().toISOString(),
        },
        hasMore: false,
        stats: { seen: records.length },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const flood = /FLOOD_WAIT_(\d+)/.exec(message);
      if (flood) throw new ConnectorRateLimitError(message, Number(flood[1]));
      throw error;
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  }

  checkpoint(result: FetchPage): Record<string, unknown> {
    return result.checkpoint;
  }

  private credentials(input?: Record<string, unknown>): TelegramCredentials {
    return {
      apiId: numberValue(input?.apiId),
      apiHash: stringValue(input?.apiHash),
      session: stringValue(input?.session),
    };
  }

  private async loadGramJs(): Promise<{ TelegramClient: TelegramClientCtor; Api: Record<string, any>; StringSession: new (session: string) => unknown }> {
    const telegram = await loadRuntimePackage<Record<string, any>>('teleproto');
    const sessions = await loadRuntimePackage<Record<string, any>>('teleproto/sessions');
    return { TelegramClient: telegram.TelegramClient, Api: telegram.Api, StringSession: sessions.StringSession };
  }

  private readMessage(input: unknown): { id: number; text: string; date: Date; editDate?: Date; raw: Record<string, unknown> } {
    const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const id = numberValue(raw.id) ?? 0;
    const text = stringValue(raw.message) ?? '';
    const dateSeconds = numberValue(raw.date) ?? Math.floor(Date.now() / 1000);
    const editSeconds = numberValue(raw.editDate);
    return {
      id,
      text,
      date: new Date(dateSeconds * 1000),
      editDate: editSeconds ? new Date(editSeconds * 1000) : undefined,
      raw,
    };
  }

  private extractLinks(text: string): string[] {
    return Array.from(text.matchAll(/https?:\/\/\S+/g)).map((match) => match[0].replace(/[),.;]+$/, ''));
  }
}
