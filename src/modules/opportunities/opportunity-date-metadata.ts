import { Opportunity, SourceOccurrence } from './schemas/opportunity.schema';

type DayPrecision = { precision: 'day'; calendarDate: string; originalText?: string; timezone?: string };
export type OpportunityDateMetadata = { publishedAt?: DayPrecision; deadline?: DayPrecision };

/** Expose precision only from native evidence for the actual canonical value. */
export function opportunityDateMetadata(opportunity: Opportunity): OpportunityDateMetadata | undefined {
  const result: OpportunityDateMetadata = {};
  const occurrences = [...(opportunity.sourceOccurrences ?? [])].sort((a, b) => Number(b.primary) - Number(a.primary));
  for (const field of ['publishedAt', 'deadline'] as const) {
    const canonical = timestamp(opportunity[field]);
    if (canonical === undefined) continue;
    const occurrence = occurrences.find((item) => {
      const native = field === 'publishedAt' ? item.publishedAt : item.normalizedSnapshot?.deadline;
      return canonical === timestamp(native) && item.sourceMetadata?.[field === 'publishedAt' ? 'datePrecision' : 'deadlinePrecision'] === 'day';
    });
    if (!occurrence) continue;
    const metadata = dayMetadata(occurrence, field, canonical);
    if (metadata) result[field] = metadata;
  }
  return Object.keys(result).length ? result : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (!(value instanceof Date) && typeof value !== 'string') return undefined;
  const number = new Date(value).getTime();
  return Number.isFinite(number) ? number : undefined;
}

function dayMetadata(occurrence: SourceOccurrence, field: 'publishedAt' | 'deadline', value: number): DayPrecision | undefined {
  const metadata = occurrence.sourceMetadata ?? {};
  const timezoneValue = metadata[field === 'publishedAt' ? 'dateTimezone' : 'deadlineTimezone'];
  const timezone = typeof timezoneValue === 'string' && timezoneValue.trim() ? timezoneValue : 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone }).formatToParts(new Date(value));
    const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    const calendarDate = `${read('year')}-${read('month')}-${read('day')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(calendarDate)) return undefined;
    const original = metadata[field === 'publishedAt' ? 'publishedText' : 'deadlineText'];
    const originalText = typeof original === 'string' ? original.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300) : undefined;
    return { precision: 'day', calendarDate, timezone, ...(originalText ? { originalText } : {}) };
  } catch {
    // Invalid native timezone must not silently change the source calendar day.
    return undefined;
  }
}
