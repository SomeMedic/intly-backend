#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { SOURCE_CATALOG } = require('../src/modules/sources/catalog/source-catalog.ts');
const { ConnectorRegistryService } = require('../src/modules/sources/connectors/connector-registry.service.ts');
const { HhConnector } = require('../src/modules/sources/connectors/hh.connector.ts');
const { RssFeedConnector } = require('../src/modules/sources/connectors/rss-feed.connector.ts');
const { PublicApiFeedConnector } = require('../src/modules/sources/connectors/public-api-feed.connector.ts');
const { AtsPublicBoardConnector } = require('../src/modules/sources/connectors/ats-public-board.connector.ts');
const { AuthenticatedAtsConnector } = require('../src/modules/sources/connectors/authenticated-ats.connector.ts');
const { AuthenticatedMarketplaceConnector } = require('../src/modules/sources/connectors/authenticated-marketplace.connector.ts');
const { AtsBoardDiscovery } = require('../src/modules/sources/connectors/ats-board-discovery.ts');
const { TelegramMtprotoConnector } = require('../src/modules/sources/connectors/telegram-mtproto.connector.ts');
const { VkWallConnector } = require('../src/modules/sources/connectors/vk-wall.connector.ts');
const { GenericPublicWebConnector } = require('../src/modules/sources/connectors/generic-public-web.connector.ts');
const { WebExtractionService } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');
const { SourceDeduplicationService } = require('../src/modules/sources/deduplication/source-deduplication.service.ts');
const { SourcesService } = require('../src/modules/sources/sources.service.ts');

