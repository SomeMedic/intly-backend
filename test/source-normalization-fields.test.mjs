import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { SourceNormalizerService } = require('../src/modules/sources/normalization/source-normalizer.service.ts');
const { OpportunitiesIngestAdapter } = require('../src/modules/sources/ingestion/opportunities-ingest.adapter.ts');

const service = new SourceNormalizerService();

describe('source normalization canonical fields', () => {
  it('maps HH salary numbers and direct job fields without JSON originalText', () => {
    const sourceMetadata = {
      salary: { from: 100000, to: 200000, currency: 'RUB', gross: true },
      area: 'Москва',
      employment: 'Полная занятость',
      schedule: 'Удаленная работа',
      skills: ['TypeScript', 'NestJS'],
    };

    const normalized = service.normalize(source('hh'), raw({ sourceMetadata }));

    assert.deepEqual(normalized.money, { min: 100000, max: 200000, currency: 'RUB', gross: true });
    assert.equal(normalized.money.originalText, undefined);
    assert.equal(normalized.location, 'Москва');
    assert.equal(normalized.employmentType, 'Полная занятость');
    assert.equal(normalized.remoteType, 'Удаленная работа');
    assert.deepEqual(normalized.skills, ['TypeScript', 'NestJS']);
  });

  it('falls back to freelance budget fixed amount while preserving human originalText', () => {
    const sourceMetadata = {
      budget: { amount: 6500, currency: 'RUB', originalText: '6 500 ₽ / заказ' },
      categoryTags: ['Программирование'],
    };

    const normalized = service.normalize(source('freelance_ru', 'PublicHtml', 'freelance'), raw({ type: 'freelance', sourceMetadata }));

    assert.deepEqual(normalized.money, { originalText: '6 500 ₽ / заказ', amount: 6500, min: 6500, max: 6500, currency: 'RUB' });
    assert.deepEqual(normalized.skills, ['Программирование']);
    assert.deepEqual(normalized.technologies, ['Программирование']);
  });

  it('maps Workspace budget range and only direct deadlineAt, not arbitrary deadline text', () => {
    const sourceMetadata = {
      budget: { min: 100000, max: 500000, currency: 'RUB', originalText: 'от 100 000 до 500 000 ₽' },
      deadlineAt: '2026-10-30T12:00:00.000Z',
      deadlineText: 'до 30 октября',
    };

    const normalized = service.normalize(source('workspace', 'PublicHtml', 'tenders'), raw({ type: 'tender', sourceMetadata }));
    const textOnly = service.normalize(source('workspace', 'PublicHtml', 'tenders'), raw({ type: 'tender', sourceMetadata: { deadlineText: 'до 30 октября' } }));
    const naiveIso = service.normalize(source('workspace', 'PublicHtml', 'tenders'), raw({ type: 'tender', sourceMetadata: { deadlineAt: '2026-10-30T12:00:00' } }));

    assert.deepEqual(normalized.money, { originalText: 'от 100 000 до 500 000 ₽', min: 100000, max: 500000, currency: 'RUB' });
    assert.equal(normalized.deadline.toISOString(), '2026-10-30T12:00:00.000Z');
    assert.equal(textOnly.deadline, undefined);
    assert.equal(naiveIso.deadline, undefined);
  });

  it('maps Getmatch salary, location labels, location format, skills and seniority', () => {
    const sourceMetadata = {
      salary: { originalText: '100 000 — 200 000 ₽/мес до налогов', min: 100000, max: 200000, currency: 'RUB', taxes: 'gross' },
      locations: [{ label: 'Москва', format: 'hybrid', exclude: false }],
      skills: ['TypeScript'],
      seniority: 'middle',
    };

    const normalized = service.normalize(source('getmatch'), raw({ sourceMetadata }));

    assert.deepEqual(normalized.money, { originalText: '100 000 — 200 000 ₽/мес до налогов', min: 100000, max: 200000, currency: 'RUB' });
    assert.equal(normalized.location, 'Москва');
    assert.equal(normalized.remoteType, 'hybrid');
    assert.equal(normalized.seniority, 'middle');
    assert.deepEqual(normalized.skills, ['TypeScript']);
  });

  it('keeps WorkingNomads salary text without inventing sums or annual conversions', () => {
    const sourceMetadata = {
      salary: { originalText: '$ 14 per hour', shortText: '$14/h', annualUsd: null },
      locations: ['USA'],
      skills: ['quality', 'english'],
      experienceLevel: 'junior',
    };

    const normalized = service.normalize(source('workingnomads'), raw({ sourceMetadata }));

    assert.deepEqual(normalized.money, { originalText: '$ 14 per hour' });
    assert.equal(normalized.location, 'USA');
    assert.equal(normalized.seniority, 'junior');
    assert.deepEqual(normalized.skills, ['quality', 'english']);
  });

  it('does not mix budget into salary and preserves raw/source metadata plus fingerprint continuity', () => {
    const sourceMetadata = {
      salary: { originalText: 'По договоренности' },
      budget: { amount: 6500, currency: 'RUB', originalText: '6 500 ₽ / заказ' },
    };
    const rawPayload = { id: 'same-id', title: 'Canonical record' };

    const first = service.normalize(source('mixed'), raw({ rawPayload, sourceMetadata }));
    const second = service.normalize(source('mixed'), raw({ rawPayload, sourceMetadata: { budget: { amount: 9999, currency: 'RUB' } } }));

    assert.deepEqual(first.money, { originalText: 'По договоренности' });
    assert.deepEqual(first.sourceOccurrences[0].rawPayload, rawPayload);
    assert.deepEqual(first.sourceOccurrences[0].sourceMetadata, sourceMetadata);
    assert.equal(first.fingerprint, second.fingerprint);
  });

  it('passes Workspace deadline through adapter into ingest input', async () => {
    const normalized = service.normalize(source('workspace', 'PublicHtml', 'tenders'), raw({
      type: 'tender',
      sourceMetadata: {
        budget: { min: 100000, max: 500000, currency: 'RUB', originalText: 'от 100 000 до 500 000 ₽' },
        deadlineAt: '2026-10-30T12:00:00.000Z',
      },
    }));
    const captured = await capturedIngestInput(normalized);

    assert.equal(captured.deadline.toISOString(), '2026-10-30T12:00:00.000Z');
    assert.deepEqual(captured.money, { originalText: 'от 100 000 до 500 000 ₽', min: 100000, max: 500000, currency: 'RUB' });
  });

  it('keeps explicit tender facts through normalization and ingestion without inventing eligibility', async () => {
    const sourceMetadata = {
      tenderData: {
        customer: 'Native customer',
        region: 'Москва',
        procurementMethod: 'Открытый конкурс',
        contractNumber: '32616434303',
        sourceName: 'Untrusted override',
      },
      budget: { amount: 150000, currency: 'RUB' },
      deadlineAt: '2026-10-30T12:00:00.000Z',
    };
    const normalized = service.normalize({ ...source('roseltorg', 'TenderPlatform', 'tenders'), name: 'Росэлторг' }, raw({ type: 'tender', sourceMetadata }));
    const captured = await capturedIngestInput(normalized);

    assert.deepEqual(captured.tenderData, { ...sourceMetadata.tenderData, sourceName: 'Росэлторг' });
    assert.equal(captured.tenderData.eligibility, undefined);
    assert.deepEqual(normalized.sourceOccurrences[0].sourceMetadata, sourceMetadata);
    assert.equal(captured.deadline.toISOString(), sourceMetadata.deadlineAt);
    assert.equal(captured.money.amount, 150000);

    const sparse = service.normalize(source('workspace', 'PublicHtml', 'tenders'), raw({ type: 'tender', sourceMetadata: { tenderData: ['invalid'] } }));
    const vacancy = service.normalize(source('hh'), raw({ sourceMetadata }));
    assert.deepEqual(sparse.tenderData, { sourceName: 'workspace' });
    assert.deepEqual(vacancy.tenderData, {});
  });

  it('passes Getmatch seniority through adapter into ingest input', async () => {
    const normalized = service.normalize(source('getmatch'), raw({
      sourceMetadata: {
        salary: { originalText: '100 000 — 200 000 ₽/мес до налогов', min: 100000, max: 200000, currency: 'RUB' },
        seniority: 'middle',
        locations: [{ label: 'Москва', format: 'hybrid' }],
      },
    }));
    const captured = await capturedIngestInput(normalized);

    assert.equal(captured.seniority, 'middle');
    assert.equal(captured.location, 'Москва');
    assert.equal(captured.remoteType, 'hybrid');
  });
});

function source(id, connectorFamily = 'Direct', group = 'jobs') {
  return { _id: id, name: id, connectorFamily, group };
}

function raw(overrides = {}) {
  return {
    externalId: 'ext-1',
    url: 'https://example.test/opportunity/1',
    type: 'vacancy',
    title: 'Canonical record',
    companyOrClient: 'Client',
    description: 'Description',
    sourceStatus: 'Active',
    rawPayload: { id: 'ext-1' },
    sourceMetadata: {},
    ...overrides,
  };
}

async function capturedIngestInput(record) {
  const captured = [];
  const service = {
    ingestOrUpsert: async (input) => {
      captured.push(input);
      return { opportunity: { _id: 'opp-1' }, created: true };
    },
  };
  const adapter = new OpportunitiesIngestAdapter(service);
  const result = await adapter.ingestFromSource({ sourceId: 'source-1', runId: 'run-1', records: [record] });
  assert.equal(result.failed, 0);
  assert.equal(captured.length, 1);
  return captured[0];
}
