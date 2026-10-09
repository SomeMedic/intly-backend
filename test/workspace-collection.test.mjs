import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { WorkspaceConnector } = require('../src/modules/sources/connectors/workspace.connector.ts');
const { WebExtractionHttpError } = require('../src/modules/sources/extraction/web-extraction.service.ts');

const listUrl = 'https://workspace.ru/tenders/';
const listHtml = readFileSync(new URL('./fixtures/workspace-native/list.html', import.meta.url), 'utf8');
const page2Xhr = readFileSync(new URL('./fixtures/workspace-native/page2-xhr.json', import.meta.url), 'utf8');
const detail18993 = readFileSync(new URL('./fixtures/workspace-native/detail-18993.html', import.meta.url), 'utf8');
const dayMs = 86_400_000;

function ctx(overrides = {}) {
  return {
    source: { _id: 'workspace', name: 'Workspace', connectorFamily: 'PublicHtml', endpoint: { baseUrl: listUrl }, timeoutMs: 1_000 },
    requestId: 'workspace-test',
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
      const html = pages[url] ?? autoDetail(url);
      if (html instanceof Error) throw html;
      if (!html) throw new Error(`fixture fetch failure: ${url}`);
      return typeof html === 'string' ? { html, finalUrl: url, metadata: {} } : { metadata: {}, finalUrl: url, ...html };
    },
  };
}

function card(id, title, { published = '04 октября 2026', deadline = '24 октября 2026', budget = '300 000 - 900 000', status = 'Идет прием заявок', tenderType = 'Публичный', next = '' } = {}) {
  return `<div data-tender-public-list><div class="vacancies__card _tender" data-tender-card>
    <div class="tendercart-type__status-public">${status}</div>
    <span class="reference _public">${tenderType}</span><span class="reference _views">12</span>
    <div class="b-tender__block--title"><div class="b-tender__title _wide"><a href="/tenders/${slug(title)}-${id}/">${title}</a></div><div class="b-tender__info-item-text">${budget}</div></div>
    <div class="b-tender__info">
      <div class="b-tender__info-item"><div class="b-tender__info-item-title">Опубликован</div><div class="b-tender__info-item-text">${published}</div></div>
      <div class="b-tender__info-item"><div class="b-tender__info-item-title">Крайний срок приема заявок:</div><div class="b-tender__info-item-text">${deadline}</div></div>
    </div>
  </div>${next}</div>`;
}

function detail(id, title, { body = `Полное описание тендера ${id}`, service = 'SMM под ключ', organizer = 'Юридическое лицо', executors = 'Предпочтительно из России, Москвы', canonicalPath } = {}) {
  const path = canonicalPath ?? `/tenders/${slug(title)}-${id}/`;
  return `<html><head><link rel="canonical" href="https://workspace.ru${path}"></head><body>
    <div class="tendercart-type__status-public">Идет прием заявок</div><span class="reference _public">Публичный</span><span class="reference _views">44</span>
    <h1>${title}</h1><div class="tendercard__desc"><p>${body}</p><p>Второй абзац<br>строка</p><ul><li>пункт один</li></ul></div>
    <div class="b-tender__info-item"><div class="b-tender__info-item-title">Бюджет:</div><div class="b-tender__info-item-text">300 000 - 900 000 рублей</div></div>
    <div class="b-tender__info-item"><div class="b-tender__info-item-title">Опубликован:</div><div class="b-tender__info-item-text">04 октября 2026</div></div>
    <div class="b-tender__info-item"><div class="b-tender__info-item-title">Крайний срок приема заявок:</div><div class="b-tender__info-item-text">24 октября 2026</div></div>
    <h2>Требуемая услуга</h2><a href="/services/smm/">${service}</a>
    <h2>Исполнители</h2><p>${executors}</p><h2>Oрганизатор</h2><p>${organizer}</p>
    <p>Этот тендер организован заказчиком из Москвы.</p>
  </body></html>`;
}

