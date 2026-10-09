import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { Actor, PUBLIC_KEY, ROLES_KEY } from '../../common/access';
import { ApiTokensService } from '../api-tokens';
import { UsersService } from '../users/users.service';
import { AccessTokenPayload } from './auth.types';
import { AuthRepository } from './auth.repository';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly authRepository: AuthRepository,
    private readonly apiTokensService: ApiTokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: Actor }>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    if (token.startsWith('intly_')) {
      const verified = await this.apiTokensService.verify(token);
      if (!verified) throw new UnauthorizedException('Invalid API token');
      const user = await this.usersService.findById(verified.userId);
      if (!user || user.status !== 'Active') throw new UnauthorizedException('Account is not available');
      const actor: Actor = { ...this.usersService.toActor(user), scopes: verified.scopes };
      this.assertApiTokenScope(request, actor);
      this.assertRoles(context, actor);
      request.user = actor;
      return true;
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }

    if (payload.sessionId) {
      const session = await this.authRepository.findAccessSessionById(payload.sessionId);
      if (!session || session.userId !== payload.sub) {
        throw new UnauthorizedException('Session is not available');
      }
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user || user.status !== 'Active') {
      throw new UnauthorizedException('Account is not available');
    }

    const actor = this.usersService.toActor(user, payload.sessionId);
    this.assertRoles(context, actor);
    request.user = actor;
    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return Boolean(
      this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()]) ??
        this.reflector.getAllAndOverride<boolean>('isPublic', [context.getHandler(), context.getClass()]) ??
        this.reflector.getAllAndOverride<boolean>('public', [context.getHandler(), context.getClass()]),
    );
  }

  private assertRoles(context: ExecutionContext, actor: Actor): void {
    const roles =
      this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [context.getHandler(), context.getClass()]) ??
      this.reflector.getAllAndOverride<string[]>('roles', [context.getHandler(), context.getClass()]) ??
      this.reflector.getAllAndOverride<string[]>('allowedRoles', [context.getHandler(), context.getClass()]);
    if (roles?.length && !roles.includes(actor.role)) {
      throw new ForbiddenException('Role is not allowed');
    }
  }



  private assertApiTokenScope(request: Request, actor: Actor): void {
    const scopes = new Set(actor.scopes ?? []);
    const area = this.scopeArea(request.path);
    if (!area) throw new ForbiddenException('API token is not allowed for this endpoint');
    const verb = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'read' : 'write';
    const required = `${verb}:${area}`;
    if (!scopes.has(required)) {
      throw new ForbiddenException(`API token requires ${required}`);
    }
  }

  private scopeArea(path: string): 'opportunities' | 'profiles' | 'responses' | 'resumes' | null {
    const clean = path.replace(/^\/api\/v\d+/, '');
    if (clean.startsWith('/opportunities')) return 'opportunities';
    if (clean.startsWith('/profiles')) return 'profiles';
    if (clean.startsWith('/responses')) return 'responses';
    if (clean.startsWith('/resumes') || clean.startsWith('/resume-adaptations')) return 'resumes';
    return null;
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, token] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : null;
  }
}
