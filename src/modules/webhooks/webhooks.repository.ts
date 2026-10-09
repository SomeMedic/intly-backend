import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Webhook, WebhookDelivery, WebhookDeliveryDocument, WebhookDocument, WebhookEvent } from './schemas/webhook.schema';

@Injectable()
export class WebhooksRepository {
  constructor(
    @InjectModel(Webhook.name) private readonly webhookModel: Model<WebhookDocument>,
    @InjectModel(WebhookDelivery.name) private readonly deliveryModel: Model<WebhookDeliveryDocument>,
  ) {}

  create(input: Partial<Webhook>): Promise<Webhook> {
    return this.webhookModel.create(input).then((document) => document.toObject());
  }

  list(userId: string) {
    return this.webhookModel.find({ userId, deletedAt: { $exists: false } }).sort({ createdAt: -1 }).select('-secretEncrypted').lean();
  }

  async getOwned(id: string, userId: string): Promise<Webhook> {
    const webhook = await this.webhookModel.findOne({ _id: id, userId, deletedAt: { $exists: false } }).lean();
    if (!webhook) throw new NotFoundException('Webhook not found');
    return webhook;
  }

  async updateOwned(id: string, userId: string, patch: Partial<Webhook>): Promise<Webhook> {
    const updated = await this.webhookModel.findOneAndUpdate(
      { _id: id, userId, deletedAt: { $exists: false } },
      { $set: patch },
      { returnDocument: 'after' },
    ).select('-secretEncrypted').lean();
    if (!updated) throw new NotFoundException('Webhook not found');
    return updated as Webhook;
  }

  async deleteOwned(id: string, userId: string): Promise<{ success: true }> {
    const result = await this.webhookModel.updateOne({ _id: id, userId, deletedAt: { $exists: false } }, { $set: { deletedAt: new Date(), enabled: false } });
    if (result.matchedCount === 0) throw new NotFoundException('Webhook not found');
    return { success: true };
  }

  listSubscribers(userId: string, event: WebhookEvent) {
    return this.webhookModel.find({ userId, enabled: true, deletedAt: { $exists: false }, events: event }).lean();
  }

  createDelivery(input: Partial<WebhookDelivery>): Promise<WebhookDelivery> {
    return this.deliveryModel.create(input).then((document) => document.toObject());
  }

  async getDelivery(id: string): Promise<WebhookDelivery> {
    const delivery = await this.deliveryModel.findById(id).lean();
    if (!delivery) throw new NotFoundException('Webhook delivery not found');
    return delivery;
  }

  async listDeliveriesOwned(userId: string, webhookId: string, limit = 20): Promise<WebhookDelivery[]> {
    await this.getOwned(webhookId, userId);
    return this.deliveryModel
      .find({ userId, webhookId })
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .select('-payload')
      .lean();
  }

  async getDeliveryOwned(userId: string, deliveryId: string): Promise<WebhookDelivery> {
    const delivery = await this.deliveryModel.findOne({ _id: deliveryId, userId }).lean();
    if (!delivery) throw new NotFoundException('Webhook delivery not found');
    return delivery;
  }

  async updateDelivery(id: string, patch: Partial<WebhookDelivery>): Promise<WebhookDelivery> {
    const updated = await this.deliveryModel.findByIdAndUpdate(id, { $set: patch, $inc: { attempts: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw new NotFoundException('Webhook delivery not found');
    return updated;
  }

  async markDeliveryQueued(id: string): Promise<WebhookDelivery> {
    const updated = await this.deliveryModel.findByIdAndUpdate(
      id,
      { $set: { status: 'queued' }, $unset: { errorSummary: '', statusCode: '' } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new NotFoundException('Webhook delivery not found');
    return updated;
  }
}
