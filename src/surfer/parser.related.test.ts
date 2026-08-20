import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSurferRelatedRows, parseSurferOverlap, type SurferRelatedTableRow } from './parser.js';

test('parses Keyword | Overlap | Volume in displayed order', () => {
  const rows: SurferRelatedTableRow[] = [
    { keyword: 'compare lists', overlapText: '50%', volumeText: '1.2K' },
  ];
  const result = parseSurferRelatedRows(rows);
  assert.equal(result.length, 1);
  // Keyword is taken verbatim; no "%" or digits are stripped from the name.
  assert.equal(result[0]!.keyword, 'compare lists');
  assert.equal(result[0]!.volume, 1200);
  assert.equal(result[0]!.overlap, 50);
  assert.equal(result[0]!.normalizedKeyword, 'compare lists');
});

test('parses overlap as a unitless 0..100 percentage', () => {
  assert.equal(parseSurferOverlap('50%'), 50);
  assert.equal(parseSurferOverlap('80'), 80);
  assert.equal(parseSurferOverlap('  8% '), 8);
  assert.equal(parseSurferOverlap(''), null);
  assert.equal(parseSurferOverlap(undefined), null);
  assert.equal(parseSurferOverlap('n/a'), null);
});

test('parses multiple rows and drops empty keywords', () => {
  const rows: SurferRelatedTableRow[] = [
    { keyword: 'best laptops', overlapText: '40%', volumeText: '50K' },
    { keyword: '', overlapText: '', volumeText: '' },
    { keyword: 'wireframe tool', overlapText: '', volumeText: '' },
  ];
  const result = parseSurferRelatedRows(rows);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.keyword, 'best laptops');
  assert.equal(result[0]!.volume, 50000);
  assert.equal(result[0]!.overlap, 40);
  assert.equal(result[1]!.keyword, 'wireframe tool');
  assert.equal(result[1]!.volume, null);
  assert.equal(result[1]!.overlap, null);
});

test('keyword without numbers keeps null metrics verbatim', () => {
  const rows: SurferRelatedTableRow[] = [
    { keyword: 'mind map tool', overlapText: '', volumeText: '' },
  ];
  const result = parseSurferRelatedRows(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.keyword, 'mind map tool');
  assert.equal(result[0]!.volume, null);
  assert.equal(result[0]!.overlap, null);
});

test('empty row list yields no candidates', () => {
  assert.deepEqual(parseSurferRelatedRows([]), []);
});

test('related keyword uses the same whitespace normalization as seeds', () => {
  const [result] = parseSurferRelatedRows([
    { keyword: '  Compare   TWO Lists  ', overlapText: '50%', volumeText: '100' },
  ]);
  assert.equal(result?.normalizedKeyword, 'compare two lists');
});

test('fixture: real Surfer related-keywords table order', () => {
  // Mirrors the observed Keyword | Overlap | Volume column order.
  const rows: SurferRelatedTableRow[] = [
    { keyword: 'instagram', overlapText: '50%', volumeText: '30.4M' },
    { keyword: 'notion', overlapText: '45%', volumeText: '1.8M' },
  ];
  const result = parseSurferRelatedRows(rows);
  assert.equal(result[0]!.keyword, 'instagram');
  assert.equal(result[0]!.overlap, 50);
  assert.equal(result[0]!.volume, 30_400_000);
  assert.equal(result[1]!.keyword, 'notion');
  assert.equal(result[1]!.overlap, 45);
  assert.equal(result[1]!.volume, 1_800_000);
});
