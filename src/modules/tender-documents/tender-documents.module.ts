import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge';
import { OpportunitiesModule } from '../opportunities';
import { ProfilesModule } from '../profiles';
import { TenderDocumentLink, TenderDocumentLinkSchema } from './schemas/tender-document-link.schema';
import { TenderDocumentsController } from './tender-documents.controller';
import { TenderDocumentsRepository } from './tender-documents.repository';
import { TenderDocumentsService } from './tender-documents.service';
import { TenderSourceDocumentDownloader } from './tender-source-document-downloader';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: TenderDocumentLink.name, schema: TenderDocumentLinkSchema }]),
    OpportunitiesModule,
    ProfilesModule,
    KnowledgeModule,
    AiModule,
  ],
  controllers: [TenderDocumentsController],
  providers: [TenderDocumentsRepository, TenderDocumentsService, TenderSourceDocumentDownloader],
  exports: [TenderDocumentsRepository, TenderDocumentsService],
})
export class TenderDocumentsModule {}
