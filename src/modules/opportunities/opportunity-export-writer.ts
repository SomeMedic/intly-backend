import { createWriteStream, type WriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export type OpportunityExportFormat = 'csv' | 'json' | 'xlsx';
export type OpportunityExportWriteResult = { count: number; size: number };

const XLSX_MAX_ROWS = 1_048_576;
const XLSX_MAX_COLUMNS = 16_384;
const ZIP_UINT32_MAX = 0xffffffff;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;

export async function writeOpportunityExport(
  path: string,
  format: OpportunityExportFormat,
  rows: AsyncIterable<Record<string, unknown>>,
  headers: string[],
): Promise<OpportunityExportWriteResult> {
  validateHeaders(headers);
  if (format === 'csv') return writeCsv(path, rows, headers);
  if (format === 'json') return writeJson(path, rows, headers);
  if (format === 'xlsx') return writeXlsx(path, rows, headers);
  throw new Error(`Unsupported opportunity export format: ${String(format)}`);
}

async function writeCsv(path: string, rows: AsyncIterable<Record<string, unknown>>, headers: string[]): Promise<OpportunityExportWriteResult> {
  const writer = new BoundedFileWriter(path);
  let count = 0;
  try {
    await writer.write('\uFEFF');
    await writer.write(csvRow(headers));
    for await (const row of rows) {
      await writer.write('\n');
      await writer.write(csvRow(headers.map((header) => row[header])));
      count += 1;
    }
    await writer.end();
    return { count, size: writer.size };
  } catch (error) {
    await writer.abort(error);
    throw error;
  }
}

async function writeJson(path: string, rows: AsyncIterable<Record<string, unknown>>, headers: string[]): Promise<OpportunityExportWriteResult> {
  const writer = new BoundedFileWriter(path);
  let count = 0;
  try {
    await writer.write('{"items":[');
    for await (const row of rows) {
      await writer.write(count === 0 ? '\n' : ',\n');
      await writer.write(JSON.stringify(orderedJsonRow(row, headers)));
      count += 1;
    }
    await writer.write(count === 0 ? ']}' : '\n]}');
    await writer.end();
    return { count, size: writer.size };
  } catch (error) {
    await writer.abort(error);
    throw error;
  }
}

async function writeXlsx(path: string, rows: AsyncIterable<Record<string, unknown>>, headers: string[]): Promise<OpportunityExportWriteResult> {
  if (headers.length > XLSX_MAX_COLUMNS) {
    throw new Error(`XLSX column limit exceeded: ${headers.length} > ${XLSX_MAX_COLUMNS}`);
  }

  const writer = new BoundedFileWriter(path);
  const zip = new ZipWriter(writer);
  let count = 0;
  try {
    await zip.addEntry('[Content_Types].xml', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
      '</Types>',
    ]);
    await zip.addEntry('_rels/.rels', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
      '</Relationships>',
    ]);
    await zip.addEntry('xl/workbook.xml', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      '<sheets><sheet name="Opportunities" sheetId="1" r:id="rId1"/></sheets>',
      '</workbook>',
    ]);
    await zip.addEntry('xl/_rels/workbook.xml.rels', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
      '</Relationships>',
    ]);
    await zip.addEntry('xl/styles.xml', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>',
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>',
      '<borders count="1"><border/></borders>',
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs>',
      '</styleSheet>',
    ]);

    await zip.addStreamingEntry('xl/worksheets/sheet1.xml', async (entry) => {
      await entry.write('<?xml version="1.0" encoding="UTF-8"?>');
      await entry.write('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
      await entry.write(xlsxRow(1, headers));
      for await (const row of rows) {
        count += 1;
        const sheetRow = count + 1;
        if (sheetRow > XLSX_MAX_ROWS) {
          throw new Error(`XLSX row limit exceeded: ${sheetRow} > ${XLSX_MAX_ROWS}`);
        }
        await entry.write(xlsxRow(sheetRow, headers.map((header) => row[header])));
      }
      await entry.write('</sheetData></worksheet>');
    });

    await zip.finish();
    await writer.end();
    return { count, size: writer.size };
  } catch (error) {
    await writer.abort(error);
    throw error;
  }
}

function validateHeaders(headers: string[]): void {
  if (!headers.length) throw new Error('Opportunity export requires at least one header');
  const seen = new Set<string>();
  for (const header of headers) {
    if (typeof header !== 'string' || header.length === 0) throw new Error('Opportunity export headers must be non-empty strings');
    if (seen.has(header)) throw new Error(`Duplicate opportunity export header: ${header}`);
    seen.add(header);
  }
}

function orderedJsonRow(row: Record<string, unknown>, headers: string[]): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const header of headers) ordered[header] = jsonCompatible(row[header]);
  return ordered;
}

function jsonCompatible(value: unknown): unknown {
  if (value === undefined) return '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonCompatible);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, jsonCompatible(nested)]));
  }
  return value;
}

function csvRow(values: unknown[]): string {
  return values.map((value) => `"${cellText(value).replace(/"/g, '""')}"`).join(',');
}

