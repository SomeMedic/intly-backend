import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

import { OPPORTUNITY_TYPES, OpportunityType } from '../../opportunities/schemas/opportunity.schema';
import { PIPELINE_STATUSES, PipelineStatus } from '../../opportunities/schemas/opportunity-user-state.schema';

const toArray = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
};

const toNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return Number(value);
};

export const PIPELINE_ATTENTION_FILTERS = ['all', 'needs_attention', 'overdue', 'follow_up_due', 'deadline_urgent'] as const;
export const PIPELINE_SORTS = ['recommended', 'freshness', 'score', 'deadline'] as const;

export class PipelineQueryDto {
  @IsOptional()
  @IsIn(OPPORTUNITY_TYPES)
  type?: OpportunityType;

  @IsOptional()
  @IsUUID()
  profileId?: string;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  sourceIds?: string[];

  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsNumber()
  @Min(0)
  @Max(100)
  minMatch?: number;

  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsNumber()
  @Min(0)
  @Max(100)
  minAiScore?: number;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  tags?: string[];

  @IsOptional()
  @IsDateString({ strict: true })
  dateFrom?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  dateTo?: string;

  @IsOptional()
  @IsIn(PIPELINE_ATTENTION_FILTERS)
  attention?: (typeof PIPELINE_ATTENTION_FILTERS)[number];

  @IsOptional()
  @IsString()
  counterpart?: string;

  @IsOptional()
  @IsIn(PIPELINE_SORTS)
  sort?: (typeof PIPELINE_SORTS)[number];
}

export class UpdatePipelineDto {
  @IsUUID()
  profileId!: string;

  @IsIn(PIPELINE_STATUSES)
  pipelineStatus!: PipelineStatus;
}
