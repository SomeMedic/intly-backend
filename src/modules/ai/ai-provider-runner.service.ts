import { Injectable } from '@nestjs/common';
import type * as AiSdk from 'ai' with { 'resolution-mode': 'import' };
import type * as GoogleSdk from '@ai-sdk/google' with { 'resolution-mode': 'import' };
import type * as OpenAiSdk from '@ai-sdk/openai' with { 'resolution-mode': 'import' };
import type * as DeepSeekSdk from '@ai-sdk/deepseek' with { 'resolution-mode': 'import' };
import type { ZodType } from 'zod';

import { CryptoService } from '../../infrastructure/crypto.service';
import { AiProviderConfig, AiTaskConfig } from './schemas/ai-config.schema';
import { normalizeAiCallUsage, type AiCallUsage } from './ai-cost';

export class AiProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiProviderUnavailableError';
  }
}

export class AiProviderCallError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly usage?: AiCallUsage) {
    super(message);
    this.name = 'AiProviderCallError';
  }
}

// SDK errors can contain request headers, URLs and response bodies. Persist only
// these classifications, never the original error or its cause.
export function safeProviderError(error: unknown): AiProviderCallError {
  const info = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof info.statusCode === 'number' ? info.statusCode : undefined;
  const classified = (code: string, message: string, retryable: boolean) => new AiProviderCallError(code, message, retryable, normalizeAiCallUsage(info.usage));
  if (status === 401 || status === 403) return classified('AI_AUTHENTICATION_FAILED', 'The provider rejected access. Check the saved credential and account permissions.', false);
  if (status === 404) return classified('AI_MODEL_UNAVAILABLE', 'The configured model or endpoint is unavailable.', false);
  if (status === 429) return classified('AI_RATE_LIMITED', 'The provider rate limit was reached. Try again later.', true);
  if (status !== undefined && status >= 500) return classified('AI_PROVIDER_UNAVAILABLE', 'The provider is temporarily unavailable.', true);
  if (status !== undefined && status >= 400) return classified('AI_INVALID_REQUEST', 'The provider rejected the model configuration or output schema.', false);
  if (info.name === 'AI_NoObjectGeneratedError' || info.name === 'AI_TypeValidationError' || info.name === 'ZodError') return classified('AI_OUTPUT_INVALID', 'The provider output did not match the protected schema.', false);
  if (info.name === 'TimeoutError') return classified('AI_PROVIDER_TIMEOUT', 'The provider request timed out.', true);
  return classified('AI_RUN_FAILED', 'The provider request could not be completed.', true);
}

type GenerateObjectResult = {
  object: Record<string, unknown>;
  usage?: AiCallUsage;
};

@Injectable()
export class AiProviderRunnerService {
  constructor(private readonly cryptoService: CryptoService) {}

  async generateObject(input: {
    provider: AiProviderConfig;
    route: AiTaskConfig;
    modelId: string;
    prompt: string;
    schema: ZodType<Record<string, unknown>>;
    abortSignal?: AbortSignal;
  }): Promise<GenerateObjectResult> {
    if (!input.provider.enabled || !input.provider.apiKeyEncrypted) {
      throw new AiProviderUnavailableError(`${input.provider.provider} credentials are not configured`);
    }

    const ai = await this.dynamicImport<typeof AiSdk>('ai').catch(() => null);
    if (!ai?.generateText || !ai.Output?.object) {
      throw new AiProviderUnavailableError('Vercel AI SDK package is not installed');
    }
    const timeout = AbortSignal.timeout(120_000);
    const signal = input.abortSignal ? AbortSignal.any([input.abortSignal, timeout]) : timeout;
    try {
      const model = await this.createModel(input.provider, input.modelId);
      const result = await ai.generateText({
        model,
        output: ai.Output.object({ schema: input.schema }),
        prompt: input.prompt,
        temperature: input.route.temperature,
        maxOutputTokens: input.route.maxOutputTokens,
        maxRetries: 0,
        abortSignal: signal,
      });
      return { object: result.output, usage: normalizeAiCallUsage(result.usage) };
    } catch (error) {
      if (input.abortSignal?.aborted) throw new AiProviderCallError('AI_RUN_CANCELLED', 'AI request cancelled', false, normalizeAiCallUsage(error && typeof error === 'object' && 'usage' in error ? error.usage : undefined));
      if (timeout.aborted) throw new AiProviderCallError('AI_PROVIDER_TIMEOUT', 'The provider request timed out.', true);
      if (error instanceof AiProviderUnavailableError) throw error;
      throw safeProviderError(error);
    }
  }

  private async createModel(provider: AiProviderConfig, modelId: string): Promise<AiSdk.LanguageModel> {
    const apiKey = this.cryptoService.decrypt(provider.apiKeyEncrypted!);
    if (provider.provider === 'openai') {
      const mod = await this.dynamicImport<typeof OpenAiSdk>('@ai-sdk/openai').catch(() => null);
      const factory = mod?.createOpenAI({ apiKey, baseURL: provider.baseUrl });
      if (!factory) throw new AiProviderUnavailableError('@ai-sdk/openai is not installed');
      return factory(modelId);
    }
    if (provider.provider === 'gemini') {
      const mod = await this.dynamicImport<typeof GoogleSdk>('@ai-sdk/google').catch(() => null);
      const factory = mod?.createGoogleGenerativeAI({ apiKey, baseURL: provider.baseUrl });
      if (!factory) throw new AiProviderUnavailableError('@ai-sdk/google is not installed');
      return factory(modelId);
    }
    const mod = await this.dynamicImport<typeof DeepSeekSdk>('@ai-sdk/deepseek').catch(() => null);
    const factory = mod?.createDeepSeek({ apiKey, baseURL: provider.baseUrl });
    if (!factory) throw new AiProviderUnavailableError('@ai-sdk/deepseek is not installed');
    return factory(modelId);
  }

  private dynamicImport<T>(specifier: string): Promise<T> {
    const importer = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<T>;
    return importer(specifier);
  }
}
