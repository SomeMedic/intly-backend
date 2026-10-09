import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Actor } from '../../common/access';
import { AuditService } from '../audit/audit.service';
import { AiRepository } from './ai.repository';
import { AiProviderCallError, AiProviderRunnerService, AiProviderUnavailableError, safeProviderError } from './ai-provider-runner.service';
import { AI_PROVIDERS, AiProvider, AiTaskConfig } from './schemas/ai-config.schema';

@Injectable()
export class AiProviderHealthService {
  constructor(private readonly repository: AiRepository, private readonly runner: AiProviderRunnerService, private readonly audit: AuditService) {}

  async test(actor: Actor, providerName: string, modelId: string) {
    if (!AI_PROVIDERS.includes(providerName as AiProvider)) throw new BadRequestException('Unsupported AI provider');
    const provider = providerName as AiProvider;
    const model = modelId.trim();
    if (!model) throw new BadRequestException('A model ID is required');
    const config = await this.repository.getProvider(provider);
    const checkedAt = new Date().toISOString();
    const started = performance.now();
    const health: { provider: AiProvider; modelId: string; status: 'healthy' | 'failed'; checkedAt: string; latencyMs: number; errorCode?: string; message?: string } = {
      provider, modelId: model, status: 'failed', checkedAt, latencyMs: 0,
    };
    await this.audit.record(actor, 'ai.provider.test', 'AiProviderConfig', provider, ['modelId']);
    try {
      if (!config?.enabled || !config.apiKeyEncrypted) throw new AiProviderUnavailableError('Provider is disabled or has no saved credential.');
      const schema = z.object({ ok: z.literal(true) });
      const output = await this.runner.generateObject({
        provider: config,
        modelId: model,
        route: { taskType: 'document_extraction', primaryProvider: provider, primaryModel: model, retryCount: 0, temperature: 0, maxOutputTokens: 128 } as AiTaskConfig,
        schema,
        prompt: 'This is a synthetic INTLY connectivity check. Return only {"ok":true}. No user data is included.',
        abortSignal: AbortSignal.timeout(20_000),
      });
      schema.parse(output.object);
      health.status = 'healthy';
      health.message = 'Synthetic structured-output request succeeded.';
    } catch (error) {
      const safe = error instanceof AiProviderUnavailableError
        ? { code: 'AI_PROVIDER_UNAVAILABLE', message: 'Provider is disabled or has no saved credential.' }
        : error instanceof AiProviderCallError ? error
          : error instanceof Error && error.name === 'AbortError'
            ? { code: 'AI_PROVIDER_TIMEOUT', message: 'The provider check timed out.' }
            : safeProviderError(error);
      health.errorCode = safe.code;
      health.message = safe.message;
    }
    health.latencyMs = Math.round(performance.now() - started);
    const persisted = config ? await this.repository.recordProviderHealth(config, health) : false;
    return { ...health, persisted };
  }
}
