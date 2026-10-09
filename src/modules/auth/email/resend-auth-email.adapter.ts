import { Injectable } from '@nestjs/common';

import { AuthEmailAdapter, AuthEmailResult } from './email.adapter';

@Injectable()
export class ResendAuthEmailAdapter implements AuthEmailAdapter {
  async sendInvite(input: { to: string; name: string; token: string }): Promise<AuthEmailResult> {
    return this.send({
      to: input.to,
      subject: 'INTLY account activation',
      html: this.linkEmail(input.name, 'activate', input.token),
    });
  }

  async sendPasswordReset(input: { to: string; name: string; token: string }): Promise<AuthEmailResult> {
    return this.send({
      to: input.to,
      subject: 'INTLY password reset',
      html: this.linkEmail(input.name, 'reset-password', input.token),
    });
  }

  private async send(input: { to: string; subject: string; html: string }): Promise<AuthEmailResult> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    if (!apiKey || !from) {
      return { sent: false, reason: 'RESEND_API_KEY and RESEND_FROM are not configured' };
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: input.to, subject: input.subject, html: input.html }),
    });

    if (!response.ok) {
      return { sent: false, reason: `Resend returned ${response.status}` };
    }

    return { sent: true };
  }

  private linkEmail(name: string, route: string, token: string): string {
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const safeName = name.replace(/[<>&"]/g, '');
    const url = `${frontendUrl}/${route}?token=${encodeURIComponent(token)}`;
    return `<p>Hello ${safeName},</p><p>Open this INTLY link:</p><p><a href="${url}">${url}</a></p>`;
  }
}
