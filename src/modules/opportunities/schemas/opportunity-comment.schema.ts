import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type OpportunityCommentDocument = HydratedDocument<OpportunityComment>;

@Schema(schemaOptions)
export class OpportunityComment {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  opportunityId!: string;

  @Prop({ type: String, required: true, index: true })
  authorId!: string;

  @Prop({ type: String, required: true })
  authorEmail!: string;

  @Prop({ type: String, required: true, trim: true })
  body!: string;

  @Prop({ type: [String], default: [], index: true })
  mentionUserIds!: string[];

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: String })
  deletedBy?: string;
}

export const OpportunityCommentSchema = SchemaFactory.createForClass(OpportunityComment);

OpportunityCommentSchema.index({ opportunityId: 1, createdAt: -1, _id: 1 });
OpportunityCommentSchema.index({ mentionUserIds: 1, createdAt: -1 });
