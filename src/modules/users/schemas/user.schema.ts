import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type UserDocument = HydratedDocument<User>;

export const USER_ROLES = ['Admin', 'User'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['Invited', 'Active', 'Disabled', 'Locked', 'Deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const DEFAULT_UI_SETTINGS = {
  themePack: 'intly-plum',
  theme: 'system',
  density: 'comfortable',
  reducedMotion: false,
};

export const DEFAULT_NOTIFICATION_SETTINGS = {
  inApp: true,
  email: false,
  telegram: false,
  quietHours: null,
  digestMode: 'instant',
};

export const DEFAULT_ONBOARDING = {
  minimumComplete: false,
  checklist: {},
};

export const DEFAULT_INVITE_DEFAULTS = {
  starterProfile: true,
  defaultPrompts: true,
  notifications: true,
};

@Schema(schemaOptions)
export class User {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true })
  email!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, enum: USER_ROLES, default: 'User', index: true })
  role!: UserRole;

  @Prop({ type: String, enum: USER_STATUSES, default: 'Invited', index: true })
  status!: UserStatus;

  @Prop({ type: String })
  passwordHash?: string;

  @Prop({ type: Date })
  passwordChangedAt?: Date;

  @Prop({ type: Boolean, default: false })
  mustChangePassword!: boolean;

  @Prop({ type: String, default: 'ru' })
  locale!: string;

  @Prop({ type: String, default: 'Europe/Moscow' })
  timezone!: string;

  @Prop({ type: Object, default: DEFAULT_UI_SETTINGS })
  uiSettings!: Record<string, unknown>;

  @Prop({ type: Object, default: DEFAULT_NOTIFICATION_SETTINGS })
  notificationSettings!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  aiPreferences!: Record<string, unknown>;

  @Prop({ type: Object, default: DEFAULT_ONBOARDING })
  onboarding!: { minimumComplete: boolean; checklist: Record<string, unknown> };

  @Prop({ type: Object, default: DEFAULT_INVITE_DEFAULTS })
  inviteDefaults!: typeof DEFAULT_INVITE_DEFAULTS;

  @Prop({ type: Object, default: { linked: false } })
  telegram!: { linked: boolean; chatIdEncrypted?: string };

  @Prop({ type: Date })
  lastActiveAt?: Date;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ status: 1, role: 1, createdAt: -1 });
UserSchema.index({ updatedAt: -1 });
