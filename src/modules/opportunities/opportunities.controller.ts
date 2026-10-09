import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser, Roles } from '../../common/access';
import {
  BulkAdminReportsDto,
  BulkOpportunityActionDto,
  AdminCorrectionDto,
  AdminMergeDto,
  CreateOpportunityCommentDto,
  ImportFileDto,
  ListAdminReportsDto,
  ListDuplicateReviewsDto,
  ManualOpportunityDto,
  OpportunityExportDto,
  OpportunityListQueryDto,
  OpportunityProfileQueryDto,
  ReportIssueDto,
  ResolveAdminReportDto,
  UpdateAdminReportDto,
  UpdatePersonalStateDto,
} from './dto/opportunity.dto';
import { OpportunitiesService } from './opportunities.service';
import { OpportunityDeduplicationService } from './opportunity-deduplication.service';

@Controller('opportunities')
export class OpportunitiesController {
  constructor(private readonly opportunitiesService: OpportunitiesService) {}

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: OpportunityListQueryDto) {
    return this.opportunitiesService.list(actor, query);
  }

  @Post('manual')
  manualCreate(@CurrentUser() actor: Actor, @Body() dto: ManualOpportunityDto) {
    return this.opportunitiesService.manualCreate(actor, dto);
  }


  @Post('import-file')
  importFile(@CurrentUser() actor: Actor, @Body() dto: ImportFileDto) {
    return this.opportunitiesService.importFile(actor, dto);
  }

  @Post('export')
  export(@CurrentUser() actor: Actor, @Body() dto: OpportunityExportDto) {
    return this.opportunitiesService.export(actor, dto);
  }

  @Get('exports/:id')
  exportStatus(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.opportunitiesService.exportStatus(actor, id);
  }

  @Post('bulk')
  bulk(@CurrentUser() actor: Actor, @Body() dto: BulkOpportunityActionDto) {
    return this.opportunitiesService.bulk(actor, dto);
  }

  @Post(':id/view')
  view(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: OpportunityProfileQueryDto) {
    return this.opportunitiesService.view(actor, id, body?.profileId);
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Query() query: OpportunityProfileQueryDto) {
    return this.opportunitiesService.get(actor, id, query.profileId);
  }

  @Get(':id/personal')
  getPersonal(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: OpportunityProfileQueryDto,
  ) {
    return this.opportunitiesService.getPersonal(actor, id, query.profileId);
  }

  @Get(':id/personal-state')
  getPersonalState(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: OpportunityProfileQueryDto,
  ) {
    return this.opportunitiesService.getPersonal(actor, id, query.profileId);
  }

  @Patch(':id/personal')
  updatePersonal(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePersonalStateDto) {
    return this.opportunitiesService.updatePersonal(actor, id, dto);
  }

  @Patch(':id/personal-state')
  updatePersonalState(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePersonalStateDto) {
    return this.opportunitiesService.updatePersonal(actor, id, dto);
  }

  @Post(':id/report')
  reportIssue(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportIssueDto) {
    return this.opportunitiesService.reportIssue(actor, id, dto);
  }

  @Get(':id/sources')
  sources(@Param('id', ParseUUIDPipe) id: string) {
    return this.opportunitiesService.getSources(id, false);
  }

  @Get(':id/comments')
  comments(@Param('id', ParseUUIDPipe) id: string) {
    return this.opportunitiesService.listComments(id);
  }

  @Post(':id/comments')
  createComment(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateOpportunityCommentDto,
  ) {
    return this.opportunitiesService.createComment(actor, id, dto);
  }

  @Delete(':id/comments/:commentId')
  deleteComment(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    return this.opportunitiesService.deleteComment(actor, id, commentId);
  }
}

@Roles('Admin')
@Controller('admin/opportunities')
export class AdminOpportunitiesController {
  constructor(private readonly opportunitiesService: OpportunitiesService, private readonly deduplication: OpportunityDeduplicationService) {}

  @Get('dedup/status')
  deduplicationStatus() { return this.deduplication.historicalStatus(); }

  @Get('dedup/reviews')
  duplicateReviews(@Query() query: ListDuplicateReviewsDto) { return this.deduplication.listReviews(query); }

  @Post('dedup/reviews/:id/recheck')
  recheckDuplicate(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.deduplication.requestReviewCheck(id, actor.id); }

  @Post('dedup/backfill')
  startDuplicateBackfill(@CurrentUser() actor: Actor) { return this.deduplication.startHistoricalRun(actor.id); }

  @Post(':id/corrections')
  applyCorrection(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminCorrectionDto,
  ) {
    return this.opportunitiesService.adminApplyCorrection(actor, id, dto.field as never, dto.value, dto.reason);
  }

  @Post(':id/merge')
  merge(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminMergeDto) {
    return this.opportunitiesService.adminMerge(actor, id, dto.duplicateId);
  }

  @Get(':id/sources')
  sources(@Param('id', ParseUUIDPipe) id: string) {
    return this.opportunitiesService.getSources(id, true);
  }
}

@Roles('Admin')
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly opportunitiesService: OpportunitiesService) {}

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: ListAdminReportsDto) {
    return this.opportunitiesService.adminListReports(actor, query);
  }

  @Post('bulk')
  bulk(@CurrentUser() actor: Actor, @Body() dto: BulkAdminReportsDto) {
    return this.opportunitiesService.adminBulkReports(actor, dto);
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.opportunitiesService.adminGetReport(actor, id);
  }

  @Patch(':id')
  update(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAdminReportDto) {
    return this.opportunitiesService.adminUpdateReport(actor, id, dto);
  }

  @Post(':id/resolve')
  resolve(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveAdminReportDto) {
    return this.opportunitiesService.adminResolveReport(actor, id, dto);
  }

  @Post(':id/dismiss')
  dismiss(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveAdminReportDto) {
    return this.opportunitiesService.adminDismissReport(actor, id, dto);
  }
}
