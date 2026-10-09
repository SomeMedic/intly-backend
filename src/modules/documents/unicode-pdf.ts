import { existsSync, readFileSync } from 'node:fs';

const FONT_CANDIDATES = [
  process.env.INTLY_PDF_FONT_PATH,
  '/System/Library/Fonts/SFNS.ttf',
  '/System/Library/Fonts/SFCompact.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
].filter((value): value is string => !!value);

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_X = 50;
const TOP_Y = 790;
const BOTTOM_Y = 50;
const BODY_FONT_SIZE = 10;
const TITLE_FONT_SIZE = 16;
const BODY_LINE_HEIGHT = 14;
const TITLE_LINE_HEIGHT = 20;
const MAX_TEXT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

type FontTable = { offset: number; length: number };
type FontMetrics = {
  data: Buffer;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  cmap: Map<number, number>;
  glyphWidths: number[];
  fallbackWidth: number;
};
export type UnicodePdfRun = { text: string; bold?: boolean; italic?: boolean; link?: boolean };
export type UnicodePdfBlock = {
  type?: 'paragraph' | 'heading' | 'listItem';
  level?: number;
  indent?: number;
  marker?: string;
  runs: UnicodePdfRun[];
};
type Line = { text?: string; runs?: UnicodePdfRun[]; size: number; lineHeight: number; indent?: number; keepWithNext?: boolean };
type CidEncoding = {
  codeToCid: Map<number, number>;
  cidToCode: Map<number, number>;
};

export function renderUnicodePdf(title: string, text: string): Buffer {
  const requiredGlyphs = collectRequiredGlyphCodePoints(`${title}\n${text}`);
  const font = loadUnicodeFont(requiredGlyphs);
  const lines: Line[] = [
    ...wrapText(font, title, TITLE_FONT_SIZE, TITLE_LINE_HEIGHT),
    { text: '', size: BODY_FONT_SIZE, lineHeight: BODY_LINE_HEIGHT },
    ...wrapText(font, text, BODY_FONT_SIZE, BODY_LINE_HEIGHT),
  ];
  return renderPdfLines(font, lines);
}

export function renderRichUnicodePdf(title: string, blocks: UnicodePdfBlock[]): Buffer {
  const requiredGlyphs = collectRequiredGlyphCodePoints(`${title}\n${blocks.flatMap((block) => [block.marker ?? '', ...block.runs.map((run) => run.text)]).join('\n')}`);
  const font = loadUnicodeFont(requiredGlyphs);
  const lines: Line[] = [
    ...wrapText(font, title, TITLE_FONT_SIZE, TITLE_LINE_HEIGHT),
    { text: '', size: BODY_FONT_SIZE, lineHeight: BODY_LINE_HEIGHT },
    ...blocks.flatMap((block) => wrapBlock(font, block)),
  ];
  return renderPdfLines(font, lines);
}

