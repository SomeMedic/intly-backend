import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { TenderDocumentsService } = require('../src/modules/tender-documents/tender-documents.service.ts');
const { TenderSourceDocumentDownloader } = require('../src/modules/tender-documents/tender-source-document-downloader.ts');

const actor = { id: 'user-1', email: 'u@example.test', role: 'User' };
const otherActor = { id: 'user-2', email: 'other@example.test', role: 'User' };
const profile = { _id: '22222222-2222-4222-8222-222222222222', userId: actor.id, name: 'Main', aiPreferences: {} };
const sourceUrl = 'https://example.test/tender/1';
const documentUrl = 'https://example.test/files/requirements.pdf';
const opportunity = {
  _id: '11111111-1111-4111-8111-111111111111',
  type: 'tender',
  title: 'CRM tender',
  tenderData: { documents: [{ label: 'Fallback document', url: 'https://example.test/files/fallback.pdf' }] },
  sourceOccurrences: [{
    sourceId: 'roseltorg',
    externalId: 'proc-1',
    url: sourceUrl,
    sourceMetadata: {
      sourceDocuments: [
        { label: 'Техническое задание.pdf', url: documentUrl, secret: 'hidden' },
        { label: 'Landing duplicate', url: sourceUrl },
      ],
    },
  }],
};

function fixture(overrides = {}) {
  const links = [];
  const knowledgeDocs = new Map();
  const deletedKnowledge = [];
  let next = 1;
  const repository = overrides.repository ?? {
    create: async (input) => {
      const link = { _id: `33333333-3333-4333-8333-33333333333${next++}`, ...input };
      links.push(link);
      return link;
    },
    createSourceImport: async (input) => {
      const existing = links.find((link) => link.userId === input.userId && link.opportunityId === input.opportunityId && link.profileId === input.profileId && link.sourceId === input.sourceId && link.sourceUrl === input.sourceUrl && !link.deletedAt);
      if (existing) {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      }
      return repository.create(input);
    },
    findSourceImport: async ({ userId, opportunityId, profileId, sourceId, sourceUrl }) => links.find((link) => link.userId === userId && link.opportunityId === opportunityId && link.profileId === profileId && link.sourceId === sourceId && link.sourceUrl === sourceUrl && !link.deletedAt) ?? null,
    list: async ({ userId, opportunityId, profileId }) => links.filter((link) => (!userId || link.userId === userId) && link.opportunityId === opportunityId && link.profileId === profileId && !link.deletedAt),
    get: async (id) => links.find((link) => link._id === id),
    updateMany: async (ids, input) => { for (const link of links) if (ids.includes(link._id)) Object.assign(link, input); },
    softDelete: async () => undefined,
  };
  const knowledge = overrides.knowledge ?? {
    createMultipart: async (_actor, file, dto) => {
      const document = { id: `44444444-4444-4444-8444-44444444444${next++}`, fileId: `55555555-5555-4555-8555-55555555555${next++}`, title: dto.title, status: 'Uploading', file };
      knowledgeDocs.set(document.id, document);
      return document;
    },
    get: async (_actor, id) => knowledgeDocs.get(id) ?? { id, fileId: 'file-1', status: 'Indexed', extractedText: 'Ready text', summary: 'Ready' },
    delete: async (_actor, id) => { deletedKnowledge.push(id); return { success: true }; },
    reprocess: async () => ({ success: true }),
  };
  const downloaderCalls = [];
  const downloader = overrides.downloader ?? {
    download: async (url, fallback) => {
      downloaderCalls.push([url, fallback]);
      return { buffer: Buffer.from('%PDF-source'), finalUrl: url, filename: 'requirements.pdf', mimeType: 'application/pdf', size: 11 };
    },
  };
  const service = new TenderDocumentsService(
    repository,
    overrides.opportunities ?? { getById: async () => opportunity },
    overrides.profiles ?? { getOwned: async (profileId, userId) => {
      assert.equal(profileId, profile._id);
      if (userId !== actor.id) throw new Error('not owned');
      return profile;
    }, getById: async () => profile },
    knowledge,
    overrides.ai ?? { runTenderDocumentAnalysis: async () => ({ _id: 'run-1', status: 'queued' }), getRun: async () => ({ _id: 'run-1', status: 'queued' }) },
    downloader,
  );
  return { service, links, downloaderCalls, knowledgeDocs, deletedKnowledge };
}

