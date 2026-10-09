import { BadRequestException } from '@nestjs/common';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export const NOTIFICATION_CATEGORIES = ['opportunity', 'ai', 'workflow', 'collaboration', 'system', 'admin'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_LIST_FILTERS = ['all', 'unread', 'system', 'opportunities', 'tasks', 'archived', 'ai', 'workflow', 'collaboration', 'admin'] as const;
export type NotificationListFilter = (typeof NOTIFICATION_LIST_FILTERS)[number];

export const NOTIFICATION_DIGEST_MODES = ['instant', 'daily', 'weekly', 'digest'] as const;
export type NotificationDigestMode = (typeof NOTIFICATION_DIGEST_MODES)[number];

export type NotificationEventChannels = Record<NotificationCategory, {
  inApp?: boolean;
  email?: boolean;
  telegram?: boolean;
  mode?: 'instant' | 'digest';
}>;

export type NotificationSettings = {
  inApp: boolean;
  email: boolean;
  telegram: boolean;
  digestMode: 'instant' | 'daily' | 'weekly' | 'digest';
  quietHours: { start: string; end: string; timezone?: string } | null;
  eventChannels: Partial<NotificationEventChannels>;
};

export type NotificationSettingsPatch = {
  set: Record<string, unknown>;
  unset: Record<string, ''>;
  settings: Partial<NotificationSettings>;
};

export class NotificationListQueryDto {
  @IsOptional()
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional()
  @IsIn(NOTIFICATION_LIST_FILTERS)
  filter?: NotificationListFilter;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}

export class UpdateNotificationSettingsDto {
  @IsOptional()
  @IsBoolean()
  inApp?: boolean;

  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  telegram?: boolean;

  @IsOptional()
  @IsIn(NOTIFICATION_DIGEST_MODES)
  digestMode?: NotificationDigestMode;

  @IsOptional()
  @IsObject()
  quietHours?: { start?: string; end?: string; timezone?: string } | null;

  @IsOptional()
  @IsObject()
  eventChannels?: Partial<NotificationEventChannels>;
}

export class ArchiveNotificationDto {
  @IsBoolean()
  archived!: boolean;
}

export class TelegramLinkDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  botUsername?: string;
}

export function normalizeNotificationSettings(value: unknown): NotificationSettings {
  const raw = recordValue(value) ?? {};
  return {
    inApp: boolOrDefault(raw.inApp, true, 'notificationSettings.inApp'),
    email: boolOrDefault(raw.email, false, 'notificationSettings.email'),
    telegram: boolOrDefault(raw.telegram, false, 'notificationSettings.telegram'),
    digestMode: validateDigestMode(raw.digestMode, 'notificationSettings.digestMode'),
    quietHours: validateQuietHours(raw.quietHours, 'notificationSettings.quietHours'),
    eventChannels: validateEventChannels(raw.eventChannels, 'notificationSettings.eventChannels'),
  };
}

export function validateNotificationSettingsPatch(value: unknown, options: { partial?: boolean } = {}): NotificationSettingsPatch {
  const raw = recordValue(value);
  if (!raw) throw new BadRequestException('Notification settings must be an object');
  const allowed = new Set(['inApp', 'email', 'telegram', 'digestMode', 'quietHours', 'eventChannels']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new BadRequestException(`Unsupported notification setting: ${key}`);
  }
  const settings: Partial<NotificationSettings> = {};
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  const root = 'notificationSettings';

  if (raw.inApp !== undefined || !options.partial) {
    settings.inApp = boolOrDefault(raw.inApp, true, `${root}.inApp`);
    set[`${root}.inApp`] = settings.inApp;
  }
  if (raw.email !== undefined || !options.partial) {
    settings.email = boolOrDefault(raw.email, false, `${root}.email`);
    set[`${root}.email`] = settings.email;
  }
  if (raw.telegram !== undefined || !options.partial) {
    settings.telegram = boolOrDefault(raw.telegram, false, `${root}.telegram`);
    set[`${root}.telegram`] = settings.telegram;
  }
  if (raw.digestMode !== undefined || !options.partial) {
    settings.digestMode = validateDigestMode(raw.digestMode, `${root}.digestMode`);
    set[`${root}.digestMode`] = settings.digestMode;
  }
  if (raw.quietHours !== undefined || !options.partial) {
    settings.quietHours = validateQuietHours(raw.quietHours, `${root}.quietHours`);
    set[`${root}.quietHours`] = settings.quietHours;
  }
  if (raw.eventChannels !== undefined || !options.partial) {
    settings.eventChannels = validateEventChannels(raw.eventChannels, `${root}.eventChannels`);
    if (raw.eventChannels === null || raw.eventChannels === undefined) {
      set[`${root}.eventChannels`] = {};
    } else {
      for (const [category, config] of Object.entries(settings.eventChannels ?? {})) {
        set[`${root}.eventChannels.${category}`] = config;
      }
    }
  }
  return { set, unset, settings };
}

