import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKeyword, buildSeedKeywords } from './normalize.js';

test('normalizeKeyword trims and collapses whitespace', () => {
  assert.equal(normalizeKeyword('  compare   lists  '), 'compare lists');
  assert.equal(normalizeKeyword('Compare Lists'), 'compare lists');
  assert.equal(normalizeKeyword('a\tb\nc'), 'a b c');
});

test('buildSeedKeywords dedupes case-insensitively and preserves first original text', () => {
  const keywords = buildSeedKeywords([
    { keyword: 'compare lists', rowNumber: 2 },
    { keyword: 'Compare Lists', rowNumber: 3 },
    { keyword: '  compare   lists  ', rowNumber: 4 },
  ]);

  assert.equal(keywords.length, 1);
  assert.equal(keywords[0]!.keyword, 'compare lists');
  assert.equal(keywords[0]!.normalizedKeyword, 'compare lists');
  assert.deepEqual(keywords[0]!.sourceRows, [2, 3, 4]);
});

test('buildSeedKeywords keeps distinct keywords separate', () => {
  const keywords = buildSeedKeywords([
    { keyword: 'compare lists', rowNumber: 2 },
    { keyword: 'zip code county lookup', rowNumber: 3 },
  ]);

  assert.equal(keywords.length, 2);
  assert.deepEqual(
    keywords.map((item) => item.normalizedKeyword),
    ['compare lists', 'zip code county lookup'],
  );
});

test('buildSeedKeywords preserves row provenance per occurrence', () => {
  const keywords = buildSeedKeywords([
    { keyword: 'a b', rowNumber: 2 },
    { keyword: 'a b', rowNumber: 5 },
  ]);

  assert.equal(keywords.length, 1);
  assert.deepEqual(keywords[0]!.sourceRows, [2, 5]);
});