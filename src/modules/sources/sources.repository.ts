import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SOURCE_CATALOG } from './catalog/source-catalog';
import { SourceCatalogEntry } from './catalog/source-catalog.types';
import { SourceDlq, SourceDlqDocument } from './schemas/source-dlq.schema';
import { SourceRun, SOURCE_RUN_ACTIVE_COLLECTION_INDEX, SOURCE_RUN_ACTIVE_COLLECTION_INDEX_KEY, SOURCE_RUN_ACTIVE_COLLECTION_INDEX_OPTIONS, SOURCE_RUN_COLLECTION_TYPES, SourceRunDocument, SourceRunStatus } from './schemas/source-run.schema';
import { Source, SourceDocument } from './schemas/source.schema';

const SOURCE_RUN_CURSOR_VERSION = 1;
const UUID_CURSOR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SourceRunsCursor = {
  v: typeof SOURCE_RUN_CURSOR_VERSION;
  id: string;
  createdAt: string;
  sourceId?: string;
  status?: string;
};

export function isSourceActiveRunConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; index?: unknown; keyPattern?: unknown; errmsg?: unknown; message?: unknown };
  if (candidate.code !== 11000) return false;
  const keyPattern = candidate.keyPattern;
  const hasSourceIdKey = !!keyPattern && typeof keyPattern === 'object' && (keyPattern as Record<string, unknown>).sourceId === 1;
  if (!hasSourceIdKey) return false;
  const index = typeof candidate.index === 'string' ? candidate.index : undefined;
  const message = [candidate.errmsg, candidate.message].filter((value): value is string => typeof value === 'string').join(' ');
  return index === SOURCE_RUN_ACTIVE_COLLECTION_INDEX || message.includes(SOURCE_RUN_ACTIVE_COLLECTION_INDEX);
}

@Injectable()
export class SourcesRepository {
  constructor(
    @InjectModel(Source.name) private readonly sourceModel: Model<SourceDocument>,
    @InjectModel(SourceRun.name) private readonly sourceRunModel: Model<SourceRunDocument>,
    @InjectModel(SourceDlq.name) private readonly sourceDlqModel: Model<SourceDlqDocument>,
  ) {}

  async ensureCatalog(): Promise<void> {
    await this.ensureActiveCollectionRunIndex();
    await Promise.all(SOURCE_CATALOG.map((entry) => {
      const { $set, $unset } = this.catalogSystemUpdate(entry);
      return this.sourceModel.updateOne(
        { _id: entry.id },
        { $set, $unset, $setOnInsert: this.catalogInsertDefaults(entry) },
        { upsert: true },
      );
    }));
  }

  async ensureActiveCollectionRunIndex(): Promise<void> {
    await this.sourceRunModel.collection.createIndex(SOURCE_RUN_ACTIVE_COLLECTION_INDEX_KEY, SOURCE_RUN_ACTIVE_COLLECTION_INDEX_OPTIONS);
  }

  async list(params: { group?: string; connectorFamily?: string; healthState?: string; query?: string; limit?: number; cursor?: string }) {
    const filter: Record<string, unknown> = {};
    if (params.group) filter.group = params.group;
    if (params.connectorFamily) filter.connectorFamily = params.connectorFamily;
    if (params.healthState) filter.healthState = params.healthState;
    if (params.query) filter.$or = [{ name: { $regex: params.query, $options: 'i' } }, { _id: { $regex: params.query, $options: 'i' } }];
    if (params.cursor) filter._id = { $gt: params.cursor };
    const limit = Math.min(params.limit ?? 100, 200);
    const items = await this.sourceModel.find(filter).sort({ _id: 1 }).limit(limit + 1).lean();
    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    return { items: pageItems, nextCursor: hasMore ? pageItems[pageItems.length - 1]?._id ?? null : null, total: await this.sourceModel.countDocuments(filter) };
  }

  async get(id: string): Promise<Source> {
    const source = await this.sourceModel.findById(id).lean();
    if (!source) throw new NotFoundException('Source not found');
    return source;
  }

