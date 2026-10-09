import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';

import { withCanonicalOpportunity } from '../opportunities/canonical-opportunity-transaction';
import { TaskListQueryDto } from './dto/tasks.dto';
import { Board, BoardDocument } from './schemas/board.schema';
import { TaskComment, TaskCommentDocument } from './schemas/task-comment.schema';
import { Task, TaskDocument } from './schemas/task.schema';

@Injectable()
export class TasksRepository {
  constructor(
    @InjectModel(Board.name) private readonly boardModel: Model<BoardDocument>,
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    @InjectModel(TaskComment.name) private readonly commentModel: Model<TaskCommentDocument>,
    @InjectConnection() private readonly connection?: Connection,
  ) {}

  listBoardsForUser(userId: string): Promise<Board[]> {
    return this.boardModel
      .find({ deletedAt: { $exists: false }, $or: [{ ownerUserId: userId }, { members: userId }] })
      .sort({ updatedAt: -1, _id: 1 })
      .lean();
  }

  listAllBoards(): Promise<Board[]> {
    return this.boardModel.find({ deletedAt: { $exists: false } }).sort({ updatedAt: -1, _id: 1 }).lean();
  }

  async getBoard(id: string): Promise<Board> {
    const board = await this.boardModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
    if (!board) throw new NotFoundException('Board not found');
    return board;
  }

  async createBoard(input: Partial<Board>): Promise<Board> {
    const created = await this.boardModel.create(input);
    return created.toObject();
  }

  async updateBoard(id: string, input: Partial<Board>): Promise<Board> {
    const updated = await this.boardModel.findOneAndUpdate({ _id: id, deletedAt: { $exists: false } }, { $set: input }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Board not found');
    return updated;
  }

  async listTasks(query: TaskListQueryDto & { boardIds?: string[] }): Promise<Task[]> {
    const opportunityId = query.opportunityId ? await this.resolveCanonicalOpportunityId(query.opportunityId) : undefined;
    return this.taskModel
      .find({
        deletedAt: { $exists: false },
        ...(query.boardIds ? { boardId: { $in: query.boardIds } } : {}),
        ...(query.boardId ? { boardId: query.boardId } : {}),
        ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
        ...(query.reporterId ? { reporterId: query.reporterId } : {}),
        ...(query.statusColumnId ? { statusColumnId: query.statusColumnId } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(opportunityId ? { opportunityId } : {}),
      })
      .sort({ dueAt: 1, updatedAt: -1, _id: 1 })
      .lean();
  }

  async getTask(id: string): Promise<Task> {
    const task = await this.taskModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  async createTask(input: Partial<Task>): Promise<Task> {
    if (this.connection?.db && input.opportunityId) {
      return withCanonicalOpportunity(this.connection, input.opportunityId, async (opportunityId, session) => {
        const [created] = await this.taskModel.create([{ ...input, opportunityId }], { session });
        return created.toObject();
      });
    }
    const created = await this.taskModel.create(input);
    return created.toObject();
  }

  async updateTask(id: string, input: Partial<Task>): Promise<Task> {
    if (this.connection?.db) {
      const hasOpportunityPatch = Object.prototype.hasOwnProperty.call(input, 'opportunityId');
      const explicitOpportunityId = hasOpportunityPatch ? input.opportunityId : undefined;
      if (hasOpportunityPatch) {
        if (explicitOpportunityId) {
          const updated = await withCanonicalOpportunity(this.connection, explicitOpportunityId, async (opportunityId, session) => this.updateTaskInSession(id, { ...input, opportunityId }, session));
          if (updated) return updated;
          throw new NotFoundException('Task not found');
        }
        const updated = await this.updateTaskInSession(id, input);
        if (!updated) throw new NotFoundException('Task not found');
        return updated;
      }
      const existingOpportunityId = (await this.taskModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean())?.opportunityId;
      if (existingOpportunityId) {
        const updated = await withCanonicalOpportunity(this.connection, existingOpportunityId, async (_opportunityId, session) => this.updateTaskInSession(id, input, session));
        if (updated) return updated;
        throw new NotFoundException('Task not found');
      }
    }
    const updated = await this.updateTaskInSession(id, input);
    if (!updated) throw new NotFoundException('Task not found');
    return updated;
  }

  async softDeleteTask(id: string): Promise<void> {
    const result = await this.taskModel.updateOne({ _id: id, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date() } });
    if (result.matchedCount === 0) throw new NotFoundException('Task not found');
  }

  private async updateTaskInSession(id: string, input: Partial<Task>, session?: mongo.ClientSession): Promise<Task | null> {
    return this.taskModel.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } },
      { $set: input },
      { new: true, ...(session ? { session } : {}) },
    ).lean();
  }

  private async resolveCanonicalOpportunityId(opportunityId: string): Promise<string> {
    if (!this.connection?.db) return opportunityId;
    let id = opportunityId;
    const visited = new Set<string>();
    const opportunities = this.connection.db.collection<{ _id: string; mergedIntoOpportunityId?: string }>('opportunities');
    for (let hop = 0; hop < 20; hop += 1) {
      if (visited.has(id)) throw new ConflictException('Opportunity alias cycle');
      visited.add(id);
      const record = await opportunities.findOne({ _id: id }, { projection: { _id: 1, mergedIntoOpportunityId: 1 } });
      if (!record) return opportunityId;
      if (!record.mergedIntoOpportunityId) return record._id;
      id = record.mergedIntoOpportunityId;
    }
    throw new ConflictException('Opportunity alias chain exceeds safe depth');
  }

  listComments(taskId: string): Promise<TaskComment[]> {
    return this.commentModel.find({ taskId, deletedAt: { $exists: false } }).sort({ createdAt: 1, _id: 1 }).lean();
  }

  async createComment(input: Partial<TaskComment>): Promise<TaskComment> {
    const created = await this.commentModel.create(input);
    return created.toObject();
  }
}
