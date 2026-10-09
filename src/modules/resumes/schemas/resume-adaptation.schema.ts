import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type ResumeAdaptationDocument = HydratedDocument<ResumeAdaptation>;

export const RESUME_ADAPTATION_STATUSES = ['generating', 'review', 'editing', 'ready', 'exported', 'failed'] as const;
export type ResumeAdaptationStatus = (typeof RESUME_ADAPTATION_STATUSES)[number];

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export type ResumeSuggestion = {
  id: string;
  type: string;
  title: string;
  rationale?: string;
  evidence?: string;
  proposed: Record<string, unknown>;
  status: SuggestionStatus;
  decidedAt?: Date;
};

@Schema({ ...schemaOptions, collection: 'resume_adaptations' })
export class ResumeAdaptation {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  profileId!: string;

  @Prop({ type: String, required: true, index: true })
  opportunityId!: string;

  @Prop({ type: String, required: true, index: true })
  baseResumeId!: string;

  @Prop({ type: Object, default: {} })
  documentJson!: Record<string, unknown>;

  @Prop({ type: String })
  markdownCache?: string;

  @Prop({ type: [Object], default: [] })
  suggestions!: ResumeSuggestion[];

  @Prop({ type: String, enum: RESUME_ADAPTATION_STATUSES, default: 'generating', index: true })
  status!: ResumeAdaptationStatus;

  @Prop({ type: Number, default: 1, min: 1 })
  revision!: number;

  @Prop({ type: String, index: true })
  aiRunId?: string;

  @Prop({ type: Object, default: {} })
  generation!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  exportState!: Record<string, unknown>;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const ResumeAdaptationSchema = SchemaFactory.createForClass(ResumeAdaptation);

ResumeAdaptationSchema.index({ userId: 1, opportunityId: 1, profileId: 1, updatedAt: -1 });
ResumeAdaptationSchema.index({ userId: 1, baseResumeId: 1, opportunityId: 1 });
