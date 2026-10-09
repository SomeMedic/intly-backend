import { Injectable, ServiceUnavailableException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { parseDelimitedText, parseXlsx } from './spreadsheet-document-parser';

@Injectable()
export class DocumentParserService {
  constructor(private readonly config: ConfigService) {}

  async parse(buffer: Buffer, mimeType: string): Promise<{ text: string; structured: Record<string, unknown> }> {
    if (mimeType === 'text/plain' || mimeType === 'text/markdown' || mimeType === 'application/json') {
      const text = buffer.toString('utf8').replace(/\u0000/g, '').trim();
      return { text, structured: this.extractLightweightResumeFacts(text) };
    }
    if (mimeType === 'text/csv' || mimeType === 'text/tab-separated-values') {
      const parsed = parseDelimitedText(buffer, mimeType);
      return { text: parsed.text, structured: { ...this.extractLightweightResumeFacts(parsed.text), ...parsed.structured } };
    }
    if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      const parsed = parseXlsx(buffer);
      return { text: parsed.text, structured: { ...this.extractLightweightResumeFacts(parsed.text), ...parsed.structured } };
    }
    if (mimeType === 'application/pdf') {
      const text = await this.extractPdfText(buffer);
      return { text, structured: this.extractLightweightResumeFacts(text) };
    }
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const text = await this.extractDocxText(buffer);
      return { text, structured: this.extractLightweightResumeFacts(text) };
    }
    if (mimeType.startsWith('image/')) {
      const text = await this.extractImageText(buffer);
      return { text, structured: this.extractLightweightResumeFacts(text) };
    }
    throw new UnsupportedMediaTypeException('Unsupported document type');
  }

  private async extractPdfText(buffer: Buffer): Promise<string> {
    let parser: { getText: () => Promise<{ text: string }>; destroy: () => Promise<void> } | undefined;
    try {
      const { PDFParse } = await import('pdf-parse');
      parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      return this.requireText(result.text, 'PDF parser returned no text');
    } catch (error) {
      throw this.parserError(error, 'PDF parser is unavailable');
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
  }

  private async extractDocxText(buffer: Buffer): Promise<string> {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return this.requireText(result.value, 'DOCX parser returned no text');
    } catch (error) {
      throw this.parserError(error, 'DOCX parser is unavailable');
    }
  }

  private async extractImageText(buffer: Buffer): Promise<string> {
    const workerPath = this.config.get<string>('TESSERACT_WORKER_PATH');
    const corePath = this.config.get<string>('TESSERACT_CORE_PATH');
    const langPath = this.config.get<string>('TESSERACT_LANG_PATH');
    const cachePath = this.config.get<string>('TESSERACT_CACHE_PATH') ?? '/tmp/tesseract-cache';
    const cacheMethod = this.config.get<string>('TESSERACT_CACHE_METHOD') ?? 'write';
    try {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker(['eng', 'rus'], 1, {
        ...(workerPath ? { workerPath } : {}),
        ...(corePath ? { corePath } : {}),
        ...(langPath ? { langPath } : {}),
        cachePath,
        cacheMethod,
        gzip: this.config.get<string>('TESSERACT_GZIP') !== 'false',
      });
      try {
        const result = await worker.recognize(buffer);
        return this.requireText(result.data.text, 'OCR returned no text');
      } finally {
        await worker.terminate();
      }
    } catch (error) {
      throw this.parserError(error, 'Local OCR is unavailable');
    }
  }

  private requireText(text: string, message: string): string {
    const normalized = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized) throw new ServiceUnavailableException(message);
    return normalized.slice(0, 1_000_000);
  }

  private parserError(error: unknown, fallback: string): ServiceUnavailableException {
    const message = error instanceof Error && error.message ? `${fallback}: ${error.message}` : fallback;
    return new ServiceUnavailableException(message);
  }

  private extractLightweightResumeFacts(text: string): Record<string, unknown> {
    const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const technologies = Array.from(new Set((text.match(/\b(TypeScript|JavaScript|Python|React|Next\.js|NestJS|Node\.js|MongoDB|PostgreSQL|Docker|Kubernetes|LLM|AI)\b/gi) ?? []).map((item) => item.trim())));
    return { ...(email ? { email } : {}), technologies };
  }
}
