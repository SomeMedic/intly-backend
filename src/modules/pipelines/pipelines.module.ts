import { Module } from '@nestjs/common';

import { CalendarModule } from '../calendar';
import { OpportunitiesModule } from '../opportunities';
import { ProfilesModule } from '../profiles';
import { TasksModule } from '../tasks';
import { PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';

@Module({
  imports: [OpportunitiesModule, ProfilesModule, TasksModule, CalendarModule],
  controllers: [PipelinesController],
  providers: [PipelinesService],
  exports: [PipelinesService],
})
export class PipelinesModule {}
