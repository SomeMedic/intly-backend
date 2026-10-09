import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { FileAsset, FileAssetSchema } from './schemas/file-asset.schema';
import { FilesController } from './files.controller';
import { FilesRepository } from './files.repository';
import { FilesService } from './files.service';
import { FilesStorageService } from './files-storage.service';
import { FilesDownloadTokensService } from './files-download-tokens.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: FileAsset.name, schema: FileAssetSchema }])],
  controllers: [FilesController],
  providers: [FilesRepository, FilesStorageService, FilesDownloadTokensService, FilesService],
  exports: [FilesRepository, FilesStorageService, FilesDownloadTokensService, FilesService],
})
export class FilesModule {}
