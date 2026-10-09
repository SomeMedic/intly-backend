import { Body, Controller, Get, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { ImportUrlDto } from '../opportunities/dto/opportunity.dto';
import { SourcesImportService } from './sources-import.service';
import { SourcesService } from './sources.service';

@Controller('sources')
export class PublicSourcesController {
  constructor(
    private readonly sourcesService: SourcesService,
    private readonly sourcesImportService: SourcesImportService,
  ) {}

  @Get()
  async list(@Query('group') group?: string) {
    return this.sourcesService.publicRegistry(group);
  }

  @Post('import-url')
  importUrl(@CurrentUser() actor: Actor, @Body() dto: ImportUrlDto) {
    return this.sourcesImportService.importUrl(actor, dto);
  }
}
