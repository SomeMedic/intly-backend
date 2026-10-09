import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { ConflictException } = require('@nestjs/common');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { SetResponseStatusDto } = require('../src/modules/responses/dto/response.dto.ts');
const { ResponsesService } = require('../src/modules/responses/responses.service.ts');

const actor = { id: 'user-1', role: 'User' };
const checklist = {
  factsChecked: true,
  requirementsCovered: true,
  noUnresolvedPlaceholders: true,
  userReviewed: true,
};

function paragraph(text) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function semanticSection(section, text) {
  return { type: 'semanticBlock', attrs: { semanticType: section }, content: [{ type: 'text', text }] };
}

function legacySection(section, text, attrs) {
  return { type: section, ...(attrs ? { attrs } : {}), content: [paragraph(text)] };
}

function heading(text) {
  return { type: 'heading', content: [{ type: 'text', text }] };
}

function doc(content) {
  return { type: 'doc', content };
}

function draft(overrides = {}) {
  return {
    _id: 'draft-1',
    userId: 'user-1',
    opportunityId: 'opp-1',
    profileId: 'profile-1',
    revision: 3,
    opportunityType: 'tender',
    format: 'application_draft',
    status: 'draft',
    documentJson: doc([paragraph('Ready response text.')]),
    markdownCache: '',
    unresolvedPlaceholders: [],
    checklist,
    generation: { status: 'completed' },
    ...overrides,
  };
}

function opportunity(overrides = {}) {
  return {
    _id: 'opp-1',
    type: 'tender',
    title: 'Tender',
    tenderData: {},
    ...overrides,
  };
}

function harness({ draftValue = draft(), opportunityValue = opportunity(), storage = async () => ({ _id: 'file-1', originalName: 'response.txt', mimeType: 'text/plain', size: 10 }), updateWithRevision, notify, emit } = {}) {
  const updates = [];
  const stored = [];
  const notifications = [];
  const webhooks = [];
  const responses = new ResponsesService(
    {
      getOwned: async () => draftValue,
      updateWithRevision: updateWithRevision ?? (async (_id, _userId, _revision, patch) => {
        updates.push(patch);
        return { ...draftValue, ...patch, revision: draftValue.revision + 1 };
      }),
    },
    { getById: async () => opportunityValue },
    {},
    {},
    { register: () => undefined },
    { storeBuffer: async (...args) => { stored.push(args); return storage(...args); } },
    { notify: async (payload) => { notifications.push(payload); return notify?.(payload); } },
    { emit: async (...args) => { webhooks.push(args); return emit?.(...args); } },
  );
  return { responses, updates, stored, notifications, webhooks };
}

async function assertBadRequestCode(promise, code, extra) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.response?.code, code);
    extra?.(error.response);
    return true;
  });
}

test('tender readiness requires configured semantic application sections with meaningful text', async () => {
  const { responses } = harness({
    draftValue: draft({ documentJson: doc([heading('Eligibility'), semanticSection('application-summary', 'Summary text'), semanticSection('eligibility', '   ')]) }),
    opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['application-summary', 'eligibility'] } }),
  });

  await assertBadRequestCode(
    responses.setStatus(actor, 'draft-1', { status: 'ready', revision: 3 }),
    'TENDER_APPLICATION_SECTIONS_MISSING',
    (body) => {
      assert.deepEqual(body.missing, ['eligibility']);
      assert.deepEqual(body.details, { required: ['application-summary', 'eligibility'], missing: ['eligibility'] });
    },
  );
});

test('tender readiness accepts normalized semanticType and legacy section node types', async () => {
  for (const documentJson of [
    doc([semanticSection(' application-summary ', 'Summary text'), semanticSection(' eligibility ', 'Eligibility text')]),
    doc([legacySection('application-summary', 'Summary text'), legacySection('eligibility', 'Eligibility text')]),
    doc([legacySection('application-summary', 'Summary text', { semanticType: 'generic' }), legacySection('eligibility', 'Eligibility text', { semanticType: 'generic' })]),
  ]) {
    const { responses, updates } = harness({
      draftValue: draft({ documentJson }),
      opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['application-summary', 'eligibility'] } }),
    });

    const result = await responses.setStatus(actor, 'draft-1', { status: 'ready', revision: 3 });

    assert.equal(result.status, 'ready');
    assert.equal(updates.length, 1);
  }
});

test('valid non-generic semanticType takes precedence over legacy node type fallback', async () => {
  for (const semanticType of ['technical-response', 'intro', 'custom-safe']) {
    const { responses } = harness({
      draftValue: draft({ documentJson: doc([legacySection('eligibility', 'Eligibility text', { semanticType })]) }),
      opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['eligibility'] } }),
    });

    await assertBadRequestCode(
      responses.setStatus(actor, 'draft-1', { status: 'ready', revision: 3 }),
      'TENDER_APPLICATION_SECTIONS_MISSING',
      (body) => {
        assert.deepEqual(body.missing, ['eligibility']);
        assert.deepEqual(body.details, { required: ['eligibility'], missing: ['eligibility'] });
      },
    );
  }
});

