import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { CalendarQueryDto, CalendarReminderDto, UpdateCalendarEventDto, UpsertCalendarEventDto } from './dto/calendar.dto';
import { CalendarService } from './calendar.service';

@Controller('calendar/events')
export class CalendarController {
  constructor(private readonly service: CalendarService) {}

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: CalendarQueryDto) {
    return this.service.list(actor, query);
  }

  @Post()
  create(@CurrentUser() actor: Actor, @Body() dto: UpsertCalendarEventDto) {
    return this.service.create(actor, dto);
  }

  @Patch(':id')
  update(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCalendarEventDto) {
    return this.service.update(actor, id, dto);
  }

  @Delete(':id')
  delete(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.delete(actor, id);
  }

  @Post(':id/reminders')
  createReminder(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CalendarReminderDto) {
    return this.service.createReminder(actor, id, dto);
  }
}
