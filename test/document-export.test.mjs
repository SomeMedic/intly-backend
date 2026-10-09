import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { renderDocumentExport, tiptapToText } = require('../src/modules/responses/document-export.ts');

test('document exports use visible JSON instead of stale Markdown cache', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Проверенный текст' }] }] };
  const exported = renderDocumentExport(doc, 'Старый {{placeholder}}', 'response-id', 'txt');
  assert.equal(exported.buffer.toString('utf8'), 'Проверенный текст');
});

test('document exports preserve semantic inline marks and explicit line breaks', () => {
  const doc = { type: 'doc', content: [{ type: 'semanticBlock', content: [
    { type: 'text', text: 'Ставка: ' }, { type: 'text', text: '4 600', marks: [{ type: 'bold' }] },
    { type: 'text', text: ' ₽/час.' }, { type: 'hardBreak' }, { type: 'text', text: 'Срок: 7 дней.' },
  ] }] };
  assert.equal(tiptapToText(doc).trim(), 'Ставка: 4 600 ₽/час.\nСрок: 7 дней.');
});

test('DOCX displays a human title independently of the stable export filename', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Proposal body' }] }] };
  const exported = renderDocumentExport(doc, undefined, 'response-commercial_proposal-draft-1', 'docx', 'Python API <proposal>');
  assert.match(exported.filename, /^response-commercial_proposal-draft-1-/);
  const content = exported.buffer.toString('utf8');
  assert.ok(content.includes('Python API &lt;proposal&gt;'));
  assert.ok(content.includes('Proposal body'));
  assert.equal(content.includes('response-commercial_proposal-draft-1'), false);
});

test('document exports retain Markdown fallback for empty legacy JSON', () => {
  const exported = renderDocumentExport({ type: 'doc', content: [] }, 'Legacy saved text', 'response-id', 'txt');
  assert.equal(exported.buffer.toString('utf8'), 'Legacy saved text');
});

test('DOCX exports rich JSON structure with styles numbering relationships and safe links', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Scope <Plan>' }] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'Цена ' },
        { type: 'text', text: '100 ₽', marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'hardBreak' },
        { type: 'text', text: 'Safe link', marks: [{ type: 'link', attrs: { href: 'https://example.com/a?x=1&y=2' } }, { type: 'bold' }, { type: 'italic' }] },
        { type: 'text', text: ' unsafe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
      ] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Первый пункт' }] }] },
        { type: 'listItem', content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Второй пункт' }] },
          { type: 'orderedList', attrs: { start: 3 }, content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested ordered' }] }] },
          ] },
        ] },
      ] },
      { type: 'orderedList', attrs: { start: 4 }, content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Top ordered' }] }] },
      ] },
      { type: 'semanticBlock', content: [{ type: 'text', text: 'Semantic inline stays visible' }] },
    ],
  };

  const exported = renderDocumentExport(doc, undefined, 'response-id', 'docx', 'Commercial <Offer>');
  const entries = unzipStore(exported.buffer);
  const documentXml = entries.get('word/document.xml').toString('utf8');
  const stylesXml = entries.get('word/styles.xml').toString('utf8');
  const numberingXml = entries.get('word/numbering.xml').toString('utf8');
  const relsXml = entries.get('word/_rels/document.xml.rels').toString('utf8');
  const contentTypesXml = entries.get('[Content_Types].xml').toString('utf8');

  assert.match(contentTypesXml, /word\/styles\.xml/);
  assert.match(contentTypesXml, /word\/numbering\.xml/);
  assert.match(relsXml, /relationships\/styles" Target="styles\.xml"/);
  assert.match(relsXml, /relationships\/numbering" Target="numbering\.xml"/);
  assert.match(relsXml, /relationships\/hyperlink" Target="https:\/\/example\.com\/a\?x=1&amp;y=2" TargetMode="External"/);
  assert.equal(relsXml.includes('javascript:alert'), false);

  assert.match(stylesXml, /w:style w:type="paragraph" w:styleId="Heading2"/);
  assert.match(stylesXml, /w:outlineLvl w:val="1"/);
  assert.match(stylesXml, /w:style w:type="character" w:styleId="Hyperlink"/);
  assert.match(numberingXml, /w:abstractNum w:abstractNumId="1"/);
  assert.match(numberingXml, /w:numFmt w:val="bullet"/);
  assert.match(numberingXml, /w:numFmt w:val="decimal"/);
  assert.match(numberingXml, /w:startOverride w:val="3"/);
  assert.match(numberingXml, /w:startOverride w:val="4"/);

  assert.match(documentXml, /Commercial &lt;Offer&gt;/);
  assert.match(documentXml, /w:pStyle w:val="Heading2"/);
  assert.match(documentXml, /Scope &lt;Plan&gt;/);
  assert.match(documentXml, /<w:b\/><w:i\/>/);
  assert.match(documentXml, /<w:br\/>/);
  assert.match(documentXml, /<w:hyperlink r:id="rId3">/);
  assert.match(documentXml, /<w:rPr><w:rStyle w:val="Hyperlink"\/><w:b\/><w:i\/><\/w:rPr><w:t xml:space="preserve">Safe link<\/w:t>/);
  assert.match(documentXml, /unsafe/);
  assert.match(documentXml, /w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"/);
  assert.match(documentXml, /w:numPr><w:ilvl w:val="1"\/><w:numId w:val="2"/);
  assert.match(documentXml, /Semantic inline stays visible/);
  assert.equal(documentXml.includes('response-id'), false);
});

test('DOCX list item continuation paragraphs keep indent without extra markers', () => {
  const doc = { type: 'doc', content: [
    { type: 'bulletList', content: [
      { type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Marker paragraph' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Continuation paragraph' }] },
        { type: 'orderedList', attrs: { start: 2 }, content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested item' }] }] },
        ] },
      ] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second marker' }] }] },
    ] },
  ] };

  const exported = renderDocumentExport(doc, undefined, 'response-id', 'docx');
  const documentXml = unzipStore(exported.buffer).get('word/document.xml').toString('utf8');
  const markerParagraph = paragraphContaining(documentXml, 'Marker paragraph');
  const continuationParagraph = paragraphContaining(documentXml, 'Continuation paragraph');
  const nestedParagraph = paragraphContaining(documentXml, 'Nested item');
  const secondParagraph = paragraphContaining(documentXml, 'Second marker');

  assert.match(markerParagraph, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/);
  assert.doesNotMatch(continuationParagraph, /<w:numPr>/);
  assert.match(continuationParagraph, /<w:ind w:left="720"\/>/);
  assert.match(nestedParagraph, /<w:numPr><w:ilvl w:val="1"\/><w:numId w:val="2"\/><\/w:numPr>/);
  assert.match(secondParagraph, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/);
  assert.equal((documentXml.match(/<w:numPr>/g) ?? []).length, 3);
});

