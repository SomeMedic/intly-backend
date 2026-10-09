import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Config, Meilisearch, Settings } from 'meilisearch' with { 'resolution-mode': 'import' };

export type MeiliResult = { id: string; score?: number; payload?: Record<string, unknown> };
export type SearchIndexSettings = {
  searchableAttributes?: readonly string[];
  filterableAttributes?: readonly string[];
  sortableAttributes?: readonly string[];
  displayedAttributes?: readonly string[];
  rankingRules?: readonly string[];
};
export type MeiliTask = { taskUid?: number; status?: string; error?: unknown };
export type SearchIndexBuildResult = { index: string; count: number; taskUids: number[] };
const CANONICAL_SEARCH_INDEXES = ['opportunities', 'knowledge_chunks', 'tasks', 'profiles', 'watchlists'] as const;

@Injectable()
export class MeiliSearchService {
  private readonly host?: string;
  private clientPromise?: Promise<MeiliClient>;

  constructor(private readonly config: ConfigService) {
    this.host = this.config.get<string>('MEILI_URL');
  }

  available(): boolean {
    return Boolean(this.host);
  }

  async search(index: string, query: string, options: Record<string, unknown> = {}): Promise<MeiliResult[]> {
    const client = await this.client();
    const payload = await client.index(index).search(query, { limit: 20, showRankingScore: true, ...options });
    return (payload.hits as Array<Record<string, unknown>>).map((hit) => ({
      id: String(hit.id ?? hit._id),
      score: typeof hit._rankingScore === 'number' ? hit._rankingScore : undefined,
      payload: hit,
    }));
  }

  async upsert(index: string, documents: Array<Record<string, unknown>>): Promise<void> {
    const client = await this.client();
    if (!documents.length) return;
    await client.index(index).addDocuments(documents, { primaryKey: 'id' });
  }

  async delete(index: string, id: string): Promise<void> {
    const client = await this.client();
    const task = await client.index(index).deleteDocument(id);
    await this.waitForTask(task, `delete document ${index}/${id}`);
  }

  async indexStats(): Promise<Array<{ name: string; available: boolean; raw?: unknown }>> {
    if (!this.host) return CANONICAL_SEARCH_INDEXES.map((name) => ({ name, available: false }));
    const raw = await (await this.client()).getStats();
    return CANONICAL_SEARCH_INDEXES.map((name) => {
      const stats = raw.indexes?.[name];
      return stats ? { name, available: true, raw: stats } : { name, available: false };
    });
  }

  async ensureIndex(index: string, settings: SearchIndexSettings): Promise<void> {
    const client = await this.client();
    try {
      await client.getIndex(index);
    } catch (error) {
      if (!this.isIndexNotFound(error)) throw error;
      await client.createIndex(index, { primaryKey: 'id' });
    }
    await client.index(index).updateSettings(this.sdkSettings(settings));
  }

  async replaceAll(index: string, documents: Array<Record<string, unknown>>, settings: SearchIndexSettings): Promise<{ index: string; count: number }> {
    await this.ensureIndex(index, settings);
    const client = await this.client();
    await client.index(index).deleteAllDocuments();
    if (documents.length) await client.index(index).addDocuments(documents, { primaryKey: 'id' });
    return { index, count: documents.length };
  }

  async prepareEmptyIndex(index: string, settings: SearchIndexSettings): Promise<number[]> {
    const client = await this.client();
    const taskUids: number[] = [];
    try {
      const deleteTask = await client.deleteIndex(index);
      taskUids.push(this.taskUid(deleteTask));
      await this.waitForTask(deleteTask, `delete ${index}`, { tolerateIndexNotFound: true });
    } catch (error) {
      if (!this.isIndexNotFound(error)) throw error;
    }
    const createTask = await client.createIndex(index, { primaryKey: 'id' });
    taskUids.push(this.taskUid(createTask));
    await this.waitForTask(createTask, `create ${index}`);
    const settingsTask = await client.index(index).updateSettings(this.sdkSettings(settings));
    taskUids.push(this.taskUid(settingsTask));
    await this.waitForTask(settingsTask, `settings ${index}`);
    return taskUids;
  }

