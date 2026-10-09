import { Transform } from 'class-transformer';
import { IsBooleanString, IsDateString, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

import { OPPORTUNITY_TYPES, OpportunityType } from '../../opportunities/schemas/opportunity.schema';
import { PIPELINE_STATUSES, PipelineStatus } from '../../opportunities/schemas/opportunity-user-state.schema';

export const ANALYTICS_PERIODS = ['7d', '30d', '90d', 'custom'] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

function csvArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
}

export class AnalyticsQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  profileId?: string;

  @IsOptional()
  @IsIn(OPPORTUNITY_TYPES)
  type?: OpportunityType;

  @IsOptional()
  @Transform(({ value }) => csvArray(value))
  sourceIds?: string[];

  @IsOptional()
  sourceId?: string;

  @IsOptional()
  @IsIn(ANALYTICS_PERIODS)
  period?: AnalyticsPeriod;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsBooleanString()
  includeClosed?: string;


  @IsOptional()
  @Transform(({ value }) => csvArray(value))
  sourceGroups?: string[];

  @IsOptional()
  @Transform(({ value }) => csvArray(value))
  locations?: string[];

  @IsOptional()
  @Transform(({ value }) => csvArray(value))
  countriesAllowed?: string[];

  @IsOptional()
  @Transform(({ value }) => csvArray(value))
  technologies?: string[];

  @IsOptional()
  @IsString()
  seniority?: string;

  @IsOptional()
  @IsString()
  remoteType?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  counterpart?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  moneyPeriod?: string;

  @IsOptional()
  @IsString()
  moneyKind?: string;

  @IsOptional()
  @Transform(({ value }) => csvArray(value))
  @IsIn(PIPELINE_STATUSES, { each: true })
  pipelineReachedStatuses?: PipelineStatus[];

  @IsOptional()
  @IsDateString()
  pipelineReachedFrom?: string;

  @IsOptional()
  @IsDateString()
  pipelineReachedTo?: string;

  @IsOptional()
  @IsBooleanString()
  comparePrevious?: string;

  @IsOptional()
  @IsBooleanString()
  trackedOnly?: string;
}
