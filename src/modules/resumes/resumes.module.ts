import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiModule } from '../ai/ai.module';
import { FilesModule } from '../files';
import { NotificationsModule } from '../notifications';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { WebhooksModule } from '../webhooks';
import { ProfilesModule } from '../profiles/profiles.module';
import { ResumeAdaptation, ResumeAdaptationSchema } from './schemas/resume-adaptation.schema';
import { Resume, ResumeSchema } from './schemas/resume.schema';
import { ResumesController } from './resumes.controller';
import { ResumesRepository } from './resumes.repository';
import { ResumesService } from './resumes.service';

@Module({
  imports: [
    AiModule,
    FilesModule,
    NotificationsModule,
    OpportunitiesModule,
    ProfilesModule,
    WebhooksModule,
    MongooseModule.forFeature([
      { name: Resume.name, schema: ResumeSchema },
      { name: ResumeAdaptation.name, schema: ResumeAdaptationSchema },
    ]),
  ],
  controllers: [ResumesController],
  providers: [ResumesRepository, ResumesService],
  exports: [ResumesRepository, ResumesService],
})
export class ResumesModule {}
