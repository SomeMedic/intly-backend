import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { FilesModule } from '../files';
import { MatchingModule } from '../matching';
import { NotificationsModule } from '../notifications';
import { SavedViewsModule } from '../saved-views';
import { ProfilesModule } from '../profiles';
import { UsersModule } from '../users';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { IssueReport, IssueReportSchema } from './schemas/issue-report.schema';
import { OpportunityComment, OpportunityCommentSchema } from './schemas/opportunity-comment.schema';
import { OpportunityExport, OpportunityExportSchema } from './schemas/opportunity-export.schema';
import { Opportunity, OpportunitySchema } from './schemas/opportunity.schema';
import { OpportunityUserState, OpportunityUserStateSchema } from './schemas/opportunity-user-state.schema';
import { IssueReportsRepository } from './issue-reports.repository';
import { OpportunityCommentsRepository } from './comments.repository';
import { OpportunityExportsRepository } from './opportunity-exports.repository';
import { OpportunityMergesRepository } from './opportunity-merges.repository';
import { OpportunityDeduplicationService } from './opportunity-deduplication.service';
import { OpportunitiesController, AdminOpportunitiesController, AdminReportsController } from './opportunities.controller';
import { OpportunityDedupReviewsController } from './opportunity-dedup-reviews.controller';
import { OpportunityDedupReviewsService } from './opportunity-dedup-reviews.service';
import { OpportunitiesRepository } from './opportunities.repository';
import { OpportunitiesService } from './opportunities.service';
import { OpportunityUserStatesRepository } from './opportunity-user-states.repository';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Opportunity.name, schema: OpportunitySchema },
      { name: OpportunityUserState.name, schema: OpportunityUserStateSchema },
      { name: IssueReport.name, schema: IssueReportSchema },
      { name: OpportunityComment.name, schema: OpportunityCommentSchema },
      { name: OpportunityExport.name, schema: OpportunityExportSchema },
    ]),
    ProfilesModule,
    MatchingModule,
    FilesModule,
    NotificationsModule,
    SavedViewsModule,
    UsersModule,
    KnowledgeModule,
  ],
  controllers: [OpportunitiesController, AdminOpportunitiesController, AdminReportsController, OpportunityDedupReviewsController],
  providers: [
    OpportunitiesRepository,
    OpportunityUserStatesRepository,
    IssueReportsRepository,
    OpportunityCommentsRepository,
    OpportunityExportsRepository,
    OpportunityMergesRepository,
    OpportunityDeduplicationService,
    OpportunityDedupReviewsService,
    OpportunitiesService,
  ],
  exports: [OpportunitiesRepository, OpportunityUserStatesRepository, OpportunitiesService, OpportunityDeduplicationService],
})
export class OpportunitiesModule {}
