import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AutoAiRulesDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  dailyMax?: number | null;

  @IsOptional()
  @IsBoolean()
  rerunOnMaterialChange?: boolean;
}

export class UpsertWatchlistDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsUUID()
  profileId!: string;

  @IsObject()
  filters!: Record<string, unknown>;

  @IsOptional()
  @Min(0)
  @Max(100)
  matchMin?: number;

  @IsOptional()
  @Min(0)
  @Max(100)
  aiMin?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => AutoAiRulesDto)
  autoAiRules?: AutoAiRulesDto;

  @IsOptional()
  @IsObject()
  notificationPolicy?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  exclusions?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateWatchlistDto extends UpsertWatchlistDto {
  @IsOptional()
  declare name: string;

  @IsOptional()
  declare profileId: string;

  @IsOptional()
  declare filters: Record<string, unknown>;
}

export class WatchlistHitsQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
