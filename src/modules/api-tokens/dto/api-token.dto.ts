import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { API_TOKEN_SCOPES, ApiTokenScope } from '../schemas/api-token.schema';

export class CreateApiTokenDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(API_TOKEN_SCOPES, { each: true })
  scopes?: ApiTokenScope[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
