import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import { RawOpportunityRecord } from '../connectors/connector.types';
import { NormalizedOpportunityInput } from '../ingestion/source-ingestion.types';
import { Source } from '../schemas/source.schema';

@Injectable()
export class SourceNormalizerService {
  normalize(source: Source, record: RawOpportunityRecord): NormalizedOpportunityInput {
    const now = new Date();
    const metadata = record.sourceMetadata ?? {};
    const skills = this.metadataStrings(metadata, ['skills', 'tags', 'categoryTags', 'categories', 'fields']);
    const normalized: NormalizedOpportunityInput = {
      type: record.type,
      title: record.title.trim(),
      companyOrClient: record.companyOrClient?.trim() ?? '',
      description: record.description ?? '',
      skills,
      technologies: skills,
      seniority: this.metadataString(metadata, ['seniority', 'experienceLevel', 'experience']),
      employmentType: this.metadataString(metadata, ['employment', 'employmentType', 'positionType']),
      location: this.location(metadata),
      remoteType: this.remoteType(metadata),
      money: this.money(metadata),
      deadline: this.metadataDate(metadata.deadlineAt),
      publishedAt: record.publishedAt,
      sourceStatus: record.sourceStatus,
      sourceOccurrences: [
        {
          sourceId: source._id,
          externalId: record.externalId,
          url: record.url,
          primary: true,
          firstSeenAt: now,
          lastSeenAt: now,
          publishedAt: record.publishedAt,
          checksum: this.hash(record.rawPayload),
          status: record.sourceStatus,
          rawPayload: record.rawPayload,
          sourceMetadata: record.sourceMetadata,
        },
      ],
      canonicalTags: [source.connectorFamily, source.group],
      vacancyData: record.type === 'vacancy' ? { ...this.record(metadata.vacancyData), sourceName: source.name } : {},
      freelanceData: record.type === 'freelance' ? { ...this.record(metadata.freelanceData), sourceName: source.name } : {},
      tenderData: record.type === 'tender' ? { ...this.record(metadata.tenderData), sourceName: source.name } : {},
      fingerprint: this.fingerprint(record),
    };
    return normalized;
  }

  private fingerprint(record: RawOpportunityRecord): string {
    return this.hash({
      type: record.type,
      title: record.title.toLowerCase().trim(),
      companyOrClient: record.companyOrClient?.toLowerCase().trim() ?? '',
      url: record.url,
    });
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private money(metadata: Record<string, unknown>): Record<string, unknown> {
    const salary = this.nonEmptyRecord(metadata.salary);
    if (salary) return this.moneyFromRecord(salary);
    const budget = this.nonEmptyRecord(metadata.budget);
    if (budget) return this.moneyFromRecord(budget);
    return {};
  }

  private moneyFromRecord(value: Record<string, unknown>): Record<string, unknown> {
    const amount = this.optionalNumber(value.amount);
    const min = this.optionalNumber(value.from ?? value.min) ?? amount;
    const max = this.optionalNumber(value.to ?? value.max) ?? amount;
    return this.omitUndefined({
      originalText: this.optionalString(value.originalText),
      amount,
      min,
      max,
      currency: this.optionalString(value.currency),
      period: this.optionalString(value.period),
      kind: this.optionalString(value.kind),
      gross: typeof value.gross === 'boolean' ? value.gross : undefined,
    });
  }

  private location(metadata: Record<string, unknown>): string | undefined {
    return this.metadataString(metadata, ['area', 'location', 'locationBase']) ?? this.locationFromItems(metadata.locations);
  }

  private remoteType(metadata: Record<string, unknown>): string | undefined {
    return this.metadataString(metadata, ['schedule', 'remoteType']) ?? this.firstRecordString(metadata.locations, ['format']);
  }

  private locationFromItems(value: unknown): string | undefined {
    if (!Array.isArray(value)) return undefined;
    const locations = value
      .map((item) => (typeof item === 'string' ? this.optionalString(item) : this.recordString(item, ['label', 'displayName', 'name'])))
      .filter((item): item is string => Boolean(item));
    return locations.length > 0 ? Array.from(new Set(locations)).join(', ') : undefined;
  }

  private metadataStrings(metadata: Record<string, unknown>, keys: string[]): string[] {
    const values = keys.flatMap((key) => this.stringArray(metadata[key]));
    return Array.from(new Set(values));
  }

  private metadataString(metadata: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.optionalString(metadata[key]);
      if (value) return value;
    }
    return undefined;
  }

  private firstRecordString(value: unknown, keys: string[]): string | undefined {
    if (!Array.isArray(value)) return undefined;
    for (const item of value) {
      const found = this.recordString(item, keys);
      if (found) return found;
    }
    return undefined;
  }

  private recordString(value: unknown, keys: string[]): string | undefined {
    const record = this.record(value);
    if (!record) return undefined;
    return this.metadataString(record, keys);
  }

  private metadataDate(value: unknown): Date | undefined {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    if (typeof value !== 'string' || value.trim().length === 0) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim())) return undefined;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => this.optionalString(item)).filter((item): item is string => Boolean(item)) : [];
  }

  private record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }

  private nonEmptyRecord(value: unknown): Record<string, unknown> | null {
    const record = this.record(value);
    if (!record) return null;
    return Object.values(record).some((item) => item !== null && item !== undefined && item !== '') ? record : null;
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  private optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
  }
}
