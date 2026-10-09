import { OpportunityType, SourceStatus } from '../../opportunities/schemas/opportunity.schema';

export const SOURCES_JOBS_SERVICE = Symbol('SOURCES_JOBS_SERVICE');
export const SOURCES_REALTIME_SERVICE = Symbol('SOURCES_REALTIME_SERVICE');
export const OPPORTUNITIES_INGEST_SERVICE = Symbol('OPPORTUNITIES_INGEST_SERVICE');

export type JobsServiceLike = {
  queue(name: string): {
    add(
      name: string,
      data: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<{ id?: string }>;
    upsertJobScheduler(
      id: string,
      repeatOptions: { every: number },
      jobTemplate: { name: string; data: Record<string, unknown>; opts?: Record<string, unknown> },
    ): Promise<unknown>;
    getJobSchedulers(start?: number, end?: number, asc?: boolean): Promise<Array<{ key: string }>>;
    removeJobScheduler(id: string): Promise<boolean>;
    getJobs?(
      types?: string[],
      start?: number,
      end?: number,
      asc?: boolean,
    ): Promise<Array<{ id?: string; name?: string; data?: Record<string, unknown> }>>;
  };
  enqueue(
    queue: string,
    name: string,
    data: Record<string, unknown>,
    options?: { jobId?: string; delay?: number },
  ): Promise<{ id: string; queue: string }>;
  registerHandler(
    queue: string,
    name: string,
    handler: (data: Record<string, unknown>, job?: unknown) => Promise<unknown>,
  ): void;
};

export type RealtimeServiceLike = {
  publish(userId: string, type: string, payload: Record<string, unknown>): void;
};

export type NormalizedSourceOccurrenceInput = {
  sourceId: string;
  externalId: string;
  url: string;
  primary: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  publishedAt?: Date;
  checksum?: string;
  status: SourceStatus;
  rawPayload: Record<string, unknown>;
  sourceMetadata: Record<string, unknown>;
};

export type NormalizedOpportunityInput = {
  type: OpportunityType;
  title: string;
  companyOrClient: string;
  description: string;
  language?: string;
  skills: string[];
  technologies: string[];
  seniority?: string;
  employmentType?: string;
  location?: string;
  remoteType?: string;
  money: Record<string, unknown>;
  deadline?: Date;
  publishedAt?: Date;
  sourceStatus: SourceStatus;
  sourceOccurrences: NormalizedSourceOccurrenceInput[];
  canonicalTags: string[];
  vacancyData: Record<string, unknown>;
  freelanceData: Record<string, unknown>;
  tenderData: Record<string, unknown>;
  fingerprint: string;
};

export type IngestBatchInput = {
  sourceId: string;
  runId: string;
  effectMode?: 'fresh' | 'historical';
  records: NormalizedOpportunityInput[];
};

export type MarkSourceOccurrenceRemovedInput = {
  opportunityId: string;
  sourceId: string;
  externalId: string;
  url: string;
  observedAt: Date | string;
  reason: string;
  runId: string;
};

export type MarkSourceOccurrenceRemovedResult = {
  opportunityId: string;
  sourceStatus: SourceStatus;
};

export type IngestRecordFailure = {
  index: number;
  externalId?: string;
  url?: string;
  title?: string;
  code?: string;
  reason: string;
  transient: boolean;
};

export type IngestBatchResult = {
  seen: number;
  normalized: number;
  upserted: number;
  created: number;
  updated: number;
  duplicates: number;
  failed: number;
  opportunityIds: string[];
  failures: IngestRecordFailure[];
};

export type OpportunitiesIngestServiceLike = {
  ingestFromSource(input: IngestBatchInput): Promise<IngestBatchResult>;
  markSourceOccurrenceRemoved?(input: MarkSourceOccurrenceRemovedInput): Promise<MarkSourceOccurrenceRemovedResult>;
};
