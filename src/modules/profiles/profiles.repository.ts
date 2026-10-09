import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';

import { Profile, ProfileDocument } from './schemas/profile.schema';

@Injectable()
export class ProfilesRepository {
  constructor(@InjectModel(Profile.name) private readonly profileModel: Model<ProfileDocument>) {}

  async listByUser(userId: string): Promise<Profile[]> {
    return this.profileModel.find({ userId, deletedAt: { $exists: false } }).sort({ updatedAt: -1, _id: 1 }).lean();
  }

  async listAll(): Promise<Profile[]> {
    return this.profileModel.find({ deletedAt: { $exists: false } }).sort({ updatedAt: -1, _id: 1 }).lean();
  }

  async listForIngestionMatching(): Promise<Profile[]> {
    const pipeline: PipelineStage[] = [
      { $match: { deletedAt: { $exists: false } } },
      { $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        pipeline: [{ $match: { status: 'Active', deletedAt: { $exists: false } } }, { $project: { _id: 1 } }],
        as: 'owner',
      } },
      { $match: { owner: { $ne: [] } } },
      { $project: { owner: 0 } },
      { $sort: { updatedAt: -1, _id: 1 } },
    ];
    return this.profileModel.aggregate<Profile>(pipeline).exec();
  }

  async findById(id: string): Promise<Profile | null> {
    return this.profileModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
  }

  async getById(id: string): Promise<Profile> {
    const profile = await this.findById(id);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    return profile;
  }

  async findOwned(id: string, userId: string): Promise<Profile | null> {
    return this.profileModel.findOne({ _id: id, userId, deletedAt: { $exists: false } }).lean();
  }

  async findActive(userId: string): Promise<Profile | null> {
    return this.profileModel.findOne({ userId, isActive: true, deletedAt: { $exists: false } }).lean();
  }

  async getOwned(id: string, userId: string): Promise<Profile> {
    const profile = await this.findOwned(id, userId);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    return profile;
  }

  async create(input: Partial<Profile>): Promise<Profile> {
    const created = await this.profileModel.create(input);
    return created.toObject();
  }

  async updateOwned(id: string, userId: string, input: Partial<Profile>): Promise<Profile> {
    const updated = await this.profileModel
      .findOneAndUpdate({ _id: id, userId, deletedAt: { $exists: false } }, { $set: input }, { new: true })
      .lean();
    if (!updated) {
      throw new NotFoundException('Profile not found');
    }
    return updated;
  }

  async updateById(id: string, input: Partial<Profile>): Promise<Profile> {
    const updated = await this.profileModel.findOneAndUpdate({ _id: id, deletedAt: { $exists: false } }, { $set: input }, { new: true }).lean();
    if (!updated) {
      throw new NotFoundException('Profile not found');
    }
    return updated;
  }

  async softDeleteOwned(id: string, userId: string): Promise<void> {
    const updated = await this.profileModel.updateOne(
      { _id: id, userId, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), isActive: false } },
    );
    if (updated.matchedCount === 0) {
      throw new NotFoundException('Profile not found');
    }
  }

  async softDeleteById(id: string): Promise<void> {
    const updated = await this.profileModel.updateOne(
      { _id: id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), isActive: false } },
    );
    if (updated.matchedCount === 0) {
      throw new NotFoundException('Profile not found');
    }
  }

  async clearActive(userId: string): Promise<void> {
    await this.profileModel.updateMany(
      { userId, isActive: true, deletedAt: { $exists: false } },
      { $set: { isActive: false } },
    );
  }

  async setActive(id: string, userId: string): Promise<Profile> {
    await this.getOwned(id, userId);
    await this.clearActive(userId);
    return this.updateOwned(id, userId, { isActive: true });
  }
}