test('plain text export preserves ordered and bulleted list markers with nesting', () => {
  const doc = { type: 'doc', content: [
    { type: 'orderedList', attrs: { start: 2 }, content: [
      { type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Prepare' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested bullet' }] }] },
        ] },
      ] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Submit' }] }] },
    ] },
  ] };

  const exported = renderDocumentExport(doc, undefined, 'response-id', 'txt');

  assert.equal(exported.buffer.toString('utf8'), '2. Prepare\n  • Nested bullet\n3. Submit');
});

test('PDF export uses rich JSON hierarchy instead of flatten-only text', () => {
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'PDF Heading' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: 'PDF link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }, { type: 'bold' }, { type: 'italic' }] },
    ] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PDF bullet' }] }] },
    ] },
  ] };

  const exported = renderDocumentExport(doc, undefined, 'response-id', 'pdf', 'PDF Title');
  const content = pdfContentStreams(exported.buffer).join('\n');

  assert.match(content, /\/F1 14 Tf/);
  assert.match(content, /2 Tr/);
  assert.match(content, /1 0 0\.18 1/);
  assert.match(content, /0 0 1 rg/);
  assert.match(content, /1 0 0 1 50 [0-9.]+ Tm/);
  assert.match(content, /1 0 0 1 50 [0-9.]+ Tm[\s\S]*1 0 0 1 50 [0-9.]+ Tm/);
});

function unzipStore(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    entries.set(name, buffer.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

function pdfContentStreams(buffer) {
  const source = buffer.toString('latin1');
  return [...source.matchAll(/\/Contents (\d+) 0 R/g)].map((match) => objectStream(buffer, Number(match[1])).toString('utf8'));
}

function objectStream(buffer, objectId) {
  const marker = Buffer.from(`${objectId} 0 obj\n`, 'binary');
  const objectStart = buffer.indexOf(marker);
  assert.notEqual(objectStart, -1, `object ${objectId} should exist`);
  const streamStartMarker = Buffer.from('stream\n', 'binary');
  const streamStart = buffer.indexOf(streamStartMarker, objectStart);
  assert.notEqual(streamStart, -1, `object ${objectId} should contain a stream`);
  const contentStart = streamStart + streamStartMarker.length;
  const streamEnd = buffer.indexOf(Buffer.from('\nendstream', 'binary'), contentStart);
  assert.notEqual(streamEnd, -1, `object ${objectId} stream should terminate`);
  return buffer.subarray(contentStart, streamEnd);
}

function paragraphContaining(documentXml, text) {
  const paragraph = [...documentXml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map((match) => match[0]).find((value) => value.includes(text));
  assert.ok(paragraph, `paragraph containing ${text} should exist`);
  return paragraph;
}