  async update(id: string, input: Partial<Source>): Promise<Source> {
    const updated = await this.sourceModel.findByIdAndUpdate(id, { $set: input }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Source not found');
    return updated;
  }

  async updateHealth(id: string, input: Partial<Source>): Promise<void> {
    await this.sourceModel.updateOne({ _id: id }, this.sourcePatch(input));
  }

  async updateCheckpoint(id: string, checkpoint: Record<string, unknown>): Promise<void> {
    await this.sourceModel.updateOne({ _id: id }, { $set: { checkpoint } });
  }

  createRun(input: Partial<SourceRun>): Promise<SourceRun> {
    return this.sourceRunModel.create(input).then((doc) => doc.toObject());
  }

  async updateRun(id: string, input: Partial<SourceRun>): Promise<SourceRun> {
    const updated = await this.sourceRunModel.findByIdAndUpdate(id, { $set: input }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Source run not found');
    return updated;
  }

  async finishRunIfNotStopped(id: string, input: Partial<SourceRun>): Promise<SourceRun> {
    const updated = await this.sourceRunModel.findOneAndUpdate(
      { _id: id, status: 'Running', requestedStopAt: { $exists: false } },
      { $set: input },
      { returnDocument: 'after' },
    ).lean();
    if (updated) return updated;
    return this.getRun(id);
  }

  async startRun(id: string): Promise<SourceRun | null> {
    try {
      return await this.sourceRunModel.findOneAndUpdate(
        { _id: id, status: { $in: ['Queued', 'Failed'] }, requestedStopAt: { $exists: false } },
        { $set: { status: 'Running', startedAt: new Date() }, $unset: { error: '', finishedAt: '' } },
        { returnDocument: 'after' },
      ).lean();
    } catch (error) {
      if (isSourceActiveRunConflict(error)) return null;
      throw error;
    }
  }

  async recoverActiveRunToQueued(run: SourceRun): Promise<SourceRun | null> {
    return this.sourceRunModel.findOneAndUpdate(
      {
        _id: run._id,
        sourceId: run.sourceId,
        runType: run.runType,
        status: run.status,
        updatedAt: run.updatedAt,
        requestedStopAt: { $exists: false },
      },
      { $set: { status: 'Queued' } },
      { returnDocument: 'after' },
    ).lean();
  }

  async findActiveRun(sourceId: string): Promise<SourceRun | null> {
    return this.sourceRunModel.findOne({ sourceId, status: { $in: ['Queued', 'Running'] }, runType: { $in: SOURCE_RUN_COLLECTION_TYPES } }).sort({ createdAt: -1, _id: -1 }).lean();
  }

  async latestCollectionRun(sourceId: string): Promise<SourceRun | null> {
    return this.sourceRunModel.findOne({ sourceId, runType: { $in: SOURCE_RUN_COLLECTION_TYPES } }).sort({ createdAt: -1, _id: -1 }).lean();
  }

  async getRun(id: string): Promise<SourceRun> {
    const run = await this.sourceRunModel.findById(id).lean();
    if (!run) throw new NotFoundException('Source run not found');
    return run;
  }

  async listRuns(params: { sourceId?: string; status?: string; limit?: number; cursor?: string }) {
    const baseFilter = this.sourceRunListBaseFilter(params);
    const cursor = params.cursor ? await this.resolveSourceRunCursor(params.cursor, params, baseFilter) : null;
    const filter: Record<string, unknown> = { ...baseFilter };
    if (cursor) {
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
      ];
    }
    const limit = Math.min(params.limit ?? 50, 200);
    const items = await this.sourceRunModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    const latestCollectionRun = params.sourceId ? await this.latestCollectionRun(params.sourceId) : null;
    return { items: pageItems, nextCursor: hasMore ? this.encodeSourceRunCursor(params, pageItems[pageItems.length - 1]) : null, latestCollectionRun };
  }

  async requestStop(runId: string): Promise<SourceRun> {
    return this.updateRun(runId, { requestedStopAt: new Date(), status: 'Cancelled' });
  }

  async createDlq(input: Partial<SourceDlq>): Promise<SourceDlq> {
    return this.sourceDlqModel.create(input).then((doc) => doc.toObject());
  }

  async recoverRunDlq(runId: string): Promise<number> {
    const run = await this.getRun(runId);
    if (run.status !== 'Succeeded' || run.requestedStopAt || run.requestMetadata?.pendingIngest || run.requestMetadata?.pendingRefreshIngest || run.checkpointAfter?.hasMore === true || run.checkpointAfter?.incomplete === true) return 0;
    const result = await this.sourceDlqModel.updateMany(
      { runId, sourceId: run.sourceId, status: 'Open' },
      { $set: { status: 'Recovered', recoveredAt: new Date() } },
    );
    return result.modifiedCount;
  }

  private catalogSystemUpdate(entry: SourceCatalogEntry): { $set: Partial<Source>; $unset: Record<string, ''> } {
    const $set: Partial<Source> = {
      name: entry.name,
      group: entry.group,
      category: entry.category,
      opportunityTypes: entry.opportunityTypes,
      connectorFamily: entry.connectorFamily,
      endpoint: entry.endpoint,
      parserVersion: entry.parserVersion,
      normalizationProfile: entry.normalizationProfile,
      refreshPolicy: entry.refreshPolicy,
      checkpointStrategy: entry.checkpointStrategy,
      dedupPriority: entry.dedupPriority,
      policy: entry.policy,
    };
    const $unset: Record<string, ''> = {};
    this.setOptionalCatalogField($set, $unset, 'authCredentialRef', entry.authCredentialRef);
    this.setOptionalCatalogField($set, $unset, 'sourceRole', entry.sourceRole);
    this.setOptionalCatalogField($set, $unset, 'unavailableReason', entry.unavailableReason);
    return { $set, $unset };
  }

  private catalogInsertDefaults(entry: SourceCatalogEntry): Partial<Source> {
    return {
      _id: entry.id,
      runtimeState: entry.defaultState === 'Enabled' ? 'Enabled' : entry.defaultState,
      enabled: entry.defaultEnabled,
      intervalSeconds: entry.defaultIntervalSeconds,
      timeoutMs: entry.defaultTimeoutMs,
      config: {},
      limits: { perPage: 50 },
      proxyPoolEnabled: entry.proxyPoolEnabled,
      checkpoint: {},
      healthState: entry.defaultEnabled ? 'Unknown' : 'Disabled',
    };
  }

  private setOptionalCatalogField<K extends keyof Pick<Source, 'authCredentialRef' | 'sourceRole' | 'unavailableReason'>>(
    $set: Partial<Source>,
    $unset: Record<string, ''>,
    key: K,
    value: Source[K] | undefined,
  ): void {
    if (value === undefined) {
      $unset[key] = '';
      return;
    }
    $set[key] = value;
  }

  private sourceRunListBaseFilter(params: { sourceId?: string; status?: string }): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (params.sourceId) filter.sourceId = params.sourceId;
    if (params.status) filter.status = params.status as SourceRunStatus;
    return filter;
  }

