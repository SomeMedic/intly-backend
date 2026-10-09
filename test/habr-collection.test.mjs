import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { HabrConnector } = require('../src/modules/sources/connectors/habr.connector.ts');
const { ConnectorRegistryService } = require('../src/modules/sources/connectors/connector-registry.service.ts');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, 'fixtures', 'habr');
const page1Url = 'https://career.habr.com/vacancies?page=1&sort=date&type=all';
const page2Url = 'https://career.habr.com/vacancies?page=2&sort=date&type=all';
const page3Url = 'https://career.habr.com/vacancies?page=3&sort=date&type=all';
const page1 = readFileSync(join(fixtures, 'page-1.html'), 'utf8');
const page2 = readFileSync(join(fixtures, 'page-2.html'), 'utf8');

function ctx(overrides = {}) {
  return {
    source: {
      _id: 'habr',
      name: 'Habr Career',
      connectorFamily: 'OfficialFeed',
      endpoint: { baseUrl: 'https://career.habr.com/vacancies?sort=date&type=all&page=1' },
      config: {},
      timeoutMs: 30_000,
      ...overrides.source,
    },
    checkpoint: {},
    backfillDays: 30,
    backfillSince: '2026-09-04T00:00:00.000Z',
    requestId: 'habr-test',
    ...overrides,
  };
}

class FakeExtraction {
  constructor(pages = {}) {
    this.pages = pages;
    this.listCalls = [];
    this.detailCalls = [];
  }

  async extractUrl(url, options = {}) {
    const key = canonicalListUrl(url);
    this.listCalls.push({ url: key, options });
    const html = this.pages[key];
    if (!html) throw new Error(`Unexpected Habr list ${key}`);
    return { finalUrl: key, html, metadata: { firecrawl: false } };
  }

  async extractOpportunityFromUrl(url, input = {}) {
    this.detailCalls.push({ url, input });
    const id = /\/vacancies\/(\d+)/.exec(url)?.[1];
    if (!id) throw new Error(`Unexpected Habr detail ${url}`);
    return detailRecord(id, input.detailUrlOverride ?? url);
  }
}

function canonicalListUrl(input) {
  const url = new URL(input, page1Url);
  url.searchParams.set('sort', 'date');
  url.searchParams.set('type', url.searchParams.get('type') ?? 'all');
  url.searchParams.set('page', url.searchParams.get('page') ?? '1');
  url.searchParams.sort();
  return url.toString();
}

function detailRecord(id, url = `https://career.habr.com/vacancies/${id}`, overrides = {}) {
  return {
    externalId: `detail-${id}`,
    url,
    type: 'vacancy',
    title: `Detail title ${id}`,
    companyOrClient: 'Detail company',
    description: overrides.description ?? 'Навыки: Go, SQL. Квалификация: Средний (Middle). Специализации: Backend разработчик. Полное описание вакансии.',
    sourceStatus: 'Unknown',
    rawPayload: { id, full: true },
    sourceMetadata: overrides.sourceMetadata ?? { extraction: 'http-html', detailOnly: true },
  };
}

function listHtml({ cards, nextHref }) {
  return `<!doctype html><html><body><div class="vacancies">${cards.map(cardHtml).join('\n')}</div>${nextHref ? `<a class="pagination__next" href="${nextHref}">Next ›</a>` : ''}</body></html>`;
}

function cardHtml({ id, title = `Vacancy ${id}`, datetime = '2026-10-04T10:00:00+03:00', company = 'Company', salary = 'от 100 000 ₽', location = 'Москва', locations, seniority, remote = false, skills = ['Go', 'SQL'] }) {
  const locationValues = locations ?? (location ? [location] : []);
  const chips = [
    seniority ? chipHtml('grade', seniority) : '',
    ...locationValues.map((value) => chipHtml('placemark', value)),
    remote ? chipHtml('remote', 'Удаленно') : '',
  ].join('');
  return `<div class="vacancy-card"><div class="vacancy-card__date"><time datetime="${datetime}">4 октября</time></div><div class="vacancy-card__company"><a>${company}</a></div><div class="vacancy-card__title"><a class="vacancy-card__title-link" href="/vacancies/${id}">${title}</a></div><div class="vacancy-card__salary">${salary}</div><div class="vacancy-card__meta">${chips}</div><div class="vacancy-card__skills">${skills.map((skill) => `<a class="vacancy-card__skills-chip" href="/vacancies/skills/${skill.toLowerCase()}">${skill}</a>`).join('')}</div></div>`;
}

