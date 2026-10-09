import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { access, readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
require('reflect-metadata');
require('ts-node/register/transpile-only');

const { MatchingService } = require('../src/modules/matching/matching.service.ts');
const { OpportunitiesService } = require('../src/modules/opportunities/opportunities.service.ts');
const { ProfilesService } = require('../src/modules/profiles/profiles.service.ts');
const { DEFAULT_MATCH_WEIGHTS } = require('../src/modules/profiles/schemas/profile.schema.ts');

describe('matching', () => {
  it('calculates a deterministic score from real opportunity and profile fields', () => {
    const service = new MatchingService();
    const result = service.calculate(
      {
        skills: ['TypeScript', 'NestJS'],
        technologies: ['MongoDB'],
        seniority: 'Senior',
        employmentType: 'Full-time',
        remoteType: 'remote',
        location: 'Russia',
        money: { max: 300000 },
        publishedAt: new Date(),
        sourceOccurrences: [{ sourceId: 'hh', externalId: '1', url: 'https://example.test/1' }],
      },
      {
        technologies: ['TypeScript', 'MongoDB'],
        seniority: ['Senior'],
        employmentTypes: ['Full-time'],
        remotePreferences: ['remote'],
        locations: ['Russia'],
        compensationPreferences: { min: 250000 },
        sourceIds: ['hh'],
        matchWeights: { skills: 35, seniority: 10, money: 15, remoteLocation: 15, employment: 10, freshness: 10, source: 5 },
      },
    );

    assert.equal(result.score, 100);
    assert.deepEqual(result.matchedSkills.sort(), ['MongoDB', 'TypeScript'].sort());
    assert.equal(result.components.money, 100);
  });
});

describe('opportunity ingestion', () => {
  it('upserts by source occurrence and retains raw payload on the occurrence', async () => {
    const repository = new InMemoryOpportunityRepository();
    const service = new OpportunitiesService(
      repository,
      {},
      {},
      {},
      {},
      new MatchingService(),
    );

    const first = await service.ingestOrUpsert({
      type: 'vacancy',
      title: 'Backend Engineer',
      sourceId: 'hh',
      externalId: 'vacancy-1',
      url: 'https://example.test/jobs/1',
      rawPayload: { original: true },
    });
    const second = await service.ingestOrUpsert({
      type: 'vacancy',
      title: 'Backend Engineer Updated',
      sourceId: 'hh',
      externalId: 'vacancy-1',
      url: 'https://example.test/jobs/1',
      rawPayload: { original: false, updated: true },
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.occurrenceAdded, false);
    assert.equal(repository.records.length, 1);
    assert.equal(second.opportunity.title, 'Backend Engineer Updated');
    assert.deepEqual(second.opportunity.sourceOccurrences[0].rawPayload, { original: false, updated: true });
    assert.equal(second.opportunity.firstSeenAt.getTime(), first.opportunity.firstSeenAt.getTime());
  });

  it('enqueues real ingestion match jobs when jobs service is available', async () => {
    const jobs = new InMemoryJobsService();
    const service = new OpportunitiesService(
      new InMemoryOpportunityRepository(),
      {},
      {},
      {},
      {},
      new MatchingService(),
      jobs,
    );

    await service.ingestOrUpsert({
      type: 'vacancy',
      title: 'Backend Engineer',
      sourceId: 'hh',
      sourceRunId: 'run-historical',
      sourceRunEffectMode: 'historical',
      externalId: 'vacancy-2',
      url: 'https://example.test/jobs/2',
    });

    assert.deepEqual(jobs.enqueued.map((job) => [job.queue, job.name]), [
      ['analytics', 'ingestion_match_all'],
      ['search', 'index-opportunity'],
    ]);
    assert.equal(jobs.enqueued[0].data.sourceRunId, 'run-historical');
    assert.equal(jobs.enqueued[0].data.effectMode, 'historical');
    assert.equal(jobs.enqueued[0].data.sourceId, 'hh');
  });

  it('passes persisted historical source metadata to legacy ingestion match jobs', async () => {
    const repository = new InMemoryOpportunityRepository();
    repository.records.push({
      _id: 'opp-historical',
      type: 'vacancy',
      title: 'Historical',
      companyOrClient: '',
      description: '',
      sourceStatus: 'Active',
      sourceOccurrences: [{ sourceId: 'hh', sourceMetadata: { sourceRunId: 'run-1', sourceRunEffectMode: 'historical' } }],
      technologies: [],
      skills: [],
      canonicalTags: [],
    });
    const jobs = new InMemoryJobsService();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Profile' });
    const watchlists = { contexts: [], async evaluateOpportunity(_opportunity, context) { this.contexts.push(context); return { evaluated: 1, hits: 1, autoAiQueued: 0 }; } };
    const moduleRef = { get: () => watchlists };
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService(), jobs, moduleRef);
    service.onModuleInit();

    await jobs.run('analytics', 'ingestion_match_all', { opportunityId: 'opp-historical' });

    assert.equal(states.records.length, 1);
    assert.equal(watchlists.contexts[0].effectMode, 'historical');
  });

  it('does not suppress legacy ingestion match jobs that only have a source run id', async () => {
    const repository = new InMemoryOpportunityRepository();
    repository.records.push({
      _id: 'opp-legacy',
      type: 'vacancy',
      title: 'Legacy',
      companyOrClient: '',
      description: '',
      sourceStatus: 'Active',
      sourceOccurrences: [{ sourceId: 'hh', sourceMetadata: { sourceRunId: 'run-legacy' } }],
      technologies: [],
      skills: [],
      canonicalTags: [],
    });
    const jobs = new InMemoryJobsService();
    const watchlists = { contexts: [], async evaluateOpportunity(_opportunity, context) { this.contexts.push(context); return { evaluated: 1, hits: 1, autoAiQueued: 0 }; } };
    const service = new OpportunitiesService(
      repository,
      new InMemoryStateRepository(),
      {},
      {},
      new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Profile' }),
      new MatchingService(),
      jobs,
      { get: () => watchlists },
    );
    service.onModuleInit();

    await jobs.run('analytics', 'ingestion_match_all', { opportunityId: 'opp-legacy' });

    assert.equal(watchlists.contexts[0].effectMode, undefined);
  });

  it('imports opportunities from an owned JSON file and reports skipped rows', async () => {
    const repository = new InMemoryOpportunityRepository();
    const files = new InMemoryFilesService([
      { type: 'vacancy', title: 'Imported Backend', sourceId: 'hh', externalId: 'file-1', url: 'https://example.test/file/1' },
      { type: 'vacancy', sourceId: 'hh', externalId: 'file-2', url: 'https://example.test/file/2' },
    ]);
    const service = new OpportunitiesService(repository, {}, {}, {}, {}, new MatchingService(), undefined, undefined, files);

    const result = await service.importFile({ id: 'user-1', email: 'u@example.test', role: 'User' }, { fileId: '6f9031c2-3601-4715-901f-b352131b795f' });

    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
    assert.equal(repository.records[0].title, 'Imported Backend');
    assert.equal(repository.records[0].sourceOccurrences[0].sourceMetadata.importFileId, '6f9031c2-3601-4715-901f-b352131b795f');
  });

  it('exports safe JSON without source raw payload or private notes', async () => {
    const repository = new InMemoryOpportunityRepository();
    const service = new OpportunitiesService(repository, new InMemoryStateRepository(), {}, {}, new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned' }), new MatchingService());
    await service.ingestOrUpsert({
      type: 'vacancy',
      title: 'Exported Backend',
      sourceId: 'hh',
      externalId: 'export-1',
      url: 'https://example.test/export/1',
      rawPayload: { secret: true },
    });

    const result = await service.export({ id: 'user-1', email: 'u@example.test', role: 'User' }, { format: 'json', scope: 'filtered', query: { archive: false } });
    const decoded = JSON.parse(Buffer.from(result.contentBase64, 'base64').toString('utf8'));

    assert.equal(decoded.items[0].title, 'Exported Backend');
    assert.equal(JSON.stringify(decoded).includes('rawPayload'), false);
    assert.equal(JSON.stringify(decoded).includes('notes'), false);
  });

  it('exports filtered opportunities through owned private state restrictions', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned', isActive: true });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    const first = await service.ingestOrUpsert({
      type: 'vacancy',
      title: 'Favorite Backend',
      sourceId: 'hh',
      externalId: 'filtered-1',
      url: 'https://example.test/filtered/1',
    });
    const second = await service.ingestOrUpsert({
      type: 'vacancy',
      title: 'Ignored Backend',
      sourceId: 'hh',
      externalId: 'filtered-2',
      url: 'https://example.test/filtered/2',
    });
    await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: first.opportunity._id, favorite: true, hidden: false, archived: false, tags: ['priority'], pipelineStatus: 'Shortlisted', matchScore: 91 });
    await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: second.opportunity._id, favorite: false, hidden: false, archived: false, tags: [], pipelineStatus: 'New', matchScore: 64 });
    await states.upsert({ userId: 'other-user', profileId: 'profile-foreign', opportunityId: second.opportunity._id, favorite: true, hidden: false, archived: false, tags: ['priority'], pipelineStatus: 'Shortlisted', matchScore: 100 });

    const result = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'filtered', query: { favorite: true, profileId: 'profile-1' }, includePersonalData: true },
    );
    const decoded = JSON.parse(Buffer.from(result.contentBase64, 'base64').toString('utf8'));

    assert.deepEqual(decoded.items.map((item) => item.id), [first.opportunity._id]);
    assert.equal(decoded.items[0].pipelineStatus, 'Shortlisted');
    assert.equal(decoded.items[0].matchScore, 91);
    assert.deepEqual(states.lastFindMatching, {
      userId: 'user-1',
      query: { profileId: 'profile-1', favorite: true, hidden: undefined, archived: undefined, minMatch: undefined, tags: undefined },
    });
  });


  it('lists trackedOnly opportunities across all owned profiles without active-profile fallback', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-active', userId: 'user-1', name: 'Active', isActive: true });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    const tracked = await service.ingestOrUpsert({ type: 'vacancy', title: 'Tracked', sourceId: 'hh', externalId: 'tracked-only-1', url: 'https://example.test/tracked-only/1' });
    await service.ingestOrUpsert({ type: 'vacancy', title: 'Untracked', sourceId: 'hh', externalId: 'tracked-only-2', url: 'https://example.test/tracked-only/2' });
    await states.upsert({ userId: 'user-1', profileId: 'profile-a', opportunityId: tracked.opportunity._id, pipelineStatus: 'Applied' });
    await states.upsert({ userId: 'user-1', profileId: 'profile-b', opportunityId: tracked.opportunity._id, pipelineStatus: 'Interview' });

    const page = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { trackedOnly: true, profileScope: 'all' });

    assert.deepEqual(page.items.map((item) => item.id), [tracked.opportunity._id]);
    assert.equal(states.lastFindMatching.query.profileId, undefined);
  });

  it('filters current and reached pipeline stages with canonical opportunity type aware legacy mapping', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned', isActive: true });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    const vacancyWon = await service.ingestOrUpsert({ type: 'vacancy', title: 'Legacy Vacancy Win', sourceId: 'hh', externalId: 'legacy-vacancy-won', url: 'https://example.test/legacy/vacancy' });
    const tenderWon = await service.ingestOrUpsert({ type: 'tender', title: 'Tender Win', sourceId: 'zakupki', externalId: 'legacy-tender-won', url: 'https://example.test/legacy/tender' });
    const freelanceInterview = await service.ingestOrUpsert({ type: 'freelance', title: 'Legacy Freelance Interview', sourceId: 'fl', externalId: 'legacy-freelance-interview', url: 'https://example.test/legacy/freelance' });
    const shortlisted = await service.ingestOrUpsert({ type: 'vacancy', title: 'Legacy Shortlisted', sourceId: 'hh', externalId: 'legacy-shortlisted', url: 'https://example.test/legacy/shortlisted' });
    await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: vacancyWon.opportunity._id, pipelineStatus: 'Won', pipelineEvents: [{ status: 'Won', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }] });
    await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: tenderWon.opportunity._id, pipelineStatus: 'Won', pipelineEvents: [{ status: 'Won', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }] });
    await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: freelanceInterview.opportunity._id, pipelineStatus: 'Interview', pipelineEvents: [{ status: 'Interview', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }] });
    await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: shortlisted.opportunity._id, pipelineStatus: 'Shortlisted', pipelineEvents: [{ status: 'Shortlisted', firstReachedAt: new Date('2026-10-01T00:00:00.000Z') }] });

    const offerPage = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', pipelineStatuses: ['Offer'] });
    const wonPage = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', pipelineStatuses: ['Won'] });
    const negotiationReached = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', pipelineReachedStatuses: ['Negotiation'] });
    const interestedReached = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', pipelineReachedStatuses: ['Interested'] });

    assert.deepEqual(offerPage.items.map((item) => item.id), [vacancyWon.opportunity._id]);
    assert.deepEqual(wonPage.items.map((item) => item.id), [tenderWon.opportunity._id]);
    assert.deepEqual(negotiationReached.items.map((item) => item.id), [freelanceInterview.opportunity._id]);
    assert.deepEqual(interestedReached.items.map((item) => item.id), [shortlisted.opportunity._id]);
  });

  it('keeps selected export id order while applying private state restrictions', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned', isActive: true });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    const first = await service.ingestOrUpsert({ type: 'vacancy', title: 'First', sourceId: 'hh', externalId: 'ordered-1', url: 'https://example.test/ordered/1' });
    const second = await service.ingestOrUpsert({ type: 'vacancy', title: 'Second', sourceId: 'hh', externalId: 'ordered-2', url: 'https://example.test/ordered/2' });
    const third = await service.ingestOrUpsert({ type: 'vacancy', title: 'Third', sourceId: 'hh', externalId: 'ordered-3', url: 'https://example.test/ordered/3' });
    await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: first.opportunity._id, favorite: true, hidden: false, archived: false, tags: [], pipelineStatus: 'Shortlisted', matchScore: 88 });
    await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: second.opportunity._id, favorite: false, hidden: false, archived: false, tags: [], pipelineStatus: 'New', matchScore: 52 });
    await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: third.opportunity._id, favorite: true, hidden: false, archived: false, tags: [], pipelineStatus: 'Interviewing', matchScore: 93 });

    const result = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'selected', ids: [third.opportunity._id, first.opportunity._id, second.opportunity._id], query: { favorite: true, profileId: 'profile-1' } },
    );
    const decoded = JSON.parse(Buffer.from(result.contentBase64, 'base64').toString('utf8'));

    assert.deepEqual(decoded.items.map((item) => item.id), [third.opportunity._id, first.opportunity._id]);
    assert.equal(result.count, 2);
    assert.equal(result.skipped, 1);
  });

  it('sorts non-private filtered exports by money and deadline query order', async () => {
    const repository = new InMemoryOpportunityRepository();
    const service = new OpportunitiesService(repository, new InMemoryStateRepository(), {}, {}, new InMemoryProfilesRepository(null), new MatchingService());
    const seed = async (externalId, title, moneyMax, deadline, firstSeenAt) => {
      const ingested = await service.ingestOrUpsert({ type: 'vacancy', title, sourceId: 'hh', externalId, url: `https://example.test/${externalId}` });
      Object.assign(repository.records.find((item) => item._id === ingested.opportunity._id), {
        money: { max: moneyMax, currency: 'RUB' },
        deadline: new Date(deadline),
        firstSeenAt: new Date(firstSeenAt),
      });
      return ingested.opportunity._id;
    };
    const lowLate = await seed('export-sort-1', 'Low late', 100, '2026-11-10T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
    const lowEarly = await seed('export-sort-2', 'Low early', 100, '2026-11-01T00:00:00.000Z', '2026-10-04T00:00:00.000Z');
    const highEarly = await seed('export-sort-3', 'High early', 500, '2026-11-01T00:00:00.000Z', '2026-10-03T00:00:00.000Z');
    const midMiddle = await seed('export-sort-4', 'Mid middle', 300, '2026-11-05T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
    const moneyAscDeadlineDesc = JSON.stringify([
      { field: 'moneyMax', direction: 'asc' },
      { field: 'deadlineAt', direction: 'desc' },
    ]);
    const deadlineAscMoneyDesc = JSON.stringify([
      { field: 'deadlineAt', direction: 'asc' },
      { field: 'moneyMax', direction: 'desc' },
    ]);

    const byMoney = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'filtered', query: { advancedSort: moneyAscDeadlineDesc } },
    );
    const byDeadline = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'filtered', query: { advancedSort: deadlineAscMoneyDesc } },
    );

    assert.deepEqual(JSON.parse(Buffer.from(byMoney.contentBase64, 'base64').toString('utf8')).items.map((item) => item.id), [lowLate, lowEarly, midMiddle, highEarly]);
    assert.deepEqual(JSON.parse(Buffer.from(byDeadline.contentBase64, 'base64').toString('utf8')).items.map((item) => item.id), [highEarly, lowEarly, midMiddle, lowLate]);
  });

  it('queues large filtered exports and writes all matching rows to a private file', async () => {
    const repository = new InMemoryOpportunityRepository();
    const jobs = new InMemoryJobsService();
    const files = new InMemoryFilesService([]);
    const exports = new InMemoryExportsRepository();
    const notifications = new InMemoryNotificationsService();
    const service = new OpportunitiesService(
      repository,
      new InMemoryStateRepository(),
      {},
      {},
      new InMemoryProfilesRepository(null),
      new MatchingService(),
      jobs,
      undefined,
      files,
      undefined,
      undefined,
      undefined,
      exports,
      notifications,
    );
    service.onModuleInit();
    for (let index = 0; index < 1005; index += 1) {
      const ingested = await service.ingestOrUpsert({
        type: 'vacancy',
        title: `Large export ${index}`,
        sourceId: 'hh',
        externalId: `large-export-${index}`,
        url: `https://example.test/large-export/${index}`,
      });
      repository.records.find((item) => item._id === ingested.opportunity._id).firstSeenAt = new Date(Date.UTC(2026, 9, 3, 0, 0, 0) - index * 60_000);
    }

    const queued = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'filtered', query: {} },
    );
    const beforeRun = await service.exportStatus({ id: 'user-1', email: 'u@example.test', role: 'User' }, queued.exportId);
    await jobs.run('documents', 'opportunity.export', { exportId: queued.exportId });
    const completed = await service.exportStatus({ id: 'user-1', email: 'u@example.test', role: 'User' }, queued.exportId);
    const stored = files.stored.find((file) => file._id === completed.fileId);
    const decoded = JSON.parse(stored.buffer.toString('utf8'));

    assert.equal(queued.status, 'queued');
    assert.equal('contentBase64' in queued, false);
    assert.equal(beforeRun.status, 'queued');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.count, 1005);
    assert.equal('contentBase64' in completed, false);
    assert.equal(stored.ownerUserId, 'user-1');
    assert.equal(decoded.items.length, 1005);
    assert.equal(decoded.items[0].title, 'Large export 0');
    assert.equal(decoded.items.at(-1).title, 'Large export 1004');
    assert.deepEqual(notifications.sent.map((item) => item.type), ['opportunity_export.completed']);
    assert.equal(repository.listCanonicalCandidatesCalls, 0);
    assert.ok(repository.exportHydrationBatches.every((ids) => ids.length <= 500));
    assert.deepEqual(repository.exportHydrationBatches.map((ids) => ids.length), [500, 500, 5]);
    assert.equal(files.generatedPaths.length, 1);
    await assert.rejects(access(files.generatedPaths[0]), { code: 'ENOENT' });
  });

  it('keeps selected and loaded closed records, repeated ids and caller order', async () => {
    const repository = new InMemoryOpportunityRepository();
    const service = new OpportunitiesService(repository, new InMemoryStateRepository(), {}, {}, new InMemoryProfilesRepository(null), new MatchingService());
    const first = await service.ingestOrUpsert({ type: 'vacancy', title: 'Closed selected', sourceStatus: 'Closed', sourceId: 'hh', externalId: 'closed-selected', url: 'https://example.test/closed-selected' });
    const second = await service.ingestOrUpsert({ type: 'vacancy', title: 'Merged selected', sourceId: 'hh', externalId: 'merged-selected', url: 'https://example.test/merged-selected' });
    repository.records.find((item) => item._id === second.opportunity._id).mergedIntoOpportunityId = first.opportunity._id;
    repository.findByIds = async () => { throw new Error('Export must not hydrate rich source records'); };
    const ids = [second.opportunity._id, first.opportunity._id, second.opportunity._id, 'missing'];
    for (const scope of ['selected', 'loaded']) {
      const exported = await service.export({ id: 'user-1', role: 'User' }, { format: 'json', scope, ids, loadedIds: ids, query: { query: 'does not match', status: ['Active'] } });
      const rows = JSON.parse(Buffer.from(exported.contentBase64, 'base64').toString()).items;
      assert.deepEqual(rows.map((item) => item.id), ids.slice(0, 3));
      assert.equal(exported.skipped, 1);
    }
  });

  it('preserves optional personal and AI columns when the first row has no stored state', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned', isActive: true });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    const first = await service.ingestOrUpsert({ type: 'vacancy', title: 'Untracked first', sourceId: 'hh', externalId: 'personal-columns-1', url: 'https://example.test/personal-columns/1' });
    const second = await service.ingestOrUpsert({ type: 'vacancy', title: 'Tracked second', sourceId: 'hh', externalId: 'personal-columns-2', url: 'https://example.test/personal-columns/2' });
    states.records.push({ userId: 'user-1', profileId: 'profile-1', opportunityId: second.opportunity._id, favorite: true, tags: ['owned tag'], notes: ['PRIVATE NOTE'], pipelineStatus: 'Responded', matchScore: 74 });
    repository.aiRows.push({ userId: 'user-1', profileId: 'profile-1', opportunityId: second.opportunity._id, taskType: 'opportunity_analysis', status: 'completed', aiScore: 82, runId: 'owned-ai' });
    repository.aiRows.push({ userId: 'user-2', profileId: 'profile-2', opportunityId: first.opportunity._id, taskType: 'opportunity_analysis', status: 'completed', aiScore: 99, runId: 'FOREIGN AI' });
    const dto = { format: 'csv', scope: 'selected', ids: [first.opportunity._id, second.opportunity._id], includePersonalData: true };
    const full = await service.export({ id: 'user-1', role: 'User' }, dto);
    const fullCsv = Buffer.from(full.contentBase64, 'base64').toString();
    assert.ok(fullCsv.split('\n')[0].includes('"aiScore","aiRunId"'));
    assert.ok(fullCsv.includes('"owned tag","82","owned-ai"'));
    assert.ok(!fullCsv.includes('PRIVATE NOTE') && !fullCsv.includes('FOREIGN AI'));
    const custom = await service.export({ id: 'user-1', role: 'User' }, { ...dto, fields: ['id', 'favorite', 'personalTags', 'aiScore', 'aiRunId', 'notes', 'rawPayload', 'id'] });
    assert.deepEqual(Buffer.from(custom.contentBase64, 'base64').toString().split('\n'), [
      '\uFEFF"id","favorite","personalTags","aiScore","aiRunId"',
      `"${first.opportunity._id}","false","","",""`,
      `"${second.opportunity._id}","true","owned tag","82","owned-ai"`,
    ]);
    const withoutPersonal = await service.export({ id: 'user-1', role: 'User' }, { ...dto, includePersonalData: false });
    const publicCsv = Buffer.from(withoutPersonal.contentBase64, 'base64').toString();
    assert.ok(!publicCsv.includes('owned tag') && !publicCsv.includes('owned-ai') && !publicCsv.includes('favorite'));
  });

  it('queues an oversized single-row export instead of returning a large base64 response', async () => {
    const repository = new InMemoryOpportunityRepository();
    const jobs = new InMemoryJobsService();
    const files = new InMemoryFilesService([]);
    const exports = new InMemoryExportsRepository();
    const service = new OpportunitiesService(repository, new InMemoryStateRepository(), {}, {}, new InMemoryProfilesRepository(null), new MatchingService(), jobs, undefined, files, undefined, undefined, undefined, exports);
    const item = await service.ingestOrUpsert({ type: 'vacancy', title: 'Long export', description: 'x'.repeat(9 * 1024 * 1024), sourceId: 'hh', externalId: 'long-export', url: 'https://example.test/long-export' });
    const queued = await service.export({ id: 'user-1', role: 'User' }, { format: 'json', scope: 'selected', ids: [item.opportunity._id], limit: 1 });
    assert.equal(queued.status, 'queued');
    assert.equal(Object.hasOwn(queued, 'contentBase64'), false);
    assert.equal(files.stored.length, 0);
  });

  it('removes generated temporary files after a storage failure', async () => {
    const repository = new InMemoryOpportunityRepository();
    const jobs = new InMemoryJobsService();
    const files = new InMemoryFilesService([]);
    const exports = new InMemoryExportsRepository();
    const service = new OpportunitiesService(repository, new InMemoryStateRepository(), {}, {}, new InMemoryProfilesRepository(null), new MatchingService(), jobs, undefined, files, undefined, undefined, undefined, exports);
    service.onModuleInit();
    const item = await service.ingestOrUpsert({ type: 'vacancy', title: 'Storage failure', sourceId: 'hh', externalId: 'failed-store', url: 'https://example.test/failed-store' });
    const queued = await service.export({ id: 'user-1', role: 'User' }, { format: 'json', scope: 'selected', ids: [item.opportunity._id], background: true });
    let temporaryPath;
    files.storeGeneratedFile = async (_owner, path) => { temporaryPath = path; throw new Error('storage failed'); };
    await assert.rejects(jobs.run('documents', 'opportunity.export', { exportId: queued.exportId }), /storage failed/);
    await assert.rejects(access(temporaryPath), { code: 'ENOENT' });
    assert.equal(exports.records[0].status, 'failed');
    assert.equal(files.stored.length, 0);
  });

  it('keeps a stored completed export authoritative after final progress failure and repeated execution', async () => {
    const repository = new InMemoryOpportunityRepository();
    const jobs = new InMemoryJobsService();
    const files = new InMemoryFilesService([]);
    const exports = new InMemoryExportsRepository();
    const notifications = new InMemoryNotificationsService();
    const service = new OpportunitiesService(repository, new InMemoryStateRepository(), {}, {}, new InMemoryProfilesRepository(null), new MatchingService(), jobs, undefined, files, undefined, undefined, undefined, exports, notifications);
    service.onModuleInit();
    const item = await service.ingestOrUpsert({ type: 'vacancy', title: 'Final progress failure', sourceId: 'hh', externalId: 'progress-final', url: 'https://example.test/progress-final' });
    const actor = { id: 'user-1', role: 'User' };
    const queued = await service.export(actor, { format: 'json', scope: 'selected', ids: [item.opportunity._id], background: true });
    const first = await jobs.run('documents', 'opportunity.export', { exportId: queued.exportId }, { failProgress: 100 });
    assert.equal(first.status, 'completed');
    assert.ok(first.fileId);
    assert.equal((await service.exportStatus(actor, queued.exportId)).status, 'completed');
    const second = await jobs.run('documents', 'opportunity.export', { exportId: queued.exportId });
    assert.equal(second.fileId, first.fileId);
    assert.equal(files.stored.length, 1);
    assert.equal(files.generatedPaths.length, 1);
    assert.deepEqual(notifications.sent.map((item) => item.type), ['opportunity_export.completed']);
  });

  it('keeps selected id order in background exports', async () => {
    const repository = new InMemoryOpportunityRepository();
    const jobs = new InMemoryJobsService();
    const files = new InMemoryFilesService([]);
    const exports = new InMemoryExportsRepository();
    const service = new OpportunitiesService(
      repository,
      new InMemoryStateRepository(),
      {},
      {},
      new InMemoryProfilesRepository(null),
      new MatchingService(),
      jobs,
      undefined,
      files,
      undefined,
      undefined,
      undefined,
      exports,
    );
    service.onModuleInit();
    const first = await service.ingestOrUpsert({ type: 'vacancy', title: 'First selected', sourceId: 'hh', externalId: 'bg-order-1', url: 'https://example.test/bg-order/1' });
    const second = await service.ingestOrUpsert({ type: 'vacancy', title: 'Second selected', sourceId: 'hh', externalId: 'bg-order-2', url: 'https://example.test/bg-order/2' });
    const third = await service.ingestOrUpsert({ type: 'vacancy', title: 'Third selected', sourceId: 'hh', externalId: 'bg-order-3', url: 'https://example.test/bg-order/3' });

    const queued = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'selected', ids: [third.opportunity._id, first.opportunity._id, second.opportunity._id], background: true },
    );
    await jobs.run('documents', 'opportunity.export', { exportId: queued.exportId });
    const completed = await service.exportStatus({ id: 'user-1', email: 'u@example.test', role: 'User' }, queued.exportId);
    const decoded = JSON.parse(files.stored.find((file) => file._id === completed.fileId).buffer.toString('utf8'));

    assert.deepEqual(decoded.items.map((item) => item.id), [third.opportunity._id, first.opportunity._id, second.opportunity._id]);
    assert.equal(completed.count, 3);
  });

  it('protects background export status by owner while allowing admin reads', async () => {
    const repository = new InMemoryOpportunityRepository();
    const jobs = new InMemoryJobsService();
    const exports = new InMemoryExportsRepository();
    const service = new OpportunitiesService(
      repository,
      new InMemoryStateRepository(),
      {},
      {},
      new InMemoryProfilesRepository(null),
      new MatchingService(),
      jobs,
      undefined,
      new InMemoryFilesService([]),
      undefined,
      undefined,
      undefined,
      exports,
    );
    service.onModuleInit();
    await service.ingestOrUpsert({ type: 'vacancy', title: 'Private status', sourceId: 'hh', externalId: 'bg-acl-1', url: 'https://example.test/bg-acl/1' });

    const queued = await service.export(
      { id: 'owner-user', email: 'owner@example.test', role: 'User' },
      { format: 'json', scope: 'filtered', query: {}, background: true },
    );

    assert.equal((await service.exportStatus({ id: 'owner-user', email: 'owner@example.test', role: 'User' }, queued.exportId)).status, 'queued');
    await assert.rejects(
      () => service.exportStatus({ id: 'other-user', email: 'other@example.test', role: 'User' }, queued.exportId),
      /Opportunity export access denied/,
    );
    assert.equal((await service.exportStatus({ id: 'admin-user', email: 'admin@example.test', role: 'Admin' }, queued.exportId)).status, 'queued');
  });

  it('marks background exports failed when worker profile ownership revalidation fails', async () => {
    const repository = new InMemoryOpportunityRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned', isActive: true });
    const jobs = new InMemoryJobsService();
    const exports = new InMemoryExportsRepository();
    const notifications = new InMemoryNotificationsService();
    const service = new OpportunitiesService(
      repository,
      new InMemoryStateRepository(),
      {},
      {},
      profiles,
      new MatchingService(),
      jobs,
      undefined,
      new InMemoryFilesService([]),
      undefined,
      undefined,
      undefined,
      exports,
      notifications,
    );
    service.onModuleInit();
    await service.ingestOrUpsert({ type: 'vacancy', title: 'Revalidate profile', sourceId: 'hh', externalId: 'bg-fail-1', url: 'https://example.test/bg-fail/1' });
    const queued = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'filtered', query: { profileId: 'profile-1' }, background: true },
    );
    profiles.profiles = [];

    await assert.rejects(
      () => jobs.run('documents', 'opportunity.export', { exportId: queued.exportId }),
      /Profile not found/,
    );
    const failed = await service.exportStatus({ id: 'user-1', email: 'u@example.test', role: 'User' }, queued.exportId);

    assert.equal(failed.status, 'failed');
    assert.equal(failed.progress, 100);
    assert.match(failed.error, /Profile not found/);
    assert.deepEqual(notifications.sent.map((item) => item.type), ['opportunity_export.failed']);
  });

  it('marks durable export failed when enqueue fails after record creation', async () => {
    const repository = new InMemoryOpportunityRepository();
    const jobs = new InMemoryJobsService();
    const exports = new InMemoryExportsRepository();
    const service = new OpportunitiesService(
      repository,
      new InMemoryStateRepository(),
      {},
      {},
      new InMemoryProfilesRepository(null),
      new MatchingService(),
      jobs,
      undefined,
      new InMemoryFilesService([]),
      undefined,
      undefined,
      undefined,
      exports,
    );
    await service.ingestOrUpsert({ type: 'vacancy', title: 'Enqueue failure', sourceId: 'hh', externalId: 'bg-enqueue-fail-1', url: 'https://example.test/bg-enqueue-fail/1' });
    jobs.enqueueError = new Error('queue unavailable');

    await assert.rejects(
      () => service.export(
        { id: 'user-1', email: 'u@example.test', role: 'User' },
        { format: 'json', scope: 'filtered', query: {}, background: true },
      ),
      /queue unavailable/,
    );

    assert.equal(exports.records.length, 1);
    assert.equal(exports.records[0].status, 'failed');
    assert.equal(exports.records[0].progress, 100);
    assert.match(exports.records[0].error, /queue unavailable/);
  });

  it('keeps transient worker retry failures polling-safe until the terminal attempt', async () => {
    const repository = new InMemoryOpportunityRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned', isActive: true });
    const jobs = new InMemoryJobsService();
    const exports = new InMemoryExportsRepository();
    const notifications = new InMemoryNotificationsService();
    const service = new OpportunitiesService(
      repository,
      new InMemoryStateRepository(),
      {},
      {},
      profiles,
      new MatchingService(),
      jobs,
      undefined,
      new InMemoryFilesService([]),
      undefined,
      undefined,
      undefined,
      exports,
      notifications,
    );
    service.onModuleInit();
    await service.ingestOrUpsert({ type: 'vacancy', title: 'Retry profile', sourceId: 'hh', externalId: 'bg-retry-1', url: 'https://example.test/bg-retry/1' });
    const queued = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'filtered', query: { profileId: 'profile-1' }, background: true },
    );
    profiles.profiles = [];

    await assert.rejects(
      () => jobs.run('documents', 'opportunity.export', { exportId: queued.exportId }, { attemptsMade: 0, attempts: 5 }),
      /Profile not found/,
    );
    const retrying = await service.exportStatus({ id: 'user-1', email: 'u@example.test', role: 'User' }, queued.exportId);
    assert.equal(retrying.status, 'running');
    assert.equal(notifications.sent.length, 0);

    await assert.rejects(
      () => jobs.run('documents', 'opportunity.export', { exportId: queued.exportId }, { attemptsMade: 4, attempts: 5 }),
      /Profile not found/,
    );
    const failed = await service.exportStatus({ id: 'user-1', email: 'u@example.test', role: 'User' }, queued.exportId);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(notifications.sent.map((item) => item.type), ['opportunity_export.failed']);
  });

  it('checks private profile ownership before exporting with state filters', async () => {
    const repository = new InMemoryOpportunityRepository();
    const service = new OpportunitiesService(
      repository,
      new InMemoryStateRepository(),
      {},
      {},
      new InMemoryProfilesRepository([{ _id: 'profile-foreign', userId: 'other-user', name: 'Foreign' }]),
      new MatchingService(),
    );
    await service.ingestOrUpsert({ type: 'vacancy', title: 'Protected', sourceId: 'hh', externalId: 'protected-1', url: 'https://example.test/protected/1' });

    await assert.rejects(
      () => service.export(
        { id: 'user-1', email: 'u@example.test', role: 'User' },
        { format: 'json', scope: 'filtered', query: { favorite: true, profileId: 'profile-foreign' } },
      ),
      /Profile not found/,
    );
  });


  it('keeps profileId from bulk action value when updating personal state', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository([
      { _id: 'profile-active', userId: 'user-1', name: 'Active', isActive: true, technologies: [], seniority: [], employmentTypes: [], remotePreferences: [], locations: [], sourceIds: [], compensationPreferences: {}, matchWeights: { skills: 35, seniority: 10, money: 15, remoteLocation: 15, employment: 10, freshness: 10, source: 5 } },
      { _id: 'profile-target', userId: 'user-1', name: 'Target', technologies: [], seniority: [], employmentTypes: [], remotePreferences: [], locations: [], sourceIds: [], compensationPreferences: {}, matchWeights: { skills: 35, seniority: 10, money: 15, remoteLocation: 15, employment: 10, freshness: 10, source: 5 } },
    ]);
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    const ingested = await service.ingestOrUpsert({
      type: 'vacancy',
      title: 'Bulk Backend',
      sourceId: 'hh',
      externalId: 'bulk-1',
      url: 'https://example.test/bulk/1',
    });

    await service.bulk({ id: 'user-1', email: 'u@example.test', role: 'User' }, { ids: [ingested.opportunity._id], action: 'favorite', value: { enabled: true, profileId: 'profile-target' } });

    assert.equal(states.records[0].profileId, 'profile-target');
    assert.equal(states.records[0].favorite, true);
  });

  it('hides source raw payload from normal source reads', async () => {
    const repository = new InMemoryOpportunityRepository();
    const service = new OpportunitiesService(repository, {}, {}, {}, {}, new MatchingService());
    const ingested = await service.ingestOrUpsert({
      type: 'freelance',
      title: 'Parser task',
      sourceId: 'freelancehunt',
      externalId: 'task-1',
      url: 'https://example.test/tasks/1',
      rawPayload: { tokenLike: 'secret-source-debug' },
    });

    const safeSources = await service.getSources(ingested.opportunity._id, false);
    const debugSources = await service.getSources(ingested.opportunity._id, true);

    assert.equal('rawPayload' in safeSources[0], false);
    assert.deepEqual(debugSources[0].rawPayload, { tokenLike: 'secret-source-debug' });
  });


  it('exposes safe source documents and critical conflicts without raw source secrets', async () => {
    const repository = new InMemoryOpportunityRepository();
    const service = new OpportunitiesService(repository, new InMemoryStateRepository(), {}, {}, new InMemoryProfilesRepository(null), new MatchingService());
    const ingested = await service.ingestOrUpsert({
      type: 'tender',
      title: 'Integration tender',
      sourceId: 'zakupki',
      externalId: 'tender-1',
      url: 'https://example.test/tenders/1',
      deadline: '2026-11-01T10:00:00.000Z',
      money: { max: 1000000, currency: 'RUB' },
      sourceStatus: 'Active',
      rawPayload: { secret: true },
      sourceMetadata: { importFileId: 'file-safe-1', secretToken: 'hidden' },
    });
    const record = repository.records[0];
    record.sourceOccurrences.push({
      sourceId: 'platform-alt',
      externalId: 'tender-alt-1',
      url: 'https://example.test/tenders/alt-1',
      primary: false,
      status: 'Closed',
      firstSeenAt: new Date('2026-10-02T00:00:00.000Z'),
      lastSeenAt: new Date('2026-10-02T00:00:00.000Z'),
      rawPayload: { hidden: true },
      sourceMetadata: { secret: 'private' },
      normalizedSnapshot: {
        deadline: new Date('2026-11-05T10:00:00.000Z'),
        money: { max: 1200000, currency: 'RUB' },
        sourceStatus: 'Closed',
      },
    });

    const response = await service.get({ id: 'user-1', email: 'u@example.test', role: 'User' }, ingested.opportunity._id);
    const encoded = JSON.stringify(response);

    assert.equal(encoded.includes('rawPayload'), false);
    assert.equal(encoded.includes('sourceMetadata'), false);
    assert.equal(encoded.includes('secretToken'), false);
    assert.deepEqual(response.criticalConflicts.map((item) => item.field).sort(), ['deadline', 'money', 'sourceStatus']);
    assert.deepEqual(response.sourceDocuments.map((item) => [item.kind, item.sourceId]), [
      ['url', 'zakupki'],
      ['file', 'zakupki'],
      ['url', 'platform-alt'],
    ]);
    assert.equal(response.primaryCanonical.sourceStatus, 'Active');
  });

  it('exposes native document URLs with source identity while rejecting unsafe metadata and duplicates', async () => {
    const repository = new InMemoryOpportunityRepository();
    const service = new OpportunitiesService(repository, new InMemoryStateRepository(), {}, {}, new InMemoryProfilesRepository(null), new MatchingService());
    const url = 'https://example.test/tender/1';
    const ingested = await service.ingestOrUpsert({
      type: 'tender', title: 'Tender with native documents', sourceId: 'roseltorg', externalId: 'tender-doc-1', url,
      tenderData: { contractNumber: '32616434303' },
      sourceMetadata: {
        sourceDocuments: [
          { label: 'Техническое задание.docx', url: 'https://example.test/documents/technical.docx', sourceId: 'spoofed', secret: 'hidden' },
          { label: 'Duplicate', url: 'https://example.test/documents/technical.docx' },
          { label: 'Duplicate source', url },
          { label: 'Script', url: 'javascript:alert(1)' },
          { label: 'Credentials', url: 'https://user:secret@example.test/private' },
          { label: 'Malformed', url: 'https://' },
          { label: 'No URL' },
          null,
        ],
      },
    });
    const response = await service.get({ id: 'user-1', email: 'u@example.test', role: 'User' }, ingested.opportunity._id);
    assert.deepEqual(response.sourceDocuments, [
      { kind: 'url', sourceId: 'roseltorg', label: 'roseltorg', url },
      { kind: 'url', sourceId: 'roseltorg', label: 'Техническое задание.docx', url: 'https://example.test/documents/technical.docx' },
    ]);
    assert.equal(response.tenderData.eligibilityEvidence, undefined);
    assert.equal(JSON.stringify(response).includes('hidden'), false);
    assert.equal(JSON.stringify(response).includes('spoofed'), false);
  });

  it('applies saved view query, filters and sort to real opportunity criteria', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned', isActive: true });
    const savedViews = new InMemorySavedViewsRepository({
      _id: 'view-1',
      userId: 'user-1',
      query: { query: 'Backend', profileId: 'profile-1' },
      filters: { type: 'vacancy', remoteType: 'remote' },
      sort: { sort: 'highestAI' },
    });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService(), undefined, undefined, undefined, savedViews);
    const first = await service.ingestOrUpsert({
      type: 'vacancy',
      title: 'Backend Platform',
      sourceId: 'hh',
      externalId: 'saved-1',
      url: 'https://example.test/saved/1',
      remoteType: 'remote',
    });
    const second = await service.ingestOrUpsert({
      type: 'vacancy',
      title: 'Backend Office',
      sourceId: 'hh',
      externalId: 'saved-2',
      url: 'https://example.test/saved/2',
      remoteType: 'office',
    });
    repository.aiRows = [
      { opportunityId: second.opportunity._id, runId: 'run-2', aiScore: 99, completedAt: new Date('2026-10-02T12:00:00.000Z'), taskType: 'opportunity_analysis', userId: 'user-1', profileId: 'profile-1', status: 'completed' },
      { opportunityId: first.opportunity._id, runId: 'run-1', aiScore: 91, completedAt: new Date('2026-10-02T11:00:00.000Z'), taskType: 'opportunity_analysis', userId: 'user-1', profileId: 'profile-1', status: 'completed' },
    ];

    const result = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { viewId: 'view-1', limit: 10 });

    assert.deepEqual(result.items.map((item) => item.id), [first.opportunity._id]);
    assert.equal(result.items[0].aiScore, 91);
    assert.equal(result.items[0].latestAiAnalysis.id, 'run-1');
  });

  it('keeps match score separate from latest private AI score', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned', isActive: true });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    const first = await service.ingestOrUpsert({ type: 'vacancy', title: 'High AI', sourceId: 'hh', externalId: 'ai-1', url: 'https://example.test/ai/1' });
    const second = await service.ingestOrUpsert({ type: 'vacancy', title: 'Low AI', sourceId: 'hh', externalId: 'ai-2', url: 'https://example.test/ai/2' });
    await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: first.opportunity._id, favorite: false, hidden: false, archived: false, tags: [], pipelineStatus: 'New', matchScore: 42 });
    repository.aiRows = [
      { opportunityId: first.opportunity._id, runId: 'run-high', aiScore: 88, completedAt: new Date('2026-10-02T12:00:00.000Z'), taskType: 'opportunity_analysis', userId: 'user-1', profileId: 'profile-1', status: 'completed' },
      { opportunityId: second.opportunity._id, runId: 'run-low', aiScore: 62, completedAt: new Date('2026-10-02T12:30:00.000Z'), taskType: 'opportunity_analysis', userId: 'user-1', profileId: 'profile-1', status: 'completed' },
    ];

    const result = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', minAiScore: 80, analyzed: true, sort: 'highestAI' });

    assert.deepEqual(result.items.map((item) => item.id), [first.opportunity._id]);
    assert.equal(result.items[0].aiScore, 88);
    assert.equal(result.items[0].matchScore, 42);
  });


  it('calculates active-profile match for fresh imports in feed sort and minMatch without stored state', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Python', isActive: true, technologies: ['Python'], sourceIds: ['hh'], matchWeights: { skills: 70, seniority: 0, money: 0, remoteLocation: 0, employment: 0, freshness: 20, source: 10 } });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    const high = await service.ingestOrUpsert({ type: 'vacancy', title: 'Python backend', sourceId: 'hh', externalId: 'match-fresh-1', url: 'https://example.test/match/1', technologies: ['Python'], publishedAt: new Date('2026-10-02T00:00:00.000Z') });
    const low = await service.ingestOrUpsert({ type: 'vacancy', title: 'Go backend', sourceId: 'hh', externalId: 'match-fresh-2', url: 'https://example.test/match/2', technologies: ['Go'], publishedAt: new Date('2026-10-03T00:00:00.000Z') });
    repository.records.find((item) => item._id === high.opportunity._id).firstSeenAt = new Date('2026-10-01T00:00:00.000Z');
    repository.records.find((item) => item._id === low.opportunity._id).firstSeenAt = new Date('2026-10-03T00:00:00.000Z');

    const recommended = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', sort: 'recommended', limit: 10 });
    const minMatch = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', minMatch: recommended.items[0].matchScore, limit: 10 });

    assert.deepEqual(recommended.items.map((item) => item.id), [high.opportunity._id, low.opportunity._id]);
    assert.ok(recommended.items[0].matchScore > recommended.items[1].matchScore);
    assert.equal(recommended.items[0].pipelineStatus, null);
    assert.deepEqual(minMatch.items.map((item) => item.id), [high.opportunity._id]);
    assert.equal(states.records.length, 0);

    const filteredExport = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'filtered', query: { profileId: 'profile-1', minMatch: recommended.items[0].matchScore, sort: 'recommended' }, includePersonalData: true },
    );
    const filteredRows = JSON.parse(Buffer.from(filteredExport.contentBase64, 'base64').toString('utf8')).items;
    assert.deepEqual(filteredRows.map((item) => item.id), minMatch.items.map((item) => item.id));
    assert.equal(filteredRows[0].matchScore, recommended.items[0].matchScore);
    const orderedExport = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'filtered', query: { profileId: 'profile-1', sort: 'recommended' } },
    );
    const orderedRows = JSON.parse(Buffer.from(orderedExport.contentBase64, 'base64').toString('utf8')).items;
    assert.deepEqual(orderedRows.map((item) => item.id), recommended.items.map((item) => item.id));
    assert.equal(Object.hasOwn(orderedRows[0], 'matchScore'), false);
  });

  it('does not cap private match feed candidates at the export limit', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({
      _id: 'profile-1',
      userId: 'user-1',
      name: 'Python',
      isActive: true,
      technologies: ['Python'],
      matchWeights: { skills: 100, seniority: 0, money: 0, remoteLocation: 0, employment: 0, freshness: 0, source: 0 },
    });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    for (let index = 0; index < 1005; index += 1) {
      const ingested = await service.ingestOrUpsert({
        type: 'vacancy',
        title: `Generic Go ${index}`,
        sourceId: 'hh',
        externalId: `cap-low-${index}`,
        url: `https://example.test/cap/${index}`,
        technologies: ['Go'],
      });
      repository.records.find((item) => item._id === ingested.opportunity._id).firstSeenAt = new Date(Date.UTC(2026, 9, 3, 0, 0, 0) - index * 60_000);
    }
    const best = await service.ingestOrUpsert({
      type: 'vacancy',
      title: 'Best Python behind old cap',
      sourceId: 'hh',
      externalId: 'cap-best',
      url: 'https://example.test/cap/best',
      technologies: ['Python'],
    });
    repository.records.find((item) => item._id === best.opportunity._id).firstSeenAt = new Date('2026-01-01T00:00:00.000Z');

    const firstPage = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', sort: 'recommended', limit: 1 });
    const secondPage = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', sort: 'recommended', limit: 1, cursor: firstPage.nextCursor });
    const minMatch = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', minMatch: 100, limit: 10 });

    assert.equal(repository.listForExportCalls, 0);
    assert.equal(repository.listCanonicalCandidatesCalls, 0);
    assert.equal(repository.iteratePrivateSortCandidatesCalls, 4);
    assert.equal(firstPage.items[0].id, best.opportunity._id);
    assert.equal(firstPage.items[0].matchScore, 100);
    assert.ok(firstPage.nextCursor);
    assert.notEqual(secondPage.items[0].id, best.opportunity._id);
    assert.equal(firstPage.total, 1006);
    assert.equal(secondPage.total, 1006);
    assert.deepEqual(minMatch.items.map((item) => item.id), [best.opportunity._id]);
    assert.equal(minMatch.total, 1);
  });


  it('orders private AI advanced sort with secondary money deadline match rules and stable cursor', async () => {
    const repository = new InMemoryOpportunityRepository();
    const scan = repository.iteratePrivateSortCandidates.bind(repository);
    repository.iteratePrivateSortCandidates = (query, ids) => scan(query, ids, 2);
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned', isActive: true });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    const seed = async (externalId, title, moneyMax, deadline, matchScore) => {
      const ingested = await service.ingestOrUpsert({ type: 'vacancy', title, sourceId: 'hh', externalId, url: `https://example.test/${externalId}` });
      const record = repository.records.find((item) => item._id === ingested.opportunity._id);
      Object.assign(record, { money: { max: moneyMax, currency: 'RUB' }, deadline: new Date(deadline), firstSeenAt: new Date(`2026-10-02T00:0${repository.records.length}:00.000Z`) });
      await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: ingested.opportunity._id, favorite: false, hidden: false, archived: false, tags: [], pipelineStatus: 'New', matchScore });
      return ingested.opportunity._id;
    };
    const lateTie = await seed('sort-1', 'Late tie', 100, '2026-11-10T00:00:00.000Z', 10);
    const deadlineTie = await seed('sort-2', 'Deadline tie', 100, '2026-11-01T00:00:00.000Z', 50);
    const lowerAi = await seed('sort-3', 'Lower AI', 50, '2026-10-20T00:00:00.000Z', 99);
    const matchTie = await seed('sort-4', 'Match tie', 100, '2026-11-01T00:00:00.000Z', 90);
    const otherUserOnly = await seed('sort-5', 'Other user only', 1, '2026-10-01T00:00:00.000Z', 100);
    repository.aiRows = [
      { opportunityId: lateTie, runId: 'run-late', aiScore: 95, completedAt: new Date('2026-10-02T12:00:00.000Z'), taskType: 'opportunity_analysis', userId: 'user-1', profileId: 'profile-1', status: 'completed' },
      { opportunityId: deadlineTie, runId: 'run-deadline', aiScore: 95, completedAt: new Date('2026-10-02T12:01:00.000Z'), taskType: 'opportunity_analysis', userId: 'user-1', profileId: 'profile-1', status: 'completed' },
      { opportunityId: lowerAi, runId: 'run-lower', aiScore: 80, completedAt: new Date('2026-10-02T12:02:00.000Z'), taskType: 'opportunity_analysis', userId: 'user-1', profileId: 'profile-1', status: 'completed' },
      { opportunityId: matchTie, runId: 'run-match', aiScore: 95, completedAt: new Date('2026-10-02T12:03:00.000Z'), taskType: 'opportunity_analysis', userId: 'user-1', profileId: 'profile-1', status: 'completed' },
      { opportunityId: otherUserOnly, runId: 'run-leak', aiScore: 100, completedAt: new Date('2026-10-02T12:04:00.000Z'), taskType: 'opportunity_analysis', userId: 'other-user', profileId: 'profile-1', status: 'completed' },
    ];
    const advancedSort = JSON.stringify([
      { field: 'highestAI', direction: 'desc' },
      { field: 'moneyMax', direction: 'asc' },
      { field: 'deadlineAt', direction: 'asc' },
      { field: 'matchScore', direction: 'desc' },
    ]);

    const firstPage = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', sort: 'recommended', advancedSort, limit: 2 });
    const secondPage = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', sort: 'recommended', advancedSort, limit: 2, cursor: firstPage.nextCursor });
    const ascPage = await service.list({ id: 'user-1', email: 'u@example.test', role: 'User' }, { profileId: 'profile-1', advancedSort: JSON.stringify([{ field: 'highestAI', direction: 'asc' }]), limit: 1 });

    assert.deepEqual(firstPage.items.map((item) => item.id), [matchTie, deadlineTie]);
    assert.deepEqual(secondPage.items.map((item) => item.id), [lateTie, lowerAi]);
    assert.equal(firstPage.total, 4);
    assert.equal(secondPage.total, 4);
    assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size, 4);
    assert.equal(ascPage.items[0].id, lowerAi);
    assert.equal([...firstPage.items, ...secondPage.items, ...ascPage.items].some((item) => item.id === otherUserOnly), false);

    const exported = await service.export(
      { id: 'user-1', email: 'u@example.test', role: 'User' },
      { format: 'json', scope: 'filtered', query: { profileId: 'profile-1', advancedSort, minAiScore: 90 }, includePersonalData: true },
    );
    const exportedRows = JSON.parse(Buffer.from(exported.contentBase64, 'base64').toString('utf8')).items;
    assert.deepEqual(exportedRows.map((item) => item.id), [matchTie, deadlineTie, lateTie]);
    assert.deepEqual(exportedRows.map((item) => item.aiScore), [95, 95, 95]);
    assert.equal(exportedRows.some((item) => item.aiRunId === 'run-leak'), false);
  });

  it('preserves exact private pagination across batches with null values and filtered or invalid cursors', async () => {
    const repository = new InMemoryOpportunityRepository();
    const states = new InMemoryStateRepository();
    const profiles = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned', isActive: true });
    const service = new OpportunitiesService(repository, states, {}, {}, profiles, new MatchingService());
    const ids = {};
    for (const [title, max, score, sourceId, sourceStatus] of [
      ['Alpha', 100, 90, 'hh', 'Active'], ['Beta', 100, 90, 'hh', 'Active'],
      ['Gamma', 50, 90, 'hh', 'Active'], ['Delta', undefined, 90, 'hh', 'Active'],
      ['Low', 1, 20, 'hh', 'Active'], ['Tie a', undefined, 90, 'hh', 'Active'],
      ['Closed', 5, 100, 'hh', 'Closed'], ['Other source', 20, 100, 'other', 'Active'],
    ]) {
      const { opportunity } = await service.ingestOrUpsert({ type: 'vacancy', title, money: { max }, sourceId, sourceStatus, externalId: title, url: `https://example.test/stream/${encodeURIComponent(title)}` });
      ids[title] = opportunity._id;
      await states.upsert({ userId: 'user-1', profileId: 'profile-1', opportunityId: opportunity._id, matchScore: score, favorite: false, hidden: false, archived: false, tags: [], pipelineStatus: 'New' });
    }
    const scan = repository.iteratePrivateSortCandidates.bind(repository);
    repository.iteratePrivateSortCandidates = (query, restricted) => scan(query, restricted, 2);
    const hydrate = repository.findByIds.bind(repository);
    repository.findByIds = async (requested) => {
      assert.ok(requested.length <= 2, 'full records are loaded only for the requested page');
      return hydrate(requested);
    };
    const actor = { id: 'user-1', email: 'u@example.test', role: 'User' };
    const query = { profileId: 'profile-1', sourceIds: ['hh'], minMatch: 50, limit: 2, sorts: [
      { field: 'matchScore', direction: 'desc' }, { field: 'moneyMax', direction: 'asc' }, { field: 'title', direction: 'asc' },
    ] };
    const first = await service.list(actor, query);
    const second = await service.list(actor, { ...query, cursor: first.nextCursor });
    const third = await service.list(actor, { ...query, cursor: second.nextCursor });
    assert.deepEqual([...first.items, ...second.items, ...third.items].map((item) => item.title), ['Gamma', 'Alpha', 'Beta', 'Delta', 'Tie a']);
    assert.deepEqual([first.total, second.total, third.total], [5, 5, 5]);
    assert.equal(third.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items, ...third.items].map((item) => item.id)).size, 5);
    const encode = (id) => Buffer.from(JSON.stringify({ privateSort: true, id })).toString('base64url');
    for (const cursor of ['invalid-base64', encode('unknown'), encode(ids.Low), encode(ids.Closed), encode(ids['Other source'])]) {
      const fallback = await service.list(actor, { ...query, cursor });
      assert.deepEqual(fallback.items.map((item) => item.id), first.items.map((item) => item.id));
      assert.equal(fallback.total, 5);
    }
    const end = await service.list(actor, { ...query, cursor: encode(ids['Tie a']) });
    assert.deepEqual(end.items, []);
    assert.equal(end.nextCursor, null);
    assert.equal(end.total, 5);
    assert.equal(repository.listCanonicalCandidatesCalls, 0);
  });
});

