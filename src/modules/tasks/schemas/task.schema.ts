import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type TaskDocument = HydratedDocument<Task>;

export const TASK_TYPES = ['Task', 'Follow-up', 'Interview Prep', 'Application', 'Tender Step', 'Resume Update', 'Research'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type TaskChecklistItem = { id: string; text: string; completed: boolean };
export type Subtask = { id: string; title: string; completed: boolean; assigneeId?: string };
export type TaskReminder = { id: string; remindAt: Date; channels: string[] };

@Schema(schemaOptions)
export class Task {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  boardId!: string;

  @Prop({ type: String })
  projectId?: string;

  @Prop({ type: String, enum: TASK_TYPES, default: 'Task', index: true })
  type!: TaskType;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: String, default: '' })
  description!: string;

  @Prop({ type: String, required: true, index: true })
  statusColumnId!: string;

  @Prop({ type: String, default: 'normal', index: true })
  priority!: string;

  @Prop({ type: String, required: true, index: true })
  reporterId!: string;

  @Prop({ type: String, index: true })
  assigneeId?: string;

  @Prop({ type: String, index: true })
  opportunityId?: string;

  @Prop({ type: String, index: true })
  profileId?: string;

  @Prop({ type: Date, index: true })
  dueAt?: Date;

  @Prop({ type: [String], default: [], index: true })
  labels!: string[];

  @Prop({ type: [Object], default: [] })
  subtasks!: Subtask[];

  @Prop({ type: [Object], default: [] })
  checklist!: TaskChecklistItem[];

  @Prop({ type: [Object], default: [] })
  reminders!: TaskReminder[];

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const TaskSchema = SchemaFactory.createForClass(Task);

TaskSchema.index({ boardId: 1, statusColumnId: 1, updatedAt: -1 });
TaskSchema.index({ reporterId: 1, updatedAt: -1 });
TaskSchema.index({ assigneeId: 1, dueAt: 1 });
TaskSchema.index({ opportunityId: 1, updatedAt: -1 });