const rootDir = resolve(new URL('..', import.meta.url).pathname);
const projectRoot = resolve(rootDir, '..');
const reportPath = resolve(projectRoot, '.local/reports/source-blocks.json');
const live = process.argv.includes('--live') || process.env.INTLY_SOURCE_LIVE === '1';
const startedAt = new Date().toISOString();
const runId = `source-blocks-${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;

const report = {
  ok: false,
  runId,
  startedAt,
  live,
  catalog: {},
  checks: [],
  liveSamples: [],
  skipped: [],
  warnings: [],
};

async function main() {
  await step('catalog.master-103-shape', () => {
    const counts = countBy(SOURCE_CATALOG, (source) => source.group);
    const families = countBy(SOURCE_CATALOG, (source) => source.connectorFamily);
    assert.equal(SOURCE_CATALOG.length, 103);
    assert.equal(counts.web, 53);
    assert.equal(counts.telegram, 35);
    assert.equal(counts.vk, 15);
    assert.equal(new Set(SOURCE_CATALOG.map((source) => source.id)).size, 103);
    report.catalog = { total: SOURCE_CATALOG.length, groups: counts, families };
    return report.catalog;
  });

  await step('registry.family-routing', () => {
    const registry = new ConnectorRegistryService(new WebExtractionService());
    const routed = [
      registry.get(source('hh')).id,
      registry.get(source('habr')).id,
      registry.get(source('remoteok')).id,
      registry.get(source('greenhouse')).id,
      registry.get(source('workable')).id,
      registry.get(source('upwork')).id,
      registry.get(source('freelancer_com')).id,
      registry.get(source('workspace')).id,
      registry.get(source('tg_workk_onchat')).id,
      registry.get(source('vk_freelance_work')).id,
    ];
    assert.deepEqual(routed, ['hh', 'habr', 'remoteok', 'greenhouse', 'workable', 'upwork', 'freelancer_com', 'generic-public-web', 'telegram-mtproto', 'vk-wall']);
    return { routed };
  });

  await step('credential-gates.no-secrets', async () => {
    const telegram = await new TelegramMtprotoConnector().validateConfig({ handle: '@workk_onchat', credentials: {} });
    const vk = await new VkWallConnector().validateConfig({ domain: 'freelance_work', credentials: {} });
    const superjob = await new PublicApiFeedConnector('superjob').validateConfig({});
    const freelancehunt = await new PublicApiFeedConnector('freelancehunt').validateConfig({});
    const adzuna = await new PublicApiFeedConnector('adzuna').validateConfig({});
    assert.equal(telegram.ok, false);
    assert.equal(vk.ok, false);
    assert.equal(superjob.ok, false);
    assert.equal(freelancehunt.ok, false);
    assert.equal(adzuna.ok, false);
    report.skipped.push(
      { family: 'TelegramMtproto', reason: 'Needs apiId, apiHash and encrypted MTProto session; dedicated account is allowed but credentials are not present.' },
      { family: 'VkWall', reason: 'Needs VK access token; no token is present in this acceptance run.' },
      { sourceId: 'superjob', reason: 'Needs API key; collection contract is validated but live fetch skipped.' },
      { sourceId: 'freelancehunt', reason: 'Needs API token; collection contract is validated but live fetch skipped.' },
      { sourceId: 'adzuna', reason: 'Needs app id/key; collection contract is validated but live fetch skipped.' },
    );
    return {
      telegram: telegram.message,
      vk: vk.message,
      superjob: superjob.message,
      freelancehunt: freelancehunt.message,
      adzuna: adzuna.message,
    };
  });

  await step('ats.discovery-and-multi-tenant-safety', async () => {
    const greenhouse = new AtsPublicBoardConnector('greenhouse');
    const lever = new AtsPublicBoardConnector('lever');
    const ashby = new AtsPublicBoardConnector('ashby');
    const personio = new AtsPublicBoardConnector('personio');
    assert.equal((await greenhouse.validateConfig({ tenants: ['airbnb'] })).ok, true);
    assert.equal((await lever.validateConfig({ tenants: ['wealthsimple'] })).ok, true);
    assert.equal((await ashby.validateConfig({ tenants: ['linear'] })).ok, true);
    assert.equal((await personio.validateConfig({ tenants: ['example.jobs.personio.de'] })).ok, true);
    assert.equal((await greenhouse.validateConfig({ tenants: ['localhost'] })).ok, false);
    assert.equal((await lever.validateConfig({ tenants: ['https://jobs.lever.co/netflix'] })).ok, false);

    const greenhouseDiscovery = new AtsBoardDiscovery('greenhouse');
    const leverDiscovery = new AtsBoardDiscovery('lever');
    const ashbyDiscovery = new AtsBoardDiscovery('ashby');
    const personioDiscovery = new AtsBoardDiscovery('personio');
    assert.deepEqual(greenhouseDiscovery.candidatesFromUrl('https://boards.greenhouse.io/airbnb/jobs/1').map((item) => item.tenant), ['airbnb']);
    assert.deepEqual(leverDiscovery.candidatesFromUrl('https://jobs.lever.co/wealthsimple/abc').map((item) => item.tenant), ['wealthsimple']);
    assert.deepEqual(ashbyDiscovery.candidatesFromUrl('https://jobs.ashbyhq.com/linear').map((item) => item.tenant), ['linear']);
    assert.deepEqual(personioDiscovery.candidatesFromUrl('https://example.jobs.personio.de/xml').map((item) => item.tenant), ['example.jobs.personio.de']);

    const discovered = [
      ...greenhouseDiscovery.candidatesFromHtml('<a href="https://job-boards.greenhouse.io/embed/job_board?for=airbnb">Jobs</a>', 'https://example.com/careers'),
      ...leverDiscovery.candidatesFromHtml('<a href="https://jobs.lever.co/wealthsimple">Jobs</a>', 'https://example.com/careers'),
      ...ashbyDiscovery.candidatesFromHtml('<a href="https://api.ashbyhq.com/posting-api/job-board/linear">Jobs</a>', 'https://example.com/careers'),
      ...personioDiscovery.candidatesFromHtml('<a href="https://example.jobs.personio.de/xml?language=en">Jobs</a>', 'https://example.com/careers'),
    ].map((item) => item.tenant);
    assert.deepEqual(discovered, ['airbnb', 'wealthsimple', 'linear', 'example.jobs.personio.de']);

    const originalFetch = globalThis.fetch;
    const fetchedUrls = [];
    globalThis.fetch = async (url) => {
      const text = String(url);
      fetchedUrls.push(text);
      if (text.includes('/boards/definitely-missing-intly-board/')) return { ok: false, status: 404, json: async () => ({}) };
      if (text.includes('/boards/airbnb/') || text.includes('/boards/stripe/') || text.includes('/boards/openai/')) {
        const tenant = text.includes('/boards/stripe/') ? 'stripe' : text.includes('/boards/openai/') ? 'openai' : 'airbnb';
        return {
          ok: true,
          status: 200,
          json: async () => ({ jobs: [{ id: tenant, absolute_url: `https://boards.greenhouse.io/${tenant}/jobs/1`, title: `${tenant} Fixture Engineer`, content: 'Fixture role' }] }),
        };
      }
      return originalFetch(url);
    };
    let multiTenant;
    let rotated;
    try {
      multiTenant = await greenhouse.fetchPage({
        source: withConfig(withLimits(source('greenhouse'), { maxTenantsPerRun: 2 }), { tenants: ['definitely-missing-intly-board', 'airbnb'] }),
        requestId: runId,
        checkpoint: {},
        backfillDays: 30,
        signal: AbortSignal.timeout(30_000),
      });
      rotated = await greenhouse.fetchPage({
        source: withConfig(withLimits(source('greenhouse'), { maxTenantsPerRun: 2 }), { tenants: ['airbnb', 'stripe', 'openai'] }),
        requestId: runId,
        checkpoint: { tenantCursor: 1 },
        backfillDays: 30,
        signal: AbortSignal.timeout(30_000),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(multiTenant.records.length > 0, 'ATS fetchPage must continue across multiple tenants after a failed tenant');
    assert.ok(Array.isArray(multiTenant.checkpoint.errors));
    assert.equal(multiTenant.checkpoint.errors.length, 1);
    assert.deepEqual(rotated.checkpoint.tenants, ['stripe', 'openai']);
    assert.equal(rotated.checkpoint.tenantCursor, 0);
    return { seededFamilies: ['greenhouse', 'lever', 'ashby', 'personio'], unsafeRejected: true, discoveryFixtures: discovered, multiTenantRecords: multiTenant.records.length, rotatedTenants: rotated.checkpoint.tenants, fetchedUrls: fetchedUrls.length };
  });



  await step('credentialed-runtime-families.fetch-and-safety', async () => {
    const workable = new AuthenticatedAtsConnector('workable');
    const upwork = new AuthenticatedMarketplaceConnector('upwork');
    const freelancer = new AuthenticatedMarketplaceConnector('freelancer_com');
    assert.equal((await workable.validateConfig({ subdomain: 'acme', credentials: {} })).ok, false);
    assert.equal((await workable.validateConfig({ subdomain: 'localhost', credentials: { token: 'secret-workable-token' } })).ok, false);
    assert.equal((await upwork.validateConfig({ credentials: {} })).ok, false);
    assert.equal((await upwork.validateConfig({ apiBaseUrl: 'https://evil.example', credentials: { accessToken: 'secret-upwork-token' } })).ok, false);
    assert.equal((await freelancer.validateConfig({ apiBaseUrl: 'http://www.freelancer.com', credentials: { token: 'secret-freelancer-token' } })).ok, false);

    const originalFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, options = {}) => {
      const text = String(url);
      seen.push({ url: text, headers: options.headers ?? {} });
      if (text.startsWith('https://acme.workable.com/spi/v3/jobs')) {
        assert.equal(options.headers.Authorization, 'Bearer secret-workable-token');
        return fixtureJson({ jobs: [{ id: 'w1', shortcode: 'ABC123', title: 'Fixture Platform Engineer', full_description: 'Build ATS integrations.', published_on: '2026-10-01T10:00:00Z', url: 'https://acme.workable.com/jobs/ABC123', location: { city: 'Remote' }, department: { name: 'Engineering' } }], paging: { next: 'https://acme.workable.com/spi/v3/jobs?limit=5&since_id=w1' } });
      }
      if (text === 'https://api.upwork.com/graphql') {
        assert.equal(options.headers.Authorization, 'Bearer secret-upwork-token');
        const body = JSON.parse(options.body);
        assert.match(body.query, /marketplaceJobPostingsSearch/);
        assert.equal(body.variables.filter.searchExpression_eq, 'typescript');
        assert.deepEqual(body.variables.filter.pagination_eq, { after: '0', first: 5 });
        return fixtureJson({ data: { marketplaceJobPostingsSearch: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: 'cursor-1' }, edges: [{ cursor: 'cursor-1', node: { id: 'u1', ciphertext: 'cipher-u1', title: 'Fixture Upwork integration project', description: 'Need API extraction and normalization.', publishedDateTime: '2026-10-02T10:00:00Z', amount: { displayValue: '$500', currency: 'USD' }, hourlyBudgetMin: { rawValue: 25, currency: 'USD' }, hourlyBudgetMax: { rawValue: 50, currency: 'USD' }, skills: [{ name: 'TypeScript' }], client: { totalFeedback: 5, location: { country: 'US', city: 'Remote' } } } }] } } });
      }
      if (text.startsWith('https://www.freelancer.com/api/projects/0.1/projects/active/')) {
        assert.equal(options.headers['Freelancer-OAuth-V1'], 'secret-freelancer-token');
        return fixtureJson({ result: { projects: [{ id: 77, title: 'Fixture Freelancer connector project', description: 'Collect marketplace cards safely.', submitdate: 1790935200, seo_url: 'typescript/fixture', budget: { minimum: 100, maximum: 300 }, currency: { code: 'USD' }, jobs: [{ name: 'TypeScript' }] }] } });
      }
      return fixtureJson({}, 404);
    };
    let workablePage;
    let upworkPage;
    let freelancerPage;
    try {
      workablePage = await workable.fetchPage({ source: withConfig(source('workable'), { subdomain: 'acme' }), requestId: runId, credentials: { token: 'secret-workable-token' }, checkpoint: {}, backfillDays: 30 });
      upworkPage = await upwork.fetchPage({ source: withLimits(withConfig(source('upwork'), { searchText: 'typescript' }), { perPage: 5 }), requestId: runId, credentials: { accessToken: 'secret-upwork-token' }, checkpoint: {}, backfillDays: 30 });
      freelancerPage = await freelancer.fetchPage({ source: withConfig(source('freelancer_com'), { searchText: 'typescript' }), requestId: runId, credentials: { token: 'secret-freelancer-token' }, checkpoint: {}, backfillDays: 30 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(workablePage.records[0].title, 'Fixture Platform Engineer');
    assert.equal(workablePage.checkpoint.nextUrl, 'https://acme.workable.com/spi/v3/jobs?limit=5&since_id=w1');
    assert.equal(workablePage.records[0].url, 'https://acme.workable.com/jobs/ABC123');
    assert.equal(upworkPage.records[0].type, 'freelance');
    assert.equal(upworkPage.records[0].sourceMetadata.budget.originalText, '$500');
    assert.equal(upworkPage.records[0].sourceMetadata.budget.min, 25);
    assert.equal(freelancerPage.records[0].url, 'https://www.freelancer.com/projects/typescript/fixture');
    assert.equal(freelancerPage.records[0].sourceMetadata.budget.min, 100);
    assert.equal(freelancerPage.records[0].sourceMetadata.budget.currency, 'USD');
    assert.equal(workablePage.hasMore, true);
    assert.equal(upworkPage.checkpoint.page, 0);
    assert.equal(upworkPage.checkpoint.cursor, undefined);
    assert.equal(freelancerPage.checkpoint.page, 0);
    const serialized = JSON.stringify({ workablePage, upworkPage, freelancerPage });
    assert.equal(serialized.includes('secret-workable-token'), false);
    assert.equal(serialized.includes('secret-upwork-token'), false);
    assert.equal(serialized.includes('secret-freelancer-token'), false);
    return { records: { workable: workablePage.records.length, upwork: upworkPage.records.length, freelancer: freelancerPage.records.length }, requests: seen.map((item) => new URL(item.url).host) };
  });


  await step('credentialed-runtime-families.runtime-pagination-boundary', async () => {
    const workable = new AuthenticatedAtsConnector('workable');
    const upwork = new AuthenticatedMarketplaceConnector('upwork');
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const text = String(url);
      calls.push({ url: text, body: options.body });
      if (text.startsWith('https://evil.example/')) throw new Error('unsafe checkpoint nextUrl was fetched');
      if (text.startsWith('https://acme.workable.com/spi/v3/jobs')) {
        return fixtureJson({ jobs: [{ id: 'safe-w1', shortcode: 'SAFE1', title: 'Safe Workable page', url: 'https://acme.workable.com/jobs/SAFE1' }] });
      }
      if (text === 'https://api.upwork.com/graphql') {
        const body = JSON.parse(options.body);
        return fixtureJson({ data: { marketplaceJobPostingsSearch: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: body.variables.filter.pagination_eq.after === '0' ? 'fresh-cursor' : 'old-cursor' }, edges: [{ cursor: 'fresh-cursor', node: { id: `upwork-${calls.length}`, title: 'Fresh Upwork top result', description: 'Second scheduled run starts at top.', publishedDateTime: '2026-10-02T10:00:00Z' } }] } } });
      }
      return fixtureJson({}, 404);
    };
    let workablePage;
    let firstUpwork;
    let secondUpwork;
    try {
      workablePage = await workable.fetchPage({ source: withConfig(source('workable'), { subdomain: 'acme' }), requestId: runId, credentials: { token: 'secret-workable-token' }, checkpoint: { nextUrl: 'https://evil.example/spi/v3/jobs?leak=true' }, backfillDays: 30 });
      firstUpwork = await upwork.fetchPage({ source: withLimits(withConfig(source('upwork'), { searchText: 'typescript' }), { perPage: 5 }), requestId: runId, credentials: { accessToken: 'secret-upwork-token' }, checkpoint: { page: 4, cursor: 'stale-terminal-cursor', hasMore: false }, backfillDays: 30 });
      secondUpwork = await upwork.fetchPage({ source: withLimits(withConfig(source('upwork'), { searchText: 'typescript' }), { perPage: 5 }), requestId: runId, credentials: { accessToken: 'secret-upwork-token' }, checkpoint: firstUpwork.checkpoint, backfillDays: 30 });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const upworkBodies = calls.filter((call) => call.url === 'https://api.upwork.com/graphql').map((call) => JSON.parse(call.body));
    assert.equal(workablePage.records[0].externalId, 'safe-w1');
    assert.equal(calls.some((call) => call.url.startsWith('https://evil.example/')), false);
    assert.deepEqual(upworkBodies.map((body) => body.variables.filter.pagination_eq), [{ after: '0', first: 5 }, { after: '0', first: 5 }]);
    assert.equal(firstUpwork.checkpoint.page, 0);
    assert.equal(secondUpwork.checkpoint.page, 0);
    return { workableFetchedHost: new URL(calls[0].url).host, upworkPagination: upworkBodies.map((body) => body.variables.filter.pagination_eq) };
  });

  await step('credentialed-runtime-families.encrypted-service-resolution', async () => {
    const sourceItem = withConfig(source('upwork'), { searchText: 'typescript' });
    sourceItem.enabled = true;
    sourceItem.runtimeState = 'Enabled';
    sourceItem.credentialsEncrypted = 'encrypted-upwork-json';
    const state = { source: sourceItem, run: { _id: 'credentialed-run', sourceId: 'upwork', runType: 'scheduled', status: 'Queued', checkpointBefore: {}, requestMetadata: {} } };
    const fakeConnector = {
      id: 'upwork',
      family: 'AuthenticatedMarketplace',
      validateConfig: async (config) => ({ ok: config.credentials?.accessToken === 'secret-upwork-token', message: 'credentials required' }),
      fetchPage: async ({ credentials }) => {
        assert.equal(credentials.accessToken, 'secret-upwork-token');
        return { records: [rawFixture('credentialed-1', 'freelance', { marketplace: 'upwork' })], checkpoint: { page: 1 }, hasMore: false, stats: { seen: 1 } };
      },
      checkpoint: (page) => page.checkpoint,
      healthCheck: async () => ({ state: 'Healthy', checkedAt: new Date() }),
    };
    const repo = {
      startRun: async () => ({ ...state.run, status: 'Running' }),
      getRun: async () => ({ ...state.run, status: 'Running' }),
      get: async () => state.source,
      update: async (_id, input) => { state.source = { ...state.source, ...input, config: input.config ?? state.source.config }; return state.source; },
      updateCheckpoint: async (_id, checkpoint) => { state.source.checkpoint = checkpoint; },
      updateRun: async (_id, input) => ({ ...state.run, ...input }),
      updateHealth: async () => undefined,
      createDlq: async () => undefined,
    };
    const service = new SourcesService(
      repo,
      { get: () => fakeConnector },
      { normalize: (_source, record) => record },
      { collapseBatch: (records) => ({ records, duplicates: 0 }) },
      { decrypt: (value) => {
        assert.equal(value, 'encrypted-upwork-json');
        return JSON.stringify({ accessToken: 'secret-upwork-token' });
      }, encrypt: (value) => value },
      { record: async () => undefined },
      { registerHandler: () => undefined, enqueue: async () => undefined, queue: () => ({ add: async () => undefined }) },
      { publish: () => undefined },
      { ingestFromSource: async ({ records }) => ({ seen: records.length, normalized: records.length, upserted: records.length, created: records.length, updated: 0, duplicates: 0, failed: 0 }) },
    );
    const finished = await service.executeRun('credentialed-run', 30);
    assert.equal(finished.status, 'Succeeded');
    assert.equal(JSON.stringify(finished).includes('secret-upwork-token'), false);
    return { status: finished.status, checkpoint: state.source.checkpoint };
  });

  await step('ats.service-auto-discovery-before-polling', async () => {
    const sourceItem = withConfig(source('greenhouse'), { discoveryUrls: ['https://boards.greenhouse.io/airbnb'] });
    sourceItem.config.tenants = [];
    const state = { source: sourceItem, run: { _id: 'ats-auto-run', sourceId: 'greenhouse', runType: 'scheduled', status: 'Queued', checkpointBefore: {}, requestMetadata: {} } };
    const fakeConnector = {
      id: 'greenhouse',
      family: 'AtsPublicBoard',
      discover: async () => ({ ok: true, message: 'fixture discovery', details: { tenants: ['airbnb'], candidatesChecked: 1 } }),
      validateConfig: async (config) => ({ ok: Array.isArray(config.tenants) && config.tenants.includes('airbnb'), message: 'tenants required' }),
      fetchPage: async ({ source: fetchSource }) => {
        assert.deepEqual(fetchSource.config.tenants, ['airbnb']);
        return { records: [rawFixture('ats-auto-1', 'vacancy', { tenant: 'airbnb' })], checkpoint: { tenantCursor: 0 }, hasMore: false, stats: { seen: 1 } };
      },
      checkpoint: (page) => page.checkpoint,
      healthCheck: async () => ({ state: 'Healthy', checkedAt: new Date() }),
    };
    const updates = [];
    const repo = {
      startRun: async () => ({ ...state.run, status: 'Running' }),
      getRun: async () => ({ ...state.run, status: 'Running' }),
      get: async () => state.source,
      update: async (_id, input) => {
        updates.push(input);
        state.source = { ...state.source, ...input, config: input.config ?? state.source.config };
        return state.source;
      },
      updateCheckpoint: async (_id, checkpoint) => { state.source.checkpoint = checkpoint; },
      updateRun: async (_id, input) => ({ ...state.run, ...input }),
      updateHealth: async () => undefined,
      createDlq: async () => undefined,
    };
    const service = new SourcesService(
      repo,
      { get: () => fakeConnector },
      { normalize: (_source, record) => record },
      { collapseBatch: (records) => ({ records, duplicates: 0 }) },
      { decrypt: (value) => value, encrypt: (value) => value },
      { record: async () => undefined },
      { registerHandler: () => undefined, enqueue: async () => undefined, queue: () => ({ add: async () => undefined }) },
      { publish: () => undefined },
      { ingestFromSource: async ({ records }) => ({ seen: records.length, normalized: records.length, upserted: records.length, created: records.length, updated: 0, duplicates: 0, failed: 0 }) },
    );
    assert.equal(service.shouldSchedule(sourceItem), true);
    const finished = await service.executeRun('ats-auto-run', 30);
    assert.equal(finished.status, 'Succeeded');
    assert.deepEqual(state.source.config.tenants, ['airbnb']);
    assert.equal(state.source.config.atsDiscovery.tenantsFound, 1);
    assert.ok(updates.some((item) => item.config?.tenants?.includes('airbnb')), 'auto-discovery must persist tenants before fetch');
    return { persistedTenants: state.source.config.tenants, discoveryState: state.source.config.atsDiscovery };
  });


  await step('public-html.weblancer-card-or-zero', async () => {
    const cardHtml = `<html><body>
      <article class="bg-white p-6 rounded-md shadow hover:shadow-md transition-shadow relative">
        <div><h2 class="text-xl"><a href="/freelance/dizain-saitov-9/veb-dizainer-dlya-uluchsheniya-vizuala-saita-1269668/">Веб-дизайнер для улучшения визуала сайта</a></h2>
        <span class="text-green-600 text-xl whitespace-nowrap">3300<!-- --> $</span></div>
        <p class="text-gray-600 flex-grow">Требуется веб-дизайнер для косметического ремонта сайта B2B-поставщика.</p>
        <div><a href="/freelance/dizain-saitov/">Дизайн сайтов</a><a href="/freelance/figma/">Figma</a></div>
        <div><span>01.10.2026</span><span>9 заявок</span><span>1474 просмотра</span></div>
      </article>
      <h1>Фриланс — свежие заказы и поиск фрилансеров</h1>
    </body></html>`;
    const landingHtml = '<html><head><title>Фриланс — свежие заказы и поиск фрилансеров | Weblancer</title></head><body><h1>Каталог фрилансеров</h1></body></html>';
    const connectorWithHtml = (html) => new GenericPublicWebConnector({
      extractUrl: async () => ({ finalUrl: 'https://www.weblancer.net/freelance/', html, metadata: { firecrawl: false } }),
      extractOpportunityLinks: () => [],
      extractOpportunityFromUrl: async () => { throw new Error('Weblancer must not use generic document fallback'); },
    });
    const cardPage = await connectorWithHtml(cardHtml).fetchPage({ source: source('weblancer'), requestId: runId, checkpoint: {}, backfillDays: 30 });
    const emptyPage = await connectorWithHtml(landingHtml).fetchPage({ source: source('weblancer'), requestId: runId, checkpoint: {}, backfillDays: 30 });
    assert.equal(cardPage.records.length, 1);
    assert.equal(cardPage.records[0].externalId, '1269668');
    assert.equal(cardPage.records[0].title, 'Веб-дизайнер для улучшения визуала сайта');
    assert.equal(cardPage.records[0].url, 'https://www.weblancer.net/freelance/dizain-saitov-9/veb-dizainer-dlya-uluchsheniya-vizuala-saita-1269668/');
    assert.equal(cardPage.records[0].sourceMetadata.extraction, 'weblancer-html');
    assert.equal(cardPage.records[0].sourceMetadata.price.amount, 3300);
    assert.equal(cardPage.records[0].sourceMetadata.price.currency, 'USD');
    assert.deepEqual(cardPage.records[0].sourceMetadata.categoryTags, ['Дизайн сайтов', 'Figma']);
    assert.equal(emptyPage.records.length, 0);
    assert.match(String(emptyPage.checkpoint.issue), /no project cards|landing\/catalog text/i);
    return { cardRecords: cardPage.records.length, emptyRecords: emptyPage.records.length, issue: emptyPage.checkpoint.issue };
  });

  await step('normalization.salary-and-metadata', () => {
    const normalizer = new SourceNormalizerService();
    const hh = normalizer.normalize(source('hh'), rawFixture('hh-1', 'vacancy', { salary: { from: 250000, to: 320000, currency: 'RUB', gross: false }, skills: ['TypeScript', 'NestJS'] }));
    const remoteok = normalizer.normalize(source('remoteok'), rawFixture('remoteok-1', 'vacancy', { salary: { min: 70000, max: 110000, currency: 'USD' }, skills: ['Remote', 'Node.js'] }));
    assert.equal(hh.money.min, 250000);
    assert.equal(hh.money.max, 320000);
    assert.equal(hh.money.gross, false);
    assert.equal(remoteok.money.min, 70000);
    assert.equal(remoteok.money.max, 110000);
    assert.deepEqual(remoteok.technologies, ['Remote', 'Node.js']);
    assert.equal(hh.sourceOccurrences[0].status, 'Active');
    return {
      hhMoney: hh.money,
      remoteOkMoney: remoteok.money,
      tags: remoteok.canonicalTags,
    };
  });

  await step('dedup.source-external-id', () => {
    const normalizer = new SourceNormalizerService();
    const dedup = new SourceDeduplicationService();
    const first = normalizer.normalize(source('hh'), rawFixture('dup-1', 'vacancy', { skills: ['Python'] }));
    const duplicate = normalizer.normalize(source('hh'), rawFixture('dup-1', 'vacancy', { skills: ['Python'] }));
    const sameTitleOtherSource = normalizer.normalize(source('remoteok'), rawFixture('dup-1', 'vacancy', { skills: ['Python'] }));
    const result = dedup.collapseBatch([first, duplicate, sameTitleOtherSource]);
    assert.equal(result.duplicates, 1);
    assert.equal(result.records.length, 2);
    return { input: 3, output: result.records.length, duplicates: result.duplicates };
  });

  if (live) {
    await liveStep('hh.public-api', source('hh'), new HhConnector(), { backfillDays: 30, page: 0, limits: { perPage: 3 } });
    await liveStep('habr.rss', source('habr'), new RssFeedConnector('habr', 'https://career.habr.com/vacancies/rss'), { backfillDays: 30 });
    await liveStep('remoteok.public-api', source('remoteok'), new PublicApiFeedConnector('remoteok'), { backfillDays: 30 });
    await liveStep('remotive.public-api', source('remotive'), new PublicApiFeedConnector('remotive'), { backfillDays: 30 });
    await liveStep('hackernews.public-api', source('hackernews_whoishiring'), new PublicApiFeedConnector('hackernews_whoishiring'), { backfillDays: 45, limits: { perPage: 5 } });
    await liveDiscoveryStep('greenhouse.discovery', withConfig(source('greenhouse'), { discoveryUrls: ['https://boards.greenhouse.io/airbnb'] }), new AtsPublicBoardConnector('greenhouse'));
    await liveStep('greenhouse.seeded-board', withConfig(source('greenhouse'), { tenants: ['airbnb'] }), new AtsPublicBoardConnector('greenhouse'), { backfillDays: 30 });
    await liveStep('lever.seeded-board', withConfig(source('lever'), { tenants: ['wealthsimple'] }), new AtsPublicBoardConnector('lever'), { backfillDays: 30 });
    await liveDiscoveryStep('ashby.discovery', withConfig(source('ashby'), { discoveryUrls: ['https://jobs.ashbyhq.com/linear'] }), new AtsPublicBoardConnector('ashby'));
    await liveStep('ashby.seeded-board', withConfig(source('ashby'), { tenants: ['linear'] }), new AtsPublicBoardConnector('ashby'), { backfillDays: 30 });
    await liveStep('public-html.workspace', source('workspace'), new GenericPublicWebConnector(new WebExtractionService()), { backfillDays: 30, limits: { maxPages: 2 } });
    await liveStep('public-html.fl-ru', source('fl_ru'), new GenericPublicWebConnector(new WebExtractionService()), { backfillDays: 30, limits: { maxPages: 2 } });
    await liveStep('public-html.kwork', source('kwork'), new GenericPublicWebConnector(new WebExtractionService()), { backfillDays: 30, limits: { maxPages: 2 } });
    await liveStep('public-html.weblancer', source('weblancer'), new GenericPublicWebConnector(new WebExtractionService()), { backfillDays: 30, limits: { maxPages: 2 } });
  } else {
    report.skipped.push({ block: 'live-public-smoke', reason: 'Run with --live or INTLY_SOURCE_LIVE=1 to fetch public endpoints.' });
  }

  await step('coverage.truthful-family-state', () => {
    const implementedFamilies = new Set(['OfficialRestApi', 'OfficialFeed', 'AtsPublicBoard', 'AtsAuthenticated', 'AuthenticatedMarketplace', 'PublicHtml', 'TenderPlatform', 'TelegramMtproto', 'VkWall']);
    const catalogFamilies = new Set(SOURCE_CATALOG.map((item) => item.connectorFamily));
    const missingFamilies = [...catalogFamilies].filter((family) => !implementedFamilies.has(family));
    assert.deepEqual(missingFamilies.sort(), []);
    const runtimeRequired = SOURCE_CATALOG.filter((item) => item.policy?.runtimeVerificationRequired).length;
    const credentialed = SOURCE_CATALOG.filter((item) => item.authCredentialRef).length;
    report.warnings.push('ATS discovery validates public board candidates from configured discovery URLs/hosts and expands collection across discovered tenants; it does not prove unknown boards that were never discovered.');
    report.warnings.push('Credentialed ATS/marketplace connectors are implemented as configured read-only fetch paths; live proof requires user-provided API credentials and is intentionally skipped in this public run.');
    report.warnings.push('Paid responses/submissions are intentionally out of scope; acceptance covers collection/read paths only.');
    return {
      implementedFamilies: [...implementedFamilies].sort(),
      missingFamilies,
      runtimeVerificationRequiredSources: runtimeRequired,
      credentialedSources: credentialed,
    };
  });

  report.ok = true;
}

