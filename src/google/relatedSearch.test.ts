import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleRelatedSearch } from '../google/relatedSearch.js';

test('parseGoogleRelatedSearch trims, collapses whitespace, and de-dupes case-insensitively', () => {
  const raw = [
    'compare lists excel',
    '  Compare Lists Excel  ',
    'compare lists online',
    'compare lists online',
    '',
    '   ',
  ];
  // case-insensitive dedup keeps the first-seen casing only
  assert.deepEqual(parseGoogleRelatedSearch(raw), [
    'compare lists excel',
    'compare lists online',
  ]);
});

test('parseGoogleRelatedSearch returns empty for no usable text', () => {
  assert.deepEqual(parseGoogleRelatedSearch(['', '   ']), []);
});
