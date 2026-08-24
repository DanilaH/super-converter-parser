import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGooglePaa } from '../google/paa.js';

test('parseGooglePaa collects only question text and de-dupes case-insensitively', () => {
  const raw = [
    'what is a json diff?',
    '  What is a JSON diff?  ',
    'how to compare two lists?',
    '',
  ];
  // case-insensitive dedup keeps the first-seen casing only
  assert.deepEqual(parseGooglePaa(raw), [
    'what is a json diff?',
    'how to compare two lists?',
  ]);
});

test('parseGooglePaa never invents an answer', () => {
  const raw = ['why use a csv file?'];
  const out = parseGooglePaa(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0], 'why use a csv file?');
});
