import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';

import { Actor, CurrentUser, Roles } from '../../common/access';
import { AiService } from './ai.service';
import { AdminAiProviderTestDto, AdminAiTestDto, AdminAiUsageQueryDto, AdminPromptPatchDto, AdminProviderPatchDto, AdminTaskRoutePatchDto, AiRunFeedbackDto, RunOpportunityAnalysisDto } from './dto/ai.dto';
import { AiTaskType } from './schemas/ai-config.schema';
import { AiProviderHealthService } from './ai-provider-health.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('analyses')
  runOpportunityAnalysis(@CurrentUser() actor: Actor, @Body() dto: RunOpportunityAnalysisDto) {
    return this.aiService.runOpportunityAnalysis(actor, dto);
  }

  @Get('runs')
  listRuns(
    @CurrentUser() actor: Actor,
    @Query('opportunityId') opportunityId?: string,
    @Query('profileId') profileId?: string,
    @Query('taskType') taskType?: AiTaskType,
  ) {
    return this.aiService.listRuns(actor, { opportunityId, profileId, taskType });
  }

  @Get('runs/:id')
  getRun(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.aiService.getRun(actor, id);
  }

  @Get('runs/:id/prompt')
  getPrompt(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.aiService.getPromptPreview(actor, id);
  }

  @Post('runs/:id/feedback')
  feedback(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: AiRunFeedbackDto) {
    return this.aiService.feedback(actor, id, dto);
  }

  @Post('runs/:id/cancel')
  cancel(@CurrentUser() actor: Actor, @Param('id') id: string) {
    return this.aiService.cancel(actor, id);
  }
}

@Roles('Admin')
@Controller('admin/ai')
export class AdminAiController {
  constructor(private readonly aiService: AiService, private readonly providerHealth: AiProviderHealthService) {}

  @Post('providers/:provider/test')
  @HttpCode(200)
  testProvider(@CurrentUser() actor: Actor, @Param('provider') provider: string, @Body() dto: AdminAiProviderTestDto) {
    return this.providerHealth.test(actor, provider, dto.modelId);
  }

  @Get('providers')
  providers() {
    return this.aiService.listProvidersAdmin();
  }

  @Patch('providers')
  patchProvider(@CurrentUser() actor: Actor, @Body() dto: AdminProviderPatchDto) {
    return this.aiService.patchProviderAdmin(actor, dto);
  }

  @Get('routes')
  routes() {
    return this.aiService.listRoutesAdmin();
  }

  @Patch('routes')
  patchRoute(@CurrentUser() actor: Actor, @Body() dto: AdminTaskRoutePatchDto) {
    return this.aiService.patchRouteAdmin(actor, dto);
  }

  @Get('prompts')
  prompts() {
    return this.aiService.listPromptsAdmin();
  }

  @Patch('prompts')
  patchPrompt(@CurrentUser() actor: Actor, @Body() dto: AdminPromptPatchDto) {
    return this.aiService.patchPromptAdmin(actor, dto);
  }

  @Get('schemas')
  schemas() {
    return this.aiService.schemasAdmin();
  }

  @Get('usage')
  usage(@Query() query: AdminAiUsageQueryDto) {
    return this.aiService.usageAdmin(query);
  }

  @Post('test')
  test(@CurrentUser() actor: Actor, @Body() dto: AdminAiTestDto) {
    return this.aiService.testAdmin(actor, dto);
  }
}
