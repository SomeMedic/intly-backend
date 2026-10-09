import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { OpportunitiesModule } from '../opportunities';
import { Opportunity, OpportunitySchema } from '../opportunities/schemas/opportunity.schema';
import { OpportunityUserState, OpportunityUserStateSchema } from '../opportunities/schemas/opportunity-user-state.schema';
import { Source, SourceSchema } from '../sources/schemas/source.schema';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [
    OpportunitiesModule,
    MongooseModule.forFeature([
      { name: Opportunity.name, schema: OpportunitySchema },
      { name: OpportunityUserState.name, schema: OpportunityUserStateSchema },
      { name: Source.name, schema: SourceSchema },
    ]),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
