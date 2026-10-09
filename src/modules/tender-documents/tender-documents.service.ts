import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';

import { Actor } from '../../common/access';
import { toPublic } from '../../common/schema';
import { AiService } from '../ai';
import { KnowledgeService } from '../knowledge';
import { OpportunitiesRepository } from '../opportunities';
import { ProfilesRepository } from '../profiles';
import { ImportSourceTenderDocumentDto, TenderDocumentAnalysisDto, TenderDocumentQueryDto, UploadTenderDocumentDto } from './dto/tender-document.dto';
import { TenderDocumentsRepository } from './tender-documents.repository';
import { TenderDocumentLink } from './schemas/tender-document-link.schema';
import { TenderSourceDocumentDownloader } from './tender-source-document-downloader';

type PublicKnowledgeDocument = Record<string, unknown> & { id: string; fileId?: string; title?: string; status?: string; summary?: string; extractedText?: string; lastError?: string };
type OpportunityWithSources = {
  _id: string;
  type: string;
  tenderData?: Record<string, unknown>;
  sourceOccurrences?: Array<Record<string, unknown>>;
};
type SourceDocumentDescriptor = {
  sourceId: string;
  url: string;
  title: string;
  filename?: string;
  mimeType?: string;
  size?: number;
};

@Injectable()
export class TenderDocumentsService {
  constructor(
    private readonly repository: TenderDocumentsRepository,
    private readonly opportunities: OpportunitiesRepository,
    private readonly profiles: ProfilesRepository,
    private readonly knowledge: KnowledgeService,
    private readonly ai: AiService,
    private readonly sourceDownloader?: TenderSourceDocumentDownloader,
  ) {}

  async list(actor: Actor, opportunityId: string, query: TenderDocumentQueryDto) {
    const { opportunity } = await this.assertScope(actor, opportunityId, query.profileId);
    const canonicalOpportunityId = String(opportunity._id);
    const links = await this.repository.list({ userId: actor.role === 'Admin' ? undefined : actor.id, opportunityId: canonicalOpportunityId, profileId: query.profileId });
    const items = await Promise.all(links.map((link) => this.publicLink(actor, link)));
    return { items, nextCursor: null };
  }

  async upload(actor: Actor, opportunityId: string, file: { buffer: Buffer; originalname: string; mimetype: string; size: number }, dto: UploadTenderDocumentDto) {
    const { opportunity } = await this.assertScope(actor, opportunityId, dto.profileId);
    const canonicalOpportunityId = String(opportunity._id);
    if (!file?.buffer?.length) throw new BadRequestException('File is required');
    const knowledgeDocument = await this.knowledge.createMultipart(actor, file, {
      title: dto.title,
      type: 'other',
      mode: 'rag_only',
      profileIds: JSON.stringify([dto.profileId]),
      filename: dto.filename,
      mimeType: dto.mimeType,
    }) as PublicKnowledgeDocument;
    const fileId = String(knowledgeDocument.fileId ?? '');
    if (!fileId) throw new BadRequestException('Uploaded document did not return a file id');
    const link = await this.repository.create({
      userId: actor.id,
      opportunityId: canonicalOpportunityId,
      profileId: dto.profileId,
      knowledgeDocumentId: knowledgeDocument.id,
      fileId,
      title: dto.title,
      documentType: dto.documentType ?? 'other',
      aiStatus: 'Not analyzed',
    });
    return this.publicLink(actor, link, knowledgeDocument);
  }

