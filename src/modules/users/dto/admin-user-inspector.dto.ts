import { BadRequestException } from '@nestjs/common';

export const ADMIN_USER_INSPECTOR_SECTIONS = [
  'profiles',
  'resumes',
  'adaptations',
  'knowledge',
  'watchlists',
  'opportunities',
  'responses',
  'tasks',
  'boards',
  'aiRuns',
] as const;

export type AdminUserInspectorSection = (typeof ADMIN_USER_INSPECTOR_SECTIONS)[number];

export type AdminUserInspectorPageQuery = {
  limit?: string;
  cursor?: string;
};

export type AdminUserInspectorBatchOverviewDto = {
  userIds?: string[];
};

export type AdminUserInspectorOverview = {
  userId: string;
  counts: {
    profiles: number;
    resumes: number;
    adaptations: number;
    knowledge: number;
    watchlists: number;
    watchlistHits: number;
    opportunityStates: number;
    responses: number;
    tasks: number;
    tasksAssigned: number;
    tasksReported: number;
    boards: number;
    aiRuns: number;
  };
  breakdowns: {
    knowledgeByStatus: Record<string, number>;
    opportunitiesByPipelineStatus: Record<string, number>;
  };
  currentMonthAiUsage: unknown;
  period: { dateFrom: string; dateTo: string };
};

export type AdminUserInspectorBatchOverview = {
  items: AdminUserInspectorOverview[];
  nextCursor: null;
};

export type AdminUserInspectorPage = {
  section: AdminUserInspectorSection;
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
};

export type AdminUserInspectorContent = {
  section: AdminUserInspectorSection;
  item: Record<string, unknown>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseInspectorSection(value: string): AdminUserInspectorSection {
  if ((ADMIN_USER_INSPECTOR_SECTIONS as readonly string[]).includes(value)) return value as AdminUserInspectorSection;
  throw new BadRequestException('Invalid admin user inspector section');
}

export function parseInspectorLimit(value: string | undefined): number {
  if (value === undefined || value === '') return 25;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('Inspector limit must be an integer from 1 to 50');
  return limit;
}

export function assertInspectorUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw new BadRequestException(`${label} must be a UUID`);
  return value;
}

export function parseInspectorCursor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return assertInspectorUuid(value, 'cursor');
}

export function parseInspectorUserIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new BadRequestException('userIds must be an array');
  if (value.length < 1 || value.length > 50) throw new BadRequestException('userIds must contain 1 to 50 ids');
  const unique = [...new Set(value)];
  if (unique.length !== value.length) throw new BadRequestException('userIds must be unique');
  return unique.map((item) => {
    if (typeof item !== 'string') throw new BadRequestException('userIds must be UUID strings');
    return assertInspectorUuid(item, 'userId');
  });
}
