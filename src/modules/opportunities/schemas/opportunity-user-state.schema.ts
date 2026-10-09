import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';
import { PIPELINE_STATUSES, PipelineStatus } from '../pipeline-definitions';

export type OpportunityUserStateDocument = HydratedDocument<OpportunityUserState>;

export { PIPELINE_STATUSES, PipelineStatus };

export type PipelineEvent = {
  status: PipelineStatus;
  firstReachedAt: Date;
};

export type PersonalNote = {
  id: string;
  text: string;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

@Schema(schemaOptions)
export class OpportunityUserState {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  opportunityId!: string;

  @Prop({ type: String, required: true, index: true })
  profileId!: string;

  @Prop({ type: String, enum: PIPELINE_STATUSES, default: 'New', index: true })
  pipelineStatus!: PipelineStatus;

  @Prop({ type: Boolean, default: false, index: true })
  favorite!: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  hidden!: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  archived!: boolean;

  @Prop({ type: [String], default: [], index: true })
  tags!: string[];

  @Prop({ type: Number, default: 0, index: true })
  matchScore!: number;

  @Prop({ type: Object, default: {} })
  matchComponents!: Record<string, number>;

  @Prop({ type: Date })
  matchCalculatedAt?: Date;

  @Prop({ type: Object, default: {} })
  responseState!: Record<string, unknown>;

  @Prop({ type: [Object], default: [] })
  notes!: PersonalNote[];

  @Prop({ type: [Object], default: [] })
  checklist!: Record<string, unknown>[];

  @Prop({ type: Boolean, default: false })
  pinned!: boolean;

  @Prop({ type: String })
  selectedResumeId?: string;

  @Prop({ type: [Object], default: [] })
  pipelineEvents!: PipelineEvent[];

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: String })
  mergedIntoStateId?: string;

  @Prop({ type: Date })
  mergedAt?: Date;
}

export const OpportunityUserStateSchema = SchemaFactory.createForClass(OpportunityUserState);

OpportunityUserStateSchema.index(
  { userId: 1, opportunityId: 1, profileId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: { $exists: false } } },
);
OpportunityUserStateSchema.index({ userId: 1, profileId: 1, pipelineStatus: 1, updatedAt: -1 });
