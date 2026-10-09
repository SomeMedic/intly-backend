import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { CreateResponseDraftDto, ExportResponseDto, GenerateResponseDto, SetResponseStatusDto, TransformResponseSelectionDto, UpdateResponseDraftDto } from './dto/response.dto';
import { ResponsesService } from './responses.service';

@Controller('responses')
export class ResponsesController {
  constructor(private readonly responsesService: ResponsesService) {}

  @Get()
  list(@CurrentUser() actor: Actor, @Query('opportunityId') opportunityId?: string, @Query('profileId') profileId?: string) {
    return this.responsesService.list(actor, { opportunityId, profileId });
  }

  @Post()
  create(@CurrentUser() actor: Actor, @Body() dto: CreateResponseDraftDto) {
    return this.responsesService.create(actor, dto);
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.responsesService.get(actor, id);
  }

  @Patch(':id')
  update(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: UpdateResponseDraftDto) {
    return this.responsesService.update(actor, id, dto);
  }

  @Post(':id/status')
  setStatus(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: SetResponseStatusDto) {
    return this.responsesService.setStatus(actor, id, dto);
  }

  @Post(':id/generate')
  generate(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: GenerateResponseDto) {
    return this.responsesService.generate(actor, id, dto);
  }

  @Post(':id/export')
  export(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: ExportResponseDto) {
    return this.responsesService.export(actor, id, dto);
  }

  @Post(':id/transform')
  transform(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: TransformResponseSelectionDto) {
    return this.responsesService.transformSelection(actor, id, dto);
  }


}
