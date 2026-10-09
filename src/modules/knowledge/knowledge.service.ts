import { createHash } from 'node:crypto';

import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { Actor } from '../../common/access';
import { toPublic } from '../../common/schema';
import { FilesService } from '../files';
import { JobsService } from '../jobs/jobs.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ProfilesRepository } from '../profiles';
import { ChunkerService } from './chunker.service';
import { DocumentParserService } from './document-parser.service';
import { CreateKnowledgeDocumentDto, CreateKnowledgeMultipartDocumentDto, KnowledgeDocumentListQueryDto, KnowledgeSearchDto, UpdateKnowledgeDocumentDto } from './dto/knowledge.dto';
import { EmbeddingsService } from './embeddings.service';
import { KnowledgeRepository } from './knowledge.repository';
import { KnowledgeChunk } from './schemas/knowledge-chunk.schema';
import { KnowledgeDocument } from './schemas/knowledge-document.schema';

export type RagEvidence = {
  documentId: string;
  documentTitle: string;
  chunkId: string;
  excerpt: string;
  score: number;
  profileScope: string[];
};

@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly filesService: FilesService,
    private readonly jobsService: JobsService,
    private readonly realtime: RealtimeService,
    private readonly profilesRepository: ProfilesRepository,
    private readonly parser: DocumentParserService,
    private readonly chunker: ChunkerService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  onModuleInit(): void {
    this.jobsService.registerHandler('documents', 'knowledge.process', async (data) => {
      await this.processDocument(String(data.documentId));
      return { success: true };
    });
    this.jobsService.registerHandler('documents', 'embeddings.warmup', async () => this.embeddings.warmup());
  }

  async list(actor: Actor, query: KnowledgeDocumentListQueryDto) {
    const documents = await this.repository.list(actor.role === 'Admin' ? null : actor.id, query);
    return { items: documents.map((document) => this.publicDocument(document)), nextCursor: null };
  }

  async create(actor: Actor, dto: CreateKnowledgeDocumentDto) {
    await this.ensureProfileAccess(actor, dto.profileIds ?? []);
    const file = await this.filesService.storeBuffer(actor.id, Buffer.from(dto.contentBase64, 'base64'), dto.mimeType, dto.filename, {
      source: 'knowledge',
    });
    const document = await this.repository.createDocument({
      userId: actor.id,
      fileId: file._id,
      title: dto.title,
      type: dto.type,
      mode: dto.mode ?? 'rag_only',
      profileIds: dto.profileIds ?? [],
      status: 'Uploading',
    });
    this.realtime.publish(actor.id, 'document.uploaded', { documentId: document._id });
    await this.enqueueProcess(document._id);
    return this.publicDocument(document);
  }

  async createMultipart(actor: Actor, file: { buffer: Buffer; originalname: string; mimetype: string; size: number }, dto: CreateKnowledgeMultipartDocumentDto) {
    if (!file?.buffer?.length) throw new BadRequestException('File is required');
    const profileIds = this.parseProfileIds(dto.profileIds);
    await this.ensureProfileAccess(actor, profileIds);
    const stored = await this.filesService.storeBuffer(actor.id, file.buffer, dto.mimeType ?? file.mimetype, dto.filename ?? file.originalname, {
      source: 'knowledge',
    });
    const document = await this.repository.createDocument({
      userId: actor.id,
      fileId: stored._id,
      title: dto.title,
      type: dto.type,
      mode: dto.mode ?? 'rag_only',
      profileIds,
      status: 'Uploading',
    });
    this.realtime.publish(actor.id, 'document.uploaded', { documentId: document._id });
    await this.enqueueProcess(document._id);
    return this.publicDocument(document);
  }

  async get(actor: Actor, id: string) {
    const document = await this.getAccessible(actor, id);
    return this.publicDocument(document, true);
  }

  async update(actor: Actor, id: string, dto: UpdateKnowledgeDocumentDto) {
    const document = await this.getAccessible(actor, id);
    await this.ensureProfileAccess({ ...actor, id: document.userId }, dto.profileIds ?? []);
    const updated = await this.repository.updateDocument(id, dto);
    await this.jobsService.enqueue('search', 'index-knowledge-document', { documentId: id }, { jobId: `search.knowledge:${id}` });
    this.realtime.publish(updated.userId, 'document.updated', { documentId: updated._id });
    return this.publicDocument(updated);
  }

  async delete(actor: Actor, id: string): Promise<{ success: true }> {
    const document = await this.getAccessible(actor, id);
    await this.repository.softDeleteDocument(id);
    await this.jobsService.enqueue('search', 'delete-knowledge-document', { documentId: id }, { jobId: `search.knowledge.delete:${id}` });
    this.realtime.publish(document.userId, 'document.deleted', { documentId: id });
    return { success: true };
  }

  async reprocess(actor: Actor, id: string) {
    const document = await this.getAccessible(actor, id);
    await this.enqueueProcess(document._id);
    return { success: true };
  }

  async warmupEmbeddings() {
    return this.jobsService.enqueue('documents', 'embeddings.warmup', {}, { jobId: 'embeddings.warmup' });
  }

  async search(actor: Actor, dto: KnowledgeSearchDto) {
    const result = await this.retrieveForActor(actor, dto.query, dto.profileId, dto.topK ?? 8);
    return { items: result.evidence, nextCursor: null };
  }

  async retrieveForActor(actor: Actor, query: string, profileId?: string, topK = 8): Promise<{ evidence: RagEvidence[]; alwaysInclude: Array<{ documentId: string; title: string; text: string }> }> {
    if (profileId) await this.ensureProfileAccess(actor, [profileId]);
    const userId = actor.id;
    const [alwaysInclude, keywordChunks, vectorCandidates] = await Promise.all([
      this.repository.listAlwaysInclude(userId, profileId),
      this.repository.searchChunks({ userId, profileId, query, limit: topK * 3 }),
      this.repository.candidateChunks({ userId, profileId, limit: 200 }),
    ]);
    const candidates = new Map<string, KnowledgeChunk>();
    for (const chunk of vectorCandidates) candidates.set(chunk._id, chunk);
    for (const chunk of keywordChunks) candidates.set(chunk._id, chunk);
    const candidateChunks = Array.from(candidates.values());
    if (!candidateChunks.length) {
      return {
        evidence: [],
        alwaysInclude: alwaysInclude.map((document) => ({
          documentId: document._id,
          title: document.title,
          text: (document.summary || document.extractedText).slice(0, 4000),
        })),
      };
    }
    const keywordIds = new Set(keywordChunks.map((chunk) => chunk._id));
    const hasEmbeddings = candidateChunks.some((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0);
    const queryEmbedding = hasEmbeddings ? await this.embeddings.embedQuery(query) : undefined;
    const ranked = candidateChunks
      .map((chunk) => ({
        chunk,
        score: (keywordIds.has(chunk._id) ? 0.35 : 0) + (queryEmbedding && chunk.embedding?.length ? 0.65 * this.embeddings.similarity(queryEmbedding.vector, chunk.embedding) : 0),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
    const documents = new Map((await Promise.all(ranked.map((item) => this.repository.getDocument(item.chunk.documentId)))).map((document) => [document._id, document]));
    return {
      evidence: ranked.map(({ chunk, score }) => this.toEvidence(chunk, documents.get(chunk.documentId), score)),
      alwaysInclude: alwaysInclude.map((document) => ({
        documentId: document._id,
        title: document.title,
        text: (document.summary || document.extractedText).slice(0, 4000),
      })),
    };
  }

  async retrieveForUser(userId: string, query: string, profileId?: string, topK = 8) {
    return this.retrieveForActor({ id: userId, email: 'system@intly.local', role: 'User' }, query, profileId, topK);
  }

  async processDocument(id: string): Promise<void> {
    const document = await this.repository.getDocument(id);
    try {
      await this.stage(document, 'Parsing');
      const { file, buffer } = await this.filesService.readForSystem(document.fileId);
      const parsed = await this.parser.parse(buffer, file.mimeType);
      await this.stage(document, 'Chunking', { extractedText: parsed.text, structuredExtract: parsed.structured });
      const chunkInputs = this.chunker.chunk(parsed.text);
      await this.stage(document, 'Embedding');
      const chunks = await Promise.all(
        chunkInputs.map(async (chunk, index): Promise<Partial<KnowledgeChunk>> => {
          const embedding = await this.embeddings.embedPassage(chunk.text);
          return {
            documentId: document._id,
            userId: document.userId,
            profileIds: document.profileIds,
            section: chunk.section,
            type: document.type,
            chunkIndex: index,
            text: chunk.text,
            inputHash: createHash('sha256').update(chunk.text).digest('hex'),
            embedding: embedding.vector,
            embeddingMetadata: embedding.metadata,
            active: document.mode !== 'disabled',
          };
        }),
      );
      await this.stage(document, 'Indexing');
      await this.repository.replaceChunks(document._id, chunks);
      const summary = parsed.text.split(/\s+/).slice(0, 120).join(' ');
      const updated = await this.repository.updateDocument(document._id, {
        status: 'Indexed',
        extractedText: parsed.text,
        structuredExtract: parsed.structured,
        summary,
        chunkCount: chunks.length,
        processedAt: new Date(),
        lastError: undefined,
      });
      await this.jobsService.enqueue('search', 'index-knowledge-document', { documentId: document._id }, { jobId: `search.knowledge:${document._id}` });
      this.realtime.publish(document.userId, 'document.indexed', { documentId: updated._id, chunkCount: chunks.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Document processing failed';
      this.logger.warn(`Document ${id} failed: ${message}`);
      await this.repository.updateDocument(document._id, { status: 'Failed', lastError: message });
      this.realtime.publish(document.userId, 'document.failed', { documentId: document._id, error: message });
      throw error;
    }
  }

  private async enqueueProcess(documentId: string): Promise<void> {
    await this.jobsService.enqueue('documents', 'knowledge.process', { documentId }, { jobId: `knowledge.process:${documentId}` });
  }

  private async stage(document: KnowledgeDocument, status: KnowledgeDocument['status'], patch: Partial<KnowledgeDocument> = {}): Promise<void> {
    await this.repository.updateDocument(document._id, { ...patch, status });
    this.realtime.publish(document.userId, 'document.parsing.progress', { documentId: document._id, stage: status });
  }

  private async getAccessible(actor: Actor, id: string): Promise<KnowledgeDocument> {
    const document = await this.repository.getDocument(id);
    if (actor.role !== 'Admin' && document.userId !== actor.id) throw new ForbiddenException('Knowledge document access denied');
    return document;
  }

  private async ensureProfileAccess(actor: Actor, profileIds: string[]): Promise<void> {
    for (const profileId of profileIds) {
      if (actor.role === 'Admin') await this.profilesRepository.getById(profileId);
      else await this.profilesRepository.getOwned(profileId, actor.id);
    }
  }

  private parseProfileIds(value?: string): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
    } catch {
      // Fallback to comma-separated form data below.
    }
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }

  private toEvidence(chunk: KnowledgeChunk, document: KnowledgeDocument | undefined, score: number): RagEvidence {
    return {
      documentId: chunk.documentId,
      documentTitle: document?.title ?? 'Knowledge document',
      chunkId: chunk._id,
      excerpt: chunk.text.slice(0, 900),
      score: Number(score.toFixed(4)),
      profileScope: chunk.profileIds,
    };
  }

  private publicDocument(document: KnowledgeDocument, includeText = false) {
    const publicDocument = toPublic(document);
    if (!includeText) {
      delete (publicDocument as { extractedText?: string }).extractedText;
    }
    return publicDocument;
  }
}
