import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';

import { withCanonicalOpportunity } from './canonical-opportunity-transaction';
import { IssueReport, IssueReportDocument, IssueReportStatus, IssueReportType } from './schemas/issue-report.schema';

export type IssueReportListParams = {
  status?: IssueReportStatus;
  type?: IssueReportType;
  opportunityId?: string;
  assignedAdminId?: string;
  query?: string;
  limit?: number;
  cursor?: string;
};

@Injectable()
export class IssueReportsRepository {
  constructor(
    @InjectModel(IssueReport.name) private readonly issueReportModel: Model<IssueReportDocument>,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async create(input: Partial<IssueReport>): Promise<IssueReport> {
    if (this.connection?.db && input.opportunityId) return withCanonicalOpportunity(this.connection, input.opportunityId, async (opportunityId, session) => this.createCanonical({ ...input, opportunityId }, session));
    return this.createCanonical(input);
  }

  async list(params: IssueReportListParams = {}) {
    const totalFilter = await this.toFilter(params);
    const filter = { ...totalFilter };
    if (params.cursor) filter._id = { $lt: params.cursor };
    const limit = Math.min(params.limit ?? 50, 100);
    const items = await this.issueReportModel.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const pageItems = items.slice(0, limit);
    return {
      items: pageItems,
      nextCursor: items.length > limit ? pageItems[pageItems.length - 1]?._id ?? null : null,
      total: await this.issueReportModel.countDocuments(totalFilter),
    };
  }

  async get(id: string): Promise<IssueReport> {
    const report = await this.issueReportModel.findById(id).lean();
    if (!report) throw new NotFoundException('Issue report not found');
    return report;
  }

  async update(id: string, patch: Partial<IssueReport>, unset: Array<keyof IssueReport> = []): Promise<IssueReport> {
    if (this.connection?.db && Object.prototype.hasOwnProperty.call(patch, 'opportunityId') && patch.opportunityId) {
      return withCanonicalOpportunity(this.connection, patch.opportunityId, async (opportunityId, session) => this.updateCanonical(id, { ...patch, opportunityId }, unset, session));
    }
    return this.updateCanonical(id, patch, unset);
  }

  async related(opportunityId: string, excludeId?: string): Promise<IssueReport[]> {
    const canonicalOpportunityId = await this.resolveCanonicalOpportunityId(opportunityId);
    const filter: Record<string, unknown> = { opportunityId: canonicalOpportunityId };
    if (excludeId) filter._id = { $ne: excludeId };
    return this.issueReportModel.find(filter).sort({ _id: -1 }).limit(20).lean();
  }

  async groupedCounts(opportunityIds: string[]): Promise<Record<string, number>> {
    if (!opportunityIds.length) return {};
    const canonicalIds = Array.from(new Set(await Promise.all(opportunityIds.map((id) => this.resolveCanonicalOpportunityId(id)))));
    const rows = await this.issueReportModel.aggregate<{ _id: string; count: number }>([
      { $match: { opportunityId: { $in: canonicalIds } } },
      { $group: { _id: '$opportunityId', count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map((row) => [row._id, row.count]));
  }

  private async createCanonical(input: Partial<IssueReport>, session?: mongo.ClientSession): Promise<IssueReport> {
    const [created] = await this.issueReportModel.create([input], { ...(session ? { session } : {}) });
    return created.toObject();
  }

  private async updateCanonical(id: string, patch: Partial<IssueReport>, unset: Array<keyof IssueReport> = [], session?: mongo.ClientSession): Promise<IssueReport> {
    const update = {
      $set: patch,
      ...(unset.length ? { $unset: Object.fromEntries(unset.map((field) => [field, 1])) } : {}),
    };
    const updated = await this.issueReportModel.findByIdAndUpdate(id, update, { new: true, ...(session ? { session } : {}) }).lean();
    if (!updated) throw new NotFoundException('Issue report not found');
    return updated;
  }

  private async toFilter(params: IssueReportListParams): Promise<Record<string, unknown>> {
    const filter: Record<string, unknown> = {};
    if (params.status) filter.status = params.status;
    if (params.type) filter.type = params.type;
    if (params.opportunityId) filter.opportunityId = await this.resolveCanonicalOpportunityId(params.opportunityId);
    if (params.assignedAdminId) filter.assignedAdminId = params.assignedAdminId;
    if (params.query) {
      const escaped = params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { comment: { $regex: escaped, $options: 'i' } },
        { opportunityId: { $regex: escaped, $options: 'i' } },
        { userId: { $regex: escaped, $options: 'i' } },
      ];
    }
    return filter;
  }

  private async resolveCanonicalOpportunityId(opportunityId: string): Promise<string> {
    if (!this.connection?.db) return opportunityId;
    let id = opportunityId;
    const visited = new Set<string>();
    const opportunities = this.connection.db.collection<{ _id: string; mergedIntoOpportunityId?: string }>('opportunities');
    for (let hop = 0; hop < 20; hop += 1) {
      if (visited.has(id)) throw new ConflictException('Opportunity alias cycle');
      visited.add(id);
      const record = await opportunities.findOne({ _id: id }, { projection: { _id: 1, mergedIntoOpportunityId: 1 } });
      if (!record) return opportunityId;
      if (!record.mergedIntoOpportunityId) return record._id;
      id = record.mergedIntoOpportunityId;
    }
    throw new ConflictException('Opportunity alias chain exceeds safe depth');
  }
}
