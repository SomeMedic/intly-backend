import { BadRequestException, ConflictException, Injectable, OnModuleInit, Optional } from '@nestjs/common';

import { Actor } from '../../common/access';
import { newId } from '../../common/schema';
import { AiRunCompletionRegistry } from '../ai/ai-run-completion.registry';
import { validateRichDocumentJson } from '../ai/rich-document-validation';
import { AiService } from '../ai/ai.service';
import { AiAnalysis } from '../ai/schemas/ai-analysis.schema';
import { FilesService } from '../files';
import { NotificationsService } from '../notifications';
import { OpportunityUserStatesRepository } from '../opportunities/opportunity-user-states.repository';
import { normalizePipelineStatus, pipelineStagesForType } from '../opportunities/pipeline-definitions';
import { OpportunitiesRepository } from '../opportunities/opportunities.repository';
import { OpportunityType } from '../opportunities/schemas/opportunity.schema';
import { PipelineStatus } from '../opportunities/schemas/opportunity-user-state.schema';
import { TENDER_APPLICATION_SECTIONS, TENDER_APPLICATION_SECTION_SET } from '../opportunities/tender-application-sections';
import { ProfilesRepository } from '../profiles/profiles.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateResponseDraftDto, ExportResponseDto, GenerateResponseDto, SetResponseStatusDto, TransformResponseSelectionDto, UpdateResponseDraftDto } from './dto/response.dto';
import { WebhooksService } from '../webhooks';
import { renderDocumentExport } from './document-export';
import { ResponseDraft, ResponsePipelineHandoff } from './schemas/response-draft.schema';
import { ResponsesRepository } from './responses.repository';

const RESPONSE_FORMATS_BY_OPPORTUNITY_TYPE = {
  vacancy: ['short_response', 'full_response', 'cover_letter', 'telegram_chat', 'why_good_fit'],
  freelance: ['short_proposal', 'full_proposal', 'chat_message', 'commercial_proposal'],
  tender: ['commercial_proposal', 'application_draft', 'checklist_text'],
} as const;

type EditorTransformTarget =
  | { kind: 'selection'; selectionText: string; surroundingText?: string; blockId?: string }
  | { kind: 'block'; blockId: string }
  | { kind: 'document' };

type PinnedContextFact = {
  label: string;
  text: string;
  source?: string;
};

type EditorTransformRequest = {
  tool: string;
  target: EditorTransformTarget;
  documentContext: Record<string, unknown>;
  baseRevision: number;
  pinnedFacts?: PinnedContextFact[];
};

@Injectable()
export class ResponsesService implements OnModuleInit {
  constructor(
    private readonly responsesRepository: ResponsesRepository,
    private readonly opportunitiesRepository: OpportunitiesRepository,
    private readonly profilesRepository: ProfilesRepository,
    private readonly aiService: AiService,
    private readonly runCompletionRegistry: AiRunCompletionRegistry,
    private readonly filesService: FilesService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly webhooksService?: WebhooksService,
    @Optional() private readonly statesRepository?: OpportunityUserStatesRepository,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.runCompletionRegistry.register('responses.apply-generation', async (run) => this.handleAiTerminal(run));
  }

  async list(actor: Actor, query: { opportunityId?: string; profileId?: string }) {
    return { items: await this.responsesRepository.list(actor.id, query), nextCursor: null };
  }

  async get(actor: Actor, id: string) {
    const draft = await this.responsesRepository.getOwned(id, actor.id);
    return this.reconcilePipelineHandoff(actor, draft, { allowRetry: true, externalSideEffects: false });
  }

  async create(actor: Actor, dto: CreateResponseDraftDto): Promise<ResponseDraft> {
    const [opportunity] = await Promise.all([
      this.opportunitiesRepository.getById(dto.opportunityId),
      this.profilesRepository.getOwned(dto.profileId, actor.id),
    ]);
    this.assertFormatAllowed(opportunity.type, dto.format);
    return this.responsesRepository.create({
      userId: actor.id,
      opportunityId: opportunity._id,
      profileId: dto.profileId,
      opportunityType: opportunity.type,
      format: dto.format,
      documentJson: dto.documentJson ?? { type: 'doc', content: [] },
      markdownCache: dto.markdownCache,
      status: 'draft',
    });
  }

  async update(actor: Actor, id: string, dto: UpdateResponseDraftDto) {
    const documentJson = dto.documentJson;
    return this.responsesRepository.updateWithRevision(id, actor.id, dto.revision, {
      ...(documentJson !== undefined ? { documentJson, unresolvedPlaceholders: this.findPlaceholders(documentJson, dto.markdownCache) } : {}),
      ...(dto.markdownCache !== undefined ? { markdownCache: dto.markdownCache } : {}),
      ...(dto.proposedCommercialFields !== undefined ? { proposedCommercialFields: dto.proposedCommercialFields } : {}),
      ...(dto.checklist !== undefined ? { checklist: dto.checklist } : {}),
    });
  }

