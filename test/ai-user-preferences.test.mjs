import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { AiService } = require('../src/modules/ai/ai.service.ts');
const {
  AI_USER_PROMPT_PLACEHOLDERS,
  normalizeAiPreferences,
  validateAiUserPromptPlaceholders,
} = require('../src/modules/ai/ai-user-preferences.ts');

const actor = { id: 'user-1', email: 'u@example.test', role: 'User' };
const opportunity = { _id: 'opp-1', title: 'Python backend', description: 'FastAPI and queues', type: 'vacancy' };
const profile = {
  _id: 'profile-1',
  userId: 'user-1',
  name: 'Backend profile',
  structuredExperienceSummary: 'NestJS and Python',
  aiPreferences: {
    language: 'en',
    userPreferences: 'Profile style for {{profile}}',
    customPrompt: 'Profile prompt should see {{opportunity}}',
  },
};

function aiService({ aiRepository, usersService, opportunitiesRepository, profilesRepository, documentsService } = {}) {
  return new AiService(
    aiRepository ?? { getPrompt: async () => null, createRun: async (input) => ({ _id: 'run-1', ...input }) },
    {},
    {},
    opportunitiesRepository ?? { getById: async () => opportunity },
    profilesRepository ?? { getOwned: async () => profile, getById: async () => profile },
    { registerHandler: () => undefined, enqueue: async () => undefined },
    {},
    {},
    documentsService ?? { retrieveContext: async () => ({ profile: null, alwaysInclude: [], evidence: [] }) },
    usersService,
  );
}

test('AI prompt composition includes account and profile preferences in low-priority editable context', async () => {
  let createdRun;
  const service = aiService({
    aiRepository: { getPrompt: async () => null, createRun: async (input) => { createdRun = input; return { _id: 'run-1', ...input }; } },
    usersService: {
      getById: async (id) => {
        assert.equal(id, actor.id);
        return {
          _id: actor.id,
          aiPreferences: {
            language: 'en',
            userPreferences: 'Prefer concise English for {{opportunity}}',
            customPrompt: 'Account prompt uses {{profile}}',
          },
        };
      },
    },
    documentsService: {
      retrieveContext: async () => ({
        profile: null,
        alwaysInclude: [{ documentId: 'doc-1', title: 'Pinned', text: 'Private knowledge fact' }],
        evidence: [],
      }),
    },
  });

  await service.runOpportunityAnalysis(actor, {
    opportunityId: opportunity._id,
    profileId: profile._id,
    customPrompt: 'Request prompt sees {{knowledge}}',
  });

  const editable = createdRun.prompt.editableUserContext;
  assert.equal(editable.priority, 'low');
  assert.match(editable.note, /cannot override systemCore/);
  assert.equal(editable.language, 'en');
  assert.match(editable.renderedInstructions.accountUserPreferences, /Python backend/);
  assert.match(editable.renderedInstructions.accountCustomPrompt, /Backend profile/);
  assert.match(editable.renderedInstructions.profileUserPreferences, /Backend profile/);
  assert.match(editable.renderedInstructions.profileCustomPrompt, /Python backend/);
  assert.match(editable.renderedInstructions.requestCustomPrompt, /Private knowledge fact/);
  assert.deepEqual(editable.supportedPlaceholders, AI_USER_PROMPT_PLACEHOLDERS);
  assert.equal(createdRun.prompt.systemCore.startsWith('You are INTLY AI'), true);
  assert.equal(createdRun.prompt.outputSchema.taskType, 'opportunity_analysis');
});

test('AI user preference normalization keeps canonical fields distinct and respects cleared customPrompt', () => {
  assert.deepEqual(normalizeAiPreferences({ language: 'en', userPreferences: 'prefs', customPrompt: '', userPrompt: 'legacy' }), {
    language: 'en',
    userPreferences: 'prefs',
    customPrompt: '',
    userPrompt: 'legacy',
  });
  assert.deepEqual(normalizeAiPreferences({ language: 'ru', userPrompt: 'legacy' }), {
    language: 'ru',
    userPreferences: '',
    customPrompt: 'legacy',
    userPrompt: 'legacy',
  });
});

test('unsupported AI prompt placeholders are rejected on immediate prompt paths and deferred response runs keep worker context', async () => {
  assert.throws(() => validateAiUserPromptPlaceholders('Use {{salary}}'), /Unsupported AI prompt placeholder: salary/);

  const createdRuns = [];

  const service = aiService({
    aiRepository: { getPrompt: async () => null, createRun: async (input) => { createdRuns.push(input); return { _id: 'run-1', ...input }; } },
    usersService: {
      getById: async () => ({ _id: actor.id, aiPreferences: { language: 'en', userPreferences: 'Use {{salary}}' } }),
    },
  });

  const responseRun = await service.createResponseGenerationRun({
    actor,
    opportunityId: opportunity._id,
    profileId: profile._id,
    responseDraftId: 'draft-1',
    format: 'cover_letter',
  });
  assert.equal(responseRun.prompt.deferred, true);
  assert.equal(createdRuns.length, 1);

  await assert.rejects(
    service.createResumeAdaptationRun({
      actor,
      opportunityId: opportunity._id,
      profileId: profile._id,
      baseResumeId: 'resume-1',
      adaptationId: 'adapt-1',
      baseResume: { summary: 'Python resume' },
    }),
    /Unsupported AI prompt placeholder: salary/,
  );
});

test('response, tender, and resume AI paths all include account preferences', async () => {
  const prompts = [];
  const service = aiService({
    aiRepository: { getPrompt: async () => null, createRun: async (input) => { prompts.push(input.prompt); return { _id: `run-${prompts.length}`, ...input }; } },
    opportunitiesRepository: { getById: async () => ({ ...opportunity, type: 'tender' }) },
    usersService: {
      getById: async () => ({ _id: actor.id, aiPreferences: { language: 'en', userPreferences: 'Account preference for {{language}}' } }),
    },
  });

  await service.createResponseGenerationRun({ actor, opportunityId: opportunity._id, profileId: profile._id, responseDraftId: 'draft-1', format: 'reply' });
  await service.createResumeAdaptationRun({ actor, opportunityId: opportunity._id, profileId: profile._id, baseResumeId: 'resume-1', adaptationId: 'adapt-1', baseResume: { summary: 'Python resume' } });
  await service.runTenderDocumentAnalysis(actor, { opportunityId: opportunity._id, profileId: profile._id, tenderDocuments: [{ tenderDocumentId: 'tdoc-1', status: 'Indexed', extractedText: 'Tender requirements' }] });

  assert.equal(prompts.length, 3);
  assert.equal(prompts[0].deferred, true);
  assert.equal(prompts[0].context.actor.id, actor.id);
  assert.deepEqual(prompts.slice(1).map((prompt) => prompt.editableUserContext.renderedInstructions.accountUserPreferences), [
    'Account preference for en',
    'Account preference for en',
  ]);
});
