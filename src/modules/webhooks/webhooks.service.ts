import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';

import { createPinnedDispatcher, resolvePublicAddresses } from '../sources/extraction/pinned-fetch';
import { parseHttpUrl } from '../sources/extraction/url-safety';

import { Actor } from '../../common/access';
import { CryptoService } from '../../infrastructure/crypto.service';
import { JobsService } from '../jobs/jobs.service';
import { CreateWebhookDto, UpdateWebhookDto } from './dto/webhook.dto';
import { Webhook, WebhookDelivery, WebhookEvent } from './schemas/webhook.schema';
import { WebhooksRepository } from './webhooks.repository';

@Injectable()
export class WebhooksService implements OnModuleInit {
  constructor(
    private readonly webhooksRepository: WebhooksRepository,
    private readonly jobsService: JobsService,
    private readonly cryptoService: CryptoService,
  ) {}

  onModuleInit(): void {
    this.jobsService.registerHandler('notifications', 'webhook.deliver', async (data) => this.deliver(String(data.deliveryId)));
  }

  list(actor: Actor) {
    return this.webhooksRepository.list(actor.id).then((items) => ({ items, nextCursor: null }));
  }

  async create(actor: Actor, dto: CreateWebhookDto) {
    await this.assertWebhookUrlAllowed(dto.url);
    const saved = await this.webhooksRepository.create({
      userId: actor.id,
      name: dto.name,
      url: dto.url,
      events: dto.events,
      enabled: dto.enabled ?? true,
      secretEncrypted: this.cryptoService.encrypt(dto.secret),
    });
    const { secretEncrypted: _secret, ...publicWebhook } = saved;
    return publicWebhook;
  }

  async update(actor: Actor, id: string, dto: UpdateWebhookDto) {
    if (dto.url !== undefined) await this.assertWebhookUrlAllowed(dto.url);
    return this.webhooksRepository.updateOwned(id, actor.id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.url !== undefined ? { url: dto.url } : {}),
      ...(dto.events !== undefined ? { events: dto.events } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.secret !== undefined ? { secretEncrypted: this.cryptoService.encrypt(dto.secret) } : {}),
    });
  }

  delete(actor: Actor, id: string) {
    return this.webhooksRepository.deleteOwned(id, actor.id);
  }

  async deliveries(actor: Actor, webhookId: string, limit?: number) {
    const items = await this.webhooksRepository.listDeliveriesOwned(actor.id, webhookId, limit);
    return { items, nextCursor: null };
  }

  async retry(actor: Actor, deliveryId: string) {
    const delivery = await this.webhooksRepository.getDeliveryOwned(actor.id, deliveryId);
    const webhook = await this.webhooksRepository.getOwned(delivery.webhookId, actor.id);
    if (!webhook.enabled) throw new BadRequestException('Webhook is disabled');
    const queued = await this.webhooksRepository.markDeliveryQueued(delivery._id);
    await this.jobsService.enqueue('notifications', 'webhook.deliver', { deliveryId: queued._id }, { jobId: `webhook:${queued._id}:retry:${Date.now()}` });
    return queued;
  }

  async emit(userId: string, event: WebhookEvent, payload: Record<string, unknown>) {
    const webhooks = await this.webhooksRepository.listSubscribers(userId, event);
    const sanitized = this.redact({ ...payload, ownerUserId: userId });
    const deliveries = await Promise.all(webhooks.map((webhook) => this.queueDelivery(webhook, event, sanitized)));
    return { deliveries };
  }

  async test(actor: Actor, id: string) {
    const webhook = await this.webhooksRepository.getOwned(id, actor.id);
    return this.queueDelivery(webhook, 'test', { ok: true, generatedAt: new Date().toISOString() });
  }

  private async queueDelivery(webhook: Webhook, event: WebhookEvent, payload: Record<string, unknown>): Promise<WebhookDelivery> {
    if (!webhook.enabled) throw new BadRequestException('Webhook is disabled');
    const delivery = await this.webhooksRepository.createDelivery({
      userId: webhook.userId,
      webhookId: webhook._id,
      event,
      payload,
      status: 'queued',
    });
    await this.jobsService.enqueue('notifications', 'webhook.deliver', { deliveryId: delivery._id }, { jobId: `webhook:${delivery._id}` });
    return delivery;
  }

  private async deliver(deliveryId: string): Promise<void> {
    const delivery = await this.webhooksRepository.getDelivery(deliveryId);
    const webhook = await this.webhooksRepository.getOwned(delivery.webhookId, delivery.userId);
    if (!webhook.enabled) {
      await this.webhooksRepository.updateDelivery(deliveryId, { status: 'failed', errorSummary: 'Webhook is disabled' });
      return;
    }
    const body = JSON.stringify({ event: delivery.event, payload: delivery.payload, deliveryId: delivery._id, createdAt: new Date().toISOString() });
    const secret = this.cryptoService.decrypt(webhook.secretEncrypted);
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    try {
      const response = await this.guardedPost(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Intly-Event': delivery.event,
          'X-Intly-Delivery': delivery._id,
          'X-Intly-Signature': `sha256=${signature}`,
        },
        body,
      });
      if (response.ok) {
        await this.webhooksRepository.updateDelivery(deliveryId, { status: 'sent', statusCode: response.status, deliveredAt: new Date() });
        return;
      }
      await this.webhooksRepository.updateDelivery(deliveryId, { status: 'failed', statusCode: response.status, errorSummary: `Webhook returned ${response.status}` });
      throw new Error(`Webhook returned ${response.status}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Webhook returned ')) {
        await this.webhooksRepository.updateDelivery(deliveryId, {
          status: 'failed',
          errorSummary: error instanceof Error ? error.message.slice(0, 500) : 'Webhook delivery failed',
        });
      }
      throw error;
    }
  }


  private async guardedPost(initialUrl: string, init: RequestInit, redirects = 0): Promise<Response> {
    if (redirects > 3) throw new Error('Webhook redirected too many times');
    const url = parseHttpUrl(initialUrl);
    await this.assertWebhookUrlAllowed(url.toString());
    const dispatcher = await createPinnedDispatcher(url);
    try {
      const response = await undiciFetch(url, { ...init, dispatcher, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(15_000) } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Webhook redirect is missing location');
        const redirected = new URL(location, url);
        return this.guardedPost(redirected.toString(), init, redirects + 1);
      }
      return response;
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }

  private async assertWebhookUrlAllowed(inputUrl: string): Promise<void> {
    const url = parseHttpUrl(inputUrl);
    await resolvePublicAddresses(url);
  }

  private redact(value: unknown): Record<string, unknown> {
    const redacted = this.redactValue(value);
    return this.isRecord(redacted) ? redacted : { value: redacted };
  }

  private redactValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item));
    if (!this.isRecord(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/password|secret|token|hash|private|credential|encrypted/i.test(key)) {
        result[key] = '[redacted]';
      } else {
        result[key] = this.redactValue(item);
      }
    }
    return result;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
