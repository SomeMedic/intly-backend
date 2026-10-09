import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';

import { Actor, CurrentUser, Public } from '../../common/access';
import { ArchiveNotificationDto, TelegramLinkDto, UpdateNotificationSettingsDto } from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

@Controller()
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('notifications')
  list(
    @CurrentUser() actor: Actor,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('filter') filter?: string,
    @Query('archived') archived?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.notificationsService.list(actor, {
      unreadOnly: unreadOnly === 'true',
      filter,
      archived: archived === 'true',
      cursor,
      limit: this.parseLimit(limit),
    });
  }

  @Patch('notifications/:id/read')
  markRead(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.notificationsService.markRead(actor, id);
  }

  @Post('notifications/mark-all-read')
  markAllRead(@CurrentUser() actor: Actor) {
    return this.notificationsService.markAllRead(actor);
  }

  @Patch('notifications/:id/archive')
  markArchived(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: ArchiveNotificationDto) {
    return this.notificationsService.markArchived(actor, id, dto.archived);
  }

  @Patch('notification-settings')
  updateSettings(@CurrentUser() actor: Actor, @Body() dto: UpdateNotificationSettingsDto) {
    return this.notificationsService.updateSettings(actor, dto);
  }

  @Post('telegram/link')
  linkTelegram(@CurrentUser() actor: Actor, @Body() dto: TelegramLinkDto) {
    return this.notificationsService.createTelegramLink(actor, dto);
  }

  @Delete('telegram/link')
  unlinkTelegram(@CurrentUser() actor: Actor) {
    return this.notificationsService.unlinkTelegram(actor);
  }

  @Public()
  @Post('telegram/link/callback')
  confirmTelegramLink(@Req() request: { headers: Record<string, string | string[] | undefined> }, @Body() update: Record<string, unknown>) {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expectedSecret) throw new ServiceUnavailableException('Telegram webhook secret is not configured');
    const providedSecret = request.headers['x-telegram-bot-api-secret-token'];
    if (providedSecret !== expectedSecret) throw new ForbiddenException('Telegram webhook secret is invalid');
    return this.notificationsService.confirmTelegramWebhook(update);
  }

  private parseLimit(value?: string): number | undefined {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new BadRequestException('Notification limit must be an integer from 1 to 100');
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Notification limit must be an integer from 1 to 100');
    return limit;
  }

}
