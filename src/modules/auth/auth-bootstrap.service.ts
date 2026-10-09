import { Injectable, OnModuleInit } from '@nestjs/common';

import { AuthService } from './auth.service';

@Injectable()
export class AuthBootstrapService implements OnModuleInit {
  constructor(private readonly authService: AuthService) {}

  async onModuleInit(): Promise<void> {
    await this.authService.bootstrapDevelopmentAdmin();
  }
}