describe('profiles', () => {
  it('returns stable public profile payload defaults across service paths', async () => {
    const actor = { id: 'user-1', email: 'u@example.test', role: 'User' };
    const repository = new InMemoryProfilesRepository([
      { _id: 'profile-empty', userId: 'user-1', name: 'Empty legacy', isActive: true },
      {
        _id: 'profile-populated',
        userId: 'user-1',
        name: 'Populated',
        isActive: false,
        compensationPreferences: { min: 250000 },
        aiPreferences: { language: 'ru' },
        matchWeights: { skills: 70, freshness: 20 },
      },
    ]);
    const service = new ProfilesService(repository);

    const assertStablePublicProfile = (profile) => {
      assert.equal('_id' in profile, false);
      assert.ok(profile.id);
      assert.deepEqual(profile.compensationPreferences, profile.id === 'profile-populated' ? { min: 250000 } : {});
      assert.deepEqual(profile.aiPreferences, profile.id === 'profile-populated' ? { language: 'ru' } : {});
      assert.deepEqual(profile.matchWeights, profile.id === 'profile-populated' ? { ...DEFAULT_MATCH_WEIGHTS, skills: 70, freshness: 20 } : DEFAULT_MATCH_WEIGHTS);
    };

    const listed = await service.list(actor);
    assert.equal(listed.length, 2);
    listed.forEach(assertStablePublicProfile);

    assertStablePublicProfile(await service.get(actor, 'profile-empty'));

    const created = await service.create(actor, { name: 'Created from public POST' });
    assert.equal(created.name, 'Created from public POST');
    assert.deepEqual(created.compensationPreferences, {});
    assert.deepEqual(created.aiPreferences, {});
    assert.deepEqual(created.matchWeights, DEFAULT_MATCH_WEIGHTS);

    const updated = await service.update(actor, 'profile-empty', { name: 'Updated empty' });
    assert.equal(updated.name, 'Updated empty');
    assert.deepEqual(updated.compensationPreferences, {});
    assert.deepEqual(updated.aiPreferences, {});
    assert.deepEqual(updated.matchWeights, DEFAULT_MATCH_WEIGHTS);

    const duplicate = await service.duplicate(actor, 'profile-populated');
    assert.equal(duplicate.name, 'Populated copy');
    assert.deepEqual(duplicate.compensationPreferences, { min: 250000 });
    assert.deepEqual(duplicate.aiPreferences, { language: 'ru' });
    assert.deepEqual(duplicate.matchWeights, { ...DEFAULT_MATCH_WEIGHTS, skills: 70, freshness: 20 });

    const active = await service.setActive(actor, 'profile-empty');
    assert.equal(active.isActive, true);
    assert.deepEqual(active.compensationPreferences, {});
    assert.deepEqual(active.aiPreferences, {});
    assert.deepEqual(active.matchWeights, DEFAULT_MATCH_WEIGHTS);
  });

  it('patches scalar fields without replacing existing match weights', async () => {
    const repository = new InMemoryProfilesRepository({
      _id: 'profile-1',
      userId: 'user-1',
      name: 'Old',
      matchWeights: { skills: 60, seniority: 10, money: 10, remoteLocation: 10, employment: 5, freshness: 3, source: 2 },
    });
    const service = new ProfilesService(repository);

    await service.update({ id: 'user-1', email: 'u@example.test', role: 'User' }, 'profile-1', { name: 'New' });

    assert.equal(repository.updatedInput.name, 'New');
    assert.equal('matchWeights' in repository.updatedInput, false);
    assert.equal(repository.clearActiveCalls, 0);
  });


  it('checks ownership before enqueueing profile recalculation', async () => {
    const repository = new InMemoryProfilesRepository({ _id: 'profile-1', userId: 'user-1', name: 'Owned' });
    const jobs = new InMemoryJobsService();
    const service = new ProfilesService(repository, jobs);

    const result = await service.recalculateMatch({ id: 'user-1', email: 'u@example.test', role: 'User' }, 'profile-1');

    assert.equal(result.profileId, 'profile-1');
    assert.deepEqual(jobs.enqueued.map((job) => [job.queue, job.name, job.data.profileId]), [
      ['analytics', 'profile.recalculateMatch', 'profile-1'],
    ]);
  });

  it('checks profile ownership before clearing active profile state', async () => {
    const repository = new InMemoryProfilesRepository(null);
    const service = new ProfilesService(repository);

    await assert.rejects(
      () => service.update({ id: 'user-1', email: 'u@example.test', role: 'User' }, 'missing', { isActive: true }),
      /Profile not found/,
    );
    assert.equal(repository.clearActiveCalls, 0);
  });
});


