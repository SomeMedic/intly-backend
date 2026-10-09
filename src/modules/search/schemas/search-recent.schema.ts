import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type SearchRecentDocument = HydratedDocument<SearchRecent>;

@Schema(schemaOptions)
export class SearchRecent {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, trim: true })
  query!: string;

  @Prop({ type: String, default: 'all', index: true })
  scope!: string;

  @Prop({ type: Object, default: {} })
  filters!: Record<string, unknown>;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const SearchRecentSchema = SchemaFactory.createForClass(SearchRecent);

SearchRecentSchema.index({ userId: 1, query: 1, scope: 1 }, { unique: true, partialFilterExpression: { deletedAt: { $exists: false } } });
SearchRecentSchema.index({ userId: 1, updatedAt: -1 });
