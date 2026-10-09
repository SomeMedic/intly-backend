import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DeadLetter, DeadLetterSchema } from './schemas/dead-letter.schema';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
@Global()
@Module({ imports: [MongooseModule.forFeature([{ name: DeadLetter.name, schema: DeadLetterSchema }])], providers: [JobsService], controllers: [JobsController], exports: [JobsService] })
export class JobsModule {}