  async setStatus(actor: Actor, id: string, dto: SetResponseStatusDto) {
    const draft = await this.responsesRepository.getOwned(id, actor.id);
    let opportunity: unknown;
    if (dto.status === 'ready' || dto.status === 'sent' || dto.status === 'submitted') {
      opportunity = await this.opportunitiesRepository.getById(draft.opportunityId);
    }
    if (dto.status === 'submitted') {
      this.assertTenderExternalSubmission(opportunity, dto.confirmedExternalSubmission);
    } else if (dto.status === 'ready' || dto.status === 'sent') {
      this.assertReady(draft, opportunity);
    }
    const targetPipelineStatus = this.isOpportunityType(opportunity) ? this.pipelineTargetForResponse(opportunity.type, dto.status) : null;
    const sentAt = dto.status === 'sent' || dto.status === 'submitted' ? draft.sentAt ?? new Date() : undefined;
    const pipelineHandoff = this.statesRepository && targetPipelineStatus && sentAt ? this.pendingPipelineHandoff(draft, dto.status, targetPipelineStatus, sentAt) : undefined;
    let updated = await this.responsesRepository.updateWithRevision(id, actor.id, dto.revision, {
      status: dto.status,
      ...(sentAt ? { sentAt } : {}),
      ...(pipelineHandoff ? { pipelineHandoff } : {}),
    });
    updated = await this.reconcilePipelineHandoff(actor, updated, { opportunity, allowRetry: true, externalSideEffects: true });
    if (dto.status === 'submitted') {
      await Promise.all([
        this.notificationsService?.notify({ userId: actor.id, type: 'response.submitted', title: 'Response marked submitted', data: { responseId: id, opportunityId: draft.opportunityId } }),
        this.webhooksService?.emit(actor.id, 'response.submitted', { response: updated }),
      ]);
    }
    return updated;
  }

  async generate(actor: Actor, id: string, dto: GenerateResponseDto) {
    const draft = await this.responsesRepository.getOwned(id, actor.id);
    if (dto.revision !== undefined && dto.revision !== draft.revision) {
      throw new BadRequestException({ code: 'RESPONSE_DRAFT_REVISION_CONFLICT', message: 'Response draft revision conflict' });
    }
    if (this.hasContent(draft)) {
      throw new BadRequestException({
        code: 'RESPONSE_REGENERATION_REQUIRES_PREVIEW',
        message: 'Use an explicit replaceDocument editor transform with preview before regenerating a non-empty response draft',
      });
    }
    if (this.hasActiveGeneration(draft)) {
      throw new BadRequestException({ code: 'RESPONSE_GENERATION_ALREADY_RUNNING', generation: draft.generation });
    }
    const expectedGeneration = this.generationSnapshot(draft.generation) ?? {};
    const run = await this.aiService.createResponseGenerationRun({
      actor,
      opportunityId: draft.opportunityId,
      profileId: draft.profileId,
      responseDraftId: draft._id,
      format: draft.format,
      customPrompt: dto.customPrompt,
      baseRevision: draft.revision,
      pinnedFacts: this.validPinnedFacts(dto.pinnedFacts),
      expectedGeneration,
    });
    try {
      await this.responsesRepository.attachGeneration(id, actor.id, {
        runId: run._id,
        status: run.status,
        taskType: run.taskType,
        createdAt: (run as AiRunWithTimestamps).createdAt,
        baseRevision: draft.revision,
      }, { revision: draft.revision, generation: expectedGeneration });
    } catch (error) {
      await this.cancelSupersededRun(actor, run._id);
      throw error;
    }
    return run;
  }





  async transformSelection(actor: Actor, id: string, dto: TransformResponseSelectionDto) {
    const draft = await this.responsesRepository.getOwned(id, actor.id);
    if (draft.revision !== dto.revision) throw new BadRequestException('Response draft revision conflict');
    const editorTransform = this.validEditorTransform(draft, dto);
    return this.aiService.createEditorTransformRun({
      actor,
      opportunityId: draft.opportunityId,
      profileId: draft.profileId,
      responseDraftId: draft._id,
      baseRevision: draft.revision,
      pinnedFacts: editorTransform.pinnedFacts,
      editorTransform,
      selection: editorTransform.target.kind === 'selection' ? { target: editorTransform.target } : undefined,
      instruction: dto.instruction,
    });
  }

