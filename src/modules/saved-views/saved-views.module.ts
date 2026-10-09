import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { SavedView, SavedViewSchema } from './schemas/saved-view.schema';
import { SavedViewsController } from './saved-views.controller';
import { SavedViewsRepository } from './saved-views.repository';
import { SavedViewsService } from './saved-views.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: SavedView.name, schema: SavedViewSchema }])],
  controllers: [SavedViewsController],
  providers: [SavedViewsRepository, SavedViewsService],
  exports: [SavedViewsRepository, SavedViewsService],
})
export class SavedViewsModule {}
