#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { SOURCE_CATALOG } = require('../src/modules/sources/catalog/source-catalog.ts');
const { ConnectorRegistryService } = require('../src/modules/sources/connectors/connector-registry.service.ts');
const { WebExtractionService } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const root = resolve(new URL('../..', import.meta.url).pathname);
const sourceIds = process.argv.slice(2).filter((value) => !value.startsWith('--'));
if (!sourceIds.length) throw new Error('Pass explicit public registry source IDs');
const pageBudget = Math.max(1, Math.min(5, Number(process.argv.find((value) => value.startsWith('--pages='))?.split('=')[1] ?? 2)));
const registry = new ConnectorRegistryService(new WebExtractionService());
const startedAt = new Date().toISOString();
const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
const report = { startedAt, live: true, scope: 'Bounded read-only public connector pages; not a full backfill, queue, account, or platform-wide completeness proof', pageBudget, backfillSince: cutoff, sources: [] };
const reportName = process.argv.find((value) => value.startsWith('--report='))?.slice('--report='.length) ?? 'public-source-pages-20261004.json';
assert.match(reportName, /^[a-zA-Z0-9_-]+\.json$/, 'Report must be a JSON filename');
const file = resolve(root, '.local/reports', reportName);
const recordsDir = resolve(root, '.local/reports', reportName.replace(/\.json$/, '-records'));
await mkdir(resolve(root, '.local/reports'), { recursive: true });
for (const id of sourceIds) {
  const entry = SOURCE_CATALOG.find((item) => item.id === id && item.group === 'web');
  if (!entry) throw new Error(`Unknown web source ${id}`);
  const source = { ...entry, _id: entry.id, enabled: true, limits: { maxPages: 1, perPage: 5 } };
  const connector = registry.get(source);
  const row = { sourceId: id, connector: connector.id, endpoint: entry.endpoint.baseUrl, startedAt: new Date().toISOString(), pages: [], status: 'running' };
  let checkpoint = {};
  let page;
  const allRecords = [];
  for (let index = 0; index < pageBudget; index++) {
    try {
      const result = await connector.fetchPage({ source, requestId: `public-source-pages-${startedAt}`, checkpoint, backfillDays: 30, backfillSince: cutoff, page, signal: AbortSignal.timeout(45000) });
      assert.ok(Array.isArray(result.records));
      for (const record of result.records) {
        assert.ok(record.externalId && typeof record.externalId === 'string');
        assert.ok(record.title?.trim() && record.title !== 'Untitled');
        assert.ok(record.description?.trim());
        assert.ok(['http:', 'https:'].includes(new URL(record.url).protocol));
      }
      const priorIds = new Set(allRecords.map((record) => record.externalId));
      if (allRecords.length && result.records.length && result.records.every((record) => priorIds.has(record.externalId))) {
        throw new Error('Listing continuation returned only previously seen external IDs');
      }
      row.pages.push({ returned: result.records.length, seen: result.stats.seen, hasMore: result.hasMore, nextPage: result.nextPage, checkpoint: result.checkpoint, ids: result.records.map((record) => record.externalId) });
      allRecords.push(...result.records);
      checkpoint = result.checkpoint;
      page = result.nextPage;
      row.status = allRecords.length ? 'data' : 'empty';
      if (result.checkpoint?.incomplete === true) {
        row.status = 'partial';
        row.error = result.checkpoint.limitation ?? 'Connector reported incomplete collection';
      }
      if (!result.hasMore) break;
    } catch (error) {
      row.status = allRecords.length ? 'partial' : 'failed';
      row.error = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  row.completedAt = new Date().toISOString();
  row.returned = allRecords.length;
  row.uniqueExternalIds = new Set(allRecords.map((record) => record.externalId)).size;
  const windowTo = Date.parse(checkpoint.windowTo ?? row.completedAt);
  row.unknownPublicationDates = allRecords.filter((record) => !record.publishedAt).length;
  row.withinFixedWindow = allRecords.filter((record) => !record.publishedAt || new Date(record.publishedAt).getTime() >= Date.parse(cutoff) && new Date(record.publishedAt).getTime() <= windowTo).length;
  row.sample = allRecords.slice(0, 3).map((record) => ({ externalId: record.externalId, title: record.title, url: record.url, publishedAt: record.publishedAt, updatedAt: record.updatedAt, descriptionLength: record.description?.length, money: record.sourceMetadata?.budget ?? record.sourceMetadata?.salary, extraction: record.sourceMetadata?.extraction }));
  row.recordsFile = resolve(recordsDir, `${id}.json`);
  await mkdir(recordsDir, { recursive: true });
  await writeFile(row.recordsFile, JSON.stringify(allRecords, null, 2));
  report.sources.push(row);
  await writeFile(file, JSON.stringify(report, null, 2));
  process.stdout.write(`${id}: ${row.status}, ${row.returned} records / ${row.uniqueExternalIds} unique, ${row.pages.length} pages${row.error ? `; ${row.error}` : ''}\n`);
}
report.completedAt = new Date().toISOString();
report.summary = { attempted: report.sources.length, data: report.sources.filter((row) => row.status === 'data').length, failed: report.sources.filter((row) => row.status === 'failed').length, empty: report.sources.filter((row) => row.status === 'empty').length, partial: report.sources.filter((row) => row.status === 'partial').length };
await writeFile(file, JSON.stringify(report, null, 2));
