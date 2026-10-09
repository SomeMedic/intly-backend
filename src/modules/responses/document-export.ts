import { createHash } from 'node:crypto';

import { renderRichUnicodePdf, renderUnicodePdf, UnicodePdfBlock, UnicodePdfRun } from '../documents/unicode-pdf';

export type ExportFormat = 'pdf' | 'docx' | 'txt';

export function renderDocumentExport(documentJson: Record<string, unknown>, markdownCache: string | undefined, title: string, format: ExportFormat, displayTitle = title): { buffer: Buffer; mimeType: string; filename: string } {
  const jsonText = normalizeText(tiptapToText(documentJson).trim());
  const text = jsonText || normalizeText(markdownCache?.trim() || displayTitle);
  if (format === 'txt') {
    return { buffer: Buffer.from(text, 'utf8'), mimeType: 'text/plain', filename: `${safeFilename(title)}.txt` };
  }
  if (format === 'pdf') {
    return {
      buffer: jsonText ? renderRichUnicodePdf(displayTitle, pdfBlocks(documentJson)) : renderUnicodePdf(displayTitle, text),
      mimeType: 'application/pdf',
      filename: `${safeFilename(title)}.pdf`,
    };
  }
  return {
    buffer: jsonText ? renderRichDocx(displayTitle, documentJson) : renderFallbackDocx(displayTitle, text),
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: `${safeFilename(title)}.docx`,
  };
}

export function tiptapToText(node: unknown): string {
  return flattenText(node).join('\n');
}

function flattenText(node: unknown, depth = 0): string[] {
  if (!isRecord(node)) return [];
  const type = typeof node.type === 'string' ? node.type : '';
  const children = Array.isArray(node.content) ? node.content : [];
  if (type === 'text') return [typeof node.text === 'string' ? node.text : ''];
  if (type === 'hardBreak') return ['\n'];
  if (type === 'paragraph' || type === 'heading') return [inlineText(children)];
  if (type === 'semanticBlock') {
    return hasBlockChildren(children) ? children.flatMap((child) => flattenText(child, depth)) : [inlineText(children)];
  }
  if (type === 'bulletList') return flattenList(children, depth, 'bullet');
  if (type === 'orderedList') return flattenList(children, depth, 'ordered', readStart(node));
  if (type === 'listItem') return flattenListItem(children, depth, 'bullet', 1);
  return children.flatMap((child) => flattenText(child, depth));
}

function inlineText(nodes: unknown[]): string {
  return nodes.map((node) => {
    if (!isRecord(node)) return '';
    const type = typeof node.type === 'string' ? node.type : '';
    if (type === 'text') return typeof node.text === 'string' ? node.text : '';
    if (type === 'hardBreak') return '\n';
    return inlineText(Array.isArray(node.content) ? node.content : []);
  }).join('');
}

function flattenList(nodes: unknown[], depth: number, kind: 'bullet' | 'ordered', start = 1): string[] {
  let counter = start;
  return nodes.flatMap((node) => {
    const prefix = kind === 'ordered' ? `${counter}. ` : '• ';
    counter += 1;
    const children = isRecord(node) && Array.isArray(node.content) ? node.content : [];
    return flattenListItem(children, depth, kind, counter - 1, prefix);
  });
}

