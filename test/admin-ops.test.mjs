import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { BadRequestException } = require('@nestjs/common');
const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');
const { JobsController } = require('../src/modules/jobs/jobs.controller.ts');
const { JobsService } = require('../src/modules/jobs/jobs.service.ts');
const { AdminReportsController } = require('../src/modules/opportunities/opportunities.controller.ts');
const { OpportunitiesService } = require('../src/modules/opportunities/opportunities.service.ts');

describe('admin jobs contracts', () => {
  it('exposes scheduled, detail and cancel routes without hijacking queue list', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, JobsController), 'admin/jobs');
    assert.equal(Reflect.getMetadata(PATH_METADATA, JobsController.prototype.scheduled), 'scheduled');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, JobsController.prototype.scheduled), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, JobsController.prototype.detail), ':queue/:id');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, JobsController.prototype.detail), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, JobsController.prototype.cancel), ':queue/:id/cancel');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, JobsController.prototype.cancel), RequestMethod.POST);
  });

  it('redacts job payload details and only marks waiting or delayed jobs cancellable', async () => {
    const service = Object.create(JobsService.prototype);
    const waitingJob = fakeJob('waiting', { requestId: 'request-1', apiKey: 'secret', nested: { password: 'hidden' }, opportunityId: 'opp-1' });
    service.queue = () => ({ getJob: async () => waitingJob });

    const detail = await service.detail('ai', 'job-1');

    assert.equal(detail.canCancel, true);
    assert.equal(detail.logsCorrelationId, 'request-1');
    assert.deepEqual(detail.data, { requestId: 'request-1', apiKey: '[redacted]', nested: { password: '[redacted]' }, opportunityId: 'opp-1' });
    assert.deepEqual(detail.entity, { opportunityId: 'opp-1' });
  });

  it('rejects active job cancellation when handlers do not support safe interruption', async () => {
    const service = Object.create(JobsService.prototype);
    service.queue = () => ({ getJob: async () => fakeJob('active', {}) });

    await assert.rejects(() => service.cancel('ai', 'active-job', adminActor()), BadRequestException);
  });
});

describe('admin report contracts', () => {
  it('exposes bulk triage before id routes', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminReportsController), 'admin/reports');
    assert.equal(Reflect.getMetadata(PATH_METADATA, AdminReportsController.prototype.bulk), 'bulk');
    assert.equal(Reflect.getMetadata(METHOD_METADATA, AdminReportsController.prototype.bulk), RequestMethod.POST);
  });

  it('enriches report lists with readable reporter and assignee summaries', async () => {
    const service = reportService();
    const result = await service.adminListReports(adminActor(), {});

    assert.equal(result.items[0].reporter.email, 'reporter@example.test');
    assert.equal(result.items[0].assignee.name, 'Admin User');
    assert.equal(result.items[0].opportunity.title, 'Backend Engineer');
  });

  it('bulk triage returns per-item success and failure without editing canonical opportunities', async () => {
    const service = reportService({ failUpdateIds: new Set(['report-fail']), homogeneous: true });
    const result = await service.adminBulkReports(adminActor(), { ids: ['report-ok', 'report-fail'], action: 'dismiss', reason: 'same invalid group', confirmed: true });

    assert.deepEqual(result.items.map((item) => [item.id, item.success]), [
      ['report-ok', true],
      ['report-fail', false],
    ]);
    assert.equal(result.items[0].status, 'Dismissed');
  });
});

function adminActor() {
  return { id: 'admin-1', email: 'admin@example.test', role: 'Admin' };
}

function fakeJob(state, data) {
  return {
    id: 'job-1',
    name: 'ai.run',
    data,
    opts: { attempts: 5, backoff: { type: 'exponential', delay: 1500 } },
    attemptsMade: 1,
    timestamp: 1790899200000,
    processedOn: 1790899201000,
    finishedOn: null,
    failedReason: undefined,
    progress: { stage: 'queued' },
    stacktrace: [],
    getState: async () => state,
    remove: async () => undefined,
  };
}

function reportService(options = {}) {
  const opportunity = {
    _id: 'opp-1',
    title: 'Backend Engineer',
    type: 'vacancy',
    sourceStatus: 'Active',
    companyOrClient: 'Intly',
    sourceOccurrences: [{ sourceId: 'hh', url: 'https://example.test/job', primary: true }],
    money: { currency: 'RUB', max: 300000 },
    remoteType: 'remote',
    location: 'Moscow',
    countriesAllowed: ['RU'],
    skills: ['TypeScript'],
    technologies: ['NestJS'],
    canonicalTags: ['backend'],
  };
  const reports = new Map([
    ['report-ok', { _id: 'report-ok', userId: 'user-1', assignedAdminId: 'admin-1', opportunityId: 'opp-1', type: 'money', comment: 'wrong budget', status: 'Open', adminComment: '', createdAt: new Date() }],
    ['report-fail', { _id: 'report-fail', userId: 'user-1', opportunityId: 'opp-1', type: options.homogeneous ? 'money' : 'closed', comment: 'closed', status: 'Open', adminComment: '', createdAt: new Date() }],
  ]);
  return new OpportunitiesService(
    {
      findByIds: async () => [opportunity],
      getById: async () => opportunity,
    },
    {},
    {
      list: async () => ({ items: [reports.get('report-ok')], nextCursor: null, total: 1 }),
      groupedCounts: async () => ({ 'opp-1': 2 }),
      get: async (id) => reports.get(id),
      related: async () => [],
      update: async (id, patch) => {
        if (options.failUpdateIds?.has(id)) throw new Error('update failed');
        const current = reports.get(id);
        const updated = { ...current, ...patch };
        reports.set(id, updated);
        return updated;
      },
    },
    {},
    {},
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    { record: async () => undefined },
    {
      findByIds: async () => [
        { _id: 'user-1', name: 'Reporter User', email: 'reporter@example.test', role: 'User', status: 'Active' },
        { _id: 'admin-1', name: 'Admin User', email: 'admin@example.test', role: 'Admin', status: 'Active' },
      ],
    },
  );
}
