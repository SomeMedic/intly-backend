import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { ApiTokensService } from './api-tokens.service';
import { CreateApiTokenDto } from './dto/api-token.dto';

@Controller('api-tokens')
export class ApiTokensController {
  constructor(private readonly apiTokensService: ApiTokensService) {}

  @Get()
  list(@CurrentUser() actor: Actor) {
    return this.apiTokensService.list(actor);
  }

  @Post()
  create(@CurrentUser() actor: Actor, @Body() dto: CreateApiTokenDto) {
    return this.apiTokensService.create(actor, dto);
  }

  @Delete(':id')
  revoke(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.apiTokensService.revoke(actor, id);
  }
}
