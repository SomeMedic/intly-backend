import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { JobsModule } from '../jobs/jobs.module';
import { Webhook, WebhookDelivery, WebhookDeliverySchema, WebhookSchema } from './schemas/webhook.schema';
import { WebhooksController } from './webhooks.controller';
import { WebhooksRepository } from './webhooks.repository';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [
    JobsModule,
    MongooseModule.forFeature([
      { name: Webhook.name, schema: WebhookSchema },
      { name: WebhookDelivery.name, schema: WebhookDeliverySchema },
    ]),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksRepository, WebhooksService],
  exports: [WebhooksRepository, WebhooksService],
})
export class WebhooksModule {}
