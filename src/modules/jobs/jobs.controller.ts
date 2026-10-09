import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser, Roles } from '../../common/access';
import { JobsService } from './jobs.service';
class ListJobsQuery { @IsOptional() @IsIn(['waiting', 'active', 'completed', 'failed', 'delayed']) state?: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' }
@ApiTags('admin-jobs')
@Roles('Admin')
@Controller('admin/jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}
  @Get() counts() { return this.jobs.counts(); }
  @Get('dlq') dlq() { return this.jobs.dlq(); }
  @Get('scheduled') scheduled() { return this.jobs.scheduled(); }
  @Get(':queue') list(@Param('queue') queue: string, @Query() query: ListJobsQuery) { return this.jobs.list(queue, query.state); }
  @Get(':queue/:id') detail(@Param('queue') queue: string, @Param('id') id: string) { return this.jobs.detail(queue, id); }
  @Post(':queue/:id/retry') retry(@CurrentUser() actor: Actor, @Param('queue') queue: string, @Param('id') id: string) { return this.jobs.retry(queue, id, actor); }
  @Post(':queue/:id/cancel') cancel(@CurrentUser() actor: Actor, @Param('queue') queue: string, @Param('id') id: string) { return this.jobs.cancel(queue, id, actor); }
  @Post(':queue/:id/dismiss') dismiss(@CurrentUser() actor: Actor, @Param('queue') queue: string, @Param('id') id: string) { return this.jobs.dismissDlq(queue, id, actor); }
  @Post(':queue/pause') pause(@CurrentUser() actor: Actor, @Param('queue') queue: string) { return this.jobs.pause(queue, actor); }
  @Post(':queue/resume') resume(@CurrentUser() actor: Actor, @Param('queue') queue: string) { return this.jobs.resume(queue, actor); }
}
