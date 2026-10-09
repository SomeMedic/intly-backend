import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type ApiTokenDocument = HydratedDocument<ApiToken>;

export const API_TOKEN_SCOPES = ['read:opportunities', 'read:profiles', 'read:responses', 'read:resumes', 'write:responses', 'write:resumes'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

@Schema({ ...schemaOptions, collection: 'api_tokens' })
export class ApiToken {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, required: true, unique: true, index: true })
  tokenHash!: string;

  @Prop({ type: String, required: true })
  tokenPrefix!: string;

  @Prop({ type: [String], enum: API_TOKEN_SCOPES, default: ['read:opportunities'] })
  scopes!: ApiTokenScope[];

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date })
  lastUsedAt?: Date;

  @Prop({ type: Date })
  revokedAt?: Date;
}

export const ApiTokenSchema = SchemaFactory.createForClass(ApiToken);

ApiTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ApiTokenSchema.index({ userId: 1, revokedAt: 1, createdAt: -1 });
