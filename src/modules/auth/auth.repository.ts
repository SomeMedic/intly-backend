import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { InviteToken, InviteTokenDocument } from './schemas/invite-token.schema';
import { PasswordResetToken, PasswordResetTokenDocument } from './schemas/password-reset-token.schema';
import { UserSession, UserSessionDocument } from './schemas/user-session.schema';

@Injectable()
export class AuthRepository {
  constructor(
    @InjectModel(UserSession.name) private readonly sessionModel: Model<UserSessionDocument>,
    @InjectModel(InviteToken.name) private readonly inviteTokenModel: Model<InviteTokenDocument>,
    @InjectModel(PasswordResetToken.name) private readonly passwordResetTokenModel: Model<PasswordResetTokenDocument>,
  ) {}

  createSession(input: Partial<UserSession>): Promise<UserSession> {
    return this.sessionModel.create(input).then((doc) => doc.toObject());
  }

  findAccessSessionById(id: string): Promise<UserSession | null> {
    return this.sessionModel.findOne({ _id: id, status: { $in: ['Active', 'Replaced'] }, expiresAt: { $gt: new Date() } }).lean();
  }


  findSessionByHash(tokenHash: string): Promise<UserSession | null> {
    return this.sessionModel.findOne({ tokenHash }).lean();
  }

  replaceActiveSession(tokenHash: string, nextSessionId: string): Promise<UserSession | null> {
    return this.sessionModel.findOneAndUpdate(
      { tokenHash, status: 'Active', expiresAt: { $gt: new Date() } },
      { $set: { status: 'Replaced', rotatedAt: new Date(), replacedBySessionId: nextSessionId } },
      { returnDocument: 'after' },
    ).lean();
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.sessionModel.updateOne({ tokenHash, status: 'Active' }, { $set: { status: 'Revoked', revokedAt: new Date() } });
  }

  async revokeFamily(familyId: string, status: 'Revoked' | 'Reused' = 'Revoked'): Promise<void> {
    await this.sessionModel.updateMany(
      { familyId, status: { $in: ['Active', 'Replaced'] } },
      { $set: { status, revokedAt: new Date() } },
    );
  }

  async revokeUserSessions(userId: string): Promise<void> {
    await this.sessionModel.updateMany(
      { userId, status: { $in: ['Active', 'Replaced'] } },
      { $set: { status: 'Revoked', revokedAt: new Date() } },
    );
  }

  createInviteToken(input: Partial<InviteToken>): Promise<InviteToken> {
    return this.inviteTokenModel.create(input).then((doc) => doc.toObject());
  }

  findInviteByHash(tokenHash: string): Promise<InviteToken | null> {
    return this.inviteTokenModel.findOne({ tokenHash }).lean();
  }

  async consumeInviteToken(tokenHash: string): Promise<InviteToken | null> {
    return this.inviteTokenModel.findOneAndUpdate(
      { tokenHash, usedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
  }

  async invalidateInvitesForUser(userId: string): Promise<void> {
    await this.inviteTokenModel.updateMany(
      { userId, usedAt: { $exists: false } },
      { $set: { usedAt: new Date() } },
    );
  }

  createPasswordResetToken(input: Partial<PasswordResetToken>): Promise<PasswordResetToken> {
    return this.passwordResetTokenModel.create(input).then((doc) => doc.toObject());
  }

  async consumePasswordResetToken(tokenHash: string): Promise<PasswordResetToken | null> {
    return this.passwordResetTokenModel.findOneAndUpdate(
      { tokenHash, usedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
  }

  async invalidatePasswordResetsForUser(userId: string): Promise<void> {
    await this.passwordResetTokenModel.updateMany(
      { userId, usedAt: { $exists: false } },
      { $set: { usedAt: new Date() } },
    );
  }
}
