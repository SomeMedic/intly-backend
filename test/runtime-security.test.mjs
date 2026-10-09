import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-intly-auth';
process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-secret';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { WebhooksService } = require('../src/modules/webhooks/webhooks.service.ts');
const { NotificationsService } = require('../src/modules/notifications/notifications.service.ts');
const { SourcesService } = require('../src/modules/sources/sources.service.ts');
const { assertPublicHttpUrl, parseHttpUrl } = require('../src/modules/sources/extraction/url-safety.ts');

class InMemorySourceRepository {
  constructor(source) {
    this.source = source;
    this.runs = new Map();
    this.dlq = [];
    this.health = [];
  }
  async ensureCatalog() {}
  async get(id) {
    assert.equal(id, this.source._id);
    return { ...this.source };
  }
  async createRun(input) {
    const run = { _id: input._id ?? crypto.randomUUID(), stats: {}, checkpointAfter: {}, ...input };
    this.runs.set(run._id, run);
    return { ...run };
  }
  async getRun(id) {
    return { ...this.runs.get(id) };
  }
  async startRun(id) {
    const run = this.runs.get(id);
    if (!run || run.status !== 'Queued' || run.requestedStopAt) return null;
    Object.assign(run, { status: 'Running', startedAt: new Date(), error: undefined });
    return { ...run };
  }
  async updateRun(id, patch) {
    const run = this.runs.get(id);
    Object.assign(run, patch);
    return { ...run };
  }
  async updateHealth(_id, patch) {
    this.health.push(patch);
  }
  async createDlq(input) {
    this.dlq.push(input);
    return input;
  }
  async updateCheckpoint(id, checkpoint) {
    this.source = { ...this.source, checkpoint, lastSuccessAt: new Date() };
  }
}

function makeSourcesService(repository, connector) {
  return new SourcesService(
    repository,
    { get: () => connector },
    { normalize: (_source, record) => record },
    { collapseBatch: (records) => ({ records, duplicates: 0 }) },
    { encrypt: JSON.stringify, decrypt: JSON.parse },
    { record: async () => undefined },
    { registerHandler: () => undefined, enqueue: async () => undefined, queue: () => ({ add: async () => undefined }) },
    { publish: () => undefined },
    { ingestFromSource: async ({ records }) => ({ seen: records.length, normalized: records.length, upserted: records.length, created: records.length, updated: 0, duplicates: 0, failed: 0 }) },
  );
}

test('Telegram link confirmation accepts only Telegram update data, not caller-supplied chatId', async () => {
  const token = 'abcdefghijklmnopqrstuvwxyz123456';
  const tokenHash = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(token).digest('hex'));
  const user = { _id: 'user-1', email: 'u@example.test', telegram: { linkTokenHash: tokenHash, linkRequestedAt: new Date() } };
  const updates = [];
  const service = new NotificationsService(
    {},
    { getById: async () => user, findByTelegramLinkTokenHash: async (hash) => hash === tokenHash ? user : null, update: async (_id, patch) => { updates.push(patch); return { ...user, ...patch }; } },
    { publish: () => undefined },
    { registerHandler: () => undefined, enqueue: async () => undefined },
    { encrypt: (value) => `enc:${value}`, decrypt: (value) => value.replace(/^enc:/, '') },
  );

  await service.confirmTelegramWebhook({ message: { text: `/start ${token}`, chat: { id: 424242 } }, chatId: 'attacker' });

  assert.equal(updates[0].telegram.chatIdEncrypted, 'enc:424242');
});

test('webhook creation blocks loopback and private webhook targets before delivery', async () => {
  const service = new WebhooksService(
    { create: async (input) => ({ _id: 'webhook-1', ...input }) },
    { registerHandler: () => undefined, enqueue: async () => undefined },
    { encrypt: (value) => `enc:${value}`, decrypt: (value) => value.replace(/^enc:/, '') },
  );

  await assert.rejects(() => service.create({ id: 'user-1' }, { name: 'bad', url: 'http://127.0.0.1/hook', events: ['test'], secret: 'secret' }), /private|loopback|Localhost/i);
});

test('URL safety blocks IPv4-mapped IPv6 private addresses', async () => {
  await assert.rejects(() => assertPublicHttpUrl(parseHttpUrl('http://[::ffff:127.0.0.1]/')), /private|loopback|link-local/i);
});

test('source run failures are persisted and rethrown so BullMQ can retry', async () => {
  const repository = new InMemorySourceRepository({ _id: 'source-1', enabled: true, runtimeState: 'Enabled', checkpoint: {}, connectorFamily: 'HttpRss', config: {} });
  const service = makeSourcesService(repository, {
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => { throw new Error('upstream failed'); },
    checkpoint: () => ({}),
  });
  const run = await repository.createRun({ sourceId: 'source-1', runType: 'scheduled', status: 'Queued', checkpointBefore: {} });

  await assert.rejects(() => service.executeRun(run._id), /upstream failed/);
  assert.equal(repository.runs.get(run._id).status, 'Failed');
  assert.equal(repository.dlq.length, 1);
});

test('disabled scheduled source job is cancelled without connector execution', async () => {
  const repository = new InMemorySourceRepository({ _id: 'source-1', enabled: false, runtimeState: 'Disabled', checkpoint: {}, connectorFamily: 'HttpRss', config: {} });
  let fetched = false;
  const service = makeSourcesService(repository, {
    validateConfig: async () => ({ ok: true }),
    fetchPage: async () => { fetched = true; return { records: [] }; },
    checkpoint: () => ({}),
  });
  const queued = await repository.createRun({
    sourceId: 'source-1',
    runType: 'scheduled',
    status: 'Queued',
    checkpointBefore: {},
    requestMetadata: { scheduled: true, backfillDays: 30 },
  });

  const run = await service.executeQueuedRun({ runId: queued._id, sourceId: 'source-1', scheduled: true, backfillDays: 30 });

  assert.equal(run.status, 'Cancelled');
  assert.equal(fetched, false);
});
