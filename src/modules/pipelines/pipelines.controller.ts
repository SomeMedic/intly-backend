import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { PipelineQueryDto, UpdatePipelineDto } from './dto/pipelines.dto';
import { PipelineAttentionResponse, PipelineBoardResponse, PipelinesService, PipelineUpdateResponse } from './pipelines.service';

@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly service: PipelinesService) {}

  @Get()
  board(@CurrentUser() actor: Actor, @Query() query: PipelineQueryDto): Promise<PipelineBoardResponse> {
    return this.service.board(actor, query);
  }

  @Get('attention')
  attention(@CurrentUser() actor: Actor): Promise<PipelineAttentionResponse> {
    return this.service.attention(actor);
  }

  @Patch(':opportunityId')
  update(
    @CurrentUser() actor: Actor,
    @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
    @Body() dto: UpdatePipelineDto,
  ): Promise<PipelineUpdateResponse> {
    return this.service.update(actor, opportunityId, dto);
  }
}
