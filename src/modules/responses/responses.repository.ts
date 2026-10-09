import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';

import { withCanonicalOpportunity } from '../opportunities/canonical-opportunity-transaction';
import { ResponseDraft, ResponseDraftDocument } from './schemas/response-draft.schema';

const ACTIVE_GENERATION_STATUSES = ['queued', 'running'];
type GenerationSnapshot = { runId?: string; status?: string };

@Injectable()
export class ResponsesRepository {
  constructor(
    @InjectModel(ResponseDraft.name) private readonly draftModel: Model<ResponseDraftDocument>,
    @InjectConnection() private readonly connection?: Connection,
  ) {}

  async create(input: Partial<ResponseDraft>): Promise<ResponseDraft> {
    try {
      if (this.connection?.db && input.opportunityId) {
        return await withCanonicalOpportunity(this.connection, input.opportunityId, async (opportunityId, session) => {
          const [created] = await this.draftModel.create([{ ...input, opportunityId }], { session });
          return created.toObject();
        });
      }
      const created = await this.draftModel.create(input);
      return created.toObject();
    } catch (error) {
      this.throwDuplicateDraftConflict(error);
      throw error;
    }
  }

  async list(userId: string, query: { opportunityId?: string; profileId?: string }) {
    const opportunityId = query.opportunityId ? await this.resolveCanonicalOpportunityId(query.opportunityId) : undefined;
    return this.draftModel.find({ userId, deletedAt: { $exists: false }, ...query, ...(opportunityId ? { opportunityId } : {}) }).sort({ updatedAt: -1 }).lean();
  }

  findOwned(id: string, userId: string): Promise<ResponseDraft | null> {
    return this.draftModel.findOne({ _id: id, userId, deletedAt: { $exists: false } }).lean();
  }

  async getOwned(id: string, userId: string): Promise<ResponseDraft> {
    const draft = await this.findOwned(id, userId);
    if (!draft) throw new NotFoundException('Response draft not found');
    return draft;
  }

  async updateWithRevision(id: string, userId: string, revision: number, patch: Partial<ResponseDraft>): Promise<ResponseDraft> {
    try {
      if (this.connection?.db) {
        const existing = await this.draftModel.findOne({ _id: id, userId, deletedAt: { $exists: false } }).lean();
        if (existing?.opportunityId) {
          const updated = await withCanonicalOpportunity(this.connection, existing.opportunityId, async (_opportunityId, session) => this.updateWithRevisionInSession(id, userId, revision, patch, session));
          if (updated) return updated;
          throw new ConflictException('Response draft revision conflict');
        }
      }
      const updated = await this.updateWithRevisionInSession(id, userId, revision, patch);
      if (!updated) {
        const exists = await this.findOwned(id, userId);
        if (exists) throw new ConflictException('Response draft revision conflict');
        throw new NotFoundException('Response draft not found');
      }
      return updated;
    } catch (error) {
      this.throwDuplicateDraftConflict(error);
      throw error;
    }
  }

  async updatePipelineHandoff(id: string, userId: string, handoffId: string, handoff: Record<string, unknown>): Promise<ResponseDraft> {
    try {
      const updated = await this.withCanonicalDraftWrite(id, userId, (opportunityId, session) => this.draftModel.findOneAndUpdate(
        { _id: id, userId, deletedAt: { $exists: false }, 'pipelineHandoff.id': handoffId },
        { $set: { pipelineHandoff: handoff } },
        { returnDocument: 'after', ...(session ? { session } : {}) },
      ).lean());
      if (updated) return updated;
      const existing = await this.findOwned(id, userId);
      if (!existing) throw new NotFoundException('Response draft not found');
      return existing;
    } catch (error) {
      this.throwDuplicateDraftConflict(error);
      throw error;
    }
  }



  async applyGeneration(input: {
    id: string;
    userId: string;
    runId: string;
    documentJson: Record<string, unknown>;
    markdownCache?: string;
    status: string;
    baseRevision?: number;
    errorSummary?: string;
    expectedGeneration?: GenerationSnapshot;
  }): Promise<ResponseDraft> {
    const patch: Record<string, unknown> = {
      generation: {
        runId: input.runId,
        status: input.status,
        completedAt: new Date(),
        ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
      },
    };
    if (input.status === 'completed') {
      patch.documentJson = input.documentJson;
      patch.markdownCache = input.markdownCache;
      patch.status = 'draft';
    }
    const update = input.status === 'completed' ? { $set: patch, $inc: { revision: 1 } } : { $set: patch };
    const runGuard = this.terminalGenerationGuard(input.runId, input.expectedGeneration, input.baseRevision);
    const filter: Record<string, unknown> = { _id: input.id, userId: input.userId, deletedAt: { $exists: false }, ...runGuard };
    if (input.status === 'completed' && input.baseRevision) filter.revision = input.baseRevision;
    let updated: ResponseDraft | null;
    try {
      updated = await this.withCanonicalDraftWrite(input.id, input.userId, (opportunityId, session) => this.draftModel.findOneAndUpdate(
        filter,
        update,
        { returnDocument: 'after', ...(session ? { session } : {}) },
      ).lean());
    } catch (error) {
      this.throwDuplicateDraftConflict(error);
      throw error;
    }
    if (updated) return updated;
    const existing = await this.findOwned(input.id, input.userId);
    if (!existing) throw new NotFoundException('Response draft not found');
    const existingRunId = typeof existing.generation?.runId === 'string' ? existing.generation.runId : undefined;
    const existingStatus = typeof existing.generation?.status === 'string' ? existing.generation.status : undefined;
    if (existingRunId === input.runId && existingStatus === input.status) return existing;
    if (existingRunId && existingRunId !== input.runId) return existing;
    if (input.status === 'completed' && input.baseRevision && existingRunId === input.runId) {
      try {
        const stale = await this.withCanonicalDraftWrite(input.id, input.userId, (opportunityId, session) => this.draftModel.findOneAndUpdate(
          { _id: input.id, userId: input.userId, deletedAt: { $exists: false }, 'generation.runId': input.runId },
          { $set: { generation: { runId: input.runId, status: 'stale', completedAt: new Date(), baseRevision: input.baseRevision, currentRevision: existing.revision } } },
          { returnDocument: 'after', ...(session ? { session } : {}) },
        ).lean());
        return stale ?? existing;
      } catch (error) {
        this.throwDuplicateDraftConflict(error);
        throw error;
      }
    }
    return existing;
  }