class InMemoryFilesService {
  constructor(items) {
    this.items = items;
    this.stored = [];
    this.generatedPaths = [];
  }

  async get() {
    return { id: 'file-1' };
  }

  async readForSystem() {
    return {
      file: { _id: 'file-1', originalName: 'opportunities.json', mimeType: 'application/json' },
      buffer: Buffer.from(JSON.stringify(this.items), 'utf8'),
    };
  }

  async storeBuffer(ownerUserId, buffer, mimeType, filename, metadata) {
    const file = {
      _id: `stored-file-${this.stored.length + 1}`,
      ownerUserId,
      buffer,
      mimeType,
      originalName: filename,
      metadata,
    };
    this.stored.push(file);
    return file;
  }

  async storeGeneratedFile(ownerUserId, path, mimeType, filename, metadata) {
    this.generatedPaths.push(path);
    return this.storeBuffer(ownerUserId, await readFile(path), mimeType, filename, metadata);
  }
}

class InMemoryStateRepository {
  records = [];
  lastFindMatching = null;

  async findForList(userId, opportunityIds, profileId) {
    return this.records.filter((record) =>
      record.userId === userId
      && opportunityIds.includes(record.opportunityId)
      && (!profileId || record.profileId === profileId),
    );
  }

  async findMatchingStates(userId, query) {
    this.lastFindMatching = { userId, query };
    return this.records
      .filter((record) => record.userId === userId)
      .filter((record) => !query.profileId || record.profileId === query.profileId)
      .filter((record) => query.favorite === undefined || record.favorite === query.favorite)
      .filter((record) => query.hidden === undefined || record.hidden === query.hidden)
      .filter((record) => query.archived === undefined || record.archived === query.archived)
      .filter((record) => query.minMatch === undefined || (record.matchScore ?? 0) >= query.minMatch)
      .filter((record) => !query.tags?.length || query.tags.every((tag) => record.tags?.includes(tag)));
  }

