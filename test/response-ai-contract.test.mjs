import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { EDITOR_NODE_TYPES, EDITOR_TOOLS, editorTransformOutputSchema, opportunityAnalysisOutputSchema, promptSchemaByTask } = require('../src/modules/ai/ai-output.schemas.ts');
const { AiService } = require('../src/modules/ai/ai.service.ts');
const { validateRichDocumentJson } = require('../src/modules/ai/rich-document-validation.ts');
const { ResponsesRepository } = require('../src/modules/responses/responses.repository.ts');
const { ResponsesService } = require('../src/modules/responses/responses.service.ts');

test('opportunity analysis preserves typed commercial recommendations and other type-specific facts', () => {
  const commercial = { pricingModel: 'hourly', recommendedPrice: '175 000 RUB', recommendedRate: '4 600 RUB/hour', estimatedHours: 30, estimatedDuration: '7 working days' };
  const parsed = opportunityAnalysisOutputSchema.parse({
    aiScore: 75, recommendation: 'Review', summary: 'Supported project estimate',
    typeSpecific: { commercial, technicalFit: { skills: ['Python'] } },
  });
  assert.deepEqual(parsed.typeSpecific.commercial, commercial);
  assert.deepEqual(parsed.typeSpecific.technicalFit, { skills: ['Python'] });
  assert.deepEqual(promptSchemaByTask.opportunity_analysis.properties.typeSpecific.properties.commercial.properties.pricingModel.enum, ['fixed', 'hourly']);
});

test('commercial recommendation validation rejects invalid models and negative hours without requiring estimates', () => {
  const base = { aiScore: 75, recommendation: 'Review', summary: 'No estimate available' };
  assert.deepEqual(opportunityAnalysisOutputSchema.parse(base).typeSpecific, {});
  assert.equal(opportunityAnalysisOutputSchema.parse({ ...base, typeSpecific: { commercial: { estimatedHours: 0 } } }).typeSpecific.commercial.estimatedHours, 0);
  assert.throws(() => opportunityAnalysisOutputSchema.parse({ ...base, typeSpecific: { commercial: { pricingModel: 'unknown' } } }));
  assert.throws(() => opportunityAnalysisOutputSchema.parse({ ...base, typeSpecific: { commercial: { estimatedHours: -1 } } }));
});

test('freelance analysis includes commercial field guidance alongside configured task instructions', async () => {
  for (const type of ['freelance', 'vacancy']) {
    const runs = [];
    const ai = new AiService(
      {
        getPrompt: async () => ({ systemCore: 'Protected core', taskInstructions: 'Configured analysis instructions' }),
        createRun: async (input) => { runs.push(input); return { _id: 'commercial-run', ...input }; },
      }, {}, {},
      { getById: async () => ({ _id: 'opp-1', type, title: 'Python API' }) },
      { getOwned: async () => ({ _id: 'profile-1', userId: 'user-1', name: 'Profile' }) },
      { registerHandler: () => undefined, enqueue: async () => undefined }, {}, {},
    );
    await ai.runOpportunityAnalysis({ id: 'user-1', role: 'User' }, { opportunityId: 'opp-1', profileId: 'profile-1' });
    assert.match(runs[0].prompt.taskInstructions, /Configured analysis instructions/);
    assert.equal(runs[0].prompt.taskInstructions.includes('typeSpecific.commercial'), type === 'freelance');
    if (type === 'freelance') assert.match(runs[0].prompt.taskInstructions, /never invent a client budget/);
    assert.equal(runs[0].status, 'queued');
  }
});

function assertBadRequestCode(fn, code) {
  assert.throws(fn, (error) => error?.response?.code === code);
}

function service() {
  return new ResponsesService({}, {}, {}, {}, { register: () => undefined }, { storeBuffer: async () => ({}) });
}

const readyChecklist = {
  factsChecked: true,
  requirementsCovered: true,
  noUnresolvedPlaceholders: true,
  userReviewed: true,
};

const nonEmptyDraft = {
  documentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Checked response text.' }] }] },
  markdownCache: '',
  unresolvedPlaceholders: [],
  checklist: readyChecklist,
  generation: { status: 'completed' },
};

test('editor transform output accepts only typed catalog operations', () => {
  const parsed = editorTransformOutputSchema.parse({
    draftId: 'draft-1',
    baseRevision: 7,
    explanation: 'Rewrite the selected sentence.',
    operations: [{
      tool: 'rewriteSelection',
      baseRevision: 7,
      target: { kind: 'selection', blockId: 'technical-fit', selectionText: 'old text' },
      content: { text: 'new text' },
    }],
  });

  assert.equal(parsed.operations[0].tool, 'rewriteSelection');
  assert.throws(() => editorTransformOutputSchema.parse({
    draftId: 'draft-1',
    baseRevision: 7,
    explanation: 'Patch arbitrary JSON.',
    operations: [{ tool: 'jsonPatch', baseRevision: 7, path: '/content/0', value: 'x' }],
  }), /Invalid input|No matching discriminator|tool/i);
});



test('editor transform output catalog covers all tools with exact target and content shapes', () => {
  const operations = [
    { tool: 'rewriteSelection', baseRevision: 7, target: { kind: 'selection', blockId: 'intro', selectionText: 'old text' }, content: { text: 'new text' } },
    { tool: 'replaceBlock', baseRevision: 7, target: { kind: 'block', blockId: 'intro' }, content: { nodeType: 'heading', text: 'New heading' } },
    { tool: 'replaceDocument', baseRevision: 7, target: { kind: 'document' }, content: { markdown: 'Full document' } },
    { tool: 'regenerateBlock', baseRevision: 7, target: { kind: 'block', blockId: 'intro' }, content: { text: 'Regenerated' } },
    { tool: 'shortenBlock', baseRevision: 7, target: { kind: 'block', blockId: 'intro' }, content: { text: 'Short' } },
    { tool: 'changeTone', baseRevision: 7, target: { kind: 'selection', blockId: 'intro', selectionText: 'old text' }, content: { text: 'Warmer' } },
    { tool: 'emphasizeFact', baseRevision: 7, target: { kind: 'block', blockId: 'intro' }, content: { text: 'Emphasized' } },
    { tool: 'insertBefore', baseRevision: 7, target: { kind: 'block', blockId: 'intro' }, content: { nodeType: 'technical-response', text: 'Before' } },
    { tool: 'insertAfter', baseRevision: 7, target: { kind: 'block', blockId: 'intro' }, content: { nodeType: 'semanticBlock', text: 'After' } },
    { tool: 'addParagraph', baseRevision: 7, target: { kind: 'block', blockId: 'intro' }, content: { text: 'Paragraph' } },
    { tool: 'updateHeading', baseRevision: 7, target: { kind: 'block', blockId: 'heading' }, content: { text: 'Updated heading' } },
    { tool: 'removeBlock', baseRevision: 7, target: { kind: 'block', blockId: 'intro' } },
  ];
  const parsed = editorTransformOutputSchema.parse({ draftId: 'draft-1', baseRevision: 7, explanation: 'Catalog', operations });

  assert.deepEqual(parsed.operations.map((operation) => operation.tool).sort(), [...EDITOR_TOOLS].sort());
  assert.throws(() => editorTransformOutputSchema.parse({ draftId: 'draft-1', baseRevision: 7, explanation: 'Bad node', operations: [{ tool: 'insertBefore', baseRevision: 7, target: { kind: 'block', blockId: 'intro' }, content: { nodeType: 'arbitraryWidget', text: 'x' } }] }), /Invalid|nodeType|enum/i);
  assert.throws(() => editorTransformOutputSchema.parse({ draftId: 'draft-1', baseRevision: 7, explanation: 'Bad target', operations: [{ tool: 'shortenBlock', baseRevision: 7, target: { kind: 'selection', selectionText: 'x' }, content: { text: 'x' } }] }), /Invalid|target/i);
  assert.throws(() => editorTransformOutputSchema.parse({ draftId: 'draft-1', baseRevision: 7, explanation: 'Bad add', operations: [{ tool: 'addParagraph', baseRevision: 7, target: { kind: 'block', blockId: 'intro' }, content: { nodeType: 'paragraph', text: 'x' } }] }), /Invalid|nodeType|Unrecognized/i);
});

