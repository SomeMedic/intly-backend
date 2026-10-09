import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './common/http-error.filter';
import { ResponseInterceptor } from './common/response.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use(cookieParser());
  app.use((request: Request & { id?: string }, response: Response, next: NextFunction) => { if (request.id) response.setHeader('X-Request-Id', request.id); next(); });
  app.enableCors({ origin: config.getOrThrow<string>('FRONTEND_URL'), credentials: true, exposedHeaders: ['X-Request-Id'], methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  app.useGlobalFilters(new HttpErrorFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.enableShutdownHooks();
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('INTLY API').setDescription('Canonical REST contract. Owner decisions dated 2026-10-02 apply.').setVersion('1.0.0').addBearerAuth().build());
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/v1/openapi.json' });
  await app.listen(config.getOrThrow<number>('PORT'), config.get<string>('HOST') ?? (config.get('NODE_ENV') === 'production' ? '0.0.0.0' : '127.0.0.1'));
  app.get(Logger).log(`INTLY API ready on port ${config.get('PORT')}`);
}
void bootstrap().catch(error => { console.error(error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1; });