async function liveDiscoveryStep(name, baseSource, connector) {
  await step(name, async () => {
    const sourceItem = withLimits(baseSource, {});
    let result;
    try {
      result = await connector.discover({
        source: sourceItem,
        requestId: runId,
        signal: AbortSignal.timeout(Number(process.env.INTLY_SOURCE_LIVE_TIMEOUT_MS ?? 45_000)),
      });
    } catch (error) {
      const failure = {
        name,
        sourceId: sourceItem._id,
        endpoint: publicEndpoint(sourceItem),
        status: 'failed',
        error: sanitizeError(error).message,
      };
      report.liveSamples.push(failure);
      report.warnings.push(`${name} live discovery failed: ${failure.error}`);
      return failure;
    }
    assert.equal(result.ok, true, `${name} must discover at least one validated tenant`);
    const tenants = Array.isArray(result.details?.tenants) ? result.details.tenants : [];
    assert.ok(tenants.length > 0, `${name} must return tenant details`);
    report.liveSamples.push({
      name,
      sourceId: sourceItem._id,
      endpoint: publicEndpoint(sourceItem),
      status: 'discovered',
      tenants,
      candidatesChecked: result.details?.candidatesChecked,
      checkedUrls: result.details?.checkedUrls,
    });
    return { tenants, candidatesChecked: result.details?.candidatesChecked };
  });
}