function chipHtml(icon, text) {
  return `<div class="basic-chip"><svg><use xlink:href="/images/icons-sprite.svg#${icon}"></use></svg><div class="chip-with-icon__text">${text}</div></div>`;
}

describe('Habr Career public HTML collection', () => {
  it('collects a real public listing page, enriches all 25 details, and exposes durable next pagination', async () => {
    const web = new FakeExtraction({ [page1Url]: page1 });
    const result = await new HabrConnector(web).fetchPage(ctx());

    assert.equal(result.records.length, 25);
    assert.equal(result.records[0].externalId, '1000167378');
    assert.equal(result.records[0].url, 'https://career.habr.com/vacancies/1000167378');
    assert.equal(result.records[0].publishedAt.toISOString(), '2026-10-04T14:46:20.000Z');
    assert.equal(result.records[0].title, 'Detail title 1000167378');
    assert.equal(result.records[0].sourceMetadata.listPublishedAt, '2026-10-04T17:46:20+03:00');
    assert.deepEqual(result.records[0].sourceMetadata.skills, ['PostgreSQL', 'Redis', 'C#']);
    assert.equal(result.records[0].sourceMetadata.seniority, 'Средний (Middle)');
    const internCard = result.records.find((record) => record.externalId === '1000167380');
    assert.equal(internCard.sourceMetadata.listSeniority, 'Intern');
    assert.equal(internCard.sourceMetadata.listLocation, 'Москва');
    assert.equal(internCard.sourceMetadata.location, 'Москва');
    assert.equal(result.hasMore, true);
    assert.equal(result.checkpoint.nextUrl, page2Url);
    assert.deepEqual(result.checkpoint.visitedListUrls, [page1Url]);
    assert.equal(web.detailCalls.length, 25);
    assert.deepEqual(web.listCalls[0].options.allowedHosts, ['career.habr.com']);
    assert.equal(web.detailCalls[0].input.requireOpportunitySignal, true);
  });

  it('continues to the next real page without duplicating ids and preserves type=all query', async () => {
    const web = new FakeExtraction({ [page1Url]: page1, [page2Url]: page2 });
    const connector = new HabrConnector(web);
    const first = await connector.fetchPage(ctx());
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));

    assert.equal(second.records.length, 25);
    assert.equal(second.records[0].externalId, '1000167369');
    assert.equal(second.checkpoint.nextUrl, page3Url);
    assert.equal(second.checkpoint.seenExternalIds.length, 50);
    const leadCard = second.records.find((record) => record.externalId === '1000167334');
    assert.equal(leadCard.sourceMetadata.listSeniority, 'Lead');
    assert.equal(leadCard.sourceMetadata.listLocation, 'Москва');
    assert.equal(leadCard.sourceMetadata.location, 'Москва');
    assert.deepEqual(web.listCalls.map((call) => call.url), [page1Url, page2Url]);
  });

  it('filters to the fixed collection window, stops on all-known older pages, and retains unknown dates', async () => {
    const recent = cardHtml({ id: '1001', datetime: '2026-10-04T10:00:00+03:00' });
    const old = cardHtml({ id: '1002', datetime: '2026-08-01T10:00:00+03:00' });
    const unknown = cardHtml({ id: '1003' }).replace(/<time[^>]*>[\s\S]*?<\/time>/, '<span>без даты</span>');
    const firstHtml = listHtml({ cards: [], nextHref: '/vacancies?page=2&sort=date&type=all' }).replace('<div class="vacancies"></div>', `<div class="vacancies">${recent}${old}${unknown}</div>`);
    const oldHtml = listHtml({ cards: [{ id: '2001', datetime: '2026-08-01T10:00:00+03:00' }, { id: '2002', datetime: '2026-08-01T09:00:00+03:00' }], nextHref: '/vacancies?page=3&sort=date&type=all' });
    const web = new FakeExtraction({ [page1Url]: firstHtml, [page2Url]: oldHtml });
    const connector = new HabrConnector(web);
    const first = await connector.fetchPage(ctx());
    const second = await connector.fetchPage(ctx({ checkpoint: first.checkpoint }));

    assert.deepEqual(first.records.map((record) => record.externalId), ['1001', '1003']);
    assert.equal(first.hasMore, true);
    assert.deepEqual(second.records, []);
    assert.equal(second.hasMore, false);
    assert.equal(second.checkpoint.terminalReason, 'fixed-window-exhausted');
  });

  it('rejects unsafe explicit next pagination, cycles, and detail redirects to another vacancy', async () => {
    const unsafeHtml = listHtml({ cards: [{ id: '3001' }], nextHref: 'https://evil.example.com/vacancies?page=2&sort=date&type=all' });
    const web = new FakeExtraction({ [page1Url]: unsafeHtml });
    await assert.rejects(() => new HabrConnector(web).fetchPage(ctx()), /observed next pagination link/);

    await assert.rejects(
      () => new HabrConnector(new FakeExtraction({ [page1Url]: listHtml({ cards: [{ id: '3002' }] }) })).fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl: page1Url, backfillSince: '2026-09-04T00:00:00.000Z', windowTo: '2026-10-04T00:00:00.000Z', visitedListUrls: [page1Url], seenExternalIds: [] } })),
      /pagination cycle/,
    );

    class RedirectExtraction extends FakeExtraction {
      async extractOpportunityFromUrl(url, input = {}) {
        this.detailCalls.push({ url, input });
        return detailRecord('9999', 'https://career.habr.com/vacancies/9999');
      }
    }
    await assert.rejects(() => new HabrConnector(new RedirectExtraction({ [page1Url]: listHtml({ cards: [{ id: '3003' }] }) })).fetchPage(ctx()), /different vacancy/);

    class EvilSamePathExtraction extends FakeExtraction {
      async extractOpportunityFromUrl(url, input = {}) {
        this.detailCalls.push({ url, input });
        return detailRecord('3004', 'https://evil.example.com/vacancies/3004');
      }
    }
    await assert.rejects(() => new HabrConnector(new EvilSamePathExtraction({ [page1Url]: listHtml({ cards: [{ id: '3004' }] }) })).fetchPage(ctx()), /different vacancy/);
  });

  it('fails loud on malformed Habr listing contracts instead of returning partial or terminal success', async () => {
    const extraFilterNext = listHtml({ cards: [{ id: '5001' }], nextHref: '/vacancies?page=2&sort=date&type=remote' });
    await assert.rejects(() => new HabrConnector(new FakeExtraction({ [page1Url]: extraFilterNext })).fetchPage(ctx()), /observed next pagination link/);

    const unrelatedQueryNext = listHtml({ cards: [{ id: '5006' }], nextHref: '/vacancies?page=2&sort=date&type=all&q=go' });
    await assert.rejects(() => new HabrConnector(new FakeExtraction({ [page1Url]: unrelatedQueryNext })).fetchPage(ctx()), /observed next pagination link/);

    const malformedNext = listHtml({ cards: [{ id: '5007' }], nextHref: 'https://[::1/vacancies?page=2&sort=date&type=all' });
    await assert.rejects(() => new HabrConnector(new FakeExtraction({ [page1Url]: malformedNext })).fetchPage(ctx()), /observed next pagination link/);

    const nonAdjacentNext = listHtml({ cards: [{ id: '5002' }], nextHref: '/vacancies?page=4&sort=date&type=all' });
    await assert.rejects(() => new HabrConnector(new FakeExtraction({ [page1Url]: nonAdjacentNext })).fetchPage(ctx()), /jumps from page 1 to 4/);

    const unsafeCard = '<div class="vacancy-card"><a class="vacancy-card__title-link" href="https://evil.example.com/vacancies/5003">Bad</a></div>';
    await assert.rejects(() => new HabrConnector(new FakeExtraction({ [page1Url]: `<!doctype html><html><body>${unsafeCard}</body></html>` })).fetchPage(ctx()), /invalid public vacancy URL/);

    const missingTitle = '<div class="vacancy-card"><a class="vacancy-card__title-link" href="/vacancies/5004"></a></div>';
    await assert.rejects(() => new HabrConnector(new FakeExtraction({ [page1Url]: `<!doctype html><html><body>${missingTitle}</body></html>` })).fetchPage(ctx()), /has no title/);

    await assert.rejects(
      () => new HabrConnector(new FakeExtraction({ [page2Url]: listHtml({ cards: [{ id: '5005' }] }) })).fetchPage(ctx({ checkpoint: { hasMore: true, nextUrl: page2Url, visitedListUrls: [page1Url], seenExternalIds: [] } })),
      /missing the fixed collection window/,
    );

    await assert.rejects(
      () => new HabrConnector(new FakeExtraction()).fetchPage(ctx({ source: { endpoint: { baseUrl: 'https://career.habr.com/vacancies?page=1&sort=date&type=remote' } } })),
      /initial list URL/,
    );
  });

  it('uses actual page numbers, preserves detail facts, keeps paginating only when old pages are date-ordered, and stops scheduling details after failures', async () => {
    class SparseDetailExtraction extends FakeExtraction {
      async extractOpportunityFromUrl(url, input = {}) {
        this.detailCalls.push({ url, input });
        const id = /\/vacancies\/(\d+)/.exec(url)?.[1];
        return detailRecord(id, url, {
          description: 'Полное описание без Habr declared skills.',
          sourceMetadata: { skills: ['DetailSkill'], location: 'Detail location', area: 'Detail area' },
        });
      }
    }
    const sparse = new SparseDetailExtraction({ [page1Url]: listHtml({ cards: [{ id: '6001', skills: [], location: '', seniority: 'Lead' }], nextHref: '/vacancies?page=2&sort=date&type=all' }) });
    const sparseResult = await new HabrConnector(sparse).fetchPage(ctx());
    assert.equal(sparseResult.nextPage, 2);
    assert.equal(sparseResult.checkpoint.page, 2);
    assert.deepEqual(sparseResult.records[0].sourceMetadata.skills, ['DetailSkill']);
    assert.equal(sparseResult.records[0].sourceMetadata.location, 'Detail location');
    assert.equal(sparseResult.records[0].sourceMetadata.area, 'Detail area');
    assert.equal(sparseResult.records[0].sourceMetadata.seniority, 'Lead');
    assert.equal(sparseResult.records[0].sourceMetadata.listLocation, undefined);
    assert.equal(sparseResult.records[0].sourceMetadata.listSeniority, 'Lead');

    const unsortedOld = listHtml({
      cards: [
        { id: '6002', datetime: '2026-08-01T10:00:00+03:00' },
        { id: '6003', datetime: '2026-08-02T10:00:00+03:00' },
      ],
      nextHref: '/vacancies?page=2&sort=date&type=all',
    });
    const unsorted = await new HabrConnector(new FakeExtraction({ [page1Url]: unsortedOld })).fetchPage(ctx());
    assert.equal(unsorted.records.length, 0);
    assert.equal(unsorted.hasMore, true);
    assert.equal(unsorted.checkpoint.nextUrl, page2Url);

    class FailingDetailExtraction extends FakeExtraction {
      async extractOpportunityFromUrl(url, input = {}) {
        this.detailCalls.push({ url, input });
        if (this.detailCalls.length === 1) throw new Error('detail boom');
        return detailRecord(/\/vacancies\/(\d+)/.exec(url)?.[1], url);
      }
    }
    const sixCards = Array.from({ length: 6 }, (_, index) => ({ id: String(7001 + index) }));
    const failing = new FailingDetailExtraction({ [page1Url]: listHtml({ cards: sixCards }) });
    await assert.rejects(() => new HabrConnector(failing).fetchPage(ctx()), /detail boom/);
    assert.ok(failing.detailCalls.length <= 4, `expected no more than concurrency in-flight calls, got ${failing.detailCalls.length}`);
  });

  it('maps Habr meta chips by explicit icon instead of treating grade chips as city', async () => {
    class PlainDetailExtraction extends FakeExtraction {
      async extractOpportunityFromUrl(url, input = {}) {
        this.detailCalls.push({ url, input });
        const id = /\/vacancies\/(\d+)/.exec(url)?.[1];
        const metadataById = {
          8001: { extraction: 'http-html', locations: [] },
          8004: { extraction: 'http-html', remoteType: 'remote', locations: [] },
        };
        return detailRecord(id, url, { description: 'Полное описание без Habr declared facts.', sourceMetadata: metadataById[id] ?? { extraction: 'http-html' } });
      }
    }
    const web = new PlainDetailExtraction({
      [page1Url]: listHtml({
        cards: [
          { id: '8001', seniority: 'Lead', locations: ['Новосибирск', 'Москва'] },
          { id: '8002', seniority: 'Middle', location: '', remote: true },
          { id: '8003', seniority: 'Senior', location: '' },
          { id: '8004', locations: ['Казань', 'Иннополис'], remote: true },
        ],
      }),
    });
    const result = await new HabrConnector(web).fetchPage(ctx());
    const byId = new Map(result.records.map((record) => [record.externalId, record]));

    assert.equal(byId.get('8001').sourceMetadata.location, 'Новосибирск, Москва');
    assert.equal(byId.get('8001').sourceMetadata.area, 'Новосибирск, Москва');
    assert.deepEqual(byId.get('8001').sourceMetadata.locations, ['Новосибирск', 'Москва']);
    assert.equal(byId.get('8001').sourceMetadata.seniority, 'Lead');
    assert.equal(byId.get('8001').sourceMetadata.listLocation, 'Новосибирск, Москва');
    assert.deepEqual(byId.get('8001').sourceMetadata.listLocations, ['Новосибирск', 'Москва']);

    assert.equal(byId.get('8002').sourceMetadata.location, undefined);
    assert.equal(byId.get('8002').sourceMetadata.seniority, 'Middle');
    assert.equal(byId.get('8002').sourceMetadata.remoteType, 'remote');
    assert.equal(byId.get('8002').sourceMetadata.listRemoteType, 'remote');

    assert.equal(byId.get('8003').sourceMetadata.location, undefined);
    assert.equal(byId.get('8003').sourceMetadata.area, undefined);
    assert.equal(byId.get('8003').sourceMetadata.seniority, 'Senior');
    assert.equal(byId.get('8003').sourceMetadata.listLocation, undefined);

    assert.equal(byId.get('8004').sourceMetadata.location, 'Казань, Иннополис');
    assert.equal(byId.get('8004').sourceMetadata.area, 'Казань, Иннополис');
    assert.deepEqual(byId.get('8004').sourceMetadata.locations, ['Казань', 'Иннополис']);
    assert.equal(byId.get('8004').sourceMetadata.remoteType, 'remote');
  });

  it('passes abort signals through list and detail extraction and registry routes habr to the HTML connector', async () => {
    const abort = new AbortController();
    const web = new FakeExtraction({ [page1Url]: listHtml({ cards: [{ id: '4001' }] }) });
    await new HabrConnector(web).fetchPage(ctx({ signal: abort.signal }));

    assert.equal(web.listCalls[0].options.signal, abort.signal);
    assert.equal(web.detailCalls[0].input.signal, abort.signal);
    const registryConnector = new ConnectorRegistryService(web).get(ctx().source);
    assert.ok(registryConnector instanceof HabrConnector);
  });
});
