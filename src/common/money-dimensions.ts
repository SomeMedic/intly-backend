export type MoneyDimension = 'period' | 'kind';

const PERIOD_ALIASES: Record<string, string[]> = {
  hour: ['hour', 'hourly'],
  day: ['day'],
  week: ['week'],
  month: ['month'],
  year: ['year'],
  project: ['project'],
};

const KIND_ALIASES: Record<string, string[]> = {
  salary: ['salary'],
  budget: ['budget'],
  rate: ['rate'],
  gross: ['gross'],
  net: ['net'],
};

export function canonicalMoneyDimensionValue(kind: MoneyDimension, value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = normalizeMoneyToken(trimmed);
  if (normalized === undefined) return undefined;
  if (normalized === 'unknown') return 'unknown';
  const aliases = kind === 'period' ? PERIOD_ALIASES : KIND_ALIASES;
  return Object.entries(aliases).find(([, values]) => values.includes(normalized))?.[0] ?? trimmed;
}

export function addMoneyDimensionFilter(filter: Record<string, unknown>, and: Record<string, unknown>[], field: string, kind: MoneyDimension, value?: string): void {
  const trimmed = value?.trim();
  if (!trimmed) return;
  const canonical = canonicalMoneyDimensionValue(kind, trimmed);
  if (canonical === 'unknown') {
    and.push({ $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }, { [field]: { $regex: '^unknown$', $options: 'i' } }] });
    return;
  }
  const aliases = canonical ? (kind === 'period' ? PERIOD_ALIASES : KIND_ALIASES)[canonical] : undefined;
  if (!aliases?.length) {
    filter[field] = trimmed;
    return;
  }
  and.push({ $or: aliases.map((alias) => ({ [field]: { $regex: `^${escapeRegex(alias)}$`, $options: 'i' } })) });
}

function normalizeMoneyToken(value?: string): string | undefined {
  const normalized = value?.trim().replace(/-/g, '_').toLowerCase();
  return normalized || undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
