import { BadRequestException, HttpException, HttpStatus, Injectable, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { fetch as undiciFetch } from 'undici';

import { createPinnedDispatcher } from '../sources/extraction/pinned-fetch';
import { parseHttpUrl } from '../sources/extraction/url-safety';

const MAX_SOURCE_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 30_000;

const SUPPORTED_MIME_TYPES = new Set([
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

type FetchLike = typeof undiciFetch;
type PinnedDispatcher = { close(): Promise<void> | void };

type SourceDocumentErrorCode =
  | 'SOURCE_DOCUMENT_ACCESS_DENIED'
  | 'SOURCE_DOCUMENT_NOT_FOUND'
  | 'SOURCE_DOCUMENT_RATE_LIMITED'
  | 'SOURCE_DOCUMENT_TLS_ERROR'
  | 'SOURCE_DOCUMENT_TIMEOUT'
  | 'SOURCE_DOCUMENT_UNAVAILABLE';

export type DownloadedSourceDocument = {
  buffer: Buffer;
  finalUrl: string;
  filename: string;
  mimeType: string;
  size: number;
};

@Injectable()
export class TenderSourceDocumentDownloader {
  async download(urlText: string, fallbackFilename: string, signal?: AbortSignal): Promise<DownloadedSourceDocument> {
    const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    const signals = [timeout, signal].filter(Boolean) as AbortSignal[];
    const abortSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    let current: URL;
    try {
      current = parseHttpUrl(urlText);
    } catch (error) {
      throw this.mapDownloadError(error, timeout);
    }
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      let dispatcher: PinnedDispatcher | undefined;
      let response: Response | undefined;
      try {
        dispatcher = await this.createDispatcher(current, abortSignal);
        response = await this.fetch(current.toString(), {
          dispatcher,
          redirect: 'manual',
          signal: abortSignal,
          headers: {
            accept: 'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/markdown,application/json,image/*,*/*;q=0.5',
            'user-agent': 'IntlyTenderDocumentImporter/1.0',
          },
        } as unknown as Parameters<FetchLike>[1]) as unknown as Response;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await this.cancelBody(response);
          if (redirect === MAX_REDIRECTS) throw new BadRequestException('Source document redirect limit exceeded');
          const location = response.headers.get('location');
          if (!location) throw new BadRequestException('Source document redirect is missing Location');
          current = parseHttpUrl(new URL(location, current).toString());
          continue;
        }
        try {
          this.assertStatus(response.status);
        } catch (error) {
          await this.cancelBody(response);
          throw error;
        }
        const contentLength = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_DOCUMENT_BYTES) {
          await this.cancelBody(response);
          throw new PayloadTooLargeException('Source document is too large');
        }
        const contentDisposition = response.headers.get('content-disposition') ?? undefined;
        const contentType = response.headers.get('content-type') ?? undefined;
        const filename = this.filename(contentDisposition, current.pathname, fallbackFilename);
        const buffer = await this.readBoundedBody(response, abortSignal);
        const mimeType = this.detectMimeType(buffer, contentType, filename);
        this.assertSupportedPayload(buffer, mimeType, contentType, filename);
        return {
          buffer,
          finalUrl: current.toString(),
          filename: this.withExtension(filename, mimeType),
          mimeType,
          size: buffer.length,
        };
      } catch (error) {
        throw this.mapDownloadError(error, timeout);
      } finally {
        if (response && abortSignal.aborted) await this.cancelBody(response);
        await Promise.resolve(dispatcher?.close()).catch(() => undefined);
      }
    }
    throw new BadRequestException('Source document redirect limit exceeded');
  }

  protected async fetch(url: string, init: Parameters<FetchLike>[1]): Promise<Response> {
    return await undiciFetch(url, init) as unknown as Response;
  }

  protected async createDispatcher(url: URL, signal: AbortSignal): Promise<PinnedDispatcher> {
    return this.raceAbort(createPinnedDispatcher(url), signal);
  }

  private async raceAbort<T extends PinnedDispatcher>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw this.abortError(signal);
    return await new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (callback: () => void) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => {
        finish(() => reject(this.abortError(signal)));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then((dispatcher) => {
        if (signal.aborted) {
          void Promise.resolve(dispatcher.close()).catch(() => undefined);
          finish(() => reject(this.abortError(signal)));
          return;
        }
        finish(() => resolve(dispatcher));
      }).catch((error) => finish(() => reject(error)));
    });
  }

  private assertStatus(status: number): void {
    if (status === 403) throw this.safeException(HttpStatus.BAD_REQUEST, 'SOURCE_DOCUMENT_ACCESS_DENIED', 'Source document access denied');
    if (status === 404) throw this.safeException(HttpStatus.BAD_REQUEST, 'SOURCE_DOCUMENT_NOT_FOUND', 'Source document not found');
    if (status === 429) throw this.safeException(HttpStatus.BAD_REQUEST, 'SOURCE_DOCUMENT_RATE_LIMITED', 'Source document rate limited');
    if (status < 200 || status >= 300) throw new BadRequestException(`Source document returned HTTP ${status}`);
  }

  private async readBoundedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
    if (!response.body) throw new BadRequestException('Source document returned an empty body');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        if (signal.aborted) throw this.abortError(signal);
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_SOURCE_DOCUMENT_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new PayloadTooLargeException('Source document is too large');
        }
        chunks.push(chunk);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (total === 0) throw new BadRequestException('Source document returned an empty body');
    return Buffer.concat(chunks, total);
  }

  private async cancelBody(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }

  private mapDownloadError(error: unknown, timeoutSignal: AbortSignal): unknown {
    if (error instanceof HttpException) return error;
    if (this.isValidationError(error)) return new BadRequestException(error instanceof Error ? error.message : 'Source document URL is invalid');

    const flattened = this.flattenErrors(error);
    if (timeoutSignal.aborted || this.hasErrorName(flattened, 'TimeoutError') || this.hasErrorCode(flattened, [
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'ETIMEDOUT',
      'ERR_SOCKET_CONNECTION_TIMEOUT',
    ])) {
      return this.safeException(HttpStatus.GATEWAY_TIMEOUT, 'SOURCE_DOCUMENT_TIMEOUT', 'Source document download timed out');
    }

    if (this.hasErrorCode(flattened, [
      'SELF_SIGNED_CERT_IN_CHAIN',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ])) {
      return this.safeException(HttpStatus.BAD_GATEWAY, 'SOURCE_DOCUMENT_TLS_ERROR', 'Source document TLS validation failed');
    }

    if (this.hasErrorCode(flattened, [
      'UND_ERR_CONNECT',
      'UND_ERR_SOCKET',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ECONNABORTED',
      'EPIPE',
    ]) || this.isFetchFailed(error)) {
      return this.safeException(HttpStatus.BAD_GATEWAY, 'SOURCE_DOCUMENT_UNAVAILABLE', 'Source document host is unavailable');
    }

    return error;
  }

  private safeException(status: HttpStatus, code: SourceDocumentErrorCode, message: string): HttpException {
    return new HttpException({ code, message }, status);
  }

  private isValidationError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /Only http and https URLs are supported|URL host is required|URL credentials are not allowed|Localhost URLs are not allowed|Private, loopback and link-local URLs are not allowed|URL host .* is outside the source allowlist/.test(error.message);
  }

  private flattenErrors(error: unknown, seen: Set<unknown> = new Set<unknown>()): unknown[] {
    if (!error || seen.has(error)) return [];
    seen.add(error);
    const errors: unknown[] = [error];
    const candidate = error as { cause?: unknown; errors?: unknown[] };
    if (candidate.cause) errors.push(...this.flattenErrors(candidate.cause, seen));
    if (Array.isArray(candidate.errors)) {
      for (const nested of candidate.errors) errors.push(...this.flattenErrors(nested, seen));
    }
    return errors;
  }

  private hasErrorCode(errors: unknown[], codes: string[]): boolean {
    const wanted = new Set(codes);
    return errors.some((error) => wanted.has(String((error as { code?: unknown })?.code ?? '')));
  }

  private hasErrorName(errors: unknown[], name: string): boolean {
    return errors.some((error) => String((error as { name?: unknown })?.name ?? '') === name);
  }

  private isFetchFailed(error: unknown): boolean {
    return error instanceof TypeError && /fetch failed/i.test(error.message);
  }

  private detectMimeType(buffer: Buffer, contentType: string | undefined, filename: string): string {
    const header = contentType?.split(';', 1)[0]?.trim().toLowerCase();
    const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/i)?.[1];
    const byExtension = extension ? this.mimeFromExtension(extension) : undefined;
    const magic = this.mimeFromMagic(buffer);
    if (this.isGenericBinary(header) && magic === 'application/zip' && byExtension?.startsWith('application/vnd.openxmlformats-officedocument.') && this.isOfficeZip(buffer, byExtension)) return byExtension;
    if (header?.startsWith('application/vnd.openxmlformats-officedocument.')) return header;
    if (this.isGenericBinary(header) && byExtension && !magic) return byExtension;
    if (header && !this.isGenericBinary(header)) return header;
    if (magic) return magic;
    return byExtension ?? header ?? 'application/octet-stream';
  }

  private mimeFromMagic(buffer: Buffer): string | undefined {
    if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
    if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'application/zip';
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return undefined;
  }

  private mimeFromExtension(extension: string): string | undefined {
    return ({
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      txt: 'text/plain',
      csv: 'text/csv',
      tsv: 'text/tab-separated-values',
      md: 'text/markdown',
      json: 'application/json',
      ndjson: 'application/x-ndjson',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
    } as Record<string, string | undefined>)[extension];
  }

  private assertSupportedPayload(buffer: Buffer, mimeType: string, contentType: string | undefined, filename: string): void {
    const prefix = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').trimStart().toLowerCase();
    const header = contentType?.split(';', 1)[0]?.trim().toLowerCase();
    const magic = this.mimeFromMagic(buffer);
    if (mimeType.startsWith('text/html') || prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) {
      throw new UnsupportedMediaTypeException('Source URL returned HTML instead of a supported document');
    }
    if (this.binaryClaimMismatch(buffer, mimeType, header, magic)) {
      throw new UnsupportedMediaTypeException('Source document content does not match its declared file type');
    }
    if (mimeType.startsWith('application/vnd.openxmlformats-officedocument.') && !this.isOfficeZip(buffer, mimeType)) {
      throw new UnsupportedMediaTypeException('Office source document package is invalid or unsupported');
    }
    if (mimeType === 'application/zip') throw new UnsupportedMediaTypeException('Archive source documents are not supported for import');
    if (this.mimeFromMagic(buffer) === 'application/zip' && !mimeType.startsWith('application/vnd.openxmlformats-officedocument.')) {
      throw new UnsupportedMediaTypeException(`Unsupported source document archive ${filename}`);
    }
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) throw new UnsupportedMediaTypeException('Unsupported source document type');
  }

  private filename(contentDisposition: string | undefined, pathname: string, fallback: string): string {
    const dispositionFilename = this.dispositionFilename(contentDisposition);
    const decodedDisposition = dispositionFilename ? this.decodeRfc2047(dispositionFilename) : undefined;
    const raw = decodedDisposition ?? (dispositionFilename && !this.looksLikeRfc2047(dispositionFilename) ? dispositionFilename : undefined);
    const pathCandidate = this.safeDecode(pathname.split('/').filter(Boolean).pop() ?? '');
    const fromPath = pathCandidate && /\.[a-z0-9]{2,8}$/i.test(pathCandidate) ? pathCandidate : undefined;
    return this.cleanFilename(raw ?? fromPath ?? fallback);
  }

  private dispositionFilename(contentDisposition: string | undefined): string | undefined {
    const fromDisposition = contentDisposition?.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
    if (!fromDisposition) return undefined;
    return fromDisposition[1] ? this.safeDecode(fromDisposition[1]) : fromDisposition[2];
  }

  private looksLikeRfc2047(value: string): boolean {
    return /=\?[^?]+\?[bqBQ]\?[^?]*\?=/.test(value);
  }

  private decodeRfc2047(value: string): string | undefined {
    if (!this.looksLikeRfc2047(value)) return undefined;
    let failed = false;
    let matched = false;
    const decoded = value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, encoded: string) => {
      matched = true;
      const buffer = encoding.toUpperCase() === 'B' ? this.decodeRfc2047Base64(encoded) : this.decodeRfc2047QuotedPrintable(encoded);
      if (!buffer) {
        failed = true;
        return '';
      }
      const text = this.decodeRfc2047Bytes(buffer, charset);
      if (text === undefined) {
        failed = true;
        return '';
      }
      return text;
    });
    return matched && !failed ? decoded : undefined;
  }

  private decodeRfc2047Base64(value: string): Buffer | undefined {
    const compact = value.replace(/\s+/g, '');
    if (!compact || compact.length % 4 !== 0 || /[^a-z0-9+/=]/i.test(compact)) return undefined;
    return Buffer.from(compact, 'base64');
  }

  private decodeRfc2047QuotedPrintable(value: string): Buffer | undefined {
    const bytes: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === '_') {
        bytes.push(0x20);
        continue;
      }
      if (character === '=') {
        const hex = value.slice(index + 1, index + 3);
        if (!/^[0-9a-f]{2}$/i.test(hex)) return undefined;
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
      const code = character.charCodeAt(0);
      if (code > 0x7f) return undefined;
      bytes.push(code);
    }
    return Buffer.from(bytes);
  }

  private decodeRfc2047Bytes(buffer: Buffer, charset: string): string | undefined {
    const normalized = charset.trim().toLowerCase().replace(/^cp-?/, 'windows-');
    const label = ({
      utf8: 'utf-8',
      'utf-8': 'utf-8',
      'windows-1251': 'windows-1251',
      'windows1251': 'windows-1251',
    } as Record<string, string | undefined>)[normalized];
    if (!label) return undefined;
    try {
      return new TextDecoder(label, { fatal: true }).decode(buffer);
    } catch {
      return undefined;
    }
  }

  private withExtension(filename: string, mimeType: string): string {
    if (/\.[a-z0-9]{2,8}$/i.test(filename)) return filename;
    const extension = this.extensionForMime(mimeType);
    return extension ? `${filename}.${extension}` : filename;
  }

  private cleanFilename(input: string): string {
    const basename = input.split(/[\\/]/).filter(Boolean).pop() ?? input;
    return basename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'source-document';
  }

  private extensionForMime(mimeType: string): string | undefined {
    return ({
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'text/plain': 'txt',
      'text/csv': 'csv',
      'text/tab-separated-values': 'tsv',
      'text/markdown': 'md',
      'application/json': 'json',
      'application/x-ndjson': 'ndjson',
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
    } as Record<string, string | undefined>)[mimeType];
  }

  private isGenericBinary(mimeType?: string): boolean {
    return !mimeType || mimeType === 'application/octet-stream' || mimeType === 'binary/octet-stream';
  }

  private binaryClaimMismatch(buffer: Buffer, mimeType: string, header: string | undefined, magic: string | undefined): boolean {
    const claimed = header && !this.isGenericBinary(header) ? header : mimeType;
    if (claimed === 'application/pdf') return magic !== 'application/pdf';
    if (claimed === 'image/png') return magic !== 'image/png';
    if (claimed === 'image/jpeg') return magic !== 'image/jpeg';
    if (claimed === 'image/webp') return magic !== 'image/webp';
    if (claimed.startsWith('application/vnd.openxmlformats-officedocument.')) return magic === 'application/zip' && this.isOfficeZip(buffer, claimed) ? false : true;
    return false;
  }

  private isOfficeZip(buffer: Buffer, mimeType: string): boolean {
    if (this.mimeFromMagic(buffer) !== 'application/zip') return false;
    const marker = buffer.toString('latin1', 0, Math.min(buffer.length, 250_000));
    if (!marker.includes('[Content_Types].xml')) return false;
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return marker.includes('word/');
    if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return marker.includes('xl/');
    return false;
  }

  private safeDecode(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error('Source document download aborted');
  }
}
