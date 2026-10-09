import { IsBase64, IsIn, IsInt, IsMimeType, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';

import { FILE_ASSET_STATUSES, FileAssetStatus } from '../schemas/file-asset.schema';

export class CreateFileDto {
  @IsString()
  @MaxLength(300)
  filename!: string;

  @IsMimeType()
  mimeType!: string;

  @IsBase64()
  contentBase64!: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CreateMultipartFileDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  filename?: string;

  @IsOptional()
  @IsMimeType()
  mimeType?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null ? parsed : value;
    } catch { return value; }
  })
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class FileListQueryDto {
  @IsOptional()
  @IsIn(FILE_ASSET_STATUSES)
  status?: FileAssetStatus;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? Number(value) : value)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
