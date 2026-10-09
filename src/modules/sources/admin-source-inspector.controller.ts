import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Actor, CurrentUser, Roles } from '../../common/access';
import { AdminSourceInspectorService } from './admin-source-inspector.service';
import { ListSourceLogsDto, ListSourceSamplesDto, ReindexSourceSampleDto, SourceToolOpportunityDto } from './dto/admin-source-inspector.dto';

@ApiTags('admin-source-inspector')
@Roles('Admin')
@Controller('admin/sources/:id')
export class AdminSourceInspectorController {
  constructor(private readonly inspector: AdminSourceInspectorService) {}

  @Get('logs')
  logs(@Param('id') id: string, @Query() query: ListSourceLogsDto) {
    return this.inspector.logs(id, query);
  }

  @Get('samples')
  samples(@CurrentUser() actor: Actor, @Param('id') id: string, @Query() query: ListSourceSamplesDto) {
    return this.inspector.samples(actor, id, query);
  }

  @Get('tools/capabilities')
  capabilities(@Param('id') id: string, @Query('opportunityId') opportunityId?: string) {
    return this.inspector.capabilities(id, opportunityId);
  }

  @Post('tools/reindex')
  reindex(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: ReindexSourceSampleDto) {
    return this.inspector.reindex(actor, id, dto);
  }

  @Post('tools/reprocess')
  reprocess(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: SourceToolOpportunityDto) {
    return this.inspector.reprocess(actor, id, dto);
  }

  @Post('tools/normalize')
  normalize(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: SourceToolOpportunityDto) {
    return this.inspector.normalize(actor, id, dto);
  }

  @Post('tools/deduplicate')
  deduplicate(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: SourceToolOpportunityDto) {
    return this.inspector.deduplicate(actor, id, dto);
  }
}
