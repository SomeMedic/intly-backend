import { z } from 'zod';

import { editorTransformOutputSchema } from './ai-output.schemas';
import { validateRichDocumentJson } from './rich-document-validation';
import { AiAnalysis } from './schemas/ai-analysis.schema';

type EditorTransformOutput = z.infer<typeof editorTransformOutputSchema>;
type EditorOperation = EditorTransformOutput['operations'][number];
type EditorTarget = EditorOperation['target'];
type RequestTarget = { kind?: unknown; blockId?: unknown; selectionText?: unknown };
type EditorBlock = { id: string; nodeType: string; text: string };

export function validateEditorTransformOutputForRun(run: AiAnalysis, output: Record<string, unknown>): Record<string, unknown> {
  if (run.taskType !== 'editor_transform') return output;
  const parsed = output as EditorTransformOutput;
  const expectedDraftId = stringValue(run.metadata?.responseDraftId) ?? stringValue(run.prompt?.responseDraftId);
  const expectedRevision = numberValue(run.metadata?.baseRevision) ?? numberValue(run.prompt?.baseRevision);
  if (!expectedDraftId || !expectedRevision) throw new Error('Editor transform run is missing request draft metadata');
  if (parsed.draftId !== expectedDraftId) throw new Error('Editor transform draftId does not match requested draft');
  if (parsed.baseRevision !== expectedRevision) throw new Error('Editor transform baseRevision does not match requested revision');

  const request = record(run.prompt?.editorTransform) ?? record(record(run.prompt?.context)?.editorTransform);
  if (!request) throw new Error('Editor transform run is missing request scope');
  const requestTarget = record(request.target) as RequestTarget | undefined;
  if (!requestTarget || typeof requestTarget.kind !== 'string') throw new Error('Editor transform run is missing request target');
  const blocks = editorBlocks(request);
  const blockIds = new Set(blocks.map((block) => block.id));

  if (!['selection', 'block', 'document'].includes(requestTarget.kind)) throw new Error('Editor transform request target kind is unsupported');
  if (requestTarget.kind === 'selection' && parsed.operations.length !== 1) throw new Error('Editor transform selection requests require exactly one operation');
  parsed.operations.forEach((operation, index) => {
    validateOperationScope(operation, index, requestTarget, blocks, blockIds);
  });
  return output;
}

function validateOperationScope(operation: EditorOperation, index: number, requestTarget: RequestTarget, blocks: EditorBlock[], blockIds: Set<string>): void {
  const target = operation.target as EditorTarget;
  if (target.kind === 'document') {
    if (requestTarget.kind !== 'document') throw new Error(`Editor transform operation ${index} cannot replace the whole document for a ${requestTarget.kind} request`);
    const documentJson = operation.tool === 'replaceDocument' ? record(operation.content)?.documentJson : undefined;
    if (documentJson !== undefined) validateRichDocumentJson(documentJson, `operations.${index}.content.documentJson`);
    return;
  }

  const blockId = 'blockId' in target && typeof target.blockId === 'string' ? target.blockId : undefined;
  if (blockId && !blockIds.has(blockId)) throw new Error(`Editor transform operation ${index} targets a block outside the server editor context`);

  if (requestTarget.kind === 'selection') {
    if (target.kind !== 'selection') throw new Error(`Editor transform operation ${index} must stay within the requested selection`);
    const expectedSelectionText = stringValue(requestTarget.selectionText);
    if (!expectedSelectionText || normalized(target.selectionText) !== normalized(expectedSelectionText)) {
      throw new Error(`Editor transform operation ${index} selectionText does not match the requested selection`);
    }
    const expectedBlockId = stringValue(requestTarget.blockId);
    if (expectedBlockId && target.blockId !== expectedBlockId) throw new Error(`Editor transform operation ${index} selection blockId does not match the requested selection block`);
  }

  if (requestTarget.kind === 'block') {
    if (target.kind !== 'block') throw new Error(`Editor transform operation ${index} must use a block target for a block request`);
    const expectedBlockId = stringValue(requestTarget.blockId);
    if (!expectedBlockId) throw new Error('Editor transform block request is missing blockId');
    if (target.blockId !== expectedBlockId) {
      throw new Error(`Editor transform operation ${index} blockId does not match the requested block`);
    }
  }

  if (requestTarget.kind === 'document') {
    if (target.kind === 'selection') throw new Error(`Editor transform operation ${index} cannot use a selection target for a document request`);
    if (blockId && !blockIds.has(blockId)) throw new Error(`Editor transform operation ${index} targets a block outside the requested document`);
  }

  if (operation.tool === 'updateHeading') {
    const headingBlockId = target.kind === 'block' ? target.blockId : undefined;
    const block = blocks.find((candidate) => candidate.id === headingBlockId);
    if (block?.nodeType !== 'heading') throw new Error(`Editor transform operation ${index} updateHeading requires a heading block`);
  }
}

function editorBlocks(request: Record<string, unknown>): EditorBlock[] {
  const context = record(request.documentContext);
  const blocks = Array.isArray(context?.blocks) ? context.blocks : [];
  return blocks.flatMap((item) => {
    const block = record(item);
    const id = stringValue(block?.id);
    if (!id) return [];
    return [{ id, nodeType: stringValue(block?.nodeType) ?? 'paragraph', text: stringValue(block?.text) ?? '' }];
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
