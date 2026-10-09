import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser, Roles } from '../../common/access';
import { ListRunsDto, ListSourcesDto, RefreshSourceDto, RunSourceDto, UpdateSourceDto } from './dto/source.dto';
import { SourcesService } from './sources.service';

@Controller('admin/sources')
@Roles('Admin')
export class SourcesController {
  constructor(private readonly sourcesService: SourcesService) {}

  @Get()
  list(@Query() query: ListSourcesDto) {
    return this.sourcesService.list(query);
  }

  @Get('runs')
  listRuns(@Query() query: ListRunsDto) {
    return this.sourcesService.listRuns(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.sourcesService.get(id);
  }

  @Patch(':id')
  update(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: UpdateSourceDto) {
    return this.sourcesService.update(actor, id, dto);
  }

  @Post(':id/check')
  check(@Param('id') id: string) {
    return this.sourcesService.check(id);
  }

  @Post(':id/discover')
  discover(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.sourcesService.discover(actor, id);
  }

  @Post(':id/run')
  run(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: RunSourceDto) {
    return this.sourcesService.run(actor, id, dto);
  }

  @Post(':id/refresh')
  refresh(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: RefreshSourceDto) {
    return this.sourcesService.refresh(actor, id, dto);
  }

  @Post('runs/:runId/stop')
  stopRun(@CurrentUser() actor: Actor, @Param('runId') runId: string) {
    return this.sourcesService.stopRun(actor, runId);
  }

  @Post('runs/:runId/recover')
  recoverRun(@CurrentUser() actor: Actor, @Param('runId') runId: string) {
    return this.sourcesService.recoverRun(actor, runId);
  }
}