test('legacy fallback ignores raw node type variants that frontend would not normalize', async () => {
  const { responses } = harness({
    draftValue: draft({ documentJson: doc([legacySection(' eligibility ', 'Eligibility text')]) }),
    opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['eligibility'] } }),
  });

  await assertBadRequestCode(
    responses.setStatus(actor, 'draft-1', { status: 'ready', revision: 3 }),
    'TENDER_APPLICATION_SECTIONS_MISSING',
    (body) => {
      assert.deepEqual(body.missing, ['eligibility']);
      assert.deepEqual(body.details, { required: ['eligibility'], missing: ['eligibility'] });
    },
  );
});

test('tender readiness treats absent or empty canonical section config as no required sections', async () => {
  for (const tenderData of [{}, { requiredApplicationSections: [] }]) {
    const { responses } = harness({
      draftValue: draft({ documentJson: doc([paragraph('Tender response without semantic sections.')]) }),
      opportunityValue: opportunity({ tenderData }),
    });

    await assert.doesNotReject(() => responses.setStatus(actor, 'draft-1', { status: 'ready', revision: 3 }));
  }
});

test('canonical tender config is used instead of spoofed draft checklist or payload data', async () => {
  const { responses } = harness({
    draftValue: draft({
      documentJson: doc([paragraph('Tender response without semantic sections.')]),
      checklist: { ...checklist, requiredApplicationSections: [] },
      tenderData: { requiredApplicationSections: [] },
    }),
    opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['technical-response'] } }),
  });

  await assertBadRequestCode(
    responses.setStatus(actor, 'draft-1', { status: 'ready', revision: 3 }),
    'TENDER_APPLICATION_SECTIONS_MISSING',
    (body) => {
      assert.deepEqual(body.missing, ['technical-response']);
      assert.deepEqual(body.details, { required: ['technical-response'], missing: ['technical-response'] });
    },
  );
});

test('invalid canonical tender section config fails with structured BadRequest', async () => {
  for (const requiredApplicationSections of ['eligibility', ['eligibility', 'unknown-section']]) {
    const { responses } = harness({
      draftValue: draft({ documentJson: doc([semanticSection('eligibility', 'Eligibility text')]) }),
      opportunityValue: opportunity({ tenderData: { requiredApplicationSections } }),
    });

    await assertBadRequestCode(
      responses.setStatus(actor, 'draft-1', { status: 'ready', revision: 3 }),
      'TENDER_APPLICATION_SECTIONS_INVALID',
      (body) => {
        const allowed = ['application-summary', 'eligibility', 'technical-response', 'documents-checklist', 'commercial-notes', 'closing'];
        assert.deepEqual(body.allowed, allowed);
        assert.deepEqual(body.details.allowed, allowed);
        if (Array.isArray(requiredApplicationSections)) assert.deepEqual(body.details.invalid, ['unknown-section']);
      },
    );
  }
});

test('vacancy and freelance readiness ignore tender required sections config', async () => {
  for (const type of ['vacancy', 'freelance']) {
    const { responses } = harness({
      draftValue: draft({ opportunityType: type, format: type === 'vacancy' ? 'cover_letter' : 'short_proposal', documentJson: doc([paragraph(`${type} response.`)]) }),
      opportunityValue: opportunity({ type, tenderData: { requiredApplicationSections: ['eligibility'] } }),
    });

    await assert.doesNotReject(() => responses.setStatus(actor, 'draft-1', { status: 'ready', revision: 3 }));
  }
});

test('response export validates tender sections before rendering and file storage', async () => {
  const { responses, stored } = harness({
    draftValue: draft({ documentJson: doc([paragraph('Tender response without semantic sections.')]) }),
    opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['documents-checklist'] } }),
  });

  await assertBadRequestCode(
    responses.export(actor, 'draft-1', { revision: 3, format: 'txt' }),
    'TENDER_APPLICATION_SECTIONS_MISSING',
    (body) => {
      assert.deepEqual(body.missing, ['documents-checklist']);
      assert.deepEqual(body.details, { required: ['documents-checklist'], missing: ['documents-checklist'] });
    },
  );
  assert.equal(stored.length, 0);
});


test('SetResponseStatusDto rejects non-boolean external submission confirmation', async () => {
  const dto = plainToInstance(SetResponseStatusDto, { status: 'submitted', revision: 3, confirmedExternalSubmission: 'true' });
  const errors = await validate(dto);
  assert.equal(errors.some((error) => error.property === 'confirmedExternalSubmission'), true);
});

