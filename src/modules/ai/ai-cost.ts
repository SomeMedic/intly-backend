import type { AiProvider } from './schemas/ai-config.schema';

/** USD per million tokens, chosen by the administrator for this exact model. */
export type AiModelPrice = {
  modelId: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  sourceUrl?: string;
};

export type AiCallUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  estimatedCost?: number | null;
  pricing?: AiModelPrice;
  costBasis?: 'reported-cache' | 'uncached-assumed';
};

export type AiCallAttempt = {
  number: number;
  provider: AiProvider;
  modelId: string;
  fallbackUsed: boolean;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  errorCode?: string;
  pricing?: AiModelPrice;
  usage?: AiCallUsage;
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const token = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const rate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Copy only numeric SDK counters; never persist raw SDK response/error metadata. */
export function normalizeAiCallUsage(value: unknown): AiCallUsage {
  const raw = record(value);
  const inputTokens = token(raw.inputTokens);
  const outputTokens = token(raw.outputTokens);
  const cached = token(record(raw.inputTokenDetails).cacheReadTokens ?? raw.cachedInputTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(token(raw.totalTokens) !== undefined ? { totalTokens: token(raw.totalTokens) } : inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
    ...(cached !== undefined && inputTokens !== undefined && cached <= inputTokens ? { cachedInputTokens: cached } : {}),
  };
}

export function priceAiCall(value: unknown, pricing?: AiModelPrice): AiCallUsage {
  const usage = normalizeAiCallUsage(value);
  if (!pricing || !rate(pricing.inputPerMillion) || !rate(pricing.outputPerMillion)
    || (pricing.cachedInputPerMillion !== undefined && !rate(pricing.cachedInputPerMillion))) {
    return { ...usage, estimatedCost: null };
  }
  const snapshot: AiModelPrice = { ...pricing };
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return { ...usage, pricing: snapshot, estimatedCost: null };
  const cached = usage.cachedInputTokens ?? 0;
  const estimatedCost = ((usage.inputTokens - cached) * pricing.inputPerMillion
    + cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
    + usage.outputTokens * pricing.outputPerMillion) / 1_000_000;
  return {
    ...usage, pricing: snapshot, estimatedCost: Number.isFinite(estimatedCost) ? estimatedCost : null,
    costBasis: usage.cachedInputTokens !== undefined ? 'reported-cache' : 'uncached-assumed',
  };
}