  async importSource(actor: Actor, opportunityId: string, dto: ImportSourceTenderDocumentDto) {
    const { opportunity } = await this.assertScope(actor, opportunityId, dto.profileId);
    const canonicalOpportunityId = String(opportunity._id);
    const descriptor = this.findRetainedSourceDocument(opportunity, dto.sourceId, dto.url);
    const existing = await this.repository.findSourceImport({
      userId: actor.id,
      opportunityId: canonicalOpportunityId,
      profileId: dto.profileId,
      sourceId: dto.sourceId,
      sourceUrl: descriptor.url,
    });
    if (existing) return { ...(await this.publicLink(actor, existing)), alreadyImported: true };

    const downloaded = await this.downloader().download(descriptor.url, descriptor.filename ?? descriptor.title);
    const title = descriptor.title || downloaded.filename;
    const knowledgeDocument = await this.knowledge.createMultipart(actor, {
      buffer: downloaded.buffer,
      originalname: downloaded.filename,
      mimetype: downloaded.mimeType,
      size: downloaded.size,
    }, {
      title,
      type: 'other',
      mode: 'rag_only',
      profileIds: JSON.stringify([dto.profileId]),
      filename: downloaded.filename,
      mimeType: downloaded.mimeType,
    }) as PublicKnowledgeDocument;
    const fileId = String(knowledgeDocument.fileId ?? '');
    if (!fileId) throw new BadRequestException('Imported source document did not return a file id');
    try {
      const link = await this.repository.createSourceImport({
        userId: actor.id,
        opportunityId: canonicalOpportunityId,
        profileId: dto.profileId,
        knowledgeDocumentId: knowledgeDocument.id,
        fileId,
        title,
        documentType: dto.documentType ?? 'other',
        aiStatus: 'Not analyzed',
        sourceId: dto.sourceId,
        sourceUrl: descriptor.url,
        sourceFilename: downloaded.filename,
        sourceMimeType: downloaded.mimeType,
        sourceSize: downloaded.size,
        sourceImportedAt: new Date(),
      });
      return this.publicLink(actor, link, knowledgeDocument);
    } catch (error) {
      if (!this.isDuplicateKey(error)) throw error;
      await this.knowledge.delete(actor, knowledgeDocument.id).catch(() => undefined);
      const duplicate = await this.repository.findSourceImport({
        userId: actor.id,
        opportunityId: canonicalOpportunityId,
        profileId: dto.profileId,
        sourceId: dto.sourceId,
        sourceUrl: descriptor.url,
      });
      if (!duplicate) throw error;
      return { ...(await this.publicLink(actor, duplicate)), alreadyImported: true };
    }
  }

  async reprocess(actor: Actor, opportunityId: string, id: string) {
    const link = await this.getScopedLink(actor, opportunityId, id);
    await this.knowledge.reprocess(actor.role === 'Admin' ? { ...actor, id: link.userId } : actor, link.knowledgeDocumentId);
    return { success: true };
  }

  async remove(actor: Actor, opportunityId: string, id: string) {
    const link = await this.getScopedLink(actor, opportunityId, id);
    await this.knowledge.delete(actor.role === 'Admin' ? { ...actor, id: link.userId } : actor, link.knowledgeDocumentId);
    await this.repository.softDelete(id);
    return { success: true };
  }

  async analyze(actor: Actor, opportunityId: string, dto: TenderDocumentAnalysisDto) {
    const { opportunity } = await this.assertScope(actor, opportunityId, dto.profileId);
    const canonicalOpportunityId = String(opportunity._id);
    const all = await this.repository.list({ userId: actor.role === 'Admin' ? undefined : actor.id, opportunityId: canonicalOpportunityId, profileId: dto.profileId });
    const selected = dto.tenderDocumentIds?.length ? all.filter((link) => dto.tenderDocumentIds!.includes(link._id)) : all;
    if (!selected.length) throw new BadRequestException('Upload at least one tender document before analysis');
    if (dto.tenderDocumentIds?.length && selected.length !== dto.tenderDocumentIds.length) throw new ForbiddenException('Tender document scope violation');
    const tenderDocuments = await Promise.all(selected.map(async (link) => {
      const document = await this.knowledge.get(actor.role === 'Admin' ? { ...actor, id: link.userId } : actor, link.knowledgeDocumentId) as PublicKnowledgeDocument;
      if (!this.textReady(document)) throw new BadRequestException(`Tender document "${link.title}" is not ready for AI analysis`);
      return {
        tenderDocumentId: link._id,
        knowledgeDocumentId: link.knowledgeDocumentId,
        title: link.title,
        documentType: link.documentType,
        sourceId: link.sourceId,
        sourceUrl: link.sourceUrl,
        status: document.status,
        summary: document.summary,
        extractedText: typeof document.extractedText === 'string' ? document.extractedText.slice(0, 20000) : undefined,
      };
    }));
    const run = await this.ai.runTenderDocumentAnalysis(actor, { opportunityId: canonicalOpportunityId, profileId: dto.profileId, tenderDocuments, customPrompt: dto.customPrompt });
    await this.repository.updateMany(selected.map((link) => link._id), { aiRunId: run._id, aiStatus: 'Queued' });
    return run;
  }

