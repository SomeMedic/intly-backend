import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { GenericPublicWebConnector } = require('../src/modules/sources/connectors/generic-public-web.connector.ts');
const { WebExtractionService } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');

describe('generic public HTML pagination', () => {
  it('retains freelance source prices through normalization into opportunity money', async () => {
    for (const item of [
      { id: 'fl_ru', url: 'https://www.fl.ru/projects/', html: flCard(1) },
      { id: 'weblancer', url: 'https://www.weblancer.net/jobs/', html: weblancerCard(1) },
    ]) {
      const context = ctx(item.id, item.url, { maxPages: 1 });
      const page = await new GenericPublicWebConnector(new FakeWebExtraction({ [item.url]: item.html })).fetchPage(context);
      const normalized = new SourceNormalizerService().normalize(context.source, page.records[0]);
      assert.equal(normalized.money.originalText, page.records[0].sourceMetadata.price.originalText, item.id);
      assert.ok(Object.keys(normalized.money).length > 0, item.id);
      assert.equal(normalized.money.currency, page.records[0].sourceMetadata.price.currency, item.id);
    }
  });

  it('aborts source-specific listing and detail collection without scheduling more details', async () => {
    for (const item of [
      { id: 'fl_ru', url: 'https://www.fl.ru/projects/', html: `${flCard(1)}${flCard(2)}` },
      { id: 'workspace', url: 'https://workspace.ru/tenders/', html: `${workspaceCard(1)}${workspaceCard(2)}`, detailHtml: workspaceDetail() },
    ]) {
      const controller = new AbortController();
      const extraction = new FakeWebExtraction({ [item.url]: item.html, detailHtml: item.detailHtml });
      const extractUrl = extraction.extractUrl.bind(extraction);
      const attempted = [];
      extraction.extractUrl = async (url, options) => {
        assert.equal(options.signal, controller.signal, item.id);
        attempted.push(url);
        if (url !== item.url) controller.abort(new Error('Collection was cancelled'));
        options.signal.throwIfAborted();
        return extractUrl(url);
      };
      await assert.rejects(
        () => new GenericPublicWebConnector(extraction).fetchPage({ ...ctx(item.id, item.url, { maxPages: 1 }), signal: controller.signal }),
        /Collection was cancelled/,
      );
      assert.equal(attempted.length, 2, item.id);
    }
  });

  it('retains every legitimate card on the current listing page for source-specific parsers', async () => {
    const cases = [
      {
        sourceId: 'fl_ru',
        baseUrl: 'https://www.fl.ru/projects/',
        html: `${Array.from({ length: 12 }, (_, index) => flCard(index + 1)).join('')}<a rel="next" href="/projects/?page=2">Следующая</a>`,
        expectedExtraction: 'fl-ru-html',
      },
      {
        sourceId: 'weblancer',
        baseUrl: 'https://www.weblancer.net/jobs/',
        html: `${Array.from({ length: 12 }, (_, index) => weblancerCard(index + 1)).join('')}<a rel="next" href="/jobs/?page=2">Next</a>`,
        expectedExtraction: 'weblancer-html',
      },
      {
        sourceId: 'workspace',
        baseUrl: 'https://workspace.ru/tenders/',
        html: `${Array.from({ length: 12 }, (_, index) => workspaceCard(index + 1)).join('')}<a rel="next" href="/tenders/?page=2">дальше</a>`,
        expectedExtraction: 'workspace-html',
        detailHtml: workspaceDetail(),
      },
    ];

    for (const item of cases) {
      const webExtraction = new FakeWebExtraction({
        [item.baseUrl]: item.html,
        detailHtml: item.detailHtml,
      });
      const result = await new GenericPublicWebConnector(webExtraction).fetchPage(ctx(item.sourceId, item.baseUrl, { maxPages: 5 }));

      assert.equal(result.records.length, 12, item.sourceId);
      assert.equal(result.records[0].sourceMetadata.extraction, item.expectedExtraction);
      assert.equal(result.hasMore, true);
      assert.equal(result.nextPage, 1);
      assert.match(String(result.checkpoint.nextUrl), /\?page=2$/);
    }
  });

  it('continues from the observed next listing URL and clears paging after terminal page', async () => {
    const baseUrl = 'https://www.fl.ru/projects/';
    const webExtraction = new FakeWebExtraction({
      [baseUrl]: `${flCard(1)}${flCard(2)}<a rel="next" href="/projects/?page=2">Следующая</a>`,
      'https://www.fl.ru/projects/?page=2': flCard(3),
    });
    const connector = new GenericPublicWebConnector(webExtraction);

    const first = await connector.fetchPage(ctx('fl_ru', baseUrl, { maxPages: 5 }));
    const second = await connector.fetchPage(ctx('fl_ru', baseUrl, { maxPages: 5 }, first.checkpoint));

    assert.deepEqual(webExtraction.requests, [baseUrl, 'https://www.fl.ru/projects/?page=2']);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextPage, 1);
    assert.equal(second.records.length, 1);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextPage, undefined);
    assert.equal(second.checkpoint.hasMore, false);
    assert.equal(second.checkpoint.nextUrl, undefined);
    assert.equal(second.checkpoint.visitedListUrls, undefined);
  });

  it('accepts live Workspace and FL.ru pagination forms without accepting details', async () => {
    const workspaceBaseUrl = 'https://workspace.ru/tenders/';
    const workspace = await new GenericPublicWebConnector(new FakeWebExtraction({
      [workspaceBaseUrl]: `${workspaceCard(1)}<a href="/tenders/?SORT=public&ORDER=0&page=2" class="box-more__btn" data-page="2">Показать ещё 10</a>`,
      detailHtml: workspaceDetail(),
    })).fetchPage(ctx('workspace', workspaceBaseUrl, { maxPages: 1 }));

    assert.equal(workspace.hasMore, true);
    assert.equal(workspace.checkpoint.nextUrl, 'https://workspace.ru/tenders/?SORT=public&ORDER=0&page=2');

    const flBaseUrl = 'https://www.fl.ru/projects/';
    const fl = await new GenericPublicWebConnector(new FakeWebExtraction({
      [flBaseUrl]: `${flCard(1)}<a href="/projects/page-2/" class="fl-pagination-item fl-pagination-next" label="Следующая →">→</a>`,
    })).fetchPage(ctx('fl_ru', flBaseUrl, { maxPages: 1 }));

    assert.equal(fl.hasMore, true);
    assert.equal(fl.checkpoint.nextUrl, 'https://www.fl.ru/projects/page-2/');

    const flDetailAsNext = await new GenericPublicWebConnector(new FakeWebExtraction({
      [flBaseUrl]: `${flCard(1)}<a href="/projects/123/detail/" class="fl-pagination-item fl-pagination-next">→</a>`,
    })).fetchPage(ctx('fl_ru', flBaseUrl, { maxPages: 1 }));

    assert.equal(flDetailAsNext.hasMore, false);
    assert.equal(flDetailAsNext.checkpoint.nextUrl, undefined);
  });

  it('uses Workspace public AJAX JSON fragments for continuation pages', async () => {
    const baseUrl = 'https://workspace.ru/tenders/';
    const webExtraction = new WorkspaceAjaxFakeWebExtraction({
      [baseUrl]: `${workspaceCard(1)}<a href="/tenders/?SORT=public&ORDER=0&page=2" class="box-more__btn" data-page="2">Показать ещё 10</a>`,
      'https://workspace.ru/tenders/?SORT=public&ORDER=0&page=2': { tender: `${workspaceCard(101)}${workspaceCard(102)}<a href="/tenders/?SORT=public&ORDER=0&page=3" class="box-more__btn" data-page="3">Показать ещё 10</a>` },
      detailHtml: workspaceDetail(),
    });
    const connector = new GenericPublicWebConnector(webExtraction);

    const first = await connector.fetchPage(ctx('workspace', baseUrl, { maxPages: 1 }));
    const second = await connector.fetchPage(ctx('workspace', baseUrl, { maxPages: 1 }, first.checkpoint));

    assert.deepEqual(first.records.map((record) => record.externalId), ['1']);
    assert.deepEqual(second.records.map((record) => record.externalId), ['101', '102']);
    assert.equal(second.hasMore, true);
    assert.equal(second.checkpoint.nextUrl, 'https://workspace.ru/tenders/?SORT=public&ORDER=0&page=3');
    assert.equal(webExtraction.ajaxRequests, 1);
  });

  it('enriches FL.ru cards from public detail pages without losing list fields', async () => {
    const baseUrl = 'https://www.fl.ru/projects/';
    const webExtraction = new FakeWebExtraction({
      [baseUrl]: flCard(5521884),
      flDetailHtml: flDetail(5521884, {
        title: 'Senior SEO/GEO-специалист',
        description: 'Full public FL.ru description with responsibilities and client context.',
        priceText: 'по результатам собеседования',
        conditions: [
          ['Опыт:', '3 – 6 лет'],
          ['Занятость:', 'Постоянная'],
          ['Работа:', 'Удаленная'],
        ],
        publishedText: 'Опубликована 14.09.2026 в 11:50 до 14.10.2026',
      }),
    });

    const result = await new GenericPublicWebConnector(webExtraction).fetchPage(ctx('fl_ru', baseUrl, { maxPages: 1 }));

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].externalId, '5521884');
    assert.equal(result.records[0].title, 'Senior SEO/GEO-специалист');
    assert.equal(result.records[0].description, 'Full public FL.ru description with responsibilities and client context.');
    assert.equal(result.records[0].rawPayload.listDescription, 'Build parser 5521884');
    assert.equal(result.records[0].sourceMetadata.priceText, 'по результатам собеседования');
    assert.equal(result.records[0].sourceMetadata.deadlineText, '14.10.2026');
    assert.match(result.records[0].sourceMetadata.requirementsText, /Опыт: 3 – 6 лет/);
    assert.equal(result.records[0].sourceMetadata.descriptionCoverage, 'detail-full');
    assert.deepEqual(webExtraction.detailRequests, ['https://www.fl.ru/projects/5521884/task-5521884.html']);
  });

  it('propagates FL.ru detail fetch failures so the listing page can be retried', async () => {
    const baseUrl = 'https://www.fl.ru/projects/';
    const webExtraction = new FakeWebExtraction({
      [baseUrl]: flCard(1),
      flDetailHtml: null,
    });

    await assert.rejects(
      () => new GenericPublicWebConnector(webExtraction).fetchPage(ctx('fl_ru', baseUrl, { maxPages: 1 })),
      /Unexpected URL https:\/\/www\.fl\.ru\/projects\/1\/task-1\.html/,
    );
  });

  it('rejects FL.ru detail pages without public description unless the page explicitly says it is preview-only', async () => {
    const baseUrl = 'https://www.fl.ru/projects/';

    await assert.rejects(
      () => new GenericPublicWebConnector(new FakeWebExtraction({
        [baseUrl]: flCard(2),
        flDetailHtml: flDetailWithoutDescription(2),
      })).fetchPage(ctx('fl_ru', baseUrl, { maxPages: 1 })),
      /FL\.ru project detail is missing description/,
    );

    const preview = await new GenericPublicWebConnector(new FakeWebExtraction({
      [baseUrl]: flCard(3),
      flDetailHtml: flPreviewOnlyDetail(3),
    })).fetchPage(ctx('fl_ru', baseUrl, { maxPages: 1 }));

    assert.equal(preview.records[0].description, 'Build parser 3');
    assert.equal(preview.records[0].sourceMetadata.descriptionCoverage, 'list-preview');
    assert.equal(preview.records[0].rawPayload.detailDescription, undefined);
  });

  it('propagates Workspace detail fetch failures so the page can be retried', async () => {
    const baseUrl = 'https://workspace.ru/tenders/';
    const webExtraction = new FakeWebExtraction({
      [baseUrl]: workspaceCard(1),
    });

    await assert.rejects(
      () => new GenericPublicWebConnector(webExtraction).fetchPage(ctx('workspace', baseUrl, { maxPages: 1 })),
      /Unexpected URL https:\/\/workspace\.ru\/tenders\/build-service-1\//,
    );
  });

  it('rejects Workspace records when detail has no concrete description', async () => {
    const baseUrl = 'https://workspace.ru/tenders/';
    const webExtraction = new FakeWebExtraction({
      [baseUrl]: workspaceCard(1),
      detailHtml: '<link rel="canonical" href="https://workspace.ru/tenders/build-service-1/">',
    });

    await assert.rejects(
      () => new GenericPublicWebConnector(webExtraction).fetchPage(ctx('workspace', baseUrl, { maxPages: 1 })),
      /Workspace tender detail is missing description/,
    );
  });

  it('fails Workspace continuation when AJAX JSON does not contain a valid tender HTML fragment', async () => {
    const baseUrl = 'https://workspace.ru/tenders/';
    const webExtraction = new WorkspaceAjaxFakeWebExtraction({
      [baseUrl]: `${workspaceCard(1)}<a href="/tenders/?SORT=public&ORDER=0&page=2" class="box-more__btn" data-page="2">Показать ещё 10</a>`,
      'https://workspace.ru/tenders/?SORT=public&ORDER=0&page=2': { title: 'Каталог тендеров' },
      detailHtml: workspaceDetail(),
    });
    const connector = new GenericPublicWebConnector(webExtraction);

    const first = await connector.fetchPage(ctx('workspace', baseUrl, { maxPages: 1 }));

    await assert.rejects(
      () => connector.fetchPage(ctx('workspace', baseUrl, { maxPages: 1 }, first.checkpoint)),
      /AJAX response missing HTML field: tender/,
    );
  });

  it('uses the immediate numeric page on GeekJob-style pagination', async () => {
    const baseUrl = 'https://geekjob.ru/vacancies/';
    const webExtraction = new GenericCapableFakeWebExtraction({
      [baseUrl]: `
        <a href="/vacancy/0123456789abcdef01234567">Backend</a>
        <nav class="pagination">
          <a class="pagination__item active" href="/vacancies/">1</a>
          <a class="pagination__item" href="/vacancies/2">2</a>
          <a class="pagination__item" href="/vacancies/3">3</a>
          <a class="pagination__item" href="/vacancies/4">4</a>
          <a class="pagination__item" href="/vacancies/5">chevron_right</a>
        </nav>
      `,
      'https://geekjob.ru/vacancy/0123456789abcdef01234567': '<h1>Backend Engineer</h1><main><p>Apply for backend work. Requirements: TypeScript, remote company.</p></main>',
    });

    const result = await new GenericPublicWebConnector(webExtraction).fetchPage(ctx('generic_public', baseUrl, { maxPages: 1 }));

    assert.equal(result.hasMore, true);
    assert.equal(result.checkpoint.nextUrl, 'https://geekjob.ru/vacancies/2');
  });

  it('continues through an observed chain longer than configured maxPages', async () => {
    const baseUrl = 'https://www.fl.ru/projects/';
    const webExtraction = new FakeWebExtraction({
      [baseUrl]: `${flCard(1)}<a rel="next" href="/projects/?page=2">Следующая</a>`,
      'https://www.fl.ru/projects/?page=2': `${flCard(2)}<a rel="next" href="/projects/?page=3">Следующая</a>`,
      'https://www.fl.ru/projects/?page=3': `${flCard(3)}<a rel="next" href="/projects/?page=4">Следующая</a>`,
      'https://www.fl.ru/projects/?page=4': flCard(4),
    });
    const connector = new GenericPublicWebConnector(webExtraction);
    let checkpoint = {};
    const hasMoreResults = [];

    for (let index = 0; index < 4; index += 1) {
      const result = await connector.fetchPage(ctx('fl_ru', baseUrl, { maxPages: 2 }, checkpoint));
      hasMoreResults.push(result.hasMore);
      checkpoint = result.checkpoint;
    }

    assert.deepEqual(webExtraction.requests, [
      baseUrl,
      'https://www.fl.ru/projects/?page=2',
      'https://www.fl.ru/projects/?page=3',
      'https://www.fl.ru/projects/?page=4',
    ]);
    assert.deepEqual(hasMoreResults, [true, true, true, false]);
  });

  it('rejects cycle, off-origin, unsafe, credentialed, detail, and unrelated-route pagination links', async () => {
    const baseUrl = 'https://www.fl.ru/projects/';
    const cases = {
      cycle: `${flCard(1)}<a rel="next" href="/projects/">Следующая</a>`,
      offHost: `${flCard(1)}<a rel="next" href="https://evil.example/projects/?page=2">Следующая</a>`,
      offPort: `${flCard(1)}<a rel="next" href="https://www.fl.ru:444/projects/?page=2">Следующая</a>`,
      javascript: `${flCard(1)}<a rel="next" href="javascript:alert(1)">Следующая</a>`,
      credentials: `${flCard(1)}<a rel="next" href="https://user:pass@www.fl.ru/projects/?page=2">Следующая</a>`,
      detail: `${flCard(1)}<a rel="next" href="/projects/123/task.html">Следующая</a>`,
      unrelatedRoute: `${flCard(1)}<a rel="next" href="/users/?page=2">Следующая</a>`,
    };

    for (const [name, html] of Object.entries(cases)) {
      const result = await new GenericPublicWebConnector(new FakeWebExtraction({ [baseUrl]: html })).fetchPage(ctx('fl_ru', baseUrl, { maxPages: 5 }));

      assert.equal(result.hasMore, false, name);
      assert.equal(result.nextPage, undefined, name);
      assert.equal(result.checkpoint.hasMore, false, name);
      assert.equal(result.checkpoint.nextUrl, undefined, name);
    }
  });

  it('keeps visited listing URLs across attempts to stop observed pagination cycles', async () => {
    const baseUrl = 'https://www.fl.ru/projects/';
    const webExtraction = new FakeWebExtraction({
      [baseUrl]: `${flCard(1)}<a rel="next" href="/projects/?page=2">Следующая</a>`,
      'https://www.fl.ru/projects/?page=2': `${flCard(2)}<a rel="next" href="/projects/?page=2">Следующая</a>`,
    });
    const connector = new GenericPublicWebConnector(webExtraction);

    const first = await connector.fetchPage(ctx('fl_ru', baseUrl, { maxPages: 2 }));
    const second = await connector.fetchPage(ctx('fl_ru', baseUrl, { maxPages: 2 }, first.checkpoint));

    assert.deepEqual(webExtraction.requests, [baseUrl, 'https://www.fl.ru/projects/?page=2']);
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, false);
    assert.equal(second.checkpoint.nextUrl, undefined);
  });

  it('starts a fresh listing cycle after a terminal checkpoint', async () => {
    const baseUrl = 'https://www.fl.ru/projects/';
    const webExtraction = new FakeWebExtraction({
      [baseUrl]: flCard(1),
      'https://www.fl.ru/projects/?page=2': flCard(2),
    });

    await new GenericPublicWebConnector(webExtraction).fetchPage(ctx('fl_ru', baseUrl, { maxPages: 5 }, { hasMore: false, nextUrl: 'https://www.fl.ru/projects/?page=2' }));

    assert.deepEqual(webExtraction.requests, [baseUrl]);
  });
});

