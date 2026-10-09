import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { FreelanceRuConnector } = require('../src/modules/sources/connectors/freelance-ru.connector.ts');
const { ConnectorRegistryService } = require('../src/modules/sources/connectors/connector-registry.service.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');
const base = 'https://freelance.ru/task';
const lower = '2026-09-05T10:00:00.984Z';
const upper = '2026-10-05T10:00:00.986Z';
const categories = [{ id: '4', label: 'Программирование' }, { id: '40', label: 'Дизайн' }];
const categoryUrl = (id, page = 1, key = 'c[0]') => `${base}?${encodeURIComponent(key)}=${id}${page > 1 ? `&page=${page}` : ''}`;
const card = id => `<article class="task-card"><a class="task-card__title-link" href="/task/view/${id}">Разработка интеграции ${id}</a><p class="task-card__desc">Короткое описание карточки</p><span class="task-chip--cat">Программирование</span><span class="task-card__foot-item" title="04.10.2026 06:56">Сегодня</span><div class="task-card__budget">6 500 ₽ / заказ</div></article>`;
const detail = id => `<section class="tv-hero"><div class="tv-hero__top">UI metadata</div><h1>Разработка интеграции ${id}</h1><p>Полное техническое задание ${id} с требованиями к интеграции</p><div class="tv-hero__meta"><div class="tv-meta-item"><div class="tv-meta-item__lbl">Срок</div><div class="tv-meta-item__val">7 дней</div></div></div></section>`;
const next = (href, disabled = false) => `<ul class="pagination"><li class="next${disabled ? ' disabled' : ''}"><a href="${href}">Next</a></li></ul>`;
const listing = (body, { selected, catalog = categories, count } = {}) => `<form method="get" action="/task">${catalog.map(({ id, label }) => `<label><input type="checkbox" name="c[]" value="${id}"${selected === id ? ' checked' : ''}>${label}</label>`).join('')}${count !== undefined ? `<div class="task-feed-toolbar-title"><span>${count}</span></div>` : ''}${body}</form>`;
const ctx = (checkpoint = {}) => ({ source: { _id: 'freelance_ru', name: 'Freelance.ru', connectorFamily: 'PublicHtml', limits: { maxPages: 1 }, endpoint: { baseUrl: base } }, checkpoint: checkpoint.hasMore ? { backfillSince: lower, windowTo: upper, nextPage: 1, visitedListUrls: [base], ...checkpoint } : checkpoint, backfillDays: 30, backfillSince: lower, requestId: 'fixture' });
const extractor = pages => ({ requests: [], async extractUrl(url) {
  this.requests.push(url);
  const response = pages[url] ?? (/\/task\/view\/(\d+)$/.exec(url) ? detail(url.split('/').at(-1)) : undefined);
  if (response instanceof Error) throw response;
  if (!response) throw new Error(`fixture fetch failure: ${url}`);
  return typeof response === 'string' ? { html: response, finalUrl: url, metadata: {} } : { metadata: {}, ...response };
} });

