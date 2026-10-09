import { UserRole } from '../users/schemas/user.schema';

export type AccessTokenPayload = {
  sub: string;
  email: string;
  role: UserRole;
  sessionId?: string;
};

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type RequestMetadata = {
  userAgent?: string;
  ip?: string;
};
