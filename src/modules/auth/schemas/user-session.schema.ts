import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type UserSessionDocument = HydratedDocument<UserSession>;

export const SESSION_STATUSES = ['Active', 'Replaced', 'Revoked', 'Reused'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

@Schema(schemaOptions)
export class UserSession {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  familyId!: string;

  @Prop({ type: String, required: true, unique: true, index: true })
  tokenHash!: string;

  @Prop({ type: String, enum: SESSION_STATUSES, default: 'Active', index: true })
  status!: SessionStatus;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date })
  rotatedAt?: Date;

  @Prop({ type: Date })
  revokedAt?: Date;

  @Prop({ type: String })
  replacedBySessionId?: string;

  @Prop({ type: String })
  userAgent?: string;

  @Prop({ type: String })
  ip?: string;
}

export const UserSessionSchema = SchemaFactory.createForClass(UserSession);

UserSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
UserSessionSchema.index({ userId: 1, status: 1, updatedAt: -1 });
UserSessionSchema.index({ familyId: 1, status: 1 });
