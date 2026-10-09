import { createHash } from 'node:crypto';
import { normalizePipelineStatus } from './pipeline-definitions';
import type { Opportunity, SourceOccurrence } from './schemas/opportunity.schema';
import type { OpportunityUserState } from './schemas/opportunity-user-state.schema';

function earliest(left: Date, right: Date): Date { return new Date(Math.min(+new Date(left), +new Date(right))); }
function latest(left: Date, right: Date): Date { return new Date(Math.max(+new Date(left), +new Date(right))); }

/** The selected canonical primary remains authoritative. Both originals remain as merge history. */
export function mergeSourceOccurrences(target: Opportunity, duplicate: Opportunity): SourceOccurrence[] {
  const identity = (occurrence: SourceOccurrence) => JSON.stringify([occurrence.sourceId, occurrence.externalId?.trim() || occurrence.url]);
  const occurrences = new Map<string, SourceOccurrence>();
  const primary = target.sourceOccurrences.find(occurrence => occurrence.primary) ?? target.sourceOccurrences[0] ?? duplicate.sourceOccurrences.find(occurrence => occurrence.primary) ?? duplicate.sourceOccurrences[0];
  for (const occurrence of [...target.sourceOccurrences, ...duplicate.sourceOccurrences]) {
    const key = identity(occurrence);
    const previous = occurrences.get(key);
    const fresh = previous && +new Date(previous.lastSeenAt) > +new Date(occurrence.lastSeenAt) ? previous : occurrence;
    occurrences.set(key, {
      ...fresh,
      firstSeenAt: previous ? earliest(previous.firstSeenAt, occurrence.firstSeenAt) : occurrence.firstSeenAt,
      lastSeenAt: previous ? latest(previous.lastSeenAt, occurrence.lastSeenAt) : occurrence.lastSeenAt,
      primary: Boolean(primary && identity(primary) === key),
    });
  }
  return [...occurrences.values()];
}

function mergeItems<T extends { id?: unknown }>(target: T[], duplicate: T[], sourceStateId: string): T[] {
  const result = [...target];
  for (const item of duplicate) {
    const identical = result.some(existing => JSON.stringify(existing) === JSON.stringify(item));
    if (identical) continue;
    const collision = item.id && result.some(existing => existing.id === item.id);
    result.push(collision ? { ...item, id: createHash('sha256').update(`${sourceStateId}:${String(item.id)}:${JSON.stringify(item)}`).digest('hex') } : item);
  }
  return result;
}

/** Never use matching's updatedAt as evidence of a person's pipeline decision. */
export function mergePersonalStates(target: OpportunityUserState, duplicate: OpportunityUserState, type: Opportunity['type']): Partial<OpportunityUserState> {
  if (target.userId !== duplicate.userId || target.profileId !== duplicate.profileId) throw new Error('Personal merge ownership mismatch');
  const targetStatus = normalizePipelineStatus(type, target.pipelineStatus).status;
  const hasTargetHistory = (target.pipelineEvents ?? []).some(event => normalizePipelineStatus(type, event.status).status !== 'New');
  const pipelineStatus = targetStatus === 'New' && !hasTargetHistory ? duplicate.pipelineStatus : target.pipelineStatus;
  const events = new Map<string, OpportunityUserState['pipelineEvents'][number]>();
  for (const event of [...(target.pipelineEvents ?? []), ...(duplicate.pipelineEvents ?? [])]) {
    const status = normalizePipelineStatus(type, event.status).status;
    const previous = events.get(status);
    if (!previous || +new Date(event.firstReachedAt) < +new Date(previous.firstReachedAt)) events.set(status, { ...event, status });
  }
  return {
    pipelineStatus,
    favorite: target.favorite || duplicate.favorite,
    hidden: target.hidden || duplicate.hidden,
    archived: target.archived || duplicate.archived,
    pinned: target.pinned || duplicate.pinned,
    tags: [...new Set([...(target.tags ?? []), ...(duplicate.tags ?? [])])],
    notes: mergeItems(target.notes ?? [], duplicate.notes ?? [], duplicate._id),
    checklist: mergeItems(target.checklist ?? [], duplicate.checklist ?? [], duplicate._id),
    pipelineEvents: [...events.values()],
    responseState: { ...(duplicate.responseState ?? {}), ...(target.responseState ?? {}) },
    ...(target.selectedResumeId || duplicate.selectedResumeId ? { selectedResumeId: target.selectedResumeId || duplicate.selectedResumeId } : {}),
  };
}
