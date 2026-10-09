import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');
const { AdminBackupsController, AdminInfrastructureController, AdminLogsController } = require('../src/modules/health/admin-infrastructure.controller.ts');
const { AdminInfrastructureService } = require('../src/modules/health/admin-infrastructure.service.ts');
const { createOperationalLogStream } = require('../src/common/operational-logs.ts');

describe('admin infrastructure', () => {
  it('exposes GET /admin/infrastructure', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminInfrastructureController), 'admin/infrastructure');
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminInfrastructureController.prototype.summary), '/');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminInfrastructureController.prototype.summary), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminInfrastructureController.prototype.health), 'health');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminInfrastructureController.prototype.health), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminBackupsController), 'admin/backups');
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminBackupsController.prototype.list), '/');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminBackupsController.prototype.list), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminLogsController), 'admin/logs');
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminLogsController.prototype.list), '/');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminLogsController.prototype.list), RequestMethod.GET);
  });

  it('reports unavailable required dependencies instead of fake healthy states', async () => {
    const service = new AdminInfrastructureService(
      { readyState: 0 },
      { health: async () => false, counts: async () => { throw new Error('redis down'); } },
      { get: () => undefined },
    );

    const result = await service.summary();

    assert.equal(result.status, 'issue');
    assert.equal(result.dependencies.mongo.healthy, false);
    assert.equal(result.dependencies.redis.healthy, false);
    assert.equal(result.dependencies.meili.state, 'unconfigured');
    assert.equal(result.dependencies.firecrawl.state, 'unconfigured');
    assert.equal(result.dependencies.ai.state, 'unconfigured');
    assert.equal(result.dependencies.backend.healthy, true);
  });

  it('reads backup receipts from the configured server-owned directory only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'intly-backups-'));
    writeFileSync(join(dir, 'backup-a.json'), JSON.stringify({
      id: 'backup-a',
      startedAt: '2026-10-06T10:00:00.000Z',
      finishedAt: '2026-10-06T10:00:05.000Z',
      status: 'Succeeded',
      durationMs: 5000,
      repositoryLabel: 'prod-restic',
      snapshotId: 'abc12345',
      snapshotCount: 12,
      repositoryUri: 's3:https://secret.example.test/bucket',
    }));
    writeFileSync(join(dir, 'backup-missing-start.json'), JSON.stringify({ id: 'missing-start', status: 'Succeeded' }));
    writeFileSync(join(dir, 'backup-bad-start.json'), JSON.stringify({ id: 'bad-start', startedAt: 'not-a-date', status: 'Succeeded' }));
    writeFileSync(join(dir, 'backup-unknown-status.json'), JSON.stringify({ id: 'unknown-status', startedAt: '2026-10-06T10:00:00.000Z', status: 'Done' }));
    writeFileSync(join(dir, 'backup-negative-values.json'), JSON.stringify({
      id: 'backup-negative-values',
      startedAt: '2026-10-06T10:05:00.000Z',
      status: 'Failed',
      durationMs: -1,
      snapshotCount: -2,
    }));
    const service = new AdminInfrastructureService(
      { readyState: 0 },
      { health: async () => false, counts: async () => [] },
      { get: (key) => ({ BACKUP_STATUS_DIRECTORY: dir, BACKUP_REPOSITORY_LABEL: 'prod-restic', BACKUP_CRON_SCHEDULE: '15 2 * * *' })[key] },
    );

    const result = await service.backups();

    assert.equal(result.status, 'configured');
    assert.equal(result.repositoryLabel, 'prod-restic');
    assert.equal(result.schedule, '15 2 * * *');
    assert.equal(result.items.length, 2);
    assert.equal(result.items.some((item) => item.id === 'missing-start'), false);
    assert.equal(result.items.some((item) => item.id === 'bad-start'), false);
    assert.equal(result.items.some((item) => item.id === 'unknown-status'), false);
    const negativeValues = result.items.find((item) => item.id === 'backup-negative-values');
    assert.equal(negativeValues.durationMs, undefined);
    assert.equal(negativeValues.snapshotCount, undefined);
    const backup = result.items.find((item) => item.id === 'backup-a');
    assert.deepEqual(backup, {
      id: 'backup-a',
      startedAt: '2026-10-06T10:00:00.000Z',
      finishedAt: '2026-10-06T10:00:05.000Z',
      status: 'Succeeded',
      durationMs: 5000,
      repositoryLabel: 'prod-restic',
      snapshotId: 'abc12345',
      snapshotCount: 12,
      error: undefined,
    });
    assert.equal(JSON.stringify(result).includes('secret.example.test'), false);
  });

  it('filters operational logs with capped pagination and redacts structured secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intly-logs-'));
    writeFileSync(join(dir, '2026-10-06.ndjson'), [
      JSON.stringify({ time: 'not-a-date', level: 60, msg: 'invalid time should be skipped', context: 'Broken' }),
      JSON.stringify({ time: '2026-10-06T10:00:00.000Z', level: 30, msg: 'ok', context: 'Health', reqId: 'req-1', sourceId: 'greenhouse', password: 'hidden' }),
      JSON.stringify({ time: '2026-10-06T10:01:00.000Z', level: 50, msg: 'failed bearer abc.secret', service: 'worker', context: 'Jobs', reqId: 'https://user:pass@example.test/path?token=abc', jobId: 'job-1', apiKey: 'secret', nested: { token: 'secret' } }),
      JSON.stringify({ time: '2026-10-06T10:02:00.000Z', level: 40, msg: 'source warn token=plain', context: 'Sources', sourceId: 'ashby' }),
    ].join('\n'));
    const service = new AdminInfrastructureService(
      { readyState: 0 },
      { health: async () => false, counts: async () => [] },
      { get: (key) => key === 'LOG_DIRECTORY' ? dir : undefined },
    );

    const errors = service.logs({ level: 'error', limit: 500 });
    assert.equal(errors.status, 'available');
    assert.equal(errors.items.length, 1);
    assert.equal(errors.nextCursor, null);
    assert.equal(errors.items[0].requestId, 'https://user:[redacted]@example.test/path?token=[redacted]');
    assert.equal(errors.items[0].service, 'worker');
    assert.equal(errors.items[0].message, 'failed bearer [redacted]');
    assert.equal(errors.items[0].fields.apiKey, '[redacted]');
    assert.deepEqual(errors.items[0].fields.nested, { token: '[redacted]' });

    const firstPage = service.logs({ limit: 1 });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0].level, 'warn');
    assert.equal(firstPage.nextCursor, '1');
    const secondPage = service.logs({ cursor: firstPage.nextCursor, limit: 1 });
    assert.equal(secondPage.items[0].level, 'error');

    const bySource = service.logs({ sourceId: 'greenhouse', query: 'ok' });
    assert.equal(bySource.items.length, 1);
    assert.equal(bySource.items[0].fields.password, '[redacted]');

    const invalidTime = service.logs({ context: 'Broken' });
    assert.equal(invalidTime.items.length, 0);
  });

  it('keeps stdout logging usable when file log persistence is unavailable', () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'intly-log-file-')), 'not-a-directory');
    writeFileSync(filePath, 'occupied');
    const originalStderrWrite = process.stderr.write;
    let stderr = '';
    process.stderr.write = (chunk) => {
      stderr += String(chunk);
      return true;
    };
    try {
      assert.equal(createOperationalLogStream(filePath), null);
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    assert.match(stderr, /Operational log persistence unavailable/);
  });
});
