import { createHash } from 'node:crypto';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

export type EmbeddingInputKind = 'query' | 'passage';

export type EmbeddingResult = {
  vector: number[];
  metadata: { model: string; version: string; dimension: number; inputHash: string };
};
export type AttestedEmbeddingResult = EmbeddingResult & {
  metadata: EmbeddingResult['metadata'] & {
    inputKind: 'passage'; inputTokenCount: number; maxInputTokens: number;
    consumedInputUtf8Bytes: number; truncated: false; tokenizer: string; tokenizerVersion: string;
  };
};

@Injectable()
export class EmbeddingsService {
  private extractor?: Promise<FeatureExtractionPipeline>;
  private attestedCache = new Map<string, Promise<AttestedEmbeddingResult>>();

  constructor(private readonly config: ConfigService) {}

  embed(text: string): Promise<EmbeddingResult> {
    return this.embedPassage(text);
  }

  embedQuery(text: string): Promise<EmbeddingResult> {
    return this.embedWithKind(text, 'query');
  }

  embedPassage(text: string): Promise<EmbeddingResult> {
    return this.embedWithKind(text, 'passage');
  }

  passagePrefix(): string { return this.config.get<string>('EMBEDDING_PASSAGE_PREFIX') ?? 'passage: '; }

  /** Full segment with evidence from the exact tokenizer used by the local extractor. */
  async embedAttestedPassage(text: string): Promise<AttestedEmbeddingResult> {
    // Generic HTTP vectors do not prove that the server consumed the complete input.
    if (this.teiBaseUrl() || this.legacyVectorEndpoint()) throw new ServiceUnavailableException('Embedding endpoint does not provide input completeness evidence');
    const input = this.prefixedInput(text, 'passage');
    const inputHash = createHash('sha256').update(input).digest('hex');
    const model = this.config.get<string>('EMBEDDING_MODEL') ?? 'Xenova/multilingual-e5-small';
    const key = `${model}:${inputHash}`;
    const cached = this.attestedCache.get(key);
    if (cached) return cached;
    const pending = this.attestedLocal(input, inputHash, model);
    this.attestedCache.set(key, pending);
    // Bounded process cache: keep no opportunity bodies or private data here.
    while (this.attestedCache.size > 1000) this.attestedCache.delete(this.attestedCache.keys().next().value!);
    try { return await pending; }
    catch (error) { this.attestedCache.delete(key); throw error; }
  }

  private async attestedLocal(input: string, inputHash: string, model: string): Promise<AttestedEmbeddingResult> {
    const extractor = await this.localExtractor(model);
    const complete = await extractor.tokenizer(input, { truncation: false, padding: false, return_tensor: false });
    const consumed = await extractor.tokenizer(input, { truncation: true, padding: true, return_tensor: false });
    const completeIds = complete.input_ids as number[];
    const consumedIds = consumed.input_ids as number[];
    const maxInputTokens = Number(extractor.tokenizer.model_max_length);
    if (!Array.isArray(completeIds) || !Array.isArray(consumedIds) || !Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1 ||
        completeIds.length > maxInputTokens || completeIds.length !== consumedIds.length || completeIds.some((id, index) => id !== consumedIds[index])) {
      throw new ServiceUnavailableException('Embedding segment exceeds tokenizer context');
    }
    const output = await extractor(input, { pooling: 'mean', normalize: true });
    const vector = this.validateVector(Array.from(output.data, value => Number(Number(value).toFixed(8))));
    return { vector, metadata: {
      model, version: this.config.get<string>('EMBEDDING_MODEL_VERSION') ?? 'local-transformers', dimension: vector.length, inputHash,
      inputKind: 'passage', inputTokenCount: completeIds.length, maxInputTokens,
      consumedInputUtf8Bytes: Buffer.byteLength(input, 'utf8'), truncated: false,
      tokenizer: String(extractor.tokenizer.config.tokenizer_class ?? model),
      tokenizerVersion: createHash('sha256').update(JSON.stringify(extractor.tokenizer.config)).digest('hex'),
    } };
  }

  async warmup(): Promise<{ model: string; ready: true }> {
    const model = this.config.get<string>('EMBEDDING_MODEL') ?? 'Xenova/multilingual-e5-small';
    if (this.teiBaseUrl() || this.legacyVectorEndpoint()) return { model: this.httpModelName(), ready: true };
    await this.localExtractor(model);
    return { model, ready: true };
  }

  async available(): Promise<boolean> {
    if (this.teiBaseUrl() || this.legacyVectorEndpoint()) return true;
    try {
      await this.localExtractor(this.config.get<string>('EMBEDDING_MODEL') ?? 'Xenova/multilingual-e5-small');
      return true;
    } catch {
      return false;
    }
  }

