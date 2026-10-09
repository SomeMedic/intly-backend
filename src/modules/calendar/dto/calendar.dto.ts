import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsObject, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

export class CalendarQueryDto {
  @IsOptional()
  @IsDateString()
  start?: string;

  @IsOptional()
  @IsDateString()
  end?: string;

  @IsOptional()
  @IsString()
  type?: string;
}

export class CalendarReminderDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsDateString()
  remindAt!: string;

  @IsArray()
  @IsString({ each: true })
  channels!: string[];
}

export class UpsertCalendarEventDto {
  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  @IsOptional()
  @IsUUID()
  taskId?: string;

  @IsString()
  type!: string;

  @IsDateString()
  startAt!: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsString()
  @MaxLength(240)
  title!: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CalendarReminderDto)
  reminders?: CalendarReminderDto[];
}

export class UpdateCalendarEventDto extends UpsertCalendarEventDto {
  @IsOptional()
  declare type: string;

  @IsOptional()
  declare startAt: string;

  @IsOptional()
  declare title: string;
}
