import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

@Global()
@Module({ imports: [MongooseModule.forRootAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ uri: config.getOrThrow<string>('MONGODB_URI'), serverSelectionTimeoutMS: 10000, maxPoolSize: 15, autoIndex: config.get('NODE_ENV') !== 'production' }) })], exports: [MongooseModule] })
export class DataModule {}
