import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { AdminBackupsController, AdminInfrastructureController, AdminLogsController } from './admin-infrastructure.controller';
import { AdminInfrastructureService } from './admin-infrastructure.service';
@Module({ controllers: [HealthController, AdminInfrastructureController, AdminBackupsController, AdminLogsController], providers: [AdminInfrastructureService], exports: [AdminInfrastructureService] })
export class HealthModule {}
