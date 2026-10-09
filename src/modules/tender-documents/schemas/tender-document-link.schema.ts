import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type TenderDocumentLinkDocument = HydratedDocument<TenderDocumentLink>;
export const TENDER_DOCUMENT_AI_STATUSES = ['Not analyzed', 'Queued', 'Running', 'Completed', 'Failed', 'Cancelled'] as const;
export type TenderDocumentAiStatus = (typeof TENDER_DOCUMENT_AI_STATUSES)[number];

@Schema(schemaOptions)
export class TenderDocumentLink {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  opportunityId!: string;

  @Prop({ type: String, required: true, index: true })
  profileId!: string;

  @Prop({ type: String, required: true, index: true })
  knowledgeDocumentId!: string;

  @Prop({ type: String, required: true, index: true })
  fileId!: string;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: String, default: 'other', index: true })
  documentType!: string;

  @Prop({ type: String, enum: TENDER_DOCUMENT_AI_STATUSES, default: 'Not analyzed', index: true })
  aiStatus!: TenderDocumentAiStatus;

  @Prop({ type: String })
  aiRunId?: string;

  @Prop({ type: String, index: true })
  sourceId?: string;

  @Prop({ type: String, index: true })
  sourceUrl?: string;

  @Prop({ type: String })
  sourceFilename?: string;

  @Prop({ type: String })
  sourceMimeType?: string;

  @Prop({ type: Number })
  sourceSize?: number;

  @Prop({ type: Date })
  sourceImportedAt?: Date;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const TenderDocumentLinkSchema = SchemaFactory.createForClass(TenderDocumentLink);

TenderDocumentLinkSchema.index({ userId: 1, opportunityId: 1, profileId: 1, deletedAt: 1, updatedAt: -1 });
TenderDocumentLinkSchema.index({ knowledgeDocumentId: 1, deletedAt: 1 });
TenderDocumentLinkSchema.index({ fileId: 1, deletedAt: 1 });
TenderDocumentLinkSchema.index(
  { userId: 1, opportunityId: 1, profileId: 1, sourceId: 1, sourceUrl: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sourceId: { $exists: true },
      sourceUrl: { $exists: true },
      deletedAt: { $exists: false },
    },
  },
);
