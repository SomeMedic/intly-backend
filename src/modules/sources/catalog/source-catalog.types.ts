import { OpportunityType } from '../../opportunities/schemas/opportunity.schema';

export const SOURCE_GROUPS = ['web', 'telegram', 'vk'] as const;
export type SourceGroup = (typeof SOURCE_GROUPS)[number];

export const CONNECTOR_FAMILIES = [
  'OfficialRestApi',
  'OfficialFeed',
  'AtsPublicBoard',
  'AtsAuthenticated',
  'PublicHtml',
  'AuthenticatedMarketplace',
  'TelegramMtproto',
  'VkWall',
  'TenderPlatform',
] as const;
export type ConnectorFamily = (typeof CONNECTOR_FAMILIES)[number];

export const SOURCE_DEFAULT_STATES = ['Enabled', 'Experimental', 'Conditional', 'Disabled'] as const;
export type SourceDefaultState = (typeof SOURCE_DEFAULT_STATES)[number];

export const SOURCE_RUNTIME_STATES = [
  'Enabled',
  'Disabled',
  'Experimental',
  'Conditional',
  'Maintenance',
] as const;
export type SourceRuntimeState = (typeof SOURCE_RUNTIME_STATES)[number];

export const SOURCE_HEALTH_STATES = ['Healthy', 'Degraded', 'Failed', 'Disabled', 'Unknown', 'Maintenance'] as const;
export type SourceHealthState = (typeof SOURCE_HEALTH_STATES)[number];

export type SourceEndpoint = {
  baseUrl?: string;
  apiUrl?: string;
  handle?: string;
  domain?: string;
  evidenceUrl?: string;
};

export type SourcePolicy = {
  confidence: 'High' | 'Medium' | 'Low' | 'Medium-Low' | 'Low-Medium' | 'Medium-High' | 'Conditional';
  researchDate: string;
  complianceNote: string;
  runtimeVerificationRequired: boolean;
};

export type SourceCatalogEntry = {
  id: string;
  name: string;
  group: SourceGroup;
  category: string;
  opportunityTypes: OpportunityType[];
  connectorFamily: ConnectorFamily;
  defaultState: SourceDefaultState;
  defaultEnabled: boolean;
  defaultIntervalSeconds: number;
  defaultTimeoutMs: number;
  endpoint: SourceEndpoint;
  parserVersion: string;
  normalizationProfile: string;
  refreshPolicy: string;
  checkpointStrategy: string;
  authCredentialRef?: string;
  proxyPoolEnabled: boolean;
  dedupPriority: number;
  sourceRole?: string;
  policy: SourcePolicy;
  unavailableReason?: string;
};
