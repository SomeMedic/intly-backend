import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  ValidateIf,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { OPPORTUNITY_TYPES, OpportunityType, SOURCE_STATUSES, SourceStatus } from '../schemas/opportunity.schema';
import { ISSUE_REPORT_STATUSES, ISSUE_REPORT_TYPES, IssueReportStatus, IssueReportType } from '../schemas/issue-report.schema';
import { PIPELINE_STATUSES, PipelineStatus } from '../schemas/opportunity-user-state.schema';
import { TENDER_APPLICATION_SECTIONS } from '../tender-application-sections';

const toArray = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
};

const toBoolean = (value: unknown): boolean | undefined => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
};

const toNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return Number(value);
};

export const OPPORTUNITY_SORT_FIELDS = [
  'recommended',
  'newest',
  'best-match',
  'highest-pay',
  'deadline',
  'deadline-soon',
  'publishedAt',
  'firstSeenAt',
  'deadlineAt',
  'updatedAt',
  'moneyMax',
  'matchScore',
  'title',
  'sourceStatus',
  'highestAI',
] as const;
export type OpportunitySortField = (typeof OPPORTUNITY_SORT_FIELDS)[number];

export class MoneyDto {
  @IsOptional()
  @IsString()
  originalText?: string;

  @IsOptional()
  @IsNumber()
  min?: number;

  @IsOptional()
  @IsNumber()
  max?: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  period?: string;

  @IsOptional()
  @IsString()
  kind?: string;
}

export class ManualOpportunityDto {
  @IsIn(OPPORTUNITY_TYPES)
  type!: OpportunityType;

  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  companyOrClient?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  technologies?: string[];

  @IsOptional()
  @IsString()
  seniority?: string;

  @IsOptional()
  @IsString()
  employmentType?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  remoteType?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MoneyDto)
  money?: MoneyDto;

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @IsDateString()
  publishedAt?: string;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  externalId?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @IsOptional()
  @IsArray()
  @IsIn(TENDER_APPLICATION_SECTIONS, { each: true })
  requiredApplicationSections?: string[];

  @IsOptional()
  @IsObject()
  rawPayload?: Record<string, unknown>;
}

export class ImportUrlDto {
  @IsString()
  @IsUrl({ require_tld: false })
  url!: string;

  @IsOptional()
  @IsIn(OPPORTUNITY_TYPES)
  type?: OpportunityType;

  @IsOptional()
  @IsString()
  @IsUUID()
  profileId?: string;
}

export class OpportunitySortDto {
  @IsIn(OPPORTUNITY_SORT_FIELDS)
  field!: OpportunitySortField;

  @IsIn(['asc', 'desc'])
  direction!: 'asc' | 'desc';
}

export class OpportunityListQueryDto {
  @IsOptional()
  @IsIn(OPPORTUNITY_TYPES)
  type?: OpportunityType;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsIn(OPPORTUNITY_TYPES, { each: true })
  types?: OpportunityType[];

  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  @IsUUID()
  profileId?: string;

  @IsOptional()
  @IsString()
  @IsUUID()
  viewId?: string;

  @IsOptional()
  @IsString()
  @IsUUID()
  savedViewId?: string;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  sourceIds?: string[];

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  excludeSourceIds?: string[];

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  sourceGroups?: string[];

  @IsOptional()
  @IsString()
  sourceGroup?: string;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  technologies?: string[];

  @IsOptional()
  @IsString()
  seniority?: string;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  employmentTypes?: string[];

  @IsOptional()
  @IsString()
  remoteType?: string;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  locations?: string[];

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  countriesAllowed?: string[];

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  moneyPeriod?: string;

  @IsOptional()
  @IsString()
  moneyKind?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  counterpart?: string;

  @IsOptional()
  @IsIn(['active', 'all'])
  profileScope?: 'active' | 'all';

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  trackedOnly?: boolean;

  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsNumber()
  moneyMin?: number;

  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsNumber()
  moneyMax?: number;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  includeMissingMoney?: boolean;

  @IsOptional()
  @IsDateString()
  publishedFrom?: string;

  @IsOptional()
  @IsDateString()
  publishedTo?: string;

  @IsOptional()
  @IsDateString()
  firstSeenFrom?: string;

  @IsOptional()
  @IsDateString()
  firstSeenTo?: string;

  @IsOptional()
  @IsDateString()
  deadlineFrom?: string;

  @IsOptional()
  @IsDateString()
  deadlineTo?: string;

  @IsOptional()
  @IsDateString()
  updatedFrom?: string;

  @IsOptional()
  @IsDateString()
  updatedTo?: string;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  hasDeadline?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  multipleSources?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  manualOnly?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  importedOnly?: boolean;

