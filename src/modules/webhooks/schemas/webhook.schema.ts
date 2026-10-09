import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type WebhookDocument = HydratedDocument<Webhook>;
export type WebhookDeliveryDocument = HydratedDocument<WebhookDelivery>;

export const WEBHOOK_EVENTS = ['opportunity.created', 'opportunity.updated', 'response.submitted', 'resume.ready', 'notification.created', 'test'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

@Schema({ ...schemaOptions, collection: 'webhooks' })
export class Webhook {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, required: true })
  url!: string;

  @Prop({ type: [String], enum: WEBHOOK_EVENTS, default: [] })
  events!: WebhookEvent[];

  @Prop({ type: String, required: true })
  secretEncrypted!: string;

  @Prop({ type: Boolean, default: true, index: true })
  enabled!: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

@Schema({ ...schemaOptions, collection: 'webhook_deliveries' })
export class WebhookDelivery {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  webhookId!: string;

  @Prop({ type: String, required: true, index: true })
  event!: WebhookEvent;

  @Prop({ type: Object, default: {} })
  payload!: Record<string, unknown>;

  @Prop({ type: String, enum: ['queued', 'sent', 'failed'], default: 'queued', index: true })
  status!: 'queued' | 'sent' | 'failed';

  @Prop({ type: Number })
  statusCode?: number;

  @Prop({ type: String })
  errorSummary?: string;

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  @Prop({ type: Date })
  deliveredAt?: Date;
}

export const WebhookSchema = SchemaFactory.createForClass(Webhook);
export const WebhookDeliverySchema = SchemaFactory.createForClass(WebhookDelivery);

WebhookSchema.index({ userId: 1, enabled: 1, createdAt: -1 });
WebhookDeliverySchema.index({ webhookId: 1, createdAt: -1 });
