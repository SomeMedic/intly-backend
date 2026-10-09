import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';
import type { AiModelPrice } from '../ai-cost';

export type AiProviderConfigDocument = HydratedDocument<AiProviderConfig>;
export type AiTaskConfigDocument = HydratedDocument<AiTaskConfig>;
export type AiPromptTemplateDocument = HydratedDocument<AiPromptTemplate>;

export const AI_PROVIDERS = ['openai', 'gemini', 'deepseek'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_TASK_TYPES = [
  'opportunity_analysis',
  'response_generation',
  'resume_adaptation',
  'document_extraction',
  'tender_document_analysis',
  'editor_transform',
] as const;
export type AiTaskType = (typeof AI_TASK_TYPES)[number];

@Schema({ ...schemaOptions, collection: 'ai_provider_configs' })
export class AiProviderConfig {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, enum: AI_PROVIDERS, required: true })
  provider!: AiProvider;

  @Prop({ type: Boolean, default: false })
  enabled!: boolean;

  @Prop({ type: String })
  apiKeyEncrypted?: string;

  @Prop({ type: String })
  apiKeyMasked?: string;

  @Prop({ type: String })
  baseUrl?: string;

  @Prop({ type: Object, default: {} })
  health!: Record<string, unknown>;

  @Prop({ type: [Object], default: [] })
  pricing!: AiModelPrice[];
}

@Schema({ ...schemaOptions, collection: 'ai_task_configs' })
export class AiTaskConfig {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, enum: AI_TASK_TYPES, required: true })
  taskType!: AiTaskType;

  @Prop({ type: String, enum: AI_PROVIDERS, required: true })
  primaryProvider!: AiProvider;

  @Prop({ type: String, required: true })
  primaryModel!: string;

  @Prop({ type: String, enum: AI_PROVIDERS })
  fallbackProvider?: AiProvider | null;

  @Prop({ type: String })
  fallbackModel?: string | null;

  @Prop({ type: Number, default: 1, min: 0, max: 5 })
  retryCount!: number;

  @Prop({ type: Number, min: 0, max: 2 })
  temperature?: number;

  @Prop({ type: Number, min: 1 })
  maxOutputTokens?: number;
}

@Schema({ ...schemaOptions, collection: 'ai_prompt_templates' })
export class AiPromptTemplate {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, enum: AI_TASK_TYPES, required: true })
  taskType!: AiTaskType;

  @Prop({ type: String, required: true })
  systemCore!: string;

  @Prop({ type: String, required: true })
  taskInstructions!: string;

  @Prop({ type: String, default: 'v1' })
  versionLabel!: string;
}

export const AiProviderConfigSchema = SchemaFactory.createForClass(AiProviderConfig);
export const AiTaskConfigSchema = SchemaFactory.createForClass(AiTaskConfig);
export const AiPromptTemplateSchema = SchemaFactory.createForClass(AiPromptTemplate);

AiProviderConfigSchema.index({ provider: 1 }, { unique: true });
AiTaskConfigSchema.index({ taskType: 1 }, { unique: true });
AiPromptTemplateSchema.index({ taskType: 1 }, { unique: true });