class FakeWebExtraction {
  requests = [];
  detailRequests = [];

  constructor(pages) {
    this.pages = pages;
  }

  async extractUrl(url) {
    const finalUrl = new URL(url).toString();
    const isDetail = this.isDetailUrl(finalUrl) || this.isFlRuDetailUrl(finalUrl);
    if (isDetail) {
      this.detailRequests.push(finalUrl);
    } else {
      this.requests.push(finalUrl);
    }
    const html = this.pages[finalUrl] ?? this.pages[url] ?? this.detailHtml(finalUrl);
    if (!html) throw new Error(`Unexpected URL ${finalUrl}`);
    return { html, finalUrl };
  }

  detailHtml(url) {
    if (this.isDetailUrl(url)) return this.pages.detailHtml;
    if (!this.isFlRuDetailUrl(url)) return undefined;
    if (this.pages.flDetailHtml === null) return undefined;
    const id = /\/projects\/(\d+)\//.exec(new URL(url).pathname)?.[1] ?? '1';
    return this.pages.flDetailHtml ?? flDetail(id);
  }

  isDetailUrl(url) {
    return /\/tenders\/[^/]+-\d+\/$/.test(new URL(url).pathname);
  }

  isFlRuDetailUrl(url) {
    return /\/projects\/\d+\/[^/]+\.html$/.test(new URL(url).pathname);
  }
}

