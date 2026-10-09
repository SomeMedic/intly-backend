import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';

import { Actor } from '../../common/access';
import { toPublic } from '../../common/schema';
import { OpportunityUserStatesRepository, OpportunitiesRepository } from '../opportunities';
import { Opportunity, OpportunityType } from '../opportunities/schemas/opportunity.schema';
import { OpportunityUserState, PipelineStatus } from '../opportunities/schemas/opportunity-user-state.schema';
import { isPipelineStageForType, normalizePipelineStatus, pipelineStagesForType } from '../opportunities/pipeline-definitions';
import { Profile, ProfilesRepository } from '../profiles';
import { RealtimeService } from '../realtime/realtime.service';
import { CalendarRepository } from '../calendar';
import { Task, TasksService } from '../tasks';
import { PipelineQueryDto, UpdatePipelineDto } from './dto/pipelines.dto';

export type AttentionCode = 'needs_attention' | 'overdue' | 'follow_up_due' | 'deadline_urgent';
export type SuggestedActionKey = 'follow_up' | 'interview_prep' | 'negotiation' | 'project' | 'application' | 'submission_reminder' | 'contracting';

type BoardRow = {
  state: OpportunityUserState;
  opportunity: Opportunity;
  stage: PipelineStatus;
  rawStage: string | null;
  attention: AttentionCode[];
  dueAt: Date | null;
  aiScore: number | null;
  suggestedActions: SuggestedActionKey[];
};

type AttentionSource = {
  kind: 'task' | 'calendar';
  type?: string;
  dueAt: Date | null;
  reminderAts: Date[];
};

export type PipelineCardResponse = {
  id: string;
  state: Record<string, unknown> & { pipelineStatus: PipelineStatus; rawPipelineStatus: string | null };
  opportunity: Record<string, unknown>;
  attention: AttentionCode[];
  dueAt: string | null;
  suggestedActions: SuggestedActionKey[];
  aiScore: number | null;
};

export type PipelineColumnResponse = {
  stage: PipelineStatus;
  status: PipelineStatus;
  count: number;
  attentionCount: number;
  items: PipelineCardResponse[];
};

export type PipelineDiagnostics = {
  unmappedPipelineStatuses: Array<{ opportunityId: string; rawStatus: string }>;
};

export type PipelineBoardResponse = {
  type: OpportunityType;
  profileId: string | null;
  columns: PipelineColumnResponse[];
  diagnostics: PipelineDiagnostics;
};

export type PipelineUpdateResponse = {
  state: Record<string, unknown> & { pipelineStatus: PipelineStatus; rawPipelineStatus: string | null };
  opportunity: Record<string, unknown>;
};

export type PipelineAttentionResponse = {
  type: OpportunityType;
  profileId: string | null;
  items: PipelineCardResponse[];
  nextCursor: string | null;
  diagnostics: PipelineDiagnostics;
};

@Injectable()
export class PipelinesService {
  constructor(
    private readonly statesRepository: OpportunityUserStatesRepository,
    private readonly opportunitiesRepository: OpportunitiesRepository,
    private readonly profilesRepository: ProfilesRepository,
    private readonly realtime: RealtimeService,
    @Optional() @Inject(TasksService) private readonly tasksService?: TasksService,
    @Optional() @Inject(CalendarRepository) private readonly calendarRepository?: CalendarRepository,
  ) {}

