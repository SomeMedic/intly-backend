import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { TASK_TYPES, TaskType } from '../schemas/task.schema';

export class BoardColumnDto {
  @IsString()
  id!: string;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsNumber()
  @Min(0)
  order!: number;
}

export class UpsertBoardDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  members?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BoardColumnDto)
  columns?: BoardColumnDto[];

  @IsOptional()
  @IsString()
  scope?: string;
}

export class UpdateBoardDto extends UpsertBoardDto {
  @IsOptional()
  declare name: string;
}

export class TaskListQueryDto {
  @IsOptional()
  @IsUUID()
  boardId?: string;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsOptional()
  @IsUUID()
  reporterId?: string;

  @IsOptional()
  @IsString()
  statusColumnId?: string;

  @IsOptional()
  @IsIn(TASK_TYPES)
  type?: TaskType;

  @IsOptional()
  @IsString()
  priority?: string;

  @IsOptional()
  @IsUUID()
  opportunityId?: string;
}


export class SubtaskDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MaxLength(240)
  title!: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;
}

export class ChecklistItemDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MaxLength(240)
  text!: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}

export class UpsertTaskDto {
  @IsUUID()
  boardId!: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsIn(TASK_TYPES)
  type?: TaskType;

  @IsString()
  @MaxLength(240)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  statusColumnId!: string;

  @IsOptional()
  @IsString()
  priority?: string;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  @IsOptional()
  @IsUUID()
  profileId?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubtaskDto)
  subtasks?: SubtaskDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  checklist?: ChecklistItemDto[];
}

export class UpdateTaskDto extends UpsertTaskDto {
  @IsOptional()
  declare boardId: string;

  @IsOptional()
  declare title: string;

  @IsOptional()
  declare statusColumnId: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}

export class CreateTaskCommentDto {
  @IsString()
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  mentionUserIds?: string[];
}

export class CreateTaskReminderDto {
  @IsDateString()
  remindAt!: string;

  @IsArray()
  @IsString({ each: true })
  channels!: string[];
}
