import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type ResumeDocument = HydratedDocument<Resume>;

export const RESUME_KINDS = ['base', 'adapted'] as const;
export type ResumeKind = (typeof RESUME_KINDS)[number];

export const RESUME_STATUSES = ['draft', 'ready', 'archived'] as const;
export type ResumeStatus = (typeof RESUME_STATUSES)[number];

@Schema({ ...schemaOptions, collection: 'resumes' })
export class Resume {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, index: true })
  profileId?: string;

  @Prop({ type: String, enum: RESUME_KINDS, default: 'base', index: true })
  kind!: ResumeKind;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: Object, default: {} })
  documentJson!: Record<string, unknown>;

  @Prop({ type: String })
  markdownCache?: string;

  @Prop({ type: String })
  sourceFileId?: string;

  @Prop({ type: String, index: true })
  baseResumeId?: string;

  @Prop({ type: String, index: true })
  opportunityId?: string;

  @Prop({ type: Number, default: 1, min: 1 })
  revision!: number;

  @Prop({ type: String, enum: RESUME_STATUSES, default: 'draft', index: true })
  status!: ResumeStatus;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const ResumeSchema = SchemaFactory.createForClass(Resume);

ResumeSchema.index({ userId: 1, kind: 1, updatedAt: -1 });
ResumeSchema.index({ userId: 1, profileId: 1, updatedAt: -1 });
