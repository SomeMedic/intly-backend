import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type FileAssetDocument = HydratedDocument<FileAsset>;

export const FILE_ASSET_STATUSES = ['Stored', 'Deleted', 'Failed'] as const;
export type FileAssetStatus = (typeof FILE_ASSET_STATUSES)[number];

export const STORAGE_PROVIDERS = ['local', 'minio'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

@Schema(schemaOptions)
export class FileAsset {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  ownerUserId!: string;

  @Prop({ type: String, required: true, trim: true })
  originalName!: string;

  @Prop({ type: String, required: true, trim: true, index: true })
  mimeType!: string;

  @Prop({ type: Number, required: true })
  size!: number;

  @Prop({ type: String, required: true, index: true })
  sha256!: string;

  @Prop({ type: String, enum: STORAGE_PROVIDERS, required: true })
  storageProvider!: StorageProvider;

  @Prop({ type: String, required: true })
  bucket!: string;

  @Prop({ type: String, required: true })
  objectKey!: string;

  @Prop({ type: String, enum: FILE_ASSET_STATUSES, default: 'Stored', index: true })
  status!: FileAssetStatus;

  @Prop({ type: Object, default: {} })
  metadata!: Record<string, unknown>;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const FileAssetSchema = SchemaFactory.createForClass(FileAsset);

FileAssetSchema.index({ ownerUserId: 1, updatedAt: -1 });
FileAssetSchema.index({ ownerUserId: 1, sha256: 1, status: 1 });
