import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type BoardDocument = HydratedDocument<Board>;

export type BoardColumn = { id: string; name: string; order: number };

@Schema(schemaOptions)
export class Board {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  ownerUserId!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: [String], default: [], index: true })
  members!: string[];

  @Prop({ type: [Object], default: [] })
  columns!: BoardColumn[];

  @Prop({ type: String, default: 'personal', index: true })
  scope!: string;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const BoardSchema = SchemaFactory.createForClass(Board);

BoardSchema.index({ ownerUserId: 1, deletedAt: 1, updatedAt: -1 });
BoardSchema.index({ members: 1, deletedAt: 1, updatedAt: -1 });
