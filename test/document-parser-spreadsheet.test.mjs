import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { DocumentParserService } = require('../src/modules/knowledge/document-parser.service.ts');

function parser() {
  return new DocumentParserService({ get: () => undefined });
}

test('CSV parser preserves column context, quoted values, amounts and dates', async () => {
  const service = parser();
  const csv = [
    'Item,Amount,Deadline,Note',
    '"Application, security","1 500 000 ₽","2026-10-20","submit bank guarantee"',
    '"Stage 1","250000.50","15.11.2026","scope includes CRM\nand integration",extra-value',
  ].join('\n');
  const result = await service.parse(Buffer.from(csv, 'utf8'), 'text/csv');
  assert.match(result.text, /Columns: Item \| Amount \| Deadline \| Note \| Column 5/);
  assert.match(result.text, /Row 2: Item: Application, security \| Amount: 1 500 000 ₽ \| Deadline: 2026-10-20/);
  assert.match(result.text, /Row 3: Item: Stage 1 \| Amount: 250000\.50 \| Deadline: 15\.11\.2026 \| Note: scope includes CRM and integration \| Column 5: extra-value/);
  assert.equal(result.structured.format, 'csv');
  assert.equal(result.structured.rowCount, 3);
});

test('XLSX parser extracts sheet names, shared strings, inline strings, numbers and cached formulas', async () => {
  const service = parser();
  const workbook = makeXlsx({
    'xl/workbook.xml': xml(`<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Тендер" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': xml(`<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/sharedStrings.xml': xml(`<?xml version="1.0"?><sst><si><t>Позиция</t></si><si><t>Сумма</t></si><si><r><t>Дата </t></r><r><t>поставки</t></r></si><si><t>Гарантия</t></si></sst>`),
    'xl/worksheets/sheet1.xml': xml(`<?xml version="1.0"?><worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
      <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1500000</v></c><c r="C2" t="inlineStr"><is><t>2026-10-20</t></is></c></row>
      <row r="3"><c r="A3" t="str"><f>SUM(B2:B2)</f><v>1500000</v></c></row>
    </sheetData></worksheet>`),
  });
  const result = await service.parse(workbook, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(result.text, /Sheet: Тендер/);
  assert.match(result.text, /A2 "Гарантия" \| B2 "1500000" \| C2 "2026-10-20"/);
  assert.match(result.text, /A3 formula SUM\(B2:B2\); cached value "1500000"/);
  assert.deepEqual(result.structured.sheets, [{ name: 'Тендер', rowCount: 3 }]);
});

test('XLSX parser converts styled Excel date serials while preserving raw serials', async () => {
  const service = parser();
  const serial1900 = excelSerial('2026-10-20', false);
  const workbook1900 = makeXlsx({
    'xl/workbook.xml': xml(`<?xml version="1.0"?><workbook><sheets><sheet name="Dates" sheetId="1"/></sheets></workbook>`),
    'xl/styles.xml': xml(`<?xml version="1.0"?><styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`),
    'xl/worksheets/sheet1.xml': xml(`<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" s="1"><v>${serial1900}</v></c></row></sheetData></worksheet>`),
  });
  const result1900 = await service.parse(workbook1900, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(result1900.text, new RegExp(`A1 "2026-10-20 \\(Excel serial ${serial1900}\\)"`));

  const serial1904 = excelSerial('2026-10-20', true);
  const workbook1904 = makeXlsx({
    'xl/workbook.xml': xml(`<?xml version="1.0"?><workbook><workbookPr date1904="1"/><sheets><sheet name="Dates1904" sheetId="1"/></sheets></workbook>`),
    'xl/styles.xml': xml(`<?xml version="1.0"?><styleSheet><numFmts><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="165"/></cellXfs></styleSheet>`),
    'xl/worksheets/sheet1.xml': xml(`<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" s="1"><v>${serial1904}</v></c></row></sheetData></worksheet>`),
  });
  const result1904 = await service.parse(workbook1904, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(result1904.text, new RegExp(`A1 "2026-10-20 \\(Excel serial ${serial1904}\\)"`));
});

test('XLSX parser rejects entity declarations and decompression bombs', async () => {
  const service = parser();
  const entityWorkbook = makeXlsx({
    'xl/workbook.xml': xml(`<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><workbook><sheets><sheet name="A" sheetId="1"/></sheets></workbook>`),
    'xl/worksheets/sheet1.xml': xml(`<?xml version="1.0"?><worksheet><sheetData/></worksheet>`),
  });
  await assert.rejects(service.parse(entityWorkbook, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), /entity declarations/i);

  const bomb = makeXlsx({
    'xl/workbook.xml': xml(`<?xml version="1.0"?><workbook><sheets><sheet name="A" sheetId="1"/></sheets></workbook>`),
    'xl/worksheets/sheet1.xml': {
      data: Buffer.from('<worksheet><sheetData/></worksheet>'),
      uncompressedSize: 31 * 1024 * 1024,
    },
  });
  await assert.rejects(service.parse(bomb, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), /expands too large|too large/i);

  const forgedSmallMetadata = makeXlsx({
    'xl/workbook.xml': xml(`<?xml version="1.0"?><workbook><sheets><sheet name="A" sheetId="1"/></sheets></workbook>`),
    'xl/worksheets/sheet1.xml': {
      data: Buffer.alloc(10 * 1024 * 1024 + 1, 'a'),
      uncompressedSize: 128,
    },
  });
  await assert.rejects(service.parse(forgedSmallMetadata, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), /exceeded limits|too large|size mismatch/i);
});

test('XLSX parser rejects duplicate, encrypted and mismatched ZIP headers', async () => {
  const service = parser();
  const duplicate = makeXlsxEntries([
    ['xl/workbook.xml', xml(`<?xml version="1.0"?><workbook/>`)],
    ['xl/workbook.xml', xml(`<?xml version="1.0"?><workbook/>`)],
  ]);
  await assert.rejects(service.parse(duplicate, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), /duplicate entry/i);

  const encrypted = makeXlsx({
    'xl/workbook.xml': { ...xml(`<?xml version="1.0"?><workbook/>`), flags: 1 },
  });
  await assert.rejects(service.parse(encrypted, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), /encrypted/i);

  const nameMismatch = makeXlsx({
    'xl/workbook.xml': { ...xml(`<?xml version="1.0"?><workbook/>`), localName: 'xl/not-workbook.xml' },
  });
  await assert.rejects(service.parse(nameMismatch, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), /name mismatch/i);

  const badOffset = makeXlsx({
    'xl/workbook.xml': { ...xml(`<?xml version="1.0"?><workbook/>`), localHeaderOffset: 999_999 },
  });
  await assert.rejects(service.parse(badOffset, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), /local header|invalid/i);
});

function xml(value) {
  return { data: Buffer.from(value.replace(/>\s+</g, '><'), 'utf8') };
}

function makeXlsx(files) {
  return makeXlsxEntries(Object.entries(files));
}

function makeXlsxEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, input] of entries) {
    const data = input.data;
    const compressed = input.store ? data : deflateRawSync(data);
    const method = input.store ? 0 : 8;
    const nameBuffer = Buffer.from(name, 'utf8');
    const localNameBuffer = Buffer.from(input.localName ?? name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(input.localFlags ?? input.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(input.uncompressedSize ?? data.length, 22);
    local.writeUInt16LE(localNameBuffer.length, 26);
    localParts.push(local, localNameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(input.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(input.uncompressedSize ?? data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(input.localHeaderOffset ?? offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + localNameBuffer.length + compressed.length;
  }
  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function excelSerial(dateText, date1904) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = Date.UTC(year, month - 1, day);
  if (date1904) return Math.round((date - Date.UTC(1904, 0, 1)) / 86_400_000);
  const days = Math.round((date - Date.UTC(1899, 11, 31)) / 86_400_000);
  return days >= 60 ? days + 1 : days;
}