  async findMatchingOpportunityIds(userId, query) {
    const states = await this.findMatchingStates(userId, query);
    return states
      .map((record) => record.opportunityId)
      .filter((id, index, ids) => ids.indexOf(id) === index);
  }

  async upsert(input) {
    const state = { _id: `state-${this.records.length + 1}`, tags: [], ...input };
    this.records.push(state);
    return state;
  }
}

class InMemoryOpportunityRepository {
  records = [];
  aiRows = [];
  listForExportCalls = 0;
  listCanonicalCandidatesCalls = 0;
  iteratePrivateSortCandidatesCalls = 0;
  exportHydrationBatches = [];

  async findByOccurrence(sourceId, externalId, url) {
    return this.records.find((record) =>
      record.sourceOccurrences.some((occurrence) => {
        if (occurrence.sourceId !== sourceId) return false;
        return externalId ? occurrence.externalId === externalId : occurrence.url === url;
      }),
    ) ?? null;
  }

  async create(input) {
    const record = { _id: `opp-${this.records.length + 1}`, ...input };
    this.records.push(record);
    return record;
  }

  async getById(id) {
    const record = this.records.find((item) => item._id === id);
    if (!record) throw new Error('not found');
    return record;
  }

  async findByIds(ids) {
    return this.records.filter((record) => ids.includes(record._id));
  }

