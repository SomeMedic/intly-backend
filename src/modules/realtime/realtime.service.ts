import { Injectable, Logger, MessageEvent, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { Observable, Subject, interval, merge } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { randomUUID } from 'node:crypto';

import { newId } from '../../common/schema';

export interface DomainEvent {
  id: string;
  type: string;
  timestamp: string;
  userId: string;
  payload: Record<string, unknown>;
}

type FanoutEnvelope = DomainEvent & { originNodeId: string };

const REALTIME_CHANNEL = 'intly:realtime:events';

@Injectable()
export class RealtimeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly nodeId = randomUUID();
  private readonly events = new Subject<DomainEvent>();
  private publisher?: IORedis;
  private subscriber?: IORedis;
  private redisReady = false;

  constructor(@Optional() private readonly config?: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const redisUrl = this.config?.get<string>('REDIS_URL');
    if (!redisUrl) return;
    this.publisher = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.subscriber = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.publisher.on('error', (error) => this.handleRedisError('publisher', error));
    this.subscriber.on('error', (error) => this.handleRedisError('subscriber', error));
    this.subscriber.on('message', (channel, message) => {
      if (channel !== REALTIME_CHANNEL) return;
      this.receiveFanout(message);
    });
    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.subscriber.subscribe(REALTIME_CHANNEL);
      this.redisReady = true;
    } catch (error) {
      this.redisReady = false;
      this.logger.warn(`Redis realtime fanout unavailable; using process-local SSE only: ${error instanceof Error ? error.message : 'unknown error'}`);
      await this.closeRedisClients();
    }
  }

  publish(userId: string, type: string, payload: Record<string, unknown>): void {
    const event = { id: newId(), type, timestamp: new Date().toISOString(), userId, payload };
    this.events.next(event);
    if (!this.redisReady || !this.publisher) return;
    const envelope: FanoutEnvelope = { ...event, originNodeId: this.nodeId };
    void this.publisher.publish(REALTIME_CHANNEL, JSON.stringify(envelope)).catch((error) => {
      this.redisReady = false;
      this.logger.warn(`Redis realtime publish failed; local delivery already completed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
  }

  stream(userId: string): Observable<MessageEvent> {
    return merge(
      this.events.pipe(
        filter((event) => event.userId === userId),
        map(({ userId: _userId, ...event }) => ({ id: event.id, type: event.type, data: event })),
      ),
      interval(15000).pipe(map(() => ({ type: 'heartbeat', data: { timestamp: new Date().toISOString() } }))),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.events.complete();
    await this.closeRedisClients();
  }

  private receiveFanout(message: string): void {
    try {
      const event = JSON.parse(message) as FanoutEnvelope;
      if (event.originNodeId === this.nodeId) return;
      if (!event.userId || !event.type || !event.id) return;
      const { originNodeId: _originNodeId, ...domainEvent } = event;
      this.events.next(domainEvent);
    } catch (error) {
      this.logger.warn(`Ignoring malformed realtime fanout event: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private handleRedisError(client: string, error: Error): void {
    this.redisReady = false;
    this.logger.warn(`Redis realtime ${client}: ${error.message}`);
  }

  private async closeRedisClients(): Promise<void> {
    const clients = [this.subscriber, this.publisher].filter((client): client is IORedis => Boolean(client));
    await Promise.all(clients.map(async (client) => {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }));
    this.publisher = undefined;
    this.subscriber = undefined;
  }
}
