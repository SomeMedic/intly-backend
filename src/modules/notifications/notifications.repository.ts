import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';

import { withCanonicalOpportunity } from '../opportunities/canonical-opportunity-transaction';
import { Notification, NotificationCategory, NotificationChannel, NotificationDocument } from './schemas/notification.schema';

export const NOTIFICATION_CENTER_FILTERS = ['all', 'unread', 'system', 'opportunities', 'tasks', 'archived', 'ai', 'workflow', 'collaboration', 'admin'] as const;
export type NotificationCenterFilter = (typeof NOTIFICATION_CENTER_FILTERS)[number];

export type NotificationListParams = {
  unreadOnly?: boolean;
  filter?: string;
  archived?: boolean;
  cursor?: string;
  limit?: number;
};

export type NormalizedNotificationListParams = {
  userId: string;
  filter: NotificationCenterFilter;
  archived: boolean;
  unreadOnly: boolean;
  limit: number;
};

type NotificationCursor = {
  userId: string;
  filter: NotificationCenterFilter;
  archived: boolean;
  unreadOnly: boolean;
  createdAt: string;
  id: string;
};

type NotificationCounts = {
  all: number;
  unread: number;
  system: number;
  opportunities: number;
  tasks: number;
  archived: number;
};

@Injectable()
export class NotificationsRepository {
  constructor(
    @InjectModel(Notification.name) private readonly notificationModel: Model<NotificationDocument>,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async create(input: Partial<Notification>): Promise<Notification> {
    const opportunityId = dataOpportunityId(input.data);
    if (this.connection?.db && opportunityId) return withCanonicalOpportunity(this.connection, opportunityId, (canonicalOpportunityId, session) => this.createCanonical(withDataOpportunity(input, canonicalOpportunityId), session));
    return this.createCanonical(input);
  }

  async createIdempotent(input: Partial<Notification>): Promise<{ notification: Notification; created: boolean }> {
    if (!input.idempotencyKey) return { notification: await this.create(input), created: true };
    try {
      return { notification: await this.create(input), created: true };
    } catch (error) {
      if (!this.isDuplicateKey(error)) throw error;
      const existing = await this.notificationModel.findOne({ userId: input.userId, idempotencyKey: input.idempotencyKey, deletedAt: { $exists: false } }).lean();
      if (!existing) throw error;
      return { notification: existing, created: false };
    }
  }

  private async createCanonical(input: Partial<Notification>, session?: mongo.ClientSession): Promise<Notification> {
    const [document] = await this.notificationModel.create([input], { session });
    return document.toObject();
  }

  async getById(id: string): Promise<Notification> {
    const notification = await this.notificationModel.findOne({ _id: id, deletedAt: { $exists: false } }).lean();
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }

  private isDuplicateKey(error: unknown): boolean {
    return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 11000;
  }


  async list(userId: string, query: NotificationListParams): Promise<{ items: Notification[]; nextCursor: string | null; total: number; counts: NotificationCounts }> {
    const params = this.normalizeListParams(userId, query);
    const cursor = query.cursor ? this.decodeCursor(query.cursor, params) : null;
    const filter = this.pageFilter(params, cursor);
    const items = await this.notificationModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(params.limit + 1).lean();
    const pageItems = items.slice(0, params.limit);
    const [total, counts] = await Promise.all([
      this.notificationModel.countDocuments(this.selectedFilter(params)),
      this.counts(userId),
    ]);
    return {
      items: pageItems,
      nextCursor: items.length > params.limit ? this.encodeCursor(params, pageItems[pageItems.length - 1]) : null,
      total,
      counts,
    };
  }

  async markRead(id: string, userId: string): Promise<Notification> {
    const updated = await this.notificationModel.findOneAndUpdate(
      { _id: id, userId, deletedAt: { $exists: false } },
      { $set: { readAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new NotFoundException('Notification not found');
    return updated;
  }

  async markAllRead(userId: string): Promise<{ modifiedCount: number }> {
    const result = await this.notificationModel.updateMany(
      { userId, readAt: { $exists: false }, deletedAt: { $exists: false }, archivedAt: { $exists: false }, visibleInApp: { $ne: false } },
      { $set: { readAt: new Date() } },
    );
    return { modifiedCount: result.modifiedCount };
  }

  async markArchived(id: string, userId: string, archived: boolean): Promise<Notification> {
    const update = archived ? { $set: { archivedAt: new Date() } } : { $unset: { archivedAt: '' } };
    const updated = await this.notificationModel.findOneAndUpdate(
      { _id: id, userId, deletedAt: { $exists: false } },
      update,
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new NotFoundException('Notification not found');
    return updated;
  }

  async setDeliveries(id: string, deliveries: Notification['deliveries']): Promise<Notification> {
    const updated = await this.notificationModel.findByIdAndUpdate(id, { $set: { deliveries } }, { returnDocument: 'after' }).lean();
    if (!updated) throw new NotFoundException('Notification not found');
    return updated;
  }

  listDigest(userId: string, channel: NotificationChannel, digestKey: string): Promise<Notification[]> {
    return this.notificationModel.find({
      userId,
      deletedAt: { $exists: false },
      deliveries: { $elemMatch: { channel, digestKey, status: 'queued' } },
    }).sort({ createdAt: 1 }).lean();
  }

  async setDigestDeliveries(ids: string[], channel: NotificationChannel, digestKey: string, delivery: Notification['deliveries'][number]): Promise<{ modifiedCount: number }> {
    if (!ids.length) return { modifiedCount: 0 };
    const result = await this.notificationModel.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          'deliveries.$[delivery].status': delivery.status,
          'deliveries.$[delivery].attemptedAt': delivery.attemptedAt,
          'deliveries.$[delivery].reason': delivery.reason,
        },
      },
      { arrayFilters: [{ 'delivery.channel': channel, 'delivery.digestKey': digestKey, 'delivery.status': 'queued' }] },
    );
    return { modifiedCount: result.modifiedCount };
  }

  private normalizeListParams(userId: string, query: NotificationListParams): NormalizedNotificationListParams {
    const filter = this.normalizeFilter(query.filter);
    return {
      userId,
      filter,
      archived: query.archived === true || filter === 'archived',
      unreadOnly: query.unreadOnly === true || filter === 'unread',
      limit: this.normalizeLimit(query.limit),
    };
  }

  private normalizeFilter(filter?: string): NotificationCenterFilter {
    const value = filter ?? 'all';
    if ((NOTIFICATION_CENTER_FILTERS as readonly string[]).includes(value)) return value as NotificationCenterFilter;
    throw new BadRequestException('Notification filter is invalid');
  }

  private normalizeLimit(limit?: number): number {
    if (limit === undefined) return 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Notification limit must be an integer from 1 to 100');
    return limit;
  }

  private baseVisibleFilter(userId: string, archived: boolean): Record<string, unknown> {
    return {
      userId,
      deletedAt: { $exists: false },
      visibleInApp: { $ne: false },
      ...(archived ? { archivedAt: { $exists: true } } : { archivedAt: { $exists: false } }),
    };
  }

  private selectedFilter(params: NormalizedNotificationListParams): Record<string, unknown> {
    const filter = this.baseVisibleFilter(params.userId, params.archived);
    if (params.unreadOnly) filter.readAt = { $exists: false };
    const classFilter = this.classFilter(params.filter);
    if (classFilter) Object.assign(filter, classFilter);
    return filter;
  }

  private pageFilter(params: NormalizedNotificationListParams, cursor: NotificationCursor | null): Record<string, unknown> {
    const filter = this.selectedFilter(params);
    if (!cursor) return filter;
    return {
      $and: [
        filter,
        {
          $or: [
            { createdAt: { $lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), _id: { $lt: cursor.id } },
          ],
        },
      ],
    };
  }

  private classFilter(filter: NotificationCenterFilter): Record<string, unknown> | null {
    if (filter === 'opportunities') return { $or: [{ category: 'opportunity' }, { type: { $regex: /^(watchlist|opportunity|response)/i } }] };
    if (filter === 'tasks') return {
      $and: [
        { $or: [{ category: 'workflow' }, { type: { $regex: /^(task|calendar)|reminder/i } }] },
        { category: { $nin: ['opportunity'] } },
        { type: { $not: /^(watchlist|opportunity|response)/i } },
      ],
    };
    if (filter === 'system') return {
      $and: [
        { $or: [{ category: { $in: ['system', 'admin'] } }, { type: { $regex: /^(system|admin)/i } }] },
        { category: { $nin: ['opportunity', 'workflow'] } },
        { type: { $not: /^(watchlist|opportunity|response)/i } },
        { type: { $not: /^(task|calendar)|reminder/i } },
      ],
    };
    const category = this.categoryFromFilter(filter);
    return category ? { category } : null;
  }

  private async counts(userId: string): Promise<NotificationCounts> {
    const active = this.baseVisibleFilter(userId, false);
    const archived = this.baseVisibleFilter(userId, true);
    const [all, unread, system, opportunities, tasks, archivedCount] = await Promise.all([
      this.notificationModel.countDocuments(active),
      this.notificationModel.countDocuments({ ...active, readAt: { $exists: false } }),
      this.notificationModel.countDocuments({ ...active, ...this.classFilter('system') }),
      this.notificationModel.countDocuments({ ...active, ...this.classFilter('opportunities') }),
      this.notificationModel.countDocuments({ ...active, ...this.classFilter('tasks') }),
      this.notificationModel.countDocuments(archived),
    ]);
    return { all, unread, system, opportunities, tasks, archived: archivedCount };
  }

  private encodeCursor(params: NormalizedNotificationListParams, item?: Notification): string | null {
    const createdAt = (item as Notification & { createdAt?: Date })?.createdAt;
    if (!item || !createdAt) return null;
    return Buffer.from(JSON.stringify({
      userId: params.userId,
      filter: params.filter,
      archived: params.archived,
      unreadOnly: params.unreadOnly,
      createdAt: new Date(createdAt).toISOString(),
      id: item._id,
    } satisfies NotificationCursor)).toString('base64url');
  }

  private decodeCursor(value: string, params: NormalizedNotificationListParams): NotificationCursor {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<NotificationCursor>;
      if (
        parsed.userId !== params.userId ||
        parsed.filter !== params.filter ||
        parsed.archived !== params.archived ||
        parsed.unreadOnly !== params.unreadOnly ||
        typeof parsed.createdAt !== 'string' ||
        Number.isNaN(new Date(parsed.createdAt).getTime()) ||
        typeof parsed.id !== 'string' ||
        !parsed.id
      ) {
        throw new Error('cursor mismatch');
      }
      return parsed as NotificationCursor;
    } catch {
      throw new BadRequestException('Notification cursor is invalid');
    }
  }

  private categoryFromFilter(filter?: string): NotificationCategory | undefined {
    if (filter === 'ai') return 'ai';
    if (filter === 'workflow') return 'workflow';
    if (filter === 'collaboration') return 'collaboration';
    if (filter === 'admin') return 'admin';
    return undefined;
  }
}

function dataOpportunityId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>).opportunityId;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function withDataOpportunity(input: Partial<Notification>, opportunityId: string): Partial<Notification> {
  return { ...input, data: { ...(input.data ?? {}), opportunityId } };
}
