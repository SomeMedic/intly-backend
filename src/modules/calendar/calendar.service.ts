import { BadRequestException, ForbiddenException, Injectable, OnModuleInit, Optional } from '@nestjs/common';

import { Actor } from '../../common/access';
import { newId, toPublic } from '../../common/schema';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from '../tasks';
import { CalendarQueryDto, CalendarReminderDto, UpdateCalendarEventDto, UpsertCalendarEventDto } from './dto/calendar.dto';
import { CalendarEvent } from './schemas/calendar-event.schema';
import { CalendarRepository } from './calendar.repository';

@Injectable()
export class CalendarService implements OnModuleInit {
  constructor(
    private readonly repository: CalendarRepository,
    private readonly tasksService: TasksService,
    private readonly realtime: RealtimeService,
    @Optional() private readonly jobsService?: JobsService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (!this.jobsService || !this.notificationsService) return;
    this.jobsService.registerHandler('notifications', 'calendar.reminder', async (data) => this.dispatchReminder(String(data.eventId), String(data.reminderId), String(data.userId)));
  }

  async list(actor: Actor, query: CalendarQueryDto) {
    const range = { start: query.start ? new Date(query.start) : undefined, end: query.end ? new Date(query.end) : undefined, type: query.type };
    const manual = await this.repository.list(actor.id, range);
    const taskEvents = (await this.tasksService.dueTasksForUser(actor, range)).map((task) => ({
      id: `task:${task._id}`,
      taskId: task._id,
      type: 'task_due',
      startAt: task.dueAt,
      title: task.title,
      metadata: { derived: true, boardId: task.boardId, priority: task.priority },
    }));
    return { items: [...manual.map((event) => toPublic(event)), ...taskEvents], nextCursor: null };
  }

  async create(actor: Actor, dto: UpsertCalendarEventDto) {
    await this.assertLinkedTaskAccess(actor, dto.taskId);
    const patch = this.toCreatePatch(dto);
    this.assertDateWindow(patch.startAt, patch.endAt);
    const created = await this.repository.create({ ...patch, userId: actor.id });
    await this.scheduleReminders(created);
    this.realtime.publish(actor.id, 'calendar.event.created', { eventId: created._id });
    return toPublic(created);
  }

  async update(actor: Actor, id: string, dto: UpdateCalendarEventDto) {
    const event = await this.getAccessible(actor, id);
    if (dto.taskId !== undefined) await this.assertLinkedTaskAccess(actor, dto.taskId);
    const patch = this.toUpdatePatch(dto);
    this.assertDateWindow(patch.startAt ?? event.startAt, patch.endAt ?? event.endAt);
    const updated = await this.repository.update(event._id, patch);
    if (patch.reminders) await this.scheduleReminders(updated);
    this.realtime.publish(actor.id, 'calendar.event.updated', { eventId: updated._id });
    return toPublic(updated);
  }

  async delete(actor: Actor, id: string) {
    const event = await this.getAccessible(actor, id);
    await this.repository.softDelete(event._id);
    this.realtime.publish(actor.id, 'calendar.event.deleted', { eventId: id });
    return { success: true };
  }

  async createReminder(actor: Actor, id: string, dto: CalendarReminderDto) {
    const event = await this.getAccessible(actor, id);
    await this.assertLinkedTaskAccess(actor, event.taskId);
    const reminder = this.normalizeReminder(dto);
    const updated = await this.repository.update(event._id, { reminders: [...(event.reminders ?? []), reminder] });
    await this.scheduleReminder(updated, reminder);
    this.realtime.publish(actor.id, 'calendar.event.updated', { eventId: updated._id, reminderId: reminder.id });
    return toPublic(updated);
  }

  private async assertLinkedTaskAccess(actor: Actor, taskId?: string): Promise<void> {
    if (taskId) {
      await this.tasksService.getTask(actor, taskId);
    }
  }

