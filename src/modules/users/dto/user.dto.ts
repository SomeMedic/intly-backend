import { IsBoolean, IsIn, IsObject, IsOptional, IsString, IsTimeZone, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { UpdateNotificationSettingsDto } from '../../notifications/dto/notification.dto';
import { USER_ROLES, USER_STATUSES, UserRole, UserStatus } from '../schemas/user.schema';

const LOCALES = ['ru', 'en'] as const;
const THEMES = ['light', 'dark', 'system'] as const;
const DENSITIES = ['compact', 'comfortable'] as const;
const THEME_PACKS = ['intly-plum', 'forest-teal', 'warm-clay', 'graphite-copper'] as const;

export class ExportDefaultsDto {
  @IsOptional()
  @IsIn(['csv', 'xlsx', 'json'])
  format?: 'csv' | 'xlsx' | 'json';
}

export class UiSettingsDto {
  @IsOptional()
  @IsIn(THEME_PACKS)
  themePack?: (typeof THEME_PACKS)[number];

  @IsOptional()
  @IsIn(THEMES)
  theme?: (typeof THEMES)[number];

  @IsOptional()
  @IsIn(DENSITIES)
  density?: (typeof DENSITIES)[number];

  @IsOptional()
  @IsBoolean()
  reducedMotion?: boolean;

  @IsOptional()
  @IsObject()
  dashboard?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => ExportDefaultsDto)
  exportDefaults?: ExportDefaultsDto;
}

export class NotificationSettingsDto extends UpdateNotificationSettingsDto {}

export class AiPreferencesDto {
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  userPreferences?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  customPrompt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  userPrompt?: string;

  @IsOptional()
  @IsString()
  @IsIn(LOCALES)
  language?: string;
}

export class UpdateMeSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsIn(LOCALES)
  locale?: (typeof LOCALES)[number];

  @IsOptional()
  @IsString()
  @IsTimeZone()
  timezone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => UiSettingsDto)
  uiSettings?: UiSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationSettingsDto)
  notificationSettings?: NotificationSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiPreferencesDto)
  aiPreferences?: AiPreferencesDto;
}

export class UpdateOnboardingDto {
  @IsOptional()
  @IsBoolean()
  minimumComplete?: boolean;

  @IsOptional()
  @IsObject()
  checklist?: Record<string, unknown>;
}

export class AdminUpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;

  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatus;

  @IsOptional()
  @IsIn(LOCALES)
  locale?: (typeof LOCALES)[number];

  @IsOptional()
  @IsString()
  @IsTimeZone()
  timezone?: string;
}

export class AdminSetStatusDto {
  @IsIn(USER_STATUSES)
  status!: UserStatus;
}

export class AdminChangeRoleDto {
  @IsIn(USER_ROLES)
  role!: UserRole;
}
