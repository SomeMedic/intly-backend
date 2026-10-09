import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { AiService } = require('../src/modules/ai/ai.service.ts');
const { promptSchemaByTask, schemaByTask, tenderDocumentAnalysisOutputSchema } = require('../src/modules/ai/ai-output.schemas.ts');

const actor = { id: 'user-1', email: 'user@example.test', role: 'User', locale: 'en' };
const opportunity = { _id: 'opp-1', type: 'tender', title: 'CRM tender', description: 'Tender for CRM implementation' };
const profile = { _id: 'profile-1', userId: actor.id, name: 'Tender profile', aiPreferences: {} };

const tenderDocuments = [
  {
    tenderDocumentId: 'tdoc-1',
    knowledgeDocumentId: 'kdoc-1',
    title: 'Terms.pdf',
    documentType: 'terms',
    status: 'Indexed',
    summary: 'Tender terms',
    extractedText: 'Section 4 Deadline: submit by 10 October 2026. Contractor must provide CRM integration experience and bank guarantee.',
    sourceId: 'source-1',
    sourceUrl: 'https://tender.example/documents/terms.pdf',
  },
  {
    tenderDocumentId: 'tdoc-2',
    knowledgeDocumentId: 'kdoc-2',
    title: 'Finance.pdf',
    documentType: 'finance',
    status: 'Indexed',
    summary: 'Financial terms',
    extractedText: 'Finance clause: maximum contract value is 500000 RUB. Submission date listed as 12 October 2026.',
    sourceId: 'source-1',
    sourceUrl: 'https://tender.example/documents/finance.pdf',
  },
];

test('tender_document_analysis has a dedicated zod and JSON schema with resolvable local refs', () => {
  assert.notEqual(schemaByTask.tender_document_analysis, schemaByTask.opportunity_analysis);
  assert.equal(promptSchemaByTask.tender_document_analysis.$ref, undefined);
  assert.equal(promptSchemaByTask.tender_document_analysis.properties.documents.items.properties.keyRequirements.items.$ref, '#/$defs/citedFact');
  assert.equal(promptSchemaByTask.tender_document_analysis.properties.crossDocumentFindings.items.properties.citations.minItems, 2);
  assert.deepEqual(promptSchemaByTask.tender_document_analysis.properties.crossDocumentFindings.items.properties.type.enum, ['conflicting_dates', 'financial_mismatch', 'scope_inconsistency', 'other']);
  for (const pointer of collectRefs(promptSchemaByTask.tender_document_analysis)) {
    assert.ok(resolveJsonPointer(promptSchemaByTask.tender_document_analysis, pointer), `unresolved ref ${pointer}`);
  }

  const parsed = tenderDocumentAnalysisOutputSchema.parse(validOutput());
  assert.equal(parsed.documents.length, 2);
  assert.equal(parsed.crossDocumentFindings[0].type, 'conflicting_dates');
  assert.throws(() => tenderDocumentAnalysisOutputSchema.parse({ ...validOutput(), documents: [{ tenderDocumentId: 'tdoc-1' }] }));
});

test('runTenderDocumentAnalysis preserves exact indexed document context and rejects unready or duplicate inputs', async () => {
  const createdRuns = [];
  const service = aiService({ aiRepository: { getPrompt: async () => null, createRun: async (input) => { createdRuns.push(input); return { _id: `run-${createdRuns.length}`, ...input }; } } });

  const run = await service.runTenderDocumentAnalysis(actor, { opportunityId: opportunity._id, profileId: profile._id, tenderDocuments });

  assert.equal(run.taskType, 'tender_document_analysis');
  assert.deepEqual(createdRuns[0].metadata.tenderDocumentIds, ['tdoc-1', 'tdoc-2']);
  assert.equal(createdRuns[0].prompt.tenderDocuments[0].tenderDocumentId, 'tdoc-1');
  assert.match(createdRuns[0].prompt.taskInstructions, /Return one documents\[\] result for every provided tenderDocumentId/);
  assert.match(JSON.stringify(createdRuns[0].prompt.outputSchema.json), /crossDocumentFindings/);

  await assert.rejects(
    () => service.runTenderDocumentAnalysis(actor, { opportunityId: opportunity._id, profileId: profile._id, tenderDocuments: [{ ...tenderDocuments[0], status: 'Uploading' }] }),
    /must be Indexed/,
  );
  await assert.rejects(
    () => service.runTenderDocumentAnalysis(actor, { opportunityId: opportunity._id, profileId: profile._id, tenderDocuments: [{ ...tenderDocuments[0], extractedText: '   ' }] }),
    /has no extracted text/,
  );
  await assert.rejects(
    () => service.runTenderDocumentAnalysis(actor, { opportunityId: opportunity._id, profileId: profile._id, tenderDocuments: [tenderDocuments[0], tenderDocuments[0]] }),
    /duplicated/,
  );
});

