import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Profile, ProfileSchema } from './schemas/profile.schema';
import { ProfilesController } from './profiles.controller';
import { ProfilesRepository } from './profiles.repository';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Profile.name, schema: ProfileSchema }])],
  controllers: [ProfilesController],
  providers: [ProfilesRepository, ProfilesService],
  exports: [ProfilesRepository, ProfilesService],
})
export class ProfilesModule {}
