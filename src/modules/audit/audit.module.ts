import { Controller, Get, Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Roles } from '../../common/access';
import { AuditEvent, AuditEventSchema, AuditService } from './audit.service';
@Controller('admin/audit')
@Roles('Admin')
class AuditController { constructor(private readonly audit: AuditService) {} @Get() list() { return this.audit.list(); } }
@Global()
@Module({ imports: [MongooseModule.forFeature([{ name: AuditEvent.name, schema: AuditEventSchema }])], providers: [AuditService], controllers: [AuditController], exports: [AuditService] })
export class AuditModule {}