test('processRun completes valid multi-document tender analysis with cited contradiction leads', async () => {
  const { service, completed } = processService(validOutput());

  await service.processRun('run-1');

  assert.equal(completed.status, 'completed');
  assert.equal(completed.stage, 'completed');
  assert.equal(completed.aiScore, 72);
  assert.equal(completed.structuredOutput.crossDocumentFindings[0].type, 'conflicting_dates');
  assert.deepEqual(completed.structuredOutput.documents.map((document) => document.tenderDocumentId), ['tdoc-1', 'tdoc-2']);
});

test('processRun allows single-document tender analysis only with empty crossDocumentFindings', async () => {
  const { service, completed } = processService(oneDocumentOutput(), [tenderDocuments[0]]);

  await service.processRun('run-single');

  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.structuredOutput.documents.map((document) => document.tenderDocumentId), ['tdoc-1']);
  assert.deepEqual(completed.structuredOutput.crossDocumentFindings, []);
});

test('processRun rejects crossDocumentFindings for single-document runs', async () => {
  const crossDocumentFinding = {
    ...validOutput().crossDocumentFindings[0],
    citations: [
      { tenderDocumentId: 'tdoc-1', section: 'Section 4', excerpt: 'Deadline: submit by 10 October 2026' },
      { tenderDocumentId: 'tdoc-1', section: 'Section 4', excerpt: 'Contractor must provide CRM integration experience' },
    ],
  };
  const { service, completed } = processService(oneDocumentOutput({ crossDocumentFindings: [crossDocumentFinding] }), [tenderDocuments[0]]);

  await service.processRun('run-single-cross');

  assert.equal(completed.status, 'failed');
  assert.match(completed.errorSummary, /crossDocumentFindings must be empty/);
});

test('processRun fails tender analysis on foreign, missing, duplicated IDs and invented excerpts before completion', async () => {
  const cases = [
    ['foreign', { ...validOutput(), documents: [docOutput('tdoc-1'), docOutput('foreign-doc')] }, /unauthorized tenderDocumentId/],
    ['missing', { ...validOutput(), documents: [docOutput('tdoc-1')] }, /missing tenderDocumentId tdoc-2/],
    ['duplicate', { ...validOutput(), documents: [docOutput('tdoc-1'), docOutput('tdoc-1')] }, /duplicates tenderDocumentId tdoc-1/],
    ['foreign citation', mutateFirstCitation(validOutput(), { tenderDocumentId: 'foreign-doc' }), /unauthorized tenderDocumentId/],
    ['same document cross finding', mutateCrossFindingCitation(validOutput(), 1, { tenderDocumentId: 'tdoc-1', section: 'Section 4', excerpt: 'Contractor must provide CRM integration experience' }), /at least two distinct tender documents/],
    ['invented excerpt', mutateFirstCitation(validOutput(), { excerpt: 'this exact quote is not in the source' }), /excerpt is not present/],
    ['invented section', mutateFirstCitation(validOutput(), { section: 'Section 99' }), /section is not present/],
  ];

  for (const [name, output, message] of cases) {
    const { service, completed } = processService(output);
    await service.processRun(`run-${name}`);
    assert.equal(completed.status, 'failed', name);
    assert.equal(completed.errorCode, 'AI_RUN_FAILED', name);
    assert.match(completed.errorSummary, message, name);
    assert.equal(completed.structuredOutput, undefined, name);
  }
});

function aiService(overrides = {}) {
  return new AiService(
    overrides.aiRepository ?? { getPrompt: async () => null, createRun: async (input) => ({ _id: 'run-1', ...input }) },
    overrides.providerRunner ?? {},
    overrides.runCompletionRegistry ?? { notify: async () => undefined },
    overrides.opportunitiesRepository ?? { getById: async () => opportunity },
    overrides.profilesRepository ?? { getOwned: async () => profile, getById: async () => profile },
    overrides.jobsService ?? { registerHandler: () => undefined, enqueue: async () => undefined },
    {},
    {},
    overrides.documentsService ?? { retrieveContext: async () => ({ profile: null, alwaysInclude: [], evidence: [] }) },
    overrides.usersService,
  );
}

