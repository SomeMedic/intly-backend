import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');
const { BadRequestException, ForbiddenException, NotFoundException } = require('@nestjs/common');
const { plainToInstance } = require('class-transformer');
const { validateSync } = require('class-validator');
const { OpportunitiesService } = require('../src/modules/opportunities/opportunities.service.ts');
const { IssueReportsRepository } = require('../src/modules/opportunities/issue-reports.repository.ts');
const { BulkAdminReportsDto, ListAdminReportsDto, UpdateAdminReportDto } = require('../src/modules/opportunities/dto/opportunity.dto.ts');

const admin = { id: 'admin', role: 'Admin', email: 'admin@example.test' };
const member = { id: 'member', role: 'User', email: 'member@example.test' };
const reportId = '7ed51093-f83a-41f9-9e3a-1ae58d2b6e15';

function fixture({ types = ['money', 'money'], failureIds = [], sourcesRepository, groupedCount = 2 } = {}) {
  const opportunity = { _id: 'opportunity', title: 'Existing canonical title', type: 'vacancy', sourceStatus: 'Active', money: { currency: 'USD', period: 'YEAR', min: 100000 }, sourceOccurrences: [{ sourceId: 'native', url: 'https://example.test/job', primary: true }, { sourceId: 'manual', url: 'https://example.test/manual', primary: false }] };
  const original = structuredClone(opportunity);
  const reports = new Map(types.map((type, index) => [`report-${index}`, { _id: `report-${index}`, opportunityId: opportunity._id, userId: 'member', assignedAdminId: 'admin', type, status: 'Open' }]));
  const users = [admin, member, { id: 'suspended-admin', role: 'Admin', status: 'Suspended', email: 'suspended@example.test' }].map(user => ({ ...user, _id: user.id, status: user.status ?? 'Active' }));
  const writes = [], audits = [];
  const service = new OpportunitiesService(
    { getById: async () => opportunity }, {},
    {
      get: async id => { if (!reports.has(id)) throw new NotFoundException('Issue report not found'); return reports.get(id); },
      related: async () => [],
      groupedCounts: async () => ({ opportunity: groupedCount }),
      update: async (id, patch, unset = []) => {
        writes.push({ id, patch, unset });
        if (failureIds.includes(id)) throw new Error('fixture storage failure');
        const updated = { ...reports.get(id), ...patch };
        for (const key of unset) delete updated[key];
        reports.set(id, updated);
        return updated;
      },
    }, {}, {}, {}, undefined,
    sourcesRepository ? { get: () => sourcesRepository } : undefined,
    undefined, undefined, { record: async (...args) => audits.push(args) },
    { findByIds: async ids => users.filter(user => ids.includes(user._id)), findById: async id => users.find(user => user._id === id) ?? null },
  );
  return { service, reports, writes, audits, opportunity, original };
}

test('bulk confirmation, nonempty selection and size guard reject before any writes', async () => {
  for (const dto of [
    { ids: ['report-0'], action: 'resolve' },
    { ids: [], action: 'resolve', confirmed: true },
    { ids: Array.from({ length: 101 }, (_, i) => `report-${i}`), action: 'resolve', confirmed: true },
    { ids: ['report-0'], action: 'other', confirmed: true },
  ]) {
    const { service, writes, audits } = fixture();
    await assert.rejects(service.adminBulkReports(admin, dto), BadRequestException);
    assert.equal(writes.length, 0);
    assert.equal(audits.length, 0);
  }
});

test('mixed categories reject the whole selection before triage or audit', async () => {
  const { service, writes, reports, audits } = fixture({ types: ['money', 'closed'] });
  await assert.rejects(service.adminBulkReports(admin, { ids: [...reports.keys()], action: 'dismiss', confirmed: true }), /same category/);
  assert.equal(writes.length, 0);
  assert.equal(audits.length, 0);
  assert.ok([...reports.values()].every(report => report.status === 'Open'));
});

test('homogeneous bulk deduplicates IDs and retains missing/failed results without canonical edits', async () => {
  const { service, writes, opportunity, original, audits } = fixture({ failureIds: ['report-1'] });
  const result = await service.adminBulkReports(admin, { ids: ['report-0', 'missing', 'report-1', 'report-0'], action: 'resolve', reason: 'Reviewed', confirmed: true });
  assert.deepEqual(result.items.map(item => [item.id, item.success]), [['report-0', true], ['missing', false], ['report-1', false]]);
  assert.equal(result.items[0].status, 'Resolved');
  assert.deepEqual(writes.map(item => item.id), ['report-0', 'report-1']);
  assert.deepEqual(opportunity, original);
  assert.equal(writes[0].patch.resolution.reason, 'Reviewed');
  assert.ok(audits.some(args => args[1] === 'report.bulk.resolve'));
});

test('all report admin operations reject a User before reads or mutations', async () => {
  const { service, writes } = fixture();
  await assert.rejects(service.adminListReports(member, {}), ForbiddenException);
  await assert.rejects(service.adminGetReport(member, 'report-0'), ForbiddenException);
  await assert.rejects(service.adminUpdateReport(member, 'report-0', { priority: 'high' }), ForbiddenException);
  await assert.rejects(service.adminResolveReport(member, 'report-0', {}), ForbiddenException);
  await assert.rejects(service.adminDismissReport(member, 'report-0', {}), ForbiddenException);
  await assert.rejects(service.adminBulkReports(member, { ids: ['report-0'], action: 'resolve', confirmed: true }), ForbiddenException);
  assert.equal(writes.length, 0);
});

