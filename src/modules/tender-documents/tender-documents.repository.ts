import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';

import { withCanonicalOpportunity } from '../opportunities/canonical-opportunity-transaction';
import { TenderDocumentLink, TenderDocumentLinkDocument } from './schemas/tender-document-link.schema';

@Injectable()
export class TenderDocumentsRepository {
  constructor(
    @InjectModel(TenderDocumentLink.name) private readonly model: Model<TenderDocumentLinkDocument>,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async create(input: Partial<TenderDocumentLink>): Promise<TenderDocumentLink> {
    if (this.connection?.db && input.opportunityId) return withCanonicalOpportunity(this.connection, input.opportunityId, async (opportunityId, session) => this.createCanonical({ ...input, opportunityId }, session));
    return this.createCanonical(input);
  }

  createSourceImport(input: Partial<TenderDocumentLink>): Promise<TenderDocumentLink> {
    return this.create(input);
  }

  private async createCanonical(input: Partial<TenderDocumentLink>, session?: mongo.ClientSession): Promise<TenderDocumentLink> {
    const [document] = await this.model.create([input], { session });
    return document.toObject();
  }

  list(input: { userId?: string; opportunityId: string; profileId: string }): Promise<TenderDocumentLink[]> {
    return this.model.find({
      ...(input.userId ? { userId: input.userId } : {}),
      opportunityId: input.opportunityId,
      profileId: input.profileId,
      deletedAt: { $exists: false },
    }).sort({ updatedAt: -1, _id: 1 }).lean();
  }

  async get(id: string): Promise<TenderDocumentLink> {
    const link = await this.model.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
    if (!link) throw new NotFoundException('Tender document not found');
    return link;
  }

  async findSourceImport(input: { userId: string; opportunityId: string; profileId: string; sourceId: string; sourceUrl: string }): Promise<TenderDocumentLink | null> {
    return this.model.findOne({
      userId: input.userId,
      opportunityId: input.opportunityId,
      profileId: input.profileId,
      sourceId: input.sourceId,
      sourceUrl: input.sourceUrl,
      deletedAt: { $exists: false },
    }).lean();
  }

  async updateMany(ids: string[], input: Partial<TenderDocumentLink>): Promise<void> {
    if (!ids.length) return;
    await this.model.updateMany({ _id: { $in: ids }, deletedAt: { $exists: false } }, { $set: input });
  }

  async softDelete(id: string): Promise<void> {
    const result = await this.model.updateOne({ _id: id, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date() } });
    if (result.matchedCount === 0) throw new NotFoundException('Tender document not found');
  }
}
