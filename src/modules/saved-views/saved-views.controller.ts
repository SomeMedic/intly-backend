import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { UpdateSavedViewDto, UpsertSavedViewDto } from './dto/saved-view.dto';
import { SavedViewsService } from './saved-views.service';

@Controller('saved-views')
export class SavedViewsController {
  constructor(private readonly service: SavedViewsService) {}

  @Get()
  list(@CurrentUser() actor: Actor) {
    return this.service.list(actor);
  }

  @Post()
  create(@CurrentUser() actor: Actor, @Body() dto: UpsertSavedViewDto) {
    return this.service.create(actor, dto);
  }

  @Patch(':id')
  update(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSavedViewDto) {
    return this.service.update(actor, id, dto);
  }

  @Post(':id/duplicate')
  duplicate(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.duplicate(actor, id);
  }

  @Post(':id/set-default')
  setDefault(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.setDefault(actor, id);
  }

  @Post(':id/pin')
  pin(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.pin(actor, id);
  }

  @Delete(':id')
  delete(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.delete(actor, id);
  }
}
