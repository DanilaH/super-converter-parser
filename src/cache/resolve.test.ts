import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveKeywordAccess,
  mergedCacheRefresh,
  planRunCache,
  type KeywordAccessOptions,
} from './resolve.js';
import { buildKeywordCacheKey, buildRelatedCacheKey, type CacheIdentity } from './keys.js';
import { type CachedKeywordEntry, type CachedRelatedEntry, type KeywordCache } from './store.js';
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

function cacheWithRelated(
  related: CachedRelatedEntry | null,
): KeywordCache {
  const cache = fakeCache([
    {
      key: buildKeywordCacheKey('compare lists', IDENTITY),
      expiresAt: '2026-02-01T00:00:00.000Z',
    },
  ]);
  return { ...cache, getRelated: () => related };
}

function relatedEntry(
  status: CachedRelatedEntry['status'],
  expiresAt = '2026-02-01T00:00:00.000Z',
): CachedRelatedEntry {
  return {
    cacheKey: buildRelatedCacheKey('compare lists', IDENTITY),
    normalizedKeyword: 'compare lists',
    identity: IDENTITY,
    status,
    error: status === 'error' ? 'SURFER_RELATED_PARSE_ERROR' : null,
    rows: status === 'ok' ? [{ relatedKeyword: '  List   comparison ', overlap: 80, volume: 5000 }] : [],
    storedAt: '2026-01-01T00:00:00.000Z',
    expiresAt,
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

test('mergedCacheRefresh keeps persisted force refresh across resume', () => {
  const merged = mergedCacheRefresh(
    { forceRefresh: false, refreshKeywords: new Set() },
    { forceRefresh: true, refreshKeywords: ['a'] },
  );
  assert.equal(merged.forceRefresh, true);
  assert.deepEqual(merged.refreshKeywords, ['a']);
});

test('mergedCacheRefresh lets a resume add keywords without dropping persisted ones', () => {
  const merged = mergedCacheRefresh(
    { forceRefresh: true, refreshKeywords: new Set(['b']) },
    { forceRefresh: false, refreshKeywords: ['a', 'b'] },
  );
  assert.equal(merged.forceRefresh, true);
  assert.deepEqual(merged.refreshKeywords.sort(), ['a', 'b']);
});

test('mergedCacheRefresh with nothing persisted keeps the provided semantics', () => {
  const merged = mergedCacheRefresh(
    { forceRefresh: true, refreshKeywords: new Set(['a']) },
    { forceRefresh: false, refreshKeywords: [] },
  );
  assert.deepEqual(merged, { forceRefresh: true, refreshKeywords: ['a'] });
});

test('planRunCache resolves each keyword exactly once', () => {
  let reads = 0;
  const key = buildKeywordCacheKey('compare lists', IDENTITY);
  const cache: KeywordCache = {
    getKeyword: (cacheKey) => {
      reads += 1;
      return cacheKey === key ? entry(key, '2026-02-01T00:00:00.000Z') : null;
    },
    putKeyword: () => undefined,
  };
  const plan = planRunCache(
    ['compare lists', 'best office chairs'],
    OPTIONS,
    cache,
    Date.parse('2026-01-01T00:00:00.000Z'),
  );
  assert.equal(reads, 2, 'each pending keyword is resolved exactly once');
  assert.equal(plan.needsBrowser, true);
  assert.equal(plan.resolutions.size, 2);
  assert.equal(plan.resolutions.get('compare lists')?.kind, 'hit');
  assert.equal(plan.resolutions.get('best office chairs')?.kind, 'miss');
});

test('planRunCache needs no browser when every keyword is a fresh hit', () => {
  const cache = fakeCache([
    { key: buildKeywordCacheKey('compare lists', IDENTITY), expiresAt: '2026-02-01T00:00:00.000Z' },
    { key: buildKeywordCacheKey('best office chairs', IDENTITY), expiresAt: '2026-02-01T00:00:00.000Z' },
  ]);
  const plan = planRunCache(['compare lists', 'best office chairs'], OPTIONS, cache, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(plan.needsBrowser, false);
  assert.deepEqual(
    [...plan.resolutions.values()].map((item) => item.kind),
    ['hit', 'hit'],
  );
});

test('planRunCache without a cache store plans misses and needs the browser', () => {
  const plan = planRunCache(['compare lists'], OPTIONS, null, Date.now());
  assert.equal(plan.needsBrowser, true);
  assert.equal(plan.resolutions.get('compare lists')?.kind, 'miss');
});

test('planRunCache treats forced keywords as needing the browser', () => {
  const cache = fakeCache([{ key: buildKeywordCacheKey('compare lists', IDENTITY), expiresAt: '2026-02-01T00:00:00.000Z' }]);
  const plan = planRunCache(
    ['compare lists'],
    { ...OPTIONS, forceRefresh: true },
    cache,
    Date.parse('2026-01-01T00:00:00.000Z'),
  );
  assert.equal(plan.needsBrowser, true);
  assert.equal(plan.resolutions.get('compare lists')?.kind, 'forced');
});

test('planRunCache with no pending keywords needs no browser', () => {
  const plan = planRunCache([], OPTIONS, null, Date.now());
  assert.equal(plan.needsBrowser, false);
  assert.equal(plan.resolutions.size, 0);
});

test('keyword hit plus related miss still needs the browser', () => {
  const plan = planRunCache(
    ['compare lists'], OPTIONS, cacheWithRelated(null),
    Date.parse('2026-01-01T00:00:00.000Z'),
    { enabled: true, expandableKeywords: new Set(['compare lists']) },
  );
  assert.equal(plan.resolutions.get('compare lists')?.kind, 'hit');
  assert.equal(plan.relatedResolutions.get('compare lists')?.kind, 'miss');
  assert.equal(plan.needsBrowser, true);
});

test('expired related entry needs a retry', () => {
  const plan = planRunCache(
    ['compare lists'], OPTIONS,
    cacheWithRelated(relatedEntry('ok', '2026-01-01T00:00:00.000Z')),
    Date.parse('2026-01-01T00:00:00.000Z'),
    { enabled: true, expandableKeywords: new Set(['compare lists']) },
  );
  assert.equal(plan.relatedResolutions.get('compare lists')?.kind, 'expired');
  assert.equal(plan.needsBrowser, true);
});

test('cached related error remains retryable', () => {
  const plan = planRunCache(
    ['compare lists'], OPTIONS, cacheWithRelated(relatedEntry('error')),
    Date.parse('2026-01-01T00:00:00.000Z'),
    { enabled: true, expandableKeywords: new Set(['compare lists']) },
  );
  assert.equal(plan.relatedResolutions.get('compare lists')?.kind, 'retry_error');
  assert.equal(plan.needsBrowser, true);
});

test('fresh related empty needs no browser for a keyword hit', () => {
  const plan = planRunCache(
    ['compare lists'], OPTIONS, cacheWithRelated(relatedEntry('empty')),
    Date.parse('2026-01-01T00:00:00.000Z'),
    { enabled: true, expandableKeywords: new Set(['compare lists']) },
  );
  assert.equal(plan.relatedResolutions.get('compare lists')?.kind, 'hit_empty');
  assert.equal(plan.needsBrowser, false);
});
