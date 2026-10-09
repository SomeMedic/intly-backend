import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import { Connection } from 'mongoose';
import { Public, Roles } from '../../common/access';
import { JobsService } from '../jobs/jobs.service';
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly mongo: Connection, private readonly jobs: JobsService) {}
  @Public() @Get('live') live() { return { status: 'ok', timestamp: new Date().toISOString() }; }
  @Public() @Get('ready') async ready() { const mongo = this.mongo.readyState === 1; const redis = await this.jobs.health(); if (!mongo || !redis) throw new ServiceUnavailableException(); return { status: 'ok' }; }
  @Roles('Admin') @Get('dependencies') async dependencies() { return { mongo: this.mongo.readyState === 1 ? 'Healthy' : 'Unavailable', redis: await this.jobs.health() ? 'Healthy' : 'Unavailable' }; }
}
