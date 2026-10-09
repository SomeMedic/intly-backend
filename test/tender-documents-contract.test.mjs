import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { TenderDocumentsService } = require('../src/modules/tender-documents/tender-documents.service.ts');
const { TenderDocumentsController } = require('../src/modules/tender-documents/tender-documents.controller.ts');
const { AiService } = require('../src/modules/ai/ai.service.ts');

const actor = { id: 'user-1', email: 'u@example.test', role: 'User' };
const opportunity = { _id: '11111111-1111-4111-8111-111111111111', type: 'tender', title: 'CRM tender', description: 'Need implementation', tenderData: {} };
const profile = { _id: '22222222-2222-4222-8222-222222222222', userId: 'user-1', name: 'Main', aiPreferences: {} };

function tenderService(overrides = {}) {
  const links = [];
  const repository = overrides.repository ?? {
    create: async (input) => { const link = { _id: '33333333-3333-4333-8333-333333333333', ...input }; links.push(link); return link; },
    list: async ({ userId, opportunityId, profileId }) => links.filter((link) => (!userId || link.userId === userId) && link.opportunityId === opportunityId && link.profileId === profileId),
    get: async (id) => {
      const link = links.find((item) => item._id === id) ?? overrides.link;
      if (!link) throw new Error('not found');
      return link;
    },
    updateMany: async (ids, input) => { for (const link of links) if (ids.includes(link._id)) Object.assign(link, input); },
    softDelete: async () => undefined,
  };
  const knowledgeDocs = new Map();
  const knowledge = overrides.knowledge ?? {
    createMultipart: async (_actor, file, dto) => {
      const document = { id: '44444444-4444-4444-8444-444444444444', fileId: '55555555-5555-4555-8555-555555555555', title: dto.title, status: 'Uploading', originalName: file.originalname };
      knowledgeDocs.set(document.id, document);
      return document;
    },
    get: async (_actor, id) => knowledgeDocs.get(id) ?? { id, fileId: 'file-1', title: 'Requirements.pdf', status: 'Indexed', summary: 'Parsed tender requirements', extractedText: 'Participant must have CRM delivery experience.' },
    reprocess: async () => ({ success: true }),
    delete: async () => ({ success: true }),
  };
  const aiCalls = [];
  const ai = overrides.ai ?? {
    runTenderDocumentAnalysis: async (_actor, input) => { aiCalls.push(input); return { _id: '66666666-6666-4666-8666-666666666666', status: 'queued', taskType: 'tender_document_analysis' }; },
    getRun: async () => ({ _id: '66666666-6666-4666-8666-666666666666', status: 'queued' }),
  };
  const service = new TenderDocumentsService(
    repository,
    overrides.opportunities ?? { getById: async () => opportunity },
    overrides.profiles ?? { getOwned: async (profileId, userId) => { assert.equal(profileId, profile._id); assert.equal(userId, actor.id); return profile; }, getById: async () => profile },
    knowledge,
    ai,
    overrides.downloader,
  );
  return { service, links, aiCalls };
}

test('tender document upload creates private knowledge document link scoped to opportunity and profile', async () => {
  const { service, links } = tenderService();
  const result = await service.upload(actor, opportunity._id, { buffer: Buffer.from('pdf'), originalname: 'requirements.pdf', mimetype: 'application/pdf', size: 3 }, { profileId: profile._id, title: 'Requirements.pdf', documentType: 'participant_requirements' });
  assert.equal(result.opportunityId, opportunity._id);
  assert.equal(result.profileId, profile._id);
  assert.equal(result.fileId, '55555555-5555-4555-8555-555555555555');
  assert.equal(result.processingStatus, 'Uploading');
  assert.equal(links[0].userId, actor.id);
  assert.equal(links[0].documentType, 'participant_requirements');
});

test('users cannot read or reprocess another owner tender document link', async () => {
  const foreign = { _id: '33333333-3333-4333-8333-333333333333', userId: 'other-user', opportunityId: opportunity._id, profileId: profile._id, knowledgeDocumentId: 'doc-1', fileId: 'file-1', title: 'Foreign.pdf', documentType: 'other', aiStatus: 'Not analyzed' };
  const { service } = tenderService({ link: foreign });
  await assert.rejects(service.reprocess(actor, opportunity._id, foreign._id), /access denied|Profile scope violation|scope violation/i);
});

