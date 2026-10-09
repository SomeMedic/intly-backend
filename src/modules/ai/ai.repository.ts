import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';

import { AiUsageFilters, buildAiUsagePipeline, emptyAiUsageSummary, emptyAiCallSummary } from './ai-usage';
import type { AiCallAttempt } from './ai-cost';
import { withCanonicalOpportunity } from '../opportunities/canonical-opportunity-transaction';

import { AiAnalysis, AiAnalysisDocument, AiRunProgressStage } from './schemas/ai-analysis.schema';
import { AiPromptTemplate, AiPromptTemplateDocument, AiProvider, AiProviderConfig, AiProviderConfigDocument, AiTaskConfig, AiTaskConfigDocument, AiTaskType } from './schemas/ai-config.schema';

@Injectable()
export class AiRepository {
  constructor(
    @InjectModel(AiAnalysis.name) private readonly analysisModel: Model<AiAnalysisDocument>,
    @InjectModel(AiProviderConfig.name) private readonly providerModel: Model<AiProviderConfigDocument>,
    @InjectModel(AiTaskConfig.name) private readonly taskConfigModel: Model<AiTaskConfigDocument>,
    @InjectModel(AiPromptTemplate.name) private readonly promptModel: Model<AiPromptTemplateDocument>,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async createRun(input: Partial<AiAnalysis>): Promise<AiAnalysis> {
    if (this.connection?.db && input.opportunityId) return withCanonicalOpportunity(this.connection, input.opportunityId, async (opportunityId, session) => this.createRunCanonical({ ...input, opportunityId }, session));
    return this.createRunCanonical(input);
  }

  async updateRun(id: string, input: Partial<AiAnalysis>): Promise<AiAnalysis> {
    if (this.connection?.db && Object.prototype.hasOwnProperty.call(input, 'opportunityId') && input.opportunityId) {
      return withCanonicalOpportunity(this.connection, input.opportunityId, async (opportunityId, session) => this.updateRunCanonical(id, { ...input, opportunityId }, session));
    }
    return this.updateRunCanonical(id, input);
  }

  async cancelRun(id: string): Promise<AiAnalysis | null> {
    return this.analysisModel.findOneAndUpdate(
      { _id: id, status: { $in: ['queued', 'running'] } },
      { $set: { status: 'cancelled', completedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
  }

  private async createRunCanonical(input: Partial<AiAnalysis>, session?: mongo.ClientSession): Promise<AiAnalysis> {
    const [created] = await this.analysisModel.create([input], { ...(session ? { session } : {}) });
    return created.toObject();
  }

  private async updateRunCanonical(id: string, input: Partial<AiAnalysis>, session?: mongo.ClientSession): Promise<AiAnalysis> {
    const updated = await this.analysisModel.findByIdAndUpdate(id, { $set: input }, { returnDocument: 'after', ...(session ? { session } : {}) }).lean();
    if (!updated) throw new NotFoundException('AI run not found');
    return updated;
  }

  async updateRunningRun(id: string, input: Partial<AiAnalysis>): Promise<AiAnalysis | null> {
    return this.analysisModel.findOneAndUpdate(
      { _id: id, status: 'running' },
      { $set: input },
      { returnDocument: 'after' },
    ).lean();
  }

  async updateRunStage(id: string, stage: AiRunProgressStage): Promise<AiAnalysis | null> {
    return this.updateRunningRun(id, { stage });
  }

  /** Cancellation can win while a provider returns billed usage. Preserve that
   * usage without reviving the run or changing its terminal output/status. */
  async recordAttempts(id: string, attempts: AiCallAttempt[]): Promise<AiAnalysis | null> {
    return this.analysisModel.findOneAndUpdate(
      { _id: id, status: { $in: ['running', 'cancelled'] } },
      { $set: { attempts } },
      { returnDocument: 'after' },
    ).lean();
  }

  async markRunning(id: string): Promise<AiAnalysis | null> {
    return this.analysisModel.findOneAndUpdate(
      { _id: id, status: 'queued' },
      { $set: { status: 'running', startedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
  }

  async updateRunTerminal(id: string, input: Partial<AiAnalysis>): Promise<AiAnalysis | null> {
    return this.analysisModel.findOneAndUpdate(
      { _id: id, status: 'running' },
      { $set: input },
      { returnDocument: 'after' },
    ).lean();
  }


  async getRun(id: string): Promise<AiAnalysis> {
    const run = await this.analysisModel.findById(id).lean();
    if (!run) throw new NotFoundException('AI run not found');
    return run;
  }

  async listRuns(filter: { userId?: string; opportunityId?: string; profileId?: string; taskType?: AiTaskType }) {
    const opportunityId = filter.opportunityId ? await this.resolveCanonicalOpportunityId(filter.opportunityId) : undefined;
    return this.analysisModel.find({ ...filter, ...(opportunityId ? { opportunityId } : {}) }).sort({ createdAt: -1 }).limit(50).lean();
  }

  getProvider(provider: AiProvider): Promise<AiProviderConfig | null> {
    return this.providerModel.findOne({ provider }).lean();
  }

  listProviders(): Promise<AiProviderConfig[]> {
    return this.providerModel.find().sort({ provider: 1 }).lean();
  }

  async initializeConfiguration(): Promise<void> {
    // Startup defaults must never enable a provider, copy environment secrets,
    // or replace an administrator's saved choices. setOnInsert is race-safe
    // when the API and worker start together.
    for (const provider of ['openai', 'gemini', 'deepseek'] as const) {
      await this.providerModel.updateOne({ provider }, { $setOnInsert: { provider, enabled: false, health: {} } }, { upsert: true });
    }
    for (const taskType of ['opportunity_analysis', 'response_generation', 'resume_adaptation', 'document_extraction', 'tender_document_analysis', 'editor_transform'] as const) {
      const documentTask = ['document_extraction', 'tender_document_analysis'].includes(taskType);
      await this.taskConfigModel.updateOne({ taskType }, { $setOnInsert: {
        taskType,
        primaryProvider: documentTask ? 'gemini' : 'openai',
        primaryModel: documentTask ? 'gemini-2.5-flash' : 'gpt-4.1-mini',
        fallbackProvider: documentTask ? 'openai' : 'gemini',
        fallbackModel: documentTask ? 'gpt-4.1-mini' : 'gemini-2.5-flash',
        retryCount: 1, temperature: 0.2, maxOutputTokens: 4096,
      } }, { upsert: true });
    }
  }

  async recordProviderHealth(config: AiProviderConfig, health: Record<string, unknown>): Promise<boolean> {
    const result = await this.providerModel.updateOne({
      provider: config.provider,
      enabled: config.enabled,
      apiKeyEncrypted: config.apiKeyEncrypted ?? { $exists: false },
      baseUrl: config.baseUrl ?? { $in: [null, ''] },
      $or: [{ 'health.checkedAt': { $exists: false } }, { 'health.checkedAt': { $lte: health.checkedAt } }],
    }, { $set: { health } });
    return result.matchedCount === 1;
  }

  upsertProvider(input: Partial<AiProviderConfig> & { provider: AiProvider }): Promise<AiProviderConfig> {
    return this.providerModel.findOneAndUpdate({ provider: input.provider }, { $set: input }, { upsert: true, returnDocument: 'after' }).lean().then((value) => value!);
  }

  getTaskConfig(taskType: AiTaskType): Promise<AiTaskConfig | null> {
    return this.taskConfigModel.findOne({ taskType }).lean();
  }

  listTaskConfigs(): Promise<AiTaskConfig[]> {
    return this.taskConfigModel.find().sort({ taskType: 1 }).lean();
  }

  upsertTaskConfig(input: Partial<AiTaskConfig> & { taskType: AiTaskType }): Promise<AiTaskConfig> {
    return this.taskConfigModel.findOneAndUpdate({ taskType: input.taskType }, { $set: input }, { upsert: true, returnDocument: 'after' }).lean().then((value) => value!);
  }

  getPrompt(taskType: AiTaskType): Promise<AiPromptTemplate | null> {
    return this.promptModel.findOne({ taskType }).lean();
  }

  listPrompts(): Promise<AiPromptTemplate[]> {
    return this.promptModel.find().sort({ taskType: 1 }).lean();
  }

  upsertPrompt(input: Partial<AiPromptTemplate> & { taskType: AiTaskType }): Promise<AiPromptTemplate> {
    return this.promptModel.findOneAndUpdate({ taskType: input.taskType }, { $set: input }, { upsert: true, returnDocument: 'after' }).lean().then((value) => value!);
  }


  private async resolveCanonicalOpportunityId(opportunityId: string): Promise<string> {
    if (!this.connection?.db) return opportunityId;
    let id = opportunityId;
    const visited = new Set<string>();
    const opportunities = this.connection.db.collection<{ _id: string; mergedIntoOpportunityId?: string }>('opportunities');
    for (let hop = 0; hop < 20; hop += 1) {
      if (visited.has(id)) throw new ConflictException('Opportunity alias cycle');
      visited.add(id);
      const record = await opportunities.findOne({ _id: id }, { projection: { _id: 1, mergedIntoOpportunityId: 1 } });
      if (!record) return opportunityId;
      if (!record.mergedIntoOpportunityId) return record._id;
      id = record.mergedIntoOpportunityId;
    }
    throw new ConflictException('Opportunity alias chain exceeds safe depth');
  }

  async usageSummary(filters: AiUsageFilters = {}) {
    const [report] = await this.analysisModel.aggregate(buildAiUsagePipeline(filters));
    return {
      items: report?.items ?? [], nextCursor: null,
      summary: report?.summary?.[0] ?? { ...emptyAiUsageSummary },
      users: report?.users ?? [], errors: report?.errors ?? [],
      callItems: report?.callItems ?? [], callSummary: report?.callSummary?.[0] ?? { ...emptyAiCallSummary },
    };
  }
}
