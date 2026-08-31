import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HistoricalPresenceCache,
  HISTORICAL_PRESENCE_CACHE_SCHEMA_VERSION,
  defaultHistoricalPresenceCachePath,
} from './cache.js';
import { HISTORICAL_PRESENCE_QUERY_VERSION } from './types.js';

test('historical presence cache roundtrip preserves provider/query semantics', () => {
  const cache = HistoricalPresenceCache.openInMemory();
  assert.equal(cache.version, HISTORICAL_PRESENCE_CACHE_SCHEMA_VERSION);
  cache.put({
    domain: 'example.com',
    status: 'ok',
    earliestSampledCaptureAt: '2014-03-09T11:22:33Z',
    earliestSampledCaptureUrl: 'https://example.com/',
    earliestSampledCaptureHttpStatus: '403',
    earliestMatchedCollectionId: 'CC-MAIN-2014-10',
    earliestMatchedCollectionFrom: '2014-03-01T00:00:00Z',
    earliestMatchedCollectionTo: '2014-03-31T00:00:00Z',
    historyCompleteForSelectedCollections: true,
    selectedCollectionCount: 24,
    checkedCollectionCount: 7,
    source: 'common_crawl',
    sourceReason: 'bounded sampled presence',
    error: null,
    fetchedAt: '2026-08-31T00:00:00.000Z',
    requestCount: 7,
    httpStatus: 200,
  }, HISTORICAL_PRESENCE_QUERY_VERSION, '2026-08-31T00:00:00.000Z', 30 * 24 * 60 * 60 * 1000);

  const loaded = cache.get('example.com');
  assert.equal(loaded?.source, 'common_crawl');
  assert.equal(loaded?.queryVersion, HISTORICAL_PRESENCE_QUERY_VERSION);
  assert.equal(loaded?.earliestSampledCaptureAt, '2014-03-09T11:22:33Z');
  assert.equal(loaded?.earliestSampledCaptureHttpStatus, '403');
  assert.equal(loaded?.httpStatus, 200);
  assert.equal(loaded?.historyCompleteForSelectedCollections, true);
  assert.equal(loaded?.expiresAt, '2026-09-30T00:00:00.000Z');
  cache.close();
});

test('cache keeps not_found distinct from unavailable/error', () => {
  const cache = HistoricalPresenceCache.openInMemory();
  cache.put({
    domain: 'missing.example',
    status: 'not_found',
    earliestSampledCaptureAt: null,
    earliestSampledCaptureUrl: null,
    earliestSampledCaptureHttpStatus: null,
    earliestMatchedCollectionId: null,
    earliestMatchedCollectionFrom: null,
    earliestMatchedCollectionTo: null,
    historyCompleteForSelectedCollections: true,
    selectedCollectionCount: 24,
    checkedCollectionCount: 24,
    source: 'common_crawl',
    sourceReason: 'No capture observed; not proof of absence.',
    error: null,
    fetchedAt: '2026-08-31T00:00:00.000Z',
    requestCount: 24,
    httpStatus: 404,
  }, 1, '2026-08-31T00:00:00.000Z', 1000);
  const loaded = cache.get('missing.example');
  assert.equal(loaded?.status, 'not_found');
  assert.equal(loaded?.error, null);
  assert.equal(loaded?.earliestSampledCaptureAt, null);
  cache.close();
});

test('default historical cache path is isolated from the existing shared cache', () => {
  assert.equal(
    defaultHistoricalPresenceCachePath('data/cache/cache.sqlite'),
    'data/cache/cache.historical-presence.sqlite',
  );
  assert.equal(
    defaultHistoricalPresenceCachePath('data/cache/custom'),
    'data/cache/custom.historical-presence.sqlite',
  );
});
