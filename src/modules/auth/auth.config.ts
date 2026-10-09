const minutes = 60 * 1000;
const days = 24 * 60 * minutes;

export const AUTH_COOKIE_NAME = 'intly_refresh';
export const ACCESS_TOKEN_TTL_SECONDS = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 15 * 60);
export const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_MS ?? Number(process.env.REFRESH_TTL_DAYS ?? 30) * days);
export const INVITE_TOKEN_TTL_MS = Number(process.env.INVITE_TOKEN_TTL_MS ?? 7 * days);
export const PASSWORD_RESET_TOKEN_TTL_MS = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MS ?? 60 * minutes);
export const MIN_PASSWORD_LENGTH = Number(process.env.MIN_PASSWORD_LENGTH ?? 12);

export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters');
  }
  return secret;
}