  async board(actor: Actor, query: PipelineQueryDto): Promise<PipelineBoardResponse> {
    this.assertQuery(query);
    const type = query.type ?? 'vacancy';
    const profile = query.profileId ? await this.getAccessibleProfile(actor, query.profileId) : await this.profilesRepository.findActive(actor.id);
    const stages = pipelineStagesForType(type);
    if (!profile) {
      return { type, profileId: null, columns: stages.map((stage) => ({ stage, status: stage, count: 0, attentionCount: 0, items: [] })), diagnostics: { unmappedPipelineStatuses: [] } };
    }

    const states = await this.statesRepository.findByUserProfile(profile.userId, profile._id);
    const opportunities = await this.opportunitiesRepository.findByIds(states.map((state) => state.opportunityId));
    const opportunitiesById = new Map(opportunities.map((opportunity) => [opportunity._id, opportunity]));
    const typeStates = states.filter((state) => opportunitiesById.get(state.opportunityId)?.type === type);
    const aiRows = await this.opportunitiesRepository.latestCompletedAnalysisByOpportunity({ userId: profile.userId, profileId: profile._id, opportunityIds: typeStates.map((state) => state.opportunityId), minAiScore: query.minAiScore });
    const aiByOpportunity = new Map(aiRows.map((row) => [row.opportunityId, row.aiScore]));
    const attentionSources = await this.accessibleAttentionSources(actor, new Set(typeStates.map((state) => state.opportunityId)), profile);

    const diagnostics = { unmappedPipelineStatuses: [] as Array<{ opportunityId: string; rawStatus: string }> };
    const rows = typeStates
      .map((state): BoardRow | null => {
        const opportunity = opportunitiesById.get(state.opportunityId);
        if (!opportunity) return null;
        const normalized = normalizePipelineStatus(opportunity.type, state.pipelineStatus);
        if (normalized.unmapped && normalized.rawStatus) diagnostics.unmappedPipelineStatuses.push({ opportunityId: state.opportunityId, rawStatus: normalized.rawStatus });
        return {
          state,
          opportunity,
          stage: normalized.status,
          rawStage: normalized.rawStatus,
          attention: this.attentionCodes(opportunity, attentionSources.get(state.opportunityId) ?? []),
          dueAt: this.dueAt(opportunity, attentionSources.get(state.opportunityId) ?? []),
          aiScore: aiByOpportunity.has(state.opportunityId) ? aiByOpportunity.get(state.opportunityId) ?? null : null,
          suggestedActions: this.suggestedActions(opportunity.type, normalized.status),
        };
      })
      .filter((row): row is BoardRow => Boolean(row))
      .filter((row) => this.matchesFilters(row, query));

    this.sortRows(rows, query.sort ?? 'recommended');

    const columns = stages.map((stage) => {
      const items = rows.filter((row) => row.stage === stage).map((row) => this.card(row));
      return { stage, status: stage, count: items.length, attentionCount: items.filter((item) => item.attention.length > 0).length, items };
    });

    return { type, profileId: profile._id, columns, diagnostics };
  }

  async update(actor: Actor, opportunityId: string, dto: UpdatePipelineDto): Promise<PipelineUpdateResponse> {
    const profile = await this.getAccessibleProfile(actor, dto.profileId);
    const opportunity = await this.opportunitiesRepository.getById(opportunityId);
    this.assertPipelineStatusAllowed(opportunity.type, dto.pipelineStatus);
    const state = await this.statesRepository.upsert({
      userId: profile.userId,
      opportunityId,
      profileId: profile._id,
      pipelineStatus: dto.pipelineStatus,
    });
    const normalized = normalizePipelineStatus(opportunity.type, state.pipelineStatus);
    this.realtime.publish(profile.userId, 'pipeline.changed', { opportunityId, profileId: profile._id, pipelineStatus: normalized.status, rawPipelineStatus: state.pipelineStatus });
    return { state: { ...toPublic(state), pipelineStatus: normalized.status, rawPipelineStatus: state.pipelineStatus }, opportunity: toPublic(opportunity) };
  }

  private assertPipelineStatusAllowed(type: OpportunityType, status: string): void {
    if (!isPipelineStageForType(type, status)) {
      throw new BadRequestException({ code: 'PIPELINE_STATUS_INVALID', message: `Pipeline status ${status} is not valid for ${type} opportunities`, details: { type, status } });
    }
  }

  private assertQuery(query: PipelineQueryDto): void {
    const from = this.boundaryDate(query.dateFrom, 'from');
    const to = this.boundaryDate(query.dateTo, 'to');
    if (query.dateFrom && !from) {
      throw new BadRequestException({ code: 'PIPELINE_QUERY_INVALID', message: 'dateFrom must be a valid ISO date', details: { field: 'dateFrom' } });
    }
    if (query.dateTo && !to) {
      throw new BadRequestException({ code: 'PIPELINE_QUERY_INVALID', message: 'dateTo must be a valid ISO date', details: { field: 'dateTo' } });
    }
    if (from && to && +from > +to) {
      throw new BadRequestException({ code: 'PIPELINE_QUERY_INVALID', message: 'dateFrom must be before or equal to dateTo', details: { fields: ['dateFrom', 'dateTo'] } });
    }
  }

