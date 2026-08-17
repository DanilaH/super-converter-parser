import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKeywordAccess, type KeywordAccessOptions } from './resolve.js';
import { buildKeywordCacheKey, type CacheIdentity } from './keys.js';
import { type CachedKeywordEntry, type KeywordCache } from './store.js';
import type { SerpResult } from '../google/serp.js';

const IDENTITY: CacheIdentity = {
  market: 'US',
  hl: 'en',
  gl: 'us',
  topN: 10,
  surferParserVersion: '1.0.0',
  googleParserVersion: '1.2.0',
};

const OPTIONS: KeywordAccessOptions = {
  identity: IDENTITY,
  forceRefresh: false,
  refreshKeywords: new Set(),
};

function entry(cacheKey: string, expiresAt: string): CachedKeywordEntry {
  return {
    cacheKey,
    keyword: 'compare lists',
    normalizedKeyword: 'compare lists',
    identity: IDENTITY,
    record: {
      id: 'cached',
      keyword: 'compare lists',
      normalizedKeyword: 'compare lists',
      sources: [],
      status: 'completed',
      surfer: null,
      google: null,
      error: null,
    },
    serpRows: [] as SerpResult[],
    collectedAt: '2026-01-01T00:00:00.000Z',
    storedAt: '2026-01-01T00:00:00.000Z',
    expiresAt,
  };
}

function fakeCache(entries: Array<{ key: string; expiresAt: string }>): KeywordCache {
  const map = new Map(entries.map((item) => [item.key, entry(item.key, item.expiresAt)]));
  return {
    getKeyword: (key) => map.get(key) ?? null,
    putKeyword: () => undefined,
  };
}

test('a valid entry is a hit', () => {
  const cache = fakeCache([{ key: buildKeywordCacheKey('compare lists', IDENTITY), expiresAt: '2026-02-01T00:00:00.000Z' }]);
  const resolution = resolveKeywordAccess('compare lists', OPTIONS, cache, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(resolution.kind, 'hit');
});

test('an entry exactly at expiry is expired, not a hit', () => {
  const key = buildKeywordCacheKey('compare lists', IDENTITY);
  const cache = fakeCache([{ key, expiresAt: '2026-01-01T00:00:00.000Z' }]);
  const resolution = resolveKeywordAccess('compare lists', OPTIONS, cache, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(resolution.kind, 'expired');
});

test('missing entries are misses', () => {
  const resolution = resolveKeywordAccess('compare lists', OPTIONS, fakeCache([]), Date.now());
  assert.equal(resolution.kind, 'miss');
});

test('no cache store means miss', () => {
  const resolution = resolveKeywordAccess('compare lists', OPTIONS, null, Date.now());
  assert.equal(resolution.kind, 'miss');
});

test('forceRefresh wins over a valid entry', () => {
  const cache = fakeCache([{ key: buildKeywordCacheKey('compare lists', IDENTITY), expiresAt: '2026-02-01T00:00:00.000Z' }]);
  const resolution = resolveKeywordAccess(
    'compare lists',
    { ...OPTIONS, forceRefresh: true },
    cache,
    Date.parse('2026-01-01T00:00:00.000Z'),
  );
  assert.equal(resolution.kind, 'forced');
});

test('refreshKeywords force only the listed keyword', () => {
  const cache = fakeCache([{ key: buildKeywordCacheKey('compare lists', IDENTITY), expiresAt: '2026-02-01T00:00:00.000Z' }]);
  const options: KeywordAccessOptions = { ...OPTIONS, refreshKeywords: new Set(['compare lists']) };
  const forced = resolveKeywordAccess('compare lists', options, cache, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(forced.kind, 'forced');
  const other = resolveKeywordAccess('other keyword', options, cache, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(other.kind, 'miss');
});
