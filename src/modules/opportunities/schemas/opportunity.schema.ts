import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type OpportunityDocument = HydratedDocument<Opportunity>;

export const OPPORTUNITY_TYPES = ['vacancy', 'freelance', 'tender'] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const SOURCE_STATUSES = ['Active', 'Closed', 'Expired', 'Removed', 'Unknown'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export type Money = {
  originalText?: string;
  min?: number;
  max?: number;
  currency?: string;
  period?: string;
  kind?: string;
};

export type SourceOccurrence = {
  sourceId: string;
  externalId?: string;
  url: string;
  primary: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  publishedAt?: Date;
  checksum?: string;
  status: SourceStatus;
  rawPayload: Record<string, unknown>;
  sourceMetadata: Record<string, unknown>;
  normalizedSnapshot?: {
    deadline?: Date;
    money?: Money;
    sourceStatus?: SourceStatus;
  };
};

export type AdminCorrection = {
  field: string;
  value: unknown;
  reason?: string;
  correctedBy: string;
  correctedAt: Date;
  pinned: boolean;
};

@Schema(schemaOptions)
export class Opportunity {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, enum: OPPORTUNITY_TYPES, required: true, index: true })
  type!: OpportunityType;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: String, default: '', trim: true })
  companyOrClient!: string;

  @Prop({ type: String, default: '' })
  description!: string;

  @Prop({ type: String })
  summary?: string;

  @Prop({ type: String })
  language?: string;

  @Prop({ type: [String], default: [], index: true })
  skills!: string[];

  @Prop({ type: [String], default: [], index: true })
  technologies!: string[];

  @Prop({ type: String })
  seniority?: string;

  @Prop({ type: String })
  employmentType?: string;

  @Prop({ type: String })
  location?: string;

  @Prop({ type: String, index: true })
  remoteType?: string;

  @Prop({ type: Boolean })
  relocation?: boolean;

  @Prop({ type: [String], default: [] })
  countriesAllowed!: string[];

  @Prop({ type: Object, default: {} })
  money!: Money;

  @Prop({ type: Date, index: true })
  deadline?: Date;

  @Prop({ type: Date, index: true })
  publishedAt?: Date;

  @Prop({ type: Date, required: true, default: Date.now })
  firstSeenAt!: Date;

  @Prop({ type: Date, required: true, default: Date.now })
  lastSeenAt!: Date;

  @Prop({ type: String, enum: SOURCE_STATUSES, default: 'Unknown', index: true })
  sourceStatus!: SourceStatus;

  @Prop({ type: [Object], default: [] })
  sourceOccurrences!: SourceOccurrence[];

  @Prop({ type: Object, default: {} })
  vacancyData!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  freelanceData!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  tenderData!: Record<string, unknown>;

  @Prop({ type: [String], default: [], index: true })
  canonicalTags!: string[];

  @Prop({ type: [Object], default: [] })
  adminCorrections!: AdminCorrection[];

  @Prop({ type: String })
  importedByUserId?: string;

  @Prop({ type: String, index: true })
  mergedIntoOpportunityId?: string;

  @Prop({ type: Date })
  mergedAt?: Date;

  @Prop({ type: [String], default: [], index: true })
  duplicateKeys!: string[];

  @Prop({ type: Number, default: 1, index: true })
  duplicateIndexVersion!: number;

  @Prop({ type: Number })
  privateReferenceRevision?: number;
}

export const OpportunitySchema = SchemaFactory.createForClass(Opportunity);

OpportunitySchema.index({ type: 1, sourceStatus: 1, publishedAt: -1, _id: 1 });
OpportunitySchema.index({ 'sourceOccurrences.sourceId': 1, 'sourceOccurrences.externalId': 1 });
OpportunitySchema.index({ updatedAt: -1 });
OpportunitySchema.index({ duplicateIndexVersion: 1, duplicateKeys: 1, _id: 1 });
OpportunitySchema.index({ type: 1, duplicateKeys: 1, firstSeenAt: 1, _id: 1 });
