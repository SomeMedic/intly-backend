import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DOMAIN = 'intly:file-download:v1';
const KEY_DOMAIN = 'intly:file-download:hmac-key:v1';
const PREFIX = 'fdl1';
const MAX_TICKET_LENGTH = 1024;
const MAX_TTL_MS = 5 * 60 * 1000;
const TICKET_RE = /^fdl1\.[A-Za-z0-9_-]{16,700}\.[A-Za-z0-9_-]{43}$/;

export type FileDownloadTicketPayload = {
  d: typeof DOMAIN;
  fid: string;
  oid: string;
  fv: string;
  exp: number;
};

@Injectable()
export class FilesDownloadTokensService {
  constructor(private readonly config: ConfigService) {}

  issue(input: { fileId: string; ownerUserId: string; fileVersion: string; now?: number; ttlMs?: number }): { ticket: string; expiresAt: Date } {
    const now = input.now ?? Date.now();
    const ttlMs = Math.min(input.ttlMs ?? MAX_TTL_MS, MAX_TTL_MS);
    const expiresAt = new Date(now + ttlMs);
    const payload: FileDownloadTicketPayload = {
      d: DOMAIN,
      fid: input.fileId,
      oid: input.ownerUserId,
      fv: input.fileVersion,
      exp: expiresAt.getTime(),
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = this.sign(encodedPayload);
    return { ticket: `${PREFIX}.${encodedPayload}.${signature}`, expiresAt };
  }

  verify(ticket: string, expectedFileId: string, now = Date.now()): FileDownloadTicketPayload {
    if (typeof ticket !== 'string' || ticket.length > MAX_TICKET_LENGTH || !TICKET_RE.test(ticket)) {
      throw new UnauthorizedException('Invalid file download ticket');
    }
    const [, encodedPayload, signature] = ticket.split('.');
    if (!this.constantTimeEqual(signature, this.sign(encodedPayload))) {
      throw new UnauthorizedException('Invalid file download ticket');
    }

    let payload: FileDownloadTicketPayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Invalid file download ticket');
    }
    if (
      !payload ||
      payload.d !== DOMAIN ||
      payload.fid !== expectedFileId ||
      typeof payload.oid !== 'string' ||
      !payload.oid ||
      typeof payload.fv !== 'string' ||
      !payload.fv ||
      !Number.isFinite(payload.exp) ||
      !Number.isInteger(payload.exp) ||
      payload.exp <= now ||
      payload.exp > now + MAX_TTL_MS
    ) {
      throw new UnauthorizedException('Invalid file download ticket');
    }
    return payload;
  }

  private sign(encodedPayload: string): string {
    return createHmac('sha256', this.signingKey()).update(`${DOMAIN}.${encodedPayload}`).digest('base64url');
  }

  private signingKey(): Buffer {
    return createHmac('sha256', this.config.getOrThrow<string>('JWT_SECRET')).update(KEY_DOMAIN).digest();
  }

  private constantTimeEqual(left: string, right: string): boolean {
    if (Buffer.from(left, 'base64url').toString('base64url') !== left) return false;
    const leftBuffer = Buffer.from(left, 'base64url');
    const rightBuffer = Buffer.from(right, 'base64url');
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
