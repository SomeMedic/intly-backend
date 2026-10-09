import assert from 'node:assert/strict';
import { readFile, rm, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { writeOpportunityExport } = require('../src/modules/opportunities/opportunity-export-writer.ts');

test('CSV and JSON exports preserve header order quoted multiline and unicode values', async () => {
  await withTempDir(async (dir) => {
    const headers = ['title', 'description', 'meta'];
    const rows = [
      { title: 'Senior "AI" engineer', description: 'Line 1\nLine 2 with ₽ and café', meta: { source: 'HN', ok: true } },
      { title: 'Tender', description: 'Comma, quote " and CR\r\nLF', meta: ['a', 'b'] },
    ];

    const csvPath = join(dir, 'opportunities.csv');
    const csvResult = await writeOpportunityExport(csvPath, 'csv', iterable(rows), headers);
    const csv = await readFile(csvPath, 'utf8');
    assert.equal(csvResult.count, 2);
    assert.equal(csvResult.size, (await stat(csvPath)).size);
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.equal(
      csv.slice(1),
      [
        '"title","description","meta"',
        '"Senior ""AI"" engineer","Line 1\nLine 2 with ₽ and café","{""source"":""HN"",""ok"":true}"',
        '"Tender","Comma, quote "" and CR\r\nLF","[""a"",""b""]"',
      ].join('\n'),
    );

    const jsonPath = join(dir, 'opportunities.json');
    const jsonResult = await writeOpportunityExport(jsonPath, 'json', iterable(rows), headers);
    const parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
    assert.equal(jsonResult.count, 2);
    assert.deepEqual(Object.keys(parsed.items[0]), headers);
    assert.equal(parsed.items[0].description, 'Line 1\nLine 2 with ₽ and café');
    assert.deepEqual(parsed.items[0].meta, { source: 'HN', ok: true });
  });
});

test('XLSX writes multiline cells directly instead of corrupting rows through CSV splitting', async () => {
  await withTempDir(async (dir) => {
    const headers = ['title', 'description'];
    const row = {
      title: 'Role & platform <lead>',
      description: 'Scope line 1\nScope line 2 with "quotes", ₽ and café',
    };
    const oldCsv = [
      headers.map((value) => `"${value}"`).join(','),
      headers.map((header) => `"${String(row[header]).replace(/"/g, '""')}"`).join(','),
    ].join('\n');
    assert.equal(oldCsv.split('\n').length, 3, 'the previous CSV-to-XLSX path would split one data row into two worksheet rows');

    const path = join(dir, 'opportunities.xlsx');
    const result = await writeOpportunityExport(path, 'xlsx', iterable([row]), headers);
    const entries = unzipStore(await readFile(path));
    const workbook = entries.get('xl/workbook.xml').toString('utf8');
    const sheet = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
    const parsedRows = parseSheetRows(sheet);

    assert.equal(result.count, 1);
    assert.match(workbook, /<sheet name="Opportunities"/);
    assert.deepEqual(parsedRows, [
      ['title', 'description'],
      ['Role & platform <lead>', 'Scope line 1\nScope line 2 with "quotes", ₽ and café'],
    ]);
  });
});

test('writer propagates iterator errors and closes async generators across every format', async () => {
  for (const format of ['csv', 'json', 'xlsx']) {
    await withTempDir(async (dir) => {
      let finallyRan = false;
      async function* brokenRows() {
        try {
          yield { title: 'first', description: 'visible' };
          throw new Error(`boom-${format}`);
        } finally {
          finallyRan = true;
        }
      }

      await assert.rejects(
        () => writeOpportunityExport(join(dir, `broken.${format}`), format, brokenRows(), ['title', 'description']),
        new RegExp(`boom-${format}`),
      );
      assert.equal(finallyRan, true);
    });
  }
});

test('XLSX rejects intrinsic worksheet limits before silently truncating', async () => {
  await withTempDir(async (dir) => {
    const tooManyHeaders = Array.from({ length: 16_385 }, (_, index) => `c${index}`);
    await assert.rejects(
      () => writeOpportunityExport(join(dir, 'too-wide.xlsx'), 'xlsx', iterable([]), tooManyHeaders),
      /XLSX column limit exceeded/,
    );
  });
});

test('writer consumes large async iterables without retaining all rows', async () => {
  await withTempDir(async (dir) => {
    let generated = 0;
    async function* manyRows() {
      for (let index = 0; index < 5_000; index += 1) {
        generated += 1;
        yield { id: index, description: `row ${index}\nkept in one cell` };
      }
    }

    const result = await writeOpportunityExport(join(dir, 'large.json'), 'json', manyRows(), ['id', 'description']);
    assert.equal(result.count, 5_000);
    assert.equal(generated, 5_000);
  });
});

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'intly-export-writer-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function* iterable(items) {
  for (const item of items) yield item;
}

function unzipStore(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  let central = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(central), 0x02014b50);
    const method = buffer.readUInt16LE(central + 10);
    const crc = buffer.readUInt32LE(central + 16);
    const compressedSize = buffer.readUInt32LE(central + 20);
    const uncompressedSize = buffer.readUInt32LE(central + 24);
    const nameLength = buffer.readUInt16LE(central + 28);
    const extraLength = buffer.readUInt16LE(central + 30);
    const commentLength = buffer.readUInt16LE(central + 32);
    const localOffset = buffer.readUInt32LE(central + 42);
    const name = buffer.toString('utf8', central + 46, central + 46 + nameLength);
    assert.equal(method, 0);
    assert.equal(compressedSize, uncompressedSize);
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    const descriptor = dataStart + compressedSize;
    assert.equal(buffer.readUInt32LE(descriptor), 0x08074b50);
    assert.equal(buffer.readUInt32LE(descriptor + 4), crc);
    assert.equal(buffer.readUInt32LE(descriptor + 8), compressedSize);
    assert.equal(crc32(data), crc);
    entries.set(name, data);
    central += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('End of central directory not found');
}

function parseSheetRows(xml) {
  return [...xml.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g)].map((rowMatch) => (
    [...rowMatch[0].matchAll(/<c\b[^>]*>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/c>/g)].map((cellMatch) => xmlDecode(cellMatch[1]))
  ));
}

function xmlDecode(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  CRC_TABLE[index] = value >>> 0;
}

function crc32(buffer, previous = 0) {
  let crc = previous ^ 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