test('editor transform prompt JSON schema matches nodeType catalog and simple tool restrictions', () => {
  const schemaText = JSON.stringify(promptSchemaByTask.editor_transform);
  for (const nodeType of EDITOR_NODE_TYPES) assert.equal(schemaText.includes(`"${nodeType}"`), true, `${nodeType} should be present in prompt schema`);
  assert.equal(schemaText.includes('arbitraryWidget'), false);
  assert.match(schemaText, /addParagraph/);
  assert.match(schemaText, /nodeType/);
});

test('editor transform output rejects stale operation base revisions', () => {
  assert.throws(() => editorTransformOutputSchema.parse({
    draftId: 'draft-1',
    baseRevision: 8,
    explanation: 'Stale edit.',
    operations: [{
      tool: 'rewriteSelection',
      baseRevision: 7,
      target: { kind: 'selection', selectionText: 'old text' },
      content: { text: 'new text' },
    }],
  }), /baseRevision/i);
});

test('response readiness rejects empty paragraph content and missing confirmations', () => {
  const responses = service();
  assertBadRequestCode(() => responses.assertReady({
    ...nonEmptyDraft,
    documentJson: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
    checklist: readyChecklist,
  }), 'RESPONSE_CONTENT_EMPTY');

  assertBadRequestCode(() => responses.assertReady({
    ...nonEmptyDraft,
    checklist: {},
  }), 'RESPONSE_CHECKLIST_INCOMPLETE');
});

test('response readiness blocks placeholders and stale generation', () => {
  const responses = service();
  assertBadRequestCode(() => responses.assertReady({
    ...nonEmptyDraft,
    documentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello {{name}}' }] }] },
  }), 'RESPONSE_PLACEHOLDERS_UNRESOLVED');

  assertBadRequestCode(() => responses.assertReady({
    ...nonEmptyDraft,
    generation: { status: 'stale', baseRevision: 1, currentRevision: 2 },
  }), 'RESPONSE_GENERATION_NOT_CURRENT');

  assert.doesNotThrow(() => responses.assertReady(nonEmptyDraft));
});

test('response placeholder extraction uses visible JSON over escaped Markdown serialization', () => {
  const responses = service();
  assert.throws(() => responses.assertReady({
    ...nonEmptyDraft,
    documentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello {{client_name}}' }] }] },
    markdownCache: 'Hello {{client\\_**name**}}',
    unresolvedPlaceholders: [],
  }), (error) => {
    assert.equal(error?.response?.code, 'RESPONSE_PLACEHOLDERS_UNRESOLVED');
    assert.deepEqual(error.response.placeholders, ['{{client_name}}']);
    return true;
  });
});

test('response placeholder extraction falls back to escaped Markdown only when document text is empty', () => {
  const responses = service();
  assert.throws(() => responses.assertReady({
    ...nonEmptyDraft,
    documentJson: { type: 'doc', content: [] },
    markdownCache: 'Hello {{client\\_name}} and [[project\\_name]]',
    unresolvedPlaceholders: [],
  }), (error) => {
    assert.equal(error?.response?.code, 'RESPONSE_PLACEHOLDERS_UNRESOLVED');
    assert.deepEqual(error.response.placeholders, ['{{client_name}}', '[[project_name]]']);
    return true;
  });
});

test('response placeholder extraction preserves inline placeholder text across marked nodes and ignores attrs', () => {
  const responses = service();
  assert.throws(() => responses.assertReady({
    ...nonEmptyDraft,
    documentJson: {
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { placeholder: '{{attr_only_should_not_block}}' },
        content: [
          { type: 'text', text: 'Hello {{client_' },
          { type: 'text', marks: [{ type: 'bold' }], text: 'name' },
          { type: 'text', text: '}}' },
        ],
      }],
    },
    markdownCache: 'Hello {{client\\_**name**}}',
    unresolvedPlaceholders: [],
  }), (error) => {
    assert.equal(error?.response?.code, 'RESPONSE_PLACEHOLDERS_UNRESOLVED');
    assert.deepEqual(error.response.placeholders, ['{{client_name}}']);
    return true;
  });
});

test('response placeholder extraction ignores stale Markdown cache when visible JSON has no placeholders', () => {
  const responses = service();
  assert.doesNotThrow(() => responses.assertReady({
    ...nonEmptyDraft,
    documentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ready visible response.' }] }] },
    markdownCache: 'Old cache {{client\\_name}}',
    unresolvedPlaceholders: [],
  }));
});

test('response placeholder extraction handles fully escaped Markdown fallback delimiters', () => {
  const responses = service();
  assert.throws(() => responses.assertReady({
    ...nonEmptyDraft,
    documentJson: { type: 'doc', content: [] },
    markdownCache: 'Hello \\[\\[project\\_name\\]\\] and \\{\\{client\\_name\\}\\}',
    unresolvedPlaceholders: [],
  }), (error) => {
    assert.equal(error?.response?.code, 'RESPONSE_PLACEHOLDERS_UNRESOLVED');
    assert.deepEqual(error.response.placeholders, ['[[project_name]]', '{{client_name}}']);
    return true;
  });
});

function transformService({ revision = 5 } = {}) {
  const calls = [];
  const draft = {
    _id: 'draft-1',
    userId: 'user-1',
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    revision,
    format: 'cover_letter',
    status: 'draft',
    documentJson: {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'intro' }, content: [{ type: 'text', text: 'Server intro text.' }] },
        { type: 'heading', attrs: { id: 'closing', level: 2 }, content: [{ type: 'text', text: 'Server closing.' }] },
      ],
    },
    markdownCache: '',
    checklist: {},
    unresolvedPlaceholders: [],
    generation: {},
  };
  const responses = new ResponsesService(
    { getOwned: async () => draft },
    {},
    {},
    { createEditorTransformRun: async (input) => { calls.push(input); return { _id: 'run-1', status: 'queued', taskType: 'editor_transform' }; } },
    { register: () => undefined },
    { storeBuffer: async () => ({}) },
  );
  return { responses, calls, draft };
}

const actor = { id: 'user-1', role: 'User' };

