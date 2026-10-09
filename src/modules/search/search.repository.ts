import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SearchScope } from './dto/search.dto';
import { SearchRecent, SearchRecentDocument } from './schemas/search-recent.schema';

@Injectable()
export class SearchRepository {
  constructor(@InjectModel(SearchRecent.name) private readonly recentModel: Model<SearchRecentDocument>) {}

  async recordRecent(userId: string, query: string, scope: SearchScope, filters: Record<string, unknown> = {}): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) return;
    await this.recentModel.updateOne(
      { userId, query: trimmed, scope, deletedAt: { $exists: false } },
      { $set: { filters, updatedAt: new Date() }, $setOnInsert: { userId, query: trimmed, scope } },
      { upsert: true },
    );
  }

  async listRecent(userId: string, scope?: SearchScope): Promise<SearchRecent[]> {
    return this.recentModel
      .find({ userId, deletedAt: { $exists: false }, ...(scope ? { scope } : {}) })
      .sort({ updatedAt: -1, _id: 1 })
      .limit(20)
      .lean();
  }

  async clearRecent(userId: string): Promise<void> {
    await this.recentModel.updateMany({ userId, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date() } });
  }
}
