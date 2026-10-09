import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';

import { Actor, CurrentUser, Roles } from '../../common/access';
import { AuthAuditService } from '../auth/auth-audit.service';
import { AuthService } from '../auth/auth.service';
import { InviteUserDto } from '../auth/dto/auth.dto';
import { AdminChangeRoleDto, AdminSetStatusDto, AdminUpdateUserDto } from './dto/user.dto';
import { UsersService } from './users.service';

@Roles('Admin')
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly auditService: AuthAuditService,
  ) {}

  @Get()
  list(
    @Query('query') query?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('inviteState') inviteState?: string,
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.usersService.listAdmin({
      query,
      role,
      status,
      inviteState,
      createdFrom,
      createdTo,
      sort,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post()
  async invite(@CurrentUser() actor: Actor, @Body() dto: InviteUserDto, @Req() request: Request) {
    const result = await this.authService.inviteUser(actor, dto);
    await this.auditService.record({
      actor,
      action: 'user.invite',
      targetType: 'User',
      targetId: result.user.id,
      metadata: { role: dto.role ?? 'User' },
      requestId: this.requestId(request),
    });
    return result;
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.usersService.getAdmin(id);
  }

  @Patch(':id')
  async update(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: AdminUpdateUserDto, @Req() request: Request) {
    const updated = await this.usersService.updateAdmin(id, dto);
    if (dto.status && dto.status !== 'Active') {
      await this.authService.revokeUserSessions(id);
    }
    await this.auditService.record({
      actor,
      action: 'user.update',
      targetType: 'User',
      targetId: id,
      metadata: { fields: Object.keys(dto) },
      requestId: this.requestId(request),
    });
    return updated;
  }

  @Post(':id/status')
  async setStatus(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: AdminSetStatusDto, @Req() request: Request) {
    const updated = await this.usersService.setStatus(id, dto);
    if (dto.status !== 'Active') {
      await this.authService.revokeUserSessions(id);
    }
    await this.auditService.record({
      actor,
      action: 'user.status',
      targetType: 'User',
      targetId: id,
      metadata: { status: dto.status },
      requestId: this.requestId(request),
    });
    return updated;
  }

  @Post(':id/role')
  async changeRole(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: AdminChangeRoleDto, @Req() request: Request) {
    const updated = await this.usersService.changeRole(id, dto);
    await this.auditService.record({
      actor,
      action: 'user.role',
      targetType: 'User',
      targetId: id,
      metadata: { role: dto.role },
      requestId: this.requestId(request),
    });
    return updated;
  }

  @Post(':id/resend-invite')
  async resendInvite(@CurrentUser() actor: Actor, @Param('id') id: string, @Req() request: Request) {
    const result = await this.authService.resendInvite(actor, id);
    await this.auditService.record({
      actor,
      action: 'user.resend_invite',
      targetType: 'User',
      targetId: id,
      requestId: this.requestId(request),
    });
    return result;
  }

  @Post(':id/reset-password')
  async resetPassword(@CurrentUser() actor: Actor, @Param('id') id: string, @Req() request: Request) {
    const result = await this.authService.sendPasswordResetForUser(id);
    await this.auditService.record({
      actor,
      action: 'user.reset_password',
      targetType: 'User',
      targetId: id,
      requestId: this.requestId(request),
    });
    return {
      accepted: result.accepted,
      emailSent: result.emailSent,
      ...(result.deliveryError ? { deliveryError: result.deliveryError } : {}),
    };
  }

  @Post(':id/revoke-sessions')
  async revokeSessions(@CurrentUser() actor: Actor, @Param('id') id: string, @Req() request: Request) {
    const result = await this.authService.revokeUserSessions(id);
    await this.auditService.record({
      actor,
      action: 'user.revoke_sessions',
      targetType: 'User',
      targetId: id,
      requestId: this.requestId(request),
    });
    return result;
  }

  @Delete(':id')
  async delete(@CurrentUser() actor: Actor, @Param('id') id: string, @Req() request: Request) {
    await this.usersService.setStatus(id, { status: 'Deleted' });
    await this.authService.revokeUserSessions(id);
    await this.auditService.record({
      actor,
      action: 'user.delete',
      targetType: 'User',
      targetId: id,
      requestId: this.requestId(request),
    });
    return { success: true };
  }

  private requestId(request: Request): string | undefined {
    return typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : undefined;
  }
}