test('tender document service resolves alias opportunity routes before link filters and AI analysis', async () => {
  const canonical = { ...opportunity, _id: '99999999-9999-4999-8999-999999999999' };
  const calls = { list: [], create: [], ai: [] };
  const links = [{ _id: '33333333-3333-4333-8333-333333333333', userId: actor.id, opportunityId: canonical._id, profileId: profile._id, knowledgeDocumentId: 'indexed-doc', fileId: 'file-1', title: 'Requirements.pdf', documentType: 'other', aiStatus: 'Not analyzed' }];
  const { service } = tenderService({
    opportunities: { getById: async (id) => { assert.equal(id, 'old-opportunity'); return canonical; } },
    repository: {
      create: async (input) => { calls.create.push(input); const link = { _id: 'upload-link', ...input }; links.push(link); return link; },
      list: async (input) => { calls.list.push(input); return links.filter((link) => (!input.userId || link.userId === input.userId) && link.opportunityId === input.opportunityId && link.profileId === input.profileId); },
      get: async (id) => links.find((link) => link._id === id),
      updateMany: async (ids, input) => { for (const link of links) if (ids.includes(link._id)) Object.assign(link, input); },
      softDelete: async () => undefined,
    },
    ai: {
      runTenderDocumentAnalysis: async (_actor, input) => { calls.ai.push(input); return { _id: 'run-1', status: 'queued', taskType: 'tender_document_analysis' }; },
      getRun: async () => ({ _id: 'run-1', status: 'queued' }),
    },
  });

  await service.list(actor, 'old-opportunity', { profileId: profile._id });
  await service.upload(actor, 'old-opportunity', { buffer: Buffer.from('pdf'), originalname: 'requirements.pdf', mimetype: 'application/pdf', size: 3 }, { profileId: profile._id, title: 'Uploaded.pdf' });
  await service.analyze(actor, 'old-opportunity', { profileId: profile._id, tenderDocumentIds: ['33333333-3333-4333-8333-333333333333'] });

  assert.equal(calls.list[0].opportunityId, canonical._id);
  assert.equal(calls.create[0].opportunityId, canonical._id);
  assert.equal(calls.list[1].opportunityId, canonical._id);
  assert.equal(calls.ai[0].opportunityId, canonical._id);
});

test('document analysis requires indexed linked document text before queueing AI run', async () => {
  const { service, aiCalls, links } = tenderService();
  await service.upload(actor, opportunity._id, { buffer: Buffer.from('pdf'), originalname: 'requirements.pdf', mimetype: 'application/pdf', size: 3 }, { profileId: profile._id, title: 'Requirements.pdf', documentType: 'participant_requirements' });
  await assert.rejects(service.analyze(actor, opportunity._id, { profileId: profile._id }), /not ready/i);
  links[0].knowledgeDocumentId = 'indexed-doc';
  const run = await service.analyze(actor, opportunity._id, { profileId: profile._id });
  assert.equal(run.taskType, 'tender_document_analysis');
  assert.equal(aiCalls[0].tenderDocuments[0].title, 'Requirements.pdf');
  assert.equal(aiCalls[0].tenderDocuments[0].status, 'Indexed');
  assert.equal(links[0].aiRunId, run._id);
  assert.equal(links[0].aiStatus, 'Queued');
});

