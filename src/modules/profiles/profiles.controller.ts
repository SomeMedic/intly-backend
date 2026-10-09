import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { ProfileListQueryDto, UpdateProfileDto, UpsertProfileDto } from './dto/profile.dto';
import { ProfilesService } from './profiles.service';

@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: ProfileListQueryDto) {
    return this.profilesService.list(actor, query);
  }

  @Post()
  create(@CurrentUser() actor: Actor, @Body() dto: UpsertProfileDto) {
    return this.profilesService.create(actor, dto);
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.profilesService.get(actor, id);
  }

  @Patch(':id')
  update(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProfileDto) {
    return this.profilesService.update(actor, id, dto);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.profilesService.duplicate(actor, id);
  }

  @Delete(':id')
  delete(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.profilesService.delete(actor, id);
  }

  @Post(':id/set-active')
  setActive(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.profilesService.setActive(actor, id);
  }

  @Post(':id/recalculate-match')
  recalculateMatch(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.profilesService.recalculateMatch(actor, id);
  }
}
