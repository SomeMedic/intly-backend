import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { BadRequestException, ConflictException } = require('@nestjs/common');
const { applyResumeSuggestion, normalizeStructuredResumeDocument } = require('../src/modules/resumes/resume-adaptation-engine.ts');

test('normalizes legacy resume lists into structured items with stable ids', () => {
  const document = normalizeStructuredResumeDocument({
    summary: 'Backend engineer',
    skills: ['TypeScript', { id: 'skill-node', text: 'Node.js' }],
    experience: ['Built queues'],
  });

  assert.equal(document.summary, 'Backend engineer');
  assert.equal(document.skills.length, 2);
  assert.equal(typeof document.skills[0].id, 'string');
  assert.equal(document.skills[0].text, 'TypeScript');
  assert.equal(document.skills[1].id, 'skill-node');
  assert.equal(document.experience[0].text, 'Built queues');
});

test('applies item-level resume suggestions only to the adapted structured copy', () => {
  const base = normalizeStructuredResumeDocument({
    summary: 'General backend engineer',
    experience: [{ id: 'exp-1', text: 'Built services' }, { id: 'exp-2', text: 'Maintained scripts' }],
  });
  const updated = applyResumeSuggestion(base, {
    id: 'sug-1',
    type: 'rewrite_section',
    title: 'Emphasize queues',
    evidence: 'Existing experience mentions services',
    proposed: { sectionId: 'experience', itemId: 'exp-1', action: 'replace', value: { text: 'Built high-load NestJS services and queues' } },
    status: 'pending',
  });

  assert.equal(updated.experience[0].id, 'exp-1');
  assert.equal(updated.experience[0].text, 'Built high-load NestJS services and queues');
  assert.equal(updated.experience[1].text, 'Maintained scripts');
  assert.equal(base.experience[0].text, 'Built services');
});

test('rejects added resume facts without supporting evidence', () => {
  const document = normalizeStructuredResumeDocument({ skills: [{ id: 'skill-1', text: 'Node.js' }] });

  assert.throws(() => applyResumeSuggestion(document, {
    id: 'sug-add',
    type: 'add_supported_detail',
    title: 'Add Kubernetes',
    proposed: { sectionId: 'skills', action: 'add', value: { text: 'Kubernetes' } },
    status: 'pending',
  }), BadRequestException);
});

test('resume adaptation service rejects tender opportunities', async () => {
  const { ResumesService } = require('../src/modules/resumes/resumes.service.ts');
  const service = new ResumesService(
    {
      getResumeOwned: async () => ({ _id: 'resume-1', kind: 'base', title: 'Base', documentJson: { skills: [] } }),
      createAdaptation: async () => { throw new Error('should not create tender adaptation'); },
    },
    { getById: async () => ({ _id: 'opp-tender', type: 'tender' }) },
    { getOwned: async () => ({ _id: 'profile-1' }) },
    {},
    { register: () => undefined },
    {},
  );

  await assert.rejects(
    () => service.createAdaptation({ id: 'user-1', email: 'user@example.test', role: 'User' }, 'opp-tender', { baseResumeId: 'resume-1', profileId: 'profile-1' }),
    /only vacancies and freelance/i,
  );
});


test('resume service reassigns a base resume to an owned profile', async () => {
  const { ResumesService } = require('../src/modules/resumes/resumes.service.ts');
  const calls = [];
  const service = new ResumesService(
    {
      updateResumeWithRevision: async (id, userId, revision, patch, unset) => {
        calls.push({ id, userId, revision, patch, unset });
        return { _id: id, userId, revision: revision + 1, ...patch };
      },
    },
    {},
    { getOwned: async (profileId, userId) => ({ _id: profileId, userId }) },
    {},
    { register: () => undefined },
    {},
  );

  await service.updateResume({ id: 'user-1', email: 'user@example.test', role: 'User' }, 'resume-1', { revision: 3, profileId: 'profile-2', title: 'CV' });

  assert.deepEqual(calls, [{ id: 'resume-1', userId: 'user-1', revision: 3, patch: { title: 'CV', profileId: 'profile-2' }, unset: [] }]);
});

test('resume service explicitly unbinds a base resume profile', async () => {
  const { ResumesService } = require('../src/modules/resumes/resumes.service.ts');
  const calls = [];
  const service = new ResumesService(
    {
      updateResumeWithRevision: async (id, userId, revision, patch, unset) => {
        calls.push({ id, userId, revision, patch, unset });
        return { _id: id, userId, revision: revision + 1, ...patch };
      },
    },
    {},
    { getOwned: async () => { throw new Error('profile lookup should not run for unbind'); } },
    {},
    { register: () => undefined },
    {},
  );

  await service.updateResume({ id: 'user-1', email: 'user@example.test', role: 'User' }, 'resume-1', { revision: 4, profileId: null });

  assert.deepEqual(calls, [{ id: 'resume-1', userId: 'user-1', revision: 4, patch: {}, unset: ['profileId'] }]);
});

