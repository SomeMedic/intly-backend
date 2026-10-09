import type { PipelineStage } from 'mongoose';

import type { AiProvider, AiTaskType } from './schemas/ai-config.schema';

export type AiUsageFilters = {
  dateFrom?: string;
  dateTo?: string;
  userId?: string;
  provider?: AiProvider;
  modelId?: string;
  taskType?: AiTaskType;
  status?: 'completed' | 'failed' | 'cancelled';
};

export const emptyAiUsageSummary = {
  runs: 0, completed: 0, failed: 0, cancelled: 0,
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  estimatedCost: null, costKnownRuns: 0, costUnknownRuns: 0,
  avgLatencyMs: null, latencySamples: 0, errorRate: null,
};

export const emptyAiCallSummary = {
  calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
  estimatedCost: null, costKnownCalls: 0, costUnknownCalls: 0,
  avgLatencyMs: null, latencySamples: 0,
};

const validNumber = (path: string) => ({ $and: [{ $isNumber: path }, { $gte: [path, 0] }] });
const tokenValue = (path: string) => ({ $cond: [validNumber(path), path, 0] });

const sums = {
  runs: { $sum: 1 },
  inputTokens: { $sum: '$metrics.inputTokens' },
  outputTokens: { $sum: '$metrics.outputTokens' },
  totalTokens: { $sum: '$metrics.totalTokens' },
  estimatedCost: { $sum: '$metrics.cost' },
  costKnownRuns: { $sum: { $cond: [{ $ne: ['$metrics.cost', null] }, 1, 0] } },
  costUnknownRuns: { $sum: { $cond: [{ $eq: ['$metrics.cost', null] }, 1, 0] } },
  avgLatencyMs: { $avg: '$metrics.latencyMs' },
  latencySamples: { $sum: { $cond: [{ $ne: ['$metrics.latencyMs', null] }, 1, 0] } },
};

const knownCost = { $set: { estimatedCost: { $cond: [{ $gt: ['$costKnownRuns', 0] }, '$estimatedCost', null] } } };
const userLookup = (localField: string) => ({ $lookup: {
  from: 'users', localField, foreignField: '_id',
  pipeline: [{ $project: { _id: 0, name: 1, email: 1 } }], as: 'user',
} });

const callSums = {
  calls: { $sum: 1 },
  inputTokens: sums.inputTokens, outputTokens: sums.outputTokens, totalTokens: sums.totalTokens,
  estimatedCost: sums.estimatedCost,
  costKnownCalls: sums.costKnownRuns, costUnknownCalls: sums.costUnknownRuns,
  avgLatencyMs: sums.avgLatencyMs, latencySamples: sums.latencySamples,
};
const knownCallCost = { $set: { estimatedCost: { $cond: [{ $gt: ['$costKnownCalls', 0] }, '$estimatedCost', null] } } };

/** A single snapshot supplies every aggregate. User choices intentionally ignore
 * the selected user so that selecting one never hides the other choices. */