  async export(actor: Actor, id: string, dto: ExportResponseDto) {
    const draft = await this.responsesRepository.getOwned(id, actor.id);
    if (dto.revision !== undefined && dto.revision !== draft.revision) {
      throw new ConflictException({ code: 'RESPONSE_DRAFT_REVISION_CONFLICT', message: 'Response draft revision conflict' });
    }
    const opportunity = await this.opportunitiesRepository.getById(draft.opportunityId);
    this.assertReady(draft, opportunity);
    const rendered = renderDocumentExport(draft.documentJson, draft.markdownCache, `response-${draft.format}-${draft._id}`, dto.format, opportunity.title || 'INTLY');
    const file = await this.filesService.storeBuffer(actor.id, rendered.buffer, rendered.mimeType, rendered.filename, {
      kind: 'response_export',
      responseDraftId: draft._id,
      opportunityId: draft.opportunityId,
      profileId: draft.profileId,
      format: dto.format,
    });
    return { fileId: file._id, filename: file.originalName, mimeType: file.mimeType, size: file.size };
  }

  private async handleAiTerminal(run: AiAnalysis): Promise<void> {
    if (run.taskType !== 'response_generation') return;
    const responseDraftId = typeof run.metadata?.responseDraftId === 'string' ? run.metadata.responseDraftId : undefined;
    if (!responseDraftId) return;
    if (run.status === 'completed') {
      const documentJson = this.generatedDocument(run.structuredOutput);
      await this.responsesRepository.applyGeneration({
        id: responseDraftId,
        userId: run.userId,
        runId: run._id,
        documentJson,
        markdownCache: typeof run.structuredOutput?.markdownCache === 'string' ? run.structuredOutput.markdownCache : undefined,
        status: 'completed',
        baseRevision: typeof run.metadata?.baseRevision === 'number' ? run.metadata.baseRevision : undefined,
        ...(run.metadata && 'expectedGeneration' in run.metadata ? { expectedGeneration: this.generationSnapshot(run.metadata.expectedGeneration) ?? {} } : {}),
      });
      return;
    }
    if (run.status === 'failed' || run.status === 'cancelled') {
      await this.responsesRepository.applyGeneration({
        id: responseDraftId,
        userId: run.userId,
        runId: run._id,
        documentJson: { type: 'doc', content: [] },
        status: run.status,
        errorSummary: run.errorSummary,
        baseRevision: typeof run.metadata?.baseRevision === 'number' ? run.metadata.baseRevision : undefined,
        ...(run.metadata && 'expectedGeneration' in run.metadata ? { expectedGeneration: this.generationSnapshot(run.metadata.expectedGeneration) ?? {} } : {}),
      });
    }
  }

  private generatedDocument(output?: Record<string, unknown>): Record<string, unknown> {
    const documentJson = output?.documentJson;
    if (this.isDocumentJson(documentJson)) return validateRichDocumentJson(documentJson, 'documentJson');
    throw new BadRequestException('AI response did not include a valid documentJson');
  }

  private assertTenderExternalSubmission(opportunity: unknown, confirmedExternalSubmission?: boolean): void {
    const opportunityType = this.isRecord(opportunity) && typeof opportunity.type === 'string' ? opportunity.type : undefined;
    if (opportunityType !== 'tender') {
      throw new BadRequestException({
        code: 'RESPONSE_SUBMISSION_NOT_ALLOWED',
        message: 'Submitted status is only available for tender opportunities after external submission confirmation',
        details: { expectedType: 'tender', actualType: opportunityType ?? null, status: 'submitted' },
      });
    }
    if (confirmedExternalSubmission !== true) {
      throw new BadRequestException({
        code: 'RESPONSE_EXTERNAL_SUBMISSION_UNCONFIRMED',
        message: 'Confirm external tender submission before marking this response submitted',
        details: { status: 'submitted', opportunityType: 'tender', requiredFlag: 'confirmedExternalSubmission' },
      });
    }
  }

  private async reconcilePipelineHandoff(
    actor: Actor,
    draft: ResponseDraft,
    options: { opportunity?: unknown; allowRetry: boolean; externalSideEffects: boolean },
  ): Promise<ResponseDraft> {
    const handoff = this.parsePipelineHandoff(draft.pipelineHandoff);
    if (!handoff || !options.allowRetry || handoff.status === 'synced') return draft;
    const opportunity = options.opportunity ?? await this.opportunitiesRepository.getById(draft.opportunityId);
    if (!this.statesRepository || !this.isOpportunityType(opportunity) || !this.isPipelineStage(opportunity.type, handoff.targetPipelineStatus)) {
      return this.markPipelineHandoffError(draft, handoff, 'Pipeline handoff is not available for this response');
    }
    try {
      const responseStateEntry = this.responseStateEntryFromHandoff(handoff);
      const state = await this.recordResponseHandoffState({
        actor,
        opportunityType: opportunity.type,
        draft,
        targetPipelineStatus: handoff.targetPipelineStatus,
        responseStateEntry,
      });
      const normalized = normalizePipelineStatus(opportunity.type, state.pipelineStatus);
      if (options.externalSideEffects) {
        this.realtime?.publish(actor.id, 'pipeline.changed', {
          opportunityId: draft.opportunityId,
          profileId: draft.profileId,
          pipelineStatus: normalized.status,
          rawPipelineStatus: state.pipelineStatus,
          responseState: state.responseState,
        });
      }
      return this.markPipelineHandoffSynced(draft, handoff);
    } catch (error) {
      return this.markPipelineHandoffError(draft, handoff, error instanceof Error ? error.message : 'Pipeline handoff failed');
    }
  }

