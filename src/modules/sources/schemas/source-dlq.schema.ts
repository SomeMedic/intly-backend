import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type SourceDlqDocument = HydratedDocument<SourceDlq>;

@Schema(schemaOptions)
export class SourceDlq {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  queue!: string;

  @Prop({ type: String, required: true, index: true })
  jobName!: string;

  @Prop({ type: String, required: true, index: true })
  sourceId!: string;

  @Prop({ type: String })
  runId?: string;

  @Prop({ type: Object, default: {} })
  payload!: Record<string, unknown>;

  @Prop({ type: String, required: true })
  error!: string;

  @Prop({ type: String })
  stack?: string;

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  @Prop({ type: String, default: 'Open', index: true })
  status!: 'Open' | 'Replayed' | 'Dismissed' | 'Recovered';

  @Prop({ type: Date })
  recoveredAt?: Date;
}

export const SourceDlqSchema = SchemaFactory.createForClass(SourceDlq);

SourceDlqSchema.index({ sourceId: 1, status: 1, createdAt: -1 });
SourceDlqSchema.index({ queue: 1, jobName: 1, status: 1 });
