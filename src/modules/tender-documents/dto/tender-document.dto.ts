import { IsArray, IsIn, IsMimeType, IsOptional, IsString, IsUrl, IsUUID, MaxLength } from 'class-validator';

export const TENDER_DOCUMENT_TYPES = [
  'notice',
  'technical_specification',
  'draft_contract',
  'participant_requirements',
  'application_form',
  'pricing_estimate',
  'evaluation_criteria',
  'schedule_milestones',
  'security_guarantee',
  'clarifications_amendments',
  'appendix',
  'other',
] as const;
export type TenderDocumentType = (typeof TENDER_DOCUMENT_TYPES)[number];

export class TenderDocumentQueryDto {
  @IsUUID()
  profileId!: string;
}

export class UploadTenderDocumentDto {
  @IsUUID()
  profileId!: string;

  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsIn(TENDER_DOCUMENT_TYPES)
  documentType?: TenderDocumentType;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  filename?: string;

  @IsOptional()
  @IsMimeType()
  mimeType?: string;
}

export class TenderDocumentAnalysisDto {
  @IsUUID()
  profileId!: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  tenderDocumentIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  customPrompt?: string;
}

export class ImportSourceTenderDocumentDto {
  @IsUUID()
  profileId!: string;

  @IsString()
  @MaxLength(100)
  sourceId!: string;

  @IsUrl({ require_protocol: true, protocols: ['http', 'https'], require_tld: false })
  @MaxLength(2000)
  url!: string;

  @IsOptional()
  @IsIn(TENDER_DOCUMENT_TYPES)
  documentType?: TenderDocumentType;
}
