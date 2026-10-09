import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type ResponseDraftDocument = HydratedDocument<ResponseDraft>;

export const RESPONSE_STATUSES = ['draft', 'ready', 'sent', 'submitted'] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export const RESPONSE_FORMATS = [
  'short_response',
  'full_response',
  'cover_letter',
  'telegram_chat',
  'why_good_fit',
  'short_proposal',
  'full_proposal',
  'chat_message',
  'commercial_proposal',
  'application_draft',
  'checklist_text',
] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

export type ResponsePipelineHandoffStatus = 'pending' | 'synced' | 'error';

export type ResponsePipelineHandoff = {
  id: string;
  status: ResponsePipelineHandoffStatus;
  targetPipelineStatus: string;
  responseStatus: ResponseStatus;
  draftId: string;
  format: ResponseFormat;
  sentAt: string;
  createdAt: string;
  updatedAt: string;
  syncedAt?: string;
  error?: string;
};

@Schema({ ...schemaOptions, collection: 'responses' })
export class ResponseDraft {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  profileId!: string;

  @Prop({ type: String, required: true, index: true })
  opportunityId!: string;

  @Prop({ type: String, enum: ['vacancy', 'freelance', 'tender'], required: true, index: true })
  opportunityType!: string;

  @Prop({ type: String, enum: RESPONSE_FORMATS, required: true, index: true })
  format!: ResponseFormat;

  @Prop({ type: Number, default: 1, min: 1 })
  revision!: number;

  @Prop({ type: Object, default: { type: 'doc', content: [] } })
  documentJson!: Record<string, unknown>;

  @Prop({ type: String })
  markdownCache?: string;

  @Prop({ type: String, enum: RESPONSE_STATUSES, default: 'draft', index: true })
  status!: ResponseStatus;

  @Prop({ type: Object, default: {} })
  proposedCommercialFields!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  checklist!: Record<string, unknown>;

  @Prop({ type: [String], default: [] })
  unresolvedPlaceholders!: string[];

  @Prop({ type: Object, default: {} })
  generation!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  pipelineHandoff!: Partial<ResponsePipelineHandoff>;

  @Prop({ type: Date })
  sentAt?: Date;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const ResponseDraftSchema = SchemaFactory.createForClass(ResponseDraft);

ResponseDraftSchema.index(
  { userId: 1, opportunityId: 1, profileId: 1, format: 1 },
  { unique: true, partialFilterExpression: { deletedAt: { $exists: false } } },
);
ResponseDraftSchema.index({ userId: 1, updatedAt: -1 });
