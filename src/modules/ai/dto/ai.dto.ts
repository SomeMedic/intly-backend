import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, IsUrl, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { AI_PROVIDERS, AI_TASK_TYPES, AiProvider, AiTaskType } from '../schemas/ai-config.schema';
import type { AiUsageFilters } from '../ai-usage';

export class AdminAiUsageQueryDto implements AiUsageFilters {
  @IsOptional()
  @IsISO8601({ strict: true })
  dateFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  dateTo?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsIn(AI_PROVIDERS)
  provider?: AiProvider;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  modelId?: string;

  @IsOptional()
  @IsIn(AI_TASK_TYPES)
  taskType?: AiTaskType;

  @IsOptional()
  @IsIn(['completed', 'failed', 'cancelled'])
  status?: 'completed' | 'failed' | 'cancelled';
}

export class RunOpportunityAnalysisDto {
  @IsString()
  opportunityId!: string;

  @IsString()
  profileId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  customPrompt?: string;
}

export class AiRunFeedbackDto {
  @IsIn(['positive', 'negative'])
  value!: 'positive' | 'negative';

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class AdminProviderPatchDto {
  @IsIn(AI_PROVIDERS)
  provider!: AiProvider;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AdminAiModelPriceDto)
  pricing?: AdminAiModelPriceDto[];
}

export class AdminAiModelPriceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  modelId!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  inputPerMillion!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  outputPerMillion!: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  cachedInputPerMillion?: number;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(1000)
  sourceUrl?: string;
}

export class AdminTaskRoutePatchDto {
  @IsIn(AI_TASK_TYPES)
  taskType!: AiTaskType;

  @IsIn(AI_PROVIDERS)
  primaryProvider!: AiProvider;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  primaryModel!: string;

  @IsOptional()
  @IsIn(AI_PROVIDERS)
  fallbackProvider?: AiProvider | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  fallbackModel?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  retryCount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxOutputTokens?: number;
}

export class AdminAiProviderTestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  modelId!: string;
}

export class AdminPromptPatchDto {
  @IsIn(AI_TASK_TYPES)
  taskType!: AiTaskType;

  @IsString()
  @MaxLength(20000)
  systemCore!: string;

  @IsString()
  @MaxLength(20000)
  taskInstructions!: string;

  @IsOptional()
  @IsString()
  versionLabel?: string;
}

export class AdminAiTestDto {
  @IsIn(AI_TASK_TYPES)
  taskType!: AiTaskType;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}
