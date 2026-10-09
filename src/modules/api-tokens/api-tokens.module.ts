import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensRepository } from './api-tokens.repository';
import { ApiTokensService } from './api-tokens.service';
import { ApiToken, ApiTokenSchema } from './schemas/api-token.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: ApiToken.name, schema: ApiTokenSchema }])],
  controllers: [ApiTokensController],
  providers: [ApiTokensRepository, ApiTokensService],
  exports: [ApiTokensRepository, ApiTokensService],
})
export class ApiTokensModule {}
