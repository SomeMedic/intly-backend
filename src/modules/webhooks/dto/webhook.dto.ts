import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

import { WEBHOOK_EVENTS, WebhookEvent } from '../schemas/webhook.schema';

export class CreateWebhookDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  url!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events!: WebhookEvent[];

  @IsString()
  @MaxLength(300)
  secret!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events?: WebhookEvent[];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  secret?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
