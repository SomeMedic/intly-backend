import { inflateRawSync } from 'node:zlib';

import { ServiceUnavailableException } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';

const MAX_ZIP_ENTRIES = 500;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_XML_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_SPREADSHEET_ROWS = 10_000;
const MAX_SPREADSHEET_SHEETS = 100;

type ZipEntry = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
};

type WorkbookSheet = { name: string; path: string };
type WorkbookInfo = { sheets: WorkbookSheet[]; date1904: boolean };
type XlsxStyles = { dateStyleIndexes: Set<number> };
type ParsedCell = { ref: string; value: string; formula?: string };

const BUILT_IN_DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
});

export function parseDelimitedText(buffer: Buffer, mimeType: string): { text: string; structured: Record<string, unknown> } {
  const raw = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\u0000/g, '');
  const delimiter = mimeType === 'text/tab-separated-values' ? '\t' : detectDelimiter(raw);
  const rows = parseRows(raw, delimiter).filter((row) => row.some((cell) => cell.trim()));
  if (!rows.length) throw new ServiceUnavailableException('Delimited parser returned no rows');
  if (rows.length > MAX_SPREADSHEET_ROWS) throw new ServiceUnavailableException('Delimited document has too many rows for full extraction');
  const maxColumns = Math.max(...rows.map((row) => row.length));
  const headers = Array.from({ length: maxColumns }, (_, index) => rows[0][index]?.trim() || `Column ${index + 1}`);
  const lines = [`Delimited document (${delimiter === '\t' ? 'tab' : delimiter} separated)`, `Columns: ${headers.join(' | ')}`];
  for (const [rowIndex, row] of rows.slice(1).entries()) {
    lines.push(`Row ${rowIndex + 2}: ${headers.map((header, index) => `${header}: ${cleanCell(row[index] ?? '')}`).join(' | ')}`);
  }
  if (rows.length === 1) lines.push(`Row 1: ${headers.map((header) => `${header}:`).join(' | ')}`);
  const text = requireText(lines.join('\n'));
  return {
    text,
    structured: {
      documentKind: 'spreadsheet',
      format: delimiter === '\t' ? 'tsv' : 'csv',
      rowCount: rows.length,
      columns: headers,
    },
  };
}

export function parseXlsx(buffer: Buffer): { text: string; structured: Record<string, unknown> } {
  const archive = new SafeZipReader(buffer);
  const sharedStrings = parseSharedStrings(readOptionalXml(archive, 'xl/sharedStrings.xml'));
  const workbookInfo = parseWorkbookInfo(archive);
  const styles = parseStyles(readOptionalXml(archive, 'xl/styles.xml'));
  const sheets = workbookInfo.sheets;
  if (!sheets.length) throw new ServiceUnavailableException('XLSX workbook has no worksheets');
  if (sheets.length > MAX_SPREADSHEET_SHEETS) throw new ServiceUnavailableException('XLSX workbook has too many sheets for full extraction');
  const lines = ['XLSX workbook'];
  const structuredSheets: Array<{ name: string; rowCount: number }> = [];
  let totalRows = 0;
  for (const sheet of sheets) {
    const sheetXml = readXml(archive, sheet.path);
    const rows = parseSheetRows(sheetXml, sharedStrings, styles, workbookInfo.date1904);
    totalRows += rows.length;
    if (totalRows > MAX_SPREADSHEET_ROWS) throw new ServiceUnavailableException('XLSX workbook has too many rows for full extraction');
    structuredSheets.push({ name: sheet.name, rowCount: rows.length });
    lines.push(`Sheet: ${sheet.name}`);
    for (const row of rows) {
      const cells = row.cells.map((cell) => {
        if (cell.formula) {
          const cached = cell.value ? ` cached value "${cell.value}"` : ' no cached value';
          return `${cell.ref} formula ${cell.formula};${cached}`;
        }
        return `${cell.ref} "${cell.value}"`;
      });
      if (cells.length) lines.push(`Row ${row.number}: ${cells.join(' | ')}`);
    }
  }
  const text = requireText(lines.join('\n'));
  return {
    text,
    structured: {
      documentKind: 'spreadsheet',
      format: 'xlsx',
      sheets: structuredSheets,
    },
  };
}