function validateEventChannels(value: unknown, path: string): Partial<NotificationEventChannels> {
  if (value === null || value === undefined) return {};
  const raw = recordValue(value);
  if (!raw) throw new BadRequestException(`${path} must be an object`);
  const result: Partial<NotificationEventChannels> = {};
  for (const [category, config] of Object.entries(raw)) {
    if (!isNotificationCategory(category)) throw new BadRequestException(`${path}.${category} is not a supported notification category`);
    const categoryConfig = recordValue(config);
    if (!categoryConfig) throw new BadRequestException(`${path}.${category} must be an object`);
    const allowed = new Set(['inApp', 'email', 'telegram', 'mode']);
    for (const key of Object.keys(categoryConfig)) {
      if (!allowed.has(key)) throw new BadRequestException(`${path}.${category}.${key} is not supported`);
    }
    result[category] = {
      ...('inApp' in categoryConfig ? { inApp: boolRequired(categoryConfig.inApp, `${path}.${category}.inApp`) } : {}),
      ...('email' in categoryConfig ? { email: boolRequired(categoryConfig.email, `${path}.${category}.email`) } : {}),
      ...('telegram' in categoryConfig ? { telegram: boolRequired(categoryConfig.telegram, `${path}.${category}.telegram`) } : {}),
      ...('mode' in categoryConfig ? { mode: validateEventMode(categoryConfig.mode, `${path}.${category}.mode`) } : {}),
    };
  }
  return result;
}

function validateQuietHours(value: unknown, path: string): NotificationSettings['quietHours'] {
  if (value === null || value === undefined) return null;
  const raw = recordValue(value);
  if (!raw) throw new BadRequestException(`${path} must be an object or null`);
  const allowed = new Set(['start', 'end', 'timezone']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new BadRequestException(`${path}.${key} is not supported`);
  }
  const start = typeof raw.start === 'string' ? raw.start : '';
  const end = typeof raw.end === 'string' ? raw.end : '';
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
    throw new BadRequestException(`${path} must use HH:mm time`);
  }
  const startMinutes = minutesOfDay(start);
  const endMinutes = minutesOfDay(end);
  if (startMinutes === null || endMinutes === null) throw new BadRequestException(`${path} time is invalid`);
  if (startMinutes === endMinutes) throw new BadRequestException(`${path} start and end must differ`);
  const timezone = typeof raw.timezone === 'string' ? raw.timezone : undefined;
  if (timezone) assertTimezone(timezone, `${path}.timezone`);
  return { start, end, ...(timezone ? { timezone } : {}) };
}

function validateDigestMode(value: unknown, path: string): NotificationSettings['digestMode'] {
  if (value === undefined) return 'instant';
  if (value === 'instant' || value === 'daily' || value === 'weekly' || value === 'digest') return value;
  throw new BadRequestException(`${path} is invalid`);
}

function validateEventMode(value: unknown, path: string): 'instant' | 'digest' {
  if (value === 'instant' || value === 'digest') return value;
  throw new BadRequestException(`${path} is invalid`);
}

function boolOrDefault(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  return boolRequired(value, path);
}

function boolRequired(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new BadRequestException(`${path} must be boolean`);
  return value;
}

function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function minutesOfDay(value: string): number | null {
  const [hourValue, minuteValue] = value.split(':').map(Number);
  if (!Number.isInteger(hourValue) || !Number.isInteger(minuteValue) || hourValue < 0 || hourValue > 23 || minuteValue < 0 || minuteValue > 59) return null;
  return hourValue * 60 + minuteValue;
}

function assertTimezone(timezone: string, path: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new BadRequestException(`${path} is invalid`);
  }
}