test('resume service refuses reassignment to a foreign profile before update', async () => {
  const { ResumesService } = require('../src/modules/resumes/resumes.service.ts');
  let updateCalled = false;
  const service = new ResumesService(
    {
      updateResumeWithRevision: async () => { updateCalled = true; throw new Error('should not update'); },
    },
    {},
    { getOwned: async () => { throw new Error('Profile not found'); } },
    {},
    { register: () => undefined },
    {},
  );

  await assert.rejects(
    () => service.updateResume({ id: 'user-1', email: 'user@example.test', role: 'User' }, 'resume-1', { revision: 5, profileId: 'foreign-profile' }),
    /Profile not found/,
  );
  assert.equal(updateCalled, false);
});

test('resume service all-profile lists do not filter out unbound records', async () => {
  const { ResumesService } = require('../src/modules/resumes/resumes.service.ts');
  const calls = [];
  const service = new ResumesService(
    {
      listResumes: async (userId, query) => { calls.push({ method: 'listResumes', userId, query }); return []; },
      listAdaptations: async (userId, query) => { calls.push({ method: 'listAdaptations', userId, query }); return []; },
    },
    {},
    {},
    {},
    { register: () => undefined },
    {},
  );

  await service.listResumes({ id: 'user-1', email: 'user@example.test', role: 'User' }, { kind: 'base' });
  await service.listAdaptations({ id: 'user-1', email: 'user@example.test', role: 'User' }, {});

  assert.deepEqual(calls, [
    { method: 'listResumes', userId: 'user-1', query: { kind: 'base' } },
    { method: 'listAdaptations', userId: 'user-1', query: {} },
  ]);
});

test('resume export rejects a stale reviewed revision before rendering or storing a file', async () => {
  const { ResumesService } = require('../src/modules/resumes/resumes.service.ts');
  let baseResumeLoaded = false;
  let fileStored = false;
  let adaptationUpdated = false;
  const service = new ResumesService(
    {
      getAdaptationOwned: async () => ({
        _id: 'adaptation-1',
        userId: 'user-1',
        profileId: 'profile-1',
        opportunityId: 'opportunity-1',
        baseResumeId: 'resume-1',
        documentJson: { summary: 'Current content' },
        markdownCache: 'Current content',
        status: 'review',
        revision: 7,
      }),
      getResumeOwned: async () => { baseResumeLoaded = true; throw new Error('should not load base resume for stale export'); },
      updateAdaptationWithRevision: async () => { adaptationUpdated = true; throw new Error('should not update stale export'); },
    },
    {},
    {},
    {},
    { register: () => undefined },
    {
      storeBuffer: async () => { fileStored = true; throw new Error('should not store stale export'); },
    },
  );

  await assert.rejects(
    () => service.exportAdaptation({ id: 'user-1', email: 'user@example.test', role: 'User' }, 'adaptation-1', { format: 'pdf', revision: 6 }),
    ConflictException,
  );
  assert.equal(baseResumeLoaded, false);
  assert.equal(fileStored, false);
  assert.equal(adaptationUpdated, false);
});

test('resume export accepts a matching reviewed revision and marks that revision exported', async () => {
  const { ResumesService } = require('../src/modules/resumes/resumes.service.ts');
  const calls = [];
  const service = new ResumesService(
    {
      getAdaptationOwned: async () => ({
        _id: 'adaptation-1',
        userId: 'user-1',
        profileId: 'profile-1',
        opportunityId: 'opportunity-1',
        baseResumeId: 'resume-1',
        documentJson: { headline: 'Reviewed content', summary: 'Reviewed content' },
        markdownCache: 'Reviewed content',
        status: 'review',
        revision: 7,
      }),
      getResumeOwned: async (id, userId) => {
        calls.push({ method: 'getResumeOwned', id, userId });
        return { _id: id, userId, title: 'Base Resume' };
      },
      updateAdaptationWithRevision: async (id, userId, revision, patch) => {
        calls.push({ method: 'updateAdaptationWithRevision', id, userId, revision, patch });
        return { _id: id, userId, revision: revision + 1, ...patch };
      },
    },
    {},
    {},
    {},
    { register: () => undefined },
    {
      storeBuffer: async (userId, buffer, mimeType, filename, metadata) => {
        calls.push({ method: 'storeBuffer', userId, buffer, mimeType, filename, metadata, size: buffer.length });
        return { _id: 'file-1', originalName: filename, mimeType, size: buffer.length };
      },
    },
  );

  const result = await service.exportAdaptation({ id: 'user-1', email: 'user@example.test', role: 'User' }, 'adaptation-1', { format: 'txt', revision: 7 });

  assert.equal(result.fileId, 'file-1');
  assert.equal(result.filename, calls[1].filename);
  assert.match(result.filename, /^Base-Resume-Reviewed-content-[a-f0-9]+\.txt$/);
  assert.equal(result.filename.includes('opportunity-1'), false);
  assert.equal(result.mimeType, 'text/plain');
  assert.equal(result.size, calls[1].size);
  assert.match(calls[1].buffer.toString('utf8'), /Reviewed content/);
  assert.equal(calls[0].method, 'getResumeOwned');
  assert.equal(calls[1].method, 'storeBuffer');
  assert.equal(calls[2].method, 'updateAdaptationWithRevision');
  assert.equal(calls[2].revision, 7);
  assert.equal(calls[2].patch.status, 'exported');
  assert.equal(calls[2].patch.exportState.fileId, 'file-1');
  assert.equal(calls[2].patch.exportState.format, 'txt');
  assert.ok(calls[2].patch.exportState.exportedAt instanceof Date);
});