export function buildAiUsagePipeline(filters: AiUsageFilters = {}): PipelineStage[] {
  const match: Record<string, unknown> = { status: filters.status ?? { $in: ['completed', 'failed', 'cancelled'] } };
  if (filters.taskType) match.taskType = filters.taskType;
  if (filters.dateFrom || filters.dateTo) {
    match.createdAt = {
      ...(filters.dateFrom ? { $gte: new Date(filters.dateFrom) } : {}),
      ...(filters.dateTo ? { $lt: new Date(filters.dateTo) } : {}),
    };
  }
  const selectedUser = filters.userId ? [{ $match: { userId: filters.userId } }] : [];
  const routeFilter = Object.fromEntries(['provider', 'modelId'].filter((key) => filters[key as keyof AiUsageFilters]).map((key) => [key, filters[key as keyof AiUsageFilters]]));
  const selectedRoute = Object.keys(routeFilter).length ? [{ $match: routeFilter }] : [];
  const callFilter = Object.fromEntries(Object.entries(routeFilter).map(([key, value]) => [`attempts.${key}`, value]));
  const calls = [
    ...selectedUser,
    { $unwind: '$attempts' },
    ...(Object.keys(callFilter).length ? [{ $match: callFilter }] : []),
    { $project: {
      userId: 1, taskType: 1, provider: '$attempts.provider', modelId: '$attempts.modelId', status: '$attempts.status',
      lastOccurredAt: { $convert: { input: { $ifNull: ['$attempts.completedAt', '$attempts.startedAt'] }, to: 'date', onError: null, onNull: null } },
      metrics: {
        inputTokens: tokenValue('$attempts.usage.inputTokens'),
        outputTokens: tokenValue('$attempts.usage.outputTokens'),
        totalTokens: { $cond: [validNumber('$attempts.usage.totalTokens'), '$attempts.usage.totalTokens', { $add: [tokenValue('$attempts.usage.inputTokens'), tokenValue('$attempts.usage.outputTokens')] }] },
        cost: { $cond: [validNumber('$attempts.usage.estimatedCost'), '$attempts.usage.estimatedCost', null] },
        latencyMs: { $let: {
          vars: {
            start: { $convert: { input: '$attempts.startedAt', to: 'date', onError: null, onNull: null } },
            end: { $convert: { input: '$attempts.completedAt', to: 'date', onError: null, onNull: null } },
          },
          in: { $cond: [{ $and: [{ $ne: ['$$start', null] }, { $ne: ['$$end', null] }, { $gte: ['$$end', '$$start'] }] }, { $subtract: ['$$end', '$$start'] }, null] },
        } },
      },
    } },
  ];
  return [
    { $match: match },
    { $project: {
      userId: 1, taskType: 1, provider: 1, modelId: 1, status: 1, errorCode: 1, completedAt: 1, attempts: 1,
      metrics: {
        inputTokens: tokenValue('$usage.inputTokens'),
        outputTokens: tokenValue('$usage.outputTokens'),
        totalTokens: { $cond: [validNumber('$usage.totalTokens'), '$usage.totalTokens', { $add: [tokenValue('$usage.inputTokens'), tokenValue('$usage.outputTokens')] }] },
        cost: { $cond: [validNumber('$usage.estimatedCost'), '$usage.estimatedCost', null] },
        latencyMs: { $cond: [{ $and: [
          { $eq: [{ $type: '$startedAt' }, 'date'] }, { $eq: [{ $type: '$completedAt' }, 'date'] },
          { $gte: ['$completedAt', '$startedAt'] },
        ] }, { $subtract: ['$completedAt', '$startedAt'] }, null] },
      },
    } },
    { $facet: {
      items: [
        ...selectedUser,
        ...selectedRoute,
        { $group: { _id: { userId: '$userId', taskType: '$taskType', provider: '$provider', modelId: '$modelId', status: '$status' }, ...sums } },
        knownCost,
        userLookup('_id.userId'),
        { $set: { user: { $arrayElemAt: ['$user', 0] } } },
        { $sort: { runs: -1, '_id.userId': 1, '_id.taskType': 1, '_id.provider': 1, '_id.modelId': 1, '_id.status': 1 } },
      ],
      summary: [
        ...selectedUser,
        ...selectedRoute,
        { $group: { _id: null, ...sums,
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        } },
        knownCost,
        { $set: { errorRate: { $cond: [{ $gt: [{ $add: ['$completed', '$failed'] }, 0] }, { $divide: ['$failed', { $add: ['$completed', '$failed'] }] }, null] } } },
        { $project: { _id: 0 } },
      ],
      users: [
        ...selectedRoute,
        { $group: { _id: '$userId' } },
        userLookup('_id'),
        { $project: { _id: 0, userId: '$_id', name: { $arrayElemAt: ['$user.name', 0] }, email: { $arrayElemAt: ['$user.email', 0] } } },
        { $sort: { name: 1, userId: 1 } },
      ],
      errors: [
        ...selectedUser,
        ...selectedRoute,
        { $match: { status: 'failed' } },
        { $sort: { completedAt: -1, _id: -1 } },
        { $group: {
          _id: { $ifNull: ['$errorCode', 'AI_RUN_FAILED'] }, runs: { $sum: 1 },
          lastOccurredAt: { $first: '$completedAt' }, lastRunId: { $first: '$_id' },
          userId: { $first: '$userId' }, taskType: { $first: '$taskType' },
          provider: { $first: '$provider' }, modelId: { $first: '$modelId' },
        } },
        { $set: { errorCode: '$_id' } },
        { $project: { _id: 0 } },
        { $sort: { runs: -1, errorCode: 1 } },
      ],
      callItems: [
        ...calls,
        { $sort: { lastOccurredAt: -1, _id: -1 } },
        { $group: { _id: { userId: '$userId', taskType: '$taskType', provider: '$provider', modelId: '$modelId', status: '$status' }, ...callSums,
          lastRunId: { $first: '$_id' }, lastOccurredAt: { $first: '$lastOccurredAt' },
        } },
        knownCallCost,
        userLookup('_id.userId'),
        { $set: { user: { $arrayElemAt: ['$user', 0] } } },
        { $sort: { calls: -1, '_id.userId': 1, '_id.provider': 1, '_id.modelId': 1, '_id.status': 1 } },
      ],
      callSummary: [
        ...calls,
        { $group: { _id: null, ...callSums } },
        knownCallCost,
        { $project: { _id: 0 } },
      ],
    } },
  ] as PipelineStage[];
}