class GenericCapableFakeWebExtraction extends FakeWebExtraction {
  service = new WebExtractionService();

  async extractUrl(url) {
    const document = await super.extractUrl(url);
    return { metadata: {}, ...document };
  }

  extractOpportunityLinks(document, allowedHosts, limit) {
    return this.service.extractOpportunityLinks(document, allowedHosts, limit);
  }

  async extractOpportunityFromUrl(url, input) {
    const document = await this.extractUrl(url);
    return this.service.documentToRecord(document, {
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      type: input.type ?? 'vacancy',
      requireOpportunitySignal: input.requireOpportunitySignal,
    });
  }

  documentToRecord(document, input) {
    return this.service.documentToRecord(document, input);
  }
}

class WorkspaceAjaxFakeWebExtraction extends FakeWebExtraction {
  ajaxRequests = 0;

  async extractUrl(url, options = {}) {
    if (options.ajaxHtmlField) {
      this.ajaxRequests += 1;
      if (options.ajaxHtmlField !== 'tender') throw new Error('Unexpected AJAX field');
      const finalUrl = new URL(url).toString();
      this.requests.push(finalUrl);
      const payload = this.pages[finalUrl] ?? this.pages[url];
      const html = payload?.tender;
      if (!html || !/<[a-z][\s\S]*>/i.test(html)) throw new Error(`AJAX response missing HTML field: ${options.ajaxHtmlField}`);
      return { finalUrl, html, metadata: { firecrawl: false, ajax: true, ajaxHtmlField: options.ajaxHtmlField } };
    }
    return super.extractUrl(url, options);
  }
}

