import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { Actor, CurrentUser, Roles } from '../../common/access';
import { CreateKnowledgeDocumentDto, CreateKnowledgeMultipartDocumentDto, KnowledgeDocumentListQueryDto, KnowledgeSearchDto, UpdateKnowledgeDocumentDto } from './dto/knowledge.dto';
import { KnowledgeService } from './knowledge.service';

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Get('documents')
  list(@CurrentUser() actor: Actor, @Query() query: KnowledgeDocumentListQueryDto) {
    return this.knowledgeService.list(actor, query);
  }

  @Post('documents')
  create(@CurrentUser() actor: Actor, @Body() dto: CreateKnowledgeDocumentDto) {
    return this.knowledgeService.create(actor, dto);
  }

  @Post('documents/multipart')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
  createMultipart(
    @CurrentUser() actor: Actor,
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    @Body() dto: CreateKnowledgeMultipartDocumentDto,
  ) {
    return this.knowledgeService.createMultipart(actor, file, dto);
  }

  @Get('documents/:id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.knowledgeService.get(actor, id);
  }

  @Patch('documents/:id')
  update(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateKnowledgeDocumentDto) {
    return this.knowledgeService.update(actor, id, dto);
  }

  @Delete('documents/:id')
  delete(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.knowledgeService.delete(actor, id);
  }

  @Post('documents/:id/reprocess')
  reprocess(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.knowledgeService.reprocess(actor, id);
  }

  @Post('reindex/:id')
  reindex(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.knowledgeService.reprocess(actor, id);
  }

  @Post('search')
  search(@CurrentUser() actor: Actor, @Body() dto: KnowledgeSearchDto) {
    return this.knowledgeService.search(actor, dto);
  }

  @Roles('Admin')
  @Post('embeddings/warmup')
  warmupEmbeddings() {
    return this.knowledgeService.warmupEmbeddings();
  }
}
