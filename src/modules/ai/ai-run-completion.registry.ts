import { Injectable, Logger } from '@nestjs/common';

import { AiAnalysis } from './schemas/ai-analysis.schema';

export type AiRunTerminalHandler = (run: AiAnalysis) => Promise<void> | void;

@Injectable()
export class AiRunCompletionRegistry {
  private readonly logger = new Logger(AiRunCompletionRegistry.name);
  private readonly handlers = new Map<string, AiRunTerminalHandler>();

  register(name: string, handler: AiRunTerminalHandler): void {
    if (this.handlers.has(name)) {
      throw new Error(`Duplicate AI run terminal handler: ${name}`);
    }
    this.handlers.set(name, handler);
  }

  async notify(run: AiAnalysis): Promise<void> {
    for (const [name, handler] of this.handlers) {
      try {
        await handler(run);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        this.logger.error(`AI terminal handler ${name} failed for run ${run._id}: ${message}`);
      }
    }
  }
}