test('resume export renders canonical structured resume body for txt pdf and docx instead of stale markdown', async () => {
  for (const format of ['txt', 'pdf', 'docx']) {
    const stored = await exportFixture(format, {
      headline: 'Надёжный QA Automation Engineer',
      summary: 'Пишу автотесты\nСнижаю flaky failures',
      skills: ['TypeScript', { id: 'skill-1', text: 'Playwright' }, { id: 'skill-2', title: 'CI' }, { id: 'skill-3', description: 'Pipelines' }],
      experience: [{ id: 'exp-1', text: 'Built test platform\nReduced flakes' }],
      projects: [{ id: 'project-1', name: 'INTLY', summary: 'AI sourcing cockpit' }],
      education: ['Computer Science'],
      languages: [{ id: 'lang-1', text: 'English C1' }],
      links: [{ id: 'link-1', title: 'Portfolio', description: 'https://example.test/me' }],
    }, 'STALE MARKDOWN SHOULD NOT EXPORT');

    assert.match(stored.filename, new RegExp(`^QA-Base-Надёжный-QA-Automation-Engineer-[a-f0-9]+\\.${format}$`));
    assert.equal(stored.filename.includes('opportunity-1'), false);

    if (format === 'txt') {
      const text = stored.buffer.toString('utf8');
      assert.match(text, /Надёжный QA Automation Engineer/);
      assert.match(text, /Пишу автотесты\nСнижаю flaky failures/);
      assert.match(text, /Skills\n• TypeScript\n• Playwright\n• CI\n• Pipelines/);
      assert.match(text, /Experience\n• Built test platform\nReduced flakes/);
      assert.match(text, /Projects\n• INTLY/);
      assert.equal(text.includes('STALE MARKDOWN'), false);
    } else if (format === 'docx') {
      const documentXml = unzipStore(stored.buffer).get('word/document.xml').toString('utf8');
      assert.match(documentXml, /Надёжный QA Automation Engineer/);
      assert.match(documentXml, /Пишу автотесты/);
      assert.match(documentXml, /Playwright/);
      assert.match(documentXml, /CI/);
      assert.match(documentXml, /Pipelines/);
      assert.match(documentXml, /Built test platform/);
      assert.equal(documentXml.includes('STALE MARKDOWN'), false);
    } else {
      const content = pdfContentStreams(stored.buffer).join('\n');
      assert.match(content, new RegExp(cidHexForText(stored.buffer, 'Надёжный')));
      assert.match(content, new RegExp(cidHexForText(stored.buffer, 'Playwright')));
      assert.match(content, new RegExp(cidHexForText(stored.buffer, 'Pipelines')));
      assert.equal(content.includes('STALE MARKDOWN'), false);
    }
  }
});

test('resume export avoids duplicate headline body in pdf and docx while txt keeps it as content', async () => {
  const documentJson = {
    headline: 'Надёжный QA Automation Engineer',
    summary: 'Пишу автотесты',
    skills: ['Playwright'],
  };
  const txt = await exportFixture('txt', documentJson, 'STALE MARKDOWN SHOULD NOT EXPORT');
  const docx = await exportFixture('docx', documentJson, 'STALE MARKDOWN SHOULD NOT EXPORT');
  const pdf = await exportFixture('pdf', documentJson, 'STALE MARKDOWN SHOULD NOT EXPORT');

  assert.equal((txt.buffer.toString('utf8').match(/Надёжный QA Automation Engineer/g) ?? []).length, 1);
  const documentXml = unzipStore(docx.buffer).get('word/document.xml').toString('utf8');
  assert.equal((documentXml.match(/Надёжный QA Automation Engineer/g) ?? []).length, 1);
  assert.equal(pdfContentStreams(pdf.buffer).join('\n').match(new RegExp(cidHexForText(pdf.buffer, 'Надёжный'), 'g'))?.length, 1);
});