async function liveStep(name, baseSource, connector, options) {
  await step(name, async () => {
    const testSource = withLimits(baseSource, options.limits ?? {});
    let page;
    try {
      page = await connector.fetchPage({
        source: testSource,
        requestId: runId,
        checkpoint: {},
        backfillDays: options.backfillDays ?? 30,
        page: options.page,
        signal: AbortSignal.timeout(Number(process.env.INTLY_SOURCE_LIVE_TIMEOUT_MS ?? 45_000)),
      });
    } catch (error) {
      const failure = {
        name,
        sourceId: testSource._id,
        endpoint: publicEndpoint(testSource),
        status: 'failed',
        error: sanitizeError(error).message,
      };
      report.liveSamples.push(failure);
      report.warnings.push(`${name} live fetch failed: ${failure.error}`);
      return failure;
    }
    assert.ok(Array.isArray(page.records), `${name} must return records array`);
    assert.ok(page.stats.seen >= page.records.length, `${name} stats.seen must cover returned records`);
    if (page.records.length === 0) {
      report.warnings.push(`${name} returned zero currently visible records; endpoint reached but sample is empty.`);
    }
    if (name === 'public-html.workspace') assertWorkspaceTenderQuality(page.records);
    if (name === 'public-html.fl-ru') assertFlRuProjectQuality(page.records);
    if (name === 'public-html.kwork') assertKworkNoCards(page);
    if (name === 'public-html.weblancer') assertWeblancerQuality(page);
    if (name.startsWith('public-html.') && !['public-html.workspace', 'public-html.fl-ru', 'public-html.kwork', 'public-html.weblancer'].includes(name)) warnWeakGenericHtml(name, page.records);
    const sample = page.records.slice(0, 3).map((record) => ({
      externalId: record.externalId,
      title: record.title,
      type: record.type,
      urlHost: safeHost(record.url),
      publishedAt: record.publishedAt?.toISOString?.(),
      descriptionPreview: record.description?.slice(0, 180),
      money: record.sourceMetadata?.budget ?? record.sourceMetadata?.salary,
      deadlineAt: record.sourceMetadata?.deadlineAt,
    }));
    report.liveSamples.push({
      name,
      sourceId: testSource._id,
      endpoint: publicEndpoint(testSource),
      seen: page.stats.seen,
      returned: page.records.length,
      hasMore: page.hasMore,
      checkpointKeys: Object.keys(page.checkpoint ?? {}),
      sample,
    });
    return { seen: page.stats.seen, returned: page.records.length, hasMore: page.hasMore, sample };
  });
}

