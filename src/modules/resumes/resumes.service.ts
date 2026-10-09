import { BadRequestException, ConflictException, Injectable, OnModuleInit, Optional } from '@nestjs/common';

import { Actor } from '../../common/access';
import { AiRunCompletionRegistry } from '../ai/ai-run-completion.registry';
import { FilesService } from '../files';
import { NotificationsService } from '../notifications';
import { AiService } from '../ai/ai.service';
import { AiAnalysis } from '../ai/schemas/ai-analysis.schema';
import { OpportunitiesRepository } from '../opportunities/opportunities.repository';
import { ProfilesRepository } from '../profiles/profiles.repository';
import { renderDocumentExport } from '../responses/document-export';
import { WebhooksService } from '../webhooks';
import { CreateResumeAdaptationDto, CreateResumeDto, ExportResumeDto, RevisionDto, UndoResumeReorderDto, UpdateResumeAdaptationDto, UpdateResumeDto } from './dto/resume.dto';
import { applyResumeSuggestion, normalizeStructuredResumeDocument } from './resume-adaptation-engine';
import { resumeDocumentForExport, resumeExportDisplayTitle, resumeExportTitle } from './resume-export-document';
import { RESUME_KINDS, Resume, ResumeKind } from './schemas/resume.schema';
import { ResumeAdaptation, ResumeSuggestion } from './schemas/resume-adaptation.schema';
import { ResumesRepository } from './resumes.repository';

const REORDERABLE_RESUME_SECTIONS = ['skills', 'experience', 'projects', 'education', 'languages', 'links'] as const;

@Injectable()
export class ResumesService implements OnModuleInit {
  constructor(
    private readonly resumesRepository: ResumesRepository,
    private readonly opportunitiesRepository: OpportunitiesRepository,
    private readonly profilesRepository: ProfilesRepository,
    private readonly aiService: AiService,
    private readonly runCompletionRegistry: AiRunCompletionRegistry,
    private readonly filesService: FilesService,
    @Optional() private readonly notificationsService?: NotificationsService,
    @Optional() private readonly webhooksService?: WebhooksService,
  ) {}

  onModuleInit(): void {
    this.runCompletionRegistry.register('resumes.apply-adaptation', async (run) => this.handleAiTerminal(run));
  }

  listResumes(actor: Actor, query: { profileId?: string; kind?: string }) {
    const kind = RESUME_KINDS.includes(query.kind as ResumeKind) ? query.kind as ResumeKind : undefined;
    return this.resumesRepository.listResumes(actor.id, { ...(query.profileId ? { profileId: query.profileId } : {}), ...(kind ? { kind } : {}) }).then((items) => ({ items, nextCursor: null }));
  }

  async createResume(actor: Actor, dto: CreateResumeDto): Promise<Resume> {
    if (dto.profileId) await this.profilesRepository.getOwned(dto.profileId, actor.id);
    return this.resumesRepository.createResume({
      userId: actor.id,
      profileId: dto.profileId,
      kind: 'base',
      title: dto.title,
      documentJson: normalizeStructuredResumeDocument(dto.documentJson ?? {}),
      markdownCache: dto.markdownCache,
      sourceFileId: dto.sourceFileId,
      status: 'draft',
    });
  }

  getResume(actor: Actor, id: string) {
    return this.resumesRepository.getResumeOwned(id, actor.id);
  }