describe('Freelance.ru native category collection', () => {
  beforeEach(t => t.mock.timers.enable({ apis: ['Date'], now: new Date(upper) }));

  it('retains complete root details while freezing the category catalog without claiming completion', async () => {
    const result = await new FreelanceRuConnector(extractor({ [base]: listing(card(1)) })).fetchPage(ctx());
    const record = result.records[0];
    assert.match(record.description, /Полное техническое задание 1/);
    assert.doesNotMatch(record.description, /UI metadata/);
    assert.deepEqual(record.sourceMetadata.budget, { amount: 6500, currency: 'RUB', originalText: '6 500 ₽ / заказ' });
    assert.equal(record.publishedAt.toISOString(), '2026-10-04T03:56:00.000Z');
    assert.equal(record.rawPayload.fields['Срок'], '7 дней');
    assert.equal(result.hasMore, true);
    assert.deepEqual(result.checkpoint.observedCategoryCatalog, categories);
    assert.deepEqual(result.checkpoint.completedCategoryIds, []);
    assert.equal(result.checkpoint.nextUrl, categoryUrl('4'));
    assert.equal(result.checkpoint.coverage, 'categories-public-catalog');
  });

  it('exhausts two overlapping categories beyond maxPages with global detail deduplication and full completion', async () => {
    const web = extractor({ [base]: listing(card(1) + next('/task?page=2')), [categoryUrl('4')]: listing(card(1) + card(2) + next(categoryUrl('4', 2, 'c[]')), { selected: '4' }), [categoryUrl('4', 2)]: listing(card(2) + card(3) + next(categoryUrl('4', 3), true), { selected: '4' }), [categoryUrl('40')]: listing(card(2) + card(4), { selected: '40' }) });
    const connector = new FreelanceRuConnector(web);
    const pages = [];
    let checkpoint = {};
    do { const page = await connector.fetchPage(ctx(checkpoint)); pages.push(page); checkpoint = page.checkpoint; } while (checkpoint.hasMore);
    assert.deepEqual(pages.map(page => page.records.map(record => record.externalId)), [['1'], ['2'], ['3'], ['4']]);
    assert.equal(pages[2].hasMore, true);
    assert.deepEqual(checkpoint.completedCategoryIds, ['4', '40']);
    assert.equal(checkpoint.terminalReason, 'all-category-partitions-exhausted');
    assert.equal(checkpoint.nextUrl, undefined);
    assert.equal(checkpoint.backfillSince, lower);
    assert.equal(checkpoint.windowTo, upper);
    assert.deepEqual(web.requests.filter(url => !url.includes('/view/')), [base, categoryUrl('4'), categoryUrl('4', 2), categoryUrl('40')]);
    assert.equal(web.requests.filter(url => url.endsWith('/view/2')).length, 1);
    const restarted = await connector.fetchPage(ctx(checkpoint));
    assert.equal(restarted.records[0].externalId, '1');
    assert.equal(restarted.checkpoint.nextUrl, categoryUrl('4'));
  });

  it('advances categories whose records are all globally seen, without treating cross-category overlap as repetition', async () => {
    const web = extractor({ [base]: listing(card(1)), [categoryUrl('4')]: listing(card(1), { selected: '4' }), [categoryUrl('40')]: listing(card(1), { selected: '40' }) });
    const connector = new FreelanceRuConnector(web);
    const root = await connector.fetchPage(ctx());
    const first = await connector.fetchPage(ctx(root.checkpoint));
    const second = await connector.fetchPage(ctx(first.checkpoint));
    assert.deepEqual(first.records, []);
    assert.deepEqual(second.records, []);
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.checkpoint.completedCategoryIds, ['4', '40']);
    assert.equal(web.requests.filter(url => url.endsWith('/view/1')).length, 1);
  });

  it('upgrades legacy page101 into a category sweep with exact original bounds, IDs and root visit evidence', async () => {
    const legacy = { hasMore: true, nextUrl: `${base}?page=101`, nextPage: 100, backfillSince: lower, windowTo: upper, seenExternalIds: ['1', '7000'], visitedListUrls: [base, `${base}?page=100`] };
    const web = extractor({ [base]: listing(card(1) + next('/task?page=2')), [categoryUrl('4')]: listing(card(1) + card(2), { selected: '4' }) });
    const connector = new FreelanceRuConnector(web);
    const upgraded = await connector.fetchPage(ctx(legacy));
    assert.deepEqual(upgraded.records, []);
    assert.equal(upgraded.checkpoint.categorySweepVersion, 1);
    assert.equal(upgraded.checkpoint.nextUrl, categoryUrl('4'));
    assert.equal(upgraded.checkpoint.nextPage, 0);
    assert.equal(upgraded.checkpoint.backfillSince, lower);
    assert.equal(upgraded.checkpoint.windowTo, upper);
    assert.deepEqual(upgraded.checkpoint.seenExternalIds, ['1', '7000']);
    assert.deepEqual(upgraded.checkpoint.visitedListUrls, legacy.visitedListUrls);
    const category = await connector.fetchPage(ctx(upgraded.checkpoint));
    assert.deepEqual(category.records.map(row => row.externalId), ['2']);
    assert.equal(web.requests.includes(`${base}?page=101`), false);
  });

  it('accepts c[]/c[0] next and redirect variants only when category and page remain identical', async () => {
    const web = extractor({ [base]: listing(card(1)), [categoryUrl('4')]: { html: listing(card(2) + next('/task?page=2&c%5B%5D=4'), { selected: '4' }), finalUrl: categoryUrl('4', 1, 'c[]') }, [categoryUrl('4', 2)]: { html: listing(card(3), { selected: '4' }), finalUrl: `${base}?page=2&c%5B0%5D=4` } });
    const connector = new FreelanceRuConnector(web);
    const root = await connector.fetchPage(ctx());
    const first = await connector.fetchPage(ctx(root.checkpoint));
    assert.equal(first.checkpoint.nextUrl, categoryUrl('4', 2));
    const second = await connector.fetchPage(ctx(first.checkpoint));
    assert.equal(second.checkpoint.nextUrl, categoryUrl('40'));
  });

  it('does not advance a checkpoint or claim exhaustion after HTTP404 or failed details', async () => {
    const web = extractor({ [base]: listing(card(1)), [categoryUrl('4')]: new Error('HTTP 404') });
    const connector = new FreelanceRuConnector(web);
    const root = await connector.fetchPage(ctx());
    const checkpoint = structuredClone(root.checkpoint);
    await assert.rejects(() => connector.fetchPage(ctx(checkpoint)), /HTTP 404/);
    assert.deepEqual(checkpoint, root.checkpoint);
    const empty = {};
    await assert.rejects(() => new FreelanceRuConnector(extractor({ [base]: listing(card(1)), [`${base}/view/1`]: new Error('HTTP 503') })).fetchPage(ctx(empty)), /HTTP 503/);
    assert.deepEqual(empty, {});
  });

  it('retains restricted public previews and native detail/normalization facts', async () => {
    const preview = await new FreelanceRuConnector(extractor({ [base]: listing(card(1)), [`${base}/view/1`]: `<title>У вас нет доступа к этому заданию</title>${card(1)}` })).fetchPage(ctx());
    assert.equal(preview.records[0].sourceMetadata.detailAccess, 'public-preview');
    assert.equal(preview.records[0].description, 'Короткое описание карточки');
    assert.deepEqual(preview.records[0].rawPayload.fields, {});
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/freelance-ru/native-task.json', import.meta.url), 'utf8'));
    const page = await new FreelanceRuConnector(extractor({ [base]: listing(fixture.listing), [fixture.detailUrl]: fixture.detail })).fetchPage(ctx());
    const record = page.records.find(row => row.externalId === '11908');
    assert.match(record.description, /Цель-внешние заявки/);
    assert.doesNotMatch(record.description, /Регистрация|Гонорар|UTC\+3/);
    assert.equal(record.sourceMetadata.detailAccess, 'public-detail');
    const normalized = new SourceNormalizerService().normalize(ctx().source, record);
    assert.equal(normalized.money.amount, 1_000_000);
    assert.equal(normalized.money.currency, 'RUB');
    assert.equal(normalized.money.period, undefined);
    assert.deepEqual(normalized.freelanceData, { durationText: '90 дней', experienceText: 'От 3 лет', clientTimezone: 'UTC+3', engagementText: 'Долгосрочное', sourceName: 'Freelance.ru' });
    assert.equal(normalized.vacancyData.sourceName, undefined);
  });

  it('rejects missing/invalid category catalogs before fetching details or claiming coverage', async () => {
    for (const html of [card(1), listing(card(1), { catalog: [] }), listing(card(1), { catalog: [{ id: '4', label: 'A' }, { id: '4', label: 'B' }] }), listing(card(1), { catalog: [{ id: 'unknown', label: 'A' }] })]) {
      const web = extractor({ [base]: html });
      await assert.rejects(() => new FreelanceRuConnector(web).fetchPage(ctx()), /category catalog/);
      assert.deepEqual(web.requests, [base]);
    }
  });

  it('rejects hostile or filtered legacy continuation URLs before requesting them', async () => {
    const web = extractor({});
    for (const nextUrl of ['https://evil.example/task?page=2', 'https://freelance.ru:444/task?page=2', 'https://user:pass@freelance.ru/task?page=2', 'https://freelance.ru/task/view/12', categoryUrl('4', 2)]) {
      await assert.rejects(() => new FreelanceRuConnector(web).fetchPage(ctx({ hasMore: true, nextUrl })), /invalid listing URL/);
    }
    assert.deepEqual(web.requests, []);
  });

  it('rejects mixed, unknown, changed, removed, skipped, backward and cyclic category next filters', async () => {
    for (const href of [categoryUrl('40', 2), categoryUrl('999', 2), `${base}?page=2`, `${base}?c%5B%5D=4&c%5B0%5D=4&page=2`, `${base}?c%5B0%5D=4&a=1&page=2`, `${base}?c%5B1%5D=4&page=2`, categoryUrl('4', 3), categoryUrl('4'), `${categoryUrl('4', 2)}#fragment`]) {
      const web = extractor({ [base]: listing(card(1)), [categoryUrl('4')]: listing(card(2) + next(href), { selected: '4' }) });
      const connector = new FreelanceRuConnector(web);
      const root = await connector.fetchPage(ctx());
      await assert.rejects(() => connector.fetchPage(ctx(root.checkpoint)), /next control/);
    }
  });

  it('rejects changed checkpoint/redirect filters, ignored selection and changed catalog declarations', async () => {
    const root = await new FreelanceRuConnector(extractor({ [base]: listing(card(1)) })).fetchPage(ctx());
    for (const nextUrl of [categoryUrl('999'), categoryUrl('40'), `${base}?page=2`, `${categoryUrl('4')}&c%5B%5D=4`]) {
      const web = extractor({});
      await assert.rejects(() => new FreelanceRuConnector(web).fetchPage(ctx({ ...root.checkpoint, nextUrl })), /invalid listing URL/);
      assert.deepEqual(web.requests, []);
    }
    for (const response of [{ html: listing(card(2), { selected: '4' }), finalUrl: categoryUrl('40') }, { html: listing(card(2), { selected: '40' }), finalUrl: categoryUrl('4') }, { html: listing(card(2), { selected: '4', catalog: [...categories, { id: '999', label: 'New' }] }), finalUrl: categoryUrl('4') }]) {
      const web = extractor({ [categoryUrl('4')]: response });
      await assert.rejects(() => new FreelanceRuConnector(web).fetchPage(ctx(root.checkpoint)), /changed|ignored/);
      assert.deepEqual(web.requests, [categoryUrl('4')]);
    }
  });

  it('rejects corrupt sweep/history checkpoints before they can bypass partition repeat guards', async () => {
    const root = await new FreelanceRuConnector(extractor({ [base]: listing(card(1)) })).fetchPage(ctx());
    for (const [checkpoint, expected] of [
      [{ ...root.checkpoint, categorySweepVersion: 2 }, /unsupported category sweep version/],
      [{ ...root.checkpoint, partitionSeenExternalIds: undefined }, /partition history/],
      [{ ...root.checkpoint, observedCategoryCatalog: [{ id: 4, label: 'Программирование' }] }, /frozen category catalog/],
      [{ ...root.checkpoint, completedCategoryIds: ['40'] }, /completed categories/],
    ]) {
      const web = extractor({});
      await assert.rejects(() => new FreelanceRuConnector(web).fetchPage(ctx(checkpoint)), expected);
      assert.deepEqual(web.requests, []);
    }
  });

  it('rejects repeated native pages and URLs within a category before repeating details', async () => {
    const web = extractor({ [base]: listing(card(1)), [categoryUrl('4')]: listing(card(2) + next(categoryUrl('4', 2)), { selected: '4' }), [categoryUrl('4', 2)]: listing(card(2), { selected: '4' }) });
    const connector = new FreelanceRuConnector(web);
    const root = await connector.fetchPage(ctx());
    const first = await connector.fetchPage(ctx(root.checkpoint));
    const calls = web.requests.length;
    await assert.rejects(() => connector.fetchPage(ctx(first.checkpoint)), /all previously seen.*partition/);
    assert.deepEqual(web.requests.slice(calls), [categoryUrl('4', 2)]);
    await assert.rejects(() => connector.fetchPage(ctx({ ...first.checkpoint, nextUrl: categoryUrl('4'), nextPage: 0 })), /previously visited page/);
  });

  it('finishes explicitly zero-result category HTML while rejecting unsupported empty pages', async () => {
    const web = extractor({ [base]: listing(card(1)), [categoryUrl('4')]: listing('', { selected: '4', count: 0 }), [categoryUrl('40')]: listing('', { selected: '40', count: 0 }) });
    const connector = new FreelanceRuConnector(web);
    const root = await connector.fetchPage(ctx());
    const first = await connector.fetchPage(ctx(root.checkpoint));
    const second = await connector.fetchPage(ctx(first.checkpoint));
    assert.equal(second.hasMore, false);
    assert.deepEqual(second.checkpoint.completedCategoryIds, ['4', '40']);
    await assert.rejects(() => new FreelanceRuConnector(extractor({ [categoryUrl('4')]: listing('<h1>No cards</h1>', { selected: '4' }) })).fetchPage(ctx(root.checkpoint)), /no supported public task cards/);
  });

  it('preserves exact bounds, unknown dates and later pages after old cards', async () => {
    const old = card(1).replace('04.10.2026 06:56', '04.09.2026 06:56');
    const future = card(2).replace('04.10.2026 06:56', '06.10.2026 06:56');
    const unknown = card(3).replace('04.10.2026 06:56', 'Неизвестно');
    const web = extractor({ [base]: listing(old + future + unknown), [categoryUrl('4')]: listing(old + next(categoryUrl('4', 2)), { selected: '4' }), [categoryUrl('4', 2)]: listing(card(4), { selected: '4' }) });
    const connector = new FreelanceRuConnector(web);
    const root = await connector.fetchPage(ctx());
    const first = await connector.fetchPage(ctx(root.checkpoint));
    const second = await connector.fetchPage(ctx(first.checkpoint));
    assert.deepEqual(root.records.map(row => row.externalId), ['3']);
    assert.equal(root.records[0].publishedAt, undefined);
    assert.deepEqual(root.checkpoint.seenExternalIds, ['1', '2', '3']);
    assert.deepEqual(second.records.map(row => row.externalId), ['4']);
    assert.equal(second.checkpoint.windowTo, upper);
    assert.equal(second.checkpoint.backfillSince, lower);
    assert.equal(web.requests.some(url => /view\/[12]$/.test(url)), false);
  });

  it('rejects malformed root next controls even while discovering the native partitions', async () => {
    for (const href of [base, '/task?page=3', '/task?page=2&page=3', '/task?page=2#fragment', 'https://evil.example/task?page=2']) {
      await assert.rejects(() => new FreelanceRuConnector(extractor({ [base]: listing(card(1) + next(href)) })).fetchPage(ctx()), /next control/);
    }
  });

  it('forwards abort signals and rejects changed lower publication boundaries', async () => {
    const signal = AbortSignal.timeout(10_000);
    const web = extractor({ [base]: listing(card(1)) });
    const original = web.extractUrl;
    web.extractUrl = async function (url, options) { assert.equal(options.signal, signal); return original.call(this, url); };
    await new FreelanceRuConnector(web).fetchPage({ ...ctx(), signal });
    const aborted = new AbortController(); aborted.abort(new Error('Stopped'));
    await assert.rejects(() => new FreelanceRuConnector(web).fetchPage({ ...ctx(), signal: aborted.signal }), /Stopped/);
    assert.equal(web.requests.length, 2);
    await assert.rejects(() => new FreelanceRuConnector(web).fetchPage(ctx({ hasMore: true, nextUrl: `${base}?page=2`, backfillSince: '2026-09-01T00:00:00.000Z' })), /lower publication boundary changed/);
  });

  it('retains invalid source dates as unknown and preserves registry routing', async () => {
    const page = await new FreelanceRuConnector(extractor({ [base]: listing(card(1).replace('04.10.2026 06:56', '31.09.2026 06:56')) })).fetchPage(ctx());
    assert.equal(page.records[0].publishedAt, undefined);
    assert.equal(page.records[0].rawPayload.publishedText, '31.09.2026 06:56');
    assert.equal(new ConnectorRegistryService(extractor({})).get(ctx().source).id, 'freelance-ru');
  });
});
