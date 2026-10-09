import { Module } from '@nestjs/common';

import { KnowledgeModule } from '../knowledge';
import { ProfilesModule } from '../profiles';
import { DocumentsService } from './documents.service';
import { ResumeExportService } from './resume-export.service';

@Module({
  imports: [KnowledgeModule, ProfilesModule],
  providers: [DocumentsService, ResumeExportService],
  exports: [DocumentsService, ResumeExportService],
})
export class DocumentsModule {}
