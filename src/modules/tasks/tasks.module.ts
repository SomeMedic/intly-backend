import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Board, BoardSchema } from './schemas/board.schema';
import { TaskComment, TaskCommentSchema } from './schemas/task-comment.schema';
import { Task, TaskSchema } from './schemas/task.schema';
import { TasksController } from './tasks.controller';
import { TasksRepository } from './tasks.repository';
import { TasksService } from './tasks.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Board.name, schema: BoardSchema },
      { name: Task.name, schema: TaskSchema },
      { name: TaskComment.name, schema: TaskCommentSchema },
    ]),
  ],
  controllers: [TasksController],
  providers: [TasksRepository, TasksService],
  exports: [TasksRepository, TasksService],
})
export class TasksModule {}