  async attachGeneration(id: string, userId: string, generation: Record<string, unknown>, expected: { revision?: number; generation?: GenerationSnapshot }): Promise<ResponseDraft> {
    const expectedFilter = this.expectedGenerationFilter(expected?.generation, expected?.revision);
    let updated: ResponseDraft | null;
    try {
      updated = await this.withCanonicalDraftWrite(id, userId, (opportunityId, session) => this.draftModel.findOneAndUpdate(
        {
          _id: id,
          userId,
          deletedAt: { $exists: false },
          ...expectedFilter,
        },
        { $set: { generation } },
        { returnDocument: 'after', ...(session ? { session } : {}) },
      ).lean());
    } catch (error) {
      this.throwDuplicateDraftConflict(error);
      throw error;
    }
    if (updated) return updated;
    const existing = await this.findOwned(id, userId);
    if (!existing) throw new NotFoundException('Response draft not found');
    if (existing.generation?.runId === generation.runId) return existing;
    if (ACTIVE_GENERATION_STATUSES.includes(String(existing.generation?.status))) {
      throw new ConflictException('Response generation is already running');
    }
    throw new ConflictException('Response draft generation state changed');
  }

  private async withCanonicalDraftWrite<T>(id: string, userId: string, write: (opportunityId: string | undefined, session?: mongo.ClientSession) => Promise<T>): Promise<T> {
    if (this.connection?.db) {
      const existing = await this.draftModel.findOne({ _id: id, userId, deletedAt: { $exists: false } }).lean();
      if (existing?.opportunityId) {
        return withCanonicalOpportunity(this.connection, existing.opportunityId, async (opportunityId, session) => write(opportunityId, session));
      }
    }
    return write(undefined);
  }

  private async updateWithRevisionInSession(id: string, userId: string, revision: number, patch: Partial<ResponseDraft>, session?: mongo.ClientSession): Promise<ResponseDraft | null> {
    return this.draftModel.findOneAndUpdate(
      { _id: id, userId, revision, deletedAt: { $exists: false } },
      { $set: patch, $inc: { revision: 1 } },
      { returnDocument: 'after', ...(session ? { session } : {}) },
    ).lean();
  }

  private async resolveCanonicalOpportunityId(opportunityId: string): Promise<string> {
    if (!this.connection?.db) return opportunityId;
    let id = opportunityId;
    const visited = new Set<string>();
    const opportunities = this.connection.db.collection<{ _id: string; mergedIntoOpportunityId?: string }>('opportunities');
    for (let hop = 0; hop < 20; hop += 1) {
      if (visited.has(id)) throw new ConflictException('Opportunity alias cycle');
      visited.add(id);
      const record = await opportunities.findOne({ _id: id }, { projection: { _id: 1, mergedIntoOpportunityId: 1 } });
      if (!record) return opportunityId;
      if (!record.mergedIntoOpportunityId) return record._id;
      id = record.mergedIntoOpportunityId;
    }
    throw new ConflictException('Opportunity alias chain exceeds safe depth');
  }

  private throwDuplicateDraftConflict(error: unknown): never | void {
    if (typeof error === 'object' && error && 'code' in error && error.code === 11000) {
      throw new ConflictException('Response draft already exists for this format');
    }
  }

  private terminalGenerationGuard(runId: string, expectedGeneration?: GenerationSnapshot, expectedRevision?: number): Record<string, unknown> {
    const candidates: Record<string, unknown>[] = [{ 'generation.runId': runId }];
    if (expectedGeneration) candidates.push(this.expectedGenerationFilter(expectedGeneration, expectedRevision));
    return { $or: candidates };
  }

  private expectedGenerationFilter(expectedGeneration: GenerationSnapshot | undefined, expectedRevision?: number): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (expectedRevision !== undefined) filter.revision = expectedRevision;
    filter['generation.runId'] = expectedGeneration?.runId ? expectedGeneration.runId : { $exists: false };
    filter['generation.status'] = expectedGeneration?.status ? expectedGeneration.status : { $exists: false };
    return filter;
  }
}
