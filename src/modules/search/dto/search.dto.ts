import { Transform } from 'class-transformer';
import { Equals, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const SEARCH_SCOPES = ['all', 'opportunities', 'tasks', 'profiles', 'watchlists', 'knowledge'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const SEARCH_MODES = ['keyword', 'semantic', 'hybrid'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export class UnifiedSearchDto {
  @IsString()
  @MaxLength(1000)
  query!: string;

  @IsOptional()
  @IsIn(SEARCH_SCOPES)
  scope?: SearchScope;

  @IsOptional()
  @IsIn(SEARCH_MODES)
  mode?: SearchMode;

  @IsOptional()
  @IsUUID()
  profileId?: string;

  @IsOptional()
  @IsArray()
  @IsIn(SEARCH_SCOPES, { each: true })
  scopes?: SearchScope[];

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number;
}

export class RecentSearchQueryDto {
  @IsOptional()
  @IsIn(SEARCH_SCOPES)
  scope?: SearchScope;
}

export class AdminSearchRebuildDto {
  @Equals(true)
  confirmed!: true;
}
