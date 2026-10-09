import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { JwtService } = require('@nestjs/jwt');
const { AuthService } = require('../src/modules/auth/auth.service.ts');
const { UsersService } = require('../src/modules/users/users.service.ts');

class InMemoryUsersRepository {
  users = new Map();

  normalizeEmail(email) {
    return email.trim().toLowerCase();
  }

  async create(input) {
    const user = {
      _id: input._id ?? crypto.randomUUID(),
      email: this.normalizeEmail(input.email),
      name: input.name,
      role: input.role ?? 'User',
      status: input.status ?? 'Invited',
      locale: input.locale ?? 'ru',
      timezone: input.timezone ?? 'Europe/Moscow',
      uiSettings: input.uiSettings ?? {},
      notificationSettings: input.notificationSettings ?? {},
      aiPreferences: input.aiPreferences ?? {},
      inviteDefaults: input.inviteDefaults ?? { starterProfile: true, defaultPrompts: true, notifications: true },
      onboarding: input.onboarding ?? { minimumComplete: false, checklist: {} },
      telegram: input.telegram ?? { linked: false },
      passwordHash: input.passwordHash,
      passwordChangedAt: input.passwordChangedAt,
      mustChangePassword: input.mustChangePassword ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.users.set(user._id, user);
    return { ...user };
  }

  async findByEmail(email) {
    const normalized = this.normalizeEmail(email);
    return [...this.users.values()].find((user) => user.email === normalized && !user.deletedAt) ?? null;
  }

  async findById(id) {
    const user = this.users.get(id);
    return user && !user.deletedAt ? { ...user } : null;
  }

  async getById(id) {
    const user = await this.findById(id);
    if (!user) throw new Error('User not found');
    return user;
  }

  async update(id, input) {
    const existing = this.users.get(id);
    if (!existing) throw new Error('User not found');
    Object.assign(existing, input, { updatedAt: new Date() });
    return { ...existing };
  }

  async setPassword(id, passwordHash, mustChangePassword = false) {
    return this.update(id, { passwordHash, passwordChangedAt: new Date(), mustChangePassword });
  }

  async touchLastActive(id) {
    const existing = this.users.get(id);
    if (existing) existing.lastActiveAt = new Date();
  }
}

class InMemoryAuthRepository {
  sessions = [];
  invites = [];
  resets = [];

  async createSession(input) {
    const session = {
      _id: input._id ?? crypto.randomUUID(),
      status: 'Active',
      ...input,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.push(session);
    return { ...session };
  }

  async findSessionByHash(tokenHash) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    return session ? { ...session } : null;
  }

  async replaceActiveSession(tokenHash, nextSessionId) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash && item.status === 'Active' && item.expiresAt > new Date());
    if (!session) return null;
    session.status = 'Replaced';
    session.rotatedAt = new Date();
    session.replacedBySessionId = nextSessionId;
    return { ...session };
  }

  async revokeSession(tokenHash) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash && item.status === 'Active');
    if (session) {
      session.status = 'Revoked';
      session.revokedAt = new Date();
    }
  }

  async revokeFamily(familyId, status = 'Revoked') {
    for (const session of this.sessions) {
      if (session.familyId === familyId && ['Active', 'Replaced'].includes(session.status)) {
        session.status = status;
        session.revokedAt = new Date();
      }
    }
  }

  async revokeUserSessions(userId) {
    for (const session of this.sessions) {
      if (session.userId === userId && ['Active', 'Replaced'].includes(session.status)) {
        session.status = 'Revoked';
        session.revokedAt = new Date();
      }
    }
  }

  async createInviteToken(input) {
    const invite = { _id: crypto.randomUUID(), ...input };
    this.invites.push(invite);
    return { ...invite };
  }

  async findInviteByHash(tokenHash) {
    const invite = this.invites.find((item) => item.tokenHash === tokenHash);
    return invite ? { ...invite } : null;
  }

  async consumeInviteToken(tokenHash) {
    const invite = this.invites.find((item) => item.tokenHash === tokenHash && !item.usedAt && item.expiresAt > new Date());
    if (!invite) return null;
    invite.usedAt = new Date();
    return { ...invite };
  }

  async invalidateInvitesForUser(userId) {
    for (const invite of this.invites) {
      if (invite.userId === userId && !invite.usedAt) invite.usedAt = new Date();
    }
  }

  async createPasswordResetToken(input) {
    const reset = { _id: crypto.randomUUID(), ...input };
    this.resets.push(reset);
    return { ...reset };
  }

  async consumePasswordResetToken(tokenHash) {
    const reset = this.resets.find((item) => item.tokenHash === tokenHash && !item.usedAt && item.expiresAt > new Date());
    if (!reset) return null;
    reset.usedAt = new Date();
    return { ...reset };
  }

  async invalidatePasswordResetsForUser(userId) {
    for (const reset of this.resets) {
      if (reset.userId === userId && !reset.usedAt) reset.usedAt = new Date();
    }
  }
}

function makeAuthBlock() {
  const usersRepository = new InMemoryUsersRepository();
  const authRepository = new InMemoryAuthRepository();
  const usersService = new UsersService(usersRepository);
  const sent = { invites: [], resets: [] };
  const emailAdapter = {
    async sendInvite(input) {
      sent.invites.push(input);
      return { sent: true };
    },
    async sendPasswordReset(input) {
      sent.resets.push(input);
      return { sent: true };
    },
  };
  const authService = new AuthService(
    authRepository,
    usersRepository,
    usersService,
    new JwtService({ secret: process.env.JWT_SECRET }),
    emailAdapter,
  );
  return { authRepository, authService, sent, usersRepository };
}