class SafeZipReader {
  private readonly entries = new Map<string, ZipEntry>();
  private totalUncompressed = 0;
  private totalActualUncompressed = 0;

  constructor(private readonly buffer: Buffer) {
    this.readCentralDirectory();
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (!entry) throw new ServiceUnavailableException(`XLSX archive is missing ${name}`);
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new ServiceUnavailableException(`XLSX entry ${name} is too large`);
    if (entry.encrypted) throw new ServiceUnavailableException(`XLSX entry ${name} is encrypted and cannot be parsed`);
    if (entry.localHeaderOffset < 0 || entry.localHeaderOffset + 30 > this.buffer.length) throw new ServiceUnavailableException('XLSX archive local header is invalid');
    if (this.buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) throw new ServiceUnavailableException('XLSX archive local header signature is invalid');
    const localFlags = this.buffer.readUInt16LE(entry.localHeaderOffset + 6);
    const localMethod = this.buffer.readUInt16LE(entry.localHeaderOffset + 8);
    if ((localFlags & 0x1) !== 0 || localMethod !== entry.compressionMethod) throw new ServiceUnavailableException(`XLSX entry ${name} local header does not match central directory`);
    const nameLength = this.buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = this.buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const localName = this.safeEntryName(this.buffer.subarray(entry.localHeaderOffset + 30, entry.localHeaderOffset + 30 + nameLength).toString('utf8'));
    if (localName !== name) throw new ServiceUnavailableException(`XLSX entry ${name} local header name mismatch`);
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart < 0 || dataEnd > this.buffer.length) throw new ServiceUnavailableException('XLSX archive entry data is invalid');
    const compressed = this.buffer.subarray(dataStart, dataEnd);
    let output: Buffer;
    if (entry.compressionMethod === 0) output = Buffer.from(compressed);
    else if (entry.compressionMethod === 8) {
      try {
        output = inflateRawSync(compressed, { finishFlush: 4, maxOutputLength: MAX_ENTRY_BYTES });
      } catch (error) {
        throw new ServiceUnavailableException(error instanceof Error ? `XLSX entry ${name} decompression failed or exceeded limits: ${error.message}` : `XLSX entry ${name} decompression failed or exceeded limits`);
      }
    }
    else throw new ServiceUnavailableException(`XLSX compression method ${entry.compressionMethod} is not supported`);
    if (output.length > MAX_ENTRY_BYTES) throw new ServiceUnavailableException(`XLSX entry ${name} is too large`);
    if (output.length !== entry.uncompressedSize) throw new ServiceUnavailableException(`XLSX entry ${name} size mismatch`);
    this.totalActualUncompressed += output.length;
    if (this.totalActualUncompressed > MAX_TOTAL_BYTES) throw new ServiceUnavailableException('XLSX archive expands too large');
    return output;
  }

  private readCentralDirectory(): void {
    const eocd = this.findEndOfCentralDirectory();
    const entryCount = this.buffer.readUInt16LE(eocd + 10);
    const centralSize = this.buffer.readUInt32LE(eocd + 12);
    let offset = this.buffer.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || centralSize === 0xffffffff || offset === 0xffffffff) {
      throw new ServiceUnavailableException('XLSX ZIP64 archives are not supported');
    }
    if (entryCount > MAX_ZIP_ENTRIES) throw new ServiceUnavailableException('XLSX archive has too many entries');
    if (offset + centralSize > this.buffer.length) throw new ServiceUnavailableException('XLSX central directory is invalid');
    for (let index = 0; index < entryCount; index += 1) {
      if (this.buffer.readUInt32LE(offset) !== 0x02014b50) throw new ServiceUnavailableException('XLSX central directory signature is invalid');
      const flags = this.buffer.readUInt16LE(offset + 8);
      const compressionMethod = this.buffer.readUInt16LE(offset + 10);
      const compressedSize = this.buffer.readUInt32LE(offset + 20);
      const uncompressedSize = this.buffer.readUInt32LE(offset + 24);
      const nameLength = this.buffer.readUInt16LE(offset + 28);
      const extraLength = this.buffer.readUInt16LE(offset + 30);
      const commentLength = this.buffer.readUInt16LE(offset + 32);
      const localHeaderOffset = this.buffer.readUInt32LE(offset + 42);
      const name = this.safeEntryName(this.buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
      if (this.entries.has(name)) throw new ServiceUnavailableException(`XLSX archive contains duplicate entry ${name}`);
      if ((flags & 0x1) !== 0) throw new ServiceUnavailableException(`XLSX entry ${name} is encrypted and cannot be parsed`);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new ServiceUnavailableException('XLSX ZIP64 entries are not supported');
      }
      this.totalUncompressed += uncompressedSize;
      if (this.totalUncompressed > MAX_TOTAL_BYTES) throw new ServiceUnavailableException('XLSX archive expands too large');
      this.entries.set(name, { name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset, encrypted: (flags & 0x1) !== 0 });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  private findEndOfCentralDirectory(): number {
    const min = Math.max(0, this.buffer.length - 65_557);
    for (let offset = this.buffer.length - 22; offset >= min; offset -= 1) {
      if (this.buffer.readUInt32LE(offset) === 0x06054b50) return offset;
    }
    throw new ServiceUnavailableException('XLSX end of central directory was not found');
  }

  private safeEntryName(name: string): string {
    const normalized = name.replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized.includes('/..')) {
      throw new ServiceUnavailableException('XLSX archive contains an unsafe entry name');
    }
    return normalized;
  }
}