  private sourcePatch(input: Partial<Source>): { $set?: Partial<Source>; $unset?: Record<string, ''> } {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) {
        $unset[key] = '';
      } else {
        $set[key] = value;
      }
    }
    return this.omitEmptyUpdate({ $set: $set as Partial<Source>, $unset });
  }

  private omitEmptyUpdate(update: { $set: Partial<Source>; $unset: Record<string, ''> }): { $set?: Partial<Source>; $unset?: Record<string, ''> } {
    const result: { $set?: Partial<Source>; $unset?: Record<string, ''> } = {};
    if (Object.keys(update.$set).length > 0) result.$set = update.$set;
    if (Object.keys(update.$unset).length > 0) result.$unset = update.$unset;
    return result;
  }

  private async resolveSourceRunCursor(value: string, params: { sourceId?: string; status?: string }, baseFilter: Record<string, unknown>): Promise<{ id: string; createdAt: Date }> {
    const decoded = this.decodeSourceRunCursor(value, params);
    const anchor = await this.sourceRunModel.findOne({ ...baseFilter, _id: decoded.id }).lean();
    if (!anchor?.createdAt || !Number.isFinite(+new Date(anchor.createdAt))) throw new BadRequestException('Source run cursor is invalid');
    if (decoded.createdAt && new Date(decoded.createdAt).toISOString() !== new Date(anchor.createdAt).toISOString()) throw new BadRequestException('Source run cursor is invalid');
    return { id: String(anchor._id), createdAt: new Date(anchor.createdAt) };
  }

  private encodeSourceRunCursor(params: { sourceId?: string; status?: string }, item?: SourceRun): string | null {
    if (!item?.createdAt || !item._id) return null;
    return Buffer.from(JSON.stringify({
      v: SOURCE_RUN_CURSOR_VERSION,
      id: item._id,
      createdAt: new Date(item.createdAt).toISOString(),
      sourceId: params.sourceId,
      status: params.status,
    } satisfies SourceRunsCursor), 'utf8').toString('base64url');
  }

  private decodeSourceRunCursor(value: string, params: { sourceId?: string; status?: string }): { id: string; createdAt?: string } {
    if (UUID_CURSOR_RE.test(value)) return { id: value };
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SourceRunsCursor>;
      if (
        parsed.v !== SOURCE_RUN_CURSOR_VERSION ||
        typeof parsed.id !== 'string' ||
        !parsed.id ||
        typeof parsed.createdAt !== 'string' ||
        !Number.isFinite(+new Date(parsed.createdAt)) ||
        parsed.sourceId !== params.sourceId ||
        parsed.status !== params.status
      ) {
        throw new Error('cursor mismatch');
      }
      return { id: parsed.id, createdAt: parsed.createdAt };
    } catch {
      throw new BadRequestException('Source run cursor is invalid');
    }
  }
}