  updateResume(actor: Actor, id: string, dto: UpdateResumeDto) {
    const patch: Partial<Resume> = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.documentJson !== undefined ? { documentJson: normalizeStructuredResumeDocument(dto.documentJson) } : {}),
      ...(dto.markdownCache !== undefined ? { markdownCache: dto.markdownCache } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    };
    const unset: Array<keyof Resume> = [];
    if (dto.profileId !== undefined) {
      const nextProfileId = dto.profileId;
      if (typeof nextProfileId === 'string' && nextProfileId.length > 0) {
        return this.profilesRepository.getOwned(nextProfileId, actor.id).then(() => this.resumesRepository.updateResumeWithRevision(id, actor.id, dto.revision, { ...patch, profileId: nextProfileId }, unset));
      }
      unset.push('profileId');
    }
    return this.resumesRepository.updateResumeWithRevision(id, actor.id, dto.revision, patch, unset);
  }

  listAdaptations(actor: Actor, query: { opportunityId?: string; profileId?: string; baseResumeId?: string; deleted?: string }) {
    return this.resumesRepository.listAdaptations(actor.id, {
      ...(query.opportunityId ? { opportunityId: query.opportunityId } : {}),
      ...(query.profileId ? { profileId: query.profileId } : {}),
      ...(query.baseResumeId ? { baseResumeId: query.baseResumeId } : {}),
      ...(query.deleted === 'only' ? { deleted: 'only' as const } : {}),
    }).then((items) => ({ items, nextCursor: null }));
  }

  async createAdaptation(actor: Actor, opportunityId: string, dto: CreateResumeAdaptationDto): Promise<ResumeAdaptation> {
    const [opportunity, profile, baseResume] = await Promise.all([
      this.opportunitiesRepository.getById(opportunityId),
      this.profilesRepository.getOwned(dto.profileId, actor.id),
      this.resumesRepository.getResumeOwned(dto.baseResumeId, actor.id),
    ]);
    if (baseResume.kind !== 'base') {
      throw new BadRequestException('Only base resumes can be adapted');
    }
    if (!['vacancy', 'freelance'].includes(String(opportunity.type))) {
      throw new BadRequestException('Resume adaptation supports only vacancies and freelance opportunities');
    }
    const adaptation = await this.resumesRepository.createAdaptation({
      userId: actor.id,
      profileId: profile._id,
      opportunityId: opportunity._id,
      baseResumeId: baseResume._id,
      documentJson: normalizeStructuredResumeDocument(baseResume.documentJson),
      markdownCache: baseResume.markdownCache,
      suggestions: [],
      status: 'generating',
    });
    const run = await this.aiService.createResumeAdaptationRun({
      actor,
      opportunityId: opportunity._id,
      profileId: profile._id,
      baseResumeId: baseResume._id,
      adaptationId: adaptation._id,
      baseResume: this.toAiBaseResume(baseResume),
      customPrompt: dto.customPrompt,
    });
    return this.resumesRepository.attachAdaptationRun(adaptation._id, actor.id, run._id);
  }

  getAdaptation(actor: Actor, id: string) {
    return this.resumesRepository.getAdaptationOwned(id, actor.id);
  }

  updateAdaptation(actor: Actor, id: string, dto: UpdateResumeAdaptationDto) {
    return this.resumesRepository.updateAdaptationWithRevision(id, actor.id, dto.revision, {
      ...(dto.documentJson !== undefined ? { documentJson: normalizeStructuredResumeDocument(dto.documentJson) } : {}),
      ...(dto.markdownCache !== undefined ? { markdownCache: dto.markdownCache } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    });
  }

  async acceptSuggestion(actor: Actor, id: string, suggestionId: string, dto: RevisionDto) {
    const adaptation = await this.resumesRepository.getAdaptationOwned(id, actor.id);
    const suggestion = this.findSuggestion(adaptation, suggestionId);
    if (suggestion.status !== 'pending') throw new BadRequestException('Resume suggestion is already decided');
    const suggestions = adaptation.suggestions.map((item) => item.id === suggestionId ? { ...item, status: 'accepted' as const, decidedAt: new Date() } : item);
    const documentJson = this.applySuggestion(adaptation.documentJson, suggestion);
    return this.resumesRepository.updateAdaptationWithRevision(id, actor.id, dto.revision, {
      suggestions,
      documentJson,
      status: 'editing',
    });
  }

  async rejectSuggestion(actor: Actor, id: string, suggestionId: string, dto: RevisionDto) {
    const adaptation = await this.resumesRepository.getAdaptationOwned(id, actor.id);
    const suggestion = this.findSuggestion(adaptation, suggestionId);
    if (suggestion.status !== 'pending') throw new BadRequestException('Resume suggestion is already decided');
    const suggestions = adaptation.suggestions.map((item) => item.id === suggestionId ? { ...item, status: 'rejected' as const, decidedAt: new Date() } : item);
    return this.resumesRepository.updateAdaptationWithRevision(id, actor.id, dto.revision, { suggestions });
  }

  async undoReorderSuggestion(actor: Actor, id: string, suggestionId: string, dto: UndoResumeReorderDto) {
    const adaptation = await this.resumesRepository.getAdaptationOwned(id, actor.id);
    const suggestion = this.findSuggestion(adaptation, suggestionId);
    if (suggestion.status !== 'accepted') throw new BadRequestException('Only accepted resume reorder suggestions can be undone');
    if (!this.isReorderSuggestion(suggestion)) throw new BadRequestException('Resume suggestion is not a reorder');
    const sectionId = this.reorderSectionId(suggestion);
    if (!sectionId) throw new BadRequestException('Resume reorder section is not supported');

    const currentItems = this.resumeListItems(adaptation.documentJson[sectionId]);
    const currentIds = currentItems.map((item) => item.id);
    this.assertExactOrderSet(dto.order, currentIds);
    if (this.sameOrder(dto.order, currentIds)) throw new BadRequestException('Resume reorder undo order must differ from the current order');
    const requestedItems = dto.order.map((itemId) => currentItems.find((item) => item.id === itemId)!);
    const replay = applyResumeSuggestion({ ...adaptation.documentJson, [sectionId]: requestedItems }, suggestion);
    const replayIds = this.resumeListItems(replay[sectionId]).map((item) => item.id);
    if (!this.sameOrder(replayIds, currentIds)) throw new BadRequestException('Resume reorder undo does not match the accepted suggestion');

    const suggestions = adaptation.suggestions.map((item) => {
      if (item.id !== suggestionId) return item;
      const { decidedAt: _decidedAt, ...rest } = item;
      return { ...rest, status: 'pending' as const };
    });
    return this.resumesRepository.updateAdaptationWithRevision(id, actor.id, dto.revision, {
      documentJson: { ...adaptation.documentJson, [sectionId]: requestedItems },
      suggestions,
      status: 'editing',
    });
  }

  async deleteAdaptation(actor: Actor, id: string, dto: RevisionDto) {
    const adaptation = await this.resumesRepository.getActiveAdaptationOwnedWithRevision(id, actor.id, dto.revision);
    if (adaptation.status === 'generating' && adaptation.aiRunId) {
      const run = await this.aiService.getRun(actor, adaptation.aiRunId);
      if (['queued', 'running'].includes(run.status)) await this.aiService.cancel(actor, adaptation.aiRunId);
    }
    await this.resumesRepository.softDeleteAdaptationWithRevision(id, actor.id, dto.revision);
    return { success: true };
  }

  restoreAdaptation(actor: Actor, id: string, dto: RevisionDto) {
    return this.resumesRepository.restoreAdaptationWithRevision(id, actor.id, dto.revision);
  }

  async exportAdaptation(actor: Actor, id: string, dto: ExportResumeDto) {
    const adaptation = await this.resumesRepository.getAdaptationOwned(id, actor.id);
    if (!['ready', 'review', 'editing', 'exported'].includes(adaptation.status)) {
      throw new BadRequestException('Resume adaptation is not ready for export');
    }
    if (dto.revision !== undefined && dto.revision !== adaptation.revision) {
      throw new ConflictException('Resume adaptation revision conflict');
    }
    const baseResume = await this.resumesRepository.getResumeOwned(adaptation.baseResumeId, actor.id);
    const exportDocument = resumeDocumentForExport(adaptation.documentJson, dto.format);
    const title = resumeExportTitle(baseResume.title, adaptation.documentJson);
    const displayTitle = resumeExportDisplayTitle(baseResume.title, adaptation.documentJson);
    const rendered = renderDocumentExport(exportDocument.documentJson, exportDocument.allowMarkdownFallback ? adaptation.markdownCache : undefined, title, dto.format, displayTitle);
    const file = await this.filesService.storeBuffer(actor.id, rendered.buffer, rendered.mimeType, rendered.filename, {
      kind: 'resume_export',
      resumeAdaptationId: adaptation._id,
      baseResumeId: adaptation.baseResumeId,
      opportunityId: adaptation.opportunityId,
      profileId: adaptation.profileId,
      format: dto.format,
    });
    await this.resumesRepository.updateAdaptationWithRevision(id, actor.id, adaptation.revision, {
      status: 'exported',
      exportState: { fileId: file._id, format: dto.format, exportedAt: new Date() },
    });
    await this.webhooksService?.emit(actor.id, 'resume.ready', { resumeAdaptationId: adaptation._id, fileId: file._id });
    return { fileId: file._id, filename: file.originalName, mimeType: file.mimeType, size: file.size };
  }

  private async handleAiTerminal(run: AiAnalysis): Promise<void> {
    if (run.taskType !== 'resume_adaptation') return;
    const adaptationId = typeof run.metadata?.adaptationId === 'string' ? run.metadata.adaptationId : undefined;
    if (!adaptationId) return;
    if (run.status === 'completed') {
      const adaptation = await this.resumesRepository.applyAdaptationGeneration({
        id: adaptationId,
        userId: run.userId,
        runId: run._id,
        status: 'completed',
        documentJson: this.outputDocument(run.structuredOutput),
        suggestions: this.outputSuggestions(run.structuredOutput),
      });
      await this.notificationsService?.notify({ userId: run.userId, type: 'resume.adaptation.ready', title: 'Resume adaptation is ready', data: { resumeAdaptationId: adaptation._id, opportunityId: adaptation.opportunityId } });
      return;
    }
    if (run.status === 'failed' || run.status === 'cancelled') {
      await this.resumesRepository.applyAdaptationGeneration({
        id: adaptationId,
        userId: run.userId,
        runId: run._id,
        status: run.status,
        errorSummary: run.errorSummary,
      });
    }
  }

  private toAiBaseResume(resume: Resume): Record<string, unknown> {
    return {
      id: resume._id,
      title: resume.title,
      documentJson: resume.documentJson,
      markdownCache: resume.markdownCache,
    };
  }

  private findSuggestion(adaptation: ResumeAdaptation, suggestionId: string): ResumeSuggestion {
    const suggestion = adaptation.suggestions.find((item) => item.id === suggestionId);
    if (!suggestion) throw new BadRequestException('Resume suggestion not found');
    return suggestion;
  }

  private applySuggestion(documentJson: Record<string, unknown>, suggestion: ResumeSuggestion): Record<string, unknown> {
    return applyResumeSuggestion(documentJson, suggestion);
  }

  private isReorderSuggestion(suggestion: ResumeSuggestion): boolean {
    const proposed = suggestion.proposed ?? {};
    if (this.isRecord(proposed.document) || this.isRecord(proposed.documentPatch)) return false;
    const action = this.stringValue(proposed.action ?? proposed.operation ?? proposed.kind);
    return action === 'reorder';
  }

  private reorderSectionId(suggestion: ResumeSuggestion): (typeof REORDERABLE_RESUME_SECTIONS)[number] | undefined {
    const proposed = suggestion.proposed ?? {};
    const sectionId = this.stringValue(proposed.sectionId ?? proposed.section ?? proposed.targetSection);
    return REORDERABLE_RESUME_SECTIONS.includes(sectionId as (typeof REORDERABLE_RESUME_SECTIONS)[number]) ? sectionId as (typeof REORDERABLE_RESUME_SECTIONS)[number] : undefined;
  }

  private resumeListItems(value: unknown): Array<Record<string, unknown> & { id: string }> {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Record<string, unknown> & { id: string } => this.isRecord(item) && typeof item.id === 'string' && item.id.trim().length > 0);
  }

  private assertExactOrderSet(order: string[], currentIds: string[]): void {
    const uniqueOrder = new Set(order);
    if (uniqueOrder.size !== order.length) throw new BadRequestException('Resume reorder undo order must contain unique item ids');
    if (order.length !== currentIds.length) throw new BadRequestException('Resume reorder undo order must contain the current item ids');
    const current = new Set(currentIds);
    if (order.some((itemId) => !current.has(itemId))) throw new BadRequestException('Resume reorder undo order must contain the current item ids');
  }

  private sameOrder(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private outputDocument(output?: Record<string, unknown>): Record<string, unknown> | undefined {
    return this.isRecord(output?.documentJson) ? normalizeStructuredResumeDocument(output.documentJson) : undefined;
  }

  private outputSuggestions(output?: Record<string, unknown>): Array<Partial<ResumeSuggestion>> {
    const suggestions = output?.suggestions;
    if (!Array.isArray(suggestions)) return [];
    return suggestions.filter(this.isRecord).map((suggestion) => ({
      id: typeof suggestion.id === 'string' ? suggestion.id : undefined,
      type: typeof suggestion.type === 'string' ? suggestion.type : 'other',
      title: typeof suggestion.title === 'string' ? suggestion.title : 'Resume improvement',
      rationale: typeof suggestion.rationale === 'string' ? suggestion.rationale : undefined,
      evidence: typeof suggestion.evidence === 'string' ? suggestion.evidence : undefined,
      proposed: this.isRecord(suggestion.proposed) ? suggestion.proposed : {},
    }));
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