function readXml(archive: SafeZipReader, name: string): unknown {
  const content = archive.read(name);
  if (content.length > MAX_XML_BYTES) throw new ServiceUnavailableException(`XLSX XML entry ${name} is too large`);
  const xml = content.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ServiceUnavailableException(`XLSX XML entry ${name} contains forbidden entity declarations`);
  return xmlParser.parse(xml);
}

function readOptionalXml(archive: SafeZipReader, name: string): unknown | undefined {
  return archive.has(name) ? readXml(archive, name) : undefined;
}

function parseSharedStrings(xml: unknown): string[] {
  const shared = record(xml)?.sst;
  return array(record(shared)?.si).map((item) => textFromSharedString(item));
}

function parseWorkbookInfo(archive: SafeZipReader): WorkbookInfo {
  const workbook = record(readXml(archive, 'xl/workbook.xml'))?.workbook;
  const workbookPr = record(record(workbook)?.workbookPr);
  const date1904 = ['1', 'true', 'TRUE'].includes(stringValue(workbookPr?.['@_date1904']));
  const sheets = array(record(record(workbook)?.sheets)?.sheet);
  const relationships = parseWorkbookRelationships(readOptionalXml(archive, 'xl/_rels/workbook.xml.rels'));
  return { date1904, sheets: sheets.map((sheet, index) => {
    const item = record(sheet) ?? {};
    const name = stringValue(item['@_name']) || `Sheet ${index + 1}`;
    const relationshipId = stringValue(item['@_r:id']);
    const target = relationshipId ? relationships.get(relationshipId) : undefined;
    return { name, path: normalizeWorkbookTarget(target ?? `worksheets/sheet${index + 1}.xml`) };
  }) };
}

function parseStyles(xml: unknown): XlsxStyles {
  const styles = record(xml)?.styleSheet;
  const customFormats = new Map<number, string>();
  for (const format of array(record(record(styles)?.numFmts)?.numFmt)) {
    const item = record(format) ?? {};
    const id = Number.parseInt(stringValue(item['@_numFmtId']), 10);
    const code = stringValue(item['@_formatCode']);
    if (Number.isFinite(id) && code) customFormats.set(id, code);
  }
  const dateStyleIndexes = new Set<number>();
  for (const [index, style] of array(record(record(styles)?.cellXfs)?.xf).entries()) {
    const item = record(style) ?? {};
    const numFmtId = Number.parseInt(stringValue(item['@_numFmtId']), 10);
    if (BUILT_IN_DATE_FORMAT_IDS.has(numFmtId) || looksLikeDateFormat(customFormats.get(numFmtId) ?? '')) dateStyleIndexes.add(index);
  }
  return { dateStyleIndexes };
}

function parseWorkbookRelationships(xml: unknown): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const relationship of array(record(record(xml)?.Relationships)?.Relationship)) {
    const item = record(relationship) ?? {};
    const id = stringValue(item['@_Id']);
    const target = stringValue(item['@_Target']);
    if (id && target) relationships.set(id, target);
  }
  return relationships;
}