function xlsxRow(rowIndex: number, values: unknown[]): string {
  return `<row r="${rowIndex}">${values.map((value, columnIndex) => {
    const cell = `${xlsxColumnName(columnIndex)}${rowIndex}`;
    return `<c r="${cell}" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlEscape(cellText(value))}</t></is></c>`;
  }).join('')}</row>`;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(jsonCompatible(value)) ?? '';
}

function xlsxColumnName(index: number): string {
  if (index >= XLSX_MAX_COLUMNS) throw new Error(`XLSX column limit exceeded: ${index + 1} > ${XLSX_MAX_COLUMNS}`);
  let name = '';
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;');
}

class BoundedFileWriter {
  private readonly stream: WriteStream;
  private streamError: Error | null = null;
  private closed = false;
  size = 0;

  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: 'w' });
    this.stream.on('error', (error) => {
      this.streamError = error;
    });
  }

  async write(chunk: string | Buffer): Promise<void> {
    if (this.streamError) throw this.streamError;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    await new Promise<void>((resolve, reject) => {
      this.stream.write(buffer, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (this.streamError) throw this.streamError;
    this.size += buffer.length;
  }

  async end(): Promise<void> {
    if (this.streamError) throw this.streamError;
    await new Promise<void>((resolve, reject) => {
      this.stream.end((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (this.streamError) throw this.streamError;
    this.closed = true;
    const file = await stat(this.stream.path);
    this.size = file.size;
  }

  async abort(error: unknown): Promise<void> {
    if (this.closed || this.stream.destroyed) return;
    await new Promise<void>((resolve) => {
      this.stream.once('close', resolve);
      this.stream.destroy(error instanceof Error ? error : undefined);
    });
    this.closed = true;
  }
}

type ZipCentralEntry = {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
};

class ZipWriter {
  private readonly central: ZipCentralEntry[] = [];

  constructor(private readonly writer: BoundedFileWriter) {}

  async addEntry(name: string, chunks: Array<string | Buffer>): Promise<void> {
    await this.addStreamingEntry(name, async (entry) => {
      for (const chunk of chunks) await entry.write(chunk);
    });
  }

  async addStreamingEntry(name: string, produce: (entry: ZipEntryWriter) => Promise<void>): Promise<void> {
    if (this.central.length >= ZIP_UINT16_MAX) throw new Error(`ZIP entry limit exceeded: ${ZIP_UINT16_MAX}`);
    const nameBuffer = Buffer.from(name, 'utf8');
    if (nameBuffer.length > ZIP_UINT16_MAX) throw new Error(`ZIP entry name is too long: ${name}`);
    const offset = this.writer.size;
    assertZipUint32(offset, `ZIP offset for ${name}`);
    await this.writer.write(localHeader(nameBuffer));
    await this.writer.write(nameBuffer);

    const entry = new ZipEntryWriter(this.writer);
    await produce(entry);
    const finished = entry.finish();
    await this.writer.write(dataDescriptor(finished.crc, finished.size));
    this.central.push({ name: nameBuffer, crc: finished.crc, size: finished.size, offset });
  }

  async finish(): Promise<void> {
    const centralStart = this.writer.size;
    assertZipUint32(centralStart, 'ZIP central directory offset');
    for (const entry of this.central) {
      await this.writer.write(centralHeader(entry));
      await this.writer.write(entry.name);
    }
    const centralSize = this.writer.size - centralStart;
    assertZipUint32(centralSize, 'ZIP central directory size');
    await this.writer.write(endOfCentralDirectory(this.central.length, centralSize, centralStart));
  }
}

class ZipEntryWriter {
  private crc = 0;
  private bytes = 0;
  private closed = false;

  constructor(private readonly writer: BoundedFileWriter) {}

  async write(chunk: string | Buffer): Promise<void> {
    if (this.closed) throw new Error('Cannot write to a closed ZIP entry');
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.bytes += buffer.length;
    assertZipUint32(this.bytes, 'ZIP entry size');
    this.crc = crc32(buffer, this.crc);
    await this.writer.write(buffer);
  }

  finish(): { crc: number; size: number } {
    this.closed = true;
    return { crc: this.crc >>> 0, size: this.bytes };
  }
}

function localHeader(name: Buffer): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG | ZIP_DATA_DESCRIPTOR_FLAG, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(0, 10);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function dataDescriptor(crc: number, size: number): Buffer {
  assertZipUint32(size, 'ZIP data descriptor size');
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc >>> 0, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralHeader(entry: ZipCentralEntry): Buffer {
  assertZipUint32(entry.offset, 'ZIP central entry offset');
  assertZipUint32(entry.size, 'ZIP central entry size');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG | ZIP_DATA_DESCRIPTOR_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function endOfCentralDirectory(entryCount: number, centralSize: number, centralStart: number): Buffer {
  if (entryCount > ZIP_UINT16_MAX) throw new Error(`ZIP entry limit exceeded: ${entryCount} > ${ZIP_UINT16_MAX}`);
  assertZipUint32(centralSize, 'ZIP central directory size');
  assertZipUint32(centralStart, 'ZIP central directory offset');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

function assertZipUint32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP_UINT32_MAX) {
    throw new Error(`${label} exceeds ZIP32 limit`);
  }
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(buffer: Buffer, previous = 0): number {
  let crc = previous ^ 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
