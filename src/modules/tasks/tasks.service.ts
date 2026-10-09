import { ForbiddenException, Injectable, Optional } from '@nestjs/common';

import { Actor } from '../../common/access';
import { newId, toPublic } from '../../common/schema';
import { JobsService } from '../jobs/jobs.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  CreateTaskCommentDto,
  CreateTaskReminderDto,
  TaskListQueryDto,
  UpdateBoardDto,
  UpdateTaskDto,
  UpsertBoardDto,
  UpsertTaskDto,
} from './dto/tasks.dto';
import { Board } from './schemas/board.schema';
import { Task } from './schemas/task.schema';
import { TasksRepository } from './tasks.repository';

const DEFAULT_COLUMNS = [
  { id: 'todo', name: 'To do', order: 10 },
  { id: 'doing', name: 'Doing', order: 20 },
  { id: 'done', name: 'Done', order: 30 },
];

@Injectable()
export class TasksService {
  constructor(
    private readonly repository: TasksRepository,
    private readonly realtime: RealtimeService,
    @Optional() private readonly jobsService?: JobsService,
  ) {}

  async listBoards(actor: Actor) {
    const boards = actor.role === 'Admin' ? await this.repository.listAllBoards() : await this.repository.listBoardsForUser(actor.id);
    return boards.map((board) => toPublic(board));
  }

  async createBoard(actor: Actor, dto: UpsertBoardDto) {
    const created = await this.repository.createBoard({
      ownerUserId: actor.id,
      name: dto.name,
      members: dto.members ?? [],
      columns: dto.columns?.length ? dto.columns : DEFAULT_COLUMNS,
      scope: dto.scope ?? 'personal',
    });
    this.publishBoard(created, 'board.created', { boardId: created._id });
    return toPublic(created);
  }

  async getBoard(actor: Actor, id: string) {
    const board = await this.getAccessibleBoard(actor, id);
    const tasks = await this.repository.listTasks({ boardId: board._id });
    return { ...toPublic(board), tasks: tasks.map((task) => toPublic(task)) };
  }

  async updateBoard(actor: Actor, id: string, dto: UpdateBoardDto) {
    const board = await this.getAccessibleBoard(actor, id);
    this.ensureBoardEditor(actor, board);
    const updated = await this.repository.updateBoard(id, dto);
    this.publishBoard(updated, 'board.updated', { boardId: updated._id });
    return toPublic(updated);
  }

  async listTasks(actor: Actor, query: TaskListQueryDto) {
    const boardIds = query.boardId ? [query.boardId] : (await this.repository.listBoardsForUser(actor.id)).map((board) => board._id);
    if (actor.role !== 'Admin') {
      for (const boardId of boardIds) await this.getAccessibleBoard(actor, boardId);
    }
    const tasks = await this.repository.listTasks({ ...query, boardIds: actor.role === 'Admin' && !query.boardId ? undefined : boardIds });
    return { items: tasks.map((task) => toPublic(task)), nextCursor: null };
  }

  async createTask(actor: Actor, dto: UpsertTaskDto) {
    const board = await this.getAccessibleBoard(actor, dto.boardId);
    this.ensureBoardEditor(actor, board);
    this.assertTaskParticipants(board, dto);
    const created = await this.repository.createTask({
      ...this.taskPatch(dto),
      reporterId: actor.id,
      type: dto.type ?? 'Task',
      priority: dto.priority ?? 'normal',
      description: dto.description ?? '',
      labels: dto.labels ?? [],
    });
    this.publishBoard(board, 'task.created', { taskId: created._id, boardId: board._id });
    await this.enqueueTaskIndex(created._id);
    return toPublic(created);
  }

  async getTask(actor: Actor, id: string) {
    const task = await this.getAccessibleTask(actor, id);
    const comments = await this.repository.listComments(task._id);
    return { ...toPublic(task), comments: comments.map((comment) => toPublic(comment)) };
  }

  async updateTask(actor: Actor, id: string, dto: UpdateTaskDto) {
    const task = await this.getAccessibleTask(actor, id);
    const board = await this.getAccessibleBoard(actor, dto.boardId ?? task.boardId);
    this.ensureBoardEditor(actor, board);
    this.assertTaskParticipants(board, dto);
    const updated = await this.repository.updateTask(id, {
      ...this.taskPatch(dto),
      ...(typeof dto.completed === 'boolean' ? { completedAt: dto.completed ? new Date() : undefined } : {}),
    });
    this.publishBoard(board, 'task.updated', { taskId: updated._id, boardId: updated.boardId });
    await this.enqueueTaskIndex(updated._id);
    return toPublic(updated);
  }

  async deleteTask(actor: Actor, id: string) {
    const task = await this.getAccessibleTask(actor, id);
    const board = await this.getAccessibleBoard(actor, task.boardId);
    this.ensureBoardEditor(actor, board);
    await this.repository.softDeleteTask(id);
    this.publishBoard(board, 'task.deleted', { taskId: id, boardId: board._id });
    await this.enqueueTaskDelete(id);
    return { success: true };
  }

