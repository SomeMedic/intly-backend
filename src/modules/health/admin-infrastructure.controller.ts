import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/access';
import { OperationalLogQuery } from '../../common/operational-logs';
import { AdminInfrastructureService } from './admin-infrastructure.service';

@ApiTags('admin-infrastructure')
@Roles('Admin')
@Controller('admin/infrastructure')
export class AdminInfrastructureController {
  constructor(private readonly infrastructure: AdminInfrastructureService) {}

  @Get()
  summary() {
    return this.infrastructure.summary();
  }

  @Get('health')
  health() {
    return this.infrastructure.summary();
  }
}

@ApiTags('admin-backups')
@Roles('Admin')
@Controller('admin/backups')
export class AdminBackupsController {
  constructor(private readonly infrastructure: AdminInfrastructureService) {}

  @Get()
  list() {
    return this.infrastructure.backups();
  }
}

@ApiTags('admin-logs')
@Roles('Admin')
@Controller('admin/logs')
export class AdminLogsController {
  constructor(private readonly infrastructure: AdminInfrastructureService) {}

  @Get()
  list(@Query() query: OperationalLogQuery) {
    return this.infrastructure.logs(query);
  }
}
