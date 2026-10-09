import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

import { RESUME_STATUSES, ResumeStatus } from '../schemas/resume.schema';
import { RESUME_ADAPTATION_STATUSES, ResumeAdaptationStatus } from '../schemas/resume-adaptation.schema';

export class CreateResumeDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  profileId?: string;

  @IsOptional()
  @IsObject()
  documentJson?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  markdownCache?: string;

  @IsOptional()
  @IsString()
  sourceFileId?: string;
}

export class UpdateResumeDto {
  @IsNumber()
  @Min(1)
  revision!: number;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  profileId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsObject()
  documentJson?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  markdownCache?: string;

  @IsOptional()
  @IsIn(RESUME_STATUSES)
  status?: ResumeStatus;
}

export class CreateResumeAdaptationDto {
  @IsString()
  baseResumeId!: string;

  @IsString()
  profileId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  customPrompt?: string;
}

export class UpdateResumeAdaptationDto {
  @IsNumber()
  @Min(1)
  revision!: number;

  @IsOptional()
  @IsObject()
  documentJson?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  markdownCache?: string;

  @IsOptional()
  @IsIn(RESUME_ADAPTATION_STATUSES)
  status?: ResumeAdaptationStatus;
}

export class RevisionDto {
  @IsNumber()
  @Min(1)
  revision!: number;
}

export class ExportResumeDto {
  @IsIn(['pdf', 'docx', 'txt'])
  format!: 'pdf' | 'docx' | 'txt';

  @IsOptional()
  @IsInt()
  @Min(1)
  revision?: number;
}

export class UndoResumeReorderDto {
  @IsNumber()
  @Min(1)
  revision!: number;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  order!: string[];
}
