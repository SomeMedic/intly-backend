import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';

import { newId } from '../../common/schema';
import { StorageProvider } from './schemas/file-asset.schema';

export type StoredObject = {
  provider: StorageProvider;
  bucket: string;
  objectKey: string;
  sha256: string;
  size: number;
};

@Injectable()
export class FilesStorageService {
  private readonly bucket: string;
  private readonly minio?: Client;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('MINIO_BUCKET') ?? 'intly-files';
    const endPoint = this.config.get<string>('MINIO_ENDPOINT');
    const accessKey = this.config.get<string>('MINIO_ACCESS_KEY');
    const secretKey = this.config.get<string>('MINIO_SECRET_KEY');
    if (endPoint && accessKey && secretKey) {
      const hasProtocol = /^https?:\/\//.test(endPoint);
      const secure = this.config.get<string | boolean>('MINIO_USE_SSL');
      const url = new URL(hasProtocol ? endPoint : `${secure === true || secure === 'true' ? 'https' : 'http'}://${endPoint}`);
      this.minio = new Client({
        endPoint: url.hostname,
        port: url.port ? Number(url.port) : !hasProtocol ? Number(this.config.get<string>('MINIO_PORT') ?? 9000) : url.protocol === 'https:' ? 443 : 80,
        useSSL: url.protocol === 'https:',
        accessKey,
        secretKey,
        region: this.config.get<string>('MINIO_REGION'),
      });
    } else if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new ServiceUnavailableException('Production object storage requires MinIO endpoint and credentials');
    }
  }

  async put(buffer: Buffer, mimeType: string, filename: string): Promise<StoredObject> {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const objectKey = `${new Date().toISOString().slice(0, 10)}/${newId()}-${this.cleanName(filename)}`;
    if (this.minio) {
      await this.putMinio(objectKey, buffer, mimeType);
      return { provider: 'minio', bucket: this.bucket, objectKey, sha256, size: buffer.length };
    }
    const root = this.localRoot();
    const path = join(root, this.bucket, objectKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);
    return { provider: 'local', bucket: this.bucket, objectKey, sha256, size: buffer.length };
  }

  async putFile(path: string, mimeType: string, filename: string): Promise<StoredObject> {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) throw new ServiceUnavailableException('Generated file is not a regular file');
    const sha256 = await this.hashFile(path);
    const objectKey = `${new Date().toISOString().slice(0, 10)}/${newId()}-${this.cleanName(filename)}`;
    if (this.minio) {
      await this.putMinioFile(objectKey, path, mimeType);
      return { provider: 'minio', bucket: this.bucket, objectKey, sha256, size: fileStat.size };
    }
    const root = this.localRoot();
    const storagePath = join(root, this.bucket, objectKey);
    await mkdir(dirname(storagePath), { recursive: true });
    await copyFile(path, storagePath);
    return { provider: 'local', bucket: this.bucket, objectKey, sha256, size: fileStat.size };
  }

  async get(object: { storageProvider: StorageProvider; bucket: string; objectKey: string }): Promise<Buffer> {
    if (object.storageProvider === 'minio') {
      return this.getMinio(object.bucket, object.objectKey);
    }
    return readFile(this.localObjectPath(object.bucket, object.objectKey));
  }

  async getStream(object: { storageProvider: StorageProvider; bucket: string; objectKey: string }): Promise<Readable> {
    if (object.storageProvider === 'minio') {
      return this.getMinioStream(object.bucket, object.objectKey);
    }
    return createReadStream(this.localObjectPath(object.bucket, object.objectKey));
  }

  async downloadUrl(object: { provider: StorageProvider; bucket: string; objectKey: string; fileId: string }): Promise<{ url: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    if (object.provider === 'minio' && this.minio) {
      return { url: await this.minio.presignedGetObject(object.bucket, object.objectKey, 5 * 60), expiresAt };
    }
    return { url: `/api/v1/files/${object.fileId}/content`, expiresAt };
  }

  private async putMinio(objectKey: string, buffer: Buffer, mimeType: string): Promise<void> {
    if (!this.minio) throw new ServiceUnavailableException('Object storage is unavailable');
    await this.ensureMinioBucket();
    await this.minio.putObject(this.bucket, objectKey, buffer, buffer.length, { 'content-type': mimeType });
  }

  private async putMinioFile(objectKey: string, path: string, mimeType: string): Promise<void> {
    if (!this.minio) throw new ServiceUnavailableException('Object storage is unavailable');
    await this.ensureMinioBucket();
    await this.minio.fPutObject(this.bucket, objectKey, path, { 'content-type': mimeType });
  }

  private async getMinio(bucket: string, objectKey: string): Promise<Buffer> {
    const stream = await this.getMinioStream(bucket, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  private async getMinioStream(bucket: string, objectKey: string): Promise<Readable> {
    if (!this.minio) throw new ServiceUnavailableException('Object storage is unavailable');
    return this.minio.getObject(bucket, objectKey);
  }

  private async ensureMinioBucket(): Promise<void> {
    if (!this.minio) throw new ServiceUnavailableException('Object storage is unavailable');
    if (!(await this.minio.bucketExists(this.bucket))) {
      await this.minio.makeBucket(this.bucket, this.config.get<string>('MINIO_REGION'));
    }
  }

  private async hashFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  }

  private localObjectPath(bucket: string, objectKey: string): string {
    const storageRoot = normalize(this.localRoot());
    const root = normalize(join(storageRoot, bucket));
    if (!root.startsWith(`${storageRoot}/`)) throw new ServiceUnavailableException('Invalid object key');
    const path = normalize(join(this.localRoot(), bucket, objectKey));
    if (!path.startsWith(`${root}/`)) throw new ServiceUnavailableException('Invalid object key');
    return path;
  }

  private localRoot(): string {
    return this.config.get<string>('FILE_STORAGE_ROOT') ?? '/private/tmp/intly-file-storage';
  }

  private cleanName(filename: string): string {
    return filename.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 180) || 'file';
  }
}
