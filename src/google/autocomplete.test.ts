import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGoogleAutocomplete,
  buildAutocompleteUrl,
  buildAutocompleteUrlForConfig,
} from '../google/autocomplete.js';
import type { ResearchConfig } from '../config/config.js';

test('parseGoogleAutocomplete reads the suggestion array (plain JSON)', () => {
  const payload = JSON.stringify(['compare lists', ['compare lists excel', 'compare lists online free']]);
  assert.deepEqual(parseGoogleAutocomplete(payload), ['compare lists excel', 'compare lists online free']);
});

test('parseGoogleAutocomplete strips the window.google.ac.h(...) wrapper', () => {
  const payload = 'window.google.ac.h(["json diff",["json diff tool","json diff checker"],{"q":"json diff","k":1}],{"google:baseDomain":""})';
  assert.deepEqual(parseGoogleAutocomplete(payload), ['json diff tool', 'json diff checker']);
});

test('parseGoogleAutocomplete tolerates empty/garbage payloads', () => {
  assert.deepEqual(parseGoogleAutocomplete(''), []);
  assert.deepEqual(parseGoogleAutocomplete('not json at all'), []);
});

test('buildAutocompleteUrl includes hl and gl', () => {
  const url = buildAutocompleteUrl('compare lists', 'en', 'us');
  assert.match(url, /[?&]hl=en/);
  assert.match(url, /[?&]gl=us/);
  assert.match(url, /complete\/search/);
  assert.match(url, /[?&]q=compare\+lists/);
});

test('buildAutocompleteUrlForConfig derives hl/gl from config', () => {
  const config = {
    research: { market: 'US', googleHl: 'en', googleGl: 'us', topN: 10 },
  } as unknown as ResearchConfig;
  assert.match(buildAutocompleteUrlForConfig(config, 'x'), /[?&]hl=en/);
});