  private async getAccessible(actor: Actor, id: string): Promise<CalendarEvent> {
    const event = await this.repository.get(id);
    if (actor.role !== 'Admin' && event.userId !== actor.id) {
      throw new ForbiddenException('Calendar event access denied');
    }
    return event;
  }

  private toCreatePatch(dto: UpsertCalendarEventDto): Partial<CalendarEvent> {
    return {
      opportunityId: dto.opportunityId,
      taskId: dto.taskId,
      type: dto.type,
      startAt: new Date(dto.startAt),
      ...(dto.endAt !== undefined ? { endAt: new Date(dto.endAt) } : {}),
      title: dto.title,
      metadata: dto.metadata ?? {},
      reminders: (dto.reminders ?? []).map((reminder) => this.normalizeReminder(reminder)),
    };
  }

  private toUpdatePatch(dto: UpdateCalendarEventDto): Partial<CalendarEvent> {
    const patch: Partial<CalendarEvent> = {};
    if (dto.opportunityId !== undefined) patch.opportunityId = dto.opportunityId;
    if (dto.taskId !== undefined) patch.taskId = dto.taskId;
    if (dto.type !== undefined) patch.type = dto.type;
    if (dto.startAt !== undefined) patch.startAt = new Date(dto.startAt);
    if (dto.endAt !== undefined) patch.endAt = new Date(dto.endAt);
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.metadata !== undefined) patch.metadata = dto.metadata;
    if (dto.reminders !== undefined) patch.reminders = dto.reminders.map((reminder) => this.normalizeReminder(reminder));
    return patch;
  }

  private normalizeReminder(dto: CalendarReminderDto): Record<string, unknown> & { id: string; remindAt: Date; channels: string[] } {
    const remindAt = new Date(dto.remindAt);
    if (!Number.isFinite(+remindAt)) throw new BadRequestException('Reminder date is invalid');
    if (!dto.channels.length) throw new BadRequestException('Reminder channels are required');
    return { id: dto.id ?? newId(), remindAt, channels: dto.channels };
  }

  private assertDateWindow(startAt?: Date, endAt?: Date): void {
    if (!startAt || !Number.isFinite(+new Date(startAt))) throw new BadRequestException('Calendar event start date is invalid');
    if (endAt !== undefined) {
      const end = new Date(endAt);
      if (!Number.isFinite(+end)) throw new BadRequestException('Calendar event end date is invalid');
      if (+end <= +new Date(startAt)) throw new BadRequestException('Calendar event end must be after start');
    }
  }

  private async scheduleReminders(event: CalendarEvent): Promise<void> {
    await Promise.all((event.reminders ?? []).map((reminder) => this.scheduleReminder(event, reminder)));
  }

  private async scheduleReminder(event: CalendarEvent, reminder: Record<string, unknown>): Promise<void> {
    if (!this.jobsService) return;
    const reminderId = String(reminder.id ?? '');
    const remindAt = new Date(String(reminder.remindAt));
    if (!reminderId || !Number.isFinite(+remindAt)) return;
    const delay = Math.max(0, +remindAt - Date.now());
    await this.jobsService.enqueue('notifications', 'calendar.reminder', { eventId: event._id, reminderId, userId: event.userId }, { jobId: `calendar:${event._id}:${reminderId}:${+remindAt}`, delay });
  }

  private async dispatchReminder(eventId: string, reminderId: string, userId: string): Promise<void> {
    if (!this.notificationsService) return;
    const event = await this.repository.get(eventId).catch(() => null);
    if (!event || event.userId !== userId || event.deletedAt) return;
    const reminder = (event.reminders ?? []).find((item) => String(item.id) === reminderId);
    if (!reminder) return;
    await this.notificationsService.notify({
      userId,
      type: 'calendar.reminder',
      title: `Напоминание: ${event.title}`,
      body: event.startAt ? `Событие начинается ${new Date(event.startAt).toLocaleString('ru-RU')}` : '',
      data: { eventId: event._id, reminderId, taskId: event.taskId, opportunityId: event.opportunityId },
    });
  }
}
