import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

import { SOURCE_RUNTIME_STATES, SourceRuntimeState } from '../catalog/source-catalog.types';
import { SOURCE_RUN_STATUSES, SourceRunStatus } from '../schemas/source-run.schema';

export class ListSourcesDto {
  @IsOptional()
  @IsString()
  group?: string;

  @IsOptional()
  @IsString()
  connectorFamily?: string;

  @IsOptional()
  @IsString()
  healthState?: string;

  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class UpdateSourceDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(SOURCE_RUNTIME_STATES)
  runtimeState?: SourceRuntimeState;

  @IsOptional()
  @IsInt()
  @Min(30)
  intervalSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  timeoutMs?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tenants?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  discoveryHosts?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  discoveryUrls?: string[];

  @IsOptional()
  @IsString()
  searchText?: string;

  @IsOptional()
  @IsString()
  area?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perPage?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxPages?: number;

  @IsOptional()
  @IsBoolean()
  proxyPoolEnabled?: boolean;

  @IsOptional()
  @IsObject()
  credentials?: Record<string, unknown>;
}

export class RunSourceDto {
  @IsOptional()
  @IsString()
  runType?: 'manual' | 'scheduled' | 'backfill' | 'health';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  backfillDays?: number;
}

export class RefreshSourceDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  opportunityIds?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ListRunsDto {
  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsIn(SOURCE_RUN_STATUSES)
  status?: SourceRunStatus;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