function assertWorkspaceTenderQuality(records) {
  assert.ok(records.length > 0, 'Workspace must return tender cards');
  for (const record of records) {
    assert.equal(record.type, 'tender');
    assert.match(record.externalId, /^\d+$/);
    assert.notEqual(record.title, 'Workspace');
    assert.ok(record.title.length > 20, 'Workspace tender title should be a real card title');
    assert.equal(safeHost(record.url), 'workspace.ru');
    assert.ok(record.description && record.description !== record.title, 'Workspace tender should include public detail description');
    assert.ok(record.sourceMetadata?.budget?.originalText, 'Workspace tender should include budget text when present in card');
    assert.ok(record.sourceMetadata?.deadlineAt, 'Workspace tender should include deadline when present in card');
  }
}

function warnWeakGenericHtml(name, records) {
  if (records.length === 0) return;
  const uniqueTitles = new Set(records.map((record) => record.title));
  const weakTitle = records.some((record) => /^(kwork\.ru|удаленная работа на дому|фриланс|fl\.ru|freelance|weblancer)/i.test(record.title));
  if (uniqueTitles.size <= 1 || weakTitle) {
    report.warnings.push(`${name} reached public HTML but generic extraction appears weak; source-specific parser/fixture is still required before claiming card-level coverage.`);
  }
}

