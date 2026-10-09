import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { FilesModule } from '../files';
import { JobsModule } from '../jobs/jobs.module';
import { ProfilesModule } from '../profiles';
import { RealtimeModule } from '../realtime/realtime.module';
import { ChunkerService } from './chunker.service';
import { DocumentParserService } from './document-parser.service';
import { EmbeddingsService } from './embeddings.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeRepository } from './knowledge.repository';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeChunk, KnowledgeChunkSchema } from './schemas/knowledge-chunk.schema';
import { KnowledgeDocument, KnowledgeDocumentSchema } from './schemas/knowledge-document.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: KnowledgeDocument.name, schema: KnowledgeDocumentSchema },
      { name: KnowledgeChunk.name, schema: KnowledgeChunkSchema },
    ]),
    FilesModule,
    JobsModule,
    RealtimeModule,
    ProfilesModule,
  ],
  controllers: [KnowledgeController],
  providers: [KnowledgeRepository, KnowledgeService, DocumentParserService, ChunkerService, EmbeddingsService],
  exports: [KnowledgeRepository, KnowledgeService, EmbeddingsService],
})
export class KnowledgeModule {}