function renderPdfLines(font: FontMetrics, lines: Line[]): Buffer {
  const pages = paginate(lines);
  const usedCodePoints = collectUsedCodePoints(lines);
  const cidEncoding = createCidEncoding(usedCodePoints);
  const fontObjectId = 3;
  const cidFontObjectId = 4;
  const descriptorObjectId = 5;
  const fontFileObjectId = 6;
  const toUnicodeObjectId = 7;
  const cidToGidObjectId = 8;
  const firstPageObjectId = 9;
  const pageIds = pages.map((_, index) => firstPageObjectId + index * 2);
  const contentIds = pages.map((_, index) => firstPageObjectId + index * 2 + 1);
  const objects: Array<Buffer | string> = [];

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[fontObjectId - 1] = `<< /Type /Font /Subtype /Type0 /BaseFont /IntlyUnicode /Encoding /Identity-H /DescendantFonts [${cidFontObjectId} 0 R] /ToUnicode ${toUnicodeObjectId} 0 R >>`;
  objects[cidFontObjectId - 1] = [
    '<< /Type /Font',
    '/Subtype /CIDFontType2',
    '/BaseFont /IntlyUnicode',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>',
    `/FontDescriptor ${descriptorObjectId} 0 R`,
    `/CIDToGIDMap ${cidToGidObjectId} 0 R`,
    `/DW ${Math.round(font.fallbackWidth)}`,
    `/W ${createWidthsArray(font, cidEncoding)}`,
    '>>',
  ].join(' ');
  objects[descriptorObjectId - 1] = [
    '<< /Type /FontDescriptor',
    '/FontName /IntlyUnicode',
    '/Flags 4',
    `/FontBBox [${font.bbox.map((value) => Math.round(value)).join(' ')}]`,
    '/ItalicAngle 0',
    `/Ascent ${Math.round(font.ascent)}`,
    `/Descent ${Math.round(font.descent)}`,
    `/CapHeight ${Math.round(font.capHeight)}`,
    '/StemV 80',
    `/FontFile2 ${fontFileObjectId} 0 R`,
    '>>',
  ].join(' ');
  objects[fontFileObjectId - 1] = streamObject(font.data);
  objects[toUnicodeObjectId - 1] = streamObject(Buffer.from(createToUnicodeMap(cidEncoding), 'utf8'));
  objects[cidToGidObjectId - 1] = streamObject(createCidToGidMap(font, cidEncoding));

  pages.forEach((pageLines, index) => {
    const pageObjectId = pageIds[index];
    const contentObjectId = contentIds[index];
    objects[pageObjectId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
    objects[contentObjectId - 1] = streamObject(Buffer.from(createPageStream(font, pageLines, cidEncoding), 'utf8'));
  });

  return buildPdf(objects);
}

function loadUnicodeFont(requiredGlyphs: number[]): FontMetrics {
  const errors: string[] = [];
  for (const path of FONT_CANDIDATES) {
    if (!existsSync(path)) continue;
    try {
      const font = parseTrueTypeFont(readFileSync(path));
      const missing = requiredGlyphs.filter((code) => !font.cmap.get(code));
      if (!missing.length) return font;
      errors.push(`${path} missing ${missing.map((code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`).join(',')}`);
    } catch (error) {
      errors.push(`${path} invalid TrueType font: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Unicode PDF font with required RU/EN/₽ coverage not found. Set INTLY_PDF_FONT_PATH to a compatible TTF font. ${errors.join('; ')}`);
}

function parseTrueTypeFont(data: Buffer): FontMetrics {
  if (data.length < 12 || ![0x00010000, 0x74727565].includes(data.readUInt32BE(0))) {
    throw new Error('FontFile2 requires a standalone TrueType font');
  }
  const tables = readTableDirectory(data);
  requiredTable(tables, 'glyf');
  requiredTable(tables, 'loca');
  const head = requiredTable(tables, 'head');
  const hhea = requiredTable(tables, 'hhea');
  const hmtx = requiredTable(tables, 'hmtx');
  const maxp = requiredTable(tables, 'maxp');
  const unitsPerEm = data.readUInt16BE(head.offset + 18);
  const scale = 1000 / unitsPerEm;
  const bbox: [number, number, number, number] = [
    data.readInt16BE(head.offset + 36) * scale,
    data.readInt16BE(head.offset + 38) * scale,
    data.readInt16BE(head.offset + 40) * scale,
    data.readInt16BE(head.offset + 42) * scale,
  ];
  const ascent = data.readInt16BE(hhea.offset + 4) * scale;
  const descent = data.readInt16BE(hhea.offset + 6) * scale;
  const numberOfHMetrics = data.readUInt16BE(hhea.offset + 34);
  const numGlyphs = data.readUInt16BE(maxp.offset + 4);
  const glyphWidths = readGlyphWidths(data, hmtx, numberOfHMetrics, numGlyphs, scale);
  const cmap = readUnicodeCmap(data, requiredTable(tables, 'cmap'));
  const os2 = tables.get('OS/2');
  const capHeight = os2 && os2.length >= 90 ? data.readInt16BE(os2.offset + 88) * scale : ascent;
  return {
    data,
    unitsPerEm,
    ascent,
    descent,
    capHeight,
    bbox,
    cmap,
    glyphWidths,
    fallbackWidth: glyphWidths[cmap.get(0x20) ?? 0] ?? 520,
  };
}

function readTableDirectory(data: Buffer): Map<string, FontTable> {
  const numTables = data.readUInt16BE(4);
  const tables = new Map<string, FontTable>();
  for (let index = 0; index < numTables; index += 1) {
    const offset = 12 + index * 16;
    const tag = data.toString('ascii', offset, offset + 4);
    tables.set(tag, {
      offset: data.readUInt32BE(offset + 8),
      length: data.readUInt32BE(offset + 12),
    });
  }
  return tables;
}

function requiredTable(tables: Map<string, FontTable>, tag: string): FontTable {
  const table = tables.get(tag);
  if (!table) throw new Error(`Unicode PDF font missing required ${tag} table`);
  return table;
}

function readGlyphWidths(data: Buffer, hmtx: FontTable, numberOfHMetrics: number, numGlyphs: number, scale: number): number[] {
  const widths: number[] = [];
  let lastAdvance = 520;
  for (let glyphId = 0; glyphId < numGlyphs; glyphId += 1) {
    if (glyphId < numberOfHMetrics) {
      lastAdvance = data.readUInt16BE(hmtx.offset + glyphId * 4);
    }
    widths[glyphId] = lastAdvance * scale;
  }
  return widths;
}

function readUnicodeCmap(data: Buffer, cmapTable: FontTable): Map<number, number> {
  const count = data.readUInt16BE(cmapTable.offset + 2);
  const records = Array.from({ length: count }, (_, index) => {
    const offset = cmapTable.offset + 4 + index * 8;
    const platformId = data.readUInt16BE(offset);
    const encodingId = data.readUInt16BE(offset + 2);
    const subtableOffset = cmapTable.offset + data.readUInt32BE(offset + 4);
    const format = data.readUInt16BE(subtableOffset);
    return { platformId, encodingId, subtableOffset, format };
  });
  const sorted = records
    .filter((record) => record.platformId === 3 || record.platformId === 0)
    .sort((left, right) => cmapRecordScore(right) - cmapRecordScore(left));
  for (const record of sorted) {
    if (record.format === 12) return readCmapFormat12(data, record.subtableOffset);
    if (record.format === 4) return readCmapFormat4(data, record.subtableOffset);
  }
  throw new Error('Unicode PDF font does not expose a supported Unicode cmap table');
}

function cmapRecordScore(record: { platformId: number; encodingId: number; format: number }): number {
  if (record.format === 12 && record.platformId === 3 && record.encodingId === 10) return 50;
  if (record.format === 12 && record.platformId === 0) return 45;
  if (record.format === 4 && record.platformId === 3 && record.encodingId === 1) return 40;
  if (record.format === 4 && record.platformId === 3 && record.encodingId === 0) return 35;
  if (record.format === 4 && record.platformId === 0) return 30;
  return 0;
}

function readCmapFormat12(data: Buffer, offset: number): Map<number, number> {
  const groups = data.readUInt32BE(offset + 12);
  const cmap = new Map<number, number>();
  for (let group = 0; group < groups; group += 1) {
    const groupOffset = offset + 16 + group * 12;
    const startCharCode = data.readUInt32BE(groupOffset);
    const endCharCode = data.readUInt32BE(groupOffset + 4);
    const startGlyphId = data.readUInt32BE(groupOffset + 8);
    for (let code = startCharCode; code <= endCharCode && code <= 0x10ffff; code += 1) {
      cmap.set(code, startGlyphId + code - startCharCode);
    }
  }
  return cmap;
}

function readCmapFormat4(data: Buffer, offset: number): Map<number, number> {
  const segCount = data.readUInt16BE(offset + 6) / 2;
  const endCodeOffset = offset + 14;
  const startCodeOffset = endCodeOffset + segCount * 2 + 2;
  const idDeltaOffset = startCodeOffset + segCount * 2;
  const idRangeOffsetOffset = idDeltaOffset + segCount * 2;
  const cmap = new Map<number, number>();
  for (let segment = 0; segment < segCount; segment += 1) {
    const endCode = data.readUInt16BE(endCodeOffset + segment * 2);
    const startCode = data.readUInt16BE(startCodeOffset + segment * 2);
    const idDelta = data.readInt16BE(idDeltaOffset + segment * 2);
    const idRangeOffsetPosition = idRangeOffsetOffset + segment * 2;
    const idRangeOffset = data.readUInt16BE(idRangeOffsetPosition);
    if (startCode === 0xffff && endCode === 0xffff) continue;
    for (let code = startCode; code <= endCode; code += 1) {
      let glyphId = 0;
      if (idRangeOffset === 0) {
        glyphId = (code + idDelta) & 0xffff;
      } else {
        const glyphOffset = idRangeOffsetPosition + idRangeOffset + (code - startCode) * 2;
        if (glyphOffset + 2 <= data.length) {
          glyphId = data.readUInt16BE(glyphOffset);
          if (glyphId !== 0) glyphId = (glyphId + idDelta) & 0xffff;
        }
      }
      if (glyphId !== 0) cmap.set(code, glyphId);
    }
  }
  return cmap;
}

function createPageStream(font: FontMetrics, lines: Line[], cidEncoding: CidEncoding): string {
  const commands: string[] = [];
  let y = TOP_Y;
  lines.forEach((line) => {
    let x = MARGIN_X + (line.indent ?? 0);
    const runs = line.runs ?? [{ text: line.text ?? '' }];
    for (const run of runs) {
      if (!run.text) continue;
      const width = measureText(font, run.text, line.size);
      const skew = run.italic ? '1 0 0.18 1' : '1 0 0 1';
      const color = run.link ? '0 0 1' : '0 0 0';
      commands.push('BT');
      commands.push(`${color} rg`);
      commands.push(`${color} RG`);
      commands.push(`/F1 ${line.size} Tf`);
      if (run.bold) {
        commands.push('0.15 w');
        commands.push('2 Tr');
      }
      commands.push(`${skew} ${number(x)} ${number(y)} Tm`);
      commands.push(`<${toCidHex(run.text, cidEncoding)}> Tj`);
      if (run.bold) commands.push('0 Tr');
      commands.push('ET');
      if (run.link) {
        commands.push(`0 0 1 RG 0.5 w ${number(x)} ${number(y - 2)} m ${number(x + width)} ${number(y - 2)} l S 0 0 0 RG`);
      }
      x += width;
    }
    y -= line.lineHeight;
  });
  return commands.join('\n');
}

function createToUnicodeMap(cidEncoding: CidEncoding): string {
  const entries = [...cidEncoding.cidToCode.entries()].sort(([left], [right]) => left - right);
  const sections: string[] = [];
  for (let index = 0; index < entries.length; index += 100) {
    const chunk = entries.slice(index, index + 100);
    sections.push(`${chunk.length} beginbfchar`);
    sections.push(...chunk.map(([cid, code]) => `<${hex4(cid)}> <${toUtf16BeHex(String.fromCodePoint(code))}>`));
    sections.push('endbfchar');
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /IntlyUnicode def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...sections,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

function createCidToGidMap(font: FontMetrics, cidEncoding: CidEncoding): Buffer {
  const maxCid = Math.max(0, ...cidEncoding.cidToCode.keys());
  const map = Buffer.alloc((maxCid + 1) * 2);
  for (const [cid, code] of cidEncoding.cidToCode) {
    map.writeUInt16BE(font.cmap.get(code) ?? 0, cid * 2);
  }
  return map;
}

function createWidthsArray(font: FontMetrics, cidEncoding: CidEncoding): string {
  const entries = [...cidEncoding.cidToCode.entries()]
    .sort(([left], [right]) => left - right)
    .map(([cid, code]) => `${cid} [${pdfWidthForCodePoint(font, code)}]`);
  return `[${entries.join(' ')}]`;
}

function streamObject(content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'binary'),
    content,
    Buffer.from('\nendstream', 'binary'),
  ]);
}

function buildPdf(objects: Array<Buffer | string>): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n', 'binary')];
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(totalLength(chunks));
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`, 'binary'));
    chunks.push(typeof objects[index] === 'string' ? Buffer.from(objects[index] as string, 'utf8') : objects[index] as Buffer);
    chunks.push(Buffer.from('\nendobj\n', 'binary'));
  }
  const xrefOffset = totalLength(chunks);
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, 'binary'));
  offsets.slice(1).forEach((offset) => chunks.push(Buffer.from(`${String(offset).padStart(10, '0')} 00000 n \n`, 'binary')));
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'binary'));
  return Buffer.concat(chunks);
}

