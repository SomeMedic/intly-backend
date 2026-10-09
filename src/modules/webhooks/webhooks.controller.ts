import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { CreateWebhookDto, UpdateWebhookDto } from './dto/webhook.dto';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Get()
  list(@CurrentUser() actor: Actor) {
    return this.webhooksService.list(actor);
  }

  @Post()
  create(@CurrentUser() actor: Actor, @Body() dto: CreateWebhookDto) {
    return this.webhooksService.create(actor, dto);
  }

  @Patch(':id')
  update(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: UpdateWebhookDto) {
    return this.webhooksService.update(actor, id, dto);
  }

  @Delete(':id')
  delete(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.webhooksService.delete(actor, id);
  }

  @Get(':id/deliveries')
  deliveries(@CurrentUser() actor: Actor, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.webhooksService.deliveries(actor, id, limit ? Number(limit) : undefined);
  }

  @Post(':id/test')
  test(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.webhooksService.test(actor, id);
  }

  @Post('deliveries/:deliveryId/retry')
  retry(@CurrentUser() actor: Actor, @Param('deliveryId') deliveryId: string) {
    return this.webhooksService.retry(actor, deliveryId);
  }
}
