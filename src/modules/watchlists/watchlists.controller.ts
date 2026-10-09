import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { UpdateWatchlistDto, UpsertWatchlistDto, WatchlistHitsQueryDto } from './dto/watchlist.dto';
import { WatchlistsService } from './watchlists.service';

@Controller('watchlists')
export class WatchlistsController {
  constructor(private readonly service: WatchlistsService) {}

  @Get()
  list(@CurrentUser() actor: Actor) {
    return this.service.list(actor);
  }

  @Post()
  create(@CurrentUser() actor: Actor, @Body() dto: UpsertWatchlistDto) {
    return this.service.create(actor, dto);
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(actor, id);
  }

  @Patch(':id')
  update(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWatchlistDto) {
    return this.service.update(actor, id, dto);
  }

  @Post(':id/pause')
  pause(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.pause(actor, id);
  }

  @Post(':id/resume')
  resume(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.resume(actor, id);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.duplicate(actor, id);
  }

  @Delete(':id')
  delete(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.delete(actor, id);
  }

  @Get(':id/hits')
  hits(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Query() query: WatchlistHitsQueryDto) {
    return this.service.hits(actor, id, query.limit);
  }
}