function totalLength(chunks: Buffer[]): number {
  return chunks.reduce((total, chunk) => total + chunk.length, 0);
}

function paginate(lines: Line[]): Line[][] {
  const sourceLines = lines.length ? lines : [{ text: '', size: BODY_FONT_SIZE, lineHeight: BODY_LINE_HEIGHT }];
  const pages: Line[][] = [];
  let page: Line[] = [];
  let cursor = TOP_Y;
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    const keepHeight = line.keepWithNext ? heightThroughNextVisibleLine(sourceLines, index) : line.lineHeight;
    const requiredHeight = keepHeight <= TOP_Y - BOTTOM_Y ? keepHeight : line.lineHeight;
    if (page.length && cursor - requiredHeight < BOTTOM_Y) {
      pages.push(page);
      page = [];
      cursor = TOP_Y;
    }
    if (page.length && cursor - line.lineHeight < BOTTOM_Y) {
      pages.push(page);
      page = [];
      cursor = TOP_Y;
    }
    page.push(line);
    cursor -= line.lineHeight;
  }
  if (page.length) pages.push(page);
  return pages;
}

function heightThroughNextVisibleLine(lines: Line[], startIndex: number): number {
  let total = 0;
  const pageContentHeight = TOP_Y - BOTTOM_Y;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    total += line.lineHeight;
    if (total > pageContentHeight) break;
    if (index > startIndex && isVisibleLine(line) && !line.keepWithNext) break;
  }
  return total;
}