function flattenListItem(nodes: unknown[], depth: number, kind: 'bullet' | 'ordered', counter: number, providedPrefix?: string): string[] {
  const indent = '  '.repeat(depth);
  const prefix = providedPrefix ?? (kind === 'ordered' ? `${counter}. ` : '• ');
  const lines: string[] = [];
  const firstTextBlock = nodes.find((node) => isTextBlock(node));
  const directInline = nodes.filter((node) => isInlineNode(node));
  const firstText = firstTextBlock ? flattenText(firstTextBlock, depth)[0] : inlineText(directInline);
  if (firstText) lines.push(`${indent}${prefix}${firstText}`);
  for (const child of nodes) {
    if (child === firstTextBlock || isInlineNode(child)) continue;
    if (isRecord(child) && child.type === 'bulletList') lines.push(...flattenList(Array.isArray(child.content) ? child.content : [], depth + 1, 'bullet'));
    else if (isRecord(child) && child.type === 'orderedList') lines.push(...flattenList(Array.isArray(child.content) ? child.content : [], depth + 1, 'ordered', readStart(child)));
    else lines.push(...flattenText(child, depth + 1).filter(Boolean).map((line) => `${indent}${line}`));
  }
  return lines;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function renderRichDocx(title: string, documentJson: Record<string, unknown>): Buffer {
  const context = createDocxContext();
  const body = [
    paragraphXml(textRuns(title), { style: 'Title' }, context),
    ...docxBlocks(documentJson, context),
  ].join('');
  return packageDocx(body, context);
}

function renderFallbackDocx(title: string, text: string): Buffer {
  const context = createDocxContext();
  const body = [
    paragraphXml(textRuns(title), { style: 'Title' }, context),
    ...text.split('\n').filter(Boolean).map((line) => paragraphXml(textRuns(line), {}, context)),
  ].join('');
  return packageDocx(body, context);
}

function packageDocx(body: string, context: DocxContext): Buffer {
  const documentRelationships = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    ...context.hyperlinks.map((link) => `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXmlAttr(link.href)}" TargetMode="External"/>`),
  ].join('');
  const files = new Map<string, Buffer>([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>')],
    ['_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')],
    ['word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${documentRelationships}</Relationships>`)],
    ['word/styles.xml', Buffer.from(stylesXml())],
    ['word/numbering.xml', Buffer.from(numberingXml(context))],
    ['word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr/></w:body></w:document>`)],
  ]);
  return zipStore(files);
}

type TextMark = { type: 'bold' | 'italic' | 'link'; href?: string };
type TextRun = { text?: string; hardBreak?: boolean; marks: TextMark[] };
type ListContext = { kind: 'bullet' | 'ordered'; level: number; numId: number };
type ParagraphOptions = { style?: string; list?: ListContext; continuationList?: ListContext };
type HyperlinkRelationship = { id: string; href: string };
type OrderedListDefinition = { numId: number; level: number; start: number };
type DocxContext = {
  hyperlinks: HyperlinkRelationship[];
  orderedLists: OrderedListDefinition[];
  nextRelationshipId: number;
  nextNumberingId: number;
};

function createDocxContext(): DocxContext {
  return { hyperlinks: [], orderedLists: [], nextRelationshipId: 3, nextNumberingId: 2 };
}

function docxBlocks(node: unknown, context: DocxContext, list?: ListContext): string[] {
  if (!isRecord(node)) return [];
  const type = typeof node.type === 'string' ? node.type : '';
  const children = Array.isArray(node.content) ? node.content : [];
  if (type === 'doc') return children.flatMap((child) => docxBlocks(child, context, list));
  if (type === 'paragraph') return [paragraphXml(inlineRuns(children), { list }, context)];
  if (type === 'heading') return [paragraphXml(inlineRuns(children), { style: headingStyle(node), list }, context)];
  if (type === 'semanticBlock') {
    if (hasBlockChildren(children)) return children.flatMap((child) => docxBlocks(child, context, list));
    return [paragraphXml(inlineRuns(children), { list }, context)];
  }
  if (type === 'bulletList') return listBlocks(children, context, 'bullet', list?.level ?? -1);
  if (type === 'orderedList') return listBlocks(children, context, 'ordered', list?.level ?? -1, readStart(node));
  if (type === 'listItem') return listItemBlocks(children, context, list);
  if (type === 'text' || type === 'hardBreak') return [paragraphXml(inlineRuns([node]), { list }, context)];
  return children.flatMap((child) => docxBlocks(child, context, list));
}

function listBlocks(nodes: unknown[], context: DocxContext, kind: 'bullet' | 'ordered', parentLevel: number, start = 1): string[] {
  const level = parentLevel + 1;
  const numId = kind === 'bullet' ? 1 : createOrderedNumbering(context, level, start);
  return nodes.flatMap((child) => docxBlocks(child, context, { kind, level, numId }));
}

function listItemBlocks(nodes: unknown[], context: DocxContext, list?: ListContext): string[] {
  const blocks: string[] = [];
  const firstTextBlock = nodes.find((node) => isTextBlock(node));
  const directInline = nodes.filter((node) => isInlineNode(node));
  if (firstTextBlock) {
    blocks.push(...docxBlocks(firstTextBlock, context, list));
  } else if (directInline.length) {
    blocks.push(paragraphXml(inlineRuns(directInline), { list }, context));
  } else if (list) {
    blocks.push(paragraphXml([], { list }, context));
  }
  for (const child of nodes) {
    if (child === firstTextBlock || isInlineNode(child)) continue;
    if (isListNode(child)) {
      blocks.push(...docxBlocks(child, context, list));
      continue;
    }
    if (list && isTextBlock(child)) {
      const childRecord = child as Record<string, unknown>;
      const childContent = Array.isArray(childRecord.content) ? childRecord.content : [];
      blocks.push(paragraphXml(inlineRuns(childContent), { continuationList: list }, context));
      continue;
    }
    blocks.push(...docxBlocks(child, context, undefined));
  }
  return blocks;
}

function inlineRuns(nodes: unknown[], inheritedMarks: TextMark[] = []): TextRun[] {
  const runs: TextRun[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const type = typeof node.type === 'string' ? node.type : '';
    if (type === 'text') {
      const text = typeof node.text === 'string' ? node.text : '';
      runs.push({ text, marks: [...inheritedMarks, ...readMarks(node)] });
      continue;
    }
    if (type === 'hardBreak') {
      runs.push({ hardBreak: true, marks: inheritedMarks });
      continue;
    }
    const children = Array.isArray(node.content) ? node.content : [];
    runs.push(...inlineRuns(children, inheritedMarks));
  }
  return runs;
}

function paragraphXml(runs: TextRun[], options: ParagraphOptions, context: DocxContext): string {
  const pPr = paragraphProperties(options);
  const body = groupRunsByLink(runs, context).join('');
  return `<w:p>${pPr}${body}</w:p>`;
}

function paragraphProperties(options: ParagraphOptions): string {
  const props: string[] = [];
  if (options.style) props.push(`<w:pStyle w:val="${escapeXmlAttr(options.style)}"/>`);
  if (options.list) {
    const left = 720 * (options.list.level + 1);
    props.push(`<w:numPr><w:ilvl w:val="${options.list.level}"/><w:numId w:val="${options.list.numId}"/></w:numPr><w:ind w:left="${left}" w:hanging="360"/>`);
  } else if (options.continuationList) {
    const left = 720 * (options.continuationList.level + 1);
    props.push(`<w:ind w:left="${left}"/>`);
  }
  return props.length ? `<w:pPr>${props.join('')}</w:pPr>` : '';
}

function groupRunsByLink(runs: TextRun[], context: DocxContext): string[] {
  const xml: string[] = [];
  let index = 0;
  while (index < runs.length) {
    const href = linkHref(runs[index]);
    if (!href) {
      xml.push(runXml(runs[index]));
      index += 1;
      continue;
    }
    const grouped: TextRun[] = [];
    while (index < runs.length && linkHref(runs[index]) === href) {
      grouped.push(runs[index]);
      index += 1;
    }
    const id = addHyperlink(context, href);
    xml.push(`<w:hyperlink r:id="${id}">${grouped.map(runXml).join('')}</w:hyperlink>`);
  }
  return xml;
}

function runXml(run: TextRun): string {
  const rPr = runProperties(run);
  if (run.hardBreak) return `<w:r>${rPr}<w:br/></w:r>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text ?? '')}</w:t></w:r>`;
}

function runProperties(run: TextRun): string {
  const props: string[] = [];
  if (linkHref(run)) props.push('<w:rStyle w:val="Hyperlink"/>');
  if (run.marks.some((mark) => mark.type === 'bold')) props.push('<w:b/>');
  if (run.marks.some((mark) => mark.type === 'italic')) props.push('<w:i/>');
  return props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
}

function readMarks(node: Record<string, unknown>): TextMark[] {
  const rawMarks = Array.isArray(node.marks) ? node.marks : [];
  return rawMarks.flatMap((mark): TextMark[] => {
    if (!isRecord(mark) || typeof mark.type !== 'string') return [];
    if (mark.type === 'bold') return [{ type: 'bold' }];
    if (mark.type === 'italic') return [{ type: 'italic' }];
    if (mark.type === 'link' && isRecord(mark.attrs) && typeof mark.attrs.href === 'string' && isSafeLink(mark.attrs.href)) {
      return [{ type: 'link', href: mark.attrs.href }];
    }
    return [];
  });
}

function linkHref(run: TextRun): string | undefined {
  return run.marks.find((mark) => mark.type === 'link' && mark.href)?.href;
}

function addHyperlink(context: DocxContext, href: string): string {
  const existing = context.hyperlinks.find((link) => link.href === href);
  if (existing) return existing.id;
  const id = `rId${context.nextRelationshipId}`;
  context.nextRelationshipId += 1;
  context.hyperlinks.push({ id, href });
  return id;
}

function createOrderedNumbering(context: DocxContext, level: number, start: number): number {
  const numId = context.nextNumberingId;
  context.nextNumberingId += 1;
  context.orderedLists.push({ numId, level, start });
  return numId;
}

function stylesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>',
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>',
    '</w:styles>',
  ].join('');
}

