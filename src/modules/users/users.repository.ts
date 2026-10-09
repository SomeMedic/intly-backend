import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersRepository {
  constructor(@InjectModel(User.name) private readonly userModel: Model<UserDocument>) {}

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  async create(input: Partial<User>): Promise<User> {
    try {
      const created = await this.userModel.create({
        ...input,
        email: this.normalizeEmail(input.email ?? ''),
      });
      return created.toObject();
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === 11000) {
        throw new ConflictException('User with this email already exists');
      }
      throw error;
    }
  }

  findByEmail(email: string): Promise<User | null> {
    return this.userModel.findOne({ email: this.normalizeEmail(email), deletedAt: { $exists: false } }).lean();
  }

  findById(id: string, options: { includeDeleted?: boolean } = {}): Promise<User | null> {
    return this.userModel.findOne({ _id: id, ...(options.includeDeleted ? {} : { deletedAt: { $exists: false } }) }).lean();
  }

  findByIds(ids: string[]): Promise<User[]> {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    if (!uniqueIds.length) return Promise.resolve([]);
    return this.userModel.find({ _id: { $in: uniqueIds }, deletedAt: { $exists: false } }).lean();
  }

  findByTelegramLinkTokenHash(tokenHash: string): Promise<User | null> {
    return this.userModel.findOne({ 'telegram.linkTokenHash': tokenHash, deletedAt: { $exists: false } }).lean();
  }


  async getById(id: string, options: { includeDeleted?: boolean } = {}): Promise<User> {
    const user = await this.findById(id, options);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async list(params: { query?: string; role?: string; status?: string; limit?: number; cursor?: string; includeDeleted?: boolean; inviteState?: string; createdFrom?: Date; createdTo?: Date; sort?: string }) {
    const filter: Record<string, unknown> = params.includeDeleted ? {} : { deletedAt: { $exists: false } };
    const and: Record<string, unknown>[] = [];
    if (params.role) filter.role = params.role;
    if (params.status) filter.status = params.status;
    if (params.inviteState === 'pending') and.push({ status: 'Invited' });
    if (params.inviteState === 'accepted') {
      and.push({ $or: [{ passwordChangedAt: { $exists: true } }, { passwordHash: { $exists: true } }] });
    }
    if (params.createdFrom || params.createdTo) {
      filter.createdAt = {
        ...(params.createdFrom ? { $gte: params.createdFrom } : {}),
        ...(params.createdTo ? { $lt: params.createdTo } : {}),
      };
    }
    if (params.query) {
      const escaped = params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { email: { $regex: escaped, $options: 'i' } },
        { name: { $regex: escaped, $options: 'i' } },
      ];
    }
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    const sortSpec = this.listSort(params.sort);
    if (params.cursor) {
      and.push(await this.cursorFilter(params.cursor, sortSpec, Boolean(params.includeDeleted)));
    }
    if (and.length) {
      filter.$and = [...(Array.isArray(filter.$and) ? filter.$and : []), ...and];
    }
    const sort = { [sortSpec.field]: sortSpec.direction, _id: 1 } as Record<string, 1 | -1>;
    const items = await this.userModel.find(filter).sort(sort).limit(limit + 1).lean();
    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    return {
      items: pageItems,
      nextCursor: hasMore ? pageItems[pageItems.length - 1]?._id ?? null : null,
    };
  }

  private listSort(sort?: string): { field: '_id' | 'createdAt' | 'lastActiveAt' | 'name'; direction: 1 | -1 } {
    if (sort === 'createdAt:asc') return { field: 'createdAt', direction: 1 };
    if (sort === 'createdAt:desc') return { field: 'createdAt', direction: -1 };
    if (sort === 'lastActiveAt:asc') return { field: 'lastActiveAt', direction: 1 };
    if (sort === 'lastActiveAt:desc') return { field: 'lastActiveAt', direction: -1 };
    if (sort === 'name:asc') return { field: 'name', direction: 1 };
    if (sort === 'name:desc') return { field: 'name', direction: -1 };
    return { field: '_id', direction: 1 };
  }

  private async cursorFilter(cursor: string, sort: { field: '_id' | 'createdAt' | 'lastActiveAt' | 'name'; direction: 1 | -1 }, includeDeleted: boolean): Promise<Record<string, unknown>> {
    if (sort.field === '_id') return { _id: { $gt: cursor } };
    const cursorUser = await this.findById(cursor, { includeDeleted });
    if (!cursorUser) {
      throw new BadRequestException('Invalid users cursor');
    }
    const value = this.cursorValue(cursorUser, sort.field);
    const fieldExpression = this.sortFieldExpression(sort.field);
    return {
      $expr: {
        $or: [
          { [sort.direction === 1 ? '$gt' : '$lt']: [fieldExpression, value] },
          { $and: [{ $eq: [fieldExpression, value] }, { $gt: ['$_id', cursor] }] },
        ],
      },
    };
  }

  private cursorValue(user: User, field: 'createdAt' | 'lastActiveAt' | 'name') {
    if (field === 'name') return user.name ?? '';
    if (field === 'lastActiveAt') return user.lastActiveAt ?? new Date(0);
    return (user as User & { createdAt?: Date }).createdAt ?? new Date(0);
  }

  private sortFieldExpression(field: 'createdAt' | 'lastActiveAt' | 'name') {
    if (field === 'lastActiveAt') return { $ifNull: ['$lastActiveAt', new Date(0)] };
    if (field === 'createdAt') return { $ifNull: ['$createdAt', new Date(0)] };
    return '$name';
  }

  async update(id: string, input: Partial<User>): Promise<User> {
    // Older accounts can have an absent or null settings object. Initialize it
    // conditionally so dotted updates work without replacing another request's data.
    for (const group of ['uiSettings', 'notificationSettings', 'aiPreferences']) {
      if (!Object.keys(input).some(key => key.startsWith(`${group}.`))) continue;
      await this.userModel.updateOne(
        { _id: id, deletedAt: { $exists: false }, [group]: null },
        { $set: { [group]: {} } },
      );
    }
    const updated = await this.userModel.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } },
      { $set: input },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) {
      throw new NotFoundException('User not found');
    }
    return updated;
  }

  async setPassword(id: string, passwordHash: string, mustChangePassword = false): Promise<User> {
    return this.update(id, {
      passwordHash,
      passwordChangedAt: new Date(),
      mustChangePassword,
    });
  }

  async touchLastActive(id: string): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { lastActiveAt: new Date() } });
  }
}
