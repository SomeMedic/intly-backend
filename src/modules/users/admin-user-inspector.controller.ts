import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser, Roles } from '../../common/access';
import { AdminUserInspectorService } from './admin-user-inspector.service';
import {
  AdminUserInspectorBatchOverviewDto,
  AdminUserInspectorPageQuery,
  parseInspectorCursor,
  parseInspectorLimit,
  parseInspectorSection,
  parseInspectorUserIds,
} from './dto/admin-user-inspector.dto';

@Roles('Admin')
@Controller('admin/users')
export class AdminUserInspectorController {
  constructor(private readonly inspector: AdminUserInspectorService) {}

  @Post('inspector/overview-batch')
  overviewBatch(@CurrentUser() actor: Actor, @Body() body: AdminUserInspectorBatchOverviewDto) {
    return this.inspector.overviewBatch(actor, parseInspectorUserIds(body.userIds));
  }

  @Get(':id/inspector/overview')
  overview(@CurrentUser() actor: Actor, @Param('id') userId: string) {
    return this.inspector.overview(actor, userId);
  }

  @Get(':id/inspector/:section')
  list(@CurrentUser() actor: Actor, @Param('id') userId: string, @Param('section') section: string, @Query() query: AdminUserInspectorPageQuery) {
    return this.inspector.list(actor, userId, parseInspectorSection(section), {
      limit: parseInspectorLimit(query.limit),
      cursor: parseInspectorCursor(query.cursor),
    });
  }

  @Get(':id/inspector/:section/:entityId/content')
  content(@CurrentUser() actor: Actor, @Param('id') userId: string, @Param('section') section: string, @Param('entityId') entityId: string) {
    return this.inspector.content(actor, userId, parseInspectorSection(section), entityId);
  }
}
