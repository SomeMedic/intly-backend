import { Injectable } from '@nestjs/common';

import { Actor } from '../../common/access';
import { AuditService } from '../audit/audit.service';
import { AiRepository } from '../ai/ai.repository';
import { AdminUserInspectorRepository } from './admin-user-inspector.repository';
import {
  AdminUserInspectorBatchOverview,
  AdminUserInspectorOverview,
  AdminUserInspectorPage,
  AdminUserInspectorSection,
  assertInspectorUuid,
} from './dto/admin-user-inspector.dto';

@Injectable()
export class AdminUserInspectorService {
  constructor(
    private readonly repository: AdminUserInspectorRepository,
    private readonly aiRepository: AiRepository,
    private readonly auditService: AuditService,
  ) {}

  async overview(actor: Actor, userId: string): Promise<AdminUserInspectorOverview> {
    assertInspectorUuid(userId, 'userId');
    await this.repository.getUser(userId);
    return this.overviewForValidatedUser(userId);
  }

  async overviewBatch(actor: Actor, userIds: string[]): Promise<AdminUserInspectorBatchOverview> {
    for (const userId of userIds) assertInspectorUuid(userId, 'userId');
    await Promise.all(userIds.map((userId) => this.repository.getUser(userId)));
    const items = await Promise.all(userIds.map((userId) => this.overviewForValidatedUser(userId)));
    return { items, nextCursor: null };
  }

  async list(actor: Actor, userId: string, section: AdminUserInspectorSection, input: { limit: number; cursor?: string }): Promise<AdminUserInspectorPage> {
    assertInspectorUuid(userId, 'userId');
    await this.repository.getUser(userId);
    const page = await this.repository.list({ section, userId, limit: input.limit, cursor: input.cursor });
    return { section, ...page };
  }

  async content(actor: Actor, userId: string, section: AdminUserInspectorSection, entityId: string) {
    assertInspectorUuid(userId, 'userId');
    assertInspectorUuid(entityId, 'entityId');
    await this.repository.getUser(userId);
    const item = await this.repository.content(section, userId, entityId);
    await this.auditService.record(actor, 'user.inspect_content', 'User', userId, [`section:${section}`, `entityId:${entityId}`]);
    return { section, item };
  }

  private async overviewForValidatedUser(userId: string): Promise<AdminUserInspectorOverview> {
    const period = this.currentMonthPeriod();
    const [overview, currentMonthAiUsage] = await Promise.all([
      this.repository.overviewCounts(userId),
      this.aiRepository.usageSummary({ userId, dateFrom: period.dateFrom, dateTo: period.dateTo }),
    ]);
    return {
      userId,
      ...overview,
      currentMonthAiUsage,
      period,
    };
  }

  private currentMonthPeriod() {
    const now = new Date();
    const dateFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const dateTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString() };
  }
}