  async findForExportByIds(ids) {
    this.exportHydrationBatches.push(ids);
    return this.records.filter((item) => ids.includes(item._id)).map((item) => ({
      ...Object.fromEntries(['_id', 'type', 'title', 'companyOrClient', 'summary', 'description', 'skills', 'technologies', 'seniority', 'employmentType', 'location', 'remoteType', 'money', 'sourceStatus', 'publishedAt', 'firstSeenAt', 'deadline', 'canonicalTags'].map((key) => [key, item[key]])),
      sourceOccurrences: item.sourceOccurrences.map(({ sourceId, url }) => ({ sourceId, url })),
    }));
  }

  async findTypesByIds(ids) {
    return this.records.filter((item) => ids.includes(item._id)).map(({ _id, type }) => ({ _id, type }));
  }

  async list(query, restrictIds) {
    const limit = Math.min(query.limit ?? 50, 100);
    const items = this.filterRecords(query, restrictIds).slice(0, limit);
    return { items, nextCursor: null };
  }

  async listForExport(query, restrictIds, limit = 1000) {
    this.listForExportCalls += 1;
    return this.filterRecords(query, restrictIds).slice(0, limit);
  }

  async listCanonicalCandidates(query, restrictIds) {
    this.listCanonicalCandidatesCalls += 1;
    return this.filterRecords(query, restrictIds);
  }

