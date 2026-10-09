import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

import { AdminUserInspectorSection } from './dto/admin-user-inspector.dto';

type Filter = Record<string, unknown>;
type Sort = Record<string, 1 | -1>;
type Row = Record<string, unknown>;
type CollectionLike = {
  findOne(filter: Filter, options?: { projection?: Record<string, 0 | 1> }): Promise<Row | null>;
  countDocuments(filter: Filter): Promise<number>;
  find(filter: Filter, options?: { projection?: Record<string, 0 | 1> }): { sort(sort: Sort): { limit(limit: number): { toArray(): Promise<Row[]> } } };
  aggregate(pipeline: Array<Record<string, unknown>>): { toArray(): Promise<Row[]> };
};

type PageInput = { section: AdminUserInspectorSection; userId: string; limit: number; cursor?: string };

type SectionConfig = {
  collection: string;
  filter: (userId: string) => Filter;
  projection: Record<string, 0 | 1>;
  sort?: Sort;
};

const active = { deletedAt: { $exists: false } } as const;

@Injectable()
export class AdminUserInspectorRepository {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async getUser(id: string): Promise<Row> {
    const user = await this.collection('users').findOne({ _id: id }, { projection: { passwordHash: 0, telegram: 0 } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async overviewCounts(userId: string) {
    const [
      profiles,
      resumes,
      adaptations,
      knowledge,
      watchlists,
      watchlistHits,
      opportunityStates,
      responses,
      tasks,
      tasksAssigned,
      tasksReported,
      boards,
      aiRuns,
      knowledgeByStatus,
      opportunitiesByPipelineStatus,
    ] = await Promise.all([
      this.count('profiles', { userId, ...active }),
      this.count('resumes', { userId, ...active }),
      this.count('resume_adaptations', { userId, ...active }),
      this.count('knowledgedocuments', { userId, ...active }),
      this.count('watchlists', { userId, ...active }),
      this.count('watchlisthits', { userId }),
      this.count('opportunityuserstates', { userId, ...active }),
      this.count('responses', { userId, ...active }),
      this.count('tasks', { $or: [{ assigneeId: userId }, { reporterId: userId }], ...active }),
      this.count('tasks', { assigneeId: userId, ...active }),
      this.count('tasks', { reporterId: userId, ...active }),
      this.count('boards', { $or: [{ ownerUserId: userId }, { members: userId }], ...active }),
      this.count('ai_analyses', { userId }),
      this.groupCount('knowledgedocuments', { userId, ...active }, 'status'),
      this.groupCount('opportunityuserstates', { userId, ...active }, 'pipelineStatus'),
    ]);
    return {
      counts: { profiles, resumes, adaptations, knowledge, watchlists, watchlistHits, opportunityStates, responses, tasks, tasksAssigned, tasksReported, boards, aiRuns },
      breakdowns: { knowledgeByStatus, opportunitiesByPipelineStatus },
    };
  }

  async list(input: PageInput): Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null }> {
    if (input.section === 'opportunities') return this.listOpportunities(input);
    const config = this.config(input.section);
    const filter: Filter = { ...config.filter(input.userId), ...(input.cursor ? { _id: { $gt: input.cursor } } : {}) };
    const rows = await this.collection(config.collection)
      .find(filter, { projection: config.projection })
      .sort(config.sort ?? { _id: 1 })
      .limit(input.limit + 1)
      .toArray();
    return this.page(rows, input.limit, (row) => this.publicSummary(input.section, row));
  }

  async content(section: AdminUserInspectorSection, userId: string, entityId: string): Promise<Record<string, unknown>> {
    if (section === 'opportunities') return this.opportunityContent(userId, entityId);
    const config = this.config(section);
    const row = await this.collection(config.collection).findOne({ ...config.filter(userId), _id: entityId }, { projection: this.contentProjection(section) });
    if (!row) throw new NotFoundException('Inspector item not found');
    return this.publicContent(section, row);
  }

  private async listOpportunities(input: PageInput) {
    const rows = await this.collection('opportunityuserstates').aggregate([
      { $match: { userId: input.userId, ...active, ...(input.cursor ? { _id: { $gt: input.cursor } } : {}) } },
      { $sort: { _id: 1 } },
      { $limit: input.limit + 1 },
      { $lookup: { from: 'opportunities', localField: 'opportunityId', foreignField: '_id', as: 'opportunity' } },
      { $set: { opportunity: { $arrayElemAt: ['$opportunity', 0] } } },
      { $project: {
        _id: 1, opportunityId: 1, profileId: 1, pipelineStatus: 1, favorite: 1, hidden: 1, archived: 1, tags: 1, matchScore: 1, matchCalculatedAt: 1, selectedResumeId: 1, updatedAt: 1, createdAt: 1,
        'opportunity._id': 1, 'opportunity.type': 1, 'opportunity.title': 1, 'opportunity.companyOrClient': 1, 'opportunity.summary': 1, 'opportunity.sourceStatus': 1, 'opportunity.firstSeenAt': 1, 'opportunity.deadline': 1,
      } },
    ]).toArray();
    return this.page(rows, input.limit, (row) => this.publicSummary('opportunities', row));
  }

  private async opportunityContent(userId: string, entityId: string) {
    const [row] = await this.collection('opportunityuserstates').aggregate([
      { $match: { userId, _id: entityId, ...active } },
      { $lookup: { from: 'opportunities', localField: 'opportunityId', foreignField: '_id', as: 'opportunity' } },
      { $set: { opportunity: { $arrayElemAt: ['$opportunity', 0] } } },
      { $project: {
        _id: 1, opportunityId: 1, profileId: 1, pipelineStatus: 1, favorite: 1, hidden: 1, archived: 1, tags: 1, matchScore: 1, matchComponents: 1, matchCalculatedAt: 1, responseState: 1, notes: 1, checklist: 1, pinned: 1, selectedResumeId: 1, pipelineEvents: 1, createdAt: 1, updatedAt: 1,
        'opportunity._id': 1, 'opportunity.type': 1, 'opportunity.title': 1, 'opportunity.companyOrClient': 1, 'opportunity.summary': 1, 'opportunity.description': 1, 'opportunity.skills': 1, 'opportunity.technologies': 1, 'opportunity.money': 1, 'opportunity.sourceStatus': 1, 'opportunity.firstSeenAt': 1, 'opportunity.lastSeenAt': 1, 'opportunity.deadline': 1, 'opportunity.canonicalTags': 1,
      } },
    ]).toArray();
    if (!row) throw new NotFoundException('Inspector item not found');
    return this.publicContent('opportunities', row);
  }

  private config(section: Exclude<AdminUserInspectorSection, 'opportunities'>): SectionConfig {
    const configs: Record<Exclude<AdminUserInspectorSection, 'opportunities'>, SectionConfig> = {
      profiles: { collection: 'profiles', filter: (userId) => ({ userId, ...active }), projection: { _id: 1, name: 1, kind: 1, isActive: 1, targetRoles: 1, technologies: 1, updatedAt: 1, createdAt: 1 } },
      resumes: { collection: 'resumes', filter: (userId) => ({ userId, ...active }), projection: { _id: 1, profileId: 1, kind: 1, title: 1, status: 1, revision: 1, opportunityId: 1, updatedAt: 1, createdAt: 1 } },
      adaptations: { collection: 'resume_adaptations', filter: (userId) => ({ userId, ...active }), projection: { _id: 1, profileId: 1, opportunityId: 1, baseResumeId: 1, status: 1, revision: 1, aiRunId: 1, updatedAt: 1, createdAt: 1 } },
      knowledge: { collection: 'knowledgedocuments', filter: (userId) => ({ userId, ...active }), projection: { _id: 1, profileIds: 1, fileId: 1, title: 1, type: 1, mode: 1, status: 1, summary: 1, chunkCount: 1, lastError: 1, processedAt: 1, updatedAt: 1, createdAt: 1 } },
      watchlists: { collection: 'watchlists', filter: (userId) => ({ userId, ...active }), projection: { _id: 1, profileId: 1, name: 1, matchMin: 1, aiMin: 1, active: 1, totalHits: 1, lastHitAt: 1, updatedAt: 1, createdAt: 1 } },
      responses: { collection: 'responses', filter: (userId) => ({ userId, ...active }), projection: { _id: 1, profileId: 1, opportunityId: 1, opportunityType: 1, format: 1, status: 1, revision: 1, sentAt: 1, unresolvedPlaceholders: 1, updatedAt: 1, createdAt: 1 } },
      tasks: { collection: 'tasks', filter: (userId) => ({ $or: [{ assigneeId: userId }, { reporterId: userId }], ...active }), projection: { _id: 1, boardId: 1, type: 1, title: 1, statusColumnId: 1, priority: 1, reporterId: 1, assigneeId: 1, opportunityId: 1, profileId: 1, dueAt: 1, completedAt: 1, updatedAt: 1, createdAt: 1 } },
      boards: { collection: 'boards', filter: (userId) => ({ $or: [{ ownerUserId: userId }, { members: userId }], ...active }), projection: { _id: 1, ownerUserId: 1, name: 1, members: 1, columns: 1, scope: 1, updatedAt: 1, createdAt: 1 } },
      aiRuns: { collection: 'ai_analyses', filter: (userId) => ({ userId }), projection: { _id: 1, profileId: 1, opportunityId: 1, taskType: 1, status: 1, stage: 1, provider: 1, modelId: 1, fallbackUsed: 1, aiScore: 1, usage: 1, startedAt: 1, completedAt: 1, errorCode: 1, errorSummary: 1, createdAt: 1, updatedAt: 1 } },
    };
    return configs[section];
  }

  private contentProjection(section: AdminUserInspectorSection): Record<string, 0 | 1> {
    const common = { _id: 1, createdAt: 1, updatedAt: 1 } as const;
    const projections: Record<Exclude<AdminUserInspectorSection, 'opportunities'>, Record<string, 0 | 1>> = {
      profiles: { ...common, userId: 1, name: 1, kind: 1, isActive: 1, targetRoles: 1, seniority: 1, technologies: 1, compensationPreferences: 1, locations: 1, remotePreferences: 1, employmentTypes: 1, sourceIds: 1, matchWeights: 1, aiPreferences: 1, structuredExperienceSummary: 1 },
      resumes: { ...common, userId: 1, profileId: 1, kind: 1, title: 1, documentJson: 1, markdownCache: 1, sourceFileId: 1, baseResumeId: 1, opportunityId: 1, revision: 1, status: 1 },
      adaptations: { ...common, userId: 1, profileId: 1, opportunityId: 1, baseResumeId: 1, documentJson: 1, markdownCache: 1, suggestions: 1, status: 1, revision: 1, aiRunId: 1, generation: 1, exportState: 1 },
      knowledge: { ...common, userId: 1, profileIds: 1, fileId: 1, title: 1, type: 1, mode: 1, status: 1, extractedText: 1, structuredExtract: 1, summary: 1, chunkCount: 1, lastError: 1, processedAt: 1 },
      watchlists: { ...common, userId: 1, profileId: 1, name: 1, filters: 1, matchMin: 1, aiMin: 1, autoAiRules: 1, notificationPolicy: 1, exclusions: 1, active: 1, totalHits: 1, lastHitAt: 1 },
      responses: { ...common, userId: 1, profileId: 1, opportunityId: 1, opportunityType: 1, format: 1, revision: 1, documentJson: 1, markdownCache: 1, status: 1, proposedCommercialFields: 1, checklist: 1, unresolvedPlaceholders: 1, generation: 1, pipelineHandoff: 1, sentAt: 1 },
      tasks: { ...common, boardId: 1, projectId: 1, type: 1, title: 1, description: 1, statusColumnId: 1, priority: 1, reporterId: 1, assigneeId: 1, opportunityId: 1, profileId: 1, dueAt: 1, labels: 1, subtasks: 1, checklist: 1, reminders: 1, completedAt: 1 },
      boards: { ...common, ownerUserId: 1, name: 1, members: 1, columns: 1, scope: 1 },
      aiRuns: { ...common, userId: 1, profileId: 1, opportunityId: 1, taskType: 1, status: 1, stage: 1, provider: 1, modelId: 1, fallbackUsed: 1, structuredOutput: 1, aiScore: 1, usage: 1, attempts: 1, feedback: 1, startedAt: 1, completedAt: 1, errorCode: 1, errorSummary: 1 },
    };
    return section === 'opportunities' ? {} : projections[section];
  }

  private publicSummary(section: AdminUserInspectorSection, row: Record<string, unknown>): Record<string, unknown> {
    return this.withId(this.redact(section, row));
  }

  private publicContent(section: AdminUserInspectorSection, row: Record<string, unknown>): Record<string, unknown> {
    return this.withId(this.redact(section, row));
  }

  private redact(section: AdminUserInspectorSection, row: Record<string, unknown>): Record<string, unknown> {
    if (section !== 'aiRuns') return row;
    return this.redactAiRun(row);
  }

  private redactAiRun(row: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...row };
    delete copy.prompt;
    delete copy.metadata;
    return this.redactSensitiveValue(copy) as Record<string, unknown>;
  }

