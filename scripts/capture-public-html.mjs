#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { WebExtractionService } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const { SOURCE_CATALOG } = require('../src/modules/sources/catalog/source-catalog.ts');
const root = resolve(new URL('../..', import.meta.url).pathname);
const directory = resolve(root, '.local/reports/public-html-live-20261004');
const sourceIds = process.argv.slice(2);
if (!sourceIds.length) throw new Error('Pass explicit registry source IDs');
await mkdir(directory, { recursive: true });
const extractor = new WebExtractionService();
const report = { startedAt: new Date().toISOString(), purpose: 'Public markup capture only; not proof of a working opportunity parser', sources: [] };
await Promise.all(sourceIds.map(async (sourceId) => {
  const source = SOURCE_CATALOG.find((item) => item.id === sourceId && item.group === 'web');
  if (!source) throw new Error(`Unknown web source: ${sourceId}`);
  const url = source.endpoint.baseUrl;
  const result = { sourceId, requestedUrl: url, startedAt: new Date().toISOString() };
  try {
    const document = await extractor.extractUrl(url, { allowedHosts: [new URL(url).hostname], timeoutMs: 20000, maxBytes: 2000000 });
    const file = resolve(directory, `${sourceId}.html`);
    await writeFile(file, document.html);
    Object.assign(result, {
      status: 'fetched', finalUrl: document.finalUrl, title: document.title,
      bytes: Buffer.byteLength(document.html), sha256: createHash('sha256').update(document.html).digest('hex'), file,
      anchors: Array.from(document.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)).map((match) => ({
        href: /\bhref=["']([^"']+)["']/i.exec(match[1])?.[1],
        attributes: match[1].slice(0, 600), label: match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100),
      })).filter((item) => /next|след|pager|pagin|page=|\/vacancy\/|\/vacancies\/|\/job\/|\/jobs\/|\/project\//i.test(`${item.href} ${item.attributes} ${item.label}`)).slice(0, 150),
    });
  } catch (error) {
    Object.assign(result, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
  result.completedAt = new Date().toISOString();
  report.sources.push(result);
  await writeFile(resolve(directory, `${sourceId}.json`), JSON.stringify(result, null, 2));
  process.stdout.write(`${sourceId}: ${result.status}; ${result.bytes ?? result.error}\n`);
}));
report.completedAt = new Date().toISOString();
report.sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
await writeFile(resolve(directory, 'capture.json'), JSON.stringify(report, null, 2));
