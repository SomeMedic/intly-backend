import { BadRequestException } from '@nestjs/common';

import { newId } from '../../common/schema';
import { ResumeSuggestion } from './schemas/resume-adaptation.schema';

const LIST_SECTIONS = ['skills', 'experience', 'projects', 'education', 'languages', 'links'] as const;

type ResumeListItem = Record<string, unknown> & { id: string };

export function normalizeStructuredResumeDocument(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const document = cloneRecord(value ?? {});
  for (const section of LIST_SECTIONS) {
    const raw = document[section];
    if (!Array.isArray(raw)) {
      document[section] = [];
      continue;
    }
    document[section] = raw.map((item) => normalizeListItem(item));
  }
  return document;
}

export function applyResumeSuggestion(documentJson: Record<string, unknown>, suggestion: ResumeSuggestion): Record<string, unknown> {
  validateSuggestionSupport(suggestion);
  const proposed = suggestion.proposed ?? {};
  const next = normalizeStructuredResumeDocument(documentJson);

  if (isRecord(proposed.document)) return normalizeStructuredResumeDocument(proposed.document);
  if (isRecord(proposed.documentPatch)) return normalizeStructuredResumeDocument(deepMerge(next, proposed.documentPatch));

  const sectionId = stringValue(proposed.sectionId ?? proposed.section ?? proposed.targetSection);
  if (sectionId && LIST_SECTIONS.includes(sectionId as (typeof LIST_SECTIONS)[number])) {
    return applyListSectionSuggestion(next, sectionId, proposed, suggestion.id);
  }

  const path = stringValue(proposed.path ?? proposed.field);
  if (path && proposed.value !== undefined) {
    return applyPathSuggestion(next, path, proposed.value);
  }

  if (typeof proposed.sectionId === 'string' && proposed.value !== undefined) {
    const sections = isRecord(next.sections) ? { ...next.sections } : {};
    sections[proposed.sectionId] = proposed.value;
    next.sections = sections;
    return next;
  }

  const accepted = Array.isArray(next.acceptedSuggestions) ? [...next.acceptedSuggestions] : [];
  accepted.push({ suggestionId: suggestion.id, proposed });
  next.acceptedSuggestions = accepted;
  return next;
}

export function validateSuggestionSupport(suggestion: Pick<ResumeSuggestion, 'type' | 'evidence'>): void {
  if (suggestion.type === 'add_supported_detail' && !stringValue(suggestion.evidence)) {
    throw new BadRequestException('Added resume facts require supporting evidence');
  }
}

function applyListSectionSuggestion(document: Record<string, unknown>, sectionId: string, proposed: Record<string, unknown>, suggestionId: string): Record<string, unknown> {
  const action = stringValue(proposed.action ?? proposed.operation ?? proposed.kind) ?? 'replace';
  const items = Array.isArray(document[sectionId]) ? [...document[sectionId] as ResumeListItem[]] : [];
  const itemId = stringValue(proposed.itemId ?? proposed.targetItemId);
  const index = itemId ? items.findIndex((item) => item.id === itemId) : -1;

  if (['remove', 'delete', 'deemphasize'].includes(action)) {
    if (index >= 0) items.splice(index, 1);
    document[sectionId] = items;
    return document;
  }

  if (action === 'reorder') {
    if (index >= 0) {
      const [item] = items.splice(index, 1);
      const toIndex = typeof proposed.toIndex === 'number' ? proposed.toIndex : items.length;
      items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, item);
    }
    document[sectionId] = items;
    return document;
  }

  const nextItem = normalizeListItem(proposed.value ?? proposed.item ?? proposed.text ?? proposed);
  nextItem.id = itemId || stringValue(nextItem.id) || `suggestion-${suggestionId}`;
  if (['add', 'append', 'insert'].includes(action) || index < 0) {
    const afterItemId = stringValue(proposed.afterItemId);
    const afterIndex = afterItemId ? items.findIndex((item) => item.id === afterItemId) : -1;
    items.splice(afterIndex >= 0 ? afterIndex + 1 : items.length, 0, nextItem);
  } else {
    items[index] = { ...items[index], ...nextItem, id: items[index].id };
  }
  document[sectionId] = items;
  return document;
}

function applyPathSuggestion(document: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.').map((item) => item.trim()).filter(Boolean);
  if (!keys.length) return document;
  if (keys.length > 1 && keys[0] === 'documentJson') keys.shift();
  let cursor = document;
  while (keys.length > 1) {
    const key = keys.shift()!;
    const current = cursor[key];
    cursor[key] = isRecord(current) ? { ...current } : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[0]] = value;
  return normalizeStructuredResumeDocument(document);
}

function normalizeListItem(value: unknown): ResumeListItem {
  if (typeof value === 'string') return { id: newId(), text: value };
  if (isRecord(value)) {
    const id = stringValue(value.id) ?? newId();
    const text = stringValue(value.text ?? value.title ?? value.name ?? value.value ?? value.description);
    return { ...value, id, ...(text ? { text } : {}) };
  }
  return { id: newId(), text: String(value ?? '') };
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isRecord(value) && isRecord(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
