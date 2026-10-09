import { IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { RESPONSE_FORMATS, RESPONSE_STATUSES, ResponseFormat, ResponseStatus } from '../schemas/response-draft.schema';

export class CreateResponseDraftDto {
  @IsString()
  opportunityId!: string;

  @IsString()
  profileId!: string;

  @IsIn(RESPONSE_FORMATS)
  format!: ResponseFormat;

  @IsOptional()
  @IsObject()
  documentJson?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  markdownCache?: string;
}

export class UpdateResponseDraftDto {
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
  @IsObject()
  proposedCommercialFields?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  checklist?: Record<string, unknown>;
}

export class SetResponseStatusDto {
  @IsNumber()
  @Min(1)
  revision!: number;

  @IsIn(RESPONSE_STATUSES)
  status!: ResponseStatus;

  @IsOptional()
  @IsBoolean()
  confirmedExternalSubmission?: boolean;
}

export class GenerateResponseDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  revision?: number;

  @IsOptional()
  @IsArray()
  pinnedFacts?: Array<Record<string, unknown>>;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  customPrompt?: string;
}

export class ExportResponseDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  revision?: number;

  @IsIn(['pdf', 'docx', 'txt'])
  format!: 'pdf' | 'docx' | 'txt';
}

export class TransformResponseSelectionDto {
  @IsNumber()
  @Min(1)
  revision!: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  tool?: string;

  @IsOptional()
  @IsObject()
  target?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  selection?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  documentContext?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  pinnedFacts?: Array<Record<string, unknown>>;

  @IsString()
  @MaxLength(4000)
  instruction!: string;
}
