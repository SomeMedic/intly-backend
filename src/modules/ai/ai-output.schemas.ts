import { z } from 'zod';

const commercialRecommendationSchema = z.object({
  pricingModel: z.enum(['fixed', 'hourly']).optional(),
  recommendedPrice: z.string().trim().max(200).optional(),
  recommendedRate: z.string().trim().max(200).optional(),
  estimatedHours: z.union([z.number().finite().nonnegative(), z.string().trim().max(200)]).optional(),
  estimatedDuration: z.string().trim().max(200).optional(),
}).passthrough();

export const opportunityAnalysisOutputSchema = z.object({
  aiScore: z.number().min(0).max(100),
  recommendation: z.string(),
  summary: z.string(),
  strengths: z.array(z.object({ title: z.string(), evidence: z.string().optional() })).default([]),
  risks: z.array(z.object({ title: z.string(), severity: z.enum(['low', 'medium', 'high']).optional(), evidence: z.string().optional() })).default([]),
  missingRequirements: z.array(z.object({ title: z.string(), evidence: z.string().optional() })).default([]),
  compensationBudgetAssessment: z.string().optional(),
  complexity: z.string().optional(),
  recommendedActions: z.array(z.string()).default([]),
  typeSpecific: z.object({ commercial: commercialRecommendationSchema.optional() }).catchall(z.unknown()).default({}),
});


const tenderShortText = z.string().trim().min(1).max(500);
const tenderMediumText = z.string().trim().min(1).max(2000);
const tenderOptionalMediumText = z.string().trim().max(2000).optional();
const tenderCitationSchema = z.object({
  tenderDocumentId: z.string().trim().min(1).max(160),
  section: z.string().trim().min(1).max(500).optional(),
  excerpt: z.string().trim().min(1).max(2000).optional(),
}).strict();
const tenderCitedFactSchema = z.object({
  title: tenderShortText,
  description: tenderOptionalMediumText,
  citations: z.array(tenderCitationSchema).min(1).max(8),
}).strict();
const tenderDateFactSchema = z.object({
  title: tenderShortText,
  date: z.string().trim().min(1).max(120),
  description: tenderOptionalMediumText,
  citations: z.array(tenderCitationSchema).min(1).max(8),
}).strict();

export const tenderDocumentAnalysisOutputSchema = z.object({
  summary: tenderMediumText,
  aiScore: z.number().min(0).max(100).optional(),
  recommendation: z.string().trim().max(2000).optional(),
  documents: z.array(z.object({
    tenderDocumentId: z.string().trim().min(1).max(160),
    summary: tenderMediumText,
    keyRequirements: z.array(tenderCitedFactSchema).max(50),
    dates: z.array(tenderDateFactSchema).max(30),
    risks: z.array(tenderCitedFactSchema).max(30),
    requiredDocuments: z.array(tenderCitedFactSchema).max(50),
    eligibilityReferences: z.array(tenderCitedFactSchema).max(50),
    financialTerms: z.array(tenderCitedFactSchema).max(30),
  }).strict()).min(1).max(50),
  crossDocumentFindings: z.array(z.object({
    title: tenderShortText,
    description: tenderMediumText,
    type: z.enum(['conflicting_dates', 'financial_mismatch', 'scope_inconsistency', 'other']),
    citations: z.array(tenderCitationSchema).min(2).max(12),
  }).strict()).max(50),
}).strict();

export const responseGenerationOutputSchema = z.object({
  documentJson: z.object({
    type: z.literal('doc').default('doc'),
    content: z.array(z.unknown()).default([]),
  }),
  markdownCache: z.string().optional(),
  summary: z.string().optional(),
});

