import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';

export class DashboardQueryDto {
  @IsOptional() @IsUUID() profileId?: string;
  @IsOptional() @IsIn(['today', '7d', '30d', '90d', 'custom']) period?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
