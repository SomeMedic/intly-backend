import { FetchContext, FetchPage, RawOpportunityRecord } from './connector.types';

export type HnHiringComment = Record<string, unknown> & { id: number; text: string; time: number; parent: number };
type ThreadSnapshot = { id: number; commentIds: number[] };
type HiringState = {
  version: 2;
  hasMore: true;
  page: number;
  phase: 'discover' | 'comments';
  perPage: number;
  modifiedFrom: string;
  modifiedTo: string;
  submittedIds: number[];
  submissionOffset: number;
  threads: ThreadSnapshot[];
  threadOffset: number;
  commentOffset: number;
  observedCommentCount: number;
  processedCommentCount: number;
  acceptedCommentCount: number;
  excludedByWindowCount: number;
  unavailableItemCount: number;
  unavailableCommentCount: number;
};
type HiringApi = {
  profile: () => Promise<unknown>;
  item: (id: number) => Promise<unknown>;
  record: (item: HnHiringComment, threadId: number) => RawOpportunityRecord;
};

const DAY_MS = 86_400_000;
function fail(message: string): never { throw new Error(`hackernews_whoishiring ${message}`); }
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const integer = (value: unknown, name: string, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(`${name} is malformed`);
  return value as number;
};
const ids = (value: unknown, name: string): number[] => {
  if (!Array.isArray(value)) fail(`${name} is malformed`);
  const result = (value as unknown[]).map(value => integer(value, `${name} id`, 1));
  if (new Set(result).size !== result.length) fail(`${name} contains duplicate ids`);
  return result;
};
const timestamp = (value: unknown, name: string): number => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${name} is malformed`);
  return Date.parse(value as string);
};

function nativeItem(value: unknown, requestedId: number): Record<string, unknown> | null {
  if (value === null) return null;
  const item = object(value);
  if (!item || integer(item.id, 'item id', 1) !== requestedId) fail(`item id does not match requested id ${requestedId}`);
  for (const field of ['deleted', 'dead']) {
    if (item[field] !== undefined && typeof item[field] !== 'boolean') fail(`item ${requestedId} ${field} is malformed`);
  }
  if (item.deleted === true || item.dead === true) return null;
  if (!['story', 'comment', 'job', 'poll', 'pollopt'].includes(String(item.type))) fail(`item ${requestedId} type is malformed`);
  return item;
}

async function boundedMap<T, R>(values: T[], signal: AbortSignal | undefined, fn: (value: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let offset = 0; offset < values.length; offset += 4) {
    signal?.throwIfAborted();
    const batch = await Promise.all(values.slice(offset, offset + 4).map(fn));
    signal?.throwIfAborted();
    output.push(...batch);
  }
  return output;
}

function continuingState(ctx: FetchContext, perPage: number): HiringState {
  const checkpoint = ctx.checkpoint;
  if (checkpoint.version !== 2) fail('active checkpoint version is unsupported; an explicit fresh run is required');
  const state = structuredClone(checkpoint) as unknown as HiringState;
  integer(state.page, 'checkpoint page', 1);
  if (ctx.page !== undefined && ctx.page !== state.page) fail('checkpoint page does not match requested page');
  if (state.perPage !== perPage) fail('checkpoint perPage changed during collection');
  const from = timestamp(state.modifiedFrom, 'checkpoint modifiedFrom');
  const to = timestamp(state.modifiedTo, 'checkpoint modifiedTo');
  if (to < from || to - from > 30 * DAY_MS || to > Date.now()) fail('checkpoint window is malformed');
  if (ctx.backfillSince !== undefined && Date.parse(ctx.backfillSince) !== from) fail('checkpoint lower window changed during collection');
  state.submittedIds = ids(state.submittedIds, 'checkpoint submittedIds');
  integer(state.submissionOffset, 'checkpoint submissionOffset');
  if (state.submissionOffset > state.submittedIds.length || !Array.isArray(state.threads)) fail('checkpoint discovery cursor is malformed');
  const scanned = new Set(state.submittedIds.slice(0, state.submissionOffset));
  const threadIds = new Set<number>();
  const commentIds = new Set<number>();
  let observed = 0;
  state.threads = state.threads.map(value => {
    const thread = object(value);
    if (!thread) fail('checkpoint thread is malformed');
    const id = integer(thread.id, 'checkpoint thread id', 1);
    if (!scanned.has(id) || threadIds.has(id)) fail('checkpoint thread is not a unique scanned submission');
    threadIds.add(id);
    const children = ids(thread.commentIds, 'checkpoint commentIds');
    for (const child of children) {
      if (child === id || commentIds.has(child)) fail('checkpoint contains duplicate or cyclic comment ids');
      commentIds.add(child);
    }
    observed += children.length;
    return { id, commentIds: children };
  });
  for (const field of ['threadOffset', 'commentOffset', 'observedCommentCount', 'processedCommentCount', 'acceptedCommentCount', 'excludedByWindowCount', 'unavailableItemCount', 'unavailableCommentCount'] as const) integer(state[field], `checkpoint ${field}`);
  if (state.observedCommentCount !== observed || state.unavailableCommentCount > state.unavailableItemCount || state.processedCommentCount !== state.acceptedCommentCount + state.excludedByWindowCount + state.unavailableCommentCount) fail('checkpoint coverage counts are inconsistent');
  if (state.phase === 'discover') {
    if (state.submissionOffset >= state.submittedIds.length || state.threadOffset !== 0 || state.commentOffset !== 0 || state.processedCommentCount !== 0) fail('checkpoint discovery cursor is malformed');
  } else if (state.phase === 'comments') {
    if (state.submissionOffset !== state.submittedIds.length || state.threadOffset >= state.threads.length || state.commentOffset >= state.threads[state.threadOffset].commentIds.length) fail('checkpoint comment cursor is malformed');
    const processed = state.threads.slice(0, state.threadOffset).reduce((sum, thread) => sum + thread.commentIds.length, 0) + state.commentOffset;
    if (processed !== state.processedCommentCount) fail('checkpoint comment cursor does not match coverage counts');
  } else fail('checkpoint phase is malformed');
  return state;
}

function advanceEmptyThreads(state: HiringState): void {
  while (state.threadOffset < state.threads.length && state.commentOffset === state.threads[state.threadOffset].commentIds.length) {
    state.threadOffset++;
    state.commentOffset = 0;
  }
}

function result(state: HiringState, records: RawOpportunityRecord[], seen: number): FetchPage {
  const complete = state.phase === 'comments' && state.threadOffset === state.threads.length;
  const coverage = {
    submissionCount: state.submittedIds.length,
    scannedSubmissionCount: state.submissionOffset,
    threadCount: state.threads.length,
    completedThreadCount: state.threadOffset,
    observedCommentCount: state.observedCommentCount,
    processedCommentCount: state.processedCommentCount,
    acceptedCommentCount: state.acceptedCommentCount,
    excludedByWindowCount: state.excludedByWindowCount,
    unavailableItemCount: state.unavailableItemCount,
    unavailableCommentCount: state.unavailableCommentCount,
    scope: 'all-observed-whoishiring-submissions-and-direct-comments',
    terminalReason: complete ? 'all-observed-submissions-and-direct-comments-exhausted' : undefined,
  };
  const page = complete ? 0 : state.page + 1;
  return {
    records,
    hasMore: !complete,
    nextPage: complete ? undefined : page,
    checkpoint: complete
      ? { version: 2, hasMore: false, page, phase: 'complete', perPage: state.perPage, modifiedFrom: state.modifiedFrom, modifiedTo: state.modifiedTo, coverage, lastFetchedAt: new Date().toISOString() }
      : { ...state, page, coverage, lastFetchedAt: new Date().toISOString() },
    stats: { seen },
  };
}

/** Freeze observed membership, then inspect every direct comment without assuming date order. */
export async function fetchHackerNewsHiringPage(ctx: FetchContext, api: HiringApi): Promise<FetchPage> {
  ctx.signal?.throwIfAborted();
  if (ctx.checkpoint.hasMore !== undefined && typeof ctx.checkpoint.hasMore !== 'boolean') fail('checkpoint hasMore is malformed');
  if (ctx.checkpoint.hasMore === false && ctx.checkpoint.version === 2 && ctx.checkpoint.phase !== 'complete') fail('checkpoint hasMore contradicts collection phase');
  const perPage = Math.min(integer(ctx.source.limits?.perPage ?? 40, 'perPage', 1), 80);
  let state: HiringState;
  if (ctx.checkpoint.hasMore === true) state = continuingState(ctx, perPage);
  else {
    if (ctx.page !== undefined && ctx.page !== 0) fail('fresh collection must start at page zero');
    const days = Math.min(integer(ctx.backfillDays, 'backfillDays', 1), 30);
    const from = ctx.backfillSince === undefined ? Date.now() - days * DAY_MS : Date.parse(ctx.backfillSince);
    const to = Math.min(Date.now(), from + days * DAY_MS);
    if (!Number.isFinite(from) || from > to) fail('requested window is malformed');
    const profile = object(await api.profile());
    if (!profile || profile.id !== 'whoishiring') fail('user profile identity does not match whoishiring');
    const submittedIds = ids(profile.submitted, 'submitted ids');
    if (!submittedIds.length) fail('discovery returned no submitted story ids');
    state = { version: 2, hasMore: true, page: 0, phase: 'discover', perPage,
      modifiedFrom: new Date(from).toISOString(), modifiedTo: new Date(to).toISOString(),
      submittedIds, submissionOffset: 0, threads: [], threadOffset: 0, commentOffset: 0,
      observedCommentCount: 0, processedCommentCount: 0, acceptedCommentCount: 0,
      excludedByWindowCount: 0, unavailableItemCount: 0, unavailableCommentCount: 0 };
  }
  if (state.phase === 'discover') {
    const submissions = state.submittedIds.slice(state.submissionOffset, state.submissionOffset + perPage);
    const candidates = await boundedMap(submissions, ctx.signal, async id => nativeItem(await api.item(id), id));
    const seenComments = new Set(state.threads.flatMap(thread => thread.commentIds));
    for (const item of candidates) {
      if (!item) { state.unavailableItemCount++; continue; }
      if (item.type !== 'story' || typeof item.title !== 'string' || !/^ask hn:\s*who is hiring\b/i.test(item.title) || item.by !== 'whoishiring') continue;
      integer(item.time, `thread ${item.id} time`, 1);
      const commentIds = item.kids === undefined ? [] : ids(item.kids, `thread ${item.id} kids`);
      for (const id of commentIds) {
        if (id === item.id || seenComments.has(id)) fail('native threads contain duplicate or cyclic comment ids');
        seenComments.add(id);
      }
      state.threads.push({ id: item.id as number, commentIds });
      state.observedCommentCount += commentIds.length;
    }
    state.submissionOffset += submissions.length;
    if (state.submissionOffset === state.submittedIds.length) {
      if (!state.threads.length) fail('found no valid Who Is Hiring threads in observed submissions');
      state.phase = 'comments';
      advanceEmptyThreads(state);
    }
    return result(state, [], 0);
  }
  const refs: Array<{ id: number; threadId: number }> = [];
  for (let threadIndex = state.threadOffset, offset = state.commentOffset; threadIndex < state.threads.length && refs.length < perPage; threadIndex++, offset = 0) {
    const thread = state.threads[threadIndex];
    refs.push(...thread.commentIds.slice(offset, offset + perPage - refs.length).map(id => ({ id, threadId: thread.id })));
  }
  const comments = await boundedMap(refs, ctx.signal, async ref => ({ ref, item: nativeItem(await api.item(ref.id), ref.id) }));
  const records: RawOpportunityRecord[] = [];
  const from = Date.parse(state.modifiedFrom);
  const to = Date.parse(state.modifiedTo);
  for (const { item, ref } of comments) {
    if (!item) { state.unavailableItemCount++; state.unavailableCommentCount++; }
    else {
      if (item.type !== 'comment' || item.parent !== ref.threadId) fail(`comment ${ref.id} type or parent does not match its thread`);
      if (item.text === undefined || item.text === null || (typeof item.text === 'string' && !item.text.trim())) { state.unavailableItemCount++; state.unavailableCommentCount++; }
      else if (typeof item.text !== 'string') fail(`comment ${ref.id} text is malformed`);
      else {
        const published = integer(item.time, `comment ${ref.id} time`, 1) * 1000;
        if (published >= from && published <= to) {
          records.push(api.record(item as HnHiringComment, ref.threadId));
          state.acceptedCommentCount++;
        } else state.excludedByWindowCount++;
      }
    }
    state.processedCommentCount++;
    state.commentOffset++;
    advanceEmptyThreads(state);
  }
  return result(state, records, refs.length);
}
