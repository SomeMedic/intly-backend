import { BadRequestException, Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { Actor } from '../../common/access';
import { CryptoService } from '../../infrastructure/crypto.service';
import { JobsService } from '../jobs/jobs.service';
import { RealtimeService } from '../realtime/realtime.service';
import { UsersRepository } from '../users/users.repository';
import {
  NotificationCategory,
  NotificationSettings,
  TelegramLinkDto,
  UpdateNotificationSettingsDto,
  normalizeNotificationSettings,
  validateNotificationSettingsPatch,
} from './dto/notification.dto';
import { Notification, NotificationChannel } from './schemas/notification.schema';
import { NotificationListParams, NotificationsRepository } from './notifications.repository';

type ExternalChannel = Extract<NotificationChannel, 'email' | 'telegram'>;
type DeliveryMode = 'instant' | 'daily' | 'weekly';
type NotifyInput = {
  userId: string;
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
  category?: NotificationCategory;
  channels?: Partial<Record<'inApp' | ExternalChannel, boolean>>;
  mode?: DeliveryMode | 'digest';
};

type NotificationUser = {
  _id: string;
  email: string;
  timezone?: string;
  notificationSettings?: Record<string, unknown>;
  telegram?: { linked: boolean; chatIdEncrypted?: string; linkRequestedAt?: unknown };
};

@Injectable()
export class NotificationsService implements OnModuleInit {
  constructor(
    private readonly notificationsRepository: NotificationsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly realtimeService: RealtimeService,
    private readonly jobsService: JobsService,
    private readonly cryptoService: CryptoService,
  ) {}

  onModuleInit(): void {
    this.jobsService.registerHandler('notifications', 'notification.dispatch', async (data) => this.dispatch(String(data.notificationId)));
    this.jobsService.registerHandler('notifications', 'notification.digest', async (data) => this.dispatchDigest(
      String(data.userId),
      String(data.channel) as ExternalChannel,
      String(data.digestKey),
    ));
  }

  async notify(input: NotifyInput): Promise<Notification & { newlyCreated?: boolean }> {
    const user = await this.usersRepository.getById(input.userId) as NotificationUser;
    const settings = normalizeNotificationSettings(user.notificationSettings ?? {});
    const category = input.category ?? this.categoryForType(input.type);
    const routing = this.resolveRouting(settings, category, input.channels, input.mode);
    const deliveries: Notification['deliveries'] = [];
    for (const channel of ['email', 'telegram'] as const) {
      if (!routing[channel]) continue;
      const schedule = this.deliverySchedule(settings, user, routing.mode);
      deliveries.push({
        channel,
        status: 'queued',
        dispatchAt: schedule.dispatchAt,
        digestKey: schedule.digestKey,
        mode: schedule.mode,
        reason: schedule.reason,
      });
    }
    const { notification, created } = await this.notificationsRepository.createIdempotent({
      userId: input.userId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      category,
      title: input.title,
      body: input.body ?? '',
      data: input.data ?? {},
      deliveries,
      visibleInApp: routing.inApp !== false,
    });
    if (created && routing.inApp !== false) {
      this.realtimeService.publish(input.userId, 'notification.created', { notification });
    }
    await this.enqueueNotificationDeliveries(notification);
    return { ...notification, newlyCreated: created };
  }

  private async enqueueNotificationDeliveries(notification: Notification): Promise<void> {
    const digestJobs = new Set<string>();
    for (const delivery of notification.deliveries ?? []) {
      if (delivery.status !== 'queued') continue;
      const delay = Math.max(0, (delivery.dispatchAt ? new Date(delivery.dispatchAt).getTime() : Date.now()) - Date.now());
      if (delivery.mode === 'instant' || !delivery.mode) {
        await this.jobsService.enqueue('notifications', 'notification.dispatch', { notificationId: notification._id }, { jobId: `notification:${notification._id}`, delay });
        continue;
      }
      if (!delivery.digestKey || (delivery.channel !== 'email' && delivery.channel !== 'telegram')) continue;
      const key = `${delivery.channel}:${delivery.digestKey}`;
      if (digestJobs.has(key)) continue;
      digestJobs.add(key);
      await this.jobsService.enqueue(
        'notifications',
        'notification.digest',
        { userId: notification.userId, channel: delivery.channel, digestKey: delivery.digestKey },
        { jobId: `notification:digest:${notification.userId}:${delivery.channel}:${delivery.digestKey}`, delay },
      );
    }
  }

  list(actor: Actor, query: NotificationListParams) {
    return this.notificationsRepository.list(actor.id, query);
  }

  async markRead(actor: Actor, id: string) {
    const notification = await this.notificationsRepository.markRead(id, actor.id);
    this.realtimeService.publish(actor.id, 'notification.read', { notificationId: notification._id, readAt: notification.readAt });
    return notification;
  }

  async markAllRead(actor: Actor) {
    const result = await this.notificationsRepository.markAllRead(actor.id);
    this.realtimeService.publish(actor.id, 'notification.read_all', { modifiedCount: result.modifiedCount });
    return result;
  }

  async markArchived(actor: Actor, id: string, archived: boolean) {
    const notification = await this.notificationsRepository.markArchived(id, actor.id, archived);
    this.realtimeService.publish(actor.id, 'notification.archived', { notificationId: notification._id, archived, archivedAt: notification.archivedAt });
    return notification;
  }

  async updateSettings(actor: Actor, dto: UpdateNotificationSettingsDto) {
    const patch = validateNotificationSettingsPatch(dto, { partial: true });
    const updated = await this.usersRepository.update(actor.id, patch.set as never);
    return updated.notificationSettings;
  }

  async createTelegramLink(actor: Actor, dto: TelegramLinkDto) {
    const token = randomBytes(24).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.usersRepository.update(actor.id, {
      telegram: {
        linked: false,
        chatIdEncrypted: undefined,
        linkTokenHash: tokenHash,
        linkRequestedAt: new Date(),
      } as never,
    });
    const botUsername = dto.botUsername ?? process.env.TELEGRAM_BOT_USERNAME;
    return {
      status: 'pending',
      token,
      deepLink: botUsername ? `https://t.me/${botUsername}?start=${encodeURIComponent(token)}` : null,
      expiresInSeconds: 15 * 60,
    };
  }



  async confirmTelegramWebhook(update: Record<string, unknown>) {
    const { token, chatId } = this.telegramLinkFromUpdate(update);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const user = await this.usersRepository.findByTelegramLinkTokenHash(tokenHash);
    if (!user) throw new ServiceUnavailableException('Telegram link token is invalid or expired');
    const requestedAt = this.telegramLinkRequestedAt(user.telegram);
    if (!requestedAt || Date.now() - requestedAt.getTime() > 15 * 60_000) {
      throw new ServiceUnavailableException('Telegram link token is invalid or expired');
    }
    await this.usersRepository.update(user._id, {
      telegram: {
        linked: true,
        chatIdEncrypted: this.cryptoService.encrypt(chatId),
        linkedAt: new Date(),
      } as never,
    });
    return { success: true, userId: user._id };
  }

  async unlinkTelegram(actor: Actor) {
    await this.usersRepository.update(actor.id, { telegram: { linked: false } });
    return { success: true };
  }




  private telegramLinkFromUpdate(update: Record<string, unknown>): { token: string; chatId: string } {
    const message = this.recordValue(update.message) ?? this.recordValue(update.edited_message);
    const chat = this.recordValue(message?.chat);
    const chatIdValue = chat?.id;
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    const match = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,200})$/.exec(text);
    if (!match) throw new BadRequestException('Telegram link token is missing');
    if (typeof chatIdValue !== 'string' && typeof chatIdValue !== 'number') {
      throw new BadRequestException('Telegram chat id is missing');
    }
    return { token: match[1], chatId: String(chatIdValue) };
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private telegramLinkRequestedAt(telegram: { linkRequestedAt?: unknown; linked?: boolean; chatIdEncrypted?: string }): Date | null {
    if (!telegram.linkRequestedAt) return null;
    const date = new Date(telegram.linkRequestedAt as string | number | Date);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private async dispatch(notificationId: string): Promise<void> {
    const notification = await this.notificationsRepository.getById(notificationId);
    const user = await this.usersRepository.getById(notification.userId) as NotificationUser;
    const settings = normalizeNotificationSettings(user.notificationSettings ?? {});
    const quietDelay = this.quietHoursDelayMs(settings.quietHours, user.timezone, new Date());
    if (quietDelay > 0 && (notification.deliveries ?? []).some((delivery) => delivery.status === 'queued' && delivery.mode === 'instant')) {
      await this.jobsService.enqueue('notifications', 'notification.dispatch', { notificationId }, { jobId: `notification:${notificationId}:${Date.now()}`, delay: quietDelay });
      return;
    }
    const deliveries = await Promise.all((notification.deliveries ?? []).map(async (delivery) => {
      if (delivery.status === 'sent') return delivery;
      if (delivery.status !== 'queued') return delivery;
      if (delivery.mode && delivery.mode !== 'instant') return delivery;
      if (!this.channelEnabled(settings, notification.category, delivery.channel as ExternalChannel)) {
        return { ...delivery, status: 'skipped' as const, attemptedAt: new Date(), reason: 'Notification channel is disabled' };
      }
      if (delivery.channel === 'email') return { ...delivery, ...await this.sendEmail(user.email, notification) };
      if (delivery.channel === 'telegram') return { ...delivery, ...await this.sendTelegram(user.telegram ?? { linked: false }, notification) };
      return { ...delivery, status: 'skipped' as const, attemptedAt: new Date(), reason: 'Unsupported notification channel' };
    }));
    await this.notificationsRepository.setDeliveries(notification._id, deliveries);
  }

  private async dispatchDigest(userId: string, channel: ExternalChannel, digestKey: string): Promise<void> {
    const user = await this.usersRepository.getById(userId) as NotificationUser;
    const settings = normalizeNotificationSettings(user.notificationSettings ?? {});
    const quietDelay = this.quietHoursDelayMs(settings.quietHours, user.timezone, new Date());
    if (quietDelay > 0) {
      await this.jobsService.enqueue('notifications', 'notification.digest', { userId, channel, digestKey }, { jobId: `notification:digest:${userId}:${channel}:${digestKey}:${Date.now()}`, delay: quietDelay });
      return;
    }
    const notifications = await this.notificationsRepository.listDigest(userId, channel, digestKey);
    const deliverable = notifications.filter((notification) => this.channelEnabled(settings, notification.category, channel));
    if (!deliverable.length) {
      await this.notificationsRepository.setDigestDeliveries(
        notifications.map((notification) => notification._id),
        channel,
        digestKey,
        { channel, status: 'skipped', attemptedAt: new Date(), reason: 'Notification channel is disabled' },
      );
      return;
    }
    const digestNotification = this.digestNotification(deliverable);
    const result = channel === 'email'
      ? await this.sendEmail(user.email, digestNotification)
      : await this.sendTelegram(user.telegram ?? { linked: false }, digestNotification);
    await this.notificationsRepository.setDigestDeliveries(
      deliverable.map((notification) => notification._id),
      channel,
      digestKey,
      { ...result, reason: result.status === 'sent' ? `Included in ${this.digestLabel(digestKey)} digest` : result.reason },
    );
    const skipped = notifications.filter((notification) => !this.channelEnabled(settings, notification.category, channel));
    if (skipped.length) {
      await this.notificationsRepository.setDigestDeliveries(
        skipped.map((notification) => notification._id),
        channel,
        digestKey,
        { channel, status: 'skipped', attemptedAt: new Date(), reason: 'Notification channel is disabled' },
      );
    }
  }

  private async sendEmail(to: string, notification: Notification): Promise<Notification['deliveries'][number]> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    if (!apiKey || !from) {
      return { channel: 'email', status: 'failed', attemptedAt: new Date(), reason: 'RESEND_API_KEY and RESEND_FROM are not configured' };
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: notification.title, html: this.notificationHtml(notification) }),
    });
    return response.ok
      ? { channel: 'email', status: 'sent', attemptedAt: new Date() }
      : { channel: 'email', status: 'failed', attemptedAt: new Date(), reason: `Resend returned ${response.status}` };
  }

  private async sendTelegram(telegram: { linked: boolean; chatIdEncrypted?: string }, notification: Notification): Promise<Notification['deliveries'][number]> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = telegram?.linked && telegram.chatIdEncrypted ? this.cryptoService.decrypt(telegram.chatIdEncrypted) : undefined;
    if (!token || !chatId) {
      return { channel: 'telegram', status: 'failed', attemptedAt: new Date(), reason: 'Telegram bot token or linked chat is not configured' };
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `${notification.title}
${notification.body}`.trim() }),
    });
    return response.ok
      ? { channel: 'telegram', status: 'sent', attemptedAt: new Date() }
      : { channel: 'telegram', status: 'failed', attemptedAt: new Date(), reason: `Telegram returned ${response.status}` };
  }

  private notificationHtml(notification: Notification): string {
    return `<h1>${this.escapeHtml(notification.title)}</h1><p>${this.escapeHtml(notification.body)}</p>`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char] ?? char);
  }

  private resolveRouting(settings: NotificationSettings, category: NotificationCategory, overrides?: NotifyInput['channels'], inputMode?: NotifyInput['mode']): Record<'inApp' | ExternalChannel, boolean> & { mode: DeliveryMode } {
    const event = settings.eventChannels?.[category] ?? {};
    const mode = inputMode === 'daily' || inputMode === 'weekly'
      ? inputMode
      : inputMode === 'digest' || event.mode === 'digest'
        ? this.digestCadence(settings)
        : event.mode === 'instant'
          ? 'instant'
          : this.globalMode(settings);
    return {
      inApp: overrides?.inApp ?? event.inApp ?? settings.inApp !== false,
      email: overrides?.email ?? event.email ?? settings.email === true,
      telegram: overrides?.telegram ?? event.telegram ?? settings.telegram === true,
      mode,
    };
  }

  private globalMode(settings: NotificationSettings): DeliveryMode {
    if (settings.digestMode === 'daily' || settings.digestMode === 'weekly') return settings.digestMode;
    if (settings.digestMode === 'digest') return 'daily';
    return 'instant';
  }

  private digestCadence(settings: NotificationSettings): Exclude<DeliveryMode, 'instant'> {
    return settings.digestMode === 'weekly' ? 'weekly' : 'daily';
  }

  private deliverySchedule(settings: NotificationSettings, user: NotificationUser, mode: DeliveryMode): { mode: DeliveryMode; dispatchAt: Date; digestKey?: string; reason?: string } {
    const now = new Date();
    if (mode === 'daily' || mode === 'weekly') {
      const dispatchAt = this.nextDigestAt(mode, settings.quietHours?.timezone ?? user.timezone, now);
      return { mode, dispatchAt, digestKey: this.digestKey(mode, dispatchAt), reason: `${mode} digest` };
    }
    const quietDelay = this.quietHoursDelayMs(settings.quietHours, user.timezone, now);
    return {
      mode: 'instant',
      dispatchAt: new Date(now.getTime() + quietDelay),
      ...(quietDelay > 0 ? { reason: 'Queued until quiet hours end' } : {}),
    };
  }

  private channelEnabled(settings: NotificationSettings, category: NotificationCategory, channel: ExternalChannel): boolean {
    const event = settings.eventChannels?.[category] ?? {};
    return event[channel] ?? settings[channel] === true;
  }

  private categoryForType(type: string): NotificationCategory {
    if (/^(opportunity|watchlist|response)/.test(type)) return 'opportunity';
    if (/^(ai|resume)/.test(type)) return 'ai';
    if (/^(calendar|task|workflow)/.test(type)) return 'workflow';
    if (/^(comment|mention|collaboration)/.test(type)) return 'collaboration';
    if (/^admin/.test(type)) return 'admin';
    return 'system';
  }

  private quietHoursDelayMs(value: NotificationSettings['quietHours'], userTimezone?: string, now = new Date()): number {
    if (!value) return 0;
    const timezone = value.timezone ?? userTimezone ?? 'Europe/Moscow';
    this.assertTimezone(timezone);
    const start = this.minutesOfDay(value.start);
    const end = this.minutesOfDay(value.end);
    if (start === null || end === null || start === end) return 0;
    const local = this.zonedParts(now, timezone);
    const current = local.hour * 60 + local.minute;
    const sameDay = start < end;
    const inQuiet = sameDay ? current >= start && current < end : current >= start || current < end;
    if (!inQuiet) return 0;
    const endDayOffset = sameDay || current < end ? 0 : 1;
    const endParts = this.addDays({ ...local, hour: Math.floor(end / 60), minute: end % 60 }, endDayOffset);
    return Math.max(0, this.zonedTimeToUtc(endParts, timezone).getTime() - now.getTime());
  }

  private nextDigestAt(mode: Exclude<DeliveryMode, 'instant'>, timezone = 'Europe/Moscow', now = new Date()): Date {
    this.assertTimezone(timezone);
    const local = this.zonedParts(now, timezone);
    const dispatchHour = 9;
    const daysUntilWeekly = mode === 'weekly' ? (8 - local.weekday) % 7 : 0;
    let target = this.addDays({ ...local, hour: dispatchHour, minute: 0 }, daysUntilWeekly);
    let scheduled = this.zonedTimeToUtc(target, timezone);
    if (scheduled.getTime() <= now.getTime()) {
      target = this.addDays(target, mode === 'weekly' ? 7 : 1);
      scheduled = this.zonedTimeToUtc(target, timezone);
    }
    return scheduled;
  }

  private digestKey(mode: DeliveryMode, dispatchAt: Date): string {
    const iso = dispatchAt.toISOString().slice(0, 10);
    return `${mode}:${iso}`;
  }

  private digestLabel(digestKey: string): string {
    return digestKey.startsWith('weekly:') ? 'weekly' : 'daily';
  }

  private digestNotification(notifications: Notification[]): Notification {
    const groups = new Map<NotificationCategory, Notification[]>();
    for (const notification of this.deduplicateDigest(notifications)) {
      const items = groups.get(notification.category) ?? [];
      items.push(notification);
      groups.set(notification.category, items);
    }
    const lines = [...groups.entries()].map(([category, items]) => {
      const titles = items.slice(0, 3).map((item) => item.title).join('; ');
      const extra = items.length > 3 ? ` and ${items.length - 3} more` : '';
      return `${category}: ${titles}${extra}`;
    });
    return {
      _id: `digest:${Date.now()}`,
      userId: notifications[0].userId,
      title: `Intly digest: ${notifications.length} notifications`,
      body: lines.join('\n'),
      type: 'notification.digest',
      category: 'system',
      data: {},
      deliveries: [],
      visibleInApp: false,
    } as Notification;
  }

  private deduplicateDigest(notifications: Notification[]): Notification[] {
    const seen = new Set<string>();
    return notifications.filter((notification) => {
      const opportunityId = typeof notification.data?.opportunityId === 'string' ? notification.data.opportunityId : undefined;
      const key = opportunityId ? `${notification.category}:opportunity:${opportunityId}` : `${notification.category}:${notification.type}:${notification.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private minutesOfDay(value?: string): number | null {
    if (!value) return null;
    const [hourValue, minuteValue] = value.split(':').map(Number);
    if (!Number.isInteger(hourValue) || !Number.isInteger(minuteValue) || hourValue < 0 || hourValue > 23 || minuteValue < 0 || minuteValue > 59) return null;
    return hourValue * 60 + minuteValue;
  }

  private assertTimezone(timezone: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
      throw new BadRequestException('Timezone is invalid');
    }
  }

  private zonedParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return {
      year: Number(value('year')),
      month: Number(value('month')),
      day: Number(value('day')),
      hour: Number(value('hour')),
      minute: Number(value('minute')),
      weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday')),
    };
  }

  private zonedTimeToUtc(parts: { year: number; month: number; day: number; hour: number; minute: number }, timezone: string): Date {
    let timestamp = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const observed = this.zonedParts(new Date(timestamp), timezone);
      const desiredLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
      const observedLocal = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
      timestamp += desiredLocal - observedLocal;
    }
    return new Date(timestamp);
  }

  private addDays(parts: { year: number; month: number; day: number; hour: number; minute: number; weekday?: number }, days: number): { year: number; month: number; day: number; hour: number; minute: number } {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute));
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    };
  }
}
