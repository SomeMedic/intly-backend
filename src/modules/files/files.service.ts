import { BadRequestException, ForbiddenException, Injectable, PayloadTooLargeException, StreamableFile, UnsupportedMediaTypeException } from '@nestjs/common';

import { Actor } from '../../common/access';
import { toPublic } from '../../common/schema';
import { CreateFileDto, CreateMultipartFileDto, FileListQueryDto } from './dto/file.dto';
import { FilesRepository } from './files.repository';
import { FilesStorageService } from './files-storage.service';
import { FilesDownloadTokensService } from './files-download-tokens.service';
import { FileAsset } from './schemas/file-asset.schema';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'text/markdown',
  'application/json',
  'application/x-ndjson',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

@Injectable()
export class FilesService {
  constructor(
    private readonly repository: FilesRepository,
    private readonly storage: FilesStorageService,
    private readonly downloadTokens?: FilesDownloadTokensService,
  ) {}

  async list(actor: Actor, query: FileListQueryDto) {
    const files = actor.role === 'Admin' ? await this.repository.listAll(query) : await this.repository.listForUser(actor.id, query);
    return { items: files.map((file) => toPublic(file)), nextCursor: null };
  }

  async create(actor: Actor, dto: CreateFileDto) {
    return toPublic(await this.storeBuffer(actor.id, Buffer.from(dto.contentBase64, 'base64'), dto.mimeType, dto.filename, dto.metadata));
  }

  async createMultipart(actor: Actor, file: { buffer: Buffer; originalname: string; mimetype: string; size: number }, dto: CreateMultipartFileDto) {
    if (!file?.buffer?.length) throw new BadRequestException('File is required');
    return toPublic(
      await this.storeBuffer(
        actor.id,
        file.buffer,
        dto.mimeType ?? file.mimetype,
        dto.filename ?? file.originalname,
        dto.metadata,
      ),
    );
  }

  async storeBuffer(ownerUserId: string, buffer: Buffer, mimeType: string, filename: string, metadata: Record<string, unknown> = {}): Promise<FileAsset> {
    this.validateUpload(buffer, mimeType);
    const stored = await this.storage.put(buffer, mimeType, filename);
    return this.repository.create({
      ownerUserId,
      originalName: filename,
      mimeType,
      size: stored.size,
      sha256: stored.sha256,
      storageProvider: stored.provider,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      status: 'Stored',
      metadata,
    });
  }

  async storeGeneratedFile(ownerUserId: string, path: string, mimeType: string, filename: string, metadata: Record<string, unknown> = {}): Promise<FileAsset> {
    this.validateMimeType(mimeType);
    const stored = await this.storage.putFile(path, mimeType, filename);
    return this.repository.create({
      ownerUserId,
      originalName: filename,
      mimeType,
      size: stored.size,
      sha256: stored.sha256,
      storageProvider: stored.provider,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      status: 'Stored',
      metadata,
    });
  }

  async get(actor: Actor, id: string) {
    const file = await this.getAccessible(actor, id);
    return toPublic(file);
  }

  async readForSystem(id: string): Promise<{ file: FileAsset; buffer: Buffer }> {
    const file = await this.repository.getById(id);
    return { file, buffer: await this.storage.get(file) };
  }

  async content(actor: Actor, id: string): Promise<StreamableFile> {
    const file = await this.getAccessible(actor, id);
    return this.streamFile(file);
  }

  async download(actor: Actor, id: string) {
    const file = await this.getAccessible(actor, id);
    const grant = this.tokenService().issue({ fileId: file._id, ownerUserId: file.ownerUserId, fileVersion: this.fileVersion(file) });
    return {
      url: `/api/v1/files/${file._id}/download?ticket=${encodeURIComponent(grant.ticket)}`,
      expiresAt: grant.expiresAt,
    };
  }

  async downloadWithTicket(id: string, ticket: string): Promise<StreamableFile> {
    const verified = this.tokenService().verify(ticket, id);
    const file = await this.getAccessible({ id: verified.oid, email: '', role: 'User' }, id);
    if (this.fileVersion(file) !== verified.fv) {
      throw new ForbiddenException('File access denied');
    }
    return this.streamFile(file);
  }

  async delete(actor: Actor, id: string): Promise<{ success: true }> {
    await this.getAccessible(actor, id);
    await this.repository.softDelete(id);
    return { success: true };
  }

  private async getAccessible(actor: Actor, id: string): Promise<FileAsset> {
    const file = await this.repository.getById(id);
    if (actor.role !== 'Admin' && file.ownerUserId !== actor.id) throw new ForbiddenException('File access denied');
    return file;
  }

  private async streamFile(file: FileAsset): Promise<StreamableFile> {
    const stream = await this.storage.getStream(file);
    return new StreamableFile(stream, {
      type: file.mimeType,
      disposition: `attachment; filename="${file.originalName.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.originalName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      length: file.size,
    });
  }

  private fileVersion(file: FileAsset): string {
    return `${file.size}:${file.sha256}`;
  }

  private tokenService(): FilesDownloadTokensService {
    if (!this.downloadTokens) throw new Error('FilesDownloadTokensService is not configured');
    return this.downloadTokens;
  }

  private validateUpload(buffer: Buffer, mimeType: string): void {
    this.validateMimeType(mimeType);
    if (buffer.length > MAX_UPLOAD_BYTES) throw new PayloadTooLargeException('File is too large');
  }

  private validateMimeType(mimeType: string): void {
    if (!ALLOWED_MIME.has(mimeType)) throw new UnsupportedMediaTypeException('Unsupported file type');
  }
}