function detailWithBudget(id, title, budget) {
  return detail(id, title).replace('300 000 - 900 000 рублей', budget);
}

function autoDetail(url) {
  const parsed = new URL(url);
  const match = /^\/tenders\/(.+)-(\d+)\/$/.exec(parsed.pathname);
  if (!match) return undefined;
  const title = match[1].replace(/-/g, ' ');
  return detail(match[2], title, { body: `Автоматическое полное описание ${match[2]}` });
}

function detailWithoutDates(id, title) {
  return `<html><head><link rel="canonical" href="https://workspace.ru/tenders/${slug(title)}-${id}/"></head><body>
    <h1>${title}</h1><div class="tendercard__desc"><p>Описание без даты ${id}</p></div>
    <h2>Требуемая услуга</h2><a href="/services/smm/">SMM под ключ</a>
  </body></html>`;
}

function detailWithSyntheticAttachments(id, title) {
  return detail(id, title, {
    body: `Синтетическая проверка вложений <a href="/upload/tenders/spec-${id}.pdf">Техническое задание.pdf</a>
      <a href="https://cdn.example.test/workspace/brief-${id}.docx">Бриф проекта.docx</a>
      <a href="/upload/security_policy.pdf">условиями</a>
      <a href="/upload/terms_of_use.pdf">Пользовательское соглашение</a>`,
  });
}

function refreshDetail(id, title, { budget = '900 000 - 1 200 000 рублей', deadline = '15 ноября 2026', status = 'Завершён', published, canonicalPath } = {}) {
  const path = canonicalPath ?? `/tenders/${slug(title)}-${id}/`;
  return `<html><head><link rel="canonical" href="https://workspace.ru${path}"></head><body>
    <div class="tendercart-type__status-public">${status}</div><span class="reference _public">Публичный</span><span class="reference _views">99</span>
    <h1>${title}</h1><div class="tendercard__desc"><p>Свежая карточка тендера ${id}</p></div>
    ${budget ? `<div class="b-tender__info-item"><div class="b-tender__info-item-title">Бюджет:</div><div class="b-tender__info-item-text">${budget}</div></div>` : ''}
    ${published ? `<div class="b-tender__info-item"><div class="b-tender__info-item-title">Опубликован:</div><div class="b-tender__info-item-text">${published}</div></div>` : ''}
    ${deadline ? `<div class="b-tender__info-item"><div class="b-tender__info-item-title">Крайний срок приема заявок:</div><div class="b-tender__info-item-text">${deadline}</div></div>` : ''}
    <h2>Требуемая услуга</h2><a href="/services/dev/">Разработка сайта</a>
    <h2>Oрганизатор</h2><p>Юридическое лицо</p>
    <p>Этот тендер организован заказчиком из Казани.</p>
  </body></html>`;
}

function retainedOccurrence(id = '18993', url = 'https://workspace.ru/tenders/sozdanie-kreativa-scenariev-dlya-vertikalnogo-kontenta-reels-polnoe-vedenie-smm-18993/', overrides = {}) {
  return {
    externalId: id,
    url,
    title: 'Retained Workspace tender',
    publishedAt: '2026-08-01T12:00:00.000Z',
    sourceMetadata: {
      sourceUrl: listUrl,
      detailUrl: url,
      publishedText: '01 августа 2026',
      deadlineText: '01 сентября 2026',
      deadlineAt: '2026-09-01T12:00:00.000Z',
      statusText: 'Идет прием заявок',
      tenderTypeText: 'Публичный',
      budget: { min: 100000, max: 200000, currency: 'RUB', originalText: '100 000 - 200 000 рублей' },
    },
    rawPayload: {
      list: {
        sourceUrl: listUrl,
        detailUrl: url,
        title: 'Retained Workspace tender',
        budgetText: '100 000 - 200 000 рублей',
        statusText: 'Идет прием заявок',
        tenderTypeText: 'Публичный',
        publishedText: '01 августа 2026',
        deadlineText: '01 сентября 2026',
      },
      detail: {
        url,
        title: 'Retained Workspace tender',
        budgetText: '100 000 - 200 000 рублей',
        statusText: 'Идет прием заявок',
        tenderTypeText: 'Публичный',
        publishedText: '01 августа 2026',
        deadlineText: '01 сентября 2026',
      },
    },
    ...overrides,
  };
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-|-$/g, '') || 'tender';
}

