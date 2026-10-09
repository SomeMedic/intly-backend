import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../audit/audit.module';
import { JobsModule } from '../jobs/jobs.module';
import { JobsService } from '../jobs/jobs.service';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RealtimeService } from '../realtime/realtime.service';
import { AdminSourceInspectorController } from './admin-source-inspector.controller';
import { AdminSourceInspectorService } from './admin-source-inspector.service';
import { SourceInspectorToolsService } from './source-inspector-tools.service';
import { ConnectorRegistryService } from './connectors/connector-registry.service';
import { SourceDeduplicationService } from './deduplication/source-deduplication.service';
import { WebExtractionService } from './extraction/web-extraction.service';
import { OPPORTUNITIES_INGEST_SERVICE, SOURCES_JOBS_SERVICE, SOURCES_REALTIME_SERVICE } from './ingestion/source-ingestion.types';
import { OpportunitiesIngestAdapter } from './ingestion/opportunities-ingest.adapter';
import { SourceNormalizerService } from './normalization/source-normalizer.service';
import { SourceDlq, SourceDlqSchema } from './schemas/source-dlq.schema';
import { SourceRun, SourceRunSchema } from './schemas/source-run.schema';
import { Source, SourceSchema } from './schemas/source.schema';
import { SourcesController } from './sources.controller';
import { PublicSourcesController } from './public-sources.controller';
import { SourcesImportService } from './sources-import.service';
import { SourcesRepository } from './sources.repository';
import { SourcesService } from './sources.service';

@Module({
  imports: [
    JobsModule,
    RealtimeModule,
    OpportunitiesModule,
    AuditModule,
    MongooseModule.forFeature([
      { name: Source.name, schema: SourceSchema },
      { name: SourceRun.name, schema: SourceRunSchema },
      { name: SourceDlq.name, schema: SourceDlqSchema },
    ]),
  ],
  controllers: [SourcesController, PublicSourcesController, AdminSourceInspectorController],
  providers: [
    WebExtractionService,
    ConnectorRegistryService,
    SourceNormalizerService,
    SourceDeduplicationService,
    SourcesRepository,
    AdminSourceInspectorService,
    SourceInspectorToolsService,
    OpportunitiesIngestAdapter,
    { provide: SOURCES_JOBS_SERVICE, useExisting: JobsService },
    { provide: SOURCES_REALTIME_SERVICE, useExisting: RealtimeService },
    { provide: OPPORTUNITIES_INGEST_SERVICE, useExisting: OpportunitiesIngestAdapter },
    SourcesService,
    SourcesImportService,
  ],
  exports: [ConnectorRegistryService, SourcesRepository, SourcesService, SourcesImportService],
})
export class SourcesModule {}