export const resumeAdaptationOutputSchema = z.object({
  summary: z.string().optional(),
  documentJson: z.record(z.string(), z.unknown()).optional(),
  suggestions: z.array(z.object({
    id: z.string().optional(),
    type: z.enum(['emphasize_skill', 'rewrite_section', 'add_supported_detail', 'remove_irrelevant_detail', 'formatting', 'other']).default('other'),
    title: z.string(),
    rationale: z.string().optional(),
    evidence: z.string().optional(),
    proposed: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
});


const nonEmptyText = z.string().trim().min(1).max(20000);
const optionalText = z.string().trim().max(20000).optional();

export const EDITOR_SEMANTIC_BLOCK_TYPES = [
  'greeting',
  'intro',
  'experience-fit',
  'technical-fit',
  'motivation',
  'understanding',
  'approach',
  'experience',
  'price-timeline',
  'application-summary',
  'eligibility',
  'technical-response',
  'documents-checklist',
  'commercial-notes',
  'closing',
] as const;

export const EDITOR_NODE_TYPES = [
  'paragraph',
  'heading',
  'semanticBlock',
  'bulletList',
  'orderedList',
  'blockquote',
  'codeBlock',
  ...EDITOR_SEMANTIC_BLOCK_TYPES,
] as const;

export const EDITOR_TOOLS = [
  'rewriteSelection',
  'replaceBlock',
  'replaceDocument',
  'regenerateBlock',
  'shortenBlock',
  'changeTone',
  'emphasizeFact',
  'insertBefore',
  'insertAfter',
  'addParagraph',
  'updateHeading',
  'removeBlock',
] as const;

export const EDITOR_BLOCK_TARGET_TOOLS = [
  'replaceBlock',
  'regenerateBlock',
  'shortenBlock',
  'changeTone',
  'emphasizeFact',
  'insertBefore',
  'insertAfter',
  'addParagraph',
  'updateHeading',
  'removeBlock',
] as const;

export const EDITOR_SELECTION_TARGET_TOOLS = ['rewriteSelection', 'changeTone'] as const;
export const EDITOR_DOCUMENT_TARGET_TOOLS = ['replaceDocument'] as const;
export const EDITOR_INSERT_TOOLS = ['insertBefore', 'insertAfter'] as const;

export const editorNodeTypeSchema = z.enum(EDITOR_NODE_TYPES);

const editorSelectionTargetSchema = z.object({
  kind: z.literal('selection'),
  blockId: z.string().trim().min(1).max(160).optional(),
  selectionText: nonEmptyText,
  surroundingText: optionalText,
}).strict();

const editorBlockTargetSchema = z.object({
  kind: z.literal('block'),
  blockId: z.string().trim().min(1).max(160),
}).strict();

const editorDocumentTargetSchema = z.object({
  kind: z.literal('document'),
}).strict();

export const editorTargetSchema = z.discriminatedUnion('kind', [
  editorSelectionTargetSchema,
  editorBlockTargetSchema,
  editorDocumentTargetSchema,
]);

const editorTextContentSchema = z.object({
  text: nonEmptyText,
}).strict();

const editorTypedTextContentSchema = z.object({
  nodeType: editorNodeTypeSchema.optional(),
  text: nonEmptyText,
}).strict();

const editorBaseOperationSchema = z.object({
  baseRevision: z.number().int().positive(),
  explanation: z.string().trim().max(1000).optional(),
}).strict();

export const rewriteSelectionOperationSchema = editorBaseOperationSchema.extend({
  tool: z.literal('rewriteSelection'),
  target: editorSelectionTargetSchema,
  content: editorTextContentSchema,
}).strict();

const replaceBlockOperationSchema = editorBaseOperationSchema.extend({
  tool: z.literal('replaceBlock'),
  target: editorBlockTargetSchema,
  content: editorTypedTextContentSchema,
}).strict();

const documentOperationSchema = editorBaseOperationSchema.extend({
  tool: z.literal('replaceDocument'),
  target: editorDocumentTargetSchema,
  content: z.object({
    documentJson: z.object({ type: z.literal('doc'), content: z.array(z.unknown()) }).strict().optional(),
    markdown: nonEmptyText.optional(),
  }).strict().refine((content) => content.documentJson || content.markdown, 'replaceDocument requires documentJson or markdown'),
}).strict();

const blockTextOperationSchema = editorBaseOperationSchema.extend({
  tool: z.enum(['regenerateBlock', 'shortenBlock', 'emphasizeFact', 'addParagraph', 'updateHeading']),
  target: editorBlockTargetSchema,
  content: editorTextContentSchema,
}).strict();

const changeToneOperationSchema = editorBaseOperationSchema.extend({
  tool: z.literal('changeTone'),
  target: z.discriminatedUnion('kind', [editorSelectionTargetSchema, editorBlockTargetSchema]),
  content: editorTextContentSchema,
}).strict();

const insertOperationSchema = editorBaseOperationSchema.extend({
  tool: z.enum(EDITOR_INSERT_TOOLS),
  target: editorBlockTargetSchema,
  content: editorTypedTextContentSchema,
}).strict();

const removeBlockOperationSchema = editorBaseOperationSchema.extend({
  tool: z.literal('removeBlock'),
  target: editorBlockTargetSchema,
}).strict();

export const editorOperationSchema = z.discriminatedUnion('tool', [
  rewriteSelectionOperationSchema,
  replaceBlockOperationSchema,
  documentOperationSchema,
  blockTextOperationSchema,
  changeToneOperationSchema,
  insertOperationSchema,
  removeBlockOperationSchema,
]);

export const editorTransformOutputSchema = z.object({
  draftId: z.string().trim().min(1).max(160),
  baseRevision: z.number().int().positive(),
  operations: z.array(editorOperationSchema).min(1).max(20),
  explanation: z.string().trim().max(1000),
}).strict().superRefine((value, ctx) => {
  for (const [index, operation] of value.operations.entries()) {
    if (operation.baseRevision !== value.baseRevision) {
      ctx.addIssue({ code: 'custom', path: ['operations', index, 'baseRevision'], message: 'Operation baseRevision must match response baseRevision' });
    }
  }
});

export const schemaByTask = {
  opportunity_analysis: opportunityAnalysisOutputSchema,
  response_generation: responseGenerationOutputSchema,
  resume_adaptation: resumeAdaptationOutputSchema,
  document_extraction: z.record(z.string(), z.unknown()),
  tender_document_analysis: tenderDocumentAnalysisOutputSchema,
  editor_transform: editorTransformOutputSchema,
};


type JsonSchema = Record<string, unknown>;

function selectionTargetJsonSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'selectionText'],
    properties: {
      kind: { const: 'selection' },
      blockId: { type: 'string', minLength: 1, maxLength: 160 },
      selectionText: { type: 'string', minLength: 1, maxLength: 20000 },
      surroundingText: { type: 'string', maxLength: 20000 },
    },
  };
}

function blockTargetJsonSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'blockId'],
    properties: {
      kind: { const: 'block' },
      blockId: { type: 'string', minLength: 1, maxLength: 160 },
    },
  };
}

function documentTargetJsonSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: { kind: { const: 'document' } },
  };
}

function textContentJsonSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string', minLength: 1, maxLength: 20000 } },
  };
}

function typedTextContentJsonSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      nodeType: { type: 'string', enum: [...EDITOR_NODE_TYPES] },
      text: { type: 'string', minLength: 1, maxLength: 20000 },
    },
  };
}

function editorOperationJsonSchema(tool: string | readonly string[], target: JsonSchema, content: JsonSchema): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['tool', 'baseRevision', 'target', 'content'],
    properties: {
      tool: Array.isArray(tool) ? { enum: tool } : { const: tool },
      baseRevision: { type: 'integer', minimum: 1 },
      target,
      content,
      explanation: { type: 'string', maxLength: 1000 },
    },
  };
}


export const promptSchemaByTask: Record<string, Record<string, unknown>> = {
  opportunity_analysis: {
    type: 'object',
    required: ['aiScore', 'recommendation', 'summary', 'strengths', 'risks', 'missingRequirements', 'recommendedActions', 'typeSpecific'],
    properties: {
      aiScore: { type: 'number', minimum: 0, maximum: 100 },
      recommendation: { type: 'string' },
      summary: { type: 'string' },
      strengths: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, evidence: { type: 'string' } } } },
      risks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, severity: { enum: ['low', 'medium', 'high'] }, evidence: { type: 'string' } } } },
      missingRequirements: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, evidence: { type: 'string' } } } },
      recommendedActions: { type: 'array', items: { type: 'string' } },
      typeSpecific: {
        type: 'object',
        properties: {
          commercial: {
            type: 'object',
            description: 'Freelance recommendations supported by the provided request and profile. Omit unknown recommendations; amounts include currency and rate units.',
            properties: {
              pricingModel: { type: 'string', enum: ['fixed', 'hourly'] },
              recommendedPrice: { type: 'string', maxLength: 200 },
              recommendedRate: { type: 'string', maxLength: 200 },
              estimatedHours: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'string', maxLength: 200 }] },
              estimatedDuration: { type: 'string', maxLength: 200 },
            },
          },
        },
      },
    },
  },
  response_generation: {
    type: 'object',
    required: ['documentJson'],
    properties: {
      documentJson: { type: 'object', required: ['type', 'content'], properties: { type: { const: 'doc' }, content: { type: 'array' } } },
      markdownCache: { type: 'string' },
      summary: { type: 'string' },
    },
  },
  resume_adaptation: {
    type: 'object',
    required: ['suggestions'],
    properties: {
      summary: { type: 'string' },
      documentJson: { type: 'object' },
      suggestions: { type: 'array', items: { type: 'object', required: ['title', 'proposed'], properties: { id: { type: 'string' }, type: { type: 'string' }, title: { type: 'string' }, rationale: { type: 'string' }, evidence: { type: 'string' }, proposed: { type: 'object' } } } },
    },
  },
  editor_transform: {
    type: 'object',
    additionalProperties: false,
    required: ['draftId', 'baseRevision', 'operations', 'explanation'],
    properties: {
      draftId: { type: 'string', minLength: 1, maxLength: 160 },
      baseRevision: { type: 'integer', minimum: 1 },
      explanation: { type: 'string', maxLength: 1000 },
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          oneOf: [
            editorOperationJsonSchema('rewriteSelection', selectionTargetJsonSchema(), textContentJsonSchema()),
            editorOperationJsonSchema('replaceBlock', blockTargetJsonSchema(), typedTextContentJsonSchema()),
            editorOperationJsonSchema(['regenerateBlock', 'shortenBlock', 'emphasizeFact', 'addParagraph', 'updateHeading'], blockTargetJsonSchema(), textContentJsonSchema()),
            editorOperationJsonSchema('changeTone', { oneOf: [selectionTargetJsonSchema(), blockTargetJsonSchema()] }, textContentJsonSchema()),
            editorOperationJsonSchema([...EDITOR_INSERT_TOOLS], blockTargetJsonSchema(), typedTextContentJsonSchema()),
            {
              type: 'object',
              additionalProperties: false,
              required: ['tool', 'baseRevision', 'target'],
              properties: {
                tool: { const: 'removeBlock' },
                baseRevision: { type: 'integer', minimum: 1 },
                target: blockTargetJsonSchema(),
                explanation: { type: 'string', maxLength: 1000 },
              },
            },
            editorOperationJsonSchema('replaceDocument', documentTargetJsonSchema(), {
              type: 'object',
              additionalProperties: false,
              properties: {
                documentJson: { type: 'object', additionalProperties: true, required: ['type', 'content'], properties: { type: { const: 'doc' }, content: { type: 'array' } } },
                markdown: { type: 'string', minLength: 1, maxLength: 20000 },
              },
              anyOf: [{ required: ['documentJson'] }, { required: ['markdown'] }],
            }),
          ],
        },
      },
    },
  },
  document_extraction: { type: 'object' },
  tender_document_analysis: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'documents', 'crossDocumentFindings'],
    $defs: {
      citation: {
        type: 'object',
        additionalProperties: false,
        required: ['tenderDocumentId'],
        properties: {
          tenderDocumentId: { type: 'string', minLength: 1, maxLength: 160 },
          section: { type: 'string', minLength: 1, maxLength: 500 },
          excerpt: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
      citedFact: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'citations'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 500 },
          description: { type: 'string', maxLength: 2000 },
          citations: { type: 'array', minItems: 1, maxItems: 8, items: { $ref: '#/$defs/citation' } },
        },
      },
      dateFact: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date', 'citations'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 500 },
          date: { type: 'string', minLength: 1, maxLength: 120 },
          description: { type: 'string', maxLength: 2000 },
          citations: { type: 'array', minItems: 1, maxItems: 8, items: { $ref: '#/$defs/citation' } },
        },
      },
    },
    properties: {
      summary: { type: 'string', minLength: 1, maxLength: 2000 },
      aiScore: { type: 'number', minimum: 0, maximum: 100 },
      recommendation: { type: 'string', maxLength: 2000 },
      documents: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['tenderDocumentId', 'summary', 'keyRequirements', 'dates', 'risks', 'requiredDocuments', 'eligibilityReferences', 'financialTerms'],
          properties: {
            tenderDocumentId: { type: 'string', minLength: 1, maxLength: 160 },
            summary: { type: 'string', minLength: 1, maxLength: 2000 },
            keyRequirements: { type: 'array', maxItems: 50, items: { $ref: '#/$defs/citedFact' } },
            dates: { type: 'array', maxItems: 30, items: { $ref: '#/$defs/dateFact' } },
            risks: { type: 'array', maxItems: 30, items: { $ref: '#/$defs/citedFact' } },
            requiredDocuments: { type: 'array', maxItems: 50, items: { $ref: '#/$defs/citedFact' } },
            eligibilityReferences: { type: 'array', maxItems: 50, items: { $ref: '#/$defs/citedFact' } },
            financialTerms: { type: 'array', maxItems: 30, items: { $ref: '#/$defs/citedFact' } },
          },
        },
      },
      crossDocumentFindings: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'description', 'type', 'citations'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 500 },
            description: { type: 'string', minLength: 1, maxLength: 2000 },
            type: { type: 'string', enum: ['conflicting_dates', 'financial_mismatch', 'scope_inconsistency', 'other'] },
            citations: { type: 'array', minItems: 2, maxItems: 12, items: { $ref: '#/$defs/citation' } },
          },
        },
      },
    },
  },
};
