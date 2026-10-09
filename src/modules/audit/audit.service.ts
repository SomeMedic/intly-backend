import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Schema } from 'mongoose';
import { Actor } from '../../common/access';
import { newId, schemaOptions } from '../../common/schema';

export class AuditEvent { _id!: string; userId!: string; action!: string; entityType!: string; entityId!: string; fields!: string[]; createdAt!: Date }
export const AuditEventSchema = new Schema<AuditEvent>({ _id: { type: String, default: newId }, userId: { type: String, required: true }, action: { type: String, required: true }, entityType: { type: String, required: true }, entityId: { type: String, required: true }, fields: { type: [String], default: [] } }, { ...schemaOptions, collection: 'audit_events' });
AuditEventSchema.index({ createdAt: -1 });
@Injectable()
export class AuditService {
  constructor(@InjectModel(AuditEvent.name) private readonly events: Model<AuditEvent>) {}
  async record(actor: Actor, action: string, entityType: string, entityId: string, fields: string[] = []): Promise<void> {
    if (actor.role !== 'Admin') return;
    await this.events.create({ userId: actor.id, action, entityType, entityId, fields });
  }
  async list() { return { items: await this.events.find().sort({ createdAt: -1 }).limit(100).lean(), nextCursor: null }; }
}
