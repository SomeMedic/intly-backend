import 'dotenv/config';
import 'reflect-metadata';
process.env.RUN_WORKERS = 'true';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}
void bootstrap().catch(error => { console.error(error instanceof Error ? error.message : 'Worker startup failed'); process.exitCode = 1; });
