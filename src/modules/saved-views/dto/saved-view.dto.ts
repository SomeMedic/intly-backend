import { IsArray, IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpsertSavedViewDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsString()
  @MaxLength(80)
  scope!: string;

  @IsOptional()
  @IsObject()
  query?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  sort?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  mode?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  visibleFields?: string[];

  @IsOptional()
  @IsObject()
  columnState?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class UpdateSavedViewDto extends UpsertSavedViewDto {
  @IsOptional()
  declare name: string;

  @IsOptional()
  declare scope: string;
}