test('imports only a retained native source document and exposes provenance without changing canonical tender', async () => {
  const before = JSON.stringify(opportunity);
  const { service, links, downloaderCalls } = fixture();
  const result = await service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: documentUrl, documentType: 'technical_specification' });
  assert.equal(result.sourceId, 'roseltorg');
  assert.equal(result.sourceUrl, documentUrl);
  assert.equal(result.filename, 'requirements.pdf');
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(result.size, 11);
  assert.equal(result.textReady, false);
  assert.equal(links[0].documentType, 'technical_specification');
  assert.equal(downloaderCalls[0][0], documentUrl);
  assert.equal(JSON.stringify(opportunity), before);
});

test('rejects arbitrary URLs and occurrence landing URLs', async () => {
  const { service, downloaderCalls } = fixture();
  await assert.rejects(service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: 'https://example.test/other.pdf' }), /not retained/i);
  await assert.rejects(service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: sourceUrl }), /not retained/i);
  assert.equal(downloaderCalls.length, 0);
});

test('keeps imported source documents private to owner profile scope', async () => {
  const { service } = fixture();
  await assert.rejects(service.importSource(otherActor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: documentUrl }), /not owned|Profile scope violation/i);
});

test('returns existing active import without downloading again', async () => {
  const { service, downloaderCalls } = fixture();
  const first = await service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: documentUrl });
  const second = await service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: documentUrl });
  assert.equal(second.id, first.id);
  assert.equal(second.alreadyImported, true);
  assert.equal(downloaderCalls.length, 1);
});

test('concurrent duplicate import cleans unused knowledge document and returns existing link', async () => {
  let firstLookup = true;
  const { service, links, deletedKnowledge } = fixture({
    repository: {
      create: async () => { throw new Error('unused'); },
      createSourceImport: async () => {
        const error = new Error('duplicate key');
        error.code = 11000;
        throw error;
      },
      findSourceImport: async () => {
        if (firstLookup) {
          firstLookup = false;
          return null;
        }
        return links[0] ?? null;
      },
      list: async () => links,
      get: async (id) => links.find((link) => link._id === id),
      updateMany: async () => undefined,
      softDelete: async () => undefined,
    },
  });
  links.push({ _id: '33333333-3333-4333-8333-333333333333', userId: actor.id, opportunityId: opportunity._id, profileId: profile._id, knowledgeDocumentId: 'existing-doc', fileId: 'file-1', title: 'Existing', documentType: 'other', aiStatus: 'Not analyzed', sourceId: 'roseltorg', sourceUrl: documentUrl });
  const result = await service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: documentUrl });
  assert.equal(result.id, '33333333-3333-4333-8333-333333333333');
  assert.equal(result.alreadyImported, true);
  assert.equal(deletedKnowledge.length, 1);
});

test('uses tenderData document fallback when occurrence sourceDocuments are missing', async () => {
  const { service } = fixture({
    opportunities: { getById: async () => ({ ...opportunity, sourceOccurrences: [{ sourceId: 'roseltorg', url: sourceUrl, sourceMetadata: {} }] }) },
  });
  const result = await service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: 'https://example.test/files/fallback.pdf' });
  assert.equal(result.sourceUrl, 'https://example.test/files/fallback.pdf');
});

test('uses per-occurrence tenderData object documents when sourceDocuments are missing', async () => {
  const occurrenceTenderDocumentUrl = 'https://example.test/files/from-occurrence-tender-data.pdf';
  const { service } = fixture({
    opportunities: {
      getById: async () => ({
        ...opportunity,
        tenderData: {},
        sourceOccurrences: [{
          sourceId: 'roseltorg',
          url: sourceUrl,
          sourceMetadata: {
            tenderData: {
              documents: [{ label: 'From occurrence tenderData', url: occurrenceTenderDocumentUrl }],
            },
          },
        }],
      }),
    },
  });
  const result = await service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: occurrenceTenderDocumentUrl });
  assert.equal(result.sourceUrl, occurrenceTenderDocumentUrl);
});

