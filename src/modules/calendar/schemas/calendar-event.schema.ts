import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type CalendarEventDocument = HydratedDocument<CalendarEvent>;

@Schema(schemaOptions)
export class CalendarEvent {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, index: true })
  opportunityId?: string;

  @Prop({ type: String, index: true })
  taskId?: string;

  @Prop({ type: String, required: true, index: true })
  type!: string;

  @Prop({ type: Date, required: true, index: true })
  startAt!: Date;

  @Prop({ type: Date })
  endAt?: Date;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: Object, default: {} })
  metadata!: Record<string, unknown>;

  @Prop({ type: [Object], default: [] })
  reminders!: Record<string, unknown>[];

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const CalendarEventSchema = SchemaFactory.createForClass(CalendarEvent);

CalendarEventSchema.index({ userId: 1, startAt: 1, _id: 1 });
