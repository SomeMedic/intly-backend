import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  constructor(config: ConfigService) { this.key = Buffer.from(config.getOrThrow<string>('MASTER_ENCRYPTION_KEY'), 'hex'); }
  encrypt(plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
  }
  decrypt(encrypted: string): string {
    const [version, nonce, tag, body] = encrypted.split('.');
    if (version !== 'v1' || !nonce || !tag || body === undefined) throw new Error('Invalid encrypted credential');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  }
}
