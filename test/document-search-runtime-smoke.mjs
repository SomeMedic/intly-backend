import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DocumentParserService } from '../dist/modules/knowledge/document-parser.service.js';
import { EmbeddingsService } from '../dist/modules/knowledge/embeddings.service.js';

const config = {
  get(key) {
    return process.env[key];
  },
};

const parser = new DocumentParserService(config);

test('document parser extracts real text, pdf, and docx fixtures', async () => {
  const text = await parser.parse(Buffer.from('INTLY TypeScript resume\ncontact: user@example.com'), 'text/plain');
  assert.match(text.text, /TypeScript resume/);
  assert.deepEqual(text.structured.technologies.includes('TypeScript'), true);

  const pdf = await parser.parse(makePdf('INTLY PDF Parser Smoke'), 'application/pdf');
  assert.match(pdf.text, /INTLY PDF Parser Smoke/);

  const docx = await parser.parse(makeDocx('INTLY DOCX Parser Smoke'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(docx.text, /INTLY DOCX Parser Smoke/);
});

test('ocr parser extracts optional real image fixture when configured', async (t) => {
  const imagePath = process.env.INTLY_OCR_FIXTURE;
  if (!imagePath) {
    t.skip('Set INTLY_OCR_FIXTURE to a PNG/JPEG/WebP containing RU/EN text to run OCR smoke.');
    return;
  }
  const mimeType = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg') ? 'image/jpeg' : imagePath.endsWith('.webp') ? 'image/webp' : 'image/png';
  const parsed = await parser.parse(readFileSync(imagePath), mimeType);
  assert.ok(parsed.text.trim().length > 0);
  const expectedTokens = (process.env.INTLY_OCR_EXPECT ?? '').split('|').map((token) => token.trim()).filter(Boolean);
  for (const token of expectedTokens) {
    assert.match(parsed.text, new RegExp(token, 'i'));
  }
});

test('embedding provider returns real vector or explicit unavailable', async (t) => {
  const service = new EmbeddingsService(config);
  try {
    const result = await service.embed('passage: INTLY multilingual embedding smoke');
    assert.ok(result.vector.length > 100);
    assert.equal(result.metadata.dimension, result.vector.length);
  } catch (error) {
    if (error?.name === 'ServiceUnavailableException') {
      t.skip(error.message);
      return;
    }
    throw error;
  }
});

function makePdf(text) {
  const escaped = text.replace(/[()\\]/g, '\\$&');
  const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${object}\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function makeDocx(text) {
  const root = mkdtempSync(join(tmpdir(), 'intly-docx-'));
  mkdirSync(join(root, '_rels'), { recursive: true });
  mkdirSync(join(root, 'word', '_rels'), { recursive: true });
  writeFileSync(join(root, '[Content_Types].xml'), '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  writeFileSync(join(root, '_rels', '.rels'), '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  writeFileSync(join(root, 'word', 'document.xml'), `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:body></w:document>`);
  const target = join(root, 'fixture.docx');
  execFileSync('zip', ['-qr', target, '[Content_Types].xml', '_rels', 'word'], { cwd: root });
  return readFileSync(target);
}

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
