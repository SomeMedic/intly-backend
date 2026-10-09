import { Body, Controller, ForbiddenException, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { Actor, CurrentUser, Public } from '../../common/access';
import { AuthService } from './auth.service';
import { AUTH_COOKIE_NAME, REFRESH_TOKEN_TTL_MS } from './auth.config';
import { ActivateInviteDto, ChangePasswordDto, ForgotPasswordDto, LoginDto, ResetPasswordDto } from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.assertTrustedOrigin(request, false);
    const result = await this.authService.login(dto, this.requestMetadata(request));
    this.setRefreshCookie(response, result.tokens.refreshToken);
    return {
      accessToken: result.tokens.accessToken,
      expiresIn: result.tokens.expiresIn,
      user: result.user,
    };
  }

  @Public()
  @Post('refresh')
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.assertTrustedOrigin(request, true);
    const result = await this.authService.refresh(this.readRefreshCookie(request), this.requestMetadata(request));
    this.setRefreshCookie(response, result.refreshToken);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
    };
  }

  @Post('logout')
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.assertTrustedOrigin(request, true);
    const result = await this.authService.logout(this.readRefreshCookie(request));
    this.clearRefreshCookie(response);
    return result;
  }

  @Public()
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Public()
  @Get('invite/validate')
  validateInvite(@Query('token') token: string) {
    return this.authService.validateInvite(token);
  }

  @Public()
  @Post('invite/activate')
  async activateInvite(@Body() dto: ActivateInviteDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.activate(dto, request, response);
  }

  @Public()
  @Post('activate')
  async activate(@Body() dto: ActivateInviteDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.assertTrustedOrigin(request, false);
    const result = await this.authService.activate(dto, this.requestMetadata(request));
    this.setRefreshCookie(response, result.tokens.refreshToken);
    return {
      accessToken: result.tokens.accessToken,
      expiresIn: result.tokens.expiresIn,
      user: result.user,
    };
  }

  @Post('change-password')
  changePassword(@CurrentUser() actor: Actor, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(actor, dto);
  }

  private requestMetadata(request: Request) {
    return {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    };
  }

  private readRefreshCookie(request: Request): string | undefined {
    return (request.cookies as Record<string, string> | undefined)?.[AUTH_COOKIE_NAME];
  }

  private setRefreshCookie(response: Response, token: string): void {
    response.cookie(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: REFRESH_TOKEN_TTL_MS,
      path: '/',
    });
  }

  private clearRefreshCookie(response: Response): void {
    response.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
  }

  private assertTrustedOrigin(request: Request, requireOrigin: boolean): void {
    const origin = request.headers.origin;
    if (!origin && !requireOrigin) return;
    const expectedOrigin = new URL(process.env.FRONTEND_URL ?? 'http://localhost:3000').origin;
    let actualOrigin: string | null = null;
    try {
      actualOrigin = origin ? new URL(origin).origin : null;
    } catch {
      actualOrigin = null;
    }
    if (!actualOrigin || actualOrigin !== expectedOrigin) {
      throw new ForbiddenException('Untrusted request origin');
    }
  }
}