  async *iteratePrivateSortCandidates(query, restrictIds, batchSize = 500, selectedOnly = false) {
    this.iteratePrivateSortCandidatesCalls += 1;
    const candidates = selectedOnly ? this.records.filter((item) => !restrictIds || restrictIds.includes(item._id)) : this.filterRecords(query, restrictIds);
    for (let index = 0; index < candidates.length; index += batchSize) {
      yield candidates.slice(index, index + batchSize).map((item) => ({
        ...Object.fromEntries(['_id', 'title', 'money', 'deadline', 'publishedAt', 'firstSeenAt', 'updatedAt', 'sourceStatus', 'skills', 'technologies', 'seniority', 'remoteType', 'location', 'employmentType'].map((key) => [key, item[key]])),
        sourceOccurrences: item.sourceOccurrences.map(({ sourceId }) => ({ sourceId })),
      }));
    }
  }

  async latestCompletedAnalysisByOpportunity(input) {
    const rows = this.aiRows
      .filter((row) => row.userId === input.userId)
      .filter((row) => row.taskType === 'opportunity_analysis')
      .filter((row) => row.status === 'completed')
      .filter((row) => !input.profileId || row.profileId === input.profileId)
      .filter((row) => !input.opportunityIds?.length || input.opportunityIds.includes(row.opportunityId))
      .filter((row) => typeof input.minAiScore !== 'number' || row.aiScore >= input.minAiScore)
      .sort((left, right) => {
        const score = (right.aiScore ?? -1) - (left.aiScore ?? -1);
        if (score !== 0) return score;
        return new Date(right.completedAt ?? 0).getTime() - new Date(left.completedAt ?? 0).getTime();
      });
    const byOpportunity = new Map();
    for (const row of rows) {
      if (!byOpportunity.has(row.opportunityId)) byOpportunity.set(row.opportunityId, row);
    }
    return [...byOpportunity.values()];
  }

