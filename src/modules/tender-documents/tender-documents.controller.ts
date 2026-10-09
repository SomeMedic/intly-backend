import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { Actor, CurrentUser } from '../../common/access';
import { ImportSourceTenderDocumentDto, TenderDocumentAnalysisDto, TenderDocumentQueryDto, UploadTenderDocumentDto } from './dto/tender-document.dto';
import { TenderDocumentsService } from './tender-documents.service';

@Controller('opportunities/:opportunityId/tender-documents')
export class TenderDocumentsController {
  constructor(private readonly service: TenderDocumentsService) {}

  @Get()
  list(@CurrentUser() actor: Actor, @Param('opportunityId', ParseUUIDPipe) opportunityId: string, @Query() query: TenderDocumentQueryDto) {
    return this.service.list(actor, opportunityId, query);
  }

  @Post('multipart')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
  upload(
    @CurrentUser() actor: Actor,
    @Param('opportunityId', ParseUUIDPipe) opportunityId: string,
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    @Body() dto: UploadTenderDocumentDto,
  ) {
    return this.service.upload(actor, opportunityId, file, dto);
  }

  @Post('import-source')
  importSource(@CurrentUser() actor: Actor, @Param('opportunityId', ParseUUIDPipe) opportunityId: string, @Body() dto: ImportSourceTenderDocumentDto) {
    return this.service.importSource(actor, opportunityId, dto);
  }

  @Post('analyze')
  analyze(@CurrentUser() actor: Actor, @Param('opportunityId', ParseUUIDPipe) opportunityId: string, @Body() dto: TenderDocumentAnalysisDto) {
    return this.service.analyze(actor, opportunityId, dto);
  }

  @Get(':id/analysis')
  analysis(@CurrentUser() actor: Actor, @Param('opportunityId', ParseUUIDPipe) opportunityId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.analysis(actor, opportunityId, id);
  }

  @Post(':id/reprocess')
  reprocess(@CurrentUser() actor: Actor, @Param('opportunityId', ParseUUIDPipe) opportunityId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.reprocess(actor, opportunityId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() actor: Actor, @Param('opportunityId', ParseUUIDPipe) opportunityId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(actor, opportunityId, id);
  }
}