function responseRepositoryHarness(initialDraft) {
  const state = { draft: structuredClone(initialDraft) };
  const query = (value) => ({ lean: async () => value ? structuredClone(value) : null });
  const getPath = (record, path) => path.split('.').reduce((value, key) => value?.[key], record);
  const matchesValue = (actual, expected) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
      if ('$in' in expected) return expected.$in.includes(actual);
      if ('$nin' in expected) return !expected.$nin.includes(actual);
    }
    return actual === expected;
  };
  const matches = (record, filter) => Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((candidate) => matches(record, candidate));
    return matchesValue(getPath(record, key), expected);
  });
  const applyUpdate = (record, update) => {
    for (const [key, value] of Object.entries(update.$set ?? {})) {
      const parts = key.split('.');
      let target = record;
      while (parts.length > 1) {
        const part = parts.shift();
        target[part] ??= {};
        target = target[part];
      }
      target[parts[0]] = value;
    }
    for (const [key, value] of Object.entries(update.$inc ?? {})) {
      const parts = key.split('.');
      let target = record;
      while (parts.length > 1) {
        const part = parts.shift();
        target[part] ??= {};
        target = target[part];
      }
      target[parts[0]] = (target[parts[0]] ?? 0) + value;
    }
  };
  const model = {
    findOneAndUpdate: (filter, update) => {
      if (!matches(state.draft, filter)) return query(null);
      applyUpdate(state.draft, update);
      return query(state.draft);
    },
    findOne: (filter) => query(matches(state.draft, filter) ? state.draft : null),
  };
  return { repository: new ResponsesRepository(model), state };
}

test('response editor transform accepts typed block target and uses server-authoritative document context', async () => {
  const { responses, calls } = transformService();
  await responses.transformSelection(actor, 'draft-1', {
    revision: 5,
    tool: 'replaceBlock',
    target: { kind: 'block', blockId: 'intro' },
    pinnedFacts: [
      { label: ' Requirement ', text: '  Must mention server-rendered context. ', source: 'opportunity' },
      { label: 'ignored', text: '' },
    ],
    documentContext: { blocks: [{ id: 'other-profile-secret', text: 'malicious client context' }], text: 'malicious' },
    instruction: 'Improve intro',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].editorTransform.tool, 'replaceBlock');
  assert.deepEqual(calls[0].editorTransform.target, { kind: 'block', blockId: 'intro' });
  assert.deepEqual(calls[0].editorTransform.documentContext.blocks.map((block) => block.id), ['intro']);
  assert.equal('text' in calls[0].editorTransform.documentContext, false);
  assert.equal(calls[0].editorTransform.documentContext.surroundingText.includes('Server intro text.'), true);
  assert.equal(calls[0].editorTransform.documentContext.surroundingText.includes('Server closing.'), true);
  assert.equal(JSON.stringify(calls[0].editorTransform.documentContext).includes('malicious'), false);
  assert.deepEqual(calls[0].pinnedFacts, [{ label: 'Requirement', text: 'Must mention server-rendered context.', source: 'opportunity' }]);
  assert.deepEqual(calls[0].editorTransform.pinnedFacts, calls[0].pinnedFacts);
  assert.equal(calls[0].baseRevision, 5);
});

test('response editor transform preserves legacy selection shape', async () => {
  const { responses, calls } = transformService();
  await responses.transformSelection(actor, 'draft-1', {
    revision: 5,
    selection: { target: { kind: 'selection', blockId: 'intro', selectionText: 'intro text', surroundingText: 'Server intro text.' } },
    instruction: 'Rewrite selection',
  });

  assert.equal(calls[0].editorTransform.tool, 'rewriteSelection');
  assert.deepEqual(calls[0].editorTransform.target, { kind: 'selection', blockId: 'intro', selectionText: 'intro text', surroundingText: 'Server intro text.\nServer closing.' });
  assert.deepEqual(calls[0].selection, { target: calls[0].editorTransform.target });
});

test('response editor transform limits selection context to server-derived relevant text', async () => {
  const { responses, calls, draft } = transformService();
  draft.documentJson.content.push(
    { type: 'paragraph', attrs: { id: 'far-away' }, content: [{ type: 'text', text: 'Far away private paragraph that should not be sent for a block-scoped selection.' }] },
  );

  await responses.transformSelection(actor, 'draft-1', {
    revision: 5,
    target: { kind: 'selection', blockId: 'intro', selectionText: 'intro text', surroundingText: 'client supplied full document' },
    instruction: 'Rewrite selection',
  });

  const context = calls[0].editorTransform.documentContext;
  assert.deepEqual(context.blocks.map((block) => block.id), ['intro']);
  assert.equal(context.surroundingText.includes('Server intro text.'), true);
  assert.equal(context.surroundingText.includes('Far away private paragraph'), false);
  assert.equal(JSON.stringify(context).includes('client supplied full document'), false);
});