test('canonical tenderData fallback respects source provenance and rejects ambiguous multi-source documents', async () => {
  const wrongSourceUrl = 'https://example.test/files/wrong-source.pdf';
  const unprovenancedUrl = 'https://example.test/files/unprovenanced.pdf';
  const { service } = fixture({
    opportunities: {
      getById: async () => ({
        ...opportunity,
        tenderData: {
          documents: [
            { label: 'Wrong source', url: wrongSourceUrl, sourceId: 'platform-alt' },
            { label: 'No provenance', url: unprovenancedUrl },
          ],
        },
        sourceOccurrences: [
          { sourceId: 'roseltorg', url: sourceUrl, sourceMetadata: {} },
          { sourceId: 'platform-alt', url: 'https://alt.example.test/tender/1', sourceMetadata: {} },
        ],
      }),
    },
  });
  await assert.rejects(service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: wrongSourceUrl }), /not retained/i);
  await assert.rejects(service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: unprovenancedUrl }), /not retained/i);
});

test('skips invalid native descriptor URLs while still importing a valid retained document', async () => {
  const validUrl = 'https://example.test/files/valid-after-invalid.pdf';
  const { service } = fixture({
    opportunities: {
      getById: async () => ({
        ...opportunity,
        sourceOccurrences: [{
          sourceId: 'roseltorg',
          url: sourceUrl,
          sourceMetadata: {
            sourceDocuments: [
              { label: 'Broken', url: 'https://' },
              { label: 'Valid', url: validUrl },
            ],
          },
        }],
      }),
    },
  });
  const result = await service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: validUrl });
  assert.equal(result.sourceUrl, validUrl);
});

test('AI analysis only includes ready imported source documents', async () => {
  const { service, links } = fixture({
    ai: {
      runTenderDocumentAnalysis: async (_actor, input) => ({ _id: 'run-1', status: 'queued', input }),
      getRun: async () => ({ _id: 'run-1', status: 'queued' }),
    },
  });
  await service.importSource(actor, opportunity._id, { profileId: profile._id, sourceId: 'roseltorg', url: documentUrl });
  await assert.rejects(service.analyze(actor, opportunity._id, { profileId: profile._id, tenderDocumentIds: [links[0]._id] }), /not ready/i);
  links[0].knowledgeDocumentId = 'indexed-doc';
  const run = await service.analyze(actor, opportunity._id, { profileId: profile._id, tenderDocumentIds: [links[0]._id] });
  assert.equal(run.input.tenderDocuments[0].extractedText, 'Ready text');
  assert.equal(run.input.tenderDocuments[0].sourceId, 'roseltorg');
  assert.equal(run.input.tenderDocuments[0].sourceUrl, documentUrl);
});

class FakeDownloader extends TenderSourceDocumentDownloader {
  constructor(responses = []) {
    super();
    this.responses = [...responses];
    this.dispatchers = [];
    this.fetches = [];
  }

  async fetch(url, init) {
    this.fetches.push([url, init]);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }

  async createDispatcher(url) {
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') throw new Error('Private, loopback and link-local URLs are not allowed');
    const dispatcher = { closed: false, close: async () => { dispatcher.closed = true; } };
    this.dispatchers.push(dispatcher);
    return dispatcher;
  }
}

function streamResponse(chunks, headers = {}, onCancel = () => undefined, status = 200) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
    cancel() {
      onCancel();
    },
  }), { status, headers });
}

function readerResponse(chunks, headers = {}, onCancel = () => undefined, status = 200) {
  let index = 0;
  return {
    status,
    headers: new Headers(headers),
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            const chunk = chunks[index++];
            if (chunk instanceof Error) throw chunk;
            return { done: false, value: chunk };
          },
          async cancel() {
            onCancel();
          },
          releaseLock() {},
        };
      },
      async cancel() {
        onCancel();
      },
    },
  };
}

