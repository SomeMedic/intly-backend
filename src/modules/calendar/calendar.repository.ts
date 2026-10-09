import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';

import { withCanonicalOpportunity } from '../opportunities/canonical-opportunity-transaction';
import { CalendarEvent, CalendarEventDocument } from './schemas/calendar-event.schema';

@Injectable()
export class CalendarRepository {
  constructor(
    @InjectModel(CalendarEvent.name) private readonly calendarModel: Model<CalendarEventDocument>,
    @InjectConnection() private readonly connection?: Connection,
  ) {}

  list(userId: string, range: { start?: Date; end?: Date; type?: string }): Promise<CalendarEvent[]> {
    return this.calendarModel
      .find({
        userId,
        deletedAt: { $exists: false },
        ...(range.type ? { type: range.type } : {}),
        ...(range.start || range.end
          ? { startAt: { ...(range.start ? { $gte: range.start } : {}), ...(range.end ? { $lte: range.end } : {}) } }
          : {}),
      })
      .sort({ startAt: 1, _id: 1 })
      .lean();
  }

  async get(id: string): Promise<CalendarEvent> {
    const event = await this.calendarModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
    if (!event) throw new NotFoundException('Calendar event not found');
    return event;
  }

  async create(input: Partial<CalendarEvent>): Promise<CalendarEvent> {
    if (this.connection?.db && input.opportunityId) {
      return withCanonicalOpportunity(this.connection, input.opportunityId, async (opportunityId, session) => {
        const [created] = await this.calendarModel.create([{ ...input, opportunityId }], { session });
        return created.toObject();
      });
    }
    const created = await this.calendarModel.create(input);
    return created.toObject();
  }

  async update(id: string, input: Partial<CalendarEvent>): Promise<CalendarEvent> {
    if (this.connection?.db) {
      const hasOpportunityPatch = Object.prototype.hasOwnProperty.call(input, 'opportunityId');
      const explicitOpportunityId = hasOpportunityPatch ? input.opportunityId : undefined;
      if (hasOpportunityPatch) {
        if (explicitOpportunityId) {
          const updated = await withCanonicalOpportunity(this.connection, explicitOpportunityId, async (opportunityId, session) => this.updateInSession(id, { ...input, opportunityId }, session));
          if (updated) return updated;
          throw new NotFoundException('Calendar event not found');
        }
        const updated = await this.updateInSession(id, input);
        if (!updated) throw new NotFoundException('Calendar event not found');
        return updated;
      }
      const existingOpportunityId = (await this.calendarModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean())?.opportunityId;
      if (existingOpportunityId) {
        const updated = await withCanonicalOpportunity(this.connection, existingOpportunityId, async (_opportunityId, session) => this.updateInSession(id, input, session));
        if (updated) return updated;
        throw new NotFoundException('Calendar event not found');
      }
    }
    const updated = await this.updateInSession(id, input);
    if (!updated) throw new NotFoundException('Calendar event not found');
    return updated;
  }

  private async updateInSession(id: string, input: Partial<CalendarEvent>, session?: mongo.ClientSession): Promise<CalendarEvent | null> {
    return this.calendarModel.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } },
      { $set: input },
      { new: true, ...(session ? { session } : {}) },
    ).lean();
  }

  async softDelete(id: string): Promise<void> {
    const result = await this.calendarModel.updateOne({ _id: id, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date() } });
    if (result.matchedCount === 0) throw new NotFoundException('Calendar event not found');
  }
}
