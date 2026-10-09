import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export type Role = 'Admin' | 'User';
export interface Actor { id: string; email: string; role: Role; sessionId?: string; scopes?: string[] }
export const PUBLIC_KEY = 'intly:public';
export const ROLES_KEY = 'intly:roles';
export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): Actor => context.switchToHttp().getRequest().user);
