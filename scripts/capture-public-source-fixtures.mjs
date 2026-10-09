#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { load } = require('cheerio');
const { WebExtractionService } = require('../src/modules/sources/extraction/web-extraction.service.ts');
const extractor = new WebExtractionService();
const directory = resolve(new URL('../..', import.meta.url).pathname, '.local/reports/public-source-expansion-fixtures-20261004');
await mkdir(directory, { recursive: true });

for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf('=');
  assert.ok(separator > 0, 'Use filename=https://public-source/path');
  const name = argument.slice(0, separator);
  assert.match(name, /^[a-z0-9_-]+$/);
  const url = new URL(argument.slice(separator + 1));
  const document = await extractor.extractUrl(url.toString(), { allowedHosts: [url.hostname], maxBytes: 4_000_000 });
  const file = resolve(directory, `${name}.html`);
  await writeFile(file, document.html);
  const $ = load(document.html);
  const anchors = $('a[href]').toArray().map((item) => ({ href: $(item).attr('href'), text: $(item).text().trim().slice(0, 120), class: $(item).attr('class'), rel: $(item).attr('rel') }));
  const observed = {
    url: document.finalUrl,
    file,
    bytes: Buffer.byteLength(document.html),
    title: $('title').text(),
    anchors,
    scripts: $('script[src]').toArray().map((item) => $(item).attr('src')),
    jsonLd: $('script[type="application/ld+json"]').toArray().map((item) => $(item).text()),
    forms: $('form').toArray().map((item) => ({ action: $(item).attr('action'), method: $(item).attr('method'), fields: $(item).find('input').toArray().map((field) => ({ name: $(field).attr('name'), value: $(field).attr('value') })) })),
  };
  await writeFile(resolve(directory, `${name}.json`), JSON.stringify(observed, null, 2));
  process.stdout.write(JSON.stringify({ name, file, bytes: observed.bytes, title: observed.title, anchors: anchors.length, jsonLd: observed.jsonLd.length }) + '\n');
}
