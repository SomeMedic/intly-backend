import { ForbiddenException, Injectable } from '@nestjs/common';

import { Actor } from '../../common/access';
import { validateAiUserPromptPlaceholders } from '../ai/ai-user-preferences';
import { validateNotificationSettingsPatch } from '../notifications/dto/notification.dto';
import { InviteUserDto } from '../auth/dto/auth.dto';
import { AdminChangeRoleDto, AdminSetStatusDto, AdminUpdateUserDto, UpdateMeSettingsDto, UpdateOnboardingDto } from './dto/user.dto';
import { DEFAULT_INVITE_DEFAULTS, DEFAULT_NOTIFICATION_SETTINGS, DEFAULT_UI_SETTINGS, User, UserRole, UserStatus } from './schemas/user.schema';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
  ) {}

  findById(id: string) {
    return this.usersRepository.findById(id);
  }

  getById(id: string) {
    return this.usersRepository.getById(id);
  }

  findByEmail(email: string) {
    return this.usersRepository.findByEmail(email);
  }

  createInvitedUser(input: InviteUserDto, invitedByUserId: string) {
    const inviteDefaults = {
      ...DEFAULT_INVITE_DEFAULTS,
      ...(input.inviteDefaults ?? {}),
    };
    const locale = input.locale ?? 'ru';
    const notificationSettings = inviteDefaults.notifications
      ? { ...DEFAULT_NOTIFICATION_SETTINGS }
      : { ...DEFAULT_NOTIFICATION_SETTINGS, inApp: false, email: false, telegram: false };
    return this.usersRepository.create({
      email: input.email,
      name: input.name,
      role: input.role ?? 'User',
      status: 'Invited',
      locale,
      timezone: input.timezone ?? 'Europe/Moscow',
      uiSettings: { ...DEFAULT_UI_SETTINGS },
      notificationSettings,
      aiPreferences: inviteDefaults.defaultPrompts
        ? {
            language: locale,
            userPrompt: 'Use my profile, knowledge base, selected sources and INTLY match criteria before drafting or ranking opportunities.',
          }
        : { language: locale },
      inviteDefaults,
      onboarding: {
        minimumComplete: false,
        checklist: {
          invitedByUserId,
          inviteDefaults,
          language: true,
          timezone: input.timezone ?? 'Europe/Moscow',
          starterProfilePreset: inviteDefaults.starterProfile,
          defaultPromptsPreset: inviteDefaults.defaultPrompts,
          notificationDefaults: inviteDefaults.notifications,
        },
      },
    });
  }

  async getMe(actor: Actor): Promise<User> {
    return this.usersRepository.getById(actor.id);
  }

  async getSettings(actor: Actor) {
    return this.toSettings(await this.getMe(actor));
  }

  async updateSettings(actor: Actor, dto: UpdateMeSettingsDto) {
    if (dto.aiPreferences) {
      for (const field of ['userPreferences', 'customPrompt', 'userPrompt'] as const) {
        validateAiUserPromptPlaceholders(dto.aiPreferences[field]);
      }
    }
    const input: Partial<User> & Record<string, unknown> = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
      ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
    };
    if (dto.notificationSettings) {
      Object.assign(input, validateNotificationSettingsPatch(dto.notificationSettings, { partial: true }).set);
    }
    for (const group of ['uiSettings', 'aiPreferences'] as const) {
      for (const [key, value] of Object.entries(dto[group] ?? {})) {
        if (value !== undefined) input[`${group}.${key}`] = value;
      }
    }
    const updated = await this.usersRepository.update(actor.id, input);
    return this.toSettings(updated);
  }

  async getOnboarding(actor: Actor) {
    const user = await this.getMe(actor);
    return user.onboarding;
  }

  async updateOnboarding(actor: Actor, dto: UpdateOnboardingDto) {
    const current = await this.getMe(actor);
    const onboarding = {
      minimumComplete: dto.minimumComplete ?? current.onboarding?.minimumComplete ?? false,
      checklist: {
        ...(current.onboarding?.checklist ?? {}),
        ...(dto.checklist ?? {}),
      },
    };
    const updated = await this.usersRepository.update(actor.id, { onboarding });
    return updated.onboarding;
  }

  async listAdmin(params: { query?: string; role?: string; status?: string; limit?: number; cursor?: string; inviteState?: string; createdFrom?: string; createdTo?: string; sort?: string }) {
    const page = await this.usersRepository.list({
      ...params,
      includeDeleted: true,
      inviteState: this.allowed(params.inviteState, ['pending', 'accepted']),
      createdFrom: this.dateParam(params.createdFrom),
      createdTo: this.dateParam(params.createdTo),
      sort: this.allowed(params.sort, ['createdAt:asc', 'createdAt:desc', 'lastActiveAt:asc', 'lastActiveAt:desc', 'name:asc', 'name:desc']),
    });
    return { ...page, items: page.items.map((user) => this.toPublicUser(user)) };
  }

  async getAdmin(id: string) {
    return this.toPublicUser(await this.usersRepository.getById(id, { includeDeleted: true }));
  }

  async updateAdmin(id: string, dto: AdminUpdateUserDto) {
    return this.toPublicUser(await this.usersRepository.update(id, dto));
  }

  async setStatus(id: string, dto: AdminSetStatusDto) {
    return this.toPublicUser(await this.usersRepository.update(id, {
      status: dto.status,
      deletedAt: dto.status === 'Deleted' ? new Date() : undefined,
    }));
  }

  async changeRole(id: string, dto: AdminChangeRoleDto) {
    return this.toPublicUser(await this.usersRepository.update(id, { role: dto.role }));
  }

  assertCanReadUser(actor: Actor, userId: string): void {
    if (actor.role !== 'Admin' && actor.id !== userId) {
      throw new ForbiddenException('User scope violation');
    }
  }

  toActor(user: User, sessionId?: string): Actor {
    return {
      id: user._id,
      email: user.email,
      role: user.role,
      sessionId,
    };
  }

  toPublicUser(user: User) {
    return {
      id: user._id,
      email: user.email,
      name: user.name,
      role: user.role as UserRole,
      status: user.status as UserStatus,
      locale: user.locale,
      timezone: user.timezone,
      uiSettings: user.uiSettings,
      notificationSettings: user.notificationSettings,
      aiPreferences: user.aiPreferences,
      inviteDefaults: user.inviteDefaults,
      onboarding: user.onboarding,
      telegram: { linked: Boolean(user.telegram?.linked) },
      lastActiveAt: user.lastActiveAt,
      createdAt: (user as User & { createdAt?: Date }).createdAt,
      updatedAt: (user as User & { updatedAt?: Date }).updatedAt,
    };
  }

  private toSettings(user: User) {
    return {
      name: user.name,
      email: user.email,
      status: user.status,
      locale: user.locale,
      timezone: user.timezone,
      uiSettings: user.uiSettings,
      notificationSettings: user.notificationSettings,
      aiPreferences: user.aiPreferences,
      telegram: { linked: Boolean(user.telegram?.linked) },
    };
  }

  private allowed<T extends string>(value: string | undefined, values: readonly T[]): T | undefined {
    return values.includes(value as T) ? value as T : undefined;
  }

  private dateParam(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
}