  similarity(left: number[], right: number[]): number {
    if (left.length !== right.length || !left.every(Number.isFinite) || !right.every(Number.isFinite)) return 0;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
      dot += left[index] * right[index];
      leftNorm += left[index] ** 2;
      rightNorm += right[index] ** 2;
    }
    if (!leftNorm || !rightNorm) return 0;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  }

  private async embedWithKind(text: string, kind: EmbeddingInputKind): Promise<EmbeddingResult> {
    const input = this.prefixedInput(text, kind).slice(0, 8000);
    const inputHash = createHash('sha256').update(input).digest('hex');
    const baseUrl = this.teiBaseUrl();
    if (baseUrl) return this.embedWithTei(baseUrl, input, inputHash);
    const legacyEndpoint = this.legacyVectorEndpoint();
    if (legacyEndpoint) return this.embedWithLegacyEndpoint(legacyEndpoint, input, inputHash);
    return this.embedWithLocalModel(input, inputHash);
  }

  private async embedWithTei(baseUrl: string, input: string, inputHash: string): Promise<EmbeddingResult> {
    const response = await fetch(`${baseUrl}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: input }),
      signal: AbortSignal.timeout(this.timeoutMs()),
    });
    if (!response.ok) throw new ServiceUnavailableException('TEI embedding service is unavailable');
    const payload = await response.json() as unknown;
    const vector = this.firstVector(payload);
    return {
      vector,
      metadata: {
        model: this.httpModelName(),
        version: 'tei-/embed',
        dimension: vector.length,
        inputHash,
      },
    };
  }

  private async embedWithLegacyEndpoint(endpoint: string, input: string, inputHash: string): Promise<EmbeddingResult> {
    const response = await fetch(`${endpoint}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: input }),
      signal: AbortSignal.timeout(this.timeoutMs()),
    });
    if (!response.ok) throw new ServiceUnavailableException('Embedding service is unavailable');
    const payload = await response.json() as { vector?: unknown; model?: string; version?: string; dimension?: number };
    const vector = this.validateVector(payload.vector);
    return {
      vector,
      metadata: {
        model: payload.model ?? this.httpModelName(),
        version: payload.version ?? 'legacy-vector-endpoint',
        dimension: payload.dimension ?? vector.length,
        inputHash,
      },
    };
  }

  private async embedWithLocalModel(input: string, inputHash: string): Promise<EmbeddingResult> {
    const model = this.config.get<string>('EMBEDDING_MODEL') ?? 'Xenova/multilingual-e5-small';
    try {
      const extractor = await this.localExtractor(model);
      const output = await extractor(input, { pooling: 'mean', normalize: true });
      const vector = this.validateVector(Array.from(output.data, (value) => Number(Number(value).toFixed(8))));
      return {
        vector,
        metadata: {
          model,
          version: this.config.get<string>('EMBEDDING_MODEL_VERSION') ?? 'local-transformers',
          dimension: vector.length,
          inputHash,
        },
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      const message = error instanceof Error ? error.message : 'Local embedding model is unavailable';
      throw new ServiceUnavailableException(`Local embedding model is unavailable: ${message}`);
    }
  }

  private firstVector(payload: unknown): number[] {
    if (Array.isArray(payload) && payload.length > 0 && Array.isArray(payload[0])) return this.validateVector(payload[0]);
    if (Array.isArray(payload)) return this.validateVector(payload);
    throw new ServiceUnavailableException('Embedding service returned no vector');
  }

  private validateVector(value: unknown): number[] {
    if (!Array.isArray(value) || value.length === 0) throw new ServiceUnavailableException('Embedding service returned no vector');
    const vector = value.map((item) => Number(item));
    if (!vector.every(Number.isFinite)) throw new ServiceUnavailableException('Embedding service returned invalid vector values');
    const maxDimension = Number(this.config.get<string>('EMBEDDING_MAX_DIMENSION') ?? 8192);
    if (vector.length > maxDimension) throw new ServiceUnavailableException('Embedding service returned an unexpectedly large vector');
    return vector;
  }

  private prefixedInput(text: string, kind: EmbeddingInputKind): string {
    const trimmed = text.trim();
    const defaultPrefix = kind === 'query' ? 'query: ' : 'passage: ';
    const configured = this.config.get<string>(kind === 'query' ? 'EMBEDDING_QUERY_PREFIX' : 'EMBEDDING_PASSAGE_PREFIX');
    const prefix = configured ?? defaultPrefix;
    if (!prefix || trimmed.startsWith(prefix)) return trimmed;
    return `${prefix}${trimmed}`;
  }

  private teiBaseUrl(): string | undefined {
    return this.cleanBaseUrl(this.config.get<string>('EMBEDDING_BASE_URL'));
  }

  private legacyVectorEndpoint(): string | undefined {
    return this.cleanBaseUrl(this.config.get<string>('EMBEDDING_SERVICE_URL'));
  }

  private cleanBaseUrl(value?: string): string | undefined {
    const trimmed = value?.trim().replace(/\/$/, '');
    return trimmed || undefined;
  }

  private timeoutMs(): number {
    const parsed = Number(this.config.get<string>('EMBEDDING_TIMEOUT_MS') ?? 10_000);
    if (!Number.isFinite(parsed) || parsed <= 0) return 10_000;
    return Math.min(parsed, 60_000);
  }

  private httpModelName(): string {
    return this.config.get<string>('EMBEDDING_MODEL') ?? 'tei-http';
  }

  private async localExtractor(model: string): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      this.extractor = (async () => {
        const transformers = await import('@huggingface/transformers');
        const env = transformers.env as { allowLocalModels?: boolean; allowRemoteModels?: boolean; cacheDir?: string };
        env.allowLocalModels = true;
        env.allowRemoteModels = this.config.get<string>('EMBEDDING_ALLOW_REMOTE_DOWNLOAD') === 'true';
        const cacheDir = this.config.get<string>('TRANSFORMERS_CACHE') ?? this.config.get<string>('HF_HOME');
        if (cacheDir) env.cacheDir = cacheDir;
        return transformers.pipeline('feature-extraction', model, { dtype: 'q8' });
      })();
    }
    return this.extractor;
  }
}
