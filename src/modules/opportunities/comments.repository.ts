import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { withCanonicalOpportunity } from './canonical-opportunity-transaction';

import { OpportunityComment, OpportunityCommentDocument } from './schemas/opportunity-comment.schema';

@Injectable()
export class OpportunityCommentsRepository {
  constructor(
    @InjectModel(OpportunityComment.name)
    private readonly commentModel: Model<OpportunityCommentDocument>,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async list(opportunityId: string): Promise<OpportunityComment[]> {
    return this.commentModel
      .find({ opportunityId, deletedAt: { $exists: false } })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
  }

  async create(input: Partial<OpportunityComment>): Promise<OpportunityComment> {
    if (this.connection?.db && input.opportunityId) return withCanonicalOpportunity(this.connection, input.opportunityId, async (opportunityId, session) => {
      const [created] = await this.commentModel.create([{ ...input, opportunityId }], { session });
      return created.toObject();
    });
    const created = await this.commentModel.create(input);
    return created.toObject();
  }

  async findById(id: string): Promise<OpportunityComment | null> {
    return this.commentModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const result = await this.commentModel.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), deletedBy } },
    );
    if (result.matchedCount === 0) {
      throw new NotFoundException('Comment not found');
    }
  }
}
