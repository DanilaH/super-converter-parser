import assert from 'node:assert/strict';
import test from 'node:test';
import type { CacheTtlSettings } from './store.js';
import { ttlMsForSuggestionStatus } from './store.js';

const ttl = {
  suggestionOkMs: 11,
  suggestionEmptyMs: 22,
  suggestionErrorMs: 33,
} as CacheTtlSettings;

test('suggestion cache keeps genuine empty evidence longer than transient failures', () => {
  assert.equal(ttlMsForSuggestionStatus('ok', ttl), 11);
  assert.equal(ttlMsForSuggestionStatus('empty', ttl), 22);
  assert.equal(ttlMsForSuggestionStatus('error', ttl), 33);
  assert.equal(ttlMsForSuggestionStatus('unavailable', ttl), 33);
});
