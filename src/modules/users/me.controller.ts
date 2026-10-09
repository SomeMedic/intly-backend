import { Body, Controller, Get, Patch } from '@nestjs/common';

import { Actor, CurrentUser } from '../../common/access';
import { UpdateMeSettingsDto, UpdateOnboardingDto } from './dto/user.dto';
import { UsersService } from './users.service';

@Controller('me')
export class MeController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async getMe(@CurrentUser() actor: Actor) {
    return this.usersService.toPublicUser(await this.usersService.getMe(actor));
  }

  @Get('settings')
  getSettings(@CurrentUser() actor: Actor) {
    return this.usersService.getSettings(actor);
  }

  @Patch('settings')
  updateSettings(@CurrentUser() actor: Actor, @Body() dto: UpdateMeSettingsDto) {
    return this.usersService.updateSettings(actor, dto);
  }

  @Get('onboarding')
  getOnboarding(@CurrentUser() actor: Actor) {
    return this.usersService.getOnboarding(actor);
  }

  @Patch('onboarding')
  updateOnboarding(@CurrentUser() actor: Actor, @Body() dto: UpdateOnboardingDto) {
    return this.usersService.updateOnboarding(actor, dto);
  }
}