test('resume export uses fallback markdown only when canonical structured resume is empty', async () => {
  const stored = await exportFixture('txt', { headline: '', summary: '', skills: [], experience: [], projects: [], education: [], languages: [], links: [] }, 'Fallback resume text');

  assert.match(stored.filename, /^QA-Base-adapted-[a-f0-9]+\.txt$/);
  assert.equal(stored.buffer.toString('utf8'), 'Fallback resume text');
});

test('resume export keeps legacy Tiptap markdown fallback and friendly adapted filename', async () => {
  const stored = await exportFixture('txt', { type: 'doc', content: [] }, 'Legacy saved text');

  assert.match(stored.filename, /^QA-Base-adapted-[a-f0-9]+\.txt$/);
  assert.equal(stored.filename.includes('opportunity-1'), false);
  assert.equal(stored.buffer.toString('utf8'), 'Legacy saved text');
});

async function exportFixture(format, documentJson, markdownCache) {
  const { ResumesService } = require('../src/modules/resumes/resumes.service.ts');
  let stored;
  const service = new ResumesService(
    {
      getAdaptationOwned: async () => ({
        _id: 'adaptation-1',
        userId: 'user-1',
        profileId: 'profile-1',
        opportunityId: 'opportunity-1',
        baseResumeId: 'resume-1',
        documentJson,
        markdownCache,
        status: 'review',
        revision: 7,
      }),
      getResumeOwned: async () => ({ _id: 'resume-1', userId: 'user-1', title: 'QA Base' }),
      updateAdaptationWithRevision: async (id, userId, revision, patch) => ({ _id: id, userId, revision: revision + 1, ...patch }),
    },
    {},
    {},
    {},
    { register: () => undefined },
    {
      storeBuffer: async (userId, buffer, mimeType, filename, metadata) => {
        stored = { userId, buffer, mimeType, filename, metadata };
        return { _id: 'file-1', originalName: filename, mimeType, size: buffer.length };
      },
    },
  );

  await service.exportAdaptation({ id: 'user-1', email: 'user@example.test', role: 'User' }, 'adaptation-1', { format, revision: 7 });
  assert.ok(stored, 'export should store a file');
  return stored;
}

function unzipStore(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    entries.set(name, buffer.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

function pdfContentStreams(buffer) {
  const source = buffer.toString('latin1');
  return [...source.matchAll(/\/Contents (\d+) 0 R/g)].map((match) => objectStream(buffer, Number(match[1])).toString('utf8'));
}

function cidHexForText(pdf, value) {
  const unicodeMap = unicodeMapFor(pdf);
  return [...value].map((char) => {
    const cid = unicodeMap.get(toUtf16BeHex(char));
    assert.equal(typeof cid, 'number', `${char} should be present in ToUnicode`);
    return cid.toString(16).toUpperCase().padStart(4, '0');
  }).join('');
}

function unicodeMapFor(pdf) {
  const source = pdf.toString('latin1');
  const toUnicodeRef = source.match(/\/ToUnicode (\d+) 0 R/);
  assert.ok(toUnicodeRef, 'PDF should include a ToUnicode map');
  const value = objectStream(pdf, Number(toUnicodeRef[1])).toString('utf8');
  const map = new Map();
  for (const match of value.matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)) {
    map.set(match[2], Number.parseInt(match[1], 16));
  }
  return map;
}

function objectStream(buffer, objectId) {
  const marker = Buffer.from(`${objectId} 0 obj\n`, 'binary');
  const objectStart = buffer.indexOf(marker);
  assert.notEqual(objectStart, -1, `object ${objectId} should exist`);
  const streamStartMarker = Buffer.from('stream\n', 'binary');
  const streamStart = buffer.indexOf(streamStartMarker, objectStart);
  assert.notEqual(streamStart, -1, `object ${objectId} should contain a stream`);
  const contentStart = streamStart + streamStartMarker.length;
  const streamEnd = buffer.indexOf(Buffer.from('\nendstream', 'binary'), contentStart);
  assert.notEqual(streamEnd, -1, `object ${objectId} stream should terminate`);
  return buffer.subarray(contentStart, streamEnd);
}

function toUtf16BeHex(value) {
  const littleEndian = Buffer.from(value, 'utf16le');
  for (let index = 0; index < littleEndian.length; index += 2) {
    const next = littleEndian[index];
    littleEndian[index] = littleEndian[index + 1];
    littleEndian[index + 1] = next;
  }
  return littleEndian.toString('hex').toUpperCase();
}
