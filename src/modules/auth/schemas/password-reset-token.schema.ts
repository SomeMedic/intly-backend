import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type PasswordResetTokenDocument = HydratedDocument<PasswordResetToken>;

@Schema(schemaOptions)
export class PasswordResetToken {
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
}

export const PasswordResetTokenSchema = SchemaFactory.createForClass(PasswordResetToken);

PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
PasswordResetTokenSchema.index({ userId: 1, usedAt: 1 });
