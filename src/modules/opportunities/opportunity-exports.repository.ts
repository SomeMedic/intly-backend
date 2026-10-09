import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { OpportunityExport, OpportunityExportDocument } from './schemas/opportunity-export.schema';

@Injectable()
export class OpportunityExportsRepository {
  constructor(@InjectModel(OpportunityExport.name) private readonly exportModel: Model<OpportunityExportDocument>) {}

  create(input: Partial<OpportunityExport>): Promise<OpportunityExport> {
    return this.exportModel.create(input).then((document) => document.toObject());
  }

  async getById(id: string): Promise<OpportunityExport> {
    const record = await this.exportModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
    if (!record) throw new NotFoundException('Opportunity export not found');
    return record;
  }

  async update(id: string, input: Partial<OpportunityExport>): Promise<OpportunityExport> {
    const updated = await this.exportModel.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } },
      { $set: input },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new NotFoundException('Opportunity export not found');
    return updated;
  }
}
