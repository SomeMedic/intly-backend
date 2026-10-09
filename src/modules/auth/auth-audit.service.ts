import { Injectable } from '@nestjs/common';

import { Actor } from '../../common/access';
import { AuditService } from '../audit/audit.service';

export type CriticalAdminAction =
  | 'user.invite'
  | 'user.update'
  | 'user.status'
  | 'user.role'
  | 'user.resend_invite'
  | 'user.reset_password'
  | 'user.revoke_sessions'
  | 'user.delete';

@Injectable()
export class AuthAuditService {
  constructor(private readonly auditService: AuditService) {}

  async record(input: {
    actor: Actor;
    action: CriticalAdminAction;
    targetType: 'User';
    targetId: string;
    metadata?: Record<string, unknown>;
    requestId?: string;
  }): Promise<void> {
    const fields = [
      ...(input.metadata ? Object.keys(input.metadata) : []),
      ...(input.requestId ? [`requestId:${input.requestId}`] : []),
    ];
    await this.auditService.record(input.actor, input.action, input.targetType, input.targetId, fields);
  }
}
