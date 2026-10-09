import { Controller, Get, Query } from '@nestjs/common';
import { Actor, CurrentUser } from '../../common/access';
import { DashboardQueryDto } from './dashboard.dto';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}
  @Get() summary(@CurrentUser() actor: Actor, @Query() query: DashboardQueryDto) {
    return this.dashboard.summary(actor, query);
  }
}