  async createComment(actor: Actor, taskId: string, dto: CreateTaskCommentDto) {
    const task = await this.getAccessibleTask(actor, taskId);
    const board = await this.getAccessibleBoard(actor, task.boardId);
    const comment = await this.repository.createComment({
      taskId,
      authorId: actor.id,
      authorEmail: actor.email,
      body: dto.body,
      mentionUserIds: dto.mentionUserIds ?? [],
    });
    this.publishBoard(board, 'task.comment.created', { taskId, commentId: comment._id, mentionUserIds: dto.mentionUserIds ?? [] });
    await this.enqueueTaskIndex(taskId);
    return toPublic(comment);
  }

  async createReminder(actor: Actor, taskId: string, dto: CreateTaskReminderDto) {
    const task = await this.getAccessibleTask(actor, taskId);
    const board = await this.getAccessibleBoard(actor, task.boardId);
    const reminders = [...(task.reminders ?? []), { id: newId(), remindAt: new Date(dto.remindAt), channels: dto.channels }];
    const updated = await this.repository.updateTask(taskId, { reminders });
    this.publishBoard(board, 'task.updated', { taskId, boardId: board._id });
    await this.enqueueTaskIndex(taskId);
    return toPublic(updated);
  }

  async dueTasksForUser(actor: Actor, range: { start?: Date; end?: Date }) {
    return (await this.attentionTasksForUser(actor, range)).filter((task) => Boolean(task.dueAt));
  }

  async attentionTasksForUser(actor: Actor, range: { start?: Date; end?: Date }) {
    const tasks = await this.repository.listTasks({
      assigneeId: actor.id,
      boardIds: (await this.repository.listBoardsForUser(actor.id)).map((board) => board._id),
    });
    return tasks.filter((task) => {
      if (task.completedAt) return false;
      const due = task.dueAt ? new Date(task.dueAt) : null;
      const reminderDates = (task.reminders ?? [])
        .map((reminder) => reminder.remindAt ? new Date(reminder.remindAt) : null)
        .filter((date): date is Date => date instanceof Date && Number.isFinite(+date));
      return [due, ...reminderDates].some((date) => date && (!range.start || date >= range.start) && (!range.end || date <= range.end));
    });
  }

  private async getAccessibleTask(actor: Actor, id: string): Promise<Task> {
    const task = await this.repository.getTask(id);
    await this.getAccessibleBoard(actor, task.boardId);
    return task;
  }

  private async getAccessibleBoard(actor: Actor, id: string): Promise<Board> {
    const board = await this.repository.getBoard(id);
    if (actor.role !== 'Admin' && board.ownerUserId !== actor.id && !board.members.includes(actor.id)) {
      throw new ForbiddenException('Board access denied');
    }
    return board;
  }

  private ensureBoardEditor(actor: Actor, board: Board): void {
    if (actor.role !== 'Admin' && board.ownerUserId !== actor.id && !board.members.includes(actor.id)) {
      throw new ForbiddenException('Board mutation denied');
    }
  }

  private taskPatch(dto: UpsertTaskDto | UpdateTaskDto): Partial<Task> {
    const { dueAt, subtasks, checklist, completed: _completed, ...rest } = dto as UpdateTaskDto;
    const patch: Partial<Task> = { ...rest };
    if (dueAt !== undefined) patch.dueAt = new Date(dueAt);
    if (subtasks !== undefined) {
      patch.subtasks = subtasks.map((item) => ({
        id: typeof item.id === 'string' ? item.id : newId(),
        title: item.title,
        completed: item.completed ?? false,
        assigneeId: item.assigneeId,
      }));
    }
    if (checklist !== undefined) {
      patch.checklist = checklist.map((item) => ({
        id: typeof item.id === 'string' ? item.id : newId(),
        text: item.text,
        completed: item.completed ?? false,
      }));
    }
    return patch;
  }

  private assertTaskParticipants(board: Board, dto: UpsertTaskDto | UpdateTaskDto): void {
    const participants = new Set([board.ownerUserId, ...board.members]);
    if (dto.assigneeId && !participants.has(dto.assigneeId)) {
      throw new ForbiddenException('Task assignee must be a board participant');
    }
    for (const subtask of dto.subtasks ?? []) {
      if (subtask.assigneeId && !participants.has(subtask.assigneeId)) {
        throw new ForbiddenException('Subtask assignee must be a board participant');
      }
    }
  }

  private async enqueueTaskIndex(taskId: string): Promise<void> {
    if (!this.jobsService) return;
    await this.jobsService.enqueue('search', 'index-task', { taskId }, { jobId: `search:task:${taskId}` });
  }

  private async enqueueTaskDelete(taskId: string): Promise<void> {
    if (!this.jobsService) return;
    await this.jobsService.enqueue('search', 'delete-task', { taskId }, { jobId: `search:task-delete:${taskId}` });
  }

  private publishBoard(board: Board, type: string, payload: Record<string, unknown>): void {
    for (const userId of new Set([board.ownerUserId, ...board.members])) {
      this.realtime.publish(userId, type, payload);
    }
  }
}
