import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type OpportunityExportDocument = HydratedDocument<OpportunityExport>;

export const OPPORTUNITY_EXPORT_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type OpportunityExportStatus = (typeof OPPORTUNITY_EXPORT_STATUSES)[number];

@Schema({ ...schemaOptions, collection: 'opportunity_exports' })
export class OpportunityExport {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  requestedByUserId!: string;

  @Prop({ type: String, required: true, enum: OPPORTUNITY_EXPORT_STATUSES, default: 'queued', index: true })
  status!: OpportunityExportStatus;

  @Prop({ type: Number, default: 0 })
  progress!: number;

  @Prop({ type: Object, required: true })
  dto!: Record<string, unknown>;

  @Prop({ type: String })
  jobId?: string;

  @Prop({ type: String })
  fileId?: string;

  @Prop({ type: String })
  filename?: string;

  @Prop({ type: String })
  mimeType?: string;

  @Prop({ type: Number })
  count?: number;

  @Prop({ type: String })
  error?: string;

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Date })
  failedAt?: Date;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const OpportunityExportSchema = SchemaFactory.createForClass(OpportunityExport);

OpportunityExportSchema.index({ userId: 1, createdAt: -1 });
OpportunityExportSchema.index({ status: 1, createdAt: 1 });