test('tender submitted requires explicit external submission confirmation', async () => {
  for (const confirmedExternalSubmission of [undefined, false]) {
    const { responses, updates } = harness({
      draftValue: draft({ status: 'draft', checklist: {}, documentJson: doc([]), unresolvedPlaceholders: ['{{client_name}}'], generation: { status: 'stale' } }),
      opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['eligibility'] } }),
    });

    await assertBadRequestCode(
      responses.setStatus(actor, 'draft-1', { status: 'submitted', revision: 3, ...(confirmedExternalSubmission === undefined ? {} : { confirmedExternalSubmission }) }),
      'RESPONSE_EXTERNAL_SUBMISSION_UNCONFIRMED',
      (body) => assert.deepEqual(body.details, { status: 'submitted', opportunityType: 'tender', requiredFlag: 'confirmedExternalSubmission' }),
    );
    assert.equal(updates.length, 0);
  }
});

test('tender submitted records external fact directly and preserves draft content and checks', async () => {
  const incompleteDraft = draft({
    status: 'draft',
    documentJson: doc([]),
    markdownCache: '',
    checklist: {},
    unresolvedPlaceholders: ['{{client_name}}'],
    generation: { status: 'stale', baseRevision: 1, currentRevision: 3 },
  });
  const { responses, updates, notifications, webhooks } = harness({
    draftValue: incompleteDraft,
    opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['eligibility'] } }),
  });

  const result = await responses.setStatus(actor, 'draft-1', { status: 'submitted', revision: 3, confirmedExternalSubmission: true });

  assert.equal(result.status, 'submitted');
  assert.equal(result.documentJson, incompleteDraft.documentJson);
  assert.equal(result.checklist, incompleteDraft.checklist);
  assert.deepEqual(result.unresolvedPlaceholders, ['{{client_name}}']);
  assert.deepEqual(result.generation, incompleteDraft.generation);
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0]).sort(), ['sentAt', 'status']);
  assert.equal(updates[0].status, 'submitted');
  assert.equal(updates[0].sentAt instanceof Date, true);
  assert.equal(notifications.length, 1);
  assert.equal(webhooks.length, 1);
});

test('complete tender submitted is accepted from ready state with confirmation', async () => {
  const { responses, updates } = harness({
    draftValue: draft({ status: 'ready', documentJson: doc([semanticSection('eligibility', 'Eligibility text')]) }),
    opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['eligibility'] } }),
  });

  const result = await responses.setStatus(actor, 'draft-1', { status: 'submitted', revision: 3, confirmedExternalSubmission: true });

  assert.equal(result.status, 'submitted');
  assert.equal(updates.length, 1);
});

test('submitted status uses canonical opportunity type and rejects non-tenders', async () => {
  const { responses, updates } = harness({
    draftValue: draft({ opportunityType: 'tender', status: 'ready' }),
    opportunityValue: opportunity({ type: 'vacancy' }),
  });

  await assertBadRequestCode(
    responses.setStatus(actor, 'draft-1', { status: 'submitted', revision: 3, confirmedExternalSubmission: true }),
    'RESPONSE_SUBMISSION_NOT_ALLOWED',
    (body) => assert.deepEqual(body.details, { expectedType: 'tender', actualType: 'vacancy', status: 'submitted' }),
  );
  assert.equal(updates.length, 0);
});

test('tender submitted still uses repository revision CAS', async () => {
  const { responses } = harness({
    draftValue: draft({ revision: 4, status: 'draft' }),
    opportunityValue: opportunity(),
    updateWithRevision: async (_id, _userId, revision) => {
      assert.equal(revision, 3);
      throw new ConflictException({ code: 'RESPONSE_DRAFT_REVISION_CONFLICT', message: 'Response draft revision conflict' });
    },
  });

  await assert.rejects(
    () => responses.setStatus(actor, 'draft-1', { status: 'submitted', revision: 3, confirmedExternalSubmission: true }),
    (error) => error?.response?.code === 'RESPONSE_DRAFT_REVISION_CONFLICT' && error?.getStatus?.() === 409,
  );
});

test('ready sent and export remain strict for tender draft readiness', async () => {
  for (const status of ['ready', 'sent']) {
    const { responses } = harness({
      draftValue: draft({ checklist: {}, documentJson: doc([]), unresolvedPlaceholders: ['{{client_name}}'] }),
      opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['eligibility'] } }),
    });

    await assertBadRequestCode(
      responses.setStatus(actor, 'draft-1', { status, revision: 3, confirmedExternalSubmission: true }),
      'RESPONSE_CONTENT_EMPTY',
    );
  }

  const { responses, stored } = harness({
    draftValue: draft({ checklist: {}, documentJson: doc([]), unresolvedPlaceholders: ['{{client_name}}'] }),
    opportunityValue: opportunity({ tenderData: { requiredApplicationSections: ['eligibility'] } }),
  });
  await assertBadRequestCode(
    responses.export(actor, 'draft-1', { revision: 3, format: 'txt' }),
    'RESPONSE_CONTENT_EMPTY',
  );
  assert.equal(stored.length, 0);
});