function officeZipBuffer(folder) {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(` [Content_Types].xml ${folder}/document.xml `),
  ]);
}

async function assertSourceError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(typeof error.getStatus, 'function');
    assert.equal(error.getStatus(), status);
    const response = error.getResponse();
    assert.equal(response.code, code);
    assert.equal(typeof response.message, 'string');
    assert.doesNotMatch(response.message, /SELF_SIGNED|ENOTFOUND|privatehost|stack|\/tmp/i);
    return true;
  });
}

class DispatcherFailureDownloader extends FakeDownloader {
  constructor(error) {
    super([]);
    this.error = error;
  }

  async createDispatcher() {
    throw this.error;
  }
}

test('source downloader is resolvable by real Nest DI without function provider injection', async () => {
  class DownloaderTestModule {}
  Module({ providers: [TenderSourceDocumentDownloader] })(DownloaderTestModule);
  const app = await NestFactory.createApplicationContext(DownloaderTestModule, { logger: false });
  try {
    const downloader = app.get(TenderSourceDocumentDownloader);
    assert.ok(downloader instanceof TenderSourceDocumentDownloader);
  } finally {
    await app.close();
  }
});

test('source downloader streams with size bound and cancels overrun body', async () => {
  let cancelled = false;
  const firstChunk = Buffer.alloc(25 * 1024 * 1024);
  const downloader = new FakeDownloader([
    readerResponse([firstChunk, Buffer.from('x')], { 'content-type': 'application/pdf' }, () => { cancelled = true; }),
  ]);
  await assert.rejects(downloader.download('https://example.test/document.pdf', 'document.pdf'), /too large/i);
  assert.equal(cancelled, true);
  assert.equal(downloader.dispatchers[0].closed, true);
});

test('source downloader cancels redirect response and rejects private redirect target before fetch', async () => {
  let cancelled = false;
  const downloader = new FakeDownloader([
    streamResponse([Buffer.from('redirect')], { location: 'http://127.0.0.1/private.pdf' }, () => { cancelled = true; }, 302),
  ]);
  await assert.rejects(downloader.download('https://example.test/document.pdf', 'document.pdf'), /Private|loopback|not allowed/i);
  assert.equal(cancelled, true);
  assert.equal(downloader.fetches.length, 1);
});

test('source downloader infers DOCX from retained filename for generic ZIP payload', async () => {
  const downloader = new FakeDownloader([
    streamResponse([officeZipBuffer('word')], { 'content-type': 'application/octet-stream' }),
  ]);
  const result = await downloader.download('https://example.test/download/resource', 'Техническое задание.docx');
  assert.equal(result.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(result.filename, 'Техническое задание.docx');
});

test('source downloader rejects fake PDF/image headers and malformed disposition safely', async () => {
  const fakePdf = new FakeDownloader([
    streamResponse([Buffer.from('not a pdf')], { 'content-type': 'application/pdf', 'content-disposition': "attachment; filename*=UTF-8''%E0%A4%A" }),
  ]);
  await assert.rejects(fakePdf.download('https://example.test/download/resource', 'fallback.pdf'), /does not match/i);

  const fakeImage = new FakeDownloader([
    streamResponse([Buffer.from('not a png')], { 'content-type': 'image/png' }),
  ]);
  await assert.rejects(fakeImage.download('https://example.test/image', 'fallback.png'), /does not match/i);
});

test('source downloader rejects HTML challenge and unsupported renamed ZIP archive', async () => {
  const html = new FakeDownloader([
    streamResponse([Buffer.from('<!doctype html><title>challenge</title>')], { 'content-type': 'application/octet-stream' }),
  ]);
  await assert.rejects(html.download('https://example.test/resource', 'document.pdf'), /HTML/i);

  const renamedZip = new FakeDownloader([
    streamResponse([Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(' random archive ')])], { 'content-type': 'application/octet-stream' }),
  ]);
  await assert.rejects(renamedZip.download('https://example.test/resource', 'document.docx'), /Office|archive|unsupported/i);
});