test('analysis endpoint returns scoped safe AI output without prompt context', async () => {
  const { service, links } = tenderService({
    ai: {
      runTenderDocumentAnalysis: async () => ({ _id: 'run-1', status: 'queued' }),
      getRun: async () => ({
        _id: 'run-1',
        userId: actor.id,
        opportunityId: opportunity._id,
        profileId: profile._id,
        taskType: 'tender_document_analysis',
        metadata: { tenderDocumentIds: ['33333333-3333-4333-8333-333333333333'] },
        status: 'completed',
        stage: 'completed',
        structuredOutput: { summary: 'Requirements summary', risks: ['Penalty'] },
        aiScore: 71,
        prompt: { secret: 'hidden' },
        completedAt: new Date('2026-10-05T10:00:00.000Z'),
      }),
    },
  });
  links.push({ _id: '33333333-3333-4333-8333-333333333333', userId: actor.id, opportunityId: opportunity._id, profileId: profile._id, knowledgeDocumentId: 'indexed-doc', fileId: 'file-1', title: 'Requirements.pdf', documentType: 'other', aiStatus: 'Completed', aiRunId: 'run-1' });
  const result = await service.analysis(actor, opportunity._id, '33333333-3333-4333-8333-333333333333');
  assert.equal(result.status, 'completed');
  assert.equal(result.output.summary, 'Requirements summary');
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('AI tender document analysis composes protected tender document context', async () => {
  let createdRun;
  const service = new AiService(
    { getPrompt: async () => null, createRun: async (input) => { createdRun = input; return { _id: 'run-1', ...input }; } },
    {},
    {},
    { getById: async () => opportunity },
    { getOwned: async () => profile },
    { enqueue: async (_queue, _name, data) => ({ id: data.runId }) },
    {},
    {},
    { retrieveContext: async () => ({ profile: { id: profile._id }, alwaysInclude: [], evidence: [] }) },
  );
  await service.runTenderDocumentAnalysis(actor, { opportunityId: opportunity._id, profileId: profile._id, tenderDocuments: [{ tenderDocumentId: 'tdoc-1', title: 'Requirements.pdf', status: 'Indexed', extractedText: 'Must provide guarantee.' }] });
  assert.equal(createdRun.taskType, 'tender_document_analysis');
  assert.equal(createdRun.metadata.tenderDocumentIds[0], 'tdoc-1');
  assert.equal(createdRun.prompt.tenderDocuments[0].title, 'Requirements.pdf');
  assert.match(JSON.stringify(createdRun.prompt), /Must provide guarantee/);
});


test('controller API entrypoints forward exact tender document contracts', async () => {
  const calls = [];
  const controller = new TenderDocumentsController({
    list: async (_actor, opportunityId, query) => { calls.push(['list', opportunityId, query.profileId]); return { items: [], nextCursor: null }; },
    upload: async (_actor, opportunityId, file, dto) => { calls.push(['upload', opportunityId, file.originalname, dto.profileId, dto.documentType]); return { id: 'tdoc-1' }; },
    importSource: async (_actor, opportunityId, dto) => { calls.push(['importSource', opportunityId, dto.profileId, dto.sourceId, dto.url]); return { id: 'tdoc-2' }; },
    analyze: async (_actor, opportunityId, dto) => { calls.push(['analyze', opportunityId, dto.profileId, dto.tenderDocumentIds]); return { id: 'run-1' }; },
    analysis: async (_actor, opportunityId, id) => { calls.push(['analysis', opportunityId, id]); return { id: 'run-1' }; },
    reprocess: async (_actor, opportunityId, id) => { calls.push(['reprocess', opportunityId, id]); return { success: true }; },
    remove: async (_actor, opportunityId, id) => { calls.push(['remove', opportunityId, id]); return { success: true }; },
  });
  await controller.list(actor, opportunity._id, { profileId: profile._id });
  await controller.upload(actor, opportunity._id, { buffer: Buffer.from('x'), originalname: 'doc.pdf', mimetype: 'application/pdf', size: 1 }, { profileId: profile._id, title: 'doc.pdf', documentType: 'other' });
  await controller.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: 'https://example.test/doc.pdf' });
  await controller.analyze(actor, opportunity._id, { profileId: profile._id, tenderDocumentIds: ['33333333-3333-4333-8333-333333333333'] });
  await controller.analysis(actor, opportunity._id, '33333333-3333-4333-8333-333333333333');
  await controller.reprocess(actor, opportunity._id, '33333333-3333-4333-8333-333333333333');
  await controller.remove(actor, opportunity._id, '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(calls, [
    ['list', opportunity._id, profile._id],
    ['upload', opportunity._id, 'doc.pdf', profile._id, 'other'],
    ['importSource', opportunity._id, profile._id, 'roseltorg', 'https://example.test/doc.pdf'],
    ['analyze', opportunity._id, profile._id, ['33333333-3333-4333-8333-333333333333']],
    ['analysis', opportunity._id, '33333333-3333-4333-8333-333333333333'],
    ['reprocess', opportunity._id, '33333333-3333-4333-8333-333333333333'],
    ['remove', opportunity._id, '33333333-3333-4333-8333-333333333333'],
  ]);
});
