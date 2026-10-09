import { EDITOR_SEMANTIC_BLOCK_TYPES } from './ai-output.schemas';

const BLOCK_NODES = new Set(['paragraph', 'heading', 'semanticBlock', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', ...EDITOR_SEMANTIC_BLOCK_TYPES]);
const INLINE_NODES = new Set(['text', 'hardBreak']);
const MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link']);
const SEMANTIC_TYPES = new Set<string>(EDITOR_SEMANTIC_BLOCK_TYPES);
const MAX_DEPTH = 24;

export function validateRichDocumentJson(value: unknown, label = 'documentJson'): Record<string, unknown> {
  if (!isRecord(value) || value.type !== 'doc' || !Array.isArray(value.content)) {
    throw new Error(`${label} must be a Tiptap doc with content array`);
  }
  validateAttrs(value, label);
  value.content.forEach((node, index) => validateBlockNode(node, `${label}.content.${index}`, 1));
  return value;
}

function validateBlockNode(value: unknown, path: string, depth: number): void {
  ensureDepth(depth, path);
  if (!isRecord(value) || typeof value.type !== 'string' || !BLOCK_NODES.has(value.type)) {
    throw new Error(`${path} has unsupported block node type`);
  }
  validateAttrs(value, path);
  if (value.type === 'paragraph') return validateInlineContent(value.content, path, true, depth + 1);
  if (value.type === 'heading') return validateHeading(value, path, depth + 1);
  if (value.type === 'semanticBlock' || SEMANTIC_TYPES.has(value.type)) return validateSemanticBlock(value, path, depth + 1);
  if (value.type === 'bulletList' || value.type === 'orderedList') return validateList(value, path, depth + 1);
  if (value.type === 'blockquote') return validateBlockquote(value, path, depth + 1);
  if (value.type === 'codeBlock') return validateCodeBlock(value, path, depth + 1);
}

function validateHeading(value: Record<string, unknown>, path: string, depth: number): void {
  const attrs = isRecord(value.attrs) ? value.attrs : {};
  const level = attrs.level;
  if (level !== undefined && (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6)) throw new Error(`${path}.attrs.level must be 1..6`);
  validateInlineContent(value.content, path, true, depth);
}

function validateSemanticBlock(value: Record<string, unknown>, path: string, depth: number): void {
  const attrs = isRecord(value.attrs) ? value.attrs : {};
  if (attrs.semanticType !== undefined) {
    if (typeof attrs.semanticType !== 'string') throw new Error(`${path}.attrs.semanticType is unsupported`);
    if (!isSupportedSemanticType(attrs.semanticType)) throw new Error(`${path}.attrs.semanticType is unsupported`);
  }
  validateInlineContent(value.content, path, true, depth);
}

function validateList(value: Record<string, unknown>, path: string, depth: number): void {
  const attrs = isRecord(value.attrs) ? value.attrs : {};
  const start = attrs.start;
  if (value.type === 'orderedList' && start !== undefined && (typeof start !== 'number' || !Number.isInteger(start) || start < 1)) throw new Error(`${path}.attrs.start must be a positive integer`);
  const content = requireArray(value.content, `${path}.content`);
  if (!content.length) throw new Error(`${path}.content must contain at least one listItem`);
  content.forEach((node, index) => {
    if (!isRecord(node) || node.type !== 'listItem') throw new Error(`${path}.content.${index} must be listItem`);
    validateListItem(node, `${path}.content.${index}`, depth + 1);
  });
}

function validateListItem(value: Record<string, unknown>, path: string, depth: number): void {
  ensureDepth(depth, path);
  validateAttrs(value, path);
  const content = requireArray(value.content, `${path}.content`);
  if (!content.length) throw new Error(`${path}.content must contain at least one paragraph`);
  if (!isRecord(content[0]) || content[0].type !== 'paragraph') throw new Error(`${path}.content.0 must be paragraph`);
  content.forEach((node, index) => validateBlockNode(node, `${path}.content.${index}`, depth + 1));
}

function validateBlockquote(value: Record<string, unknown>, path: string, depth: number): void {
  const content = requireArray(value.content, `${path}.content`);
  if (!content.length) throw new Error(`${path}.content must contain at least one block`);
  content.forEach((node, index) => validateBlockNode(node, `${path}.content.${index}`, depth + 1));
}

function validateCodeBlock(value: Record<string, unknown>, path: string, depth: number): void {
  if (value.content === undefined) return;
  const content = requireArray(value.content, `${path}.content`);
  content.forEach((node, index) => {
    ensureDepth(depth, `${path}.content.${index}`);
    if (!isRecord(node) || node.type !== 'text' || typeof node.text !== 'string' || !node.text.length) throw new Error(`${path}.content.${index} must be non-empty text`);
    validateAttrs(node, `${path}.content.${index}`);
    if ('content' in node) throw new Error(`${path}.content.${index}.content is not supported in codeBlock text`);
    if (node.marks !== undefined) throw new Error(`${path}.content.${index}.marks are not supported in codeBlock`);
  });
}

function validateInlineContent(value: unknown, path: string, optional: boolean, depth: number): void {
  if (value === undefined && optional) return;
  const content = requireArray(value, `${path}.content`);
  content.forEach((node, index) => validateInlineNode(node, `${path}.content.${index}`, depth + 1));
}

function validateInlineNode(value: unknown, path: string, depth: number): void {
  ensureDepth(depth, path);
  if (!isRecord(value) || typeof value.type !== 'string' || !INLINE_NODES.has(value.type)) throw new Error(`${path} has unsupported inline node type`);
  validateAttrs(value, path);
  if (value.type === 'hardBreak') {
    if ('content' in value) throw new Error(`${path}.content is not supported for hardBreak`);
    if ('text' in value) throw new Error(`${path}.text is not supported for hardBreak`);
    if (value.marks !== undefined) throw new Error(`${path}.marks are not supported for hardBreak`);
    return;
  }
  if (typeof value.text !== 'string' || !value.text.length) throw new Error(`${path}.text must be a non-empty string`);
  if ('content' in value) throw new Error(`${path}.content is not supported for text`);
  validateMarks(value.marks, path);
}

function validateMarks(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${path}.marks must be an array`);
  value.forEach((mark, index) => {
    if (!isRecord(mark) || typeof mark.type !== 'string' || !MARKS.has(mark.type)) throw new Error(`${path}.marks.${index} has unsupported mark type`);
    if (mark.type !== 'link') {
      if (mark.attrs !== undefined) throw new Error(`${path}.marks.${index}.attrs are not supported`);
      return;
    }
    const attrs = isRecord(mark.attrs) ? mark.attrs : {};
    const href = attrs.href;
    if (typeof href !== 'string' || sanitizeLinkHref(href) !== href) throw new Error(`${path}.marks.${index}.attrs.href must be safe http(s) or mailto link`);
  });
}

function validateAttrs(value: Record<string, unknown>, path: string): void {
  if (value.attrs !== undefined && !isRecord(value.attrs)) throw new Error(`${path}.attrs must be an object`);
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function ensureDepth(depth: number, path: string): void {
  if (depth > MAX_DEPTH) throw new Error(`${path} exceeds maximum rich document depth`);
}

function isSupportedSemanticType(value: string): boolean {
  if (value === 'generic') return true;
  const trimmed = value.trim();
  return !!trimmed && /^[a-z][a-z0-9-]{0,63}$/.test(trimmed);
}

function sanitizeLinkHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\u0000-\u001F\u007F\s]+/g, '');
  return /^(https?:\/\/|mailto:)/i.test(normalized) ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
