import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import packageJson from '../../../package.json';
import { OperationalLogQuery, readOperationalLogs, redactOperationalValue } from '../../common/operational-logs';
import { JobsService } from '../jobs/jobs.service';

type InfrastructureState = 'healthy' | 'degraded' | 'unavailable' | 'unconfigured' | 'configured' | 'unknown';

type InfrastructureCheck = {
  id: string;
  label: string;
  state: InfrastructureState;
  healthy: boolean | null;
  latencyMs?: number;
  message?: string;
  details?: Record<string, unknown>;
};

type BackupReceipt = {
  id?: string;
  startedAt?: string;
  finishedAt?: string;
  status?: string;
  durationMs?: number;
  repositoryLabel?: string;
  snapshotId?: string;
  snapshotCount?: number;
  error?: string;
};

@Injectable()
export class AdminInfrastructureService {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    private readonly jobs: JobsService,
    private readonly config: ConfigService,
  ) {}

  async summary() {
    const [backend, mongo, redis, meili, minio, firecrawl, ai, embedding] = await Promise.all([
      this.checkBackend(),
      this.checkMongo(),
      this.checkRedis(),
      this.checkMeili(),
      this.checkMinio(),
      this.checkFirecrawl(),
      this.checkAi(),
      this.checkEmbedding(),
    ]);
    const services = [backend, mongo, redis, meili, minio, firecrawl, ai, embedding];
    const requiredDown = [mongo, redis].some((item) => item.healthy === false);
    const configuredDown = services.some((item) => item.healthy === false && item.state !== 'unconfigured');
    const untested = services.some((item) => item.healthy === null && item.state === 'configured');
    const status = requiredDown ? 'issue' : configuredDown ? 'degraded' : untested ? 'unknown' : 'operational';
    const queues = redis.healthy ? await this.safeQueues() : [];
    return {
      status,
      checkedAt: new Date().toISOString(),
      services,
      dependencies: Object.fromEntries(services.map((item) => [item.id, { state: item.state, healthy: item.healthy, message: item.message }])),
      queues,
    };
  }

  async backups() {
    const directory = this.config.get<string>('BACKUP_STATUS_DIRECTORY');
    const repositoryLabel = this.config.get<string>('BACKUP_REPOSITORY_LABEL');
    const schedule = this.config.get<string>('BACKUP_CRON_SCHEDULE');
    const checkedAt = new Date().toISOString();
    if (!directory) return { checkedAt, status: 'unconfigured' as const, repositoryLabel, schedule, items: [], nextCursor: null };
    try {
      const root = resolve(directory);
      const items = readdirSync(root)
        .filter((file) => file.endsWith('.json') && !file.includes('/') && !file.includes('\\'))
        .sort()
        .reverse()
        .slice(0, 50)
        .map((file) => this.parseBackupReceipt(root, file, repositoryLabel))
        .filter((item): item is NonNullable<ReturnType<AdminInfrastructureService['parseBackupReceipt']>> => Boolean(item))
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      return { checkedAt, status: 'configured' as const, repositoryLabel, schedule, items, nextCursor: null };
    } catch {
      return { checkedAt, status: 'unavailable' as const, repositoryLabel, schedule, items: [], nextCursor: null };
    }
  }

  logs(query: OperationalLogQuery = {}) {
    return readOperationalLogs(this.config.get<string>('LOG_DIRECTORY'), query);
  }

  private async checkBackend(): Promise<InfrastructureCheck> {
    return {
      id: 'backend',
      label: 'NestJS backend',
      state: 'healthy',
      healthy: true,
      latencyMs: 0,
      message: 'process alive',
      details: {
        uptimeSeconds: Math.floor(process.uptime()),
        version: this.config.get<string>('APP_VERSION') ?? packageJson.version,
        node: process.version,
      },
    };
  }

  private async checkMongo(): Promise<InfrastructureCheck> {
    return this.measure('mongo', 'MongoDB', async () => {
      if (this.mongo.readyState !== 1 || !this.mongo.db) return { state: 'unavailable', healthy: false, message: `readyState=${this.mongo.readyState}` };
      await this.mongo.db.admin().ping();
      const [stats, server] = await Promise.all([
        this.mongo.db.stats().catch(() => undefined),
        this.mongo.db.admin().serverStatus().catch(() => undefined),
      ]);
      return { state: 'healthy', healthy: true, message: 'ping ok', details: {
        dataBytes: this.nonnegativeMetric(stats?.dataSize), storageBytes: this.nonnegativeMetric(stats?.storageSize),
        indexBytes: this.nonnegativeMetric(stats?.indexSize), documents: this.nonnegativeMetric(stats?.objects),
        collections: this.nonnegativeMetric(stats?.collections), connections: this.nonnegativeMetric(server?.connections?.current),
      } };
    });
  }

  private async checkRedis(): Promise<InfrastructureCheck> {
    return this.measure('redis', 'Redis / BullMQ', async () => {
      const ok = await this.jobs.health();
      if (!ok) return { state: 'unavailable', healthy: false, message: 'ping failed' };
      const details = await this.jobs.infrastructureMetrics().catch(() => ({ memoryBytes: null, connections: null }));
      return { state: 'healthy', healthy: true, message: 'ping ok', details };
    });
  }

  private async checkMeili(): Promise<InfrastructureCheck> {
    const url = this.config.get<string>('MEILI_URL');
    if (!url) return { id: 'meili', label: 'Meilisearch', state: 'unconfigured', healthy: null, message: 'MEILI_URL is not set' };
    return this.measure('meili', 'Meilisearch', async () => this.fetchHealth(new URL('/health', url).toString(), this.meiliHeaders()));
  }

  private async checkMinio(): Promise<InfrastructureCheck> {
    const endpoint = this.config.get<string>('MINIO_ENDPOINT');
    if (!endpoint) return { id: 'minio', label: 'MinIO', state: 'unconfigured', healthy: null, message: 'MINIO_ENDPOINT is not set' };
    const base = this.minioBaseUrl(endpoint);
    return this.measure('minio', 'MinIO', async () => {
      const health = await this.fetchHealth(new URL('/minio/health/live', base).toString());
      if (!health.healthy || !this.mongo.db) return health;
      const registry = await this.mongo.db.collection('fileassets').aggregate([
        { $match: { storageProvider: 'minio', deletedAt: { $exists: false } } },
        { $facet: {
          stored: [{ $match: { status: 'Stored' } }, { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: '$size' } } }],
          failed: [{ $match: { status: 'Failed', createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } }, { $count: 'count' }],
        } },
      ]).toArray().catch(() => []);
      if (!registry[0]) return health;
      return { ...health, details: {
        registeredFileCount: this.nonnegativeMetric(registry[0].stored?.[0]?.count ?? 0),
        registeredBytes: this.nonnegativeMetric(registry[0].stored?.[0]?.bytes ?? 0),
        failedUploads30Days: this.nonnegativeMetric(registry[0].failed?.[0]?.count ?? 0),
        metricsSource: 'Application file registry; physical bucket capacity is not observed',
      } };
    });
  }

  private async checkFirecrawl(): Promise<InfrastructureCheck> {
    const endpoint = this.config.get<string>('FIRECRAWL_API_URL') ?? this.config.get<string>('FIRECRAWL_BASE_URL') ?? this.config.get<string>('FIRECRAWL_URL');
    if (!endpoint) return { id: 'firecrawl', label: 'Firecrawl', state: 'unconfigured', healthy: null, message: 'Firecrawl URL is not set' };
    return this.measure('firecrawl', 'Firecrawl', async () => this.fetchHealth(new URL('/v0/health/readiness', endpoint).toString(), this.firecrawlHeaders()));
  }

  private async checkAi(): Promise<InfrastructureCheck> {
    return this.measure('ai', 'AI providers', async () => {
      const envProviders = [
        ['openai', this.config.get<string>('OPENAI_API_KEY')],
        ['gemini', this.config.get<string>('GOOGLE_GENERATIVE_AI_API_KEY') ?? this.config.get<string>('GEMINI_API_KEY')],
        ['deepseek', this.config.get<string>('DEEPSEEK_API_KEY')],
      ].filter(([, value]) => Boolean(value));
      const dbProviders = this.mongo.readyState === 1 && this.mongo.db
        ? await this.mongo.db.collection('ai_provider_configs').countDocuments({ enabled: true, apiKeyEncrypted: { $exists: true, $ne: '' } })
        : 0;
      const configured = envProviders.length + dbProviders;
      if (!configured) return { state: 'unconfigured', healthy: null, message: 'No provider key or enabled stored provider is configured' };
      return { state: 'configured', healthy: null, message: 'Provider credentials are configured; no live provider request is run here', details: { envProviders: envProviders.map(([name]) => name), storedProviders: dbProviders } };
    });
  }

  private async checkEmbedding(): Promise<InfrastructureCheck> {
    const endpoint = this.config.get<string>('EMBEDDING_SERVICE_URL') ?? this.config.get<string>('EMBEDDING_BASE_URL') ?? this.config.get<string>('EMBEDDING_URL');
    if (!endpoint) {
      return { id: 'embedding', label: 'Embedding service', state: 'configured', healthy: null, message: 'External embedding URL is not set; service will use local extractor when available' };
    }
    return this.measure('embedding', 'Embedding service', async () => this.fetchHealth(new URL('/health', endpoint).toString()));
  }

  private async fetchHealth(url: string, headers: Record<string, string> = {}): Promise<Omit<InfrastructureCheck, 'id' | 'label' | 'latencyMs'>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (response.ok) return { state: 'healthy', healthy: true, message: `HTTP ${response.status}` };
      return { state: 'unavailable', healthy: false, message: `HTTP ${response.status}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async measure(id: string, label: string, fn: () => Promise<Omit<InfrastructureCheck, 'id' | 'label' | 'latencyMs'>>): Promise<InfrastructureCheck> {
    const started = Date.now();
    try {
      const result = await fn();
      return { id, label, latencyMs: Date.now() - started, ...result };
    } catch (error) {
      return { id, label, state: 'unavailable', healthy: false, latencyMs: Date.now() - started, message: this.safeErrorMessage(error) };
    }
  }

  private meiliHeaders(): Record<string, string> {
    const key = this.config.get<string>('MEILI_MASTER_KEY') ?? this.config.get<string>('MEILI_API_KEY');
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  private minioBaseUrl(endpoint: string): string {
    if (/^https?:\/\//i.test(endpoint)) return endpoint;
    const protocol = this.config.get<string>('MINIO_USE_SSL') === 'true' ? 'https' : 'http';
    const port = this.config.get<string>('MINIO_PORT') ?? '9000';
    return `${protocol}://${endpoint}:${port}`;
  }

  private firecrawlHeaders(): Record<string, string> {
    const key = this.config.get<string>('FIRECRAWL_API_KEY');
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  private async safeQueues() {
    try {
      return await this.jobs.counts();
    } catch (error) {
      return [{ name: 'all', counts: {}, error: error instanceof Error ? error.message : 'queue counts failed' }];
    }
  }

  private parseBackupReceipt(root: string, file: string, repositoryLabel?: string) {
    try {
      const receipt = JSON.parse(readFileSync(join(root, file), 'utf8')) as BackupReceipt;
      if (typeof receipt.startedAt !== 'string' || !Number.isFinite(Date.parse(receipt.startedAt))) return null;
      const status = this.normalizeBackupStatus(receipt.status);
      if (!status) return null;
      const finishedAt = typeof receipt.finishedAt === 'string' && Number.isFinite(Date.parse(receipt.finishedAt)) ? receipt.finishedAt : undefined;
      const durationMs = typeof receipt.durationMs === 'number' && Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0 ? receipt.durationMs : undefined;
      const snapshotCount = typeof receipt.snapshotCount === 'number' && Number.isFinite(receipt.snapshotCount) && receipt.snapshotCount >= 0 ? receipt.snapshotCount : undefined;
      return {
        id: typeof receipt.id === 'string' && receipt.id ? receipt.id : file.replace(/\.json$/, ''),
        startedAt: receipt.startedAt,
        finishedAt,
        status,
        durationMs,
        repositoryLabel: typeof receipt.repositoryLabel === 'string' ? receipt.repositoryLabel : repositoryLabel,
        snapshotId: typeof receipt.snapshotId === 'string' && receipt.snapshotId ? receipt.snapshotId : undefined,
        snapshotCount,
        error: typeof receipt.error === 'string' ? String(redactOperationalValue(receipt.error)).slice(0, 500) : undefined,
      };
    } catch {
      return null;
    }
  }

  private normalizeBackupStatus(status: unknown): 'Running' | 'Succeeded' | 'Failed' | null {
    if (status === 'Succeeded' || status === 'success' || status === 'succeeded') return 'Succeeded';
    if (status === 'Failed' || status === 'failure' || status === 'failed') return 'Failed';
    if (status === 'Running' || status === 'running' || status === 'started' || status === 'start') return 'Running';
    return null;
  }

  private safeErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : 'check failed';
    return String(redactOperationalValue(message)).slice(0, 500);
  }

  private nonnegativeMetric(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
}
