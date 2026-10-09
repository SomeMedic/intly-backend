import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { JobsModule } from '../jobs/jobs.module';
import { NotificationsModule } from '../notifications';
import { TasksModule } from '../tasks';
import { CalendarRepository } from './calendar.repository';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CalendarEvent, CalendarEventSchema } from './schemas/calendar-event.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: CalendarEvent.name, schema: CalendarEventSchema }]), TasksModule, JobsModule, NotificationsModule],
  controllers: [CalendarController],
  providers: [CalendarRepository, CalendarService],
  exports: [CalendarRepository, CalendarService],
})
export class CalendarModule {}
