import { OpportunityType, SourceStatus } from '../../opportunities/schemas/opportunity.schema';
import { ConnectorFamily } from '../catalog/source-catalog.types';
import { Source } from '../schemas/source.schema';

export type ConnectorCapabilities = {
  supportsBackfill: boolean;
  supportsIncremental: boolean;
  supportsRefresh: boolean;
  requiresCredentials: boolean;
  maxBackfillDays: number;
};

export type ValidationResult = {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
};

export type ConnectorHealth = {
  state: 'Healthy' | 'Degraded' | 'Failed' | 'Disabled' | 'Unknown';
  message?: string;
  checkedAt: Date;
  details?: Record<string, unknown>;
};

export class ConnectorRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}

export type ConnectorCheckpoint = Record<string, unknown>;

export type ConnectorContext = {
  source: Source;
  requestId: string;
  signal?: AbortSignal;
  credentials?: Record<string, unknown>;
};

export type FetchContext = ConnectorContext & {
  checkpoint: ConnectorCheckpoint;
  backfillDays: number;
  backfillSince?: string;
  page?: number;
};

export type RawOpportunityRecord = {
  externalId: string;
  url: string;
  type: OpportunityType;
  title: string;
  companyOrClient?: string;
  description?: string;
  publishedAt?: Date;
  updatedAt?: Date;
  sourceStatus: SourceStatus;
  rawPayload: Record<string, unknown>;
  sourceMetadata: Record<string, unknown>;
};

export type FetchPage<TRaw = RawOpportunityRecord> = {
  records: TRaw[];
  checkpoint: ConnectorCheckpoint;
  hasMore: boolean;
  nextPage?: number;
  stats: {
    seen: number;
  };
};

export type RefreshResult<TRaw = RawOpportunityRecord> = {
  record: TRaw | null;
  checkpoint?: ConnectorCheckpoint;
};

export interface Connector<TConfig = Record<string, unknown>, TRaw = RawOpportunityRecord> {
  readonly id: string;
  readonly family: ConnectorFamily;
  capabilities(): ConnectorCapabilities;
  validateConfig(config: TConfig): Promise<ValidationResult>;
  healthCheck(ctx: ConnectorContext): Promise<ConnectorHealth>;
  discover?(ctx: ConnectorContext): Promise<ValidationResult>;
  fetchPage(ctx: FetchContext): Promise<FetchPage<TRaw>>;
  fetchById?(externalId: string, ctx: FetchContext): Promise<TRaw | null>;
  refresh?(occurrence: Record<string, unknown>, ctx: FetchContext): Promise<RefreshResult<TRaw>>;
  checkpoint(result: FetchPage<TRaw>): ConnectorCheckpoint;
}
