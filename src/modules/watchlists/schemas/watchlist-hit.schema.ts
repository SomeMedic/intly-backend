import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type WatchlistHitDocument = HydratedDocument<WatchlistHit>;

@Schema(schemaOptions)
export class WatchlistHit {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  watchlistId!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  profileId!: string;

  @Prop({ type: String, required: true, index: true })
  opportunityId!: string;

  @Prop({ type: Number, default: 0 })
  matchScore!: number;

  @Prop({ type: Number })
  aiScore?: number;

  @Prop({ type: String, default: 'pending' })
  notificationState!: string;

  @Prop({ type: String })
  notificationKey?: string;

  @Prop({ type: String, default: 'off' })
  autoAiState!: string;

  @Prop({ type: String })
  aiRunId?: string;

  @Prop({ type: [String], default: undefined })
  aiRunHistory?: string[];

  @Prop({ type: [String], default: undefined })
  notificationKeys?: string[];

  @Prop({ type: Date, default: Date.now, index: true })
  matchedAt!: Date;

  @Prop({ type: Date })
  acknowledgedAt?: Date;

  @Prop({ type: String, index: true })
  supersededByHitId?: string;
}

export const WatchlistHitSchema = SchemaFactory.createForClass(WatchlistHit);

WatchlistHitSchema.index({ watchlistId: 1, matchedAt: -1, _id: 1 });
WatchlistHitSchema.index({ watchlistId: 1, opportunityId: 1 }, { unique: true });
