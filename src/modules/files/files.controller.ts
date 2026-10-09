import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { Actor, CurrentUser, Public } from '../../common/access';
import { CreateFileDto, CreateMultipartFileDto, FileListQueryDto } from './dto/file.dto';
import { FilesService } from './files.service';

@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: FileListQueryDto) {
    return this.filesService.list(actor, query);
  }

  @Post()
  create(@CurrentUser() actor: Actor, @Body() dto: CreateFileDto) {
    return this.filesService.create(actor, dto);
  }

  @Post('multipart')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
  createMultipart(
    @CurrentUser() actor: Actor,
    @UploadedFile() file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    @Body() dto: CreateMultipartFileDto,
  ) {
    return this.filesService.createMultipart(actor, file, dto);
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.filesService.get(actor, id);
  }

  @Get(':id/content')
  content(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.filesService.content(actor, id);
  }

  @Post(':id/download-url')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  download(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.filesService.download(actor, id);
  }

  @Public()
  @Get(':id/download')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  downloadWithTicket(@Param('id', ParseUUIDPipe) id: string, @Query('ticket') ticket: string) {
    return this.filesService.downloadWithTicket(id, ticket);
  }

  @Delete(':id')
  delete(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.filesService.delete(actor, id);
  }
}
