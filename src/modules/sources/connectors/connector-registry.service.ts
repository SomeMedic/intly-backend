import { Injectable } from '@nestjs/common';

import { Source } from '../schemas/source.schema';
import { WebExtractionService } from '../extraction/web-extraction.service';
import { AuthenticatedAtsConnector } from './authenticated-ats.connector';
import { AuthenticatedMarketplaceConnector } from './authenticated-marketplace.connector';
import { AtsPublicBoardConnector } from './ats-public-board.connector';
import { ArcConnector } from './arc.connector';
import { B2bCenterConnector } from './b2b-center.connector';
import { BuduConnector } from './budu.connector';
import { BuiltinConnector } from './builtin.connector';
import { Connector } from './connector.types';
import { GenericPublicWebConnector } from './generic-public-web.connector';
import { FreelanceRuConnector } from './freelance-ru.connector';
import { FinderWorkConnector } from './finder-work.connector';
import { FabrikantConnector } from './fabrikant.connector';
import { GdeRabotaConnector } from './gderabota.connector';
import { GetmatchConnector } from './getmatch.connector';
import { HabrConnector } from './habr.connector';
import { HhConnector } from './hh.connector';
import { KworkConnector } from './kwork.connector';
import { PublicApiFeedConnector } from './public-api-feed.connector';
import { RabotaRuConnector } from './rabota-ru.connector';
import { RoseltorgConnector } from './roseltorg.connector';
import { TelegramMtprotoConnector } from './telegram-mtproto.connector';
import { UnavailableConnector } from './unavailable.connector';
import { VkWallConnector } from './vk-wall.connector';
import { WeblancerConnector } from './weblancer.connector';
import { WeWorkRemotelyConnector } from './weworkremotely.connector';
import { WorkingNomadsConnector } from './working-nomads.connector';
import { WorkdayConnector } from './workday.connector';
import { WorkspaceConnector } from './workspace.connector';
import { YcJobsConnector } from './yc-jobs.connector';

@Injectable()
export class ConnectorRegistryService {
  private readonly connectors: Map<string, Connector>;
  private readonly telegramConnector = new TelegramMtprotoConnector();
  private readonly vkConnector = new VkWallConnector();
  private readonly genericPublicWebConnector: GenericPublicWebConnector;
  private readonly freelanceRuConnector: FreelanceRuConnector;

  constructor(webExtraction: WebExtractionService) {
    this.genericPublicWebConnector = new GenericPublicWebConnector(webExtraction);
    this.freelanceRuConnector = new FreelanceRuConnector(webExtraction);
    this.connectors = new Map<string, Connector>([
      ['hh', new HhConnector()],
      ['habr', new HabrConnector(webExtraction)],
      ['weworkremotely', new WeWorkRemotelyConnector(webExtraction)],
      ['superjob', new PublicApiFeedConnector('superjob')],
      ['trudvsem', new PublicApiFeedConnector('trudvsem')],
      ['freelancehunt', new PublicApiFeedConnector('freelancehunt')],
      ['remoteok', new PublicApiFeedConnector('remoteok')],
      ['remotive', new PublicApiFeedConnector('remotive')],
      ['adzuna', new PublicApiFeedConnector('adzuna')],
      ['hackernews_whoishiring', new PublicApiFeedConnector('hackernews_whoishiring')],
      ['getmatch', new GetmatchConnector()],
      ['arc', new ArcConnector(webExtraction)],
      ['workingnomads', new WorkingNomadsConnector()],
      ['finder_work', new FinderWorkConnector(webExtraction)],
      ['budu', new BuduConnector(undefined, webExtraction)],
      ['builtin', new BuiltinConnector(webExtraction)],
      ['gderabota', new GdeRabotaConnector(webExtraction)],
      ['rabota_ru', new RabotaRuConnector(webExtraction)],
      ['yc_jobs', new YcJobsConnector(webExtraction)],
      ['weblancer', new WeblancerConnector(webExtraction)],
      ['kwork', new KworkConnector(webExtraction)],
      ['greenhouse', new AtsPublicBoardConnector('greenhouse', webExtraction)],
      ['lever', new AtsPublicBoardConnector('lever', webExtraction)],
      ['ashby', new AtsPublicBoardConnector('ashby', webExtraction)],
      ['personio', new AtsPublicBoardConnector('personio', webExtraction)],
      ['workday', new WorkdayConnector(webExtraction)],
      ['workspace', new WorkspaceConnector(webExtraction)],
      ['roseltorg', new RoseltorgConnector(webExtraction)],
      ['fabrikant', new FabrikantConnector(webExtraction)],
      ['b2b_center', new B2bCenterConnector(webExtraction)],
      ['workable', new AuthenticatedAtsConnector('workable')],
      ['upwork', new AuthenticatedMarketplaceConnector('upwork')],
      ['freelancer_com', new AuthenticatedMarketplaceConnector('freelancer_com')],
    ]);
  }

  get(source: Source): Connector {
    if (source.connectorFamily === 'TelegramMtproto') return this.telegramConnector;
    if (source.connectorFamily === 'VkWall') return this.vkConnector;
    if (source.connectorFamily === 'PublicHtml' && source._id === 'freelance_ru') return this.freelanceRuConnector;
    if (source.connectorFamily === 'PublicHtml' && ['getmatch', 'arc', 'workingnomads', 'finder_work', 'budu', 'builtin', 'gderabota', 'rabota_ru', 'yc_jobs', 'weblancer', 'kwork', 'weworkremotely', 'workspace'].includes(source._id)) return this.connectors.get(source._id)!;
    if (source.connectorFamily === 'TenderPlatform' && source._id === 'roseltorg') return this.connectors.get(source._id)!;
    if (source.connectorFamily === 'TenderPlatform' && source._id === 'fabrikant') return this.connectors.get(source._id)!;
    if (source.connectorFamily === 'TenderPlatform' && source._id === 'b2b_center') return this.connectors.get(source._id)!;
    if (source.connectorFamily === 'PublicHtml' || source.connectorFamily === 'TenderPlatform') {
      return this.genericPublicWebConnector;
    }
    return (
      this.connectors.get(source._id) ??
      new UnavailableConnector({
        id: source._id,
        family: source.connectorFamily,
        reason: source.unavailableReason ?? `Connector ${source.connectorFamily} for ${source._id} is not implemented yet`,
        requiresCredentials: Boolean(source.authCredentialRef),
      })
    );
  }
}
