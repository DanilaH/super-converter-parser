import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunStore, storedKeywordToRecord } from '../db/store.js';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { buildKeywordCacheKey, keywordCacheIdentity } from '../cache/keys.js';

const CONFIG = loadConfig({});
const SEEDS = buildSeedKeywords([{ keyword: 'broken serp', rowNumber: 1 }]);
const GOOGLE_ERROR = {
  hl: 'en',
  gl: 'us',
  pageUrl: 'https://google.com/search?q=broken+serp',
  detectedLocation: null,
  geoWarning: false,
  serpStatus: 'parse_error' as const,
  serpError: {
    code: 'GOOGLE_SERP_PARSE_ERROR' as const,
    message: 'organic selector failed',
  },
};

test('run store round-trip preserves source-specific Google SERP status and error', () => {
  const store = RunStore.openInMemory();
  const runId = 'serp-truth-run';
  store.createRun({
    runId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: 'test-surfer', google: 'test-google' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: SEEDS,
  });

  const stored = store.loadKeywords(runId)[0]!;
  store.commitKeyword(
    runId,
    {
      ...stored,
      status: 'partial',
      surfer: {
        volume: 100,
        cpc: 2,
        market: 'US',
        fetchedAt: '2026-08-29T00:00:00.000Z',
      },
      google: GOOGLE_ERROR,
      error: {
        code: 'GOOGLE_SERP_PARSE_ERROR',
        message: 'organic selector failed',
      },
      collectedAt: '2026-08-29T00:00:00.000Z',
    },
    [],
    'miss',
  );

  const loaded = storedKeywordToRecord(store.loadKeywords(runId)[0]!);
  assert.equal(loaded.google?.serpStatus, 'parse_error');
  assert.deepEqual(loaded.google?.serpError, {
    code: 'GOOGLE_SERP_PARSE_ERROR',
    message: 'organic selector failed',
  });
  store.close();
});

test('keyword cache round-trip preserves source-specific Google SERP status and error', () => {
  const cache = CacheStore.openInMemory();
  const identity = keywordCacheIdentity(CONFIG);
  const cacheKey = buildKeywordCacheKey('broken serp', identity);

  cache.putKeyword({
    cacheKey,
    keyword: 'broken serp',
    normalizedKeyword: 'broken serp',
    identity,
    record: {
      id: 'cached',
      keyword: 'broken serp',
      normalizedKeyword: 'broken serp',
      sources: [],
      surfer: {
        volume: 100,
        cpc: 2,
        market: 'US',
        fetchedAt: '2026-08-29T00:00:00.000Z',
      },
      google: GOOGLE_ERROR,
      status: 'partial',
      error: {
        code: 'GOOGLE_SERP_PARSE_ERROR',
        message: 'organic selector failed',
      },
    },
    serpRows: [],
    collectedAt: '2026-08-29T00:00:00.000Z',
    storedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-30T00:00:00.000Z',
  });

  const loaded = cache.getKeyword(cacheKey);
  assert.equal(loaded?.record.google?.serpStatus, 'parse_error');
  assert.deepEqual(loaded?.record.google?.serpError, {
    code: 'GOOGLE_SERP_PARSE_ERROR',
    message: 'organic selector failed',
  });
  cache.close();
});