test('response editor transform accepts multiline selections across editor hard breaks', async () => {
  const { responses, calls, draft } = transformService();
  draft.documentJson.content[0] = {
    type: 'paragraph',
    attrs: { id: 'intro' },
    content: [
      { type: 'text', text: 'Line one' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Line two' },
    ],
  };

  await responses.transformSelection(actor, 'draft-1', {
    revision: 5,
    target: { kind: 'selection', blockId: 'intro', selectionText: 'Line one\nLine two' },
    instruction: 'Rewrite multiline selection',
  });

  assert.equal(calls[0].editorTransform.tool, 'rewriteSelection');
  assert.deepEqual(calls[0].editorTransform.target, {
    kind: 'selection',
    blockId: 'intro',
    selectionText: 'Line one\nLine two',
    surroundingText: 'Line one Line two\nServer closing.',
  });
  assert.deepEqual(calls[0].editorTransform.documentContext.blocks.map((block) => block.id), ['intro']);
  assert.equal(calls[0].editorTransform.documentContext.blocks[0].text, 'Line one Line two');
});

test('response editor transform rejects arbitrary block ids, stale selections, invalid tool targets, and stale revisions', async () => {
  const { responses } = transformService();
  await assert.rejects(() => responses.transformSelection(actor, 'draft-1', {
    revision: 5,
    tool: 'replaceBlock',
    target: { kind: 'block', blockId: 'not-current-doc' },
    instruction: 'Improve intro',
  }), (error) => error?.response?.code === 'RESPONSE_EDITOR_BLOCK_NOT_FOUND');

  await assert.rejects(() => responses.transformSelection(actor, 'draft-1', {
    revision: 5,
    tool: 'rewriteSelection',
    target: { kind: 'selection', blockId: 'intro', selectionText: 'client-only stale text' },
    instruction: 'Rewrite selection',
  }), (error) => error?.response?.code === 'RESPONSE_EDITOR_SELECTION_STALE');

  await assert.rejects(() => responses.transformSelection(actor, 'draft-1', {
    revision: 5,
    tool: 'replaceDocument',
    target: { kind: 'block', blockId: 'intro' },
    instruction: 'Replace all',
  }), (error) => error?.response?.code === 'RESPONSE_EDITOR_TOOL_INVALID');

  await assert.rejects(() => responses.transformSelection(actor, 'draft-1', {
    revision: 4,
    tool: 'replaceBlock',
    target: { kind: 'block', blockId: 'intro' },
    instruction: 'Improve intro',
  }), /revision conflict/i);
});



test('response editor transform rejects updateHeading on non-heading blocks before queueing', async () => {
  const { responses, calls } = transformService();

  await assert.rejects(() => responses.transformSelection(actor, 'draft-1', {
    revision: 5,
    tool: 'updateHeading',
    target: { kind: 'block', blockId: 'intro' },
    instruction: 'Rename heading',
  }), (error) => error?.response?.code === 'RESPONSE_EDITOR_TARGET_INVALID');

  await responses.transformSelection(actor, 'draft-1', {
    revision: 5,
    tool: 'updateHeading',
    target: { kind: 'block', blockId: 'closing' },
    instruction: 'Rename heading',
  });
  assert.equal(calls[0].editorTransform.tool, 'updateHeading');
  assert.equal(calls[0].editorTransform.documentContext.blocks[0].nodeType, 'heading');
});

test('response generation refuses direct overwrite of non-empty drafts', async () => {
  const calls = [];
  const responses = new ResponsesService(
    { getOwned: async () => ({ ...nonEmptyDraft, _id: 'draft-1', userId: 'user-1', opportunityId: 'opp-1', profileId: 'profile-1', revision: 3, format: 'cover_letter' }) },
    {},
    {},
    { createResponseGenerationRun: async (input) => { calls.push(input); return { _id: 'run-1' }; } },
    { register: () => undefined },
    { storeBuffer: async () => ({}) },
  );

  await assert.rejects(() => responses.generate(actor, 'draft-1', { revision: 3 }), (error) => error?.response?.code === 'RESPONSE_REGENERATION_REQUIRES_PREVIEW');
  assert.equal(calls.length, 0);
});

test('response generation checks optional client revision before creating a run', async () => {
  const responses = new ResponsesService(
    { getOwned: async () => ({ ...nonEmptyDraft, _id: 'draft-1', userId: 'user-1', opportunityId: 'opp-1', profileId: 'profile-1', revision: 3, format: 'cover_letter', documentJson: { type: 'doc', content: [] }, markdownCache: '' }) },
    {},
    {},
    { createResponseGenerationRun: async () => ({ _id: 'run-1' }) },
    { register: () => undefined },
    { storeBuffer: async () => ({}) },
  );

  await assert.rejects(() => responses.generate(actor, 'draft-1', { revision: 2 }), (error) => error?.response?.code === 'RESPONSE_DRAFT_REVISION_CONFLICT');
});

test('response generation passes sanitized pinned facts for empty drafts', async () => {
  const calls = [];
  const responses = new ResponsesService(
    { getOwned: async () => ({ ...nonEmptyDraft, _id: 'draft-1', userId: 'user-1', opportunityId: 'opp-1', profileId: 'profile-1', revision: 3, format: 'cover_letter', documentJson: { type: 'doc', content: [] }, markdownCache: '' }), attachGeneration: async () => ({}) },
    {},
    {},
    { createResponseGenerationRun: async (input) => { calls.push(input); return { _id: 'run-1', status: 'queued', taskType: 'response_generation' }; } },
    { register: () => undefined },
    { storeBuffer: async () => ({}) },
  );

  await responses.generate(actor, 'draft-1', {
    revision: 3,
    pinnedFacts: [
      { label: ' Requirement ', text: '  Mention webhook reliability. ', source: 'opportunity' },
      { label: 'missing text', text: '' },
    ],
  });

  assert.deepEqual(calls[0].pinnedFacts, [{ label: 'Requirement', text: 'Mention webhook reliability.', source: 'opportunity' }]);
});

test('response generation rejects duplicate active runs before creating another AI job', async () => {
  let aiCalls = 0;
  const responses = new ResponsesService(
    { getOwned: async () => ({ ...nonEmptyDraft, _id: 'draft-1', userId: 'user-1', opportunityId: 'opp-1', profileId: 'profile-1', revision: 3, format: 'cover_letter', documentJson: { type: 'doc', content: [] }, markdownCache: '', generation: { runId: 'run-active', status: 'queued' } }) },
    {},
    {},
    { createResponseGenerationRun: async () => { aiCalls += 1; return { _id: 'run-2' }; } },
    { register: () => undefined },
    { storeBuffer: async () => ({}) },
  );

  await assert.rejects(() => responses.generate(actor, 'draft-1', { revision: 3 }), (error) => error?.response?.code === 'RESPONSE_GENERATION_ALREADY_RUNNING');
  assert.equal(aiCalls, 0);
});

test('response generation cancels a created AI run when atomic attach loses an active-run race', async () => {
  const cancelled = [];
  const raceError = new Error('Response generation is already running');
  const responses = new ResponsesService(
    {
      getOwned: async () => ({ ...nonEmptyDraft, _id: 'draft-1', userId: 'user-1', opportunityId: 'opp-1', profileId: 'profile-1', revision: 3, format: 'cover_letter', documentJson: { type: 'doc', content: [] }, markdownCache: '', generation: {} }),
      attachGeneration: async () => { throw raceError; },
    },
    {},
    {},
    {
      createResponseGenerationRun: async () => ({ _id: 'run-lost-race', status: 'queued', taskType: 'response_generation' }),
      cancel: async (_actor, runId) => { cancelled.push(runId); },
    },
    { register: () => undefined },
    { storeBuffer: async () => ({}) },
  );

  await assert.rejects(() => responses.generate(actor, 'draft-1', { revision: 3 }), /already running/);
  assert.deepEqual(cancelled, ['run-lost-race']);
});

test('response generation terminal writes ignore late superseded completed failed and cancelled runs', async () => {
  const { repository, state } = responseRepositoryHarness({
    _id: 'draft-1',
    userId: 'user-1',
    revision: 1,
    documentJson: { type: 'doc', content: [{ text: 'current' }] },
    markdownCache: 'current',
    generation: { runId: 'run-new', status: 'queued' },
  });

  await repository.applyGeneration({ id: 'draft-1', userId: 'user-1', runId: 'run-old', documentJson: { type: 'doc', content: [{ text: 'old completed' }] }, markdownCache: 'old completed', status: 'completed', baseRevision: 1 });
  await repository.applyGeneration({ id: 'draft-1', userId: 'user-1', runId: 'run-old', documentJson: { type: 'doc', content: [] }, status: 'failed', errorSummary: 'old failed' });
  await repository.applyGeneration({ id: 'draft-1', userId: 'user-1', runId: 'run-old', documentJson: { type: 'doc', content: [] }, status: 'cancelled' });

  assert.equal(state.draft.revision, 1);
  assert.equal(state.draft.markdownCache, 'current');
  assert.deepEqual(state.draft.documentJson, { type: 'doc', content: [{ text: 'current' }] });
  assert.deepEqual(state.draft.generation, { runId: 'run-new', status: 'queued' });
});

test('current response generation completion marks stale when draft revision changed', async () => {
  const { repository, state } = responseRepositoryHarness({
    _id: 'draft-1',
    userId: 'user-1',
    revision: 2,
    documentJson: { type: 'doc', content: [{ text: 'manually edited' }] },
    markdownCache: 'manually edited',
    generation: { runId: 'run-current', status: 'running', baseRevision: 1 },
  });

  await repository.applyGeneration({ id: 'draft-1', userId: 'user-1', runId: 'run-current', documentJson: { type: 'doc', content: [{ text: 'generated' }] }, markdownCache: 'generated', status: 'completed', baseRevision: 1 });

  assert.equal(state.draft.revision, 2);
  assert.equal(state.draft.markdownCache, 'manually edited');
  assert.deepEqual(state.draft.documentJson, { type: 'doc', content: [{ text: 'manually edited' }] });
  assert.equal(state.draft.generation.runId, 'run-current');
  assert.equal(state.draft.generation.status, 'stale');
  assert.equal(state.draft.generation.baseRevision, 1);
  assert.equal(state.draft.generation.currentRevision, 2);
});

test('fast response generation terminal result before attach is not overwritten by queued attach', async () => {
  const { repository, state } = responseRepositoryHarness({
    _id: 'draft-1',
    userId: 'user-1',
    revision: 1,
    documentJson: { type: 'doc', content: [] },
    markdownCache: '',
    generation: {},
  });

  await repository.applyGeneration({ id: 'draft-1', userId: 'user-1', runId: 'run-fast', documentJson: { type: 'doc', content: [{ text: 'generated' }] }, markdownCache: 'generated', status: 'completed', baseRevision: 1, expectedGeneration: {} });
  const afterAttach = await repository.attachGeneration('draft-1', 'user-1', { runId: 'run-fast', status: 'queued', taskType: 'response_generation', baseRevision: 1 }, { revision: 1, generation: {} });

  assert.equal(afterAttach.generation.status, 'completed');
  assert.equal(state.draft.generation.status, 'completed');
  assert.equal(state.draft.revision, 2);
  assert.equal(state.draft.markdownCache, 'generated');
});


test('response generation can retry after failed and cancelled terminal states', async () => {
  for (const status of ['failed', 'cancelled']) {
    const { repository, state } = responseRepositoryHarness({
      _id: `draft-${status}`,
      userId: 'user-1',
      revision: 1,
      documentJson: { type: 'doc', content: [] },
      markdownCache: '',
      generation: { runId: `run-old-${status}`, status },
    });
    const expected = { revision: 1, generation: { runId: `run-old-${status}`, status } };

    await repository.attachGeneration(`draft-${status}`, 'user-1', { runId: `run-new-${status}`, status: 'queued', taskType: 'response_generation', baseRevision: 1 }, expected);
    await repository.applyGeneration({
      id: `draft-${status}`,
      userId: 'user-1',
      runId: `run-new-${status}`,
      documentJson: { type: 'doc', content: [{ text: `generated after ${status}` }] },
      markdownCache: `generated after ${status}`,
      status: 'completed',
      baseRevision: 1,
      expectedGeneration: expected.generation,
    });

    assert.equal(state.draft.revision, 2);
    assert.equal(state.draft.generation.runId, `run-new-${status}`);
    assert.equal(state.draft.generation.status, 'completed');
    assert.equal(state.draft.markdownCache, `generated after ${status}`);
  }
});

test('fast response generation terminal result before attach can replace an old terminal run', async () => {
  const { repository, state } = responseRepositoryHarness({
    _id: 'draft-1',
    userId: 'user-1',
    revision: 1,
    documentJson: { type: 'doc', content: [] },
    markdownCache: '',
    generation: { runId: 'run-old-failed', status: 'failed' },
  });
  const expected = { revision: 1, generation: { runId: 'run-old-failed', status: 'failed' } };

  await repository.applyGeneration({
    id: 'draft-1',
    userId: 'user-1',
    runId: 'run-fast-retry',
    documentJson: { type: 'doc', content: [{ text: 'generated retry' }] },
    markdownCache: 'generated retry',
    status: 'completed',
    baseRevision: 1,
    expectedGeneration: expected.generation,
  });
  const afterAttach = await repository.attachGeneration('draft-1', 'user-1', { runId: 'run-fast-retry', status: 'queued', taskType: 'response_generation', baseRevision: 1 }, expected);

  assert.equal(afterAttach.generation.status, 'completed');
  assert.equal(state.draft.generation.runId, 'run-fast-retry');
  assert.equal(state.draft.generation.status, 'completed');
  assert.equal(state.draft.revision, 2);
  assert.equal(state.draft.markdownCache, 'generated retry');
});

test('duplicate same-run completed terminal delivery is idempotent', async () => {
  const { repository, state } = responseRepositoryHarness({
    _id: 'draft-1',
    userId: 'user-1',
    revision: 1,
    documentJson: { type: 'doc', content: [] },
    markdownCache: '',
    generation: { runId: 'run-current', status: 'running', baseRevision: 1 },
  });

  await repository.applyGeneration({ id: 'draft-1', userId: 'user-1', runId: 'run-current', documentJson: { type: 'doc', content: [{ text: 'generated' }] }, markdownCache: 'generated', status: 'completed', baseRevision: 1 });
  await repository.applyGeneration({ id: 'draft-1', userId: 'user-1', runId: 'run-current', documentJson: { type: 'doc', content: [{ text: 'duplicate' }] }, markdownCache: 'duplicate', status: 'completed', baseRevision: 1 });

  assert.equal(state.draft.revision, 2);
  assert.equal(state.draft.generation.status, 'completed');
  assert.equal(state.draft.markdownCache, 'generated');
  assert.deepEqual(state.draft.documentJson, { type: 'doc', content: [{ text: 'generated' }] });
});

test('response export rejects stale revision before readiness and file storage', async () => {
  let stored = 0;
  const responses = new ResponsesService(
    { getOwned: async () => ({ ...nonEmptyDraft, _id: 'draft-1', userId: 'user-1', opportunityId: 'opp-1', profileId: 'profile-1', revision: 4, format: 'cover_letter', checklist: {} }) },
    {},
    {},
    {},
    { register: () => undefined },
    { storeBuffer: async () => { stored += 1; return { _id: 'file-1', originalName: 'response.txt', mimeType: 'text/plain', size: 12 }; } },
  );

  await assert.rejects(
    () => responses.export(actor, 'draft-1', { revision: 3, format: 'txt' }),
    (error) => error?.response?.code === 'RESPONSE_DRAFT_REVISION_CONFLICT' && error?.getStatus?.() === 409,
  );
  assert.equal(stored, 0);
});

test('response export accepts current revision and stores rendered file', async () => {
  const stored = [];
  const responses = new ResponsesService(
    { getOwned: async () => ({ ...nonEmptyDraft, _id: 'draft-1', userId: 'user-1', opportunityId: 'opp-1', profileId: 'profile-1', revision: 4, format: 'cover_letter' }) },
    { getById: async () => ({ _id: 'opp-1', type: 'vacancy' }) },
    {},
    {},
    { register: () => undefined },
    { storeBuffer: async (...args) => { stored.push(args); return { _id: 'file-1', originalName: 'response.txt', mimeType: 'text/plain', size: 12 }; } },
  );

  const result = await responses.export(actor, 'draft-1', { revision: 4, format: 'txt' });

  assert.equal(result.fileId, 'file-1');
  assert.equal(stored.length, 1);
  assert.equal(stored[0][0], actor.id);
  assert.equal(stored[0][3].startsWith('response-cover_letter-draft-1-'), true);
  assert.equal(stored[0][3].endsWith('.txt'), true);
  assert.deepEqual(stored[0][4], {
    kind: 'response_export',
    responseDraftId: 'draft-1',
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    format: 'txt',
  });
});

test('response draft creation enforces opportunity-specific format matrix', async () => {
  const created = [];
  const responses = new ResponsesService(
    { create: async (input) => { created.push(input); return input; } },
    { getById: async () => ({ _id: 'opp-1', type: 'freelance' }) },
    { getOwned: async () => ({ _id: 'profile-1' }) },
    {},
    { register: () => undefined },
    { storeBuffer: async () => ({}) },
  );

  await responses.create(actor, { opportunityId: 'opp-1', profileId: 'profile-1', format: 'commercial_proposal' });
  assert.equal(created[0].format, 'commercial_proposal');
  await assert.rejects(() => responses.create(actor, { opportunityId: 'opp-1', profileId: 'profile-1', format: 'cover_letter' }), (error) => error?.response?.code === 'RESPONSE_FORMAT_NOT_ALLOWED');
});

test('AI editor transform prompt carries pinned facts as explicit user-visible context', async () => {
  const runs = [];
  const jobs = [];
  const ai = new AiService(
    {
      getPrompt: async () => null,
      createRun: async (input) => {
        runs.push(input);
        return { _id: 'run-1', ...input };
      },
    },
    {},
    {},
    { getById: async () => ({ _id: 'opp-1', type: 'vacancy', title: 'Backend engineer' }) },
    { getOwned: async () => ({ _id: 'profile-1', userId: 'user-1', name: 'Profile' }) },
    { registerHandler: () => undefined, enqueue: async (...args) => { jobs.push(args); } },
    {},
    {},
  );

  await ai.createEditorTransformRun({
    actor,
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    responseDraftId: 'draft-1',
    baseRevision: 9,
    pinnedFacts: [{ label: 'Requirement', text: 'Mention API contracts.', source: 'opportunity' }],
    editorTransform: { tool: 'replaceBlock', target: { kind: 'block', blockId: 'intro' }, documentContext: { blocks: [] }, baseRevision: 9 },
    instruction: 'Improve intro',
  });

  assert.equal(runs.length, 1);
  assert.equal(runs[0].prompt.deferred, true);
  assert.deepEqual(runs[0].prompt.pinnedFactsContext, [{ label: 'Requirement', text: 'Mention API contracts.', source: 'opportunity' }]);
  assert.deepEqual(runs[0].prompt.context.pinnedFacts, [{ label: 'Requirement', text: 'Mention API contracts.', source: 'opportunity' }]);
  assert.equal('systemCore' in runs[0].prompt, false);
  assert.equal('taskInstructions' in runs[0].prompt, false);
  assert.equal(runs[0].metadata.pinnedFactsCount, 1);
  assert.equal(jobs.length, 1);
});

test('AI response generation prompt carries pinned facts as explicit user-visible context', async () => {
  const runs = [];
  const ai = new AiService(
    {
      getPrompt: async () => null,
      createRun: async (input) => {
        runs.push(input);
        return { _id: 'run-1', ...input };
      },
    },
    {},
    {},
    { getById: async () => ({ _id: 'opp-1', type: 'vacancy', title: 'Backend engineer' }) },
    { getOwned: async () => ({ _id: 'profile-1', userId: 'user-1', name: 'Profile' }) },
    { registerHandler: () => undefined, enqueue: async () => undefined },
    {},
    {},
  );

  await ai.createResponseGenerationRun({
    actor,
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    responseDraftId: 'draft-1',
    format: 'cover_letter',
    baseRevision: 2,
    pinnedFacts: [{ label: 'Requirement', text: 'Mention webhook reliability.', source: 'opportunity' }],
  });

  assert.equal(runs[0].prompt.deferred, true);
  assert.deepEqual(runs[0].prompt.pinnedFactsContext, [{ label: 'Requirement', text: 'Mention webhook reliability.', source: 'opportunity' }]);
  assert.equal('systemCore' in runs[0].prompt, false);
  assert.equal(runs[0].metadata.pinnedFactsCount, 1);
});

function processingHarness({ retrieveContext, providerResult, completionNotify, usersService } = {}) {
  const events = [];
  const providerCalls = [];
  const runs = new Map();
  const repository = {
    getPrompt: async () => null,
    createRun: async (input) => {
      const run = { _id: `run-${runs.size + 1}`, ...input, createdAt: new Date('2026-10-03T00:00:00.000Z') };
      runs.set(run._id, run);
      return run;
    },
    markRunning: async (id) => {
      const run = runs.get(id);
      if (!run || run.status !== 'queued') return null;
      Object.assign(run, { status: 'running', startedAt: new Date('2026-10-03T00:00:01.000Z') });
      return { ...run };
    },
    updateRunStage: async (id, stage) => {
      const run = runs.get(id);
      if (!run || run.status !== 'running') return null;
      Object.assign(run, { stage });
      return { ...run };
    },
    cancelRun: async (id) => {
      const run = runs.get(id);
      if (!run || !['queued', 'running'].includes(run.status)) return null;
      Object.assign(run, { status: 'cancelled', completedAt: new Date('2026-10-03T00:00:02.000Z') });
      return { ...run };
    },
    updateRunningRun: async (id, patch) => {
      const run = runs.get(id);
      if (!run || run.status !== 'running') return null;
      Object.assign(run, patch);
      return { ...run };
    },
    recordAttempts: async (id, attempts) => {
      const run = runs.get(id);
      if (!run || !['running', 'cancelled'].includes(run.status)) return null;
      Object.assign(run, { attempts: structuredClone(attempts) });
      return { ...run };
    },
    updateRunTerminal: async (id, patch) => {
      const run = runs.get(id);
      if (!run || run.status !== 'running') return null;
      Object.assign(run, patch);
      return { ...run };
    },
    updateRun: async (id, patch) => {
      const run = runs.get(id);
      if (!run) throw new Error('missing run');
      Object.assign(run, patch);
      return { ...run };
    },
    getRun: async (id) => {
      const run = runs.get(id);
      if (!run) throw new Error('missing run');
      return { ...run };
    },
    getTaskConfig: async () => ({ taskType: 'response_generation', primaryProvider: 'openai', primaryModel: 'gpt-test', retryCount: 1 }),
    getProvider: async () => ({ provider: 'openai', enabled: true, apiKeyEncrypted: 'encrypted' }),
  };
  const ai = new AiService(
    repository,
    {
      generateObject: async (input) => {
        providerCalls.push(input);
        return providerResult ?? { object: { documentJson: { type: 'doc', content: [] }, markdownCache: 'Generated response', aiScore: 81 }, usage: { inputTokens: 10, outputTokens: 5 } };
      },
    },
    { notify: async (run) => { await completionNotify?.(run, events); } },
    { getById: async () => ({ _id: 'opp-1', type: 'vacancy', title: 'Backend engineer', description: 'Need NestJS' }) },
    { getOwned: async () => ({ _id: 'profile-1', userId: 'user-1', name: 'Profile', structuredExperienceSummary: 'NestJS' }) },
    { registerHandler: () => undefined, enqueue: async () => undefined },
    {},
    {},
    {
      retrieveContext: retrieveContext ?? (async () => ({
        profile: { id: 'profile-1' },
        alwaysInclude: [{ documentId: 'doc-1', title: 'Pinned', text: 'Private evidence' }],
        evidence: [],
      })),
    },
    usersService,
    { publish: (_userId, type, payload) => events.push({ type, payload }) },
  );
  return { ai, runs, events, providerCalls };
}

test('response AI job emits truthful ordered progress and prepares RAG inside the worker', async () => {
  const { ai, runs, events, providerCalls } = processingHarness({
    completionNotify: async (_run, recordedEvents) => { recordedEvents.push({ type: 'completion.notify', payload: {} }); },
  });
  const run = await ai.createResponseGenerationRun({
    actor,
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    responseDraftId: 'draft-1',
    format: 'cover_letter',
    baseRevision: 2,
    pinnedFacts: [{ label: 'Requirement', text: 'Mention webhook reliability.', source: 'opportunity' }],
  });

  assert.equal(runs.get(run._id).prompt.deferred, true);
  await ai.processRun(run._id);

  assert.deepEqual(events.map((event) => event.type), [
    'ai.run.progress',
    'ai.run.progress',
    'ai.run.progress',
    'ai.run.progress',
    'completion.notify',
    'ai.run.progress',
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'ai.run.progress').map((event) => event.payload.stage), [
    'preparing_context',
    'retrieving_knowledge',
    'calling_model',
    'validating_output',
    'completed',
  ]);
  assert.equal(events.at(-1).payload.status, 'completed');
  assert.deepEqual(Object.keys(events[0].payload).sort(), ['responseDraftId', 'runId', 'stage', 'status', 'taskType']);
  assert.equal(providerCalls.length, 1);
  assert.match(providerCalls[0].prompt, /Private evidence/);
  assert.equal(runs.get(run._id).stage, 'completed');
  assert.equal(runs.get(run._id).prompt.deferred, undefined);
  assert.equal(runs.get(run._id).prompt.privateKnowledgeContext.alwaysInclude[0].documentId, 'doc-1');
});

test('response AI job fails at validating_output without retrying when provider object violates schema', async () => {
  const { ai, runs, events, providerCalls } = processingHarness({
    providerResult: { object: { markdownCache: 'Missing documentJson' }, usage: { inputTokens: 1, outputTokens: 1 } },
  });
  const run = await ai.createResponseGenerationRun({
    actor,
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    responseDraftId: 'draft-1',
    format: 'cover_letter',
    baseRevision: 2,
  });

  await ai.processRun(run._id);

  assert.equal(providerCalls.length, 1);
  assert.equal(runs.get(run._id).status, 'failed');
  assert.equal(runs.get(run._id).stage, 'validating_output');
  assert.equal(runs.get(run._id).errorCode, 'AI_RUN_FAILED');
  assert.match(runs.get(run._id).errorSummary, /documentJson/);
  assert.deepEqual(events.map((event) => event.payload?.stage).filter(Boolean), ['preparing_context', 'retrieving_knowledge', 'calling_model', 'validating_output', 'validating_output']);
  assert.equal(events.at(-1).payload.status, 'failed');
});

test('response AI job fails terminally when worker-side RAG preparation fails without calling provider', async () => {
  const { ai, events, providerCalls } = processingHarness({
    retrieveContext: async () => { throw new Error('RAG unavailable'); },
  });
  const run = await ai.createResponseGenerationRun({
    actor,
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    responseDraftId: 'draft-1',
    format: 'cover_letter',
    baseRevision: 2,
  });

  await ai.processRun(run._id);

  assert.equal(providerCalls.length, 0);
  assert.deepEqual(events.map((event) => event.payload?.stage).filter(Boolean), ['preparing_context', 'retrieving_knowledge', 'retrieving_knowledge']);
  assert.equal(events.at(-1).payload.status, 'failed');
});

test('cancelled response AI job stops after preparation and never emits false completion', async () => {
  let releaseRetrieval;
  const retrievalStarted = new Promise((resolve) => {
    releaseRetrieval = resolve;
  });
  const { ai, events, providerCalls } = processingHarness({
    retrieveContext: async () => {
      await retrievalStarted;
      return { profile: null, alwaysInclude: [], evidence: [] };
    },
  });
  const run = await ai.createEditorTransformRun({
    actor,
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    responseDraftId: 'draft-1',
    baseRevision: 4,
    editorTransform: { tool: 'replaceBlock', target: { kind: 'block', blockId: 'intro' }, documentContext: { blocks: [] }, baseRevision: 4 },
    instruction: 'Improve intro',
  });

  const processing = ai.processRun(run._id);
  while (!events.some((event) => event.payload?.stage === 'retrieving_knowledge')) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await ai.cancel(actor, run._id);
  releaseRetrieval();
  await processing;

  assert.equal(providerCalls.length, 0);
  assert.equal(events.some((event) => event.payload?.stage === 'calling_model'), false);
  assert.equal(events.some((event) => event.payload?.stage === 'completed'), false);
  assert.equal(events.at(-1).payload.status, 'cancelled');
});





test('editor transform provider scope rejects unsupported target kinds per request kind', async () => {
  const baseRun = {
    _id: 'run-x',
    taskType: 'editor_transform',
    metadata: { responseDraftId: 'draft-1', baseRevision: 4 },
    prompt: {
      responseDraftId: 'draft-1',
      baseRevision: 4,
      editorTransform: {
        target: { kind: 'block', blockId: 'intro' },
        documentContext: { blocks: [{ id: 'intro', nodeType: 'paragraph', text: 'Server intro text.' }] },
      },
    },
  };
  const { validateEditorTransformOutputForRun } = require('../src/modules/ai/editor-transform-validation.ts');

  assert.throws(() => validateEditorTransformOutputForRun(baseRun, {
    draftId: 'draft-1', baseRevision: 4, explanation: 'Bad',
    operations: [{ tool: 'changeTone', baseRevision: 4, target: { kind: 'selection', blockId: 'intro', selectionText: 'Server intro text.' }, content: { text: 'Warmer' } }],
  }), /block target/);

  assert.throws(() => validateEditorTransformOutputForRun({
    ...baseRun,
    prompt: { ...baseRun.prompt, editorTransform: { target: { kind: 'document' }, documentContext: { blocks: [{ id: 'intro', nodeType: 'paragraph', text: 'Server intro text.' }] } } },
  }, {
    draftId: 'draft-1', baseRevision: 4, explanation: 'Bad',
    operations: [{ tool: 'changeTone', baseRevision: 4, target: { kind: 'selection', blockId: 'intro', selectionText: 'Server intro text.' }, content: { text: 'Warmer' } }],
  }), /selection target/);

  assert.throws(() => validateEditorTransformOutputForRun({
    ...baseRun,
    prompt: { ...baseRun.prompt, editorTransform: { target: { kind: 'selection', blockId: 'intro', selectionText: 'Server intro text.' }, documentContext: { blocks: [{ id: 'intro', nodeType: 'paragraph', text: 'Server intro text.' }] } } },
  }, {
    draftId: 'draft-1', baseRevision: 4, explanation: 'Bad',
    operations: [
      { tool: 'rewriteSelection', baseRevision: 4, target: { kind: 'selection', blockId: 'intro', selectionText: 'Server intro text.' }, content: { text: 'One' } },
      { tool: 'changeTone', baseRevision: 4, target: { kind: 'selection', blockId: 'intro', selectionText: 'Server intro text.' }, content: { text: 'Two' } },
    ],
  }), /exactly one/);
});

test('editor transform provider output is request-scope validated before completion', async () => {
  const { ai, runs, events } = processingHarness({
    providerResult: {
      object: {
        draftId: 'draft-1',
        baseRevision: 4,
        explanation: 'Unsafe full replacement',
        operations: [{ tool: 'replaceDocument', baseRevision: 4, target: { kind: 'document' }, content: { markdown: 'Replace everything' } }],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    completionNotify: async (run, recordedEvents) => { recordedEvents.push({ type: 'completion.notify', payload: { status: run.status } }); },
  });
  const run = await ai.createEditorTransformRun({
    actor,
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    responseDraftId: 'draft-1',
    baseRevision: 4,
    editorTransform: {
      tool: 'replaceBlock',
      target: { kind: 'block', blockId: 'intro' },
      documentContext: { draftId: 'draft-1', baseRevision: 4, target: { kind: 'block', blockId: 'intro' }, blocks: [{ id: 'intro', nodeType: 'paragraph', text: 'Server intro text.' }] },
      baseRevision: 4,
    },
    instruction: 'Improve intro',
  });

  await ai.processRun(run._id);

  assert.equal(runs.get(run._id).status, 'failed');
  assert.equal(runs.get(run._id).stage, 'validating_output');
  assert.equal(runs.get(run._id).structuredOutput, undefined);
  assert.equal(events.some((event) => event.payload?.stage === 'completed'), false);
  assert.equal(events.find((event) => event.type === 'completion.notify')?.payload.status, 'failed');
});



test('admin editor transform synthetic run has request scope and can complete', async () => {
  const { ai, runs, events } = processingHarness({
    providerResult: {
      object: {
        draftId: 'synthetic-draft',
        baseRevision: 1,
        explanation: 'Synthetic editor test',
        operations: [{ tool: 'replaceBlock', baseRevision: 1, target: { kind: 'block', blockId: 'synthetic-block' }, content: { text: 'Synthetic replacement.' } }],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  });

  const run = await ai.testAdmin(actor, { taskType: 'editor_transform', context: {} });
  await ai.processRun(run._id);

  assert.equal(runs.get(run._id).status, 'completed');
  assert.equal(runs.get(run._id).metadata.responseDraftId, 'synthetic-draft');
  assert.equal(runs.get(run._id).metadata.baseRevision, 1);
  assert.equal(events.at(-1).payload.status, 'completed');
});



test('rich document validator matches frontend rich editor legality invariants', () => {
  const nestedListDocument = (levels) => {
    const documentJson = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'level 1' }] }] }] }] };
    let current = documentJson.content[0].content[0].content;
    for (let level = 2; level <= levels; level += 1) {
      const nested = { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `level ${level}` }] }] }] };
      current.push(nested);
      current = nested.content[0].content;
    }
    return documentJson;
  };

  assert.doesNotThrow(() => validateRichDocumentJson({ type: 'doc', attrs: {}, content: [] }));
  assert.doesNotThrow(() => validateRichDocumentJson({ type: 'doc', content: [{ type: 'paragraph', content: [] }] }));
  assert.doesNotThrow(() => validateRichDocumentJson(nestedListDocument(7)));
  assert.doesNotThrow(() => validateRichDocumentJson({
    type: 'doc',
    content: [
      { type: 'semanticBlock', attrs: { semanticType: 'generic' }, content: [{ type: 'text', text: 'Generic section' }] },
      { type: 'semanticBlock', attrs: { semanticType: 'custom-safe' }, content: [{ type: 'text', text: 'Custom section' }] },
      { type: 'semanticBlock', attrs: { semanticType: ' made-up ' }, content: [{ type: 'text', text: 'Trimmed custom section' }] },
      { type: 'blockquote', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Quoted heading' }] },
        { type: 'semanticBlock', attrs: { semanticType: 'technical-response' }, content: [{ type: 'text', text: 'Quoted semantic' }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'quotedCode();' }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested quote' }] }] },
      ] },
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [{
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'strike' }, { type: 'code' }, { type: 'link', attrs: { href: 'mailto:hello@example.com' } }, { type: 'link', attrs: { href: 'https://' } }] }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Continuation paragraph' }] },
            { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested item' }] }] }] },
          ],
        }],
      },
    ],
  }));

  const invalidDocuments = [
    { type: 'doc', attrs: 'bad', content: [] },
    { type: 'doc', content: [{ type: 'blockquote', content: [{ type: 'paragraph', attrs: 'bad', content: [] }] }] },
    { type: 'doc', content: [{ type: 'bulletList', content: [] }] },
    { type: 'doc', content: [{ type: 'orderedList', content: [{ type: 'listItem', content: [] }] }] },
    { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }] }] }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bad', content: [] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hardBreak', content: [] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hardBreak', marks: [{ type: 'bold' }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unsupported underline', marks: [{ type: 'underline' }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unexpected attrs', marks: [{ type: 'bold', attrs: { style: 'x' } }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bad link', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Whitespace link', marks: [{ type: 'link', attrs: { href: ' https://example.com' } }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Control link', marks: [{ type: 'link', attrs: { href: 'https://exa mple.com' } }] }] }] },
    { type: 'doc', content: [{ type: 'orderedList', attrs: { start: 0 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }] }] }] },
    { type: 'doc', content: [{ type: 'codeBlock', content: 'const x = 1;' }] },
    { type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', attrs: 'bad', text: 'code' }] }] },
    { type: 'doc', content: [{ type: 'semanticBlock', attrs: { semanticType: 'generic' }, content: 'text' }] },
    { type: 'doc', content: [{ type: 'semanticBlock', attrs: { semanticType: 'Made-Up' }, content: [{ type: 'text', text: 'Nope' }] }] },
    { type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'const x = 1;', marks: [{ type: 'bold' }] }] }] },
    { type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'code', marks: [{ type: 'code' }] }] }] },
    nestedListDocument(8),
  ];
  for (const documentJson of invalidDocuments) assert.throws(() => validateRichDocumentJson(documentJson));
});

