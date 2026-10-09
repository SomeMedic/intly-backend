import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';

import { FileListQueryDto } from './dto/file.dto';
import { withCanonicalOpportunity } from '../opportunities/canonical-opportunity-transaction';
import { FileAsset, FileAssetDocument } from './schemas/file-asset.schema';

@Injectable()
export class FilesRepository {
  constructor(
    @InjectModel(FileAsset.name) private readonly fileModel: Model<FileAssetDocument>,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  listForUser(userId: string, query: FileListQueryDto = {}): Promise<FileAsset[]> {
    return this.fileModel
      .find({
        ownerUserId: userId,
        deletedAt: { $exists: false },
        ...(query.status ? { status: query.status } : {}),
        ...(query.mimeType ? { mimeType: query.mimeType } : {}),
      })
      .sort({ updatedAt: -1, _id: 1 })
      .limit(Math.min(query.limit ?? 50, 100))
      .lean();
  }

  listAll(query: FileListQueryDto = {}): Promise<FileAsset[]> {
    return this.fileModel
      .find({
        deletedAt: { $exists: false },
        ...(query.status ? { status: query.status } : {}),
        ...(query.mimeType ? { mimeType: query.mimeType } : {}),
      })
      .sort({ updatedAt: -1, _id: 1 })
      .limit(Math.min(query.limit ?? 50, 100))
      .lean();
  }

  async getById(id: string): Promise<FileAsset> {
    const file = await this.fileModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
    if (!file) throw new NotFoundException('File not found');
    return file;
  }

  async create(input: Partial<FileAsset>): Promise<FileAsset> {
    const opportunityId = metadataOpportunityId(input.metadata);
    if (this.connection?.db && opportunityId) return withCanonicalOpportunity(this.connection, opportunityId, (canonicalOpportunityId, session) => this.createCanonical(withMetadataOpportunity(input, canonicalOpportunityId), session));
    return this.createCanonical(input);
  }

  async update(id: string, input: Partial<FileAsset>): Promise<FileAsset> {
    const opportunityId = Object.prototype.hasOwnProperty.call(input, 'metadata') ? metadataOpportunityId(input.metadata) : undefined;
    if (this.connection?.db && opportunityId) return withCanonicalOpportunity(this.connection, opportunityId, (canonicalOpportunityId, session) => this.updateCanonical(id, withMetadataOpportunity(input, canonicalOpportunityId), session));
    return this.updateCanonical(id, input);
  }

  private async createCanonical(input: Partial<FileAsset>, session?: mongo.ClientSession): Promise<FileAsset> {
    const [created] = await this.fileModel.create([input], { session });
    return created.toObject();
  }

  private async updateCanonical(id: string, input: Partial<FileAsset>, session?: mongo.ClientSession): Promise<FileAsset> {
    const updated = await this.fileModel.findOneAndUpdate({ _id: id, deletedAt: { $exists: false } }, { $set: input }, { new: true, session }).lean();
    if (!updated) throw new NotFoundException('File not found');
    return updated;
  }

  async softDelete(id: string): Promise<void> {
    const result = await this.fileModel.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), status: 'Deleted' } },
    );
    if (result.matchedCount === 0) throw new NotFoundException('File not found');
  }
}

function metadataOpportunityId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).opportunityId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function withMetadataOpportunity(input: Partial<FileAsset>, opportunityId: string): Partial<FileAsset> {
  return { ...input, metadata: { ...(input.metadata ?? {}), opportunityId } };
}
