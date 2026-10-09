import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { KnowledgeDocumentListQueryDto } from './dto/knowledge.dto';
import { KnowledgeChunk, KnowledgeChunkDocument } from './schemas/knowledge-chunk.schema';
import { KnowledgeDocument, KnowledgeDocumentDocument } from './schemas/knowledge-document.schema';

@Injectable()
export class KnowledgeRepository {
  constructor(
    @InjectModel(KnowledgeDocument.name) private readonly documentModel: Model<KnowledgeDocumentDocument>,
    @InjectModel(KnowledgeChunk.name) private readonly chunkModel: Model<KnowledgeChunkDocument>,
  ) {}

  list(userId: string | null, query: KnowledgeDocumentListQueryDto = {}): Promise<KnowledgeDocument[]> {
    const textFilter = query.query ? { $or: [{ title: { $regex: this.escape(query.query), $options: 'i' } }, { extractedText: { $regex: this.escape(query.query), $options: 'i' } }] } : {};
    return this.documentModel
      .find({
        ...(userId ? { userId } : {}),
        deletedAt: { $exists: false },
        ...(query.type ? { type: query.type } : {}),
        ...(query.mode ? { mode: query.mode } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.profileId ? { $or: [{ profileIds: query.profileId }, { profileIds: { $size: 0 } }] } : {}),
        ...textFilter,
      })
      .sort({ updatedAt: -1, _id: 1 })
      .limit(Math.min(query.limit ?? 50, 100))
      .lean();
  }

  async getDocument(id: string): Promise<KnowledgeDocument> {
    const document = await this.documentModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
    if (!document) throw new NotFoundException('Knowledge document not found');
    return document;
  }

  async createDocument(input: Partial<KnowledgeDocument>): Promise<KnowledgeDocument> {
    const created = await this.documentModel.create(input);
    return created.toObject();
  }

  async updateDocument(id: string, input: Partial<KnowledgeDocument>): Promise<KnowledgeDocument> {
    const updated = await this.documentModel.findOneAndUpdate({ _id: id, deletedAt: { $exists: false } }, { $set: input }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Knowledge document not found');
    return updated;
  }

  async softDeleteDocument(id: string): Promise<void> {
    const result = await this.documentModel.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), mode: 'disabled' } },
    );
    if (result.matchedCount === 0) throw new NotFoundException('Knowledge document not found');
    await this.chunkModel.updateMany({ documentId: id, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date(), active: false } });
  }

  async replaceChunks(documentId: string, chunks: Array<Partial<KnowledgeChunk>>): Promise<KnowledgeChunk[]> {
    await this.chunkModel.updateMany({ documentId, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date(), active: false } });
    if (!chunks.length) return [];
    const created = await this.chunkModel.insertMany(chunks);
    return created.map((chunk) => chunk.toObject());
  }

  async searchChunks(input: { userId: string; profileId?: string; query: string; limit: number; includeEmbeddings?: boolean }): Promise<KnowledgeChunk[]> {
    const filter = {
      userId: input.userId,
      active: true,
      deletedAt: { $exists: false },
      ...(input.profileId ? { $or: [{ profileIds: input.profileId }, { profileIds: { $size: 0 } }] } : {}),
      ...(input.query ? { text: { $regex: this.escape(input.query), $options: 'i' } } : {}),
    };
    return this.chunkModel.find(filter).select(input.includeEmbeddings ? '+embedding' : '').sort({ updatedAt: -1, _id: 1 }).limit(input.limit).lean();
  }

  async candidateChunks(input: { userId: string; profileId?: string; limit: number }): Promise<KnowledgeChunk[]> {
    return this.chunkModel
      .find({
        userId: input.userId,
        active: true,
        deletedAt: { $exists: false },
        ...(input.profileId ? { $or: [{ profileIds: input.profileId }, { profileIds: { $size: 0 } }] } : {}),
      })
      .select('+embedding')
      .sort({ updatedAt: -1, _id: 1 })
      .limit(input.limit)
      .lean();
  }

  listAlwaysInclude(userId: string, profileId?: string): Promise<KnowledgeDocument[]> {
    return this.documentModel
      .find({
        userId,
        mode: 'always_include',
        status: 'Indexed',
        deletedAt: { $exists: false },
        ...(profileId ? { $or: [{ profileIds: profileId }, { profileIds: { $size: 0 } }] } : {}),
      })
      .sort({ updatedAt: -1, _id: 1 })
      .limit(20)
      .lean();
  }

  private escape(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
