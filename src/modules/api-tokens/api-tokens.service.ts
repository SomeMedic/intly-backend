import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { Actor } from '../../common/access';
import { CreateApiTokenDto } from './dto/api-token.dto';
import { ApiTokenScope } from './schemas/api-token.schema';
import { ApiTokensRepository } from './api-tokens.repository';

@Injectable()
export class ApiTokensService {
  constructor(private readonly apiTokensRepository: ApiTokensRepository) {}

  list(actor: Actor) {
    return this.apiTokensRepository.list(actor.id).then((items) => ({ items, nextCursor: null }));
  }

  async create(actor: Actor, dto: CreateApiTokenDto) {
    const scopes = dto.scopes?.length ? dto.scopes : ['read:opportunities' as ApiTokenScope];
    if (scopes.some((scope) => scope.startsWith('admin:'))) {
      throw new BadRequestException('Admin API token scopes are not allowed');
    }
    const expiresInDays = Math.min(dto.expiresInDays ?? 90, 365);
    const secret = `intly_${randomBytes(32).toString('base64url')}`;
    const saved = await this.apiTokensRepository.create({
      userId: actor.id,
      name: dto.name,
      scopes,
      tokenHash: this.hash(secret),
      tokenPrefix: secret.slice(0, 12),
      expiresAt: new Date(Date.now() + expiresInDays * 86400_000),
    });
    const { tokenHash: _tokenHash, ...publicToken } = saved;
    return { ...publicToken, token: secret };
  }

  revoke(actor: Actor, id: string) {
    return this.apiTokensRepository.revoke(id, actor.id);
  }

  async verify(rawToken: string): Promise<{ userId: string; scopes: ApiTokenScope[] } | null> {
    const token = await this.apiTokensRepository.findUsableByHash(this.hash(rawToken));
    if (!token) return null;
    await this.apiTokensRepository.touch(token._id);
    return { userId: token.userId, scopes: token.scopes };
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