  private async recordResponseHandoffState(input: {
    actor: Actor;
    opportunityType: OpportunityType;
    draft: ResponseDraft;
    targetPipelineStatus: PipelineStatus;
    responseStateEntry: Record<string, unknown>;
  }): Promise<{ pipelineStatus: PipelineStatus; responseState: Record<string, unknown> }> {
    if (!this.statesRepository) throw new Error('Pipeline state repository is not configured');
    return this.statesRepository.recordResponseHandoff(
      input.actor.id,
      input.draft.opportunityId,
      input.draft.profileId,
      input.opportunityType,
      {
        format: String(input.responseStateEntry.format),
        latestResponse: input.responseStateEntry,
        updatedAt: String(input.responseStateEntry.updatedAt),
        pipelineStatus: input.targetPipelineStatus,
      },
    );
  }

  private pipelineTargetForResponse(type: OpportunityType, status: ResponseDraft['status']): PipelineStatus | null {
    if (status === 'sent') {
      if (type === 'vacancy') return 'Applied';
      if (type === 'freelance') return 'ResponseSent';
      return null;
    }
    if (status === 'submitted' && type === 'tender') return 'ApplicationSubmitted';
    return null;
  }

  private pendingPipelineHandoff(draft: ResponseDraft, status: ResponseDraft['status'], targetPipelineStatus: PipelineStatus, sentAt: Date): ResponsePipelineHandoff {
    const now = new Date().toISOString();
    const sentAtIso = sentAt.toISOString();
    return {
      id: newId(),
      status: 'pending',
      targetPipelineStatus,
      responseStatus: status,
      draftId: draft._id,
      format: draft.format,
      sentAt: sentAtIso,
      createdAt: now,
      updatedAt: now,
    };
  }

  private syncedPipelineHandoff(handoff: ResponsePipelineHandoff): ResponsePipelineHandoff {
    const now = new Date().toISOString();
    const { error: _error, ...rest } = handoff;
    return { ...rest, status: 'synced', syncedAt: now, updatedAt: now };
  }

  private async markPipelineHandoffSynced(draft: ResponseDraft, handoff: ResponsePipelineHandoff): Promise<ResponseDraft> {
    try {
      return await this.responsesRepository.updatePipelineHandoff(draft._id, draft.userId, handoff.id, this.syncedPipelineHandoff(handoff));
    } catch {
      return draft;
    }
  }

