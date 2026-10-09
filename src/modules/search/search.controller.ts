import { Body, Controller, Delete, Get, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser, Roles } from '../../common/access';
import { AdminSearchRebuildDto, RecentSearchQueryDto, UnifiedSearchDto } from './dto/search.dto';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post()
  search(@CurrentUser() actor: Actor, @Body() dto: UnifiedSearchDto) {
    return this.searchService.search(actor, dto);
  }

  @Get('recent')
  recent(@CurrentUser() actor: Actor, @Query() query: RecentSearchQueryDto) {
    return this.searchService.recent(actor, query);
  }

  @Delete('recent')
  clearRecent(@CurrentUser() actor: Actor) {
    return this.searchService.clearRecent(actor);
  }
}

@Roles('Admin')
@Controller('admin/search')
export class AdminSearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get('indexes')
  indexes() {
    return this.searchService.adminIndexes();
  }

  @Get('maintenance')
  maintenance() {
    return this.searchService.adminMaintenance();
  }

  @Post('rebuild')
  rebuild(@CurrentUser() actor: Actor, @Body() dto: AdminSearchRebuildDto) {
    return this.searchService.adminRebuild(actor, dto);
  }
}
