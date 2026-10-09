import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { newId, schemaOptions } from '../../../common/schema';

export type IssueReportDocument = HydratedDocument<IssueReport>;

export const ISSUE_REPORT_TYPES = ['duplicate', 'closed', 'money', 'remote_location', 'broken_link', 'technology_category', 'wrong_data', 'spam', 'other'] as const;
export type IssueReportType = (typeof ISSUE_REPORT_TYPES)[number];
export const ISSUE_REPORT_STATUSES = ['Open', 'In review', 'Resolved', 'Dismissed'] as const;
export type IssueReportStatus = (typeof ISSUE_REPORT_STATUSES)[number];

@Schema(schemaOptions)
export class IssueReport {
  @Prop({ type: String, default: newId })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true, index: true })
  opportunityId!: string;

  @Prop({ type: String, enum: ISSUE_REPORT_TYPES, required: true })
  type!: IssueReportType;

  @Prop({ type: String, default: '' })
  comment!: string;

  @Prop({ type: String, enum: ISSUE_REPORT_STATUSES, default: 'Open', index: true })
  status!: IssueReportStatus;

  @Prop({ type: String })
  assignedAdminId?: string;

  @Prop({ type: String })
  priority?: 'low' | 'normal' | 'high' | 'urgent';

  @Prop({ type: String, default: '' })
  adminComment!: string;

  @Prop({ type: Object })
  resolution?: Record<string, unknown>;
}

export const IssueReportSchema = SchemaFactory.createForClass(IssueReport);

IssueReportSchema.index({ status: 1, updatedAt: -1 });