  async analysis(actor: Actor, opportunityId: string, id: string) {
    const link = await this.getScopedLink(actor, opportunityId, id);
    if (!link.aiRunId) throw new BadRequestException('Tender document has no AI analysis run');
    const run = await this.ai.getRun(actor.role === 'Admin' ? actor : { ...actor, id: link.userId }, link.aiRunId);
    if (run.userId !== link.userId || run.opportunityId !== link.opportunityId || run.profileId !== link.profileId || run.taskType !== 'tender_document_analysis') {
      throw new ForbiddenException('Tender document analysis run scope violation');
    }
    const runDocumentIds = Array.isArray(run.metadata?.tenderDocumentIds) ? run.metadata.tenderDocumentIds.map((item) => String(item)) : [];
    if (!runDocumentIds.includes(link._id)) throw new ForbiddenException('Tender document analysis run does not include this document');
    return {
      id: run._id,
      status: run.status,
      stage: run.stage,
      output: run.structuredOutput ?? null,
      aiScore: typeof run.aiScore === 'number' ? run.aiScore : null,
      errorSummary: run.errorSummary,
      completedAt: run.completedAt,
    };
  }

  private async getScopedLink(actor: Actor, opportunityId: string, id: string) {
    const link = await this.repository.get(id);
    const { opportunity } = await this.assertScope(actor, opportunityId, link.profileId);
    if (link.opportunityId !== String(opportunity._id)) throw new ForbiddenException('Tender document scope violation');
    if (actor.role !== 'Admin' && link.userId !== actor.id) throw new ForbiddenException('Tender document access denied');
    return link;
  }

  private async assertScope(actor: Actor, opportunityId: string, profileId: string) {
    const [opportunity, profile] = await Promise.all([
      this.opportunities.getById(opportunityId),
      actor.role === 'Admin' ? this.profiles.getById(profileId) : this.profiles.getOwned(profileId, actor.id),
    ]);
    if (opportunity.type !== 'tender') throw new BadRequestException('Tender documents are available only for tender opportunities');
    if (actor.role !== 'Admin' && profile.userId !== actor.id) throw new ForbiddenException('Profile scope violation');
    return { opportunity: opportunity as OpportunityWithSources, profile };
  }

  private async publicLink(actor: Actor, link: TenderDocumentLink, knownDocument?: PublicKnowledgeDocument) {
    const document = knownDocument ?? await this.knowledge.get(actor.role === 'Admin' ? { ...actor, id: link.userId } : actor, link.knowledgeDocumentId) as PublicKnowledgeDocument;
    const aiRun = link.aiRunId ? await this.ai.getRun(actor.role === 'Admin' ? actor : { ...actor, id: link.userId }, link.aiRunId).catch(() => null) : null;
    const aiStatus = aiRun ? this.aiStatus(aiRun.status) : link.aiStatus;
    return {
      ...toPublic(link),
      title: link.title,
      fileId: link.fileId,
      knowledgeDocumentId: link.knowledgeDocumentId,
      documentType: link.documentType,
      processingStatus: document.status ?? 'Uploading',
      textStatus: document.status ?? 'Uploading',
      textReady: this.textReady(document),
      summary: document.summary,
      lastError: document.lastError,
      aiStatus,
      aiRunId: link.aiRunId,
      aiScore: typeof aiRun?.aiScore === 'number' ? aiRun.aiScore : null,
      aiCompletedAt: aiRun?.completedAt,
      sourceId: link.sourceId,
      sourceUrl: link.sourceUrl,
      filename: link.sourceFilename,
      mimeType: link.sourceMimeType,
      size: link.sourceSize,
      importedAt: link.sourceImportedAt,
    };
  }

