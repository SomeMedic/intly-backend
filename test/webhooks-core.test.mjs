import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { BadRequestException } = require('@nestjs/common');
const { WebhooksService } = require('../src/modules/webhooks/webhooks.service.ts');

class InMemoryWebhooksRepository {
  webhooks = new Map();
  deliveries = new Map();

  constructor() {
    this.webhooks.set('hook-enabled', { _id: 'hook-enabled', userId: 'user-a', enabled: true, url: 'https://example.com', events: ['test'], secretEncrypted: 'secret' });
    this.webhooks.set('hook-disabled', { _id: 'hook-disabled', userId: 'user-a', enabled: false, url: 'https://example.com', events: ['test'], secretEncrypted: 'secret' });
    this.deliveries.set('delivery-a', { _id: 'delivery-a', userId: 'user-a', webhookId: 'hook-enabled', event: 'test', status: 'failed', attempts: 2, errorSummary: 'timeout' });
    this.deliveries.set('delivery-disabled', { _id: 'delivery-disabled', userId: 'user-a', webhookId: 'hook-disabled', event: 'test', status: 'failed', attempts: 1 });
  }

  async listDeliveriesOwned(userId, webhookId) {
    await this.getOwned(webhookId, userId);
    return [...this.deliveries.values()].filter((delivery) => delivery.userId === userId && delivery.webhookId === webhookId);
  }

  async getOwned(id, userId) {
    const webhook = this.webhooks.get(id);
    if (!webhook || webhook.userId !== userId) throw new Error('Webhook not found');
    return { ...webhook };
  }

  async getDeliveryOwned(userId, deliveryId) {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.userId !== userId) throw new Error('Webhook delivery not found');
    return { ...delivery };
  }

  async markDeliveryQueued(id) {
    const delivery = this.deliveries.get(id);
    Object.assign(delivery, { status: 'queued', errorSummary: undefined, statusCode: undefined });
    return { ...delivery };
  }
}

function makeService() {
  const repo = new InMemoryWebhooksRepository();
  const jobs = { enqueued: [], registerHandler() {}, async enqueue(queue, name, data, opts) { this.enqueued.push({ queue, name, data, opts }); } };
  const crypto = { encrypt(value) { return value; }, decrypt(value) { return value; } };
  return { jobs, repo, service: new WebhooksService(repo, jobs, crypto) };
}

test('webhook delivery history is scoped to the owning user and webhook', async () => {
  const { service } = makeService();
  const result = await service.deliveries({ id: 'user-a', email: 'user@intly.local', role: 'User' }, 'hook-enabled');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]._id, 'delivery-a');
  await assert.rejects(() => service.deliveries({ id: 'user-b', email: 'other@intly.local', role: 'User' }, 'hook-enabled'));
});

test('webhook retry requeues an owned delivery and blocks disabled hooks', async () => {
  const { jobs, service } = makeService();
  const queued = await service.retry({ id: 'user-a', email: 'user@intly.local', role: 'User' }, 'delivery-a');
  assert.equal(queued.status, 'queued');
  assert.equal(jobs.enqueued.length, 1);
  assert.equal(jobs.enqueued[0].data.deliveryId, 'delivery-a');
  await assert.rejects(
    () => service.retry({ id: 'user-a', email: 'user@intly.local', role: 'User' }, 'delivery-disabled'),
    BadRequestException,
  );
});