function assertFlRuProjectQuality(records) {
  assert.ok(records.length > 0, 'FL.ru must return project cards');
  for (const record of records) {
    assert.match(record.externalId, /^\d+$/);
    assert.notEqual(record.title, 'Удаленная работа на дому для фрилансеров в интернете на FL.ru');
    assert.ok(record.title.length > 5, 'FL.ru project title should be a real card title');
    assert.equal(safeHost(record.url), 'www.fl.ru');
    assert.ok(record.description && record.description !== record.title, 'FL.ru project should include card description');
    assert.equal(record.sourceMetadata?.extraction, 'fl-ru-html');
  }
}


function assertWeblancerQuality(page) {
  if (page.records.length === 0) {
    assert.match(String(page.checkpoint?.issue ?? ''), /no project cards|landing\/catalog text/i);
    report.warnings.push(String(page.checkpoint.issue));
    return;
  }
  for (const record of page.records) {
    assert.equal(record.type, 'freelance');
    assert.match(record.externalId, /^\d+$/);
    assert.equal(safeHost(record.url), 'www.weblancer.net');
    assert.match(record.url, /\/freelance\/.+-\d+\/$/);
    assert.ok(!/^(фриланс|freelance|weblancer|каталог фрилансеров|биржа заказов)/i.test(record.title), 'Weblancer title must be a project card, not landing/catalog text');
    assert.ok(record.description && record.description !== record.title, 'Weblancer project should include card description');
    assert.equal(record.sourceMetadata?.extraction, 'weblancer-html');
  }
}

