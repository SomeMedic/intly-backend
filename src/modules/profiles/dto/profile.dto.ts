import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { DEFAULT_MATCH_WEIGHTS, PROFILE_KINDS, ProfileKind } from '../schemas/profile.schema';

export class MatchWeightsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  skills?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  seniority?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  money?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  remoteLocation?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  employment?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  freshness?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  source?: number;
}

export class UpsertProfileDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsIn(PROFILE_KINDS)
  kind?: ProfileKind;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  targetRoles?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  seniority?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  technologies?: string[];

  @IsOptional()
  @IsObject()
  compensationPreferences?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  locations?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  remotePreferences?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  employmentTypes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sourceIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => MatchWeightsDto)
  matchWeights?: MatchWeightsDto;

  @IsOptional()
  @IsObject()
  aiPreferences?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  structuredExperienceSummary?: string;
}

export class UpdateProfileDto extends UpsertProfileDto {
  @IsOptional()
  declare name: string;
}

export class ProfileListQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class ProfileResponseDto {
  id!: string;
  userId!: string;
  name!: string;
  kind!: ProfileKind;
  isActive!: boolean;
  targetRoles!: string[];
  seniority!: string[];
  technologies!: string[];
  compensationPreferences!: Record<string, unknown>;
  locations!: string[];
  remotePreferences!: string[];
  employmentTypes!: string[];
  sourceIds!: string[];
  matchWeights!: typeof DEFAULT_MATCH_WEIGHTS;
  aiPreferences!: Record<string, unknown>;
  structuredExperienceSummary!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