  private aiStatus(status: string) {
    return ({ queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' } as Record<string, string>)[status] ?? 'Not analyzed';
  }

  private textReady(document: PublicKnowledgeDocument): boolean {
    return document.status === 'Indexed' && typeof document.extractedText === 'string' && document.extractedText.trim().length > 0;
  }

  private downloader(): TenderSourceDocumentDownloader {
    if (!this.sourceDownloader) throw new BadRequestException('Source document importer is unavailable');
    return this.sourceDownloader;
  }

  private findRetainedSourceDocument(opportunity: OpportunityWithSources, sourceId: string, url: string): SourceDocumentDescriptor {
    const normalized = this.normalizeUrl(url);
    const occurrences = opportunity.sourceOccurrences ?? [];
    for (const occurrence of occurrences) {
      if (occurrence.sourceId !== sourceId) continue;
      const occurrenceUrl = typeof occurrence.url === 'string' ? this.safeNormalizeUrl(occurrence.url) : undefined;
      for (const descriptor of this.retainedDocumentsForOccurrence(occurrence, opportunity)) {
        const descriptorUrl = this.safeNormalizeUrl(descriptor.url);
        if (descriptorUrl === normalized) {
          if (occurrenceUrl && normalized === occurrenceUrl) break;
          return descriptor;
        }
      }
    }
    throw new ForbiddenException('Source document URL is not retained for this tender source occurrence');
  }

  private retainedDocumentsForOccurrence(occurrence: Record<string, unknown>, opportunity: OpportunityWithSources): SourceDocumentDescriptor[] {
    const sourceId = String(occurrence.sourceId ?? '');
    const sourceOccurrences = opportunity.sourceOccurrences ?? [];
    const candidates = [
      ...this.arrayOfRecords((occurrence.sourceMetadata as Record<string, unknown> | undefined)?.sourceDocuments),
      ...this.arrayOfRecords((occurrence.sourceMetadata as Record<string, unknown> | undefined)?.tenderData && typeof (occurrence.sourceMetadata as Record<string, unknown>).tenderData === 'object' && !Array.isArray((occurrence.sourceMetadata as Record<string, unknown>).tenderData)
        ? ((occurrence.sourceMetadata as Record<string, unknown>).tenderData as Record<string, unknown>).documents
        : undefined),
      ...this.canonicalTenderDocumentsForSource(opportunity.tenderData?.documents, sourceId, sourceOccurrences),
      ...this.canonicalTenderDocumentsForSource(opportunity.tenderData?.sourceDocuments, sourceId, sourceOccurrences),
    ];
    return candidates.flatMap((item) => this.toSourceDescriptor(sourceId, item)).filter((item): item is SourceDocumentDescriptor => Boolean(item));
  }

  private toSourceDescriptor(sourceId: string, item: Record<string, unknown>): SourceDocumentDescriptor | undefined {
    const url = typeof item.url === 'string' ? item.url : typeof item.href === 'string' ? item.href : undefined;
    if (!url || !/^https?:\/\//i.test(url)) return undefined;
    const label = [item.label, item.title, item.name, item.filename].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
    return {
      sourceId,
      url,
      title: this.cleanTitle(label ?? sourceId),
      filename: typeof item.filename === 'string' ? this.cleanTitle(item.filename) : undefined,
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
      size: typeof item.size === 'number' ? item.size : undefined,
    };
  }

  private canonicalTenderDocumentsForSource(value: unknown, sourceId: string, occurrences: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const documents = this.arrayOfRecords(value);
    if (!documents.length) return [];
    const withProvenance = documents.filter((document) => document.sourceId === sourceId);
    if (withProvenance.length) return withProvenance;
    const withoutProvenance = documents.filter((document) => typeof document.sourceId !== 'string' || !document.sourceId.trim());
    const uniqueSourceIds = new Set(occurrences.map((item) => (typeof item.sourceId === 'string' ? item.sourceId : undefined)).filter(Boolean));
    return uniqueSourceIds.size === 1 ? withoutProvenance : [];
  }

  private arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
  }

  private normalizeUrl(value: string): string {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.toString();
  }

  private safeNormalizeUrl(value: string): string | undefined {
    try {
      return this.normalizeUrl(value);
    } catch {
      return undefined;
    }
  }

  private cleanTitle(value: string): string {
    return value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Source document';
  }

  private isDuplicateKey(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 11000);
  }
}
