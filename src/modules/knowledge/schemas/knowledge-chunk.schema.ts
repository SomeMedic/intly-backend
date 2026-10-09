import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type KnowledgeChunkDocument = HydratedDocument<KnowledgeChunk>;

export type EmbeddingMetadata = {
  model: string;
  version: string;
  dimension: number;
  inputHash: string;
};

@Schema(schemaOptions)
export class KnowledgeChunk {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  documentId!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: [String], default: [], index: true })
  profileIds!: string[];

  @Prop({ type: String, default: 'body', index: true })
  section!: string;

  @Prop({ type: String, default: 'text', index: true })
  type!: string;

  @Prop({ type: Number, required: true })
  chunkIndex!: number;

  @Prop({ type: String, required: true })
  text!: string;

  @Prop({ type: String, required: true, index: true })
  inputHash!: string;

  @Prop({ type: [Number], default: [], select: false })
  embedding!: number[];

  @Prop({ type: Object, default: {} })
  embeddingMetadata!: EmbeddingMetadata;

  @Prop({ type: Boolean, default: true, index: true })
  active!: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const KnowledgeChunkSchema = SchemaFactory.createForClass(KnowledgeChunk);

KnowledgeChunkSchema.index({ userId: 1, profileIds: 1, active: 1, updatedAt: -1 });
KnowledgeChunkSchema.index({ documentId: 1, chunkIndex: 1 }, { unique: true, partialFilterExpression: { deletedAt: { $exists: false } } });
KnowledgeChunkSchema.index({ text: 'text', section: 'text' });
