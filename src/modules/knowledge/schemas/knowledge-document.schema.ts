import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type KnowledgeDocumentDocument = HydratedDocument<KnowledgeDocument>;

export const KNOWLEDGE_DOCUMENT_TYPES = ['resume', 'portfolio', 'certificate', 'article', 'work_sample', 'note', 'other'] as const;
export type KnowledgeDocumentType = (typeof KNOWLEDGE_DOCUMENT_TYPES)[number];

export const KNOWLEDGE_MODES = ['always_include', 'rag_only', 'disabled'] as const;
export type KnowledgeMode = (typeof KNOWLEDGE_MODES)[number];

export const KNOWLEDGE_STATUSES = ['Uploading', 'Parsing', 'Chunking', 'Embedding', 'Indexing', 'Indexed', 'Failed'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

@Schema(schemaOptions)
export class KnowledgeDocument {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: [String], default: [], index: true })
  profileIds!: string[];

  @Prop({ type: String, required: true, index: true })
  fileId!: string;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: String, enum: KNOWLEDGE_DOCUMENT_TYPES, default: 'other', index: true })
  type!: KnowledgeDocumentType;

  @Prop({ type: String, enum: KNOWLEDGE_MODES, default: 'rag_only', index: true })
  mode!: KnowledgeMode;

  @Prop({ type: String, enum: KNOWLEDGE_STATUSES, default: 'Uploading', index: true })
  status!: KnowledgeStatus;

  @Prop({ type: String, default: '' })
  extractedText!: string;

  @Prop({ type: Object, default: {} })
  structuredExtract!: Record<string, unknown>;

  @Prop({ type: String })
  summary?: string;

  @Prop({ type: Number, default: 0 })
  chunkCount!: number;

  @Prop({ type: String })
  lastError?: string;

  @Prop({ type: Date })
  processedAt?: Date;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const KnowledgeDocumentSchema = SchemaFactory.createForClass(KnowledgeDocument);

KnowledgeDocumentSchema.index({ userId: 1, deletedAt: 1, updatedAt: -1 });
KnowledgeDocumentSchema.index({ userId: 1, profileIds: 1, mode: 1, status: 1 });