  filterRecords(query = {}, restrictIds) {
    const allowed = restrictIds ? new Set(restrictIds) : null;
    const types = query.types?.length ? query.types : query.type ? [query.type] : undefined;
    const statuses = query.status?.length ? query.status : query.archive ? ['Closed', 'Expired', 'Removed'] : ['Active', 'Unknown'];
    return this.records
      .filter((record) => !allowed || allowed.has(record._id))
      .filter((record) => !types?.length || types.includes(record.type))
      .filter((record) => statuses.includes(record.sourceStatus ?? 'Unknown'))
      .filter((record) => !query.remoteType || record.remoteType === query.remoteType)
      .filter((record) => !query.sourceIds?.length || record.sourceOccurrences.some((occurrence) => query.sourceIds.includes(occurrence.sourceId)))
      .filter((record) => !query.query || [record.title, record.companyOrClient, ...(record.skills ?? []), ...(record.technologies ?? []), ...(record.canonicalTags ?? [])].some((value) => String(value ?? '').toLowerCase().includes(query.query.toLowerCase())))
      .sort((left, right) => new Date(right.firstSeenAt ?? 0).getTime() - new Date(left.firstSeenAt ?? 0).getTime());
  }

  async update(id, input) {
    const index = this.records.findIndex((item) => item._id === id);
    this.records[index] = { ...this.records[index], ...input };
    return this.records[index];
  }

