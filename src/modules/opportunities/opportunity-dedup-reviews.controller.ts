import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';

import { Actor, CurrentUser, Roles } from '../../common/access';
import { ResolveDuplicateReviewDto } from './dto/duplicate-review.dto';
import { OpportunityDedupReviewsService } from './opportunity-dedup-reviews.service';

@Roles('Admin')
@Controller('admin/opportunities/dedup/reviews')
export class OpportunityDedupReviewsController {
  constructor(private readonly reviews: OpportunityDedupReviewsService) {}

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.reviews.get(id);
  }

  @Post(':id/resolve')
  resolve(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDuplicateReviewDto,
  ) {
    return this.reviews.resolve(actor, id, dto);
  }
}