function isVisibleLine(line: Line): boolean {
  const runs = line.runs ?? [{ text: line.text ?? '' }];
  return runs.some((run) => run.text.trim().length > 0);
}

function wrapBlock(font: FontMetrics, block: UnicodePdfBlock): Line[] {
  const headingLevel = block.type === 'heading' ? Math.min(Math.max(block.level ?? 1, 1), 3) : 0;
  const size = headingLevel === 1 ? 16 : headingLevel === 2 ? 14 : headingLevel === 3 ? 12 : BODY_FONT_SIZE;
  const lineHeight = headingLevel === 1 ? 20 : headingLevel === 2 ? 18 : headingLevel === 3 ? 16 : BODY_LINE_HEIGHT;
  const indent = (block.indent ?? 0) * 18;
  const runs = block.marker ? [{ text: block.marker }, ...block.runs] : block.runs;
  const styledRuns = runs.map((run) => ({
    ...run,
    bold: run.bold || Boolean(headingLevel),
  }));
  const wrapped = wrapRuns(font, styledRuns, size, lineHeight, indent);
  if (headingLevel) {
    return [
      { text: '', size: BODY_FONT_SIZE, lineHeight: 6, keepWithNext: true },
      ...wrapped.map((line) => ({ ...line, keepWithNext: true })),
      { text: '', size: BODY_FONT_SIZE, lineHeight: 6, keepWithNext: true },
    ];
  }
  const isUnindentedParagraph = block.type !== 'listItem' && !block.marker && (block.indent ?? 0) === 0;
  return isUnindentedParagraph ? [...wrapped, { text: '', size: BODY_FONT_SIZE, lineHeight: 4 }] : wrapped;
}

