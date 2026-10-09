import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SavedView, SavedViewDocument } from './schemas/saved-view.schema';

@Injectable()
export class SavedViewsRepository {
  constructor(@InjectModel(SavedView.name) private readonly savedViewModel: Model<SavedViewDocument>) {}

  listByUser(userId: string): Promise<SavedView[]> {
    return this.savedViewModel.find({ userId, deletedAt: { $exists: false } }).sort({ pinned: -1, updatedAt: -1 }).lean();
  }

  listAll(): Promise<SavedView[]> {
    return this.savedViewModel.find({ deletedAt: { $exists: false } }).sort({ pinned: -1, updatedAt: -1 }).lean();
  }

  async getById(id: string): Promise<SavedView> {
    const view = await this.savedViewModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
    if (!view) throw new NotFoundException('Saved view not found');
    return view;
  }

  async create(input: Partial<SavedView>): Promise<SavedView> {
    const created = await this.savedViewModel.create(input);
    return created.toObject();
  }

  async update(id: string, input: Partial<SavedView>): Promise<SavedView> {
    const updated = await this.savedViewModel.findOneAndUpdate({ _id: id, deletedAt: { $exists: false } }, { $set: input }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Saved view not found');
    return updated;
  }

  async clearDefault(userId: string, scope: string): Promise<void> {
    await this.savedViewModel.updateMany({ userId, scope, deletedAt: { $exists: false } }, { $set: { isDefault: false } });
  }

  async softDelete(id: string): Promise<void> {
    const result = await this.savedViewModel.updateOne({ _id: id, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date() } });
    if (result.matchedCount === 0) throw new NotFoundException('Saved view not found');
  }
}