function ctx(sourceId, baseUrl, limits, checkpoint = {}) {
  return {
    source: {
      _id: sourceId,
      name: sourceId,
      endpoint: { baseUrl },
      opportunityTypes: sourceId === 'workspace' ? ['tender'] : ['freelance'],
      timeoutMs: 30_000,
      limits,
    },
    requestId: 'test-run',
    checkpoint,
    backfillDays: 30,
  };
}

function flCard(id) {
  return `
    <div class="b-page__lenta_item b-post">
      <a data-disposable-project-id="${id}" href="/projects/${id}/task-${id}.html">FL project ${id}</a>
      <div class="b-post__txt text-5 ">Build parser ${id}</div>
      <span class="b-post__bold">Заказ</span>
      <span class="text-gray-opacity-4">1 час назад</span>
    </div>
  `;
}

function flDetail(id, options = {}) {
  const title = options.title ?? `FL project ${id}`;
  const description = options.description ?? `Detailed FL.ru project ${id} requirements`;
  const priceText = options.priceText ?? `${id} 000 ₽`;
  const publishedText = options.publishedText ?? 'Опубликована 01.10.2026 в 12:00 до 30.10.2026';
  const conditions = options.conditions ?? [['Опыт:', '1 – 3 года'], ['Работа:', 'Удаленная']];
  return `
    <link rel="canonical" href="https://www.fl.ru/projects/${id}/task-${id}.html" />
    <section class="fl-project-card__vacancy-info border-top my-10 pt-20">
      ${conditions.map(([label, value]) => `
        <div class="mt-10 fl-project-card__vacancy-info-line">
          <span class="text-6">${label}</span>
          <span class="text-5">${value}</span>
        </div>
      `).join('')}
    </section>
    <div class="fl-project-content col-12 mb-40">
      <h1 class="text-3" id="prj_name_${id}">${title}</h1>
      <!-- Бюджет -->
      <div class="text-4">Оплата: <span class="text-4">${priceText}</span></div>
      <div id="project_info_${id}" class="b-layout text-dark order-first order-lg-0 mb-30">
        <div id="projectp${id}" class="text-5 pb-20 fl-project-content__description-text wizard__editor">
          ${description}
          <div><div class="text-10 opacity-50">${publishedText}</div></div>
        </div>
      </div>
    </div>
  `;
}

