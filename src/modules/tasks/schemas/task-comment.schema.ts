import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type TaskCommentDocument = HydratedDocument<TaskComment>;

@Schema(schemaOptions)
export class TaskComment {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  taskId!: string;

  @Prop({ type: String, required: true, index: true })
  authorId!: string;

  @Prop({ type: String, required: true })
  authorEmail!: string;

  @Prop({ type: String, required: true })
  body!: string;

  @Prop({ type: [String], default: [], index: true })
  mentionUserIds!: string[];

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const TaskCommentSchema = SchemaFactory.createForClass(TaskComment);

TaskCommentSchema.index({ taskId: 1, createdAt: 1, _id: 1 });