  async ensureIndexReady(index: string, settings: SearchIndexSettings): Promise<number[]> {
    const client = await this.client();
    const taskUids: number[] = [];
    try {
      await client.getIndex(index);
    } catch (error) {
      if (!this.isIndexNotFound(error)) throw error;
      const createTask = await client.createIndex(index, { primaryKey: 'id' });
      taskUids.push(this.taskUid(createTask));
      await this.waitForTask(createTask, `create ${index}`);
    }
    const settingsTask = await client.index(index).updateSettings(this.sdkSettings(settings));
    taskUids.push(this.taskUid(settingsTask));
    await this.waitForTask(settingsTask, `settings ${index}`);
    return taskUids;
  }

  async addDocumentsAwaited(index: string, documents: Array<Record<string, unknown>>): Promise<number | undefined> {
    const client = await this.client();
    if (!documents.length) return undefined;
    const task = await client.index(index).addDocuments(documents, { primaryKey: 'id' });
    await this.waitForTask(task, `add documents ${index}`);
    return this.taskUid(task);
  }

  async submitSwapIndexes(swaps: Array<{ indexes: [string, string] }>): Promise<number> {
    const client = await this.client();
    const task = await client.swapIndexes(swaps.map(swap => ({ ...swap, rename: false })));
    return this.taskUid(task);
  }

  async waitForTaskUid(taskUid: number, label: string): Promise<void> {
    await this.waitForTask({ taskUid }, label);
  }

  async swapIndexes(swaps: Array<{ indexes: [string, string] }>): Promise<number> {
    const taskUid = await this.submitSwapIndexes(swaps);
    await this.waitForTaskUid(taskUid, 'swap search indexes');
    return taskUid;
  }

  async deleteIndexIfExists(index: string): Promise<number | undefined> {
    const client = await this.client();
    try {
      const task = await client.deleteIndex(index);
      await this.waitForTask(task, `delete ${index}`, { tolerateIndexNotFound: true });
      return this.taskUid(task);
    } catch (error) {
      if (!this.isIndexNotFound(error)) throw error;
      return undefined;
    }
  }

  private async waitForTask(task: unknown, label: string, options: { tolerateIndexNotFound?: boolean } = {}): Promise<void> {
    const client = await this.client();
    const taskUid = this.taskUid(task);
    const resolved = await client.tasks.waitForTask(taskUid, { timeout: SEARCH_MEILI_TASK_TIMEOUT_MS, interval: SEARCH_MEILI_TASK_INTERVAL_MS });
    if (resolved.status === 'succeeded') return;
    if (options.tolerateIndexNotFound && this.isIndexNotFound(resolved.error ?? resolved)) return;
    throw new Error(`Meili task failed during ${label}: ${JSON.stringify(resolved.error ?? resolved)}`);
  }

  private taskUid(task: unknown): number {
    const value = (task ?? {}) as { taskUid?: unknown };
    if (typeof value.taskUid !== 'number') throw new Error(`Meili task did not include taskUid: ${JSON.stringify(task)}`);
    return value.taskUid;
  }

  private sdkSettings(settings: SearchIndexSettings): Settings {
    return Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, value ? [...value] : value])) as Settings;
  }

  private isIndexNotFound(error: unknown): boolean {
    const cause = (error as { cause?: { code?: unknown }; code?: unknown })?.cause;
    return cause?.code === 'index_not_found' || (error as { code?: unknown })?.code === 'index_not_found';
  }

  private async client(): Promise<MeiliClient> {
    if (!this.host) throw new ServiceUnavailableException('Search index is unavailable');
    const host = this.host;
    if (!this.clientPromise) {
      const packageName = 'meilisearch';
      this.clientPromise = import(packageName).then((module) => {
        const Client = (module as { Meilisearch?: new (config: Config) => MeiliClient }).Meilisearch;
        if (!Client) throw new ServiceUnavailableException('Search client is unavailable');
        return new Client({
          host,
          apiKey: this.config.get<string>('MEILI_MASTER_KEY') ?? this.config.get<string>('MEILI_API_KEY'),
        });
      });
    }
    return this.clientPromise;
  }
}

type MeiliClient = Meilisearch;

const SEARCH_MEILI_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const SEARCH_MEILI_TASK_INTERVAL_MS = 250;
