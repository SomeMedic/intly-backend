import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { CreateResumeAdaptationDto, CreateResumeDto, ExportResumeDto, RevisionDto, UndoResumeReorderDto, UpdateResumeAdaptationDto, UpdateResumeDto } from './dto/resume.dto';
import { ResumesService } from './resumes.service';

@Controller()
export class ResumesController {
  constructor(private readonly resumesService: ResumesService) {}

  @Get('resumes')
  listResumes(@CurrentUser() actor: Actor, @Query('profileId') profileId?: string, @Query('kind') kind?: string) {
    return this.resumesService.listResumes(actor, { profileId, kind });
  }

  @Post('resumes')
  createResume(@CurrentUser() actor: Actor, @Body() dto: CreateResumeDto) {
    return this.resumesService.createResume(actor, dto);
  }

  @Get('resumes/:id')
  getResume(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.resumesService.getResume(actor, id);
  }

  @Patch('resumes/:id')
  updateResume(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: UpdateResumeDto) {
    return this.resumesService.updateResume(actor, id, dto);
  }

  @Get('resume-adaptations')
  listAdaptations(
    @CurrentUser() actor: Actor,
    @Query('opportunityId') opportunityId?: string,
    @Query('profileId') profileId?: string,
    @Query('baseResumeId') baseResumeId?: string,
    @Query('deleted') deleted?: string,
  ) {
    return this.resumesService.listAdaptations(actor, { opportunityId, profileId, baseResumeId, deleted });
  }

  @Post('opportunities/:opportunityId/resume-adaptations')
  createAdaptation(@CurrentUser() actor: Actor, @Param('opportunityId') opportunityId: string, @Body() dto: CreateResumeAdaptationDto) {
    return this.resumesService.createAdaptation(actor, opportunityId, dto);
  }

  @Get('resume-adaptations/:id')
  getAdaptation(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.resumesService.getAdaptation(actor, id);
  }

  @Patch('resume-adaptations/:id')
  updateAdaptation(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: UpdateResumeAdaptationDto) {
    return this.resumesService.updateAdaptation(actor, id, dto);
  }

  @Post('resume-adaptations/:id/suggestions/:suggestionId/accept')
  acceptSuggestion(@CurrentUser() actor: Actor, @Param('id') id: string, @Param('suggestionId') suggestionId: string, @Body() dto: RevisionDto) {
    return this.resumesService.acceptSuggestion(actor, id, suggestionId, dto);
  }

  @Post('resume-adaptations/:id/suggestions/:suggestionId/reject')
  rejectSuggestion(@CurrentUser() actor: Actor, @Param('id') id: string, @Param('suggestionId') suggestionId: string, @Body() dto: RevisionDto) {
    return this.resumesService.rejectSuggestion(actor, id, suggestionId, dto);
  }

  @Post('resume-adaptations/:id/suggestions/:suggestionId/undo-reorder')
  undoReorderSuggestion(@CurrentUser() actor: Actor, @Param('id') id: string, @Param('suggestionId') suggestionId: string, @Body() dto: UndoResumeReorderDto) {
    return this.resumesService.undoReorderSuggestion(actor, id, suggestionId, dto);
  }

  @Delete('resume-adaptations/:id')
  deleteAdaptation(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: RevisionDto) {
    return this.resumesService.deleteAdaptation(actor, id, dto);
  }

  @Post('resume-adaptations/:id/restore')
  restoreAdaptation(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: RevisionDto) {
    return this.resumesService.restoreAdaptation(actor, id, dto);
  }

  @Post('resume-adaptations/:id/export')
  exportAdaptation(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: ExportResumeDto) {
    return this.resumesService.exportAdaptation(actor, id, dto);
  }
}
