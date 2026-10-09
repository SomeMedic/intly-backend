import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type SavedViewDocument = HydratedDocument<SavedView>;

@Schema(schemaOptions)
export class SavedView {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, trim: true })
  scope!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: Object, default: {} })
  query!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  filters!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  sort!: Record<string, unknown>;

  @Prop({ type: String, default: 'list' })
  mode!: string;

  @Prop({ type: [String], default: [] })
  visibleFields!: string[];

  @Prop({ type: Object, default: {} })
  columnState!: Record<string, unknown>;

  @Prop({ type: Boolean, default: false, index: true })
  isDefault!: boolean;

  @Prop({ type: Boolean, default: false, index: true })
  pinned!: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const SavedViewSchema = SchemaFactory.createForClass(SavedView);

SavedViewSchema.index({ userId: 1, scope: 1, pinned: -1, updatedAt: -1 });
SavedViewSchema.index({ userId: 1, scope: 1, isDefault: 1 });