  private async getAccessibleProfile(actor: Actor, profileId: string) {
    return actor.role === 'Admin' ? this.profilesRepository.getById(profileId) : this.profilesRepository.getOwned(profileId, actor.id);
  }

  async attention(actor: Actor, query: PipelineQueryDto = {}): Promise<PipelineAttentionResponse> {
    const board = await this.board(actor, { ...query, attention: query.attention ?? 'needs_attention' });
    return { type: board.type, profileId: board.profileId, items: board.columns.flatMap((column) => column.items), nextCursor: null, diagnostics: board.diagnostics };
  }

  private async accessibleAttentionSources(actor: Actor, opportunityIds: Set<string>, profile: Profile): Promise<Map<string, AttentionSource[]>> {
    if (!opportunityIds.size) return new Map();
    const end = new Date(Date.now() + 30 * 86_400_000);
    const byOpportunity = new Map<string, AttentionSource[]>();
    const taskById = new Map<string, Task>();
    const ownerActor: Actor = { ...actor, id: profile.userId };
    if (this.tasksService) {
      const loadTasks = typeof this.tasksService.attentionTasksForUser === 'function'
        ? this.tasksService.attentionTasksForUser(ownerActor, { end })
        : this.tasksService.dueTasksForUser(ownerActor, { end });
      for (const task of await loadTasks) {
        if (task.completedAt) continue;
        taskById.set(task._id, task);
        if (!task.opportunityId || !opportunityIds.has(task.opportunityId)) continue;
        if (task.profileId && task.profileId !== profile._id) continue;
        this.addAttentionSource(byOpportunity, task.opportunityId, {
          kind: 'task',
          type: task.type,
          dueAt: this.validDate(task.dueAt),
          reminderAts: (task.reminders ?? []).map((reminder) => this.validDate(reminder.remindAt)).filter((date): date is Date => Boolean(date)),
        });
      }
    }
    if (this.calendarRepository) {
      const events = await this.calendarRepository.list(profile.userId, { end });
      for (const event of events) {
        const linkedTask = event.taskId ? taskById.get(event.taskId) : undefined;
        const opportunityId = event.opportunityId ?? linkedTask?.opportunityId;
        if (!opportunityId || !opportunityIds.has(opportunityId)) continue;
        if (linkedTask?.profileId && linkedTask.profileId !== profile._id) continue;
        this.addAttentionSource(byOpportunity, opportunityId, {
          kind: 'calendar',
          type: event.type,
          dueAt: this.validDate(event.startAt),
          reminderAts: (event.reminders ?? []).map((reminder) => this.validDate((reminder as { remindAt?: Date | string }).remindAt)).filter((date): date is Date => Boolean(date)),
        });
      }
    }
    return byOpportunity;
  }

  private addAttentionSource(target: Map<string, AttentionSource[]>, opportunityId: string, source: AttentionSource): void {
    target.set(opportunityId, [...(target.get(opportunityId) ?? []), source]);
  }

  private card(row: BoardRow): PipelineCardResponse {
    return {
      id: row.state.opportunityId,
      state: { ...toPublic(row.state), pipelineStatus: row.stage, rawPipelineStatus: row.rawStage },
      opportunity: toPublic(row.opportunity),
      attention: row.attention,
      dueAt: row.dueAt?.toISOString?.() ?? null,
      suggestedActions: row.suggestedActions,
      aiScore: row.aiScore,
    };
  }

  private matchesFilters(row: BoardRow, query: PipelineQueryDto): boolean {
    if (query.sourceIds?.length && !(row.opportunity.sourceOccurrences ?? []).some((occurrence) => query.sourceIds!.includes(occurrence.sourceId))) return false;
    if (typeof query.minMatch === 'number' && (typeof row.state.matchScore !== 'number' || row.state.matchScore < query.minMatch)) return false;
    if (typeof query.minAiScore === 'number' && (typeof row.aiScore !== 'number' || row.aiScore < query.minAiScore)) return false;
    if (query.tags?.length && !query.tags.some((tag) => (row.state.tags ?? []).includes(tag) || (row.opportunity.canonicalTags ?? []).includes(tag))) return false;
    if (query.counterpart && !(row.opportunity.companyOrClient ?? '').toLowerCase().includes(query.counterpart.toLowerCase())) return false;
    if (!this.inDateWindow(row.opportunity.firstSeenAt, query.dateFrom, query.dateTo)) return false;
    const attention = query.attention ?? 'all';
    if (attention === 'needs_attention' && row.attention.length === 0) return false;
    if (attention !== 'all' && attention !== 'needs_attention' && !row.attention.includes(attention)) return false;
    return true;
  }

