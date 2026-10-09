import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { newId } from '../../common/schema';
import { Resume, ResumeDocument, ResumeKind } from './schemas/resume.schema';
import { ResumeAdaptation, ResumeAdaptationDocument, ResumeSuggestion } from './schemas/resume-adaptation.schema';

@Injectable()
export class ResumesRepository {
  constructor(
    @InjectModel(Resume.name) private readonly resumeModel: Model<ResumeDocument>,
    @InjectModel(ResumeAdaptation.name) private readonly adaptationModel: Model<ResumeAdaptationDocument>,
  ) {}

  createResume(input: Partial<Resume>): Promise<Resume> {
    return this.resumeModel.create(input).then((document) => document.toObject());
  }

  listResumes(userId: string, query: { profileId?: string; kind?: ResumeKind }) {
    return this.resumeModel.find({ userId, deletedAt: { $exists: false }, ...(query.profileId ? { profileId: query.profileId } : {}), ...(query.kind ? { kind: query.kind } : {}) }).sort({ updatedAt: -1 }).lean();
  }

  async getResumeOwned(id: string, userId: string): Promise<Resume> {
    const resume = await this.resumeModel.findOne({ _id: id, userId, deletedAt: { $exists: false } }).lean();
    if (!resume) throw new NotFoundException('Resume not found');
    return resume;
  }

  async updateResumeWithRevision(id: string, userId: string, revision: number, patch: Partial<Resume>, unset: Array<keyof Resume> = []): Promise<Resume> {
    const unsetPatch = Object.fromEntries(unset.map((key) => [key, '']));
    const updated = await this.resumeModel.findOneAndUpdate(
      { _id: id, userId, revision, deletedAt: { $exists: false } },
      { ...(Object.keys(patch).length ? { $set: patch } : {}), ...(unset.length ? { $unset: unsetPatch } : {}), $inc: { revision: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) {
      const exists = await this.resumeModel.exists({ _id: id, userId, deletedAt: { $exists: false } });
      if (exists) throw new ConflictException('Resume revision conflict');
      throw new NotFoundException('Resume not found');
    }
    return updated;
  }

  createAdaptation(input: Partial<ResumeAdaptation>): Promise<ResumeAdaptation> {
    return this.adaptationModel.create(input).then((document) => document.toObject());
  }

  listAdaptations(userId: string, query: { opportunityId?: string; profileId?: string; baseResumeId?: string; deleted?: 'only' }) {
    return this.adaptationModel.find({
      userId,
      deletedAt: query.deleted === 'only' ? { $exists: true } : { $exists: false },
      ...(query.opportunityId ? { opportunityId: query.opportunityId } : {}),
      ...(query.profileId ? { profileId: query.profileId } : {}),
      ...(query.baseResumeId ? { baseResumeId: query.baseResumeId } : {}),
    }).sort({ updatedAt: -1 }).lean();
  }

  async getAdaptationOwned(id: string, userId: string): Promise<ResumeAdaptation> {
    const adaptation = await this.adaptationModel.findOne({ _id: id, userId, deletedAt: { $exists: false } }).lean();
    if (!adaptation) throw new NotFoundException('Resume adaptation not found');
    return adaptation;
  }

  async getActiveAdaptationOwnedWithRevision(id: string, userId: string, revision: number): Promise<ResumeAdaptation> {
    const adaptation = await this.adaptationModel.findOne({ _id: id, userId, deletedAt: { $exists: false } }).lean();
    if (!adaptation) throw new NotFoundException('Resume adaptation not found');
    if (adaptation.revision !== revision) throw new ConflictException('Resume adaptation revision conflict');
    return adaptation;
  }

  async updateAdaptationWithRevision(id: string, userId: string, revision: number, patch: Partial<ResumeAdaptation>): Promise<ResumeAdaptation> {
    const updated = await this.adaptationModel.findOneAndUpdate(
      { _id: id, userId, revision, deletedAt: { $exists: false } },
      { $set: patch, $inc: { revision: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) {
      const exists = await this.adaptationModel.exists({ _id: id, userId, deletedAt: { $exists: false } });
      if (exists) throw new ConflictException('Resume adaptation revision conflict');
      throw new NotFoundException('Resume adaptation not found');
    }
    return updated;
  }

  async softDeleteAdaptationWithRevision(id: string, userId: string, revision: number): Promise<void> {
    const updated = await this.adaptationModel.findOneAndUpdate(
      { _id: id, userId, revision, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() }, $inc: { revision: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) {
      const exists = await this.adaptationModel.exists({ _id: id, userId, deletedAt: { $exists: false } });
      if (exists) throw new ConflictException('Resume adaptation revision conflict');
      throw new NotFoundException('Resume adaptation not found');
    }
  }

  async restoreAdaptationWithRevision(id: string, userId: string, revision: number): Promise<ResumeAdaptation> {
    const updated = await this.adaptationModel.findOneAndUpdate(
      { _id: id, userId, revision, deletedAt: { $exists: true } },
      { $unset: { deletedAt: '' }, $inc: { revision: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) {
      const exists = await this.adaptationModel.exists({ _id: id, userId, deletedAt: { $exists: true } });
      if (exists) throw new ConflictException('Resume adaptation revision conflict');
      throw new NotFoundException('Resume adaptation not found');
    }
    return updated;
  }

  async attachAdaptationRun(id: string, userId: string, runId: string): Promise<ResumeAdaptation> {
    const updated = await this.adaptationModel.findOneAndUpdate(
      { _id: id, userId, deletedAt: { $exists: false } },
      { $set: { aiRunId: runId, generation: { runId, status: 'queued', createdAt: new Date() } } },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new NotFoundException('Resume adaptation not found');
    return updated;
  }

  async applyAdaptationGeneration(input: {
    id: string;
    userId: string;
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    documentJson?: Record<string, unknown>;
    suggestions?: Array<Partial<ResumeSuggestion>>;
    errorSummary?: string;
  }): Promise<ResumeAdaptation> {
    const patch: Partial<ResumeAdaptation> = {
      generation: {
        runId: input.runId,
        status: input.status,
        completedAt: new Date(),
        ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
      },
    };
    if (input.status === 'completed') {
      patch.status = 'review';
      if (input.documentJson) patch.documentJson = input.documentJson;
      patch.suggestions = (input.suggestions ?? []).map((suggestion) => ({
        id: suggestion.id ?? newId(),
        type: suggestion.type ?? 'other',
        title: suggestion.title ?? 'Resume improvement',
        rationale: suggestion.rationale,
        evidence: suggestion.evidence,
        proposed: suggestion.proposed ?? {},
        status: 'pending',
      }));
    } else {
      patch.status = 'failed';
    }
    const update = input.status === 'completed' ? { $set: patch, $inc: { revision: 1 } } : { $set: patch };
    const updated = await this.adaptationModel.findOneAndUpdate(
      { _id: input.id, userId: input.userId, deletedAt: { $exists: false } },
      update,
      { returnDocument: 'after' },
    ).lean();
    if (!updated) throw new NotFoundException('Resume adaptation not found');
    return updated;
  }
}