  async upsertOccurrence(id, occurrence, patch) {
    const record = await this.getById(id);
    const index = record.sourceOccurrences.findIndex((existing) => {
      if (existing.sourceId !== occurrence.sourceId) return false;
      return existing.externalId && occurrence.externalId
        ? existing.externalId === occurrence.externalId
        : existing.url === occurrence.url;
    });
    const sourceOccurrences = [...record.sourceOccurrences];
    sourceOccurrences[index] = { ...sourceOccurrences[index], ...occurrence, firstSeenAt: sourceOccurrences[index].firstSeenAt };
    return this.update(id, { ...patch, sourceOccurrences });
  }
}

class InMemorySavedViewsRepository {
  constructor(view) {
    this.view = view;
  }

  async getById() {
    return this.view;
  }
}

class InMemoryProfilesRepository {
  clearActiveCalls = 0;
  updatedInput = null;

  constructor(profile) {
    this.profiles = Array.isArray(profile) ? profile : profile ? [profile] : [];
    this.profile = this.profiles[0] ?? null;
    this.created = [];
  }

  async listByUser(userId) {
    return this.profiles.filter((profile) => profile.userId === userId && !profile.deletedAt);
  }

  async listAll() {
    return this.profiles.filter((profile) => !profile.deletedAt);
  }

  async listForIngestionMatching() {
    return this.listAll();
  }

  async findActive(userId) {
    return this.profiles.find((profile) => profile.userId === userId && profile.isActive) ?? this.profiles.find((profile) => profile.userId === userId) ?? null;
  }

  async getOwned(id, userId) {
    const profile = this.profiles.find((item) => item._id === id && item.userId === userId);
    if (!profile) {
      throw new Error('Profile not found');
    }
    return profile;
  }

  async getById(id) {
    const profile = this.profiles.find((item) => item._id === id);
    if (!profile) {
      throw new Error('Profile not found');
    }
    return profile;
  }

  async create(input) {
    const created = { _id: input._id ?? `created-${this.created.length + 1}`, ...input };
    this.created.push(created);
    this.profiles.push(created);
    this.profile = created;
    return created;
  }

  async updateOwned(id, userId, input) {
    const profile = await this.getOwned(id, userId);
    this.updatedInput = input;
    const updated = { ...profile, ...input };
    const index = this.profiles.indexOf(profile);
    this.profiles[index] = updated;
    this.profile = updated;
    return updated;
  }

  async updateById(id, input) {
    const profile = await this.getById(id);
    this.updatedInput = input;
    const updated = { ...profile, ...input };
    const index = this.profiles.indexOf(profile);
    this.profiles[index] = updated;
    this.profile = updated;
    return updated;
  }

  async setActive(id, userId) {
    this.profiles = this.profiles.map((profile) => profile.userId === userId ? { ...profile, isActive: profile._id === id } : profile);
    this.profile = this.profiles.find((profile) => profile._id === id && profile.userId === userId) ?? this.profile;
    if (!this.profile) throw new Error('Profile not found');
    return this.profile;
  }

  async clearActive() {
    this.clearActiveCalls += 1;
  }
}

class InMemoryJobsService {
  enqueued = [];
  handlers = new Map();
  progress = [];

  registerHandler(queue, name, handler) {
    this.handlers.set(`${queue}/${name}`, handler);
  }

  async enqueue(queue, name, data, options) {
    if (this.enqueueError) throw this.enqueueError;
    const job = { id: options?.jobId ?? `${queue}-${name}-${this.enqueued.length + 1}`, queue, name, data, options };
    this.enqueued.push(job);
    return { id: job.id, queue };
  }

  async run(queue, name, data, options = {}) {
    const handler = this.handlers.get(`${queue}/${name}`);
    if (!handler) throw new Error(`No handler registered for ${queue}/${name}`);
    return handler(data, {
      attemptsMade: options.attemptsMade ?? 0,
      opts: { attempts: options.attempts ?? 1 },
      updateProgress: async (progress) => {
        this.progress.push(progress);
        if (progress === options.failProgress) throw new Error('progress unavailable');
      },
    });
  }
}

class InMemoryExportsRepository {
  records = [];

  async create(input) {
    const now = new Date();
    const record = { _id: `export-${this.records.length + 1}`, createdAt: now, updatedAt: now, ...input };
    this.records.push(record);
    return record;
  }

  async getById(id) {
    const record = this.records.find((item) => item._id === id);
    if (!record) throw new Error('Opportunity export not found');
    return record;
  }

  async update(id, input) {
    const index = this.records.findIndex((item) => item._id === id);
    if (index < 0) throw new Error('Opportunity export not found');
    this.records[index] = { ...this.records[index], ...input, updatedAt: new Date() };
    return this.records[index];
  }
}

class InMemoryNotificationsService {
  sent = [];

  async notify(input) {
    this.sent.push(input);
    return input;
  }
}
