import { Connector, ConnectorCapabilities, ConnectorHealth, FetchContext, FetchPage, ValidationResult } from './connector.types';
import { ConnectorFamily } from '../catalog/source-catalog.types';

export class UnavailableConnector implements Connector {
  readonly id: string;
  readonly family: ConnectorFamily;

  constructor(input: { id: string; family: ConnectorFamily; reason: string; requiresCredentials?: boolean }) {
    this.id = input.id;
    this.family = input.family;
    this.reason = input.reason;
    this.requiresCredentials = input.requiresCredentials ?? false;
  }

  private readonly reason: string;
  private readonly requiresCredentials: boolean;

  capabilities(): ConnectorCapabilities {
    return {
      supportsBackfill: false,
      supportsIncremental: false,
      supportsRefresh: false,
      requiresCredentials: this.requiresCredentials,
      maxBackfillDays: 0,
    };
  }

  async validateConfig(): Promise<ValidationResult> {
    return { ok: false, message: this.reason };
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return { state: 'Disabled', message: this.reason, checkedAt: new Date() };
  }

  async fetchPage(_ctx: FetchContext): Promise<FetchPage> {
    throw new Error(this.reason);
  }

  checkpoint(): Record<string, unknown> {
    return {};
  }
}
