import { Controller, Get, Header, Query } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { AnalyticsQueryDto } from './dto/analytics.dto';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('personal')
  personal(@CurrentUser() actor: Actor, @Query() query: AnalyticsQueryDto) {
    return this.service.personal(actor, query);
  }

  @Get('personal/export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="personal-analytics.csv"')
  personalCsv(@CurrentUser() actor: Actor, @Query() query: AnalyticsQueryDto) {
    return this.service.personalCsv(actor, query);
  }

  @Get('market')
  market(@Query() query: AnalyticsQueryDto) {
    return this.service.market(query);
  }

  @Get('market/export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="market-analytics.csv"')
  marketCsv(@Query() query: AnalyticsQueryDto) {
    return this.service.marketCsv(query);
  }

  @Get('sources')
  sources(@Query() query: AnalyticsQueryDto) {
    return this.service.sources(query);
  }
}
