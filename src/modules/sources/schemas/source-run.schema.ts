import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type SourceRunDocument = HydratedDocument<SourceRun>;

export const SOURCE_RUN_STATUSES = ['Queued', 'Running', 'Succeeded', 'Failed', 'Cancelled'] as const;
export type SourceRunStatus = (typeof SOURCE_RUN_STATUSES)[number];

export const SOURCE_RUN_ACTIVE_COLLECTION_INDEX = 'source_run_one_active_collection_per_source';
export const SOURCE_RUN_COLLECTION_TYPES = ['manual', 'scheduled', 'backfill'] as const;
export const SOURCE_RUN_ACTIVE_COLLECTION_INDEX_KEY = { sourceId: 1 } as const;
export const SOURCE_RUN_ACTIVE_COLLECTION_INDEX_OPTIONS = {
  name: SOURCE_RUN_ACTIVE_COLLECTION_INDEX,
  unique: true,
  partialFilterExpression: {
    status: { $in: ['Queued', 'Running'] },
    runType: { $in: SOURCE_RUN_COLLECTION_TYPES },
  },
} as const;

@Schema(schemaOptions)
export class SourceRun {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  sourceId!: string;

  @Prop({ type: String, enum: SOURCE_RUN_STATUSES, default: 'Queued', index: true })
  status!: SourceRunStatus;

  @Prop({ type: String, required: true, index: true })
  runType!: 'manual' | 'scheduled' | 'backfill' | 'health';

  @Prop({ type: String })
  requestedByUserId?: string;

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  finishedAt?: Date;

  @Prop({ type: Date })
  requestedStopAt?: Date;

  @Prop({ type: Object, default: {} })
  checkpointBefore!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  checkpointAfter!: Record<string, unknown>;

  @Prop({ type: Object, default: { seen: 0, normalized: 0, upserted: 0, duplicates: 0, failed: 0 } })
  stats!: Record<string, number>;

  @Prop({ type: String })
  error?: string;

  @Prop({ type: Object, default: {} })
  requestMetadata!: Record<string, unknown>;

  createdAt?: Date;

  updatedAt?: Date;
}

export const SourceRunSchema = SchemaFactory.createForClass(SourceRun);

SourceRunSchema.index({ sourceId: 1, createdAt: -1 });
SourceRunSchema.index({ status: 1, updatedAt: -1 });
SourceRunSchema.index({ createdAt: -1, _id: -1 });
SourceRunSchema.index({ sourceId: 1, createdAt: -1, _id: -1 });
SourceRunSchema.index({ status: 1, createdAt: -1, _id: -1 });
SourceRunSchema.index({ sourceId: 1, status: 1, createdAt: -1, _id: -1 });
SourceRunSchema.index(SOURCE_RUN_ACTIVE_COLLECTION_INDEX_KEY, SOURCE_RUN_ACTIVE_COLLECTION_INDEX_OPTIONS);