function wrapText(font: FontMetrics, text: string, size: number, lineHeight: number): Line[] {
  const lines: Line[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const wrapped = wrapParagraph(font, paragraph, size);
    lines.push(...wrapped.map((line) => ({ text: line, size, lineHeight })));
    if (!paragraph.trim()) lines.push({ text: '', size, lineHeight });
  }
  return lines.length ? lines : [{ text: '', size, lineHeight }];
}

function wrapRuns(font: FontMetrics, runs: UnicodePdfRun[], size: number, lineHeight: number, indent: number): Line[] {
  const lines: Line[] = [];
  let current: UnicodePdfRun[] = [];
  let currentWidth = 0;
  const maxWidth = Math.max(120, MAX_TEXT_WIDTH - indent);
  const pushLine = () => {
    lines.push({ runs: trimLineRuns(current), size, lineHeight, indent });
    current = [];
    currentWidth = 0;
  };
  for (const run of runs) {
    for (const segment of splitRunByHardBreak(run)) {
      for (const token of tokenizeRun(segment)) {
        const tokenWidth = measureText(font, token.text, size);
        if (/^\s+$/.test(token.text) && current.length === 0) continue;
        if (current.length && currentWidth + tokenWidth > maxWidth) pushLine();
        if (tokenWidth > maxWidth) {
          for (const piece of splitRunToken(font, token, size, maxWidth)) {
            const pieceWidth = measureText(font, piece.text, size);
            if (current.length && currentWidth + pieceWidth > maxWidth) pushLine();
            current.push(piece);
            currentWidth += pieceWidth;
          }
        } else {
          current.push(token);
          currentWidth += tokenWidth;
        }
      }
      if (segment.hardBreakAfter) pushLine();
    }
  }
  if (current.length) pushLine();
  return lines.length ? lines : [{ runs: [], size, lineHeight, indent }];
}

function splitRunByHardBreak(run: UnicodePdfRun): Array<UnicodePdfRun & { hardBreakAfter: boolean }> {
  return run.text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((text, index, parts) => ({ ...run, text, hardBreakAfter: index < parts.length - 1 }));
}

function tokenizeRun(run: UnicodePdfRun): UnicodePdfRun[] {
  return (run.text.match(/[^\S\n\r]+|\S+/g) ?? []).map((text) => ({ ...run, text }));
}

