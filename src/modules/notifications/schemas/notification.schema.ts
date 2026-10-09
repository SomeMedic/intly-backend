import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type NotificationDocument = HydratedDocument<Notification>;

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'telegram', 'webhook'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CATEGORIES = ['opportunity', 'ai', 'workflow', 'collaboration', 'system', 'admin'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

@Schema({ ...schemaOptions, collection: 'notifications' })
export class Notification {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: String, default: '' })
  body!: string;

  @Prop({ type: String, required: true, index: true })
  type!: string;

  @Prop({ type: String })
  idempotencyKey?: string;

  @Prop({ type: String, enum: NOTIFICATION_CATEGORIES, default: 'system', index: true })
  category!: NotificationCategory;

  @Prop({ type: Object, default: {} })
  data!: Record<string, unknown>;

  @Prop({ type: Date, index: true })
  readAt?: Date;

  @Prop({ type: [Object], default: [] })
  deliveries!: Array<{
    channel: NotificationChannel;
    status: 'queued' | 'sent' | 'failed' | 'skipped';
    attemptedAt?: Date;
    reason?: string;
    dispatchAt?: Date;
    digestKey?: string;
    mode?: 'instant' | 'daily' | 'weekly';
  }>;

  @Prop({ type: Boolean, default: true, index: true })
  visibleInApp!: boolean;

  @Prop({ type: Date, index: true })
  archivedAt?: Date;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, type: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, category: 1, archivedAt: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
