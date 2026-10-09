import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { renderRichUnicodePdf, renderUnicodePdf } = require('../src/modules/documents/unicode-pdf.ts');

test('unicode PDF embeds a real CIDToGIDMap for viewer glyph rendering', () => {
  const pdf = renderUnicodePdf('ASCII A Тест ₽', 'Body B Кириллица 123 ₽');
  const source = pdf.toString('latin1');
  const cidToGidRef = source.match(/\/CIDToGIDMap (\d+) 0 R/);
  const toUnicodeRef = source.match(/\/ToUnicode (\d+) 0 R/);

  assert.ok(cidToGidRef, 'CIDFontType2 must reference an embedded CIDToGIDMap stream');
  assert.ok(toUnicodeRef, 'Type0 font must reference a ToUnicode map');
  assert.match(source, /\/W \[/, 'CIDFontType2 must expose actual glyph widths');

  const unicodeMap = parseToUnicode(objectStream(pdf, Number(toUnicodeRef[1])).toString('utf8'));
  const cidToGidMap = objectStream(pdf, Number(cidToGidRef[1]));
  const usedCids = ['0041', '0042', '0422', '0435', '20BD'].map((unicodeHex) => unicodeMap.get(unicodeHex));
  const rubleCid = unicodeMap.get('20BD');
  const glyphIds = usedCids
    .filter((cid) => cid !== undefined)
    .filter((cid) => cid * 2 + 2 <= cidToGidMap.length)
    .map((cid) => [cid, cidToGidMap.readUInt16BE(cid * 2)]);

  assert.equal(typeof rubleCid, 'number', 'ruble sign must be represented in ToUnicode');
  assert.ok(cidToGidMap.readUInt16BE(rubleCid * 2) > 0, 'required ruble sign must render with a real glyph, not glyph 0');
  assert.ok(glyphIds.some(([, glyphId]) => glyphId > 0), 'used display CIDs should map to concrete TTF glyph IDs');
  assert.ok(glyphIds.some(([cid, glyphId]) => glyphId > 0 && glyphId !== cid), 'mapping must not rely on Unicode codepoints or compact CIDs as glyph IDs');
});

test('unicode PDF preserves astral Unicode symbols in ToUnicode without CID collisions', () => {
  const pdf = renderUnicodePdf('Rocket 🚀 Тест', 'ASCII A, ₽, emoji 🚀 and Cyrillic Ж');
  const source = pdf.toString('latin1');
  const toUnicodeRef = source.match(/\/ToUnicode (\d+) 0 R/);
  const cidToGidRef = source.match(/\/CIDToGIDMap (\d+) 0 R/);

  assert.ok(toUnicodeRef);
  assert.ok(cidToGidRef);
  const unicodeMap = parseToUnicode(objectStream(pdf, Number(toUnicodeRef[1])).toString('utf8'));
  const rocketCid = unicodeMap.get('D83DDE80');
  const rubleCid = unicodeMap.get('20BD');
  const cyrillicCid = unicodeMap.get('0416');
  const asciiCid = unicodeMap.get('0041');
  const contentIds = [...source.matchAll(/\/Contents (\d+) 0 R/g)].map((match) => Number(match[1]));
  const contentHex = contentIds.map((id) => objectStream(pdf, id).toString('utf8')).join('\n');

  assert.equal(typeof rocketCid, 'number', 'astral emoji must remain extractable through ToUnicode as a surrogate pair');
  assert.equal(new Set([rocketCid, rubleCid, cyrillicCid, asciiCid]).size, 4, 'mixed BMP and astral symbols must not share CIDs');
  assert.match(contentHex, new RegExp(hex4(rocketCid)), 'page text stream must contain the assigned emoji CID');

  const cidToGidMap = objectStream(pdf, Number(cidToGidRef[1]));
  assert.equal(cidToGidMap.length >= (rocketCid + 1) * 2, true, 'CIDToGIDMap must include the assigned astral CID even when rendered by glyph 0 fallback');
});

test('unicode PDF wraps long headings and words by measured font width', () => {
  const pdf = renderUnicodePdf('ДлинныйЗаголовок'.repeat(30), 'SuperLongWord'.repeat(80));
  const source = pdf.toString('latin1');
  const contentIds = [...source.matchAll(/\/Contents (\d+) 0 R/g)].map((match) => Number(match[1]));
  const textLines = contentIds.flatMap((id) => [...objectStream(pdf, id).toString('utf8').matchAll(/<([0-9A-F]*)> Tj/g)].map((match) => match[1]));

  assert.ok(textLines.length > 6, 'long heading and long body word should be split across multiple PDF text lines');
  assert.ok(Math.max(...textLines.map((line) => line.length)) < 450, 'wrapped PDF text chunks should stay bounded for A4 width');
});

test('rich unicode PDF preserves hierarchy styling and nested list indentation commands', () => {
  const pdf = renderRichUnicodePdf('Title', [
    { type: 'heading', level: 2, runs: [{ text: 'Heading' }] },
    { type: 'paragraph', runs: [{ text: 'Bold italic link', bold: true, italic: true, link: true }] },
    { type: 'listItem', indent: 1, marker: '• ', runs: [{ text: 'Nested bullet' }] },
    { type: 'listItem', indent: 2, marker: '3. ', runs: [{ text: 'Nested ordered' }] },
  ]);
  const source = pdf.toString('latin1');
  const contentIds = [...source.matchAll(/\/Contents (\d+) 0 R/g)].map((match) => Number(match[1]));
  const content = contentIds.map((id) => objectStream(pdf, id).toString('utf8')).join('\\n');

  assert.match(content, /\/F1 14 Tf/, 'heading level 2 should render larger than body text');
  assert.match(content, /2 Tr/, 'bold rich run should use synthetic fill-and-stroke text rendering');
  assert.match(content, /0\.15 w/, 'synthetic bold should use a restrained stroke weight');
  assert.doesNotMatch(content, /0\.35 w/, 'synthetic bold should avoid overly dense old stroke weight');
  assert.match(content, /1 0 0\.18 1/, 'italic rich run should use skewed text matrix');
  assert.match(content, /0 0 1 rg\n0 0 1 RG\n\/F1 10 Tf\n0\.15 w\n2 Tr/, 'bold safe link styling should use matching blue fill and stroke');
  assert.match(content, /m [0-9.]+ [0-9.]+ l S/, 'safe link styling should draw an underline');
  assert.match(content, /1 0 0 1 68 [0-9.]+ Tm/, 'first nested list level should be indented');
  assert.match(content, /1 0 0 1 86 [0-9.]+ Tm/, 'second nested list level should be further indented');
});


test('rich unicode PDF adds paragraph and heading breathing room without loosening list rows', () => {
  const pdf = renderRichUnicodePdf('Title', [
    { type: 'paragraph', runs: [{ text: 'Intro paragraph' }] },
    { type: 'heading', level: 3, runs: [{ text: 'Compact heading' }] },
    { type: 'paragraph', runs: [{ text: 'After heading' }] },
    { type: 'listItem', indent: 0, marker: '• ', runs: [{ text: 'First item' }] },
    { type: 'listItem', indent: 0, marker: '• ', runs: [{ text: 'Second item' }] },
  ]);
  const source = pdf.toString('latin1');
  const contentIds = [...source.matchAll(/\/Contents (\d+) 0 R/g)].map((match) => Number(match[1]));
  const content = contentIds.map((id) => objectStream(pdf, id).toString('utf8')).join('\n');
  const allYPositions = [...content.matchAll(/1 0 (?:0|0\.18) 1 [0-9.]+ ([0-9.]+) Tm/g)].map((match) => Number(match[1]));
  const yPositions = allYPositions.filter((position, index) => index === 0 || position !== allYPositions[index - 1]);
  const deltas = yPositions.slice(1).map((position, index) => Number((yPositions[index] - position).toFixed(2)));

  assert.ok(deltas.some((delta) => delta >= 24), 'paragraph plus pre-heading gap should create visible breathing room before headings');
  assert.ok(deltas.some((delta) => delta === 14), 'adjacent list rows should remain tight at the body line height');
});


test('rich unicode PDF treats newlines inside a styled run as hard line breaks', () => {
  const pdf = renderRichUnicodePdf('Title', [
    { type: 'paragraph', runs: [{ text: 'Alpha\nBeta\r\nGamma\n', bold: true, italic: true, link: true }] },
  ]);
  const unicodeMap = unicodeMapFor(pdf);
  const content = contentStreams(pdf).join('\n');
  const bodyYPositions = uniqueConsecutive(
    [...content.matchAll(/1 0 0\.18 1 50 ([0-9.]+) Tm/g)].map((match) => Number(match[1])),
  ).filter((position) => position < 790);
  const bodyDeltas = bodyYPositions.slice(1).map((position, index) => Number((bodyYPositions[index] - position).toFixed(2)));

  assert.equal(unicodeMap.has('000A'), false, 'line feed must not be encoded as a fallback glyph');
  assert.equal(unicodeMap.has('000D'), false, 'carriage return must not be encoded as a fallback glyph');
  assert.equal((content.match(/0 0 1 rg\n0 0 1 RG\n\/F1 10 Tf\n0\.15 w\n2 Tr/g) ?? []).length, 3, 'style should be retained on each visible hard-break line');
  assert.deepEqual(bodyDeltas, [14, 14], 'hard breaks should advance by real body line height coordinates');
});

test('rich unicode PDF keeps a heading with the first following body line when paginating', () => {
  const fillerBlocks = Array.from({ length: 38 }, (_, index) => ({ type: 'paragraph', runs: [{ text: `Filler ${index + 1}` }] }));
  const pdf = renderRichUnicodePdf('Title', [
    ...fillerBlocks,
    { type: 'heading', level: 3, runs: [{ text: 'Section 6' }] },
    { type: 'paragraph', runs: [{ text: 'First body after heading' }] },
  ]);
  const pages = contentStreams(pdf);
  const sectionCid = cidHexForText(pdf, 'Section');
  const firstCid = cidHexForText(pdf, 'First');

  assert.ok(pages.length >= 2, 'fixture should exercise a real page break');
  assert.equal(pages[0].includes(sectionCid), false, 'heading should not be orphaned at the previous page foot');
  assert.equal(pages[1].includes(sectionCid), true, 'heading should move to the next page');
  assert.equal(pages[1].includes(firstCid), true, 'first following body line should stay on the same page as the heading');
});


test('rich unicode PDF bounds oversized heading keep-with-next scanning and preserves following body', () => {
  const oversizedHeading = Array.from({ length: 360 }, (_, index) => `OversizedHeading${index}`).join(' ');
  const pdf = renderRichUnicodePdf('Title', [
    { type: 'heading', level: 1, runs: [{ text: oversizedHeading }] },
    { type: 'paragraph', runs: [{ text: 'Final body retained after oversized heading' }] },
  ]);
  const pages = contentStreams(pdf);
  const finalCid = cidHexForText(pdf, 'Final');

  const bodyPageIndex = pages.findIndex((page) => page.includes(finalCid));

  assert.ok(pages.length > 1, 'oversized wrapped heading should naturally flow across pages');
  assert.ok(bodyPageIndex > 0, 'body after an oversized heading should remain rendered after a real page break');
});

function objectStream(pdf, objectId) {
  const marker = Buffer.from(`${objectId} 0 obj\n`, 'binary');
  const objectStart = pdf.indexOf(marker);
  assert.notEqual(objectStart, -1, `object ${objectId} should exist`);
  const streamStartMarker = Buffer.from('stream\n', 'binary');
  const streamStart = pdf.indexOf(streamStartMarker, objectStart);
  assert.notEqual(streamStart, -1, `object ${objectId} should contain a stream`);
  const contentStart = streamStart + streamStartMarker.length;
  const streamEnd = pdf.indexOf(Buffer.from('\nendstream', 'binary'), contentStart);
  assert.notEqual(streamEnd, -1, `object ${objectId} stream should terminate`);
  return pdf.subarray(contentStart, streamEnd);
}


function contentStreams(pdf) {
  const source = pdf.toString('latin1');
  return [...source.matchAll(/\/Contents (\d+) 0 R/g)].map((match) => objectStream(pdf, Number(match[1])).toString('utf8'));
}

function unicodeMapFor(pdf) {
  const source = pdf.toString('latin1');
  const toUnicodeRef = source.match(/\/ToUnicode (\d+) 0 R/);
  assert.ok(toUnicodeRef, 'PDF should include a ToUnicode map');
  return parseToUnicode(objectStream(pdf, Number(toUnicodeRef[1])).toString('utf8'));
}

function cidHexForText(pdf, value) {
  const unicodeMap = unicodeMapFor(pdf);
  return [...value].map((char) => {
    const cid = unicodeMap.get(toUtf16BeHex(char));
    assert.equal(typeof cid, 'number', `${char} should be present in ToUnicode map`);
    return hex4(cid);
  }).join('');
}

function toUtf16BeHex(value) {
  const littleEndian = Buffer.from(value, 'utf16le');
  for (let index = 0; index < littleEndian.length; index += 2) {
    const next = littleEndian[index];
    littleEndian[index] = littleEndian[index + 1];
    littleEndian[index + 1] = next;
  }
  return littleEndian.toString('hex').toUpperCase();
}

function uniqueConsecutive(values) {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function parseToUnicode(value) {
  const map = new Map();
  for (const match of value.matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)) {
    map.set(match[2], Number.parseInt(match[1], 16));
  }
  return map;
}

function hex4(value) {
  return value.toString(16).toUpperCase().padStart(4, '0');
}
