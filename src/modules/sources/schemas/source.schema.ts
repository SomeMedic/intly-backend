import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { schemaOptions } from '../../../common/schema';
import {
  CONNECTOR_FAMILIES,
  ConnectorFamily,
  SOURCE_GROUPS,
  SOURCE_HEALTH_STATES,
  SOURCE_RUNTIME_STATES,
  SourceGroup,
  SourceHealthState,
  SourceRuntimeState,
} from '../catalog/source-catalog.types';
import { OPPORTUNITY_TYPES, OpportunityType } from '../../opportunities/schemas/opportunity.schema';

export type SourceDocument = HydratedDocument<Source>;

@Schema(schemaOptions)
export class Source {
  @Prop({ type: String })
  _id!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, enum: SOURCE_GROUPS, required: true, index: true })
  group!: SourceGroup;

  @Prop({ type: String, required: true })
  category!: string;

  @Prop({ type: [String], enum: OPPORTUNITY_TYPES, default: [], index: true })
  opportunityTypes!: OpportunityType[];

  @Prop({ type: String, enum: CONNECTOR_FAMILIES, required: true, index: true })
  connectorFamily!: ConnectorFamily;

  @Prop({ type: String, enum: SOURCE_RUNTIME_STATES, default: 'Disabled', index: true })
  runtimeState!: SourceRuntimeState;

  @Prop({ type: Boolean, default: false, index: true })
  enabled!: boolean;

  @Prop({ type: Number, required: true, min: 30 })
  intervalSeconds!: number;

  @Prop({ type: Number, required: true, min: 1000 })
  timeoutMs!: number;

  @Prop({ type: Object, default: {} })
  endpoint!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  config!: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  limits!: Record<string, unknown>;

  @Prop({ type: String })
  authCredentialRef?: string;

  @Prop({ type: String })
  credentialsEncrypted?: string;

  @Prop({ type: String })
  credentialsPreview?: string;

  @Prop({ type: Boolean, default: false })
  proxyPoolEnabled!: boolean;

  @Prop({ type: String, required: true })
  parserVersion!: string;

  @Prop({ type: String, required: true })
  normalizationProfile!: string;

  @Prop({ type: String, required: true })
  refreshPolicy!: string;

  @Prop({ type: Object, default: {} })
  checkpoint!: Record<string, unknown>;

  @Prop({ type: String, required: true })
  checkpointStrategy!: string;

  @Prop({ type: String, enum: SOURCE_HEALTH_STATES, default: 'Unknown', index: true })
  healthState!: SourceHealthState;

  @Prop({ type: String })
  healthMessage?: string;

  @Prop({ type: Date })
  lastHealthCheckAt?: Date;

  @Prop({ type: String, enum: SOURCE_HEALTH_STATES })
  lastHealthCheckState?: SourceHealthState;

  @Prop({ type: String })
  lastHealthCheckMessage?: string;

  @Prop({ type: Date })
  lastSuccessAt?: Date;

  @Prop({ type: Date })
  lastFailureAt?: Date;

  @Prop({ type: String })
  lastError?: string;

  @Prop({ type: Number, default: 0 })
  dedupPriority!: number;

  @Prop({ type: String })
  sourceRole?: string;

  @Prop({ type: Object, default: {} })
  policy!: Record<string, unknown>;

  @Prop({ type: String })
  unavailableReason?: string;

  @Prop({ type: String })
  updatedByUserId?: string;
}

export const SourceSchema = SchemaFactory.createForClass(Source);

SourceSchema.index({ group: 1, enabled: 1, runtimeState: 1 });
SourceSchema.index({ connectorFamily: 1, enabled: 1 });
SourceSchema.index({ healthState: 1, updatedAt: -1 });
