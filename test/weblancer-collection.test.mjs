import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { WeblancerConnector } = require('../src/modules/sources/connectors/weblancer.connector.ts');

const listUrl = 'https://www.weblancer.net/freelance/';
const legacyJobsUrl = 'https://www.weblancer.net/jobs/';
const fixtureList = readFileSync(new URL('./fixtures/weblancer/list.html', import.meta.url), 'utf8');
const fixtureDetail = readFileSync(new URL('./fixtures/weblancer/detail-1269713.html', import.meta.url), 'utf8');

function ctx(overrides = {}) {
  return {
    source: { _id: 'weblancer', name: 'Weblancer', connectorFamily: 'PublicHtml', endpoint: { baseUrl: legacyJobsUrl }, timeoutMs: 1_000 },
    requestId: 'weblancer-test',
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

function extractor(pages = {}) {
  return {
    requests: [],
    async extractUrl(url, options = {}) {
      this.requests.push({ url, options });
      const finalUrl = redirects[url] ?? url;
      const html = pages[url] ?? pages[finalUrl] ?? autoDetail(finalUrl);
      if (!html) throw new Error(`fixture fetch failure: ${url}`);
      return { html, finalUrl, metadata: { firecrawl: false } };
    },
  };
}

const redirects = { [legacyJobsUrl]: listUrl };

function article(id, title, { date = '04.10.2026', budget = '150 $', tags = ['Telegram'], preview = 'Короткое описание из карточки', category = 'jobs' } = {}) {
  return `<article class="bg-white rounded-md"><h2><a href="/freelance/${category}/${slug(title)}-${id}/">${title}</a></h2><span class="text-green-600">${budget}</span><p class="text-gray-600">${preview}</p><a href="/freelance/telegram/">${tags[0]}</a><div>${date}</div><div>3 заявки</div><div>12 просмотров</div></article>`;
}

function detail(id, title, { date = '04.10.2026', body = `Полное описание заказа ${id} с финальным хвостом`, client = 'Михаил', canonicalPath = `/freelance/jobs/${slug(title)}-${id}/` } = {}) {
  return `<html><head><link rel="canonical" href="https://www.weblancer.net${canonicalPath}"></head><body><h1>${title}</h1><section class="bg-white p-6 rounded-md shadow space-y-5"><div><span>${client}</span><div class="text-sm text-gray-400">Данные заказчика будут вам доступны после подачи заявки</div><span>${date}</span></div><div class="text-rich"><p>${body}</p></div><a href="/freelance/telegram/">Telegram</a></section></body></html>`;
}

function detailWithBodyHtml(id, title, bodyHtml, { date = '04.10.2026', client = '', canonicalPath = `/freelance/jobs/${slug(title)}-${id}/` } = {}) {
  const clientBlock = client ? `<span>${client}</span><div class="text-sm text-gray-400">Данные заказчика будут вам доступны после подачи заявки</div>` : '';
  return `<html><head><link rel="canonical" href="https://www.weblancer.net${canonicalPath}"></head><body><h1>${title}</h1><section class="bg-white p-6 rounded-md shadow space-y-5"><div>${clientBlock}<span>${date}</span></div><div class="text-rich">${bodyHtml}</div><a href="/freelance/telegram/">Telegram</a></section></body></html>`;
}

function autoDetail(url) {
  const parsed = new URL(url);
  const match = /\/freelance\/[^/]+\/(.+)-(\d+)\/$/.exec(parsed.pathname);
  if (!match) return undefined;
  const title = match[1].replace(/-/g, ' ');
  return detail(match[2], title, { canonicalPath: parsed.pathname });
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '') || 'order';
}

describe('Weblancer native public catalog collection', () => {
  it('extracts the observed freelance catalog with full detail bodies and native audit fields', async () => {
    const web = extractor({
      [listUrl]: fixtureList,
      'https://www.weblancer.net/freelance/jobs/ai-ferma-avtorskogo-kontenta-1269713/': fixtureDetail,
    });

    const result = await new WeblancerConnector(web).fetchPage(ctx());
    const aiOrder = result.records.find((record) => record.externalId === '1269713');

    assert.equal(result.records.length, 20);
    assert.equal(result.hasMore, true);
    assert.equal(result.nextPage, 2);
    assert.equal(result.checkpoint.nextUrl, 'https://www.weblancer.net/freelance/?page=2');
    assert.equal(web.requests[0].url, listUrl);
    assert.deepEqual(web.requests[0].options.allowedHosts, ['www.weblancer.net']);
    assert.equal(aiOrder.url, 'https://www.weblancer.net/freelance/jobs/ai-ferma-avtorskogo-kontenta-1269713/');
    assert.equal(aiOrder.title, 'Ai ферма авторского контента');
    assert.match(aiOrder.description, /кейсы перед самой работой/);
    assert.match(aiOrder.description, /нам \.\n\nзадачи3\nферма/);
    assert.doesNotMatch(aiOrder.description, /Данные заказчика/);
    assert.equal(aiOrder.companyOrClient, 'Михаил');
    assert.equal(aiOrder.publishedAt.toISOString(), '2026-10-04T12:00:00.000Z');
    assert.equal(aiOrder.sourceMetadata.extraction, 'weblancer-native-html-detail-v1');
    assert.equal(aiOrder.sourceMetadata.descriptionCoverage, 'detail-full');
    assert.equal(aiOrder.sourceMetadata.datePrecision, 'day');
    assert.deepEqual(aiOrder.sourceMetadata.budget, { amount: undefined, currency: undefined, originalText: undefined });
    assert.deepEqual(aiOrder.sourceMetadata.categoryTags, ['Telegram', 'TikTok', 'YouTube', 'Монтаж видеороликов', 'Нейросети']);
    assert.equal(aiOrder.rawPayload.list.preview.includes('задачи3'), true);
    assert.match(aiOrder.rawPayload.detail.description, /Просьба откликнуться/);
  });

  it('accepts legacy /jobs/ config while collecting the observed /freelance/ catalog', async () => {
    const connector = new WeblancerConnector(extractor({ [listUrl]: `${article(1, 'Задача')}` }));

    assert.equal((await connector.validateConfig({ baseUrl: legacyJobsUrl })).ok, true);
    assert.equal((await connector.validateConfig({ baseUrl: listUrl })).ok, true);
    assert.equal((await connector.validateConfig({ baseUrl: 'https://www.weblancer.net/freelance/?page=2' })).ok, false);
    assert.equal((await connector.validateConfig({ baseUrl: 'https://evil.example/freelance/' })).ok, false);
  });

  it('uses only observed adjacent next links and dedupes native ids across continuation pages', async () => {
    const page1 = `${article(1, 'Первый заказ')}<a href="/freelance/?page=2">2</a><a href="/freelance/?page=8">8</a>`;
    const page2 = `${article(1, 'Первый заказ')} ${article(2, 'Второй заказ')}<a href="/freelance/?page=3">3</a>`;
    const page3 = `${article(3, 'Третий заказ')}`;
    const web = extractor({ [listUrl]: page1, [`${listUrl}?page=2`]: page2, [`${listUrl}?page=3`]: page3 });
    const connector = new WeblancerConnector(web);

    const first = await connector.fetchPage(ctx());
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));
    const third = await connector.fetchPage(ctx({ checkpoint: second.checkpoint }));

    assert.equal(first.checkpoint.nextUrl, `${listUrl}?page=2`);
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0].externalId, '2');
    assert.equal(second.checkpoint.nextUrl, `${listUrl}?page=3`);
    assert.equal(third.hasMore, false);
    assert.deepEqual(third.checkpoint.visitedListUrls, [listUrl, `${listUrl}?page=2`, `${listUrl}?page=3`]);
    assert.deepEqual(third.checkpoint.seenNativeIds, ['1', '2', '3']);
    assert.equal(third.checkpoint.terminalReason, 'observed-pagination-exhausted');
    assert.deepEqual(web.requests.filter((request) => request.url.includes('/freelance/?page=') || request.url === listUrl).map((request) => request.url), [listUrl, `${listUrl}?page=2`, `${listUrl}?page=3`]);
  });

  it('keeps rich detail paragraphs and lists readable without inventing a client', async () => {
    const web = extractor({
      [listUrl]: article(21, 'Readable task'),
      'https://www.weblancer.net/freelance/jobs/readable-task-21/': detailWithBodyHtml(21, 'Readable task', '<p>Первый абзац</p><p>Второй абзац<br>строка</p><ul><li>пункт один</li><li>пункт два</li></ul>'),
    });

    const result = await new WeblancerConnector(web).fetchPage(ctx());

    assert.equal(result.records[0].description, 'Первый абзац\n\nВторой абзац\nстрока\n\n- пункт один\n- пункт два');
    assert.equal(result.records[0].companyOrClient, undefined);
    assert.equal(result.records[0].sourceMetadata.clientPublicName, undefined);
  });

  it('reports observed adjacent pagination cycles instead of treating the catalog as exhausted', async () => {
    const page2 = `${article(22, 'Cycle task')}<a href="/freelance/?page=3">3</a>`;
    const web = extractor({ [`${listUrl}?page=2`]: page2 });

    await assert.rejects(
      () => new WeblancerConnector(web).fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl: `${listUrl}?page=2`, visitedListUrls: [listUrl, `${listUrl}?page=2`, `${listUrl}?page=3`] } })),
      /pagination cycle detected at https:\/\/www\.weblancer\.net\/freelance\/\?page=3/,
    );
  });

  it('starts a fresh window and traversal after a terminal checkpoint when a new poll advances backfillSince', async () => {
    const web = extractor({
      [listUrl]: article(31, 'Fresh poll task', { date: '04.10.2026' }),
      'https://www.weblancer.net/freelance/jobs/fresh-poll-task-31/': detail(31, 'Fresh poll task', { date: '04.10.2026' }),
    });
    const terminalCheckpoint = {
      hasMore: false,
      visitedListUrls: [listUrl, `${listUrl}?page=2`],
      seenNativeIds: ['old-1', 'old-2'],
      terminalReason: 'observed-pagination-exhausted',
      windowSince: '2026-09-01T00:00:00.000Z',
      windowUntil: '2026-10-01T00:00:00.000Z',
    };

    const result = await new WeblancerConnector(web).fetchPage(ctx({
      checkpoint: terminalCheckpoint,
      backfillSince: '2026-10-02T00:00:00.000Z',
    }));

    assert.deepEqual(result.records.map((record) => record.externalId), ['31']);
    assert.deepEqual(result.checkpoint.visitedListUrls, [listUrl]);
    assert.deepEqual(result.checkpoint.seenNativeIds, ['31']);
    assert.equal(result.checkpoint.windowSince, '2026-10-02T00:00:00.000Z');
    assert.notEqual(result.checkpoint.windowUntil, terminalCheckpoint.windowUntil);
  });

  it('keeps unknown dates but filters known records outside the fixed 30 day window', async () => {
    const old = article(11, 'Old task', { date: '01.08.2026' });
    const unknown = article(12, 'No date', { date: '' });
    const web = extractor({
      [listUrl]: `${old}${unknown}`,
      'https://www.weblancer.net/freelance/jobs/old-task-11/': detail(11, 'Old task', { date: '01.08.2026' }),
      'https://www.weblancer.net/freelance/jobs/no-date-12/': detail(12, 'No date', { date: '' }),
    });

    const result = await new WeblancerConnector(web).fetchPage(ctx({ backfillSince: '2026-09-04T00:00:00.000Z' }));

    assert.deepEqual(result.records.map((record) => record.externalId), ['12']);
    assert.equal(result.records[0].publishedAt, undefined);
    assert.equal(result.checkpoint.windowSince, '2026-09-04T00:00:00.000Z');
    assert.ok(typeof result.checkpoint.windowUntil === 'string');
  });

  it('fails truthfully on detail errors, hostile continuations and canonical mismatches', async () => {
    const failingDetail = extractor({ [listUrl]: article(1, 'Плохая деталь') });
    failingDetail.extractUrl = async function (url, options = {}) {
      this.requests.push({ url, options });
      if (/-1\/$/.test(new URL(url).pathname)) throw new Error('HTTP 503');
      return { html: article(1, 'Плохая деталь'), finalUrl: url, metadata: {} };
    };
    await assert.rejects(() => new WeblancerConnector(failingDetail).fetchPage(ctx()), /HTTP 503/);

    const connector = new WeblancerConnector(extractor({ [listUrl]: article(1, 'Задача') }));
    await assert.rejects(
      () => connector.fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl: 'https://evil.example/freelance/?page=2' } })),
      /invalid listing URL/,
    );

    const mismatch = extractor({
      [listUrl]: article(3, 'Canonical mismatch'),
      'https://www.weblancer.net/freelance/jobs/canonical-mismatch-3/': detail(3, 'Canonical mismatch', { canonicalPath: '/freelance/jobs/other-4/' }),
    });
    await assert.rejects(() => new WeblancerConnector(mismatch).fetchPage(ctx()), /canonical URL points to another order/);
  });
});
