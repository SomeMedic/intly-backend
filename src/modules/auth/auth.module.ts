import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';

import { UsersModule } from '../users/users.module';
import { AuthBootstrapService } from './auth-bootstrap.service';
import { AuthAuditService } from './auth-audit.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRepository } from './auth.repository';
import { AUTH_EMAIL_ADAPTER, AuthService } from './auth.service';
import { ResendAuthEmailAdapter } from './email/resend-auth-email.adapter';
import { InviteToken, InviteTokenSchema } from './schemas/invite-token.schema';
import { PasswordResetToken, PasswordResetTokenSchema } from './schemas/password-reset-token.schema';
import { UserSession, UserSessionSchema } from './schemas/user-session.schema';
import { AdminUsersController } from '../users/admin-users.controller';
import { MeController } from '../users/me.controller';
import { ApiTokensModule } from '../api-tokens';
import { AuditModule } from '../audit/audit.module';
import { AiModule } from '../ai/ai.module';
import { AdminUserInspectorController } from '../users/admin-user-inspector.controller';
import { AdminUserInspectorRepository } from '../users/admin-user-inspector.repository';
import { AdminUserInspectorService } from '../users/admin-user-inspector.service';

@Module({
  imports: [
    UsersModule,
    ApiTokensModule,
    AuditModule,
    AiModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
    MongooseModule.forFeature([
      { name: UserSession.name, schema: UserSessionSchema },
      { name: InviteToken.name, schema: InviteTokenSchema },
      { name: PasswordResetToken.name, schema: PasswordResetTokenSchema },
    ]),
  ],
  controllers: [AuthController, MeController, AdminUsersController, AdminUserInspectorController],
  providers: [
    AuthRepository,
    AuthService,
    AuthAuditService,
    AuthBootstrapService,
    AdminUserInspectorRepository,
    AdminUserInspectorService,
    ResendAuthEmailAdapter,
    { provide: AUTH_EMAIL_ADAPTER, useExisting: ResendAuthEmailAdapter },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService, AuthRepository, AuthAuditService],
})
export class AuthModule {}
