import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { JobsModule } from '../jobs/jobs.module';
import { KnowledgeChunk, KnowledgeChunkSchema, KnowledgeDocument, KnowledgeDocumentSchema, KnowledgeModule } from '../knowledge';
import { OpportunitiesModule } from '../opportunities';
import { Opportunity, OpportunitySchema } from '../opportunities/schemas/opportunity.schema';
import { ProfilesModule } from '../profiles';
import { Profile, ProfileSchema } from '../profiles/schemas/profile.schema';
import { Task, TaskSchema } from '../tasks/schemas/task.schema';
import { TasksModule } from '../tasks/tasks.module';
import { Watchlist, WatchlistSchema } from '../watchlists/schemas/watchlist.schema';
import { WatchlistsModule } from '../watchlists/watchlists.module';
import { MeiliSearchService } from './meili-search.service';
import { AdminSearchController, SearchController } from './search.controller';
import { SearchRepository } from './search.repository';
import { SearchService } from './search.service';
import { SearchRecent, SearchRecentSchema } from './schemas/search-recent.schema';
import { SearchRebuild, SearchRebuildLock, SearchRebuildLockSchema, SearchRebuildMutation, SearchRebuildMutationSchema, SearchRebuildSchema, SearchRebuildWriter, SearchRebuildWriterSchema } from './schemas/search-rebuild.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SearchRecent.name, schema: SearchRecentSchema },
      { name: Opportunity.name, schema: OpportunitySchema },
      { name: Task.name, schema: TaskSchema },
      { name: Profile.name, schema: ProfileSchema },
      { name: Watchlist.name, schema: WatchlistSchema },
      { name: KnowledgeDocument.name, schema: KnowledgeDocumentSchema },
      { name: KnowledgeChunk.name, schema: KnowledgeChunkSchema },
      { name: SearchRebuild.name, schema: SearchRebuildSchema },
      { name: SearchRebuildLock.name, schema: SearchRebuildLockSchema },
      { name: SearchRebuildMutation.name, schema: SearchRebuildMutationSchema },
      { name: SearchRebuildWriter.name, schema: SearchRebuildWriterSchema },
    ]),
    JobsModule,
    OpportunitiesModule,
    TasksModule,
    ProfilesModule,
    WatchlistsModule,
    KnowledgeModule,
  ],
  controllers: [SearchController, AdminSearchController],
  providers: [SearchRepository, MeiliSearchService, SearchService],
  exports: [SearchRepository, MeiliSearchService, SearchService],
})
export class SearchModule {}
