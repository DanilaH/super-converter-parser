import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheStore } from './store.js';
import { buildSuggestionCacheKey } from './keys.js';
import { keywordCacheIdentity } from './keys.js';

test('suggestion cache round-trips ok/empty/unavailable/error with texts', () => {
  const store = CacheStore.openInMemory();
  const identity = keywordCacheIdentity({
    research: { market: 'US', googleHl: 'en', googleGl: 'us', topN: 10 },
    browser: {
      cdpUrl: 'x',
      navigationTimeoutMs: 1,
      surferWaitTimeoutMs: 1,
      surferPreflightTimeoutMs: 1,
      surferWidgetSelector: 'a',
      surferRelatedWidgetSelector: 'b',
      surferRelatedMissingWidgetTimeoutMs: 1,
    },
  } as never);
  const key = buildSuggestionCacheKey('google_autocomplete', 'jsondiff', identity, '1.0.0');
  store.putSuggestion(
    {
      cacheKey: key,
      source: 'google_autocomplete',
      normalizedParent: 'jsondiff',
      identity,
      parserVersion: '1.0.0',
      status: 'ok',
      error: null,
      suggestions: [{ text: 'json diff online', volume: null, cpc: null, ordinal: 0 }],
    },
    '2026-01-01T00:00:00.000Z',
    7 * 24 * 60 * 60 * 1000,
  );
  const got = store.getSuggestion(key);
  assert.ok(got);
  assert.equal(got?.status, 'ok');
  assert.equal(got?.suggestions.length, 1);
  assert.equal(got?.suggestions[0]?.text, 'json diff online');

  store.putSuggestion(
    {
      cacheKey: key,
      source: 'google_autocomplete',
      normalizedParent: 'jsondiff',
      identity,
      parserVersion: '1.0.0',
      status: 'unavailable',
      error: 'SURFER_RELATED_WIDGET_MISSING',
      suggestions: [],
    },
    '2026-01-02T00:00:00.000Z',
    7 * 24 * 60 * 60 * 1000,
  );
  const got2 = store.getSuggestion(key);
  assert.equal(got2?.status, 'unavailable');
  store.close();
});