  @IsOptional()
  @IsString()
  descriptionContains?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsIn(SOURCE_STATUSES, { each: true })
  status?: SourceStatus[];

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  archive?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  favorite?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  hidden?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  archived?: boolean;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsIn(PIPELINE_STATUSES, { each: true })
  pipelineStatuses?: PipelineStatus[];

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsIn(PIPELINE_STATUSES, { each: true })
  pipelineReachedStatuses?: PipelineStatus[];

  @IsOptional()
  @IsDateString()
  pipelineReachedFrom?: string;

  @IsOptional()
  @IsDateString()
  pipelineReachedTo?: string;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @Min(0)
  @Max(100)
  minMatch?: number;


  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @Min(0)
  @Max(100)
  minAiScore?: number;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  analyzed?: boolean;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  latestAI?: boolean;

  @IsOptional()
  @IsIn(OPPORTUNITY_SORT_FIELDS)
  sort?: OpportunitySortField;

  @IsOptional()
  @ValidateIf((_, value) => Array.isArray(value))
  @ValidateNested({ each: true })
  @Type(() => OpportunitySortDto)
  sorts?: OpportunitySortDto[];

  @IsOptional()
  @IsString()
  advancedSort?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ImportFileDto {
  @IsString()
  @IsUUID()
  fileId!: string;

  @IsOptional()
  @IsIn(OPPORTUNITY_TYPES)
  type?: OpportunityType;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  @IsUUID()
  profileId?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class OpportunityExportDto {
  @IsIn(['csv', 'xlsx', 'json'])
  format!: 'csv' | 'xlsx' | 'json';

  @IsIn(['selected', 'filtered', 'loaded'])
  scope!: 'selected' | 'filtered' | 'loaded';

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  ids?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  loadedIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => OpportunityListQueryDto)
  query?: OpportunityListQueryDto;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  fields?: string[];

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  includePersonalData?: boolean;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  background?: boolean;
}

export class PersonalNoteDto {
  @IsString()
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsDateString()
  createdAt?: string;
}

export class UpdatePersonalStateDto {
  @IsOptional()
  @IsUUID()
  profileId?: string;

  @IsOptional()
  @IsBoolean()
  favorite?: boolean;

  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(PIPELINE_STATUSES)
  pipelineStatus?: PipelineStatus;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PersonalNoteDto)
  notes?: PersonalNoteDto[];
}

export class OpportunityProfileQueryDto {
  @IsOptional()
  @IsUUID()
  profileId?: string;
}

export class ReportIssueDto {
  @IsIn(ISSUE_REPORT_TYPES)
  type!: IssueReportType;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class BulkOpportunityActionDto {
  @IsArray()
  @IsUUID('4', { each: true })
  ids!: string[];

  @IsIn(['favorite', 'hide', 'archive', 'pipeline', 'tags'])
  action!: string;

  @IsObject()
  value!: Record<string, unknown>;
}

export class AdminCorrectionDto {
  @IsIn([
    'title',
    'companyOrClient',
    'description',
    'summary',
    'skills',
    'technologies',
    'seniority',
    'employmentType',
    'location',
    'remoteType',
    'money',
    'deadline',
    'publishedAt',
    'sourceStatus',
    'canonicalTags',
  ])
  field!: string;

  @IsDefined()
  value!: unknown;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class AdminMergeDto {
  @IsString()
  @IsUUID()
  duplicateId!: string;
}

export class ListDuplicateReviewsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  cursor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  query?: string;
}

export class CreateOpportunityCommentDto {
  @IsString()
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  mentionUserIds?: string[];
}


export class ListAdminReportsDto {
  @IsOptional()
  @IsIn(ISSUE_REPORT_STATUSES)
  status?: IssueReportStatus;

  @IsOptional()
  @IsIn(ISSUE_REPORT_TYPES)
  type?: IssueReportType;

  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  @IsOptional()
  @IsString()
  assignedAdminId?: string;

  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => toNumber(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class UpdateAdminReportDto {
  @IsOptional()
  @IsIn(ISSUE_REPORT_STATUSES)
  status?: IssueReportStatus;

  @IsOptional()
  @IsUUID()
  assignedAdminId?: string | null;

  @IsOptional()
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: 'low' | 'normal' | 'high' | 'urgent';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminComment?: string;
}

export class ResolveAdminReportDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  action?: string;
}

export class BulkAdminReportsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids!: string[];

  @IsIn([true])
  confirmed!: true;

  @IsIn(['resolve', 'dismiss'])
  action!: 'resolve' | 'dismiss';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
