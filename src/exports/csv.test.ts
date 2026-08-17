import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeCsvCell, renderCsv } from './csv.js';

test('plain cells pass through unchanged', () => {
  assert.equal(escapeCsvCell('compare lists'), 'compare lists');
  assert.equal(escapeCsvCell(''), '');
  assert.equal(escapeCsvCell('49500'), '49500');
  assert.equal(escapeCsvCell('7.9'), '7.9');
});

test('cells with commas, quotes, or line breaks are quoted per RFC 4180', () => {
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvCell('line1\r\nline2'), '"line1\r\nline2"');
  assert.equal(escapeCsvCell('tab\tok'), 'tab\tok');
});

test('unicode content is preserved, not escaped away', () => {
  assert.equal(escapeCsvCell('сравнение списков'), 'сравнение списков');
  assert.equal(escapeCsvCell('日本語'), '日本語');
});

test('formula-like cells are neutralized with a leading quote', () => {
  assert.equal(escapeCsvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(escapeCsvCell('+1+1'), "'+1+1");
  assert.equal(escapeCsvCell('-2+3'), "'-2+3");
  assert.equal(escapeCsvCell('@cmd'), "'@cmd");
  assert.equal(escapeCsvCell('  =SUM(A1)'), "'  =SUM(A1)", 'leading whitespace does not hide the prefix');
  // The cell also contains a double quote, so quote-wrapping applies on top
  // of the formula prefix.
  assert.equal(escapeCsvCell('\t-HYPERLINK("x")'), `"'\t-HYPERLINK(""x"")"`);
  assert.equal(escapeCsvCell('-7'), "'-7");
});

test('ordinary cells are not affected by formula protection', () => {
  assert.equal(escapeCsvCell('compare - lists'), 'compare - lists');
  assert.equal(escapeCsvCell('hello world'), 'hello world');
  assert.equal(escapeCsvCell('49,500'), '"49,500"');
});

test('renderCsv emits a UTF-8 BOM, CRLF endings, and a deterministic layout', () => {
  const csv = renderCsv([
    ['keyword', 'volume'],
    ['compare lists', '49500'],
    ['best office chairs', '0'],
  ]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.equal(csv, '\uFEFFkeyword,volume\r\ncompare lists,49500\r\nbest office chairs,0\r\n');
  // CRLF row endings only, never bare LF.
  assert.ok(!/\r\r/.test(csv));
  assert.ok(!/(^|[^\r])\n/.test(csv));
});

test('renderCsv applies cell escaping across every row', () => {
  const csv = renderCsv([
    ['keyword', 'title'],
    ['=cmd', 'a "quoted", title'],
  ]);
  assert.equal(csv, '\uFEFFkeyword,title\r\n\'=cmd,"a ""quoted"", title"\r\n');
});