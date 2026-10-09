import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProfilesModule } from '../profiles/profiles.module';
import { UsersModule } from '../users/users.module';
import { MatchingModule } from '../matching';
import { CalendarModule } from '../calendar';
import { TasksModule } from '../tasks';
import { Opportunity, OpportunitySchema } from '../opportunities/schemas/opportunity.schema';
import { OpportunityUserState, OpportunityUserStateSchema } from '../opportunities/schemas/opportunity-user-state.schema';
import { Source, SourceSchema } from '../sources/schemas/source.schema';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [ProfilesModule, UsersModule, MatchingModule, CalendarModule, TasksModule, MongooseModule.forFeature([
    { name: Opportunity.name, schema: OpportunitySchema },
    { name: OpportunityUserState.name, schema: OpportunityUserStateSchema },
    { name: Source.name, schema: SourceSchema },
  ])],
  controllers: [DashboardController], providers: [DashboardService],
})
export class DashboardModule {}
