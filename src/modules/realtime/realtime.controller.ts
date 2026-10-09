import { Controller, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser } from '../../common/access';
import { RealtimeService } from './realtime.service';
@ApiTags('realtime')
@Controller('events')
export class RealtimeController {
  constructor(private readonly events: RealtimeService) {}
  @Sse() stream(@CurrentUser() actor: Actor) { return this.events.stream(actor.id); }
}
