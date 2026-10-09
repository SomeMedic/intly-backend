import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../audit/audit.module';
import { DocumentsModule } from '../documents/documents.module';
import { JobsModule } from '../jobs/jobs.module';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersModule } from '../users/users.module';
import { AiController, AdminAiController } from './ai.controller';
import { AiProviderRunnerService } from './ai-provider-runner.service';
import { AiRunCompletionRegistry } from './ai-run-completion.registry';
import { AiRepository } from './ai.repository';
import { AiService } from './ai.service';
import { AiConfigurationBootstrapService } from './ai-configuration-bootstrap.service';
import { AiProviderHealthService } from './ai-provider-health.service';
import { AiAnalysis, AiAnalysisSchema } from './schemas/ai-analysis.schema';
import { AiPromptTemplate, AiPromptTemplateSchema, AiProviderConfig, AiProviderConfigSchema, AiTaskConfig, AiTaskConfigSchema } from './schemas/ai-config.schema';

@Module({
  imports: [
    AuditModule,
    DocumentsModule,
    JobsModule,
    OpportunitiesModule,
    ProfilesModule,
    RealtimeModule,
    UsersModule,
    MongooseModule.forFeature([
      { name: AiAnalysis.name, schema: AiAnalysisSchema },
      { name: AiProviderConfig.name, schema: AiProviderConfigSchema },
      { name: AiTaskConfig.name, schema: AiTaskConfigSchema },
      { name: AiPromptTemplate.name, schema: AiPromptTemplateSchema },
    ]),
  ],
  controllers: [AiController, AdminAiController],
  providers: [AiRepository, AiProviderRunnerService, AiRunCompletionRegistry, AiConfigurationBootstrapService, AiProviderHealthService, AiService],
  exports: [AiService, AiRepository, AiRunCompletionRegistry],
})
export class AiModule {}
