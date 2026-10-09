import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';
import { AiProvider, AiTaskType } from './ai-config.schema';
import type { AiCallAttempt, AiCallUsage } from '../ai-cost';

export type AiAnalysisDocument = HydratedDocument<AiAnalysis>;

export const AI_RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

export const AI_RUN_PROGRESS_STAGES = ['preparing_context', 'retrieving_knowledge', 'calling_model', 'validating_output', 'completed'] as const;
export type AiRunProgressStage = (typeof AI_RUN_PROGRESS_STAGES)[number];

@Schema({ ...schemaOptions, collection: 'ai_analyses' })
export class AiAnalysis {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  profileId!: string;

  @Prop({ type: String, required: true, index: true })
  opportunityId!: string;

  @Prop({ type: String, enum: ['opportunity_analysis', 'response_generation', 'resume_adaptation', 'document_extraction', 'tender_document_analysis', 'editor_transform'], required: true, index: true })
  taskType!: AiTaskType;

  @Prop({ type: String, enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued', index: true })
  status!: AiRunStatus;

  @Prop({ type: String, enum: AI_RUN_PROGRESS_STAGES })
  stage?: AiRunProgressStage;

  @Prop({ type: String })
  provider?: AiProvider;

  @Prop({ type: String })
  modelId?: string;

  @Prop({ type: Boolean, default: false })
  fallbackUsed!: boolean;

  @Prop({ type: Object })
  structuredOutput?: Record<string, unknown>;

  @Prop({ type: Number, min: 0, max: 100 })
  aiScore?: number;

  @Prop({ type: Object, default: {} })
  usage!: AiCallUsage;

  @Prop({ type: [Object], default: [] })
  attempts!: AiCallAttempt[];

  @Prop({ type: Object, default: {} })
  prompt!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  metadata!: Record<string, unknown>;

  @Prop({ type: Object })
  feedback?: { value: string; reason?: string; comment?: string };

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: String })
  errorCode?: string;

  @Prop({ type: String })
  errorSummary?: string;
}

export const AiAnalysisSchema = SchemaFactory.createForClass(AiAnalysis);

AiAnalysisSchema.index({ userId: 1, opportunityId: 1, profileId: 1, taskType: 1, createdAt: -1 });
AiAnalysisSchema.index({ status: 1, createdAt: -1 });