test('source downloader maps TLS, DNS/connect and timeout transport failures to structured safe errors', async () => {
  const tlsCause = Object.assign(new Error('certificate verify failed for privatehost.example'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  const tls = new FakeDownloader([new TypeError('fetch failed', { cause: tlsCause })]);
  await assertSourceError(tls.download('https://example.test/document.pdf', 'document.pdf'), 'SOURCE_DOCUMENT_TLS_ERROR', 502);

  const dnsCause = new AggregateError([
    Object.assign(new Error('getaddrinfo ENOTFOUND privatehost.example'), { code: 'ENOTFOUND' }),
  ], 'lookup failed');
  const dns = new FakeDownloader([new TypeError('fetch failed', { cause: dnsCause })]);
  await assertSourceError(dns.download('https://example.test/document.pdf', 'document.pdf'), 'SOURCE_DOCUMENT_UNAVAILABLE', 502);

  const connect = new DispatcherFailureDownloader(Object.assign(new Error('connect failed'), { code: 'UND_ERR_CONNECT' }));
  await assertSourceError(connect.download('https://example.test/document.pdf', 'document.pdf'), 'SOURCE_DOCUMENT_UNAVAILABLE', 502);

  let cancelled = false;
  const bodyTimeout = Object.assign(new Error('body timeout'), { code: 'UND_ERR_BODY_TIMEOUT' });
  const timeout = new FakeDownloader([
    readerResponse([bodyTimeout], { 'content-type': 'application/pdf' }, () => { cancelled = true; }),
  ]);
  await assertSourceError(timeout.download('https://example.test/document.pdf', 'document.pdf'), 'SOURCE_DOCUMENT_TIMEOUT', 504);
  assert.equal(cancelled, true);
  assert.equal(timeout.dispatchers[0].closed, true);
});

test('source downloader does not mask unknown programming errors as upstream failures', async () => {
  const bug = new FakeDownloader([new TypeError('programming bug')]);
  await assert.rejects(bug.download('https://example.test/document.pdf', 'document.pdf'), (error) => {
    assert.equal(error instanceof TypeError, true);
    assert.equal(error.message, 'programming bug');
    assert.equal(typeof error.getStatus, 'undefined');
    return true;
  });
});

test('source downloader maps retained-source HTTP denial statuses to structured codes', async () => {
  await assertSourceError(
    new FakeDownloader([streamResponse([Buffer.from('denied')], {}, undefined, 403)]).download('https://example.test/document.pdf', 'document.pdf'),
    'SOURCE_DOCUMENT_ACCESS_DENIED',
    400,
  );
  await assertSourceError(
    new FakeDownloader([streamResponse([Buffer.from('missing')], {}, undefined, 404)]).download('https://example.test/document.pdf', 'document.pdf'),
    'SOURCE_DOCUMENT_NOT_FOUND',
    400,
  );
  await assertSourceError(
    new FakeDownloader([streamResponse([Buffer.from('limited')], {}, undefined, 429)]).download('https://example.test/document.pdf', 'document.pdf'),
    'SOURCE_DOCUMENT_RATE_LIMITED',
    400,
  );
});

test('source downloader decodes RFC2047 Content-Disposition filenames with safe fallback', async () => {
  const encodedWindows1251 = new FakeDownloader([
    streamResponse([officeZipBuffer('word')], {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="=?windows-1251?B?0uX1X+fg5ODt6OUuZG9jeA==?="',
    }),
  ]);
  const result = await encodedWindows1251.download('https://example.test/download/resource', 'retained-name.docx');
  assert.equal(result.filename, 'Тех_задание.docx');

  const invalidCharset = new FakeDownloader([
    streamResponse([officeZipBuffer('word')], {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="=?koi8-r?B?0uX1X+fg5ODt6OUuZG9jeA==?="',
    }),
  ]);
  const fallback = await invalidCharset.download('https://example.test/download/resource', 'retained/path/name.docx');
  assert.equal(fallback.filename, 'name.docx');
});
