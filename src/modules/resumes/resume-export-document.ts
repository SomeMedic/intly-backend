type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
};

export type ResumeExportFormat = 'pdf' | 'docx' | 'txt';

const LIST_SECTIONS = [
  ['skills', 'Skills'],
  ['experience', 'Experience'],
  ['projects', 'Projects'],
  ['education', 'Education'],
  ['languages', 'Languages'],
  ['links', 'Links'],
] as const;

export function resumeDocumentForExport(documentJson: Record<string, unknown>, format: ResumeExportFormat): { documentJson: Record<string, unknown>; allowMarkdownFallback: boolean } {
  if (isTiptapDocument(documentJson)) return { documentJson, allowMarkdownFallback: true };
  const hasContent = hasStructuredResumeContent(documentJson);
  if (!hasContent) return { documentJson: emptyTiptapDocument(), allowMarkdownFallback: true };
  return { documentJson: structuredResumeToTiptap(documentJson, { includeHeadline: format === 'txt' }), allowMarkdownFallback: false };
}

export function resumeExportTitle(baseResumeTitle: string, documentJson: Record<string, unknown>): string {
  const baseTitle = cleanText(baseResumeTitle) || 'Resume';
  if (isTiptapDocument(documentJson)) return `${baseTitle} adapted`;
  const headline = cleanText(documentJson.headline);
  if (!headline) return `${baseTitle} adapted`;
  return sameText(baseTitle, headline) ? baseTitle : `${baseTitle} ${headline}`;
}

export function resumeExportDisplayTitle(baseResumeTitle: string, documentJson: Record<string, unknown>): string {
  const baseTitle = cleanText(baseResumeTitle) || 'Resume';
  if (isTiptapDocument(documentJson)) return baseTitle;
  return cleanText(documentJson.headline) || baseTitle;
}

function structuredResumeToTiptap(documentJson: Record<string, unknown>, options: { includeHeadline: boolean }): Record<string, unknown> {
  const content: TiptapNode[] = [];
  const headline = cleanText(documentJson.headline);
  const summary = cleanText(documentJson.summary);

  if (options.includeHeadline && headline) content.push(headingNode(headline, 1));
  if (summary) {
    content.push(headingNode('Summary', 2));
    content.push(...paragraphNodes(summary));
  }

  for (const [key, label] of LIST_SECTIONS) {
    const items = listItems(documentJson[key]);
    if (!items.length) continue;
    content.push(headingNode(label, 2));
    content.push({
      type: 'bulletList',
      content: items.map((item) => ({ type: 'listItem', content: paragraphNodes(item) })),
    });
  }

  return { type: 'doc', content };
}

function hasStructuredResumeContent(documentJson: Record<string, unknown>): boolean {
  return !!cleanText(documentJson.headline) || !!cleanText(documentJson.summary) || LIST_SECTIONS.some(([key]) => listItems(documentJson[key]).length > 0);
}

function emptyTiptapDocument(): Record<string, unknown> {
  return { type: 'doc', content: [] };
}

function paragraphNodes(value: string): TiptapNode[] {
  return cleanText(value)
    .split(/\n{2,}/)
    .map((paragraph) => ({ type: 'paragraph', content: inlineContent(paragraph) }));
}

function inlineContent(value: string): TiptapNode[] {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  return lines.flatMap((line, index) => [
    ...(index > 0 ? [{ type: 'hardBreak' }] : []),
    ...(line ? [{ type: 'text', text: line }] : []),
  ]);
}

function headingNode(value: string, level: number): TiptapNode {
  return { type: 'heading', attrs: { level }, content: inlineContent(value) };
}

function listItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(itemText).filter((item): item is string => !!item);
}

function itemText(value: unknown): string | undefined {
  if (typeof value === 'string') return cleanText(value);
  if (!isRecord(value)) return cleanText(value);
  return cleanText(value.text) || cleanText(value.title) || cleanText(value.name) || cleanText(value.description);
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
}

function sameText(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function isTiptapDocument(value: unknown): boolean {
  return isRecord(value) && value.type === 'doc' && Array.isArray(value.content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