test('response generation validates rich document structure while preserving supported nodes', async () => {
  const validDocument = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [] },
      { type: 'semanticBlock', attrs: { semanticType: 'technical-response' }, content: [{ type: 'text', text: 'Technical ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested item' }] }, { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested ordered' }] }] }] }] }] },
      { type: 'closing', content: [{ type: 'text', text: 'Alias semantic block' }] },
    ],
  };
  const { ai, runs } = processingHarness({ providerResult: { object: { documentJson: validDocument }, usage: { inputTokens: 1, outputTokens: 1 } } });
  const run = await ai.createResponseGenerationRun({ actor, opportunityId: 'opp-1', profileId: 'profile-1', responseDraftId: 'draft-1', format: 'cover_letter', baseRevision: 2 });

  await ai.processRun(run._id);

  assert.equal(runs.get(run._id).status, 'completed');
  assert.deepEqual(runs.get(run._id).structuredOutput.documentJson, validDocument);
});

test('response generation rejects malformed rich document before completion', async () => {
  const { ai, runs, events } = processingHarness({
    providerResult: { object: { documentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph', content: [] }] }] } }, usage: { inputTokens: 1, outputTokens: 1 } },
  });
  const run = await ai.createResponseGenerationRun({ actor, opportunityId: 'opp-1', profileId: 'profile-1', responseDraftId: 'draft-1', format: 'cover_letter', baseRevision: 2 });

  await ai.processRun(run._id);

  assert.equal(runs.get(run._id).status, 'failed');
  assert.equal(runs.get(run._id).stage, 'validating_output');
  assert.equal(events.some((event) => event.payload?.stage === 'completed'), false);
});

test('editor replaceDocument rejects malformed rich document before completion', async () => {
  const { ai, runs, events } = processingHarness({
    providerResult: {
      object: {
        draftId: 'draft-1',
        baseRevision: 4,
        explanation: 'Malformed replacement',
        operations: [{ tool: 'replaceDocument', baseRevision: 4, target: { kind: 'document' }, content: { documentJson: { type: 'doc', content: [{ type: 'unknownNode', content: [] }] } } }],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  });
  const run = await ai.createEditorTransformRun({
    actor,
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    responseDraftId: 'draft-1',
    baseRevision: 4,
    editorTransform: { tool: 'replaceDocument', target: { kind: 'document' }, documentContext: { blocks: [{ id: 'intro', nodeType: 'paragraph', text: 'Intro' }] }, baseRevision: 4 },
    instruction: 'Replace document',
  });

  await ai.processRun(run._id);

  assert.equal(runs.get(run._id).status, 'failed');
  assert.equal(runs.get(run._id).stage, 'validating_output');
  assert.equal(events.some((event) => event.payload?.stage === 'completed'), false);
});

test('AI cancel uses atomic status guard and cannot flip completed runs to cancelled', async () => {
  const { ai, runs, events } = processingHarness();
  const run = await ai.createResponseGenerationRun({
    actor,
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    responseDraftId: 'draft-1',
    format: 'cover_letter',
    baseRevision: 2,
  });
  Object.assign(runs.get(run._id), { status: 'completed', stage: 'completed', completedAt: new Date('2026-10-03T00:00:03.000Z') });

  await assert.rejects(() => ai.cancel(actor, run._id), /queued or running/);

  assert.equal(runs.get(run._id).status, 'completed');
  assert.equal(runs.get(run._id).stage, 'completed');
  assert.equal(events.length, 0);
});