  private async markPipelineHandoffError(draft: ResponseDraft, handoff: ResponsePipelineHandoff, error: string): Promise<ResponseDraft> {
    try {
      return await this.responsesRepository.updatePipelineHandoff(draft._id, draft.userId, handoff.id, {
        ...handoff,
        status: 'error',
        error,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      return draft;
    }
  }

  private responseStateEntryFromHandoff(handoff: ResponsePipelineHandoff): Record<string, unknown> {
    return {
      draftId: handoff.draftId,
      format: handoff.format,
      status: handoff.responseStatus,
      sentAt: handoff.sentAt,
      updatedAt: handoff.createdAt,
    };
  }

  private isOpportunityType(value: unknown): value is { type: OpportunityType } {
    return this.isRecord(value) && (value.type === 'vacancy' || value.type === 'freelance' || value.type === 'tender');
  }

  private isPipelineStage(type: OpportunityType, status: string): status is PipelineStatus {
    return (pipelineStagesForType(type) as readonly string[]).includes(status);
  }

  private parsePipelineHandoff(value: unknown): ResponsePipelineHandoff | null {
    if (!this.isRecord(value)) return null;
    if (typeof value.id !== 'string' || !value.id) return null;
    if (value.status !== 'pending' && value.status !== 'error' && value.status !== 'synced') return null;
    if (typeof value.targetPipelineStatus !== 'string' || !value.targetPipelineStatus) return null;
    if (value.responseStatus !== 'sent' && value.responseStatus !== 'submitted') return null;
    if (typeof value.draftId !== 'string' || !value.draftId) return null;
    if (typeof value.format !== 'string' || !value.format) return null;
    if (typeof value.sentAt !== 'string' || !value.sentAt) return null;
    if (typeof value.createdAt !== 'string' || !value.createdAt) return null;
    if (typeof value.updatedAt !== 'string' || !value.updatedAt) return null;
    return value as ResponsePipelineHandoff;
  }

  private assertReady(draft: ResponseDraft, opportunity?: unknown): void {
    if (!this.hasContent(draft)) {
      throw new BadRequestException({ code: 'RESPONSE_CONTENT_EMPTY', message: 'Response draft cannot be marked ready without meaningful text content' });
    }
    if (this.hasStaleOrPendingGeneration(draft)) {
      throw new BadRequestException({ code: 'RESPONSE_GENERATION_NOT_CURRENT', generation: draft.generation });
    }
    const placeholders = draft.unresolvedPlaceholders?.length ? draft.unresolvedPlaceholders : this.findPlaceholders(draft.documentJson, draft.markdownCache);
    if (placeholders.length) {
      throw new BadRequestException({ code: 'RESPONSE_PLACEHOLDERS_UNRESOLVED', placeholders });
    }
    const checklist = this.checklistStatus(draft.checklist);
    if (!checklist.complete) {
      throw new BadRequestException({ code: 'RESPONSE_CHECKLIST_INCOMPLETE', required: checklist.required, missing: checklist.missing });
    }
    this.assertTenderApplicationSections(draft, opportunity);
  }

  private assertTenderApplicationSections(draft: ResponseDraft, opportunity?: unknown): void {
    if (!this.isRecord(opportunity) || opportunity.type !== 'tender') return;
    const tenderData = this.isRecord(opportunity.tenderData) ? opportunity.tenderData : {};
    if (!('requiredApplicationSections' in tenderData)) return;
    const configured = tenderData.requiredApplicationSections;
    if (!Array.isArray(configured)) {
      throw new BadRequestException({ code: 'TENDER_APPLICATION_SECTIONS_INVALID', message: 'Tender requiredApplicationSections must be an array', allowed: TENDER_APPLICATION_SECTIONS, details: { allowed: TENDER_APPLICATION_SECTIONS } });
    }
    const required = configured.map((section) => (typeof section === 'string' ? section.trim() : ''));
    const invalid = required.filter((section) => !TENDER_APPLICATION_SECTION_SET.has(section));
    if (invalid.length) {
      throw new BadRequestException({ code: 'TENDER_APPLICATION_SECTIONS_INVALID', message: 'Tender requiredApplicationSections contains unsupported sections', invalid, allowed: TENDER_APPLICATION_SECTIONS, details: { invalid, allowed: TENDER_APPLICATION_SECTIONS } });
    }
    const missing = Array.from(new Set(required)).filter((section) => !this.hasMeaningfulTenderSection(draft.documentJson, section));
    if (missing.length) {
      throw new BadRequestException({ code: 'TENDER_APPLICATION_SECTIONS_MISSING', message: 'Tender response is missing required application sections', required: Array.from(new Set(required)), missing, details: { required: Array.from(new Set(required)), missing } });
    }
  }

  private hasMeaningfulTenderSection(value: unknown, section: string): boolean {
    if (Array.isArray(value)) return value.some((item) => this.hasMeaningfulTenderSection(item, section));
    if (!this.isRecord(value)) return false;
    if (this.tenderSectionType(value) === section && this.extractText(value).trim()) return true;
    return this.hasMeaningfulTenderSection(value.content, section);
  }

  private tenderSectionType(node: Record<string, unknown>): string | undefined {
    const attrs = this.isRecord(node.attrs) ? node.attrs : {};
    if (typeof attrs.semanticType === 'string') {
      const semanticType = attrs.semanticType.trim();
      if (/^[a-z][a-z0-9-]{0,63}$/.test(semanticType) && semanticType !== 'generic') {
        return TENDER_APPLICATION_SECTION_SET.has(semanticType) ? semanticType : undefined;
      }
    }
    const nodeType = typeof node.type === 'string' ? node.type : '';
    return TENDER_APPLICATION_SECTION_SET.has(nodeType) ? nodeType : undefined;
  }

  private hasContent(draft: ResponseDraft): boolean {
    if (draft.markdownCache?.trim()) return true;
    return this.extractText(draft.documentJson).trim().length > 0;
  }

  private hasStaleOrPendingGeneration(draft: ResponseDraft): boolean {
    const status = typeof draft.generation?.status === 'string' ? draft.generation.status : undefined;
    return status === 'queued' || status === 'running' || status === 'stale';
  }


  private generationSnapshot(value: unknown): { runId?: string; status?: string } | undefined {
    if (!this.isRecord(value)) return undefined;
    const runId = typeof value.runId === 'string' && value.runId.trim() ? value.runId.trim() : undefined;
    const status = typeof value.status === 'string' && value.status.trim() ? value.status.trim() : undefined;
    return { ...(runId ? { runId } : {}), ...(status ? { status } : {}) };
  }

  private hasActiveGeneration(draft: ResponseDraft): boolean {
    const status = typeof draft.generation?.status === 'string' ? draft.generation.status : undefined;
    return status === 'queued' || status === 'running';
  }

  private async cancelSupersededRun(actor: Actor, runId: string): Promise<void> {
    try {
      await this.aiService.cancel(actor, runId);
    } catch {
      // The AI run may have already reached a terminal status between creation and attach.
    }
  }


  private checklistStatus(checklist?: Record<string, unknown>): { complete: boolean; required: string[]; missing: string[] } {
    const required = ['factsChecked', 'requirementsCovered', 'noUnresolvedPlaceholders', 'userReviewed'];
    if (!checklist || Object.keys(checklist).length === 0) return { complete: false, required, missing: required };
    const missing = required.filter((key) => checklist[key] !== true);
    const items = checklist.items;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!this.isRecord(item) || item.required === false) continue;
        const done = item.checked === true || item.status === 'done' || item.status === 'passed';
        if (!done) missing.push(typeof item.id === 'string' ? item.id : typeof item.label === 'string' ? item.label : 'checklistItem');
      }
    }
    return { complete: missing.length === 0, required, missing: Array.from(new Set(missing)) };
  }

  private extractText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((item) => this.extractText(item)).join(' ');
    if (!this.isRecord(value)) return '';
    const ownText = typeof value.text === 'string' ? value.text : '';
    return [ownText, this.extractText(value.content)].filter(Boolean).join(' ');
  }

  private validEditorTransform(draft: ResponseDraft, dto: TransformResponseSelectionDto): EditorTransformRequest {
    const requestedTarget = this.requestedEditorTarget(dto);
    const target = this.validEditorTarget(draft, requestedTarget);
    const tool = this.validEditorTool(dto.tool, target.kind);
    this.assertEditorToolCompatibleWithCurrentBlock(draft, tool, target);
    const serverContext = this.serverEditorContext(draft, target);
    const pinnedFacts = this.validPinnedFacts(dto.pinnedFacts);
    return {
      tool,
      target,
      documentContext: serverContext,
      baseRevision: draft.revision,
      ...(pinnedFacts.length ? { pinnedFacts } : {}),
    };
  }

  private requestedEditorTarget(dto: TransformResponseSelectionDto): Record<string, unknown> {
    if (this.isRecord(dto.target)) return dto.target;
    if (this.isRecord(dto.selection)) {
      if (this.isRecord(dto.selection.target)) return dto.selection.target;
      return dto.selection;
    }
    throw new BadRequestException({ code: 'RESPONSE_EDITOR_TARGET_INVALID', message: 'Editor transform target is required' });
  }

  private validEditorTarget(draft: ResponseDraft, target: Record<string, unknown>): EditorTransformTarget {
    if (target.kind === 'selection') return this.validSelectionTarget(draft, target);
    if (target.kind === 'block') return this.validBlockTarget(draft, target);
    if (target.kind === 'document') return { kind: 'document' };
    throw new BadRequestException({ code: 'RESPONSE_EDITOR_TARGET_INVALID', message: 'Unsupported editor target kind' });
  }

  private validSelectionTarget(draft: ResponseDraft, target: Record<string, unknown>): Extract<EditorTransformTarget, { kind: 'selection' }> {
    if (typeof target.selectionText !== 'string' || !target.selectionText.trim()) {
      throw new BadRequestException({ code: 'RESPONSE_EDITOR_SELECTION_EMPTY', message: 'selectionText is required for editor transforms' });
    }
    const selectionText = target.selectionText.trim();
    const blocks = this.editorBlocks(draft.documentJson);
    const blockId = typeof target.blockId === 'string' && target.blockId.trim() ? target.blockId.trim() : undefined;
    if (blockId) {
      const block = blocks.find((candidate) => candidate.id === blockId);
      if (!block) throw new BadRequestException({ code: 'RESPONSE_EDITOR_BLOCK_NOT_FOUND', message: 'Editor block target is not part of the current response draft' });
      if (!this.includesNormalizedText(block.text, selectionText)) throw new BadRequestException({ code: 'RESPONSE_EDITOR_SELECTION_STALE', message: 'Selected text is not present in the current target block' });
    } else if (!this.includesNormalizedText(this.extractText(draft.documentJson), selectionText)) {
      throw new BadRequestException({ code: 'RESPONSE_EDITOR_SELECTION_STALE', message: 'Selected text is not present in the current response draft' });
    }
    const surroundingText = this.surroundingTextForSelection(draft, selectionText, blockId);
    return { kind: 'selection', ...(blockId ? { blockId } : {}), selectionText, ...(surroundingText ? { surroundingText } : {}) };
  }

  private validBlockTarget(draft: ResponseDraft, target: Record<string, unknown>): Extract<EditorTransformTarget, { kind: 'block' }> {
    const blockId = typeof target.blockId === 'string' ? target.blockId.trim() : '';
    if (!blockId) throw new BadRequestException({ code: 'RESPONSE_EDITOR_BLOCK_REQUIRED', message: 'blockId is required for block editor transforms' });
    if (!this.editorBlocks(draft.documentJson).some((block) => block.id === blockId)) {
      throw new BadRequestException({ code: 'RESPONSE_EDITOR_BLOCK_NOT_FOUND', message: 'Editor block target is not part of the current response draft' });
    }
    return { kind: 'block', blockId };
  }

  private assertEditorToolCompatibleWithCurrentBlock(draft: ResponseDraft, tool: string, target: EditorTransformTarget): void {
    if (tool !== 'updateHeading') return;
    if (target.kind !== 'block') throw new BadRequestException({ code: 'RESPONSE_EDITOR_TOOL_INVALID', message: 'updateHeading requires a heading block target' });
    const block = this.editorBlocks(draft.documentJson).find((candidate) => candidate.id === target.blockId);
    if (block?.nodeType !== 'heading') {
      throw new BadRequestException({ code: 'RESPONSE_EDITOR_TARGET_INVALID', message: 'updateHeading is available only for heading blocks' });
    }
  }

  private validEditorTool(tool: string | undefined, targetKind: string): string {
    const normalized = typeof tool === 'string' && tool.trim() ? tool.trim() : targetKind === 'selection' ? 'rewriteSelection' : targetKind === 'document' ? 'replaceDocument' : 'replaceBlock';
    const selectionTools = new Set(['rewriteSelection', 'changeTone']);
    const blockTools = new Set(['replaceBlock', 'regenerateBlock', 'shortenBlock', 'changeTone', 'emphasizeFact', 'insertBefore', 'insertAfter', 'addParagraph', 'removeBlock', 'updateHeading']);
    const documentTools = new Set(['replaceDocument']);
    const allowed = targetKind === 'selection' ? selectionTools : targetKind === 'block' ? blockTools : documentTools;
    if (!allowed.has(normalized)) throw new BadRequestException({ code: 'RESPONSE_EDITOR_TOOL_INVALID', message: `Tool ${normalized} is not allowed for ${targetKind} target` });
    return normalized;
  }

  private serverEditorContext(draft: ResponseDraft, target: EditorTransformTarget): Record<string, unknown> {
    const blocks = this.editorBlocks(draft.documentJson);
    if (target.kind === 'document') {
      return {
        draftId: draft._id,
        baseRevision: draft.revision,
        target,
        blocks,
        text: this.extractText(draft.documentJson).slice(0, 20000),
      };
    }
    if (target.kind === 'block') {
      const targetBlock = blocks.find((block) => block.id === target.blockId);
      return {
        draftId: draft._id,
        baseRevision: draft.revision,
        target,
        blocks: targetBlock ? [targetBlock] : [],
        surroundingText: this.surroundingTextForBlock(blocks, target.blockId),
      };
    }
    const targetBlock = target.blockId ? blocks.find((block) => block.id === target.blockId) : undefined;
    return {
      draftId: draft._id,
      baseRevision: draft.revision,
      target,
      blocks: targetBlock ? [targetBlock] : [],
      surroundingText: target.surroundingText ?? this.surroundingTextForSelection(draft, target.selectionText, target.blockId),
    };
  }

  private editorBlocks(documentJson?: Record<string, unknown>): Array<{ id: string; index: number; nodeType: string; text: string }> {
    const content = Array.isArray(documentJson?.content) ? documentJson.content : [];
    return content.filter(this.isRecord).map((node, index) => ({
      id: this.editorBlockId(node, index),
      index,
      nodeType: typeof node.type === 'string' ? node.type : 'paragraph',
      text: this.normalizedWhitespace(this.extractText(node)),
    }));
  }

  private editorBlockId(node: Record<string, unknown>, index: number): string {
    const attrs = this.isRecord(node.attrs) ? node.attrs : {};
    for (const key of ['id', 'blockId', 'dataId', 'data-block-id']) {
      const value = attrs[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return `block-${index + 1}`;
  }

  private surroundingTextForBlock(blocks: Array<{ id: string; index: number; nodeType: string; text: string }>, blockId: string): string {
    const index = blocks.findIndex((block) => block.id === blockId);
    if (index < 0) return '';
    return blocks.slice(Math.max(0, index - 1), Math.min(blocks.length, index + 2)).map((block) => block.text).filter(Boolean).join('\n').slice(0, 4000);
  }

  private surroundingTextForSelection(draft: ResponseDraft, selectionText: string, blockId?: string): string {
    const blocks = this.editorBlocks(draft.documentJson);
    if (blockId) return this.surroundingTextForBlock(blocks, blockId);
    const fullText = this.extractText(draft.documentJson);
    const index = this.normalizedTextIndex(fullText, selectionText);
    if (index < 0) return fullText.slice(0, 2000);
    return fullText.slice(Math.max(0, index - 1000), Math.min(fullText.length, index + selectionText.length + 1000));
  }

  private includesNormalizedText(source: string, needle: string): boolean {
    return this.normalizedWhitespace(source).includes(this.normalizedWhitespace(needle));
  }

  private normalizedTextIndex(source: string, needle: string): number {
    const normalizedSource = this.normalizedWhitespace(source);
    const normalizedNeedle = this.normalizedWhitespace(needle);
    const normalizedIndex = normalizedSource.indexOf(normalizedNeedle);
    if (normalizedIndex < 0) return -1;
    let sourceIndex = 0;
    let normalizedCount = 0;
    let inWhitespace = false;
    while (sourceIndex < source.length && normalizedCount < normalizedIndex) {
      if (/\s/.test(source[sourceIndex])) {
        if (!inWhitespace) {
          normalizedCount += 1;
          inWhitespace = true;
        }
      } else {
        normalizedCount += 1;
        inWhitespace = false;
      }
      sourceIndex += 1;
    }
    return sourceIndex;
  }

  private normalizedWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private validPinnedFacts(value: unknown): PinnedContextFact[] {
    if (!Array.isArray(value)) return [];
    const facts: PinnedContextFact[] = [];
    for (const item of value.slice(0, 20)) {
      if (!this.isRecord(item)) continue;
      const label = this.compactText(item.label, 120);
      const text = this.compactText(item.text, 1200);
      const source = this.compactText(item.source, 160);
      if (!label || !text) continue;
      facts.push({ label, text, ...(source ? { source } : {}) });
    }
    return facts;
  }

  private compactText(value: unknown, maxLength: number): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
  }

  private assertFormatAllowed(opportunityType: string, format: string): void {
    const allowed = RESPONSE_FORMATS_BY_OPPORTUNITY_TYPE[opportunityType as keyof typeof RESPONSE_FORMATS_BY_OPPORTUNITY_TYPE];
    if (!allowed || !(allowed as readonly string[]).includes(format)) {
      throw new BadRequestException({ code: 'RESPONSE_FORMAT_NOT_ALLOWED', message: `Format ${format} is not available for ${opportunityType} opportunities` });
    }
  }

  private findPlaceholders(documentJson?: Record<string, unknown>, markdownCache?: string): string[] {
    const documentText = this.placeholderText(documentJson);
    if (documentText.trim()) return this.placeholdersFromSource(documentText);
    return this.placeholdersFromSource(this.canonicalMarkdownEscapes(markdownCache ?? ''));
  }

  private placeholdersFromSource(source: string): string[] {
    const placeholders = new Map<string, string>();
    const matches = source.match(/\{\{[^{}]{1,120}\}\}|\[\[[^\[\]]{1,120}\]\]/g) ?? [];
    for (const match of matches) {
      placeholders.set(match, match);
      if (placeholders.size >= 50) return Array.from(placeholders.values());
    }
    return Array.from(placeholders.values());
  }

  private placeholderText(value: unknown, boundary = true): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((item) => this.placeholderText(item, boundary)).join(boundary ? ' ' : '');
    if (!this.isRecord(value)) return '';
    const ownText = typeof value.text === 'string' ? value.text : '';
    const content = this.placeholderText(value.content, this.hasPlaceholderBlockChildren(value.content));
    return `${ownText}${content}`;
  }

  private hasPlaceholderBlockChildren(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return value.some((item) => this.isRecord(item) && typeof item.type === 'string' && !['text', 'hardBreak'].includes(item.type));
  }

  private canonicalMarkdownEscapes(value: string): string {
    return value.replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, '$1');
  }

  private isDocumentJson(value: unknown): value is Record<string, unknown> {
    return this.isRecord(value) && value.type === 'doc' && Array.isArray(value.content);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

type AiRunWithTimestamps = { createdAt?: Date };
