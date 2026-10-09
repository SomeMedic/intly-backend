import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';

export class ResolveDuplicateReviewDto {
  @IsUUID()
  candidateId!: string;

  @IsIn(['distinct', 'merge'])
  decision!: 'distinct' | 'merge';

  @ValidateIf((dto: ResolveDuplicateReviewDto) => dto.decision === 'merge')
  @IsUUID()
  targetId?: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  reviewToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
