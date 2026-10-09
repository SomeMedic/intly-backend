import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import type { Params } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { serializeLogRequest } from './log-request';

const SECRET_KEY_PATTERN = /(password|secret|token|api[-_]?key|authorization|cookie|session|credential)/i;
const LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.ndjson$/;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_LOG_LIMIT = 100;
let lastPersistenceErrorAt = 0;

export type OperationalLogQuery = {
  query?: string;
  level?: string;
  service?: string;
  context?: string;
  requestId?: string;
  jobId?: string;
  runId?: string;
  sourceId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string | number;
};

export type OperationalLogItem = {
  id: string;
  time: string;
  level: string;
  service?: string;
  context?: string;
  requestId?: string;
  jobId?: string;
  runId?: string;
  sourceId?: string;
  message: string;
  fields: Record<string, unknown>;
};

export function createPinoHttpConfig(): NonNullable<Params['pinoHttp']> {
  const options = {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: process.env.RUN_WORKERS === 'true' ? 'worker' : 'api' },
    genReqId: (request: { headers: Record<string, string | string[] | undefined> }) =>
      typeof request.headers['x-request-id'] === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(request.headers['x-request-id'])
        ? request.headers['x-request-id']
        : randomUUID(),
    serializers: { req: serializeLogRequest },
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.query.ticket',
      'res.headers["set-cookie"]',
      'password',
      'passwordHash',
      'token',
      'refreshToken',
      'apiKey',
      'session',
    ],
  };
  const logDirectory = process.env.LOG_DIRECTORY;
  if (!logDirectory) return options;
  const logStream = createOperationalLogStream(logDirectory, DEFAULT_RETENTION_DAYS);
  if (!logStream) return options;
  const stream = pino.multistream([
    { stream: process.stdout },
    { stream: logStream },
  ]);
  return [options, stream];
}

export function createOperationalLogStream(directory: string, retentionDays = DEFAULT_RETENTION_DAYS): Writable | null {
  const root = resolve(directory);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    reportPersistenceError(error);
    return null;
  }
  let lastRetentionCheck = 0;
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        const now = new Date();
        if (now.getTime() - lastRetentionCheck > 60 * 60 * 1000) {
          pruneOperationalLogs(root, retentionDays, now);
          lastRetentionCheck = now.getTime();
        }
        appendFileSync(join(root, `${now.toISOString().slice(0, 10)}.ndjson`), chunk, { mode: 0o600 });
        callback();
      } catch (error) {
        reportPersistenceError(error);
        callback();
      }
    },
  });
}

export function readOperationalLogs(directory: string | undefined, query: OperationalLogQuery = {}) {
  if (!directory) {
    return { checkedAt: new Date().toISOString(), status: 'unconfigured' as const, retentionDays: DEFAULT_RETENTION_DAYS, items: [], nextCursor: null };
  }
  const root = resolve(directory);
  const limit = clamp(parsePositiveInt(query.limit, 50), 1, MAX_LOG_LIMIT);
  const offset = parseCursor(query.cursor);
  const from = parseDate(query.from);
  const to = parseDate(query.to);
  try {
    const cutoff = new Date(Date.now() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const files = readdirSync(root).filter((file) => LOG_FILE_PATTERN.test(file) && basename(file, '.ndjson') >= cutoff).sort().reverse();
    const items: OperationalLogItem[] = [];
    let matched = 0;
    outer: for (const file of files) {
      const content = readFileSync(join(root, file), 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const item = parseLogLine(lines[index], `${file}:${index + 1}`);
        if (!item) continue;
        const time = Date.parse(item.time);
        if (from && time < from.getTime()) continue;
        if (to && time > to.getTime()) continue;
        if (!matchesLogQuery(item, query)) continue;
        if (matched < offset) {
          matched += 1;
          continue;
        }
        items.push(item);
        matched += 1;
        if (items.length > limit) break outer;
      }
    }
    const page = items.slice(0, limit);
    return {
      checkedAt: new Date().toISOString(),
      status: 'available' as const,
      retentionDays: DEFAULT_RETENTION_DAYS,
      items: page,
      nextCursor: items.length > limit ? String(offset + limit) : null,
    };
  } catch {
    return { checkedAt: new Date().toISOString(), status: 'unavailable' as const, retentionDays: DEFAULT_RETENTION_DAYS, items: [], nextCursor: null };
  }
}

export function redactOperationalValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactOperationalValue(item));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactOperationalValue(item)]));
}

function parseLogLine(line: string, id: string): OperationalLogItem | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const parsedTime = parseLogTime(raw.time);
    if (!parsedTime) return null;
    const time = parsedTime.toISOString();
    const level = normalizeLevel(raw.level);
    const message = redactText(String(raw.msg ?? raw.message ?? ''));
    const request = raw.req && typeof raw.req === 'object' ? raw.req as Record<string, unknown> : {};
    const fields = redactOperationalValue(raw) as Record<string, unknown>;
    delete fields.req;
    delete fields.res;
    delete fields.msg;
    delete fields.message;
    return {
      id,
      time,
      level,
      service: safeString(raw.service),
      context: safeString(raw.context) ?? safeString(raw.name),
      requestId: safeString(raw.reqId) ?? safeString(raw.requestId) ?? safeString(request.id),
      jobId: safeString(raw.jobId),
      runId: safeString(raw.runId) ?? safeString((raw.data as Record<string, unknown> | undefined)?.runId),
      sourceId: safeString(raw.sourceId),
      message,
      fields,
    };
  } catch {
    return null;
  }
}

function matchesLogQuery(item: OperationalLogItem, query: OperationalLogQuery): boolean {
  if (query.level && item.level !== query.level) return false;
  if (query.service && item.service !== query.service) return false;
  if (query.context && item.context !== query.context) return false;
  if (query.requestId && item.requestId !== query.requestId) return false;
  if (query.jobId && item.jobId !== query.jobId) return false;
  if (query.runId && item.runId !== query.runId) return false;
  if (query.sourceId && item.sourceId !== query.sourceId) return false;
  if (query.query) {
    const haystack = `${item.message} ${JSON.stringify(item.fields)}`.toLowerCase();
    if (!haystack.includes(query.query.toLowerCase())) return false;
  }
  return true;
}

function pruneOperationalLogs(root: string, retentionDays: number, now: Date): void {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const file of readdirSync(root)) {
    if (!LOG_FILE_PATTERN.test(file)) continue;
    if (basename(file, '.ndjson') < cutoff) unlinkSync(join(root, file));
  }
}

function normalizeLevel(level: unknown): string {
  if (typeof level === 'string') return level.toLowerCase();
  if (typeof level !== 'number') return 'info';
  if (level >= 60) return 'fatal';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  if (level >= 30) return 'info';
  if (level >= 20) return 'debug';
  return 'trace';
}

function parseCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

function parseLogTime(value: unknown): Date | null {
  const date = typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? redactText(value) : undefined;
}

function redactText(value: string): string {
  return value
    .replace(/(https?:\/\/[^:\s/]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|api_key|apikey|password|secret|key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(\b(?:token|api_key|apikey|password|secret|key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, '$1[redacted]');
}

function reportPersistenceError(error: unknown): void {
  const now = Date.now();
  if (now - lastPersistenceErrorAt < 60_000) return;
  lastPersistenceErrorAt = now;
  const message = error instanceof Error ? error.message : 'unknown persistence error';
  process.stderr.write(`Operational log persistence unavailable: ${redactText(message)}\n`);
}
