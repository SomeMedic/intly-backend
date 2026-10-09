import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiModule } from '../ai';
import { MatchingModule } from '../matching';
import { NotificationsModule } from '../notifications';
import { OpportunitiesModule } from '../opportunities';
import { ProfilesModule } from '../profiles';
import { UsersModule } from '../users/users.module';
import { WebhooksModule } from '../webhooks';
import { WatchlistHit, WatchlistHitSchema } from './schemas/watchlist-hit.schema';
import { Watchlist, WatchlistSchema } from './schemas/watchlist.schema';
import { WatchlistsController } from './watchlists.controller';
import { WatchlistsRepository } from './watchlists.repository';
import { WatchlistsService } from './watchlists.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Watchlist.name, schema: WatchlistSchema },
      { name: WatchlistHit.name, schema: WatchlistHitSchema },
    ]),
    ProfilesModule,
    UsersModule,
    MatchingModule,
    OpportunitiesModule,
    AiModule,
    NotificationsModule,
    WebhooksModule,
  ],
  controllers: [WatchlistsController],
  providers: [WatchlistsRepository, WatchlistsService, { provide: 'WatchlistsService', useExisting: WatchlistsService }],
  exports: [WatchlistsRepository, WatchlistsService, 'WatchlistsService'],
})
export class WatchlistsModule {}