function numberingXml(context: DocxContext): string {
  const nums = [
    '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>',
    ...context.orderedLists.map((list) => `<w:num w:numId="${list.numId}"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="${list.level}"><w:startOverride w:val="${list.start}"/></w:lvlOverride></w:num>`),
  ].join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:abstractNum w:abstractNumId="1">',
    Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join(''),
    '</w:abstractNum>',
    '<w:abstractNum w:abstractNumId="2">',
    Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${level + 1}."/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join(''),
    '</w:abstractNum>',
    nums,
    '</w:numbering>',
  ].join('');
}

function textRuns(value: string): TextRun[] {
  return [{ text: value, marks: [] }];
}

function headingStyle(node: Record<string, unknown>): string {
  const level = isRecord(node.attrs) && typeof node.attrs.level === 'number' ? Math.min(Math.max(Math.trunc(node.attrs.level), 1), 3) : 1;
  return `Heading${level}`;
}

function readStart(node: Record<string, unknown>): number {
  const raw = isRecord(node.attrs) ? node.attrs.start : undefined;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1;
}

function hasBlockChildren(nodes: unknown[]): boolean {
  return nodes.some((node) => isRecord(node) && ['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'semanticBlock'].includes(typeof node.type === 'string' ? node.type : ''));
}

function isTextBlock(node: unknown): boolean {
  return isRecord(node) && ['paragraph', 'heading', 'semanticBlock'].includes(typeof node.type === 'string' ? node.type : '') && !hasBlockChildren(Array.isArray(node.content) ? node.content : []);
}

function isInlineNode(node: unknown): boolean {
  return isRecord(node) && ['text', 'hardBreak'].includes(typeof node.type === 'string' ? node.type : '');
}

function isListNode(node: unknown): boolean {
  return isRecord(node) && ['bulletList', 'orderedList'].includes(typeof node.type === 'string' ? node.type : '');
}

function isSafeLink(href: string): boolean {
  try {
    const parsed = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function pdfBlocks(node: unknown, list?: { kind: 'bullet' | 'ordered'; level: number; index: number }): UnicodePdfBlock[] {
  if (!isRecord(node)) return [];
  const type = typeof node.type === 'string' ? node.type : '';
  const children = Array.isArray(node.content) ? node.content : [];
  if (type === 'doc') return children.flatMap((child) => pdfBlocks(child));
  if (type === 'paragraph') return pdfTextBlocks(children, {}, list);
  if (type === 'heading') return pdfTextBlocks(children, { type: 'heading', level: headingLevel(node) }, list);
  if (type === 'semanticBlock') {
    if (hasBlockChildren(children)) return children.flatMap((child) => pdfBlocks(child, list));
    return pdfTextBlocks(children, {}, list);
  }
  if (type === 'bulletList') return pdfListBlocks(children, 'bullet', list?.level ?? -1);
  if (type === 'orderedList') return pdfListBlocks(children, 'ordered', list?.level ?? -1, readStart(node));
  if (type === 'listItem') return pdfListItemBlocks(children, list);
  if (type === 'text' || type === 'hardBreak') return pdfTextBlocks([node], {}, list);
  return children.flatMap((child) => pdfBlocks(child, list));
}

function pdfListBlocks(nodes: unknown[], kind: 'bullet' | 'ordered', parentLevel: number, start = 1): UnicodePdfBlock[] {
  const level = parentLevel + 1;
  let index = start;
  return nodes.flatMap((child) => {
    const blocks = pdfBlocks(child, { kind, level, index });
    index += 1;
    return blocks;
  });
}

function pdfListItemBlocks(nodes: unknown[], list?: { kind: 'bullet' | 'ordered'; level: number; index: number }): UnicodePdfBlock[] {
  const blocks: UnicodePdfBlock[] = [];
  const firstTextBlock = nodes.find((node) => isTextBlock(node));
  const directInline = nodes.filter((node) => isInlineNode(node));
  const marker = list ? (list.kind === 'ordered' ? `${list.index}. ` : '• ') : undefined;
  if (firstTextBlock) {
    const firstRecord = firstTextBlock as Record<string, unknown>;
    const content = Array.isArray(firstRecord.content) ? firstRecord.content : [];
    blocks.push(...pdfTextBlocks(content, {}, list, marker));
  } else if (directInline.length) {
    blocks.push(...pdfTextBlocks(directInline, {}, list, marker));
  } else if (list) {
    blocks.push({ type: 'listItem', indent: list.level, marker, runs: [] });
  }
  for (const child of nodes) {
    if (child === firstTextBlock || isInlineNode(child)) continue;
    if (isListNode(child)) {
      blocks.push(...pdfBlocks(child, list));
      continue;
    }
    if (list && isTextBlock(child)) {
      const childRecord = child as Record<string, unknown>;
      const content = Array.isArray(childRecord.content) ? childRecord.content : [];
      blocks.push(...pdfTextBlocks(content, {}, { ...list, level: list.level + 1 }));
      continue;
    }
    blocks.push(...pdfBlocks(child));
  }
  return blocks;
}

function pdfTextBlocks(
  nodes: unknown[],
  options: { type?: 'heading'; level?: number },
  list?: { level: number },
  marker?: string,
): UnicodePdfBlock[] {
  const lines = pdfInlineLines(nodes);
  return lines.map((runs, index) => ({
    type: options.type ?? (list ? 'listItem' : 'paragraph'),
    level: options.level,
    indent: list?.level,
    marker: index === 0 ? marker : undefined,
    runs,
  }));
}

function pdfInlineLines(nodes: unknown[]): UnicodePdfRun[][] {
  const lines: UnicodePdfRun[][] = [[]];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const type = typeof node.type === 'string' ? node.type : '';
    if (type === 'hardBreak') {
      lines.push([]);
      continue;
    }
    if (type === 'text') {
      const marks = readMarks(node);
      lines[lines.length - 1].push({
        text: typeof node.text === 'string' ? node.text : '',
        bold: marks.some((mark) => mark.type === 'bold'),
        italic: marks.some((mark) => mark.type === 'italic'),
        link: marks.some((mark) => mark.type === 'link'),
      });
      continue;
    }
    const children = Array.isArray(node.content) ? node.content : [];
    const childLines = pdfInlineLines(children);
    lines[lines.length - 1].push(...(childLines.shift() ?? []));
    lines.push(...childLines);
  }
  return lines;
}

function headingLevel(node: Record<string, unknown>): number {
  return isRecord(node.attrs) && typeof node.attrs.level === 'number' ? Math.min(Math.max(Math.trunc(node.attrs.level), 1), 3) : 1;
}

function zipStore(files: Map<string, Buffer>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuffer = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeFilename(value: string): string {
  const digest = createHash('sha1').update(value).digest('hex').slice(0, 8);
  return `${value.replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]+/g, '-').slice(0, 80) || 'document'}-${digest}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char] ?? char);
}

function escapeXmlAttr(value: string): string {
  return escapeXml(value).replace(/'/g, '&apos;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
