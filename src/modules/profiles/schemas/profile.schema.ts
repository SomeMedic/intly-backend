import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type ProfileDocument = HydratedDocument<Profile>;

export const PROFILE_KINDS = ['career', 'freelance', 'mixed'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export type MatchWeights = {
  skills: number;
  seniority: number;
  money: number;
  remoteLocation: number;
  employment: number;
  freshness: number;
  source: number;
};

export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  skills: 35,
  seniority: 10,
  money: 15,
  remoteLocation: 15,
  employment: 10,
  freshness: 10,
  source: 5,
};

@Schema(schemaOptions)
export class Profile {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, enum: PROFILE_KINDS, default: 'career' })
  kind!: ProfileKind;

  @Prop({ type: Boolean, default: false, index: true })
  isActive!: boolean;

  @Prop({ type: [String], default: [] })
  targetRoles!: string[];

  @Prop({ type: [String], default: [] })
  seniority!: string[];

  @Prop({ type: [String], default: [] })
  technologies!: string[];

  @Prop({ type: Object, default: {} })
  compensationPreferences!: Record<string, unknown>;

  @Prop({ type: [String], default: [] })
  locations!: string[];

  @Prop({ type: [String], default: [] })
  remotePreferences!: string[];

  @Prop({ type: [String], default: [] })
  employmentTypes!: string[];

  @Prop({ type: [String], default: [] })
  sourceIds!: string[];

  @Prop({ type: Object, default: DEFAULT_MATCH_WEIGHTS })
  matchWeights!: MatchWeights;

  @Prop({ type: Object, default: {} })
  aiPreferences!: Record<string, unknown>;

  @Prop({ type: String, default: '' })
  structuredExperienceSummary!: string;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const ProfileSchema = SchemaFactory.createForClass(Profile);

ProfileSchema.index({ userId: 1, deletedAt: 1, updatedAt: -1 });
ProfileSchema.index({ userId: 1, isActive: 1 }, { partialFilterExpression: { deletedAt: { $exists: false } } });
