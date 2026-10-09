import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { Model } from 'mongoose';
import { createHash } from 'node:crypto';
import { DeadLetter } from './schemas/dead-letter.schema';
import { Actor } from '../../common/access';
import { AuditService } from '../audit/audit.service';
import { newId } from '../../common/schema';

export const QUEUES = ['ingestion', 'normalization', 'dedup', 'search', 'ai', 'documents', 'notifications', 'analytics', 'maintenance'] as const;
export type QueueName = typeof QUEUES[number];
export type JobHandler = (data: Record<string, unknown>, job: Job) => Promise<unknown>;
type BullQueueWithSchedulers = Queue & {
  getJobSchedulers?: (start?: number, end?: number, asc?: boolean) => Promise<unknown[]>;
  getRepeatableJobs?: (start?: number, end?: number, asc?: boolean) => Promise<unknown[]>;
};

@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private readonly redis: IORedis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly handlers = new Map<string, JobHandler>();
  private readonly workers: Worker[] = [];
  constructor(
    private readonly config: ConfigService,
    @InjectModel(DeadLetter.name) private readonly deadLetters: Model<DeadLetter>,
    @Optional() private readonly audit?: AuditService,
  ) {
    this.redis = new IORedis(config.getOrThrow<string>('REDIS_URL'), { maxRetriesPerRequest: null, lazyConnect: true });
    this.redis.on('error', error => this.logger.warn(`Redis: ${error.message}`));
  }
  queue(name: string): Queue {
    if (!QUEUES.includes(name as QueueName)) throw new Error('Unknown queue family');
    const family = name as QueueName;
    if (!this.queues.has(family)) this.queues.set(family, new Queue(family, { connection: this.redis }));
    return this.queues.get(family)!;
  }
  registerHandler(queue: string, name: string, handler: JobHandler): void {
    if (!QUEUES.includes(queue as QueueName)) throw new Error('Unknown queue family');
    const key = `${queue}/${name}`;
    if (this.handlers.has(key)) throw new Error(`Duplicate job handler: ${key}`);
    this.handlers.set(key, handler);
  }
  async enqueue(queue: string, name: string, data: Record<string, unknown>, options?: { jobId?: string; delay?: number }): Promise<{ id: string; queue: string }> {
    const target = this.queue(queue);
    const depth = await target.getJobCounts('waiting', 'active', 'delayed');
    if (Object.values(depth).reduce((sum, count) => sum + count, 0) >= this.config.getOrThrow<number>('QUEUE_BACKPRESSURE_LIMIT')) throw new ServiceUnavailableException({ code: 'QUEUE_BACKPRESSURE', message: 'Queue is temporarily at capacity' });
    const jobId = options?.jobId ? createHash('sha256').update(options.jobId).digest('hex') : undefined;
    const job = await target.add(name, { jobVersion: 1, requestId: newId(), ...data }, { jobId, delay: options?.delay, attempts: 5, backoff: { type: 'exponential', delay: 1500 }, removeOnComplete: { age: 86400, count: 2000 }, removeOnFail: { age: 30 * 86400, count: 10000 } });
    return { id: job.id!, queue };
  }
  async onApplicationBootstrap(): Promise<void> {
    const shouldRun = this.config.get<string>('RUN_WORKERS') === 'true' || (this.config.get('NODE_ENV') === 'development' && this.config.get('RUN_WORKERS') !== 'false');
    if (!shouldRun) return;
    for (const family of QUEUES) {
      if (![...this.handlers.keys()].some(key => key.startsWith(`${family}/`))) continue;
      const connection = this.redis.duplicate();
      const worker = new Worker(family, async job => {
        const handler = this.handlers.get(`${family}/${job.name}`);
        if (!handler) throw new UnrecoverableError(`No registered handler for ${family}/${job.name}`);
        const context = {
          jobId: job.id,
          queue: family,
          jobName: job.name,
          requestId: typeof job.data.requestId === 'string' ? job.data.requestId : undefined,
          sourceId: typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined,
          runId: typeof job.data.runId === 'string' ? job.data.runId : undefined,
        };
        const startedAt = Date.now();
        this.logger.log({ message: 'Job started', ...context });
        try {
          const result = await handler(job.data, job);
          this.logger.log({ message: 'Job completed', ...context, durationMs: Date.now() - startedAt });
          return result;
        } catch (error) {
          this.logger.warn({ message: 'Job attempt failed', ...context, attempt: job.attemptsMade + 1, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }, { connection, concurrency: ['ai', 'documents', 'analytics'].includes(family) ? 2 : this.config.getOrThrow<number>('WORKER_CONCURRENCY'), limiter: { max: family === 'ingestion' ? 10 : 30, duration: 1000 } });
      worker.on('error', error => this.logger.error(`${family}: ${error.message}`));
      worker.on('failed', (job, error) => {
        if (!job || (job.attemptsMade < (job.opts.attempts ?? 1) && !(error instanceof UnrecoverableError))) return;
        void this.deadLetters.updateOne({ queue: family, jobId: job.id }, { $setOnInsert: { _id: newId(), queue: family, jobId: job.id, name: job.name, data: job.data, error: error.message.slice(0, 2000), attempts: job.attemptsMade, status: 'Failed' } }, { upsert: true }).catch(failure => this.logger.error(`DLQ persistence: ${failure.message}`));
      });
      this.workers.push(worker);
    }
  }
  async health(): Promise<boolean> { try { return await this.redis.ping() === 'PONG'; } catch { return false; } }
  async infrastructureMetrics(): Promise<Record<string, number | string | null>> {
    const [memory, clients, persistence] = await Promise.all(['memory', 'clients', 'persistence'].map(section => this.redis.info(section)));
    const entries = Object.fromEntries(`${memory}\n${clients}\n${persistence}`.split('\n').flatMap(line => {
      const separator = line.indexOf(':');
      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1).trim()]] : [];
    }));
    const numeric = (key: string) => {
      const value = Number(entries[key]);
      return entries[key] !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
    };
    return { memoryBytes: numeric('used_memory'), peakMemoryBytes: numeric('used_memory_peak'), maxMemoryBytes: numeric('maxmemory'), connections: numeric('connected_clients'), aofEnabled: numeric('aof_enabled'), lastSnapshotStatus: entries.rdb_last_bgsave_status ?? null };
  }
  async counts(): Promise<Array<{ name: string; counts: Record<string, number> }>> {
    const backpressureLimit = this.config.getOrThrow<number>('QUEUE_BACKPRESSURE_LIMIT');
    const defaultConcurrency = this.config.getOrThrow<number>('WORKER_CONCURRENCY');
    return Promise.all(QUEUES.map(async name => ({
      name,
      counts: await this.queue(name).getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
      concurrency: ['ai', 'documents', 'analytics'].includes(name) ? 2 : defaultConcurrency,
      rateLimit: { max: name === 'ingestion' ? 10 : 30, durationMs: 1000 },
      backpressureLimit,
    })));
  }
  async list(queue: string, state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' = 'failed') {
    const jobs = await this.queue(queue).getJobs([state], 0, 49, false);
    return { items: await Promise.all(jobs.map(job => this.toJobSummary(queue, job))), nextCursor: null };
  }
  async detail(queue: string, id: string) {
    const job = await this.queue(queue).getJob(id);
    if (!job) throw new NotFoundException('Job not found');
    return {
      ...await this.toJobSummary(queue, job),
      data: this.redactSecrets(job.data),
      stacktrace: job.stacktrace ?? [],
      logsCorrelationId: typeof job.data?.requestId === 'string' ? job.data.requestId : undefined,
      attemptsStartedAt: job.processedOn ? new Date(job.processedOn) : null,
      retryBackoff: job.opts.backoff ?? null,
    };
  }
  async scheduled() {
    const items = (await Promise.all(QUEUES.map(async queueName => {
      const queue = this.queue(queueName) as BullQueueWithSchedulers;
      const readSchedulers = queue.getJobSchedulers ?? queue.getRepeatableJobs;
      if (!readSchedulers) return [];
      const rows = await readSchedulers.call(queue, 0, 99, true);
      return rows.map((item) => this.toScheduledSummary(queueName, item));
    }))).flat();
    return { items, nextCursor: null };
  }
  async cancel(queue: string, id: string, actor?: Actor): Promise<{ success: true }> {
    const job = await this.queue(queue).getJob(id);
    if (!job) throw new NotFoundException('Job not found');
    const state = await job.getState();
    if (!['waiting', 'delayed'].includes(state)) throw new BadRequestException('Only waiting or delayed jobs can be cancelled safely');
    await job.remove();
    await this.auditAdmin(actor, 'jobs.cancel', queue, id, ['state']);
    return { success: true };
  }
  async retry(queue: string, id: string, actor?: Actor): Promise<{ success: true }> {
    const job = await this.queue(queue).getJob(id);
    if (!job || await job.getState() !== 'failed') throw new Error('Only failed jobs can be retried');
    await job.retry();
    await this.deadLetters.updateOne({ queue, jobId: id }, { status: 'Replayed', replayedAt: new Date() });
    await this.auditAdmin(actor, 'jobs.retry', queue, id, ['status']);
    return { success: true };
  }
  async pause(queue: string, actor?: Actor): Promise<{ success: true }> {
    await this.queue(queue).pause();
    await this.auditAdmin(actor, 'jobs.pause', queue, queue, ['queue']);
    return { success: true };
  }
  async resume(queue: string, actor?: Actor): Promise<{ success: true }> {
    await this.queue(queue).resume();
    await this.auditAdmin(actor, 'jobs.resume', queue, queue, ['queue']);
    return { success: true };
  }
  async dismissDlq(queue: string, id: string, actor?: Actor): Promise<{ success: true }> {
    await this.deadLetters.updateOne({ queue, jobId: id, status: 'Failed' }, { $set: { status: 'Dismissed', dismissedAt: new Date(), dismissedByUserId: actor?.id } });
    await this.auditAdmin(actor, 'jobs.dlq.dismiss', queue, id, ['status']);
    return { success: true };
  }
  async dlq() { return { items: await this.deadLetters.find({ status: 'Failed' }).sort({ createdAt: -1 }).limit(100).select('-data').exec(), nextCursor: null }; }

  private async toJobSummary(queue: string, job: Job) {
    const state = await job.getState();
    const maxAttempts = job.opts.attempts ?? 1;
    const durationMs = job.processedOn && job.finishedOn ? Math.max(job.finishedOn - job.processedOn, 0) : undefined;
    return {
      id: job.id,
      queue,
      name: job.name,
      state,
      attempts: job.attemptsMade,
      maxAttempts,
      createdAt: new Date(job.timestamp),
      startedAt: job.processedOn ? new Date(job.processedOn) : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
      durationMs,
      failedReason: job.failedReason,
      progress: job.progress,
      entity: this.extractEntity(job.data),
      canRetry: state === 'failed',
      canCancel: state === 'waiting' || state === 'delayed',
    };
  }

  private toScheduledSummary(queue: string, item: unknown) {
    const row = (item ?? {}) as Record<string, unknown>;
    const next = row.next ?? row.nextRun ?? row.timestamp;
    return {
      queue,
      id: String(row.id ?? row.key ?? row.name ?? `${queue}:scheduled`),
      name: String(row.name ?? row.id ?? 'scheduled'),
      pattern: row.pattern ?? row.cron ?? row.every ?? null,
      nextRunAt: typeof next === 'number' ? new Date(next) : next ?? null,
      raw: this.redactSecrets(row),
    };
  }

  private redactSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.redactSecrets(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      const normalized = key.toLowerCase();
      if (normalized.includes('secret') || normalized.includes('token') || normalized.includes('password') || normalized.includes('apikey') || normalized === 'key') return [key, '[redacted]'];
      return [key, this.redactSecrets(entry)];
    }));
  }

  private extractEntity(data: Record<string, unknown>) {
    const keys = ['sourceId', 'opportunityId', 'userId', 'documentId', 'notificationId', 'runId', 'eventId'];
    return Object.fromEntries(keys.flatMap(key => typeof data[key] === 'string' ? [[key, data[key]]] : []));
  }

  private async auditAdmin(actor: Actor | undefined, action: string, queue: string, entityId: string, fields: string[]): Promise<void> {
    if (!actor || !this.audit) return;
    await this.audit.record(actor, action, `job:${queue}`, entityId, fields);
  }
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map(worker => worker.close()));
    await Promise.all([...this.queues.values()].map(queue => queue.close()));
    await this.redis.quit();
  }
}
