import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiModule } from '../ai/ai.module';
import { FilesModule } from '../files';
import { NotificationsModule } from '../notifications';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { WebhooksModule } from '../webhooks';
import { ProfilesModule } from '../profiles/profiles.module';
import { ResponseDraft, ResponseDraftSchema } from './schemas/response-draft.schema';
import { ResponsesController } from './responses.controller';
import { ResponsesRepository } from './responses.repository';
import { ResponsesService } from './responses.service';

@Module({
  imports: [
    AiModule,
    FilesModule,
    NotificationsModule,
    OpportunitiesModule,
    ProfilesModule,
    WebhooksModule,
    MongooseModule.forFeature([{ name: ResponseDraft.name, schema: ResponseDraftSchema }]),
  ],
  controllers: [ResponsesController],
  providers: [ResponsesRepository, ResponsesService],
  exports: [ResponsesRepository, ResponsesService],
})
export class ResponsesModule {}
