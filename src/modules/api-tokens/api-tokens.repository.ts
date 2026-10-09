import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ApiToken, ApiTokenDocument } from './schemas/api-token.schema';

@Injectable()
export class ApiTokensRepository {
  constructor(@InjectModel(ApiToken.name) private readonly apiTokenModel: Model<ApiTokenDocument>) {}

  create(input: Partial<ApiToken>): Promise<ApiToken> {
    return this.apiTokenModel.create(input).then((document) => document.toObject());
  }

  list(userId: string) {
    return this.apiTokenModel.find({ userId, revokedAt: { $exists: false } }).sort({ createdAt: -1 }).select('-tokenHash').lean();
  }

  async revoke(id: string, userId: string): Promise<{ success: true }> {
    const updated = await this.apiTokenModel.updateOne({ _id: id, userId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    if (updated.matchedCount === 0) throw new NotFoundException('API token not found');
    return { success: true };
  }

  async findUsableByHash(tokenHash: string): Promise<ApiToken | null> {
    return this.apiTokenModel.findOne({ tokenHash, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).lean();
  }

  async touch(id: string): Promise<void> {
    await this.apiTokenModel.updateOne({ _id: id }, { $set: { lastUsedAt: new Date() } });
  }
}
