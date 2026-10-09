import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { schemaOptions } from '../../../common/schema';

export type SearchRebuildDocument = HydratedDocument<SearchRebuild>;
export type SearchRebuildStatus = 'Queued' | 'Running' | 'Succeeded' | 'Failed';

@Schema({ ...schemaOptions, collection: 'search_rebuilds' })
export class SearchRebuild {
  @Prop({ required: true })
  _id!: string;

  @Prop({ required: true, enum: ['Queued', 'Running', 'Succeeded', 'Failed'] })
  status!: SearchRebuildStatus;

  @Prop({ required: true })
  jobId!: string;

  @Prop()
  actorUserId?: string;

  @Prop({ required: true })
  stagingPrefix!: string;

  @Prop()
  stage?: string;

  @Prop({ type: Object, default: {} })
  progress?: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  indexes?: Record<string, unknown>;

  @Prop({ type: [Number], default: [] })
  taskUids?: number[];

  @Prop()
  startedAt?: Date;

  @Prop()
  finishedAt?: Date;

  @Prop()
  error?: string;

  @Prop()
  journalError?: string;

  @Prop()
  swappedAt?: Date;

  @Prop()
  swapTaskUid?: number;

  @Prop()
  cleanupWarning?: string;
}

export const SearchRebuildSchema = SchemaFactory.createForClass(SearchRebuild);
SearchRebuildSchema.index({ createdAt: -1 });
SearchRebuildSchema.index({ jobId: 1 });

@Schema({ ...schemaOptions, collection: 'search_rebuild_locks' })
export class SearchRebuildLock {
  @Prop({ required: true })
  _id!: string;

  @Prop({ required: true })
  jobId!: string;

  @Prop({ required: true })
  rebuildId!: string;

  @Prop({ required: true })
  stagingPrefix!: string;

  @Prop({ required: true })
  lockedUntil!: Date;

  @Prop({ required: true, enum: ['building', 'publishing'], default: 'building' })
  phase!: 'building' | 'publishing';

  @Prop()
  journalError?: string;
}

export type SearchRebuildLockDocument = HydratedDocument<SearchRebuildLock>;
export const SearchRebuildLockSchema = SchemaFactory.createForClass(SearchRebuildLock);
SearchRebuildLockSchema.index({ lockedUntil: 1 });

@Schema({ ...schemaOptions, collection: 'search_rebuild_mutations' })
export class SearchRebuildMutation {
  @Prop({ required: true })
  _id!: string;

  @Prop({ required: true })
  rebuildId!: string;

  @Prop({ required: true })
  index!: string;

  @Prop({ required: true, enum: ['upsert', 'delete'] })
  operation!: 'upsert' | 'delete';

  @Prop({ required: true })
  documentId!: string;

}

export type SearchRebuildMutationDocument = HydratedDocument<SearchRebuildMutation>;
export const SearchRebuildMutationSchema = SchemaFactory.createForClass(SearchRebuildMutation);
SearchRebuildMutationSchema.index({ rebuildId: 1, createdAt: 1, _id: 1 });


@Schema({ ...schemaOptions, collection: 'search_rebuild_writers' })
export class SearchRebuildWriter {
  @Prop({ required: true })
  _id!: string;

  @Prop()
  rebuildId?: string;

  @Prop()
  completedAt?: Date;
}

export type SearchRebuildWriterDocument = HydratedDocument<SearchRebuildWriter>;
export const SearchRebuildWriterSchema = SchemaFactory.createForClass(SearchRebuildWriter);
SearchRebuildWriterSchema.index({ rebuildId: 1, createdAt: 1 });
