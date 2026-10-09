import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { CreateMultipartFileDto, FileListQueryDto } = require('../src/modules/files/dto/file.dto.ts');
const { FilesController } = require('../src/modules/files/files.controller.ts');
const { FilesDownloadTokensService } = require('../src/modules/files/files-download-tokens.service.ts');
const { FilesService } = require('../src/modules/files/files.service.ts');
const { FilesStorageService } = require('../src/modules/files/files-storage.service.ts');
const { PUBLIC_KEY } = require('../src/common/access.ts');
const { ConfigService } = require('@nestjs/config');

const jwtSecret = 'download-ticket-secret-with-more-than-32-characters';

test('file list accepts bounded integer limits from HTTP query strings', async () => {
  for (const limit of ['1', '50', '100']) {
    const query = plainToInstance(FileListQueryDto, { limit });
    assert.equal((await validate(query)).length, 0);
    assert.equal(query.limit, Number(limit));
  }
  assert.equal((await validate(plainToInstance(FileListQueryDto, {}))).length, 0);
});

test('file list rejects malformed, repeated, fractional, and out-of-range limits', async () => {
  for (const limit of ['', 'unknown', '0', '101', '1.5', ['10'], true]) {
    const query = plainToInstance(FileListQueryDto, { limit });
    assert.ok((await validate(query)).some(error => error.property === 'limit'));
  }
});

test('multipart metadata is parsed and malformed metadata remains invalid', async () => {
  const valid = plainToInstance(CreateMultipartFileDto, { filename: 'import.csv', mimeType: 'text/csv', metadata: '{"kind":"opportunity_import"}' });
  assert.deepEqual(valid.metadata, { kind: 'opportunity_import' });
  assert.equal((await validate(valid)).length, 0);
  for (const metadata of ['invalid', '[]', 'null']) {
    const invalid = plainToInstance(CreateMultipartFileDto, { metadata });
    assert.ok((await validate(invalid)).some(error => error.property === 'metadata'));
  }
});

