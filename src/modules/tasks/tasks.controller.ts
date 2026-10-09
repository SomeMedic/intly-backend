import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import {
  CreateTaskCommentDto,
  CreateTaskReminderDto,
  TaskListQueryDto,
  UpdateBoardDto,
  UpdateTaskDto,
  UpsertBoardDto,
  UpsertTaskDto,
} from './dto/tasks.dto';
import { TasksService } from './tasks.service';

@Controller()
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Get('boards')
  listBoards(@CurrentUser() actor: Actor) {
    return this.service.listBoards(actor);
  }

  @Post('boards')
  createBoard(@CurrentUser() actor: Actor, @Body() dto: UpsertBoardDto) {
    return this.service.createBoard(actor, dto);
  }

  @Get('boards/:id')
  getBoard(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getBoard(actor, id);
  }

  @Patch('boards/:id')
  updateBoard(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBoardDto) {
    return this.service.updateBoard(actor, id, dto);
  }

  @Get('tasks')
  listTasks(@CurrentUser() actor: Actor, @Query() query: TaskListQueryDto) {
    return this.service.listTasks(actor, query);
  }

  @Post('tasks')
  createTask(@CurrentUser() actor: Actor, @Body() dto: UpsertTaskDto) {
    return this.service.createTask(actor, dto);
  }

  @Get('tasks/:id')
  getTask(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getTask(actor, id);
  }

  @Patch('tasks/:id')
  updateTask(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaskDto) {
    return this.service.updateTask(actor, id, dto);
  }

  @Delete('tasks/:id')
  deleteTask(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteTask(actor, id);
  }

  @Post('tasks/:id/comments')
  createComment(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateTaskCommentDto) {
    return this.service.createComment(actor, id, dto);
  }

  @Post('tasks/:id/reminders')
  createReminder(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateTaskReminderDto) {
    return this.service.createReminder(actor, id, dto);
  }
}
