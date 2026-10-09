import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

import { MIN_PASSWORD_LENGTH } from '../auth.config';
import { USER_ROLES, UserRole } from '../../users/schemas/user.schema';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  newPassword!: string;
}

export class ActivateInviteDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;
}

export class ValidateTokenDto {
  @IsString()
  token!: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  newPassword!: string;
}

export class InviteDefaultsDto {
  @IsOptional()
  @IsBoolean()
  starterProfile?: boolean;

  @IsOptional()
  @IsBoolean()
  defaultPrompts?: boolean;

  @IsOptional()
  @IsBoolean()
  notifications?: boolean;
}

export class InviteUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => InviteDefaultsDto)
  inviteDefaults?: InviteDefaultsDto;
}
