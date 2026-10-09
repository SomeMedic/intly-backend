import { OpportunityType } from './schemas/opportunity.schema';

export const PIPELINE_DEFINITIONS = {
  vacancy: ['New', 'Reviewed', 'Interested', 'Applied', 'HRReply', 'Interview', 'TechnicalInterview', 'Offer', 'Rejected', 'Archived'],
  freelance: ['New', 'Reviewed', 'Interested', 'ResponseSent', 'ClientReplied', 'Negotiation', 'Won', 'InProgress', 'Completed', 'Lost', 'Archived'],
  tender: ['New', 'Reviewed', 'Interested', 'PreparingApplication', 'ApplicationSubmitted', 'Admitted', 'BiddingEvaluation', 'Won', 'Contracting', 'InProgress', 'Completed', 'Lost', 'Archived'],
} as const;

export type CanonicalPipelineStatus = (typeof PIPELINE_DEFINITIONS)[OpportunityType][number];

export const LEGACY_PIPELINE_STATUSES = ['Shortlisted'] as const;
export type LegacyPipelineStatus = (typeof LEGACY_PIPELINE_STATUSES)[number];

export const PIPELINE_STATUSES = Array.from(new Set([
  ...PIPELINE_DEFINITIONS.vacancy,
  ...PIPELINE_DEFINITIONS.freelance,
  ...PIPELINE_DEFINITIONS.tender,
  ...LEGACY_PIPELINE_STATUSES,
])) as [CanonicalPipelineStatus | LegacyPipelineStatus, ...(CanonicalPipelineStatus | LegacyPipelineStatus)[]];

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

const LEGACY_STATUS_MAP: Record<OpportunityType, Partial<Record<string, CanonicalPipelineStatus>>> = {
  vacancy: {
    Shortlisted: 'Interested',
    Won: 'Offer',
  },
  freelance: {
    Shortlisted: 'Interested',
    Applied: 'ResponseSent',
    Interview: 'Negotiation',
    Offer: 'Negotiation',
    Rejected: 'Lost',
  },
  tender: {
    Shortlisted: 'Interested',
    Applied: 'ApplicationSubmitted',
    Rejected: 'Lost',
  },
};

export function pipelineStagesForType(type: OpportunityType): readonly CanonicalPipelineStatus[] {
  return PIPELINE_DEFINITIONS[type];
}

export function isPipelineStageForType(type: OpportunityType, status: string): status is CanonicalPipelineStatus {
  return (PIPELINE_DEFINITIONS[type] as readonly string[]).includes(status);
}

export function normalizePipelineStatus(type: OpportunityType, status?: string | null): { status: CanonicalPipelineStatus; rawStatus: string | null; mapped: boolean; unmapped: boolean } {
  const rawStatus = typeof status === 'string' && status ? status : null;
  if (rawStatus && isPipelineStageForType(type, rawStatus)) {
    return { status: rawStatus, rawStatus, mapped: false, unmapped: false };
  }
  const mapped = rawStatus ? LEGACY_STATUS_MAP[type][rawStatus] : undefined;
  if (mapped) {
    return { status: mapped, rawStatus, mapped: true, unmapped: false };
  }
  return { status: 'New', rawStatus, mapped: false, unmapped: Boolean(rawStatus) };
}

export function legacyStatusesForCanonical(type: OpportunityType, status: string): string[] {
  const legacy = new Set<string>();
  for (const [raw, canonical] of Object.entries(LEGACY_STATUS_MAP[type])) {
    if (canonical === status) legacy.add(raw);
  }
  return Array.from(legacy);
}

export function expandPipelineStatusFilterForType(type: OpportunityType, statuses: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const status of statuses) {
    expanded.add(status);
    for (const legacy of legacyStatusesForCanonical(type, status)) expanded.add(legacy);
  }
  return Array.from(expanded);
}

export function pipelineStatusMatches(type: OpportunityType, rawStatus: string | undefined | null, canonicalStatuses: readonly string[]): boolean {
  if (!canonicalStatuses.length) return true;
  const wanted = new Set(canonicalStatuses);
  const normalized = normalizePipelineStatus(type, rawStatus);
  return wanted.has(normalized.status);
}

export function earliestPipelineReachedAtForType(
  type: OpportunityType,
  events: readonly { status?: string | null; firstReachedAt?: Date | string | null }[] | undefined,
  canonicalStatuses: readonly string[],
): Date | null {
  if (!canonicalStatuses.length) return null;
  const wanted = new Set(canonicalStatuses);
  const dates = (events ?? [])
    .filter((event) => wanted.has(normalizePipelineStatus(type, event.status).status))
    .map((event) => event.firstReachedAt ? new Date(event.firstReachedAt) : null)
    .filter((date): date is Date => date instanceof Date && Number.isFinite(+date))
    .sort((left, right) => +left - +right);
  return dates[0] ?? null;
}