function assertKworkNoCards(page) {
  assert.equal(page.records.length, 0, 'Kwork must not emit landing page as a fake project record');
  assert.match(String(page.checkpoint?.issue ?? ''), /no project cards|client-rendered shell/i);
  report.warnings.push(String(page.checkpoint.issue));
}

async function step(name, fn) {
  const item = { name, ok: false, startedAt: new Date().toISOString() };
  report.checks.push(item);
  try {
    item.result = await fn();
    item.ok = true;
  } catch (error) {
    item.error = sanitizeError(error);
    throw error;
  } finally {
    item.finishedAt = new Date().toISOString();
  }
  return item.result;
}

function source(id) {
  const entry = SOURCE_CATALOG.find((item) => item.id === id);
  assert.ok(entry, `Missing source ${id}`);
  return {
    _id: entry.id,
    name: entry.name,
    group: entry.group,
    category: entry.category,
    opportunityTypes: entry.opportunityTypes,
    connectorFamily: entry.connectorFamily,
    runtimeState: entry.defaultState,
    enabled: entry.defaultEnabled,
    intervalSeconds: entry.defaultIntervalSeconds,
    timeoutMs: Math.min(entry.defaultTimeoutMs, Number(process.env.INTLY_SOURCE_TIMEOUT_MS ?? entry.defaultTimeoutMs)),
    endpoint: entry.endpoint ?? {},
    config: {},
    limits: { perPage: 5, maxPages: 2 },
    authCredentialRef: entry.authCredentialRef,
    proxyPoolEnabled: entry.proxyPoolEnabled,
    parserVersion: entry.parserVersion,
    normalizationProfile: entry.normalizationProfile,
    refreshPolicy: entry.refreshPolicy,
    checkpoint: {},
    checkpointStrategy: entry.checkpointStrategy,
    healthState: 'Unknown',
    dedupPriority: entry.dedupPriority,
    sourceRole: entry.sourceRole,
    policy: entry.policy,
    unavailableReason: entry.unavailableReason,
  };
}

