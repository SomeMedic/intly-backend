import { z } from 'zod';

const optionalText = z.preprocess(value => typeof value === 'string' ? value.trim() || undefined : value, z.string().min(1).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  FRONTEND_URL: z.url().default('http://localhost:3000'),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/intly'),
  REDIS_URL: z.url().default('redis://127.0.0.1:6379'),
  JWT_SECRET: z.string().min(32),
  MASTER_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  QUEUE_BACKPRESSURE_LIMIT: z.coerce.number().int().min(10).default(1000),
  SOURCE_SCHEDULER_ENABLED: z.enum(['true', 'false']).default('false'),
  LOG_DIRECTORY: optionalText,
  BACKUP_STATUS_DIRECTORY: optionalText,
  BACKUP_REPOSITORY_LABEL: optionalText,
  BACKUP_CRON_SCHEDULE: optionalText,
}).passthrough();

export function validateEnvironment(environment: Record<string, unknown>): Record<string, unknown> {
  const result = envSchema.safeParse(environment);
  if (!result.success) throw new Error(`Invalid environment: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return result.data;
}