  private redactSensitiveValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.redactSensitiveValue(item));
    if (value instanceof Date) return value;
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalized.includes('secret') || normalized.includes('password') || normalized.includes('apikey') || normalized === 'key' || normalized === 'authorization' || normalized === 'token' || (normalized.endsWith('token') && !normalized.endsWith('tokens'))) return [key, '[redacted]'];
      return [key, this.redactSensitiveValue(item)];
    }));
  }

  private withId(row: Record<string, unknown>): Record<string, unknown> {
    const { _id, ...rest } = row;
    return { ...rest, id: _id };
  }

  private page(rows: Row[], limit: number, map: (row: Row) => Record<string, unknown>) {
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: pageRows.map((row) => map(row)),
      nextCursor: hasMore ? String(pageRows[pageRows.length - 1]._id) : null,
    };
  }

  private count(collection: string, filter: Filter) {
    return this.collection(collection).countDocuments(filter);
  }

  private async groupCount(collection: string, filter: Filter, field: string): Promise<Record<string, number>> {
    const rows = await this.collection(collection).aggregate([
      { $match: filter },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    return Object.fromEntries(rows.map((row: Row) => [String(row._id ?? 'unknown'), Number(row.count ?? 0)]));
  }

  private collection(name: string): CollectionLike {
    return this.connection.collection(name) as unknown as CollectionLike;
  }
}