function processService(providerOutput, authorizedDocuments = tenderDocuments) {
  const completed = {};
  let run = {
    _id: 'run-1',
    userId: actor.id,
    profileId: profile._id,
    opportunityId: opportunity._id,
    taskType: 'tender_document_analysis',
    status: 'queued',
    prompt: { tenderDocuments: authorizedDocuments },
    metadata: { tenderDocumentIds: authorizedDocuments.map((document) => document.tenderDocumentId) },
    usage: {},
  };
  const repo = {
    markRunning: async () => { run = { ...run, status: 'running' }; return run; },
    getTaskConfig: async () => ({ taskType: 'tender_document_analysis', primaryProvider: 'openai', primaryModel: 'model-1', retryCount: 1 }),
    getProvider: async () => ({ provider: 'openai', enabled: true, apiKeyEncrypted: 'encrypted' }),
    updateRunStage: async (_id, stage) => { run = { ...run, stage }; return run; },
    updateRunningRun: async (_id, input) => { run = { ...run, ...input }; return run; },
    updateRunTerminal: async (_id, input) => { run = { ...run, ...input }; Object.assign(completed, run); return run; },
    getPrompt: async () => null,
  };
  const service = aiService({
    aiRepository: repo,
    providerRunner: { generateObject: async () => ({ object: providerOutput, usage: { inputTokens: 10, outputTokens: 20 } }) },
  });
  return { service, completed };
}

function validOutput() {
  return {
    summary: 'The tender requires CRM integration, guarantee documents, and financial review.',
    aiScore: 72,
    recommendation: 'Proceed after verifying conflicting submission dates.',
    documents: [docOutput('tdoc-1'), docOutput('tdoc-2')],
    crossDocumentFindings: [{
      title: 'Conflicting submission dates',
      description: 'Terms and finance document cite different submission dates for the same tender package.',
      type: 'conflicting_dates',
      citations: [
        { tenderDocumentId: 'tdoc-1', section: 'Section 4', excerpt: 'Deadline: submit by 10 October 2026' },
        { tenderDocumentId: 'tdoc-2', section: 'Finance clause', excerpt: 'Submission date listed as 12 October 2026' },
      ],
    }],
  };
}

function docOutput(tenderDocumentId) {
  if (tenderDocumentId === 'tdoc-2') {
    return {
      tenderDocumentId,
      summary: 'Financial ceiling and alternate submission date.',
      keyRequirements: [],
      dates: [{ title: 'Submission date', date: '12 October 2026', citations: [{ tenderDocumentId, section: 'Finance clause', excerpt: 'Submission date listed as 12 October 2026' }] }],
      risks: [{ title: 'Financial mismatch', description: 'Budget ceiling must be checked.', citations: [{ tenderDocumentId, excerpt: 'maximum contract value is 500000 RUB' }] }],
      requiredDocuments: [],
      eligibilityReferences: [],
      financialTerms: [{ title: 'Maximum value', description: '500000 RUB ceiling.', citations: [{ tenderDocumentId, section: 'Finance clause', excerpt: 'maximum contract value is 500000 RUB' }] }],
    };
  }
  return {
    tenderDocumentId,
    summary: 'Eligibility and guarantee requirements.',
    keyRequirements: [{ title: 'CRM experience', description: 'Contractor must have CRM integration experience.', citations: [{ tenderDocumentId, excerpt: 'Contractor must provide CRM integration experience' }] }],
    dates: [{ title: 'Submission deadline', date: '10 October 2026', citations: [{ tenderDocumentId, section: 'Section 4', excerpt: 'Deadline: submit by 10 October 2026' }] }],
    risks: [],
    requiredDocuments: [{ title: 'Bank guarantee', citations: [{ tenderDocumentId, excerpt: 'bank guarantee' }] }],
    eligibilityReferences: [{ title: 'CRM integration experience', citations: [{ tenderDocumentId, excerpt: 'CRM integration experience' }] }],
    financialTerms: [],
  };
}

function mutateFirstCitation(output, citationPatch) {
  const clone = structuredClone(output);
  Object.assign(clone.documents[0].keyRequirements[0].citations[0], citationPatch);
  return clone;
}

function mutateCrossFindingCitation(output, citationIndex, citationPatch) {
  const clone = structuredClone(output);
  Object.assign(clone.crossDocumentFindings[0].citations[citationIndex], citationPatch);
  return clone;
}

function oneDocumentOutput(patch = {}) {
  return {
    summary: 'Single tender document analysis.',
    documents: [docOutput('tdoc-1')],
    crossDocumentFindings: [],
    ...patch,
  };
}

function collectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectRefs(item, refs));
  } else if (value && typeof value === 'object') {
    if (typeof value.$ref === 'string') refs.push(value.$ref);
    Object.values(value).forEach((item) => collectRefs(item, refs));
  }
  return refs;
}

function resolveJsonPointer(root, pointer) {
  assert.match(pointer, /^#\//);
  return pointer.slice(2).split('/').reduce((value, part) => value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}
