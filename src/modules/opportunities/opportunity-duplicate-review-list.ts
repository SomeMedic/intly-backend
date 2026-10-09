import { BadRequestException } from '@nestjs/common';

export type DuplicateReviewListOptions = { limit?: number; cursor?: string; query?: string };
export type DuplicateReviewCursor = { checkedAt: Date; id: string };

export function decodeDuplicateReviewCursor(value?: string): DuplicateReviewCursor | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 300 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('Invalid encoding');
    const payload: unknown = JSON.parse(decoded.toString('utf8'));
    if (!payload || typeof payload !== 'object' || !('checkedAt' in payload) || !('id' in payload)) throw new Error('Invalid cursor');
    if (typeof payload.checkedAt !== 'string' || typeof payload.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id)) throw new Error('Invalid cursor');
    const checkedAt = new Date(payload.checkedAt);
    if (!Number.isFinite(+checkedAt) || checkedAt.toISOString() !== payload.checkedAt) throw new Error('Invalid date');
    return { checkedAt, id: payload.id };
  } catch {
    throw new BadRequestException('Invalid duplicate review cursor');
  }
}

export function encodeDuplicateReviewCursor(row: { _id: string; checkedAt: Date }): string {
  return Buffer.from(JSON.stringify({ checkedAt: new Date(row.checkedAt).toISOString(), id: row._id })).toString('base64url');
}

export function duplicateReviewSearchPattern(query: string): string {
  return Array.from(query.trim()).map(character => '.^$*+?()[]{}|\\'.includes(character) ? `\\${character}` : character).join('');
}