function splitRunToken(font: FontMetrics, run: UnicodePdfRun, size: number, maxWidth: number): UnicodePdfRun[] {
  const pieces: UnicodePdfRun[] = [];
  let current = '';
  for (const char of [...run.text]) {
    const candidate = current + char;
    if (current && measureText(font, candidate, size) > maxWidth) {
      pieces.push({ ...run, text: current });
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push({ ...run, text: current });
  return pieces;
}

function trimLineRuns(runs: UnicodePdfRun[]): UnicodePdfRun[] {
  const copy = runs.map((run) => ({ ...run }));
  while (copy.length && /^\s+$/.test(copy[copy.length - 1].text)) copy.pop();
  return copy;
}

function wrapParagraph(font: FontMetrics, paragraph: string, size: number): string[] {
  const words = paragraph.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = `${current} ${word}`.trim();
    if (current && measureText(font, candidate, size) > MAX_TEXT_WIDTH) {
      lines.push(current);
      current = '';
    }
    if (measureText(font, word, size) > MAX_TEXT_WIDTH) {
      const pieces = splitLongWord(font, word, size);
      lines.push(...pieces.slice(0, -1));
      current = pieces.at(-1) ?? '';
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function splitLongWord(font: FontMetrics, word: string, size: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const char of [...word]) {
    const candidate = current + char;
    if (current && measureText(font, candidate, size) > MAX_TEXT_WIDTH) {
      pieces.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function measureText(font: FontMetrics, value: string, size: number): number {
  const width = [...value].reduce((total, char) => {
    const code = char.codePointAt(0);
    if (code === undefined) return total + Math.round(font.fallbackWidth);
    return total + pdfWidthForCodePoint(font, code);
  }, 0);
  return width * size / 1000;
}

function collectUsedCodePoints(lines: Line[]): number[] {
  const codes = new Set<number>();
  for (const line of lines) {
    for (const run of line.runs ?? [{ text: line.text ?? '' }]) {
      for (const char of [...run.text]) {
        const code = char.codePointAt(0);
        if (code !== undefined) codes.add(code);
      }
    }
  }
  codes.add(0x20);
  return [...codes];
}

function collectRequiredGlyphCodePoints(value: string): number[] {
  const required = new Set<number>();
  for (const char of [...value]) {
    const code = char.codePointAt(0);
    if (code === undefined || code > 0xffff || isWhitespaceOrControl(code)) continue;
    if (isAsciiPrintable(code) || isCyrillic(code) || code === 0x20bd) required.add(code);
  }
  required.add(0x20);
  return [...required];
}

function isAsciiPrintable(code: number): boolean {
  return code >= 0x21 && code <= 0x7e;
}

function isCyrillic(code: number): boolean {
  return code >= 0x0400 && code <= 0x052f;
}

function isWhitespaceOrControl(code: number): boolean {
  return code <= 0x20 || code === 0x7f;
}

function createCidEncoding(codePoints: number[]): CidEncoding {
  const codeToCid = new Map<number, number>();
  const cidToCode = new Map<number, number>();
  [...new Set(codePoints)].sort((left, right) => left - right).forEach((code, index) => {
    const cid = index + 1;
    if (cid > 0xffff) throw new Error('Unicode PDF cannot encode more than 65535 unique glyph CIDs');
    codeToCid.set(code, cid);
    cidToCode.set(cid, code);
  });
  return { codeToCid, cidToCode };
}

function pdfWidthForCodePoint(font: FontMetrics, code: number): number {
  const glyphId = font.cmap.get(code) ?? 0;
  return Math.round(font.glyphWidths[glyphId] ?? font.fallbackWidth);
}

function toCidHex(value: string, cidEncoding: CidEncoding): string {
  return [...value]
    .map((char) => char.codePointAt(0))
    .filter((code): code is number => code !== undefined)
    .map((code) => cidEncoding.codeToCid.get(code))
    .filter((cid): cid is number => cid !== undefined)
    .map(hex4)
    .join('');
}

function toUtf16BeHex(value: string): string {
  const littleEndian = Buffer.from(value, 'utf16le');
  for (let index = 0; index < littleEndian.length; index += 2) {
    const next = littleEndian[index];
    littleEndian[index] = littleEndian[index + 1];
    littleEndian[index + 1] = next;
  }
  return littleEndian.toString('hex').toUpperCase();
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