function normalizeWorkbookTarget(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized.startsWith('xl/') ? normalized : `xl/${normalized}`;
}

function parseSheetRows(xml: unknown, sharedStrings: string[], styles: XlsxStyles, date1904: boolean): Array<{ number: string; cells: ParsedCell[] }> {
  const rows = array(record(record(record(xml)?.worksheet)?.sheetData)?.row);
  return rows.map((row, rowIndex) => {
    const rowRecord = record(row) ?? {};
    const cells = array(rowRecord.c).map((cell, cellIndex) => parseCell(cell, sharedStrings, styles, date1904, rowIndex + 1, cellIndex + 1)).filter((cell) => cell.value || cell.formula);
    return { number: stringValue(rowRecord['@_r']) || String(rowIndex + 1), cells };
  }).filter((row) => row.cells.length);
}

function parseCell(cell: unknown, sharedStrings: string[], styles: XlsxStyles, date1904: boolean, rowIndex: number, cellIndex: number): ParsedCell {
  const item = record(cell) ?? {};
  const ref = stringValue(item['@_r']) || `${columnName(cellIndex)}${rowIndex}`;
  const type = stringValue(item['@_t']);
  const formula = textValue(item.f);
  const rawValue = textValue(item.v);
  const styleIndex = Number.parseInt(stringValue(item['@_s']), 10);
  let value = rawValue;
  if (type === 's') value = sharedStrings[Number.parseInt(rawValue, 10)] ?? rawValue;
  else if (type === 'inlineStr') value = textFromSharedString(item.is);
  else if (type === 'b') value = rawValue === '1' ? 'TRUE' : rawValue === '0' ? 'FALSE' : rawValue;
  else if (!type && styles.dateStyleIndexes.has(styleIndex) && rawValue) value = excelDateText(rawValue, date1904);
  return { ref, value: cleanCell(value), ...(formula ? { formula: cleanCell(formula) } : {}) };
}

function parseRows(raw: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function detectDelimiter(raw: string): string {
  const sample = raw.split(/\r?\n/).slice(0, 10).join('\n');
  const candidates = [',', ';', '\t'];
  return candidates.sort((left, right) => count(sample, right) - count(sample, left))[0];
}

function textFromSharedString(value: unknown): string {
  const item = record(value);
  if (!item) return textValue(value);
  const direct = textValue(item.t);
  if (direct) return direct;
  return array(item.r).map((run) => textValue(record(run)?.t)).join('');
}

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  const item = record(value);
  if (!item) return '';
  return stringValue(item['#text']) || stringValue(item.t) || '';
}

function cleanCell(value: string): string {
  return value.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function requireText(text: string): string {
  const normalized = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) throw new ServiceUnavailableException('Spreadsheet parser returned no text');
  if (normalized.length > MAX_TEXT_LENGTH) throw new ServiceUnavailableException('Spreadsheet extraction is too large for full text indexing');
  return normalized;
}

function columnName(index: number): string {
  let value = '';
  for (let current = index; current > 0; current = Math.floor((current - 1) / 26)) {
    value = String.fromCharCode(65 + ((current - 1) % 26)) + value;
  }
  return value;
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function looksLikeDateFormat(formatCode: string): boolean {
  const cleaned = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*]/g, '')
    .toLowerCase();
  return /[ymdhs]/.test(cleaned) && (/[dy]/.test(cleaned) || /h|s/.test(cleaned));
}

function excelDateText(rawValue: string, date1904: boolean): string {
  const serial = Number(rawValue);
  if (!Number.isFinite(serial) || serial < 0) return rawValue;
  const wholeDays = Math.floor(serial);
  const fraction = serial - wholeDays;
  const days = date1904 ? wholeDays : wholeDays - (wholeDays >= 60 ? 1 : 0);
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const milliseconds = base + days * 86_400_000 + Math.round(fraction * 86_400_000);
  const date = new Date(milliseconds);
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const hasTime = fraction > 0;
  return hasTime ? `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} (Excel serial ${rawValue})` : `${yyyy}-${mm}-${dd} (Excel serial ${rawValue})`;
}
