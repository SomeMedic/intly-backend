import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Inject,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'crypto';

import { Actor } from '../../common/access';
import { User } from '../users/schemas/user.schema';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  INVITE_TOKEN_TTL_MS,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from './auth.config';
import { AuthRepository } from './auth.repository';
import { RequestMetadata, TokenPair } from './auth.types';
import { ActivateInviteDto, ChangePasswordDto, ForgotPasswordDto, InviteUserDto, LoginDto, ResetPasswordDto } from './dto/auth.dto';
import { AuthEmailAdapter } from './email/email.adapter';

export const AUTH_EMAIL_ADAPTER = Symbol('AUTH_EMAIL_ADAPTER');

@Injectable()
export class AuthService {
  constructor(
    private readonly authRepository: AuthRepository,
    private readonly usersRepository: UsersRepository,
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    @Inject(AUTH_EMAIL_ADAPTER)
    private readonly emailAdapter: AuthEmailAdapter,
  ) {}

  async login(dto: LoginDto, metadata: RequestMetadata): Promise<{ user: ReturnType<UsersService['toPublicUser']>; tokens: TokenPair }> {
    const user = await this.usersRepository.findByEmail(dto.email);
    if (!user || !user.passwordHash || !(await argon2.verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    this.assertCanAuthenticate(user);
    await this.usersRepository.touchLastActive(user._id);
    const tokens = await this.issueTokenPair(user, metadata);
    return { user: this.usersService.toPublicUser(user), tokens };
  }

  async refresh(refreshToken: string | undefined, metadata: RequestMetadata): Promise<TokenPair> {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh session');
    }

    const tokenHash = this.hashToken(refreshToken);
    const oldSession = await this.authRepository.findSessionByHash(tokenHash);
    if (!oldSession) {
      throw new UnauthorizedException('Invalid refresh session');
    }
    if (oldSession.status !== 'Active' || oldSession.expiresAt <= new Date()) {
      await this.authRepository.revokeFamily(oldSession.familyId, 'Reused');
      throw new UnauthorizedException('Refresh session was revoked');
    }

    const user = await this.usersRepository.getById(oldSession.userId);
    this.assertCanAuthenticate(user);
    const nextRefreshToken = this.createOpaqueToken();
    const nextSessionId = randomUUID();
    const replaced = await this.authRepository.replaceActiveSession(tokenHash, nextSessionId);
    if (!replaced) {
      await this.authRepository.revokeFamily(oldSession.familyId, 'Reused');
      throw new UnauthorizedException('Refresh session was already used');
    }

    await this.authRepository.createSession({
      _id: nextSessionId,
      userId: user._id,
      familyId: oldSession.familyId,
      tokenHash: this.hashToken(nextRefreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      userAgent: metadata.userAgent,
      ip: metadata.ip,
    });

    return {
      accessToken: await this.signAccessToken(user, nextSessionId),
      refreshToken: nextRefreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  async logout(refreshToken: string | undefined): Promise<{ success: true }> {
    if (refreshToken) {
      const session = await this.authRepository.findSessionByHash(this.hashToken(refreshToken));
      if (session) {
        await this.authRepository.revokeFamily(session.familyId);
      }
    }
    return { success: true };
  }

  async revokeUserSessions(userId: string): Promise<{ success: true }> {
    await this.usersRepository.getById(userId);
    await this.authRepository.revokeUserSessions(userId);
    return { success: true };
  }

  async validateInvite(token: string) {
    const invite = await this.authRepository.findInviteByHash(this.hashToken(token));
    if (!invite || invite.usedAt || invite.expiresAt <= new Date()) {
      throw new BadRequestException('Invite is invalid or expired');
    }
    const user = await this.usersRepository.getById(invite.userId);
    return {
      email: user.email,
      name: user.name,
      status: user.status,
      expiresAt: invite.expiresAt,
    };
  }

  async activate(dto: ActivateInviteDto, metadata: RequestMetadata) {
    this.assertPasswordPolicy(dto.password);
    const invite = await this.authRepository.consumeInviteToken(this.hashToken(dto.token));
    if (!invite) {
      throw new BadRequestException('Invite is invalid or expired');
    }
    const user = await this.usersRepository.getById(invite.userId);
    if (user.status !== 'Invited') {
      throw new BadRequestException('Invite is no longer applicable');
    }
    const passwordHash = await this.hashPassword(dto.password);
    const activeUser = await this.usersRepository.update(user._id, {
      passwordHash,
      status: 'Active',
      name: dto.name ?? user.name,
      passwordChangedAt: new Date(),
      mustChangePassword: false,
    });
    await this.authRepository.invalidateInvitesForUser(user._id);
    const tokens = await this.issueTokenPair(activeUser, metadata);
    return { user: this.usersService.toPublicUser(activeUser), tokens };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.usersRepository.findByEmail(dto.email);
    if (!user || user.status !== 'Active') {
      return { accepted: true, emailSent: false };
    }

    const token = this.createOpaqueToken();
    await this.authRepository.invalidatePasswordResetsForUser(user._id);
    await this.authRepository.createPasswordResetToken({
      userId: user._id,
      tokenHash: this.hashToken(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
    });

    const sent = await this.emailAdapter.sendPasswordReset({ to: user.email, name: user.name, token });
    return this.deliveryResponse(sent.sent, sent.reason, { resetToken: token });
  }

  async sendPasswordResetForUser(userId: string) {
    const user = await this.usersRepository.getById(userId);
    if (user.status !== 'Active') {
      throw new BadRequestException('Only active users can receive password reset links');
    }
    const token = this.createOpaqueToken();
    await this.authRepository.invalidatePasswordResetsForUser(user._id);
    await this.authRepository.createPasswordResetToken({
      userId: user._id,
      tokenHash: this.hashToken(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
    });
    const sent = await this.emailAdapter.sendPasswordReset({ to: user.email, name: user.name, token });
    return this.deliveryResponse(sent.sent, sent.reason, { resetToken: token });
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ success: true }> {
    this.assertPasswordPolicy(dto.newPassword);
    const reset = await this.authRepository.consumePasswordResetToken(this.hashToken(dto.token));
    if (!reset) {
      throw new BadRequestException('Reset token is invalid or expired');
    }
    const user = await this.usersRepository.getById(reset.userId);
    this.assertCanAuthenticate(user);
    await this.usersRepository.setPassword(user._id, await this.hashPassword(dto.newPassword));
    await this.authRepository.invalidatePasswordResetsForUser(user._id);
    await this.authRepository.revokeUserSessions(user._id);
    return { success: true };
  }

  async changePassword(actor: Actor, dto: ChangePasswordDto): Promise<{ success: true }> {
    this.assertPasswordPolicy(dto.newPassword);
    const user = await this.usersRepository.getById(actor.id);
    if (!user.passwordHash || !(await argon2.verify(user.passwordHash, dto.currentPassword))) {
      throw new UnauthorizedException('Current password is invalid');
    }
    await this.usersRepository.setPassword(user._id, await this.hashPassword(dto.newPassword));
    await this.authRepository.revokeUserSessions(user._id);
    return { success: true };
  }

  async inviteUser(actor: Actor, dto: InviteUserDto) {
    if (actor.role !== 'Admin') {
      throw new ForbiddenException('Admin role required');
    }
    const user = await this.usersService.createInvitedUser(dto, actor.id);
    const invite = await this.createInviteForUser(user, actor.id);
    const sent = await this.emailAdapter.sendInvite({ to: user.email, name: user.name, token: invite.token });
    return {
      user: this.usersService.toPublicUser(user),
      ...this.deliveryResponse(sent.sent, sent.reason, { activationToken: invite.token }),
    };
  }

  async resendInvite(actor: Actor, userId: string) {
    if (actor.role !== 'Admin') {
      throw new ForbiddenException('Admin role required');
    }
    const user = await this.usersRepository.getById(userId);
    if (user.status !== 'Invited') {
      throw new BadRequestException('Only invited users can receive a new invite');
    }
    await this.authRepository.invalidateInvitesForUser(user._id);
    const invite = await this.createInviteForUser(user, actor.id);
    const sent = await this.emailAdapter.sendInvite({ to: user.email, name: user.name, token: invite.token });
    return this.deliveryResponse(sent.sent, sent.reason, { activationToken: invite.token });
  }

  async bootstrapDevelopmentAdmin(): Promise<User | null> {
    if (process.env.NODE_ENV === 'production') {
      return null;
    }
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!email || !password) {
      return null;
    }
    this.assertPasswordPolicy(password);
    const existing = await this.usersRepository.findByEmail(email);
    if (existing) {
      return existing;
    }
    return this.usersRepository.create({
      email,
      name: process.env.BOOTSTRAP_ADMIN_NAME ?? 'Bootstrap Admin',
      role: 'Admin',
      status: 'Active',
      passwordHash: await this.hashPassword(password),
      passwordChangedAt: new Date(),
      onboarding: { minimumComplete: true, checklist: {} },
    });
  }

  private async createInviteForUser(user: User, createdByUserId: string) {
    const token = this.createOpaqueToken();
    await this.authRepository.createInviteToken({
      userId: user._id,
      tokenHash: this.hashToken(token),
      expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
      createdByUserId,
    });
    return { token };
  }

  private async issueTokenPair(user: User, metadata: RequestMetadata): Promise<TokenPair> {
    const refreshToken = this.createOpaqueToken();
    const session = await this.authRepository.createSession({
      userId: user._id,
      familyId: randomUUID(),
      tokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      userAgent: metadata.userAgent,
      ip: metadata.ip,
    });
    return {
      accessToken: await this.signAccessToken(user, session._id),
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  private signAccessToken(user: User, sessionId: string): Promise<string> {
    return this.jwtService.signAsync(
      { sub: user._id, email: user.email, role: user.role, sessionId },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );
  }

  private hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  private assertPasswordPolicy(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  private assertCanAuthenticate(user: User): void {
    if (user.status !== 'Active') {
      throw new UnauthorizedException('Account is not available for sign-in');
    }
  }

  private createOpaqueToken(): string {
    return randomBytes(48).toString('base64url');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private deliveryResponse(sent: boolean, reason?: string, devTokens: Record<string, string> = {}) {
    if (!sent && process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(reason ?? 'Email delivery is not available');
    }
    return {
      accepted: sent,
      emailSent: sent,
      ...(sent ? {} : { deliveryError: reason ?? 'Email delivery is not configured' }),
      ...(process.env.NODE_ENV === 'production' ? {} : devTokens),
    };
  }
}