test('assignment requires an active existing Admin and rejects normal/suspended/missing accounts', async () => {
  const { service, writes } = fixture();
  for (const assignedAdminId of ['member', 'suspended-admin', 'missing', '']) {
    await assert.rejects(service.adminUpdateReport(admin, 'report-0', { assignedAdminId }), BadRequestException);
  }
  assert.equal(writes.length, 0);
  const assigned = await service.adminUpdateReport(admin, 'report-0', { assignedAdminId: 'admin' });
  assert.equal(assigned.assignedAdminId, 'admin');
  assert.equal(assigned.assignee.role, 'Admin');
});

test('omitted assignment stays intact; explicit null removes it and supports reopening', async () => {
  const { service, reports, audits } = fixture();
  await service.adminUpdateReport(admin, 'report-0', { priority: 'high' });
  assert.equal(reports.get('report-0').assignedAdminId, 'admin');
  await service.adminDismissReport(admin, 'report-0', { reason: 'No issue' });
  const reopened = await service.adminUpdateReport(admin, 'report-0', { status: 'Open', assignedAdminId: null, adminComment: 'Recheck' });
  assert.equal(reopened.status, 'Open');
  assert.equal(reopened.assignee, null);
  assert.equal(Object.hasOwn(reports.get('report-0'), 'assignedAdminId'), false);
  assert.ok(audits.some(args => args[1] === 'report.update' && args[4].includes('assignedAdminId')));
});

test('detail uses the full group count rather than the related-report display cap', async () => {
  const { service } = fixture({ groupedCount: 37 });
  assert.equal((await service.adminGetReport(admin, 'report-0')).duplicateGroupCount, 37);
});

test('source diagnostics allowlist preserves real states and recent run while excluding credentials and payloads', async () => {
  const { service } = fixture({ sourcesRepository: {
    get: async id => { if (id === 'manual') throw new NotFoundException(); return { name: 'Native source', enabled: false, runtimeState: 'RequiresAccount', lastSuccessAt: new Date('2026-10-01T00:00:00Z'), config: { apiKey: 'secret-key' }, lastError: 'secret-error' }; },
    latestCollectionRun: async () => ({ _id: 'run', status: 'Failed', startedAt: new Date('2026-10-02T00:00:00Z'), stats: { seen: 3, upserted: 2, failed: 1, arbitraryNumericSecret: 123, normalized: Number.NaN }, error: 'secret-run-error', checkpointAfter: { token: 'secret-token' }, requestMetadata: { password: 'secret-password' } }),
  } });
  const detail = await service.adminGetReport(admin, 'report-0');
  assert.deepEqual(detail.sourceDiagnostics, [
    { sourceId: 'native', name: 'Native source', runtimeState: 'RequiresAccount', enabled: false, lastSuccessAt: '2026-10-01T00:00:00.000Z', latestRun: { id: 'run', status: 'Failed', startedAt: '2026-10-02T00:00:00.000Z', finishedAt: null, stats: { seen: 3, upserted: 2, failed: 1 } } },
    { sourceId: 'manual' },
  ]);
  assert.ok(!JSON.stringify(detail.sourceDiagnostics).includes('secret'));
});

test('unavailable supplementary diagnostics do not turn a saved action into a failure', async () => {
  const { service } = fixture({ sourcesRepository: { get: async () => { throw new Error('Unavailable database'); }, latestCollectionRun: async () => null } });
  const result = await service.adminBulkReports(admin, { ids: ['report-0'], action: 'dismiss', confirmed: true });
  assert.equal(result.items[0].success, true);
});

test('DTO validates confirmation and UUID assignees, accepts unassignment and numeric query limit', () => {
  assert.equal(validateSync(plainToInstance(BulkAdminReportsDto, { ids: [reportId], action: 'resolve' })).length, 1);
  assert.equal(validateSync(plainToInstance(BulkAdminReportsDto, { ids: [reportId], action: 'resolve', confirmed: true })).length, 0);
  assert.ok(validateSync(plainToInstance(UpdateAdminReportDto, { assignedAdminId: 'not-an-id' })).length > 0);
  assert.equal(validateSync(plainToInstance(UpdateAdminReportDto, { assignedAdminId: null })).length, 0);
  const query = plainToInstance(ListAdminReportsDto, { limit: '2', status: 'Open' });
  assert.equal(validateSync(query).length, 0);
  assert.equal(query.limit, 2);
});

test('repository total is independent of cursor and explicit assignment removal uses unset', async () => {
  let countedFilter, pageFilter, update;
  const repository = new IssueReportsRepository({
    find: filter => { pageFilter = filter; return { sort: () => ({ limit: () => ({ lean: async () => [{ _id: 'before-cursor' }] }) }) }; },
    countDocuments: async filter => { countedFilter = filter; return 23; },
    findByIdAndUpdate: (id, value) => { update = value; return { lean: async () => ({ _id: id, status: 'Open' }) }; },
  });
  const page = await repository.list({ status: 'Open', cursor: 'cursor', limit: 1 });
  assert.equal(page.total, 23);
  assert.deepEqual(countedFilter, { status: 'Open' });
  assert.deepEqual(pageFilter._id, { $lt: 'cursor' });
  await repository.update('report-0', { status: 'Open' }, ['assignedAdminId']);
  assert.deepEqual(update, { $set: { status: 'Open' }, $unset: { assignedAdminId: 1 } });
});