  private sortRows(rows: BoardRow[], sort: string): void {
    const score = (row: BoardRow) => Math.max(row.state.matchScore ?? 0, row.aiScore ?? 0);
    const date = (value?: Date | string | null) => value ? new Date(value).getTime() : 0;
    rows.sort((left, right) => {
      if (sort === 'freshness') return date(right.opportunity.firstSeenAt) - date(left.opportunity.firstSeenAt) || left.opportunity._id.localeCompare(right.opportunity._id);
      if (sort === 'score') return score(right) - score(left) || date(right.opportunity.firstSeenAt) - date(left.opportunity.firstSeenAt) || left.opportunity._id.localeCompare(right.opportunity._id);
      if (sort === 'deadline') return this.sortableDue(left) - this.sortableDue(right) || left.opportunity._id.localeCompare(right.opportunity._id);
      return score(right) - score(left) || this.sortableDue(left) - this.sortableDue(right) || date(right.opportunity.firstSeenAt) - date(left.opportunity.firstSeenAt) || left.opportunity._id.localeCompare(right.opportunity._id);
    });
  }

  private sortableDue(row: BoardRow): number {
    return row.dueAt ? +row.dueAt : Number.MAX_SAFE_INTEGER;
  }

  private attentionCodes(opportunity: Opportunity, sources: AttentionSource[]): AttentionCode[] {
    const now = Date.now();
    const codes = new Set<AttentionCode>();
    const signalDates = sources.flatMap((source) => [source.dueAt, ...source.reminderAts]).filter((date): date is Date => Boolean(date));
    if (signalDates.length) codes.add('needs_attention');
    if (signalDates.some((date) => +date <= now)) codes.add('overdue');
    if (sources.some((source) => source.type === 'Follow-up' && [source.dueAt, ...source.reminderAts].some((date) => date && +date <= now))) codes.add('follow_up_due');
    const deadline = opportunity.deadline ? new Date(opportunity.deadline) : null;
    if (deadline && Number.isFinite(+deadline) && +deadline >= now && +deadline <= now + 7 * 86_400_000) codes.add('deadline_urgent');
    if (deadline && Number.isFinite(+deadline) && +deadline < now) codes.add('overdue');
    return Array.from(codes);
  }

  private dueAt(opportunity: Opportunity, sources: AttentionSource[]): Date | null {
    const dates = [
      ...sources.flatMap((source) => [source.dueAt, ...source.reminderAts]),
      opportunity.deadline ? new Date(opportunity.deadline) : null,
    ].filter((date): date is Date => date instanceof Date && Number.isFinite(+date)).sort((left, right) => +left - +right);
    return dates[0] ?? null;
  }

  private validDate(value?: Date | string | null): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(+date) ? date : null;
  }

  private suggestedActions(type: OpportunityType, stage: string): SuggestedActionKey[] {
    if (type === 'vacancy' && stage === 'Applied') return ['follow_up'];
    if (type === 'vacancy' && stage === 'Interview') return ['interview_prep'];
    if (type === 'freelance' && stage === 'ResponseSent') return ['follow_up'];
    if (type === 'freelance' && stage === 'ClientReplied') return ['negotiation'];
    if (type === 'freelance' && stage === 'Won') return ['project'];
    if (type === 'tender' && stage === 'PreparingApplication') return ['application'];
    if (type === 'tender' && stage === 'ApplicationSubmitted') return ['submission_reminder'];
    if (type === 'tender' && stage === 'Won') return ['contracting'];
    return [];
  }

  private inDateWindow(value: Date | string | undefined, from?: string, to?: string): boolean {
    const date = value ? new Date(value) : null;
    if (!date || !Number.isFinite(+date)) return true;
    const fromDate = this.boundaryDate(from, 'from');
    const toDate = this.boundaryDate(to, 'to');
    if (fromDate && +date < +fromDate) return false;
    if (toDate && +date > +toDate) return false;
    return true;
  }

  private boundaryDate(value: string | undefined, edge: 'from' | 'to'): Date | null {
    if (!value) return null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T${edge === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`) : new Date(value);
    return Number.isFinite(+date) ? date : null;
  }
}
