import { Injectable, OnModuleInit } from '@nestjs/common';
import { AiRepository } from './ai.repository';

@Injectable()
export class AiConfigurationBootstrapService implements OnModuleInit {
  constructor(private readonly repository: AiRepository) {}

  async onModuleInit(): Promise<void> {
    await this.repository.initializeConfiguration();
  }
}