function flDetailWithoutDescription(id) {
  return `
    <link rel="canonical" href="https://www.fl.ru/projects/${id}/task-${id}.html" />
    <div class="fl-project-content col-12 mb-40">
      <h1 id="prj_name_${id}">FL project ${id}</h1>
      <!-- Бюджет --><div>Оплата: <span>10 000 ₽</span></div>
    </div>
  `;
}

function flPreviewOnlyDetail(id) {
  return `
    <link rel="canonical" href="https://www.fl.ru/projects/${id}/task-${id}.html" />
    <div class="fl-project-content col-12 mb-40">
      <h1 id="prj_name_${id}">FL project ${id}</h1>
      <p>Полное описание проекта доступно после авторизации.</p>
      <!-- Бюджет --><div>Оплата: <span>10 000 ₽</span></div>
    </div>
  `;
}

function weblancerCard(id) {
  const day = String(id).padStart(2, '0');
  return `
    <article class="bg-white rounded-md">
      <h2><a href="/freelance/dev-${id}/">Parser project ${id}</a></h2>
      <p class="text-gray-600">Build Weblancer parser ${id}</p>
      <span class="text-green-600">$${id * 10}</span>
      <a href="/freelance/development/">Development</a>
      <span>${day}.10.2026</span>
      <span>${id} заявок</span>
      <span>${id * 3} просмотров</span>
    </article>
  `;
}

function workspaceCard(id) {
  return `
    <div class="vacancies__card _tender">
      <div><a href="/tenders/build-service-${id}/">Workspace tender ${id}</a></div>
      <div class="b-tender__info-item-text">от ${id}00 000 ₽</div>
      <div class="b-tender__info-item-title">Опубликован</div>
      <div class="b-tender__info-item-text">1 октября 2026</div>
      <div class="b-tender__info-item-title">Крайний срок</div>
      <div class="b-tender__info-item-text">30 октября 2026</div>
      <div class="tendercart-type__status-public">Идет прием заявок</div>
    </div>
  `;
}

function workspaceDetail() {
  return `
    <link rel="canonical" href="https://workspace.ru/tenders/build-service-1/">
    <div class="tendercard__desc">Detailed tender requirements</div>
    <div class="b-tender__info-item-title">Бюджет</div>
    <div class="b-tender__info-item-text">до 500 000 ₽</div>
  `;
}
