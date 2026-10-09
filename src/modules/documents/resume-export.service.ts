import { Injectable } from '@nestjs/common';

import { renderUnicodePdf } from './unicode-pdf';

export const RESUME_EXPORT_FORMATS = ['txt', 'pdf', 'docx'] as const;
export type ResumeExportFormat = (typeof RESUME_EXPORT_FORMATS)[number];

export type ResumeExportInput = {
  title?: string;
  documentJson?: Record<string, unknown>;
  markdownCache?: string;
  format: ResumeExportFormat;
};

export type ResumeExportArtifact = {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  text: string;
};

@Injectable()
export class ResumeExportService {
  createArtifact(input: ResumeExportInput): ResumeExportArtifact {
    const title = this.cleanTitle(input.title);
    const text = this.serialize(input);
    if (input.format === 'pdf') {
      return {
        filename: `${this.safeFilename(title)}.pdf`,
        mimeType: 'application/pdf',
        buffer: renderUnicodePdf(title, text),
        text,
      };
    }
    if (input.format === 'docx') {
      return {
        filename: `${this.safeFilename(title)}.docx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: this.createDocx(title, text),
        text,
      };
    }
    return {
      filename: `${this.safeFilename(title)}.txt`,
      mimeType: 'text/plain; charset=utf-8',
      buffer: Buffer.from(text, 'utf8'),
      text,
    };
  }

  serialize(input: Omit<ResumeExportInput, 'format'>): string {
    const markdown = input.markdownCache?.trim();
    if (markdown) return markdown;
    const document = input.documentJson ?? {};
    const lines = [this.cleanTitle(input.title)];
    this.appendText(lines, 'Headline', document.headline);
    this.appendText(lines, 'Summary', document.summary);
    this.appendList(lines, 'Skills', document.skills);
    this.appendList(lines, 'Experience', document.experience);
    this.appendList(lines, 'Projects', document.projects);
    this.appendList(lines, 'Education', document.education);
    this.appendList(lines, 'Languages', document.languages);
    this.appendList(lines, 'Links', document.links);
    for (const [key, value] of Object.entries(document)) {
      if (['headline', 'summary', 'skills', 'experience', 'projects', 'education', 'languages', 'links'].includes(key)) continue;
      if (value === undefined || value === null || value === '') continue;
      this.appendText(lines, this.label(key), value);
    }
    return lines.filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private appendText(lines: string[], label: string, value: unknown): void {
    const text = this.valueToText(value);
    if (!text) return;
    lines.push('', label, text);
  }

  private appendList(lines: string[], label: string, value: unknown): void {
    const items = Array.isArray(value) ? value.map((item) => this.valueToText(item)).filter(Boolean) : [];
    if (!items.length) return;
    lines.push('', label, ...items.map((item) => `- ${item}`));
  }

  private valueToText(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map((item) => this.valueToText(item)).filter(Boolean).join(', ');
    if (typeof value === 'object' && value !== null) return JSON.stringify(value, null, 2);
    return '';
  }

  private cleanTitle(value?: string): string {
    return value?.trim() || 'Resume';
  }

  private safeFilename(value: string): string {
    return value.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'resume';
  }

  private label(value: string): string {
    return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private createDocx(title: string, text: string): Buffer {
    const paragraphs = [title, ...text.split(/\r?\n/)].map((line) => `<w:p><w:r><w:t xml:space="preserve">${this.escapeXml(line)}</w:t></w:r></w:p>`).join('');
    return this.createZip([
      {
        name: '[Content_Types].xml',
        content: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8'),
      },
      {
        name: '_rels/.rels',
        content: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8'),
      },
      {
        name: 'word/document.xml',
        content: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`, 'utf8'),
      },
    ]);
  }

  private createZip(entries: Array<{ name: string; content: Buffer }>): Buffer {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const crc = this.crc32(entry.content);
      const localHeader = Buffer.alloc(30 + name.length);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6);
      localHeader.writeUInt16LE(0, 8);
      localHeader.writeUInt16LE(0, 10);
      localHeader.writeUInt16LE(0, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(entry.content.length, 18);
      localHeader.writeUInt32LE(entry.content.length, 22);
      localHeader.writeUInt16LE(name.length, 26);
      name.copy(localHeader, 30);
      localParts.push(localHeader, entry.content);

      const centralHeader = Buffer.alloc(46 + name.length);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0x0800, 8);
      centralHeader.writeUInt16LE(0, 10);
      centralHeader.writeUInt16LE(0, 12);
      centralHeader.writeUInt16LE(0, 14);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(entry.content.length, 20);
      centralHeader.writeUInt32LE(entry.content.length, 24);
      centralHeader.writeUInt16LE(name.length, 28);
      centralHeader.writeUInt32LE(offset, 42);
      name.copy(centralHeader, 46);
      centralParts.push(centralHeader);
      offset += localHeader.length + entry.content.length;
    }
    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, ...centralParts, end]);
  }

  private crc32(buffer: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  private escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
}
