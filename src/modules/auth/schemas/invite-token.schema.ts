import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type InviteTokenDocument = HydratedDocument<InviteToken>;

@Schema(schemaOptions)
export class InviteToken {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, unique: true, index: true })
  tokenHash!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date })
  usedAt?: Date;

  @Prop({ type: String, required: true })
  createdByUserId!: string;
}

export const InviteTokenSchema = SchemaFactory.createForClass(InviteToken);

InviteTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
InviteTokenSchema.index({ userId: 1, usedAt: 1 });