function withConfig(baseSource, config) {
  return { ...baseSource, config: { ...baseSource.config, ...config } };
}

function withLimits(baseSource, limits) {
  return { ...baseSource, limits: { ...baseSource.limits, ...limits } };
}

function fixtureJson(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => payload,
  };
}

function rawFixture(externalId, type, metadata) {
  return {
    externalId,
    url: `https://example.com/${externalId}`,
    type,
    title: 'Senior Backend Engineer',
    companyOrClient: 'Example Client',
    description: 'Backend API, integrations and data processing.',
    publishedAt: new Date('2026-10-01T10:00:00.000Z'),
    updatedAt: new Date('2026-10-02T10:00:00.000Z'),
    sourceStatus: 'Active',
    rawPayload: { id: externalId, title: 'Senior Backend Engineer', metadata },
    sourceMetadata: metadata,
  };
}

function countBy(items, select) {
  return items.reduce((acc, item) => {
    const key = select(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function publicEndpoint(sourceItem) {
  return sourceItem.endpoint.apiUrl ?? sourceItem.endpoint.baseUrl ?? sourceItem.endpoint.evidenceUrl ?? sourceItem.endpoint.handle ?? sourceItem.endpoint.domain ?? null;
}

function safeHost(urlText) {
  try {
    return new URL(urlText).host;
  } catch {
    return null;
  }
}

function sanitizeError(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  return { name: error.name, message: error.message, stack: error.stack?.split('\n').slice(0, 4).join('\n') };
}

try {
  await main();
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(projectRoot, '.local/reports'), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}

if (!report.ok) {
  console.error(JSON.stringify({ passed: false, reportPath, failed: report.checks.find((check) => !check.ok)?.name }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ passed: true, live, checks: report.checks.length, liveSamples: report.liveSamples.length, reportPath }, null, 2));
}