describe('Workspace native public tender collection', () => {
  it('extracts retained official list fixtures with full detail bodies and native tender fields', async () => {
    const detailUrl = 'https://workspace.ru/tenders/sozdanie-kreativa-scenariev-dlya-vertikalnogo-kontenta-reels-polnoe-vedenie-smm-18993/';
    const web = extractor({ [listUrl]: listHtml, [detailUrl]: detail18993 });
    const connector = new WorkspaceConnector(web);
    assert.equal(connector.capabilities().supportsRefresh, true);
    const result = await connector.fetchPage(ctx());
    const first = result.records.find((record) => record.externalId === '18993');

    assert.equal(result.records.length, 10);
    assert.equal(result.hasMore, true);
    assert.equal(result.nextPage, 2);
    assert.equal(result.checkpoint.nextUrl, 'https://workspace.ru/tenders/?page=2');
    assert.deepEqual(web.requests[0], { url: listUrl, options: { allowedHosts: ['workspace.ru'], timeoutMs: 1_000, maxBytes: 2_000_000, signal: undefined } });
    assert.equal(first.url, detailUrl);
    assert.equal('companyOrClient' in first, false);
    assert.match(first.description, /Бренд категории напитки/);
    assert.match(first.description, /авторского контента/);
    assert.equal(first.publishedAt.toISOString(), '2026-10-01T12:00:00.000Z');
    assert.equal(first.sourceStatus, 'Active');
    assert.deepEqual(first.sourceMetadata.budget, { min: 300000, max: 900000, currency: 'RUB', originalText: '300 000 - 900 000' });
    assert.equal(first.sourceMetadata.deadlineAt, '2026-10-24T12:00:00.000Z');
    assert.equal(first.sourceMetadata.location, 'Москвы');
    assert.deepEqual(first.sourceMetadata.categoryTags, ['SMM под ключ']);
    assert.deepEqual(first.sourceMetadata.skills, ['SMM под ключ']);
    assert.deepEqual(first.sourceMetadata.sourceDocuments, []);
    assert.equal(first.sourceMetadata.tenderData.category, 'SMM под ключ');
    assert.equal(first.sourceMetadata.tenderData.requiredService, 'SMM под ключ');
    assert.equal(first.sourceMetadata.tenderData.region, 'Москвы');
    assert.equal(first.sourceMetadata.tenderData.procurementMethod, 'Публичный');
    assert.equal(first.sourceMetadata.tenderData.platform, 'Workspace');
    assert.equal('customer' in first.sourceMetadata.tenderData, false);
    assert.equal('contractNumber' in first.sourceMetadata.tenderData, false);
    assert.equal(first.sourceMetadata.tenderData.organizerType, 'Юридическое лицо');
    assert.equal(first.sourceMetadata.tenderData.executorPreferenceText, 'Предпочтительно из России, Москвы');
    assert.deepEqual(first.rawPayload.detail.documentAttachments, first.sourceMetadata.sourceDocuments);
    assert.equal(first.rawPayload.descriptionCoverage, 'detail-full');
  });

  it('refreshes retained Workspace occurrences with detail fields winning and old publication preserved', async () => {
    const refreshUrl = 'https://workspace.ru/tenders/refresh-tender-12/';
    const web = extractor({ [refreshUrl]: refreshDetail(12, 'Refresh tender') });
    const result = await new WorkspaceConnector(web).refresh(retainedOccurrence('12', refreshUrl), ctx({ backfillSince: '2026-09-04T00:00:00.000Z' }));
    const record = result.record;

    assert.equal(record.externalId, '12');
    assert.equal(record.url, refreshUrl);
    assert.equal(web.requests.length, 1);
    assert.deepEqual(web.requests[0], { url: refreshUrl, options: { allowedHosts: ['workspace.ru'], timeoutMs: 1_000, maxBytes: 2_000_000, signal: undefined } });
    assert.equal(record.description, 'Свежая карточка тендера 12');
    assert.equal(record.sourceStatus, 'Closed');
    assert.deepEqual(record.sourceMetadata.budget, { min: 900000, max: 1200000, currency: 'RUB', originalText: '900 000 - 1 200 000 рублей' });
    assert.equal(record.sourceMetadata.deadlineText, '15 ноября 2026');
    assert.equal(record.sourceMetadata.deadlineAt, '2026-11-15T12:00:00.000Z');
    assert.equal(record.sourceMetadata.deadlinePrecision, 'day');
    assert.equal(record.publishedAt.toISOString(), '2026-08-01T12:00:00.000Z');
    assert.equal(record.sourceMetadata.publishedText, '01 августа 2026');
    assert.equal(record.sourceMetadata.datePrecision, 'day');
    assert.equal(record.sourceMetadata.tenderData.statusText, 'Завершён');
  });

  it('refresh preserves retained status, deadline and budget when detail omits them', async () => {
    const refreshUrl = 'https://workspace.ru/tenders/missing-refresh-fields-13/';
    const web = extractor({ [refreshUrl]: refreshDetail(13, 'Missing refresh fields', { budget: '', deadline: '', status: '' }) });
    const result = await new WorkspaceConnector(web).refresh(retainedOccurrence('13', refreshUrl), ctx());
    const record = result.record;

    assert.equal(record.sourceStatus, 'Active');
    assert.deepEqual(record.sourceMetadata.budget, { min: 100000, max: 200000, currency: 'RUB', originalText: '100 000 - 200 000 рублей' });
    assert.equal(record.sourceMetadata.deadlineText, '01 сентября 2026');
    assert.equal(record.sourceMetadata.deadlineAt, '2026-09-01T12:00:00.000Z');
    assert.equal(record.publishedAt.toISOString(), '2026-08-01T12:00:00.000Z');
  });

  it('refresh rejects invalid retained identity and canonical ID mismatches without arbitrary URL fetches', async () => {
    const invalidWeb = extractor({});
    const connector = new WorkspaceConnector(invalidWeb);
    await assert.rejects(() => connector.refresh(retainedOccurrence('abc', 'https://workspace.ru/tenders/bad-abc/'), ctx()), /numeric externalId/);
    await assert.rejects(() => connector.refresh(retainedOccurrence('12', 'https://evil.example/tenders/refresh-tender-12/'), ctx()), /exact native tender URL/);
    await assert.rejects(() => connector.refresh(retainedOccurrence('12', 'https://workspace.ru/tenders/refresh-tender-13/'), ctx()), /does not match externalId/);
    assert.equal(invalidWeb.requests.length, 0);

    const mismatchUrl = 'https://workspace.ru/tenders/canonical-refresh-14/';
    await assert.rejects(
      () => new WorkspaceConnector(extractor({ [mismatchUrl]: refreshDetail(14, 'Canonical refresh', { canonicalPath: '/tenders/other-refresh-15/' }) })).refresh(retainedOccurrence('14', mismatchUrl), ctx()),
      /canonical URL points to another tender/,
    );
  });

  it('refresh preserves abort and HTTP extraction errors for shared scheduling', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const abortUrl = 'https://workspace.ru/tenders/abort-refresh-16/';
    await assert.rejects(
      () => new WorkspaceConnector(extractor({ [abortUrl]: abortError })).refresh(retainedOccurrence('16', abortUrl), ctx()),
      (error) => error === abortError,
    );

    for (const status of [403, 404, 429]) {
      const url = `https://workspace.ru/tenders/http-refresh-${status}/`;
      const original = new WebExtractionHttpError(status, url, { accessReason: status === 429 ? 'rate_limited' : 'access_denied', retryAfter: status === 429 ? '120' : undefined });
      await assert.rejects(
        () => new WorkspaceConnector(extractor({ [url]: original })).refresh(retainedOccurrence(String(status), url), ctx()),
        (error) => error === original && error.status === status && (status !== 429 || error.retryAfter === '120'),
      );
    }
  });

  it('keeps synthetic tender attachments while excluding exact Workspace policy URLs', async () => {
    const html = card(11, 'Synthetic attachment tender', { published: '20 сентября 2026' });
    const detailUrl = 'https://workspace.ru/tenders/synthetic-attachment-tender-11/';
    const result = await new WorkspaceConnector(extractor({ [listUrl]: html, [detailUrl]: detailWithSyntheticAttachments(11, 'Synthetic attachment tender') })).fetchPage(ctx());
    const [record] = result.records;

    assert.deepEqual(record.sourceMetadata.sourceDocuments, [
      { label: 'Техническое задание.pdf', url: 'https://workspace.ru/upload/tenders/spec-11.pdf' },
      { label: 'Бриф проекта.docx', url: 'https://cdn.example.test/workspace/brief-11.docx' },
    ]);
    assert.equal(record.rawPayload.detail.descriptionHtml.includes('security_policy.pdf'), true);
    assert.equal(record.rawPayload.detail.descriptionHtml.includes('terms_of_use.pdf'), true);
    assert.equal(record.sourceMetadata.sourceDocuments.some((document) => /security_policy|terms_of_use|условиями|Пользовательское соглашение/i.test(`${document.label} ${document.url}`)), false);
    assert.deepEqual(record.rawPayload.detail.documentAttachments, record.sourceMetadata.sourceDocuments);
    assert.deepEqual(record.sourceMetadata.tenderData.documentAttachments, record.sourceMetadata.sourceDocuments);
  });

  it('preserves native budget ranges, single-sided values, decimals and negotiable text without inventing zero amounts', async () => {
    const budgets = [
      ['1', 'Range budget', 'от 100 000 до 500 000 рублей', { min: 100000, max: 500000, currency: 'RUB', originalText: 'от 100 000 до 500 000 рублей' }],
      ['2', 'Upper budget', 'до 250 000 рублей', { max: 250000, currency: 'RUB', originalText: 'до 250 000 рублей' }],
      ['3', 'Lower budget', 'от 1 600 000 рублей', { min: 1600000, currency: 'RUB', originalText: 'от 1 600 000 рублей' }],
      ['4', 'Decimal budget', '12,5 рублей', { min: 12.5, currency: 'RUB', originalText: '12,5 рублей' }],
      ['5', 'Negotiable budget', 'По договоренности', { originalText: 'По договоренности' }],
      ['6', 'Zero budget', '0 рублей', { originalText: '0 рублей' }],
    ];
    const html = budgets.map(([id, title, budget]) => card(Number(id), title, { budget, published: '20 сентября 2026' })).join('');
    const pages = Object.fromEntries(budgets.map(([id, title, budget]) => [`https://workspace.ru/tenders/${slug(title)}-${id}/`, detailWithBudget(id, title, budget)]));

    const result = await new WorkspaceConnector(extractor({ [listUrl]: html, ...pages })).fetchPage(ctx());

    assert.deepEqual(
      result.records.map((record) => [record.externalId, record.sourceMetadata.budget]),
      budgets.map(([id, , , expected]) => [id, expected]),
    );
  });

  it('resumes through the observed AJAX page, dedupes native IDs and preserves exact bounds', async () => {
    const web = extractor({ [listUrl]: listHtml, 'https://workspace.ru/tenders/?page=2': page2Xhr });
    const connector = new WorkspaceConnector(web);

    const first = await connector.fetchPage(ctx());
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));

    assert.equal(web.requests[web.requests.findIndex((request) => request.url === 'https://workspace.ru/tenders/?page=2')].options.ajaxHtmlField, 'tender');
    assert.equal(second.records.length, 10);
    assert.notDeepEqual(second.records.map((record) => record.externalId), first.records.map((record) => record.externalId));
    assert.equal(second.checkpoint.windowSince, '2026-09-04T00:00:00.000Z');
    assert.equal(second.checkpoint.visitedListUrls.includes(listUrl), true);
    assert.equal(second.checkpoint.seenNativeIds.includes('18993'), true);
  });

  it('keeps unknown dates but filters known records outside the fixed 30 day window without cutting pagination', async () => {
    const html = `${card(1, 'Old tender', { published: '01 августа 2026' })}${card(2, 'Unknown tender', { published: '' })}<a href="/tenders/?page=2">Показать ещё 10</a>`;
    const web = extractor({ [listUrl]: html, 'https://workspace.ru/tenders/unknown-tender-2/': detailWithoutDates(2, 'Unknown tender') });

    const result = await new WorkspaceConnector(web).fetchPage(ctx({ backfillSince: '2026-09-04T00:00:00.000Z' }));

    assert.deepEqual(result.records.map((record) => record.externalId), ['2']);
    assert.equal(result.records[0].publishedAt, undefined);
    assert.equal(result.hasMore, true);
    assert.equal(result.checkpoint.nextUrl, 'https://workspace.ru/tenders/?page=2');
    assert.equal(web.requests.some((request) => request.url === 'https://workspace.ru/tenders/old-tender-1/'), false);
  });

  it('caps initial collection windows exactly for SourcesService 31-day ceil and delayed explicit starts', async () => {
    const html = card(7, 'Unknown window tender', { published: '' });
    const detailUrl = 'https://workspace.ru/tenders/unknown-window-tender-7/';
    const cappedDefault = await new WorkspaceConnector(extractor({ [listUrl]: html, [detailUrl]: detailWithoutDates(7, 'Unknown window tender') })).fetchPage(ctx({ backfillSince: undefined, backfillDays: 31 }));

    assert.equal(Date.parse(cappedDefault.checkpoint.windowUntil) - Date.parse(cappedDefault.checkpoint.windowSince), 30 * dayMs);

    const delayedSince = new Date(Date.now() - 31 * dayMs).toISOString();
    const delayed = await new WorkspaceConnector(extractor({ [listUrl]: html, [detailUrl]: detailWithoutDates(7, 'Unknown window tender') })).fetchPage(ctx({ backfillSince: delayedSince, backfillDays: 31 }));

    assert.equal(delayed.checkpoint.windowSince, delayedSince);
    assert.equal(Date.parse(delayed.checkpoint.windowUntil) - Date.parse(delayed.checkpoint.windowSince), 30 * dayMs);

    await assert.rejects(
      () => new WorkspaceConnector(extractor({})).fetchPage(ctx({ backfillSince: 'not-a-date' })),
      /initial publication boundary is invalid or in the future/,
    );

    await assert.rejects(
      () => new WorkspaceConnector(extractor({})).fetchPage(ctx({ backfillSince: new Date(Date.now() + dayMs).toISOString() })),
      /initial publication boundary is invalid or in the future/,
    );
  });

  it('fails truthfully on detail errors, hostile continuations, cycles, missing descriptions and canonical mismatches', async () => {
    await assert.rejects(
      () => new WorkspaceConnector(extractor({ [listUrl]: card(1, 'Bad detail', { published: '20 сентября 2026' }), 'https://workspace.ru/tenders/bad-detail-1/': new Error('HTTP 404') })).fetchPage(ctx()),
      /Workspace detail fetch failed.*HTTP 404/,
    );

    const connector = new WorkspaceConnector(extractor({}));
    await assert.rejects(
      () => connector.fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl: 'https://evil.example/tenders/?page=2', windowSince: '2026-09-04T00:00:00.000Z', windowUntil: '2026-10-05T00:00:00.000Z' } })),
      /invalid listing URL/,
    );

    await assert.rejects(
      () => new WorkspaceConnector(extractor({ [listUrl]: `${card(1, 'Cycle tender')}<a href="/tenders/?page=2">2</a>` })).fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl: listUrl, visitedListUrls: [listUrl], windowSince: '2026-09-04T00:00:00.000Z', windowUntil: '2026-10-05T00:00:00.000Z' } })),
      /repeats a previously visited page/,
    );

    await assert.rejects(
      () => new WorkspaceConnector(extractor({ [listUrl]: card(2, 'Missing description', { published: '20 сентября 2026' }), 'https://workspace.ru/tenders/missing-description-2/': '<html><head><meta name="description" content="SEO teaser"></head><body><h1>Missing description</h1></body></html>' })).fetchPage(ctx()),
      /has no public tender detail description/,
    );

    await assert.rejects(
      () => new WorkspaceConnector(extractor({ [listUrl]: card(3, 'Canonical mismatch', { published: '20 сентября 2026' }), 'https://workspace.ru/tenders/canonical-mismatch-3/': detail(3, 'Canonical mismatch', { canonicalPath: '/tenders/other-4/' }) })).fetchPage(ctx()),
      /canonical URL points to another tender/,
    );
  });

  it('fails resumed pagination when checkpoint bounds are malformed or a claimed continuation has no fresh IDs', async () => {
    const repeatedPage = `${card(1, 'Repeated tender')}<a href="/tenders/?page=3">Показать ещё 10</a>`;
    const repeatedTerminalPage = card(1, 'Repeated tender');

    await assert.rejects(
      () => new WorkspaceConnector(extractor({ 'https://workspace.ru/tenders/?page=2': repeatedPage })).fetchPage(ctx({
        checkpoint: {
          hasMore: true,
          nextUrl: 'https://workspace.ru/tenders/?page=2',
          windowSince: '2026-09-04T00:00:00.000Z',
          windowUntil: '2026-10-05T00:00:00.000Z',
          seenNativeIds: ['1'],
        },
      })),
      /contains only previously seen native tender IDs/,
    );

    await assert.rejects(
      () => new WorkspaceConnector(extractor({ 'https://workspace.ru/tenders/?page=2': repeatedTerminalPage })).fetchPage(ctx({
        checkpoint: {
          hasMore: true,
          nextUrl: 'https://workspace.ru/tenders/?page=2',
          windowSince: '2026-09-04T00:00:00.000Z',
          windowUntil: '2026-10-05T00:00:00.000Z',
          seenNativeIds: ['1'],
        },
      })),
      /contains only previously seen native tender IDs/,
    );

    await assert.rejects(
      () => new WorkspaceConnector(extractor({})).fetchPage(ctx({
        checkpoint: {
          hasMore: true,
          nextUrl: 'https://workspace.ru/tenders/?page=2',
          windowSince: 'not-a-date',
          windowUntil: '2026-10-05T00:00:00.000Z',
        },
      })),
      /invalid fixed publication boundaries/,
    );

    await assert.rejects(
      () => new WorkspaceConnector(extractor({})).fetchPage(ctx({
        checkpoint: {
          hasMore: true,
          nextUrl: 'https://workspace.ru/tenders/?page=2',
          windowSince: '2026-10-06T00:00:00.000Z',
          windowUntil: '2026-10-05T00:00:00.000Z',
        },
      })),
      /invalid fixed publication boundaries/,
    );
  });

  it('validates only the native public tender root and rejects filtered or credentialed URLs', async () => {
    const connector = new WorkspaceConnector(extractor({}));

    assert.equal((await connector.validateConfig({ baseUrl: listUrl })).ok, true);
    assert.equal((await connector.validateConfig({ baseUrl: 'https://workspace.ru/tenders/?STATUS=published' })).ok, false);
    assert.equal((await connector.validateConfig({ baseUrl: 'https://user:pass@workspace.ru/tenders/' })).ok, false);
    assert.equal((await connector.validateConfig({ baseUrl: 'https://workspace.ru/jobs/' })).ok, false);
  });
});