test('auth block handles invite activation, login, refresh rotation and replay revoke', async () => {
  const { authRepository, authService, sent } = makeAuthBlock();
  const admin = await authService.bootstrapDevelopmentAdmin();
  assert.equal(admin, null);

  const usersRepository = authService.usersRepository;
  const adminUser = await usersRepository.create({
    email: 'admin@intly.local',
    name: 'Admin',
    role: 'Admin',
    status: 'Active',
    passwordHash: await authService.hashPassword('Admin-password-123'),
    onboarding: { minimumComplete: true, checklist: {} },
  });

  const invite = await authService.inviteUser(
    { id: adminUser._id, email: adminUser.email, role: 'Admin' },
    { email: 'User@INTLY.local', name: 'User One', role: 'User' },
  );
  assert.equal(invite.emailSent, true);
  assert.equal(sent.invites.length, 1);

  const activation = await authService.activate(
    { token: sent.invites[0].token, password: 'User-password-123' },
    { userAgent: 'node-test', ip: '127.0.0.1' },
  );
  assert.equal(activation.user.status, 'Active');
  assert.equal(activation.user.email, 'user@intly.local');

  const login = await authService.login(
    { email: 'USER@intly.local', password: 'User-password-123' },
    { userAgent: 'node-test', ip: '127.0.0.1' },
  );
  assert.ok(login.tokens.accessToken);

  const firstRefresh = login.tokens.refreshToken;
  const rotated = await authService.refresh(firstRefresh, { userAgent: 'node-test', ip: '127.0.0.1' });
  const replayedFamilyId = authRepository.sessions.find((session) => session.status === 'Replaced')?.familyId;
  assert.notEqual(rotated.refreshToken, firstRefresh);
  await assert.rejects(() => authService.refresh(firstRefresh, { userAgent: 'node-test', ip: '127.0.0.1' }));
  assert.equal(authRepository.sessions.filter((session) => session.familyId === replayedFamilyId).every((session) => session.status !== 'Active'), true);
});

test('admin invite applies initial defaults to the invited account once', async () => {
  const { authService, sent, usersRepository } = makeAuthBlock();
  const adminUser = await usersRepository.create({
    email: 'admin-defaults@intly.local',
    name: 'Defaults Admin',
    role: 'Admin',
    status: 'Active',
    passwordHash: await authService.hashPassword('Admin-password-123'),
    onboarding: { minimumComplete: true, checklist: {} },
  });

  const invite = await authService.inviteUser(
    { id: adminUser._id, email: adminUser.email, role: 'Admin' },
    {
      email: 'defaults-user@intly.local',
      name: 'Defaults User',
      role: 'User',
      locale: 'en',
      timezone: 'Europe/Volgograd',
      inviteDefaults: {
        starterProfile: false,
        defaultPrompts: true,
        notifications: false,
      },
    },
  );

  assert.deepEqual(invite.user.inviteDefaults, {
    starterProfile: false,
    defaultPrompts: true,
    notifications: false,
  });
  assert.equal(invite.user.locale, 'en');
  assert.equal(invite.user.timezone, 'Europe/Volgograd');
  assert.equal(invite.user.notificationSettings.inApp, false);
  assert.equal(invite.user.notificationSettings.email, false);
  assert.equal(invite.user.notificationSettings.telegram, false);
  assert.equal(invite.user.aiPreferences.language, 'en');
  assert.match(invite.user.aiPreferences.userPrompt, /INTLY match criteria/);
  assert.deepEqual(invite.user.onboarding.checklist.inviteDefaults, invite.user.inviteDefaults);
  assert.equal(invite.user.onboarding.checklist.starterProfilePreset, false);
  assert.equal(invite.user.onboarding.checklist.defaultPromptsPreset, true);
  assert.equal(invite.user.onboarding.checklist.notificationDefaults, false);

  const stored = await usersRepository.getById(invite.user.id);
  assert.deepEqual(stored.inviteDefaults, invite.user.inviteDefaults);
  assert.equal(stored.onboarding.minimumComplete, false);

  const activation = await authService.activate(
    { token: sent.invites[0].token, password: 'User-password-123' },
    { userAgent: 'node-test', ip: '127.0.0.1' },
  );
  assert.equal(activation.user.status, 'Active');
  assert.deepEqual(activation.user.inviteDefaults, invite.user.inviteDefaults);
  assert.equal(activation.user.onboarding.minimumComplete, false);
});

test('password reset is one-time and revokes active refresh sessions', async () => {
  const { authRepository, authService, sent, usersRepository } = makeAuthBlock();
  const user = await usersRepository.create({
    email: 'reset@intly.local',
    name: 'Reset User',
    role: 'User',
    status: 'Active',
    passwordHash: await authService.hashPassword('Old-password-123'),
  });
  const login = await authService.login(
    { email: user.email, password: 'Old-password-123' },
    { userAgent: 'node-test', ip: '127.0.0.1' },
  );

  const accepted = await authService.forgotPassword({ email: user.email });
  assert.equal(accepted.emailSent, true);
  assert.equal(sent.resets.length, 1);

  await authService.resetPassword({ token: sent.resets[0].token, newPassword: 'New-password-123' });
  assert.equal(authRepository.sessions.every((session) => session.status === 'Revoked'), true);
  await assert.rejects(() => authService.refresh(login.tokens.refreshToken, { userAgent: 'node-test', ip: '127.0.0.1' }));
  await assert.rejects(() => authService.resetPassword({ token: sent.resets[0].token, newPassword: 'New-password-456' }));

  const nextLogin = await authService.login(
    { email: user.email, password: 'New-password-123' },
    { userAgent: 'node-test', ip: '127.0.0.1' },
  );
  assert.ok(nextLogin.tokens.accessToken);
});
