import { Schema } from 'mongoose';
import { newId, schemaOptions } from '../../../common/schema';
export class DeadLetter { _id!: string; queue!: string; jobId!: string; name!: string; data!: Record<string, unknown>; error!: string; attempts!: number; status!: 'Failed' | 'Replayed' | 'Dismissed'; replayedAt?: Date; dismissedAt?: Date; dismissedByUserId?: string; createdAt!: Date }
export const DeadLetterSchema = new Schema<DeadLetter>({ _id: { type: String, default: newId }, queue: { type: String, required: true }, jobId: { type: String, required: true }, name: { type: String, required: true }, data: Schema.Types.Mixed, error: String, attempts: Number, status: { type: String, enum: ['Failed', 'Replayed', 'Dismissed'], default: 'Failed' }, replayedAt: Date, dismissedAt: Date, dismissedByUserId: String }, { ...schemaOptions, collection: 'dead_letters' });
DeadLetterSchema.index({ queue: 1, jobId: 1 }, { unique: true });
