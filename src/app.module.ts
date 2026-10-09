import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { DataModule } from './infrastructure/data.module';
import { CryptoModule } from './infrastructure/crypto.module';
import { validateEnvironment } from './infrastructure/config';
import { JobsModule } from './modules/jobs/jobs.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProfilesModule } from './modules/profiles/profiles.module';
import { OpportunitiesModule } from './modules/opportunities/opportunities.module';
import { SourcesModule } from './modules/sources/sources.module';
import { AuditModule } from './modules/audit/audit.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { AiModule } from './modules/ai/ai.module';
import { ResponsesModule } from './modules/responses/responses.module';
import { WatchlistsModule } from './modules/watchlists/watchlists.module';
import { SavedViewsModule } from './modules/saved-views/saved-views.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { PipelinesModule } from './modules/pipelines/pipelines.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { FilesModule } from './modules/files/files.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { SearchModule } from './modules/search/search.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ResumesModule } from './modules/resumes/resumes.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ApiTokensModule } from './modules/api-tokens/api-tokens.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { TenderDocumentsModule } from './modules/tender-documents/tender-documents.module';
import { createPinoHttpConfig } from './common/operational-logs';

@Module({ imports: [
  ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
  LoggerModule.forRoot({ pinoHttp: createPinoHttpConfig() }),
  DataModule, CryptoModule, AuditModule, JobsModule, RealtimeModule, HealthModule, AuthModule, ProfilesModule, OpportunitiesModule, SourcesModule, DashboardModule,
  AiModule, ResponsesModule, WatchlistsModule, SavedViewsModule, TasksModule, CalendarModule, PipelinesModule, AnalyticsModule,
  FilesModule, KnowledgeModule, SearchModule, DocumentsModule, ResumesModule, NotificationsModule, ApiTokensModule, WebhooksModule, TenderDocumentsModule,
] })
export class AppModule {}