test('generated XLSX can be stored and Unicode filenames yield safe download headers', async () => {
  const file = { _id: 'file-1', ownerUserId: 'user-1', originalName: 'Резюме команды.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 11 };
  const service = new FilesService({ create: async input => ({ ...file, ...input }), getById: async () => file }, {
    put: async buffer => ({ provider: 'local', bucket: 'test', objectKey: 'file-1', sha256: 'hash', size: buffer.length }),
    getStream: async () => Readable.from([Buffer.from('xlsx export')]),
  });
  const stored = await service.storeBuffer('user-1', Buffer.from('xlsx export'), file.mimeType, file.originalName);
  assert.equal(stored.mimeType, file.mimeType);
  const stream = await service.content({ id: 'user-1', role: 'User' }, 'file-1');
  assert.ok(stream.getHeaders().disposition.includes("filename*=UTF-8''%D0"));
  assert.equal(stream.getHeaders().length, 11);
  assert.ok(!/[\r\n]/.test(stream.getHeaders().disposition));
  await assert.rejects(service.content({ id: 'other-user', role: 'User' }, 'file-1'), /access denied/i);
});

test('generated files bypass upload size cap and stream back with hash preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intly-files-large-'));
  const source = join(root, 'large-export.json');
  const chunk = Buffer.alloc(1024 * 1024, 'a');
  const hash = createHash('sha256');
  try {
    for (let index = 0; index < 26; index += 1) {
      await writeFile(source, chunk, { flag: index === 0 ? 'w' : 'a' });
      hash.update(chunk);
    }
    const repository = {
      create: async input => ({ _id: 'large-file', ...input }),
      getById: async () => repository.file,
    };
    const storage = new FilesStorageService(new ConfigService({ FILE_STORAGE_ROOT: join(root, 'storage'), MINIO_BUCKET: 'private' }));
    const service = new FilesService(repository, storage);
    const stored = await service.storeGeneratedFile('user-1', source, 'application/json', 'large-export.json', { kind: 'opportunity_export' });
    repository.file = stored;
    assert.equal(stored.size, 26 * 1024 * 1024);
    assert.equal(stored.sha256, hash.digest('hex'));
    assert.equal(stored.metadata.kind, 'opportunity_export');

    const streamable = await service.content({ id: 'user-1', role: 'User' }, 'large-file');
    const streamed = await streamToBuffer(streamable.getStream());
    assert.equal(streamed.length, stored.size);
    assert.equal(createHash('sha256').update(streamed).digest('hex'), stored.sha256);
    assert.equal(streamable.getHeaders().length, stored.size);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('regular uploads still enforce the 25MB cap', async () => {
  const service = new FilesService({ create: async input => input }, { put: async () => { throw new Error('put should not be called'); } });
  await assert.rejects(
    service.storeBuffer('user-1', Buffer.alloc(25 * 1024 * 1024 + 1), 'application/json', 'too-large.json'),
    /too large/i,
  );
});

test('download-url grants a short owner-bound ticket and public ticket download streams without buffering', async () => {
  const file = fileAsset({ ownerUserId: 'owner-1', originalName: 'Выгрузка команды.csv', mimeType: 'text/csv', size: 12, sha256: 'hash-v1' });
  let getBufferCalled = false;
  const service = filesServiceFor(file, {
    get: async () => {
      getBufferCalled = true;
      return Buffer.from('should not be used');
    },
    getStream: async () => Readable.from([Buffer.from('streamed csv')]),
  });

  const grant = await service.download({ id: 'owner-1', role: 'User' }, file._id);
  assert.match(grant.url, new RegExp(`^/api/v1/files/${file._id}/download\\?ticket=fdl1\\.`));
  assert.ok(grant.expiresAt instanceof Date);
  assert.ok(grant.expiresAt.getTime() > Date.now());

  const ticket = new URL(`http://localhost${grant.url}`).searchParams.get('ticket');
  const streamable = await service.downloadWithTicket(file._id, ticket);
  assert.equal(await streamToString(streamable.getStream()), 'streamed csv');
  assert.equal(getBufferCalled, false);
  assert.equal(streamable.getHeaders().type, 'text/csv');
  assert.equal(streamable.getHeaders().length, 12);
  assert.ok(streamable.getHeaders().disposition.includes("filename*=UTF-8''%D0"));
});

test('download-url grants for owners and admins but denies a different user at mint time', async () => {
  const file = fileAsset({ ownerUserId: 'owner-1' });
  const service = filesServiceFor(file);
  await assert.doesNotReject(service.download({ id: 'owner-1', role: 'User' }, file._id));
  const adminGrant = await service.download({ id: 'admin-1', role: 'Admin' }, file._id);
  const ticket = new URL(`http://localhost${adminGrant.url}`).searchParams.get('ticket');
  await assert.doesNotReject(service.downloadWithTicket(file._id, ticket));
  await assert.rejects(service.download({ id: 'other-user', role: 'User' }, file._id), /access denied/i);
});

test('download ticket rejects tamper, wrong file, expiry, malformed access-token-like input, and deleted files', async () => {
  const file = fileAsset({ ownerUserId: 'owner-1', sha256: 'hash-v1' });
  const service = filesServiceFor(file);
  const grant = await service.download({ id: 'owner-1', role: 'User' }, file._id);
  const ticket = new URL(`http://localhost${grant.url}`).searchParams.get('ticket');
  const tampered = `${ticket.slice(0, -1)}${ticket.endsWith('A') ? 'B' : 'A'}`;
  await assert.rejects(service.downloadWithTicket(file._id, tampered), /Invalid file download ticket/);
  const alias = `${ticket.slice(0, -1)}${canonicalBase64UrlAlias(ticket.at(-1))}`;
  assert.notEqual(Buffer.from(alias.split('.')[2], 'base64url').toString('hex'), '');
  assert.equal(Buffer.from(alias.split('.')[2], 'base64url').equals(Buffer.from(ticket.split('.')[2], 'base64url')), true);
  await assert.rejects(service.downloadWithTicket(file._id, alias), /Invalid file download ticket/);
  await assert.rejects(service.downloadWithTicket('00000000-0000-4000-8000-000000000002', ticket), /Invalid file download ticket/);
  await assert.rejects(service.downloadWithTicket(file._id, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lci0xIn0.signature'), /Invalid file download ticket/);

  const tokens = new FilesDownloadTokensService(new ConfigService({ JWT_SECRET: jwtSecret }));
  const expired = tokens.issue({ fileId: file._id, ownerUserId: file.ownerUserId, fileVersion: `${file.size}:${file.sha256}`, now: 10_000, ttlMs: 1 }).ticket;
  await assert.rejects(service.downloadWithTicket(file._id, expired), /Invalid file download ticket/);
  const future = tokens.issue({ fileId: file._id, ownerUserId: file.ownerUserId, fileVersion: `${file.size}:${file.sha256}`, now: Date.now(), ttlMs: 10 * 60 * 1000 });
  assert.ok(future.expiresAt.getTime() <= Date.now() + 5 * 60 * 1000 + 1000);
  const tooFarAhead = tokens.issue({ fileId: file._id, ownerUserId: file.ownerUserId, fileVersion: `${file.size}:${file.sha256}`, now: Date.now() + 10 * 60 * 1000 }).ticket;
  await assert.rejects(service.downloadWithTicket(file._id, tooFarAhead), /Invalid file download ticket/);

  const deleted = filesServiceFor(file, {}, { getById: async () => { throw new Error('File not found'); } });
  await assert.rejects(deleted.downloadWithTicket(file._id, ticket), /File not found/);
});

test('download ticket is invalidated when stored file version changes', async () => {
  const file = fileAsset({ ownerUserId: 'owner-1', size: 12, sha256: 'hash-v1' });
  const service = filesServiceFor(file);
  const grant = await service.download({ id: 'owner-1', role: 'User' }, file._id);
  const ticket = new URL(`http://localhost${grant.url}`).searchParams.get('ticket');
  const changed = filesServiceFor({ ...file, sha256: 'hash-v2' });
  await assert.rejects(changed.downloadWithTicket(file._id, ticket), /access denied/i);
});

test('ticket download streams the already verified file without a second repository lookup', async () => {
  const file = fileAsset({ ownerUserId: 'owner-1' });
  let reads = 0;
  const service = filesServiceFor(file, {}, {
    getById: async id => {
      reads += 1;
      if (id !== file._id) throw new Error('File not found');
      return reads === 1 ? file : { ...file, sha256: 'changed-after-verification' };
    },
  });
  const grant = await service.download({ id: 'owner-1', role: 'User' }, file._id);
  const ticket = new URL(`http://localhost${grant.url}`).searchParams.get('ticket');
  reads = 0;
  await assert.doesNotReject(service.downloadWithTicket(file._id, ticket));
  assert.equal(reads, 1);
});

test('download controller exposes only the ticket download handler as public', () => {
  assert.equal(Reflect.getMetadata(PUBLIC_KEY, FilesController.prototype.downloadWithTicket), true);
  assert.equal(Reflect.getMetadata(PUBLIC_KEY, FilesController.prototype.download), undefined);
  assert.equal(Reflect.getMetadata(PUBLIC_KEY, FilesController.prototype.content), undefined);
});

test('storage supports Compose host endpoints and production fails without credentials', () => {
  assert.doesNotThrow(() => new FilesStorageService(new ConfigService({ MINIO_ENDPOINT: 'minio', MINIO_PORT: '9000', MINIO_ACCESS_KEY: 'test-access', MINIO_SECRET_KEY: 'test-secret' })));
  assert.doesNotThrow(() => new FilesStorageService(new ConfigService({ MINIO_ENDPOINT: 'http://127.0.0.1:9000', MINIO_ACCESS_KEY: 'test-access', MINIO_SECRET_KEY: 'test-secret' })));
  assert.throws(() => new FilesStorageService(new ConfigService({ NODE_ENV: 'production' })), /requires MinIO/i);
});

test('development storage round-trips bytes and blocks sibling-directory traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intly-files-'));
  const service = new FilesStorageService(new ConfigService({ FILE_STORAGE_ROOT: root, MINIO_BUCKET: 'private' }));
  try {
    const bytes = Buffer.from('Данные импорта', 'utf8');
    const stored = await service.put(bytes, 'text/plain', 'данные.txt');
    assert.deepEqual(await service.get({ storageProvider: stored.provider, bucket: stored.bucket, objectKey: stored.objectKey }), bytes);
    assert.deepEqual(await streamToBuffer(await service.getStream({ storageProvider: stored.provider, bucket: stored.bucket, objectKey: stored.objectKey })), bytes);
    await mkdir(join(root, 'private-sibling'));
    await writeFile(join(root, 'private-sibling', 'secret'), 'outside');
    await assert.rejects(service.get({ storageProvider: 'local', bucket: 'private', objectKey: '../private-sibling/secret' }), /Invalid object key/);
    await assert.rejects(service.getStream({ storageProvider: 'local', bucket: 'private', objectKey: '../private-sibling/secret' }), /Invalid object key/);
    await assert.rejects(service.getStream({ storageProvider: 'local', bucket: '../private-sibling', objectKey: 'secret' }), /Invalid object key/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function streamToString(stream) {
  return (await streamToBuffer(stream)).toString('utf8');
}

function fileAsset(overrides = {}) {
  return {
    _id: '00000000-0000-4000-8000-000000000001',
    ownerUserId: 'owner-1',
    originalName: 'export.csv',
    mimeType: 'text/csv',
    size: 12,
    sha256: 'hash-v1',
    storageProvider: 'local',
    bucket: 'private',
    objectKey: '2026-10-05/export.csv',
    status: 'Stored',
    metadata: {},
    ...overrides,
  };
}

function filesServiceFor(file, storageOverrides = {}, repositoryOverrides = {}) {
  const repository = {
    create: async input => ({ _id: file._id, ...input }),
    getById: async id => {
      if (id !== file._id) throw new Error('File not found');
      return file;
    },
    ...repositoryOverrides,
  };
  const storage = {
    getStream: async () => Readable.from([Buffer.from('streamed csv')]),
    ...storageOverrides,
  };
  return new FilesService(
    repository,
    storage,
    new FilesDownloadTokensService(new ConfigService({ JWT_SECRET: jwtSecret })),
  );
}

function canonicalBase64UrlAlias(character) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const index = alphabet.indexOf(character);
  assert.ok(index >= 0);
  const aliasedIndex = (index & 0b111100) | ((index + 1) & 0b000011);
  const alias = alphabet[aliasedIndex];
  assert.notEqual(alias, character);
  return alias;
}
