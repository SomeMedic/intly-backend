import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBase64,
  IsIn,
  IsInt,
  IsMimeType,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  KNOWLEDGE_DOCUMENT_TYPES,
  KNOWLEDGE_MODES,
  KNOWLEDGE_STATUSES,
  KnowledgeDocumentType,
  KnowledgeMode,
  KnowledgeStatus,
} from '../schemas/knowledge-document.schema';

export class CreateKnowledgeDocumentDto {
  @IsString()
  @MaxLength(300)
  title!: string;

  @IsIn(KNOWLEDGE_DOCUMENT_TYPES)
  type!: KnowledgeDocumentType;

  @IsOptional()
  @IsIn(KNOWLEDGE_MODES)
  mode?: KnowledgeMode;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  profileIds?: string[];

  @IsString()
  @MaxLength(300)
  filename!: string;

  @IsMimeType()
  mimeType!: string;

  @IsBase64()
  contentBase64!: string;
}

export class CreateKnowledgeMultipartDocumentDto {
  @IsString()
  @MaxLength(300)
  title!: string;

  @IsIn(KNOWLEDGE_DOCUMENT_TYPES)
  type!: KnowledgeDocumentType;

  @IsOptional()
  @IsIn(KNOWLEDGE_MODES)
  mode?: KnowledgeMode;

  @IsOptional()
  @IsString()
  profileIds?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  filename?: string;

  @IsOptional()
  @IsMimeType()
  mimeType?: string;
}

export class UpdateKnowledgeDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_DOCUMENT_TYPES)
  type?: KnowledgeDocumentType;

  @IsOptional()
  @IsIn(KNOWLEDGE_MODES)
  mode?: KnowledgeMode;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  profileIds?: string[];
}

export class KnowledgeDocumentListQueryDto {
  @IsOptional()
  @IsIn(KNOWLEDGE_DOCUMENT_TYPES)
  type?: KnowledgeDocumentType;

  @IsOptional()
  @IsIn(KNOWLEDGE_MODES)
  mode?: KnowledgeMode;

  @IsOptional()
  @IsIn(KNOWLEDGE_STATUSES)
  status?: KnowledgeStatus;

  @IsOptional()
  @IsUUID()
  profileId?: string;

  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class KnowledgeSearchDto {
  @IsString()
  @MaxLength(1000)
  query!: string;

  @IsOptional()
  @IsUUID()
  profileId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  topK?: number;
}
