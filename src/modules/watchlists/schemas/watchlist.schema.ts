import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type WatchlistDocument = HydratedDocument<Watchlist>;

export type AutoAiRules = {
  enabled: boolean;
  dailyMax?: number;
  rerunOnMaterialChange?: boolean;
};

@Schema(schemaOptions)
export class Watchlist {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  profileId!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: Object, default: {} })
  filters!: Record<string, unknown>;

  @Prop({ type: Number })
  matchMin?: number;

  @Prop({ type: Number })
  aiMin?: number;

  @Prop({ type: Object, default: { enabled: false } })
  autoAiRules!: AutoAiRules;

  @Prop({ type: Object, default: {} })
  notificationPolicy!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  exclusions!: Record<string, unknown>;

  @Prop({ type: Boolean, default: true, index: true })
  active!: boolean;

  @Prop({ type: Number, default: 0 })
  totalHits!: number;

  @Prop({ type: Date })
  lastHitAt?: Date;

  @Prop({ type: Date })
  deletedAt?: Date;
}

export const WatchlistSchema = SchemaFactory.createForClass(Watchlist);

WatchlistSchema.index({ userId: 1, profileId: 1, active: 1, updatedAt: -1 });
WatchlistSchema.index({ userId: 1, deletedAt: 1, updatedAt: -1 });
