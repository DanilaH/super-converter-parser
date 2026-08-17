import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { CacheStore, type KeywordCache } from '../cache/store.js';
import { buildKeywordCacheKey, keywordCacheIdentity } from '../cache/keys.js';
import { loadConfig, type ResearchConfig } from '../config/config.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { executeRun, type EngineHooks, type ExecuteRunOptions } from './engine.js';
import { createRunId, type KeywordRecord } from './run.js';
import { ResearchError } from '../shared/errors.js';
import type { CollectionResult } from '../browser/collect.js';
import type { SerpResult } from '../google/serp.js';

const BASE_CONFIG = loadConfig({});
const INPUT = { kind: 'seeds' as const, path: 'input/seeds.csv' };
const IDENTITY = keywordCacheIdentity(BASE_CONFIG);

const KEYWORDS: SeedKeyword[] = buildSeedKeywords([
  { keyword: 'compare lists', rowNumber: 1 },
  { keyword: 'best office chairs', rowNumber: 2 },
  { keyword: 'standing desk', rowNumber: 3 },
  { keyword: 'ergonomic mouse', rowNumber: 4 },
]);

function makeHooks(overrides: Partial<EngineHooks> = {}): EngineHooks {
  return {
    sleep: async () => undefined,
    now: () => Date.now(),
    random: () => 0.5,
    logger: () => undefined,
    pauseRequested: () => false,
    ...overrides,
  };
}

function serpRowsFor(keyword: string, count: number): SerpResult[] {
  return Array.from({ length: count }, (_, index) => ({
    keyword,
    position: index + 1,
    title: `title ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    hostname: 'example.com',
    resultType: 'organic' as const,
  }));
}

function okResult(keyword: KeywordRecord, serpCount = 2): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: {
        volume: 100,
        cpc: 1.5,
        market: 'US',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=x',
        detectedLocation: null,
        geoWarning: false,
      },
      error: null,
    },
    serpRows: serpRowsFor(keyword.normalizedKeyword, serpCount),
    debugArtifactPath: null,
  };
}

// Primes a cache entry for one keyword, mirroring what the engine writes.
// Defaults are relative to "now" so entries are live, not expired.
function primeCache(
  cache: CacheStore,
  normalizedKeyword: string,
  status: KeywordRecord['status'],
  ttlMs: number,
  collectedAt = new Date(Date.now() - 60_000).toISOString(),
  volume = 49500,
): void {
  const keyword = KEYWORDS.find((item) => item.normalizedKeyword === normalizedKeyword) as SeedKeyword;
  cache.putKeyword({
    cacheKey: buildKeywordCacheKey(normalizedKeyword, IDENTITY),
    keyword: keyword.keyword,
    normalizedKeyword,
    identity: IDENTITY,
    record: {
      id: 'cached',
      keyword: keyword.keyword,
      normalizedKeyword,
      sources: [],
      status,
      surfer: status === 'completed' ? { volume, cpc: 7.9, market: 'US', fetchedAt: collectedAt } : null,
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=cached',
        detectedLocation: null,
        geoWarning: false,
      },
      error: status === 'failed' ? { code: 'SURFER_PARSE_ERROR', message: 'cached failure' } : null,
    },
    serpRows: serpRowsFor(normalizedKeyword, 2),
    collectedAt,
    storedAt: collectedAt,
    expiresAt: new Date(Date.parse(collectedAt) + ttlMs).toISOString(),
  });
}

function baseOptions(
  store: RunStore,
  runId: string,
  runDirectory: string,
  cache: KeywordCache,
  extra: Partial<ExecuteRunOptions> = {},
): ExecuteRunOptions {
  return {
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: BASE_CONFIG,
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (keyword) => okResult(keyword),
    hooks: makeHooks(),
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
    ...extra,
  };
}

test('a fully cached run serves every keyword without browser work or lookups', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'cache-all-hit-'));
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  const collectedAt = new Date(Date.now() - 60_000).toISOString();
  for (const keyword of KEYWORDS) {
    primeCache(cache, keyword.normalizedKeyword, 'completed', ttl, collectedAt);
  }

  let collectCalls = 0;
  const outcome = await executeRun(
    baseOptions(store, runId, runDirectory, cache, {
      collect: async (keyword) => {
        collectCalls += 1;
        return okResult(keyword);
      },
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.state, 'completed');
  assert.equal(collectCalls, 0);
  assert.equal(store.loadRun(runId)?.lookups, 0);
  assert.deepEqual(
    store.loadKeywords(runId).map((item) => item.cacheStatus),
    ['hit', 'hit', 'hit', 'hit'],
  );
  // Cached data (including the original collectedAt) is committed to the run.
  assert.equal(store.loadKeyword(runId, 0)?.collectedAt, collectedAt);
  assert.equal(store.loadKeyword(runId, 0)?.surfer?.volume, 49500);
  assert.equal(store.loadSerpRows(runId).length, 8);

  const manifest = JSON.parse(
    await readFile(join(runDirectory, 'manifest.json'), 'utf8'),
  ) as { progress: { cache: { hits: number; misses: number; expired: number; refreshed: number }; lookups: number } };
  assert.deepEqual(manifest.progress.cache, { hits: 4, misses: 0, expired: 0, refreshed: 0 });
  assert.equal(manifest.progress.lookups, 0);
  store.close();
  cache.close();
});

test('expired entries are misses that refresh the cache with a new expiry', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  primeCache(cache, 'compare lists', 'completed', 1000, '2020-01-01T00:00:00.000Z');

  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'cache-expired-')), cache, {
      keywords: KEYWORDS.slice(0, 1),
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(store.loadKeyword(runId, 0)?.cacheStatus, 'expired');
  assert.equal(store.loadRun(runId)?.lookups, 1);
  const refreshed = cache.getKeyword(buildKeywordCacheKey('compare lists', IDENTITY));
  assert.ok(refreshed !== null);
  assert.ok(Date.parse(refreshed.expiresAt) > Date.parse('2020-01-01T00:00:00.000Z'));
  assert.equal(refreshed.collectedAt, store.loadKeyword(runId, 0)?.collectedAt);
  store.close();
  cache.close();
});

test('forceRefresh bypasses valid cache entries and overwrites them', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  for (const keyword of KEYWORDS) {
    primeCache(cache, keyword.normalizedKeyword, 'completed', ttl, '2026-01-01T00:00:00.000Z', 123);
  }

  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'cache-force-')), cache, {
      cache: { store: cache, forceRefresh: true, refreshKeywords: new Set() },
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.deepEqual(
    store.loadKeywords(runId).map((item) => item.cacheStatus),
    ['refreshed', 'refreshed', 'refreshed', 'refreshed'],
  );
  assert.equal(store.loadRun(runId)?.lookups, 4);
  // Fresh collection (volume 100) overwrote the cached entry (volume 123).
  assert.equal(cache.getKeyword(buildKeywordCacheKey('compare lists', IDENTITY))?.record.surfer?.volume, 100);
  store.close();
  cache.close();
});

test('refreshKeywords refresh only the listed keyword', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  for (const keyword of KEYWORDS) {
    primeCache(cache, keyword.normalizedKeyword, 'completed', ttl);
  }

  const calls: string[] = [];
  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'cache-selective-')), cache, {
      cache: { store: cache, forceRefresh: false, refreshKeywords: new Set(['standing desk']) },
      collect: async (keyword) => {
        calls.push(keyword.normalizedKeyword);
        return okResult(keyword);
      },
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.deepEqual(calls, ['standing desk']);
  assert.equal(store.loadRun(runId)?.lookups, 1);
  assert.deepEqual(
    store.loadKeywords(runId).map((item) => item.cacheStatus),
    ['hit', 'hit', 'refreshed', 'hit'],
  );
  store.close();
  cache.close();
});

test('cached failures never reach the live circuit breaker window', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const ttl = BASE_CONFIG.cache.ttl.failedMs;
  for (const keyword of KEYWORDS) {
    primeCache(cache, keyword.normalizedKeyword, 'failed', ttl);
  }
  const config = testConfig({
    circuitBreaker: { surferWindow: 3, surferFailureThreshold: 3, googleConsecutiveThreshold: 10 },
  });

  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'cache-breaker-')), cache, {
      config,
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.state, 'completed_with_errors');
  assert.deepEqual(
    store.loadKeywords(runId).map((item) => item.cacheStatus),
    ['hit', 'hit', 'hit', 'hit'],
  );
  store.close();
  cache.close();
});

test('a cache write failure is visible but never corrupts the run', async () => {
  const store = RunStore.openInMemory();
  const failing: KeywordCache = {
    getKeyword: () => null,
    putKeyword: () => {
      throw new ResearchError('CACHE_DB_ERROR', 'test injection');
    },
  };
  const runId = createRunId();
  const logs: string[] = [];
  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'cache-write-fail-')), failing, {
      cache: { store: failing, forceRefresh: false, refreshKeywords: new Set() },
      hooks: makeHooks({ logger: (line) => logs.push(line) }),
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.state, 'completed');
  assert.equal(store.loadRun(runId)?.lookups, 4);
  assert.ok(logs.some((line) => line.includes('cache write failed')));
  store.close();
});

test('resume serves remaining keywords from cache without lookups', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'cache-resume-'));
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  for (const keyword of KEYWORDS.slice(1)) {
    primeCache(cache, keyword.normalizedKeyword, 'completed', ttl);
  }

  const calls: string[] = [];
  const first = await executeRun(
    baseOptions(store, runId, runDirectory, cache, {
      collect: async (keyword) => {
        calls.push(keyword.normalizedKeyword);
        return okResult(keyword);
      },
      hooks: makeHooks({ pauseRequested: () => calls.length >= 1 }),
    }),
  );
  assert.equal(first.kind, 'paused');
  assert.equal(calls.length, 1);
  assert.equal(store.loadRun(runId)?.lookups, 1);

  const resumedCalls: string[] = [];
  const second = await executeRun(
    baseOptions(store, runId, runDirectory, cache, {
      mode: 'resume',
      keywords: [],
      collect: async (keyword) => {
        resumedCalls.push(keyword.normalizedKeyword);
        return okResult(keyword);
      },
    }),
  );
  assert.equal(second.kind, 'finished');
  assert.equal(second.state, 'completed');
  assert.deepEqual(resumedCalls, []);
  assert.equal(store.loadRun(runId)?.lookups, 1);
  assert.deepEqual(
    store.loadKeywords(runId).map((item) => item.cacheStatus),
    ['miss', 'hit', 'hit', 'hit'],
  );
  store.close();
  cache.close();
});

test('force refresh semantics persist across pause and resume', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'cache-force-resume-'));
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  for (const keyword of KEYWORDS) {
    primeCache(cache, keyword.normalizedKeyword, 'completed', ttl);
  }

  let calls = 0;
  const first = await executeRun(
    baseOptions(store, runId, runDirectory, cache, {
      cache: { store: cache, forceRefresh: true, refreshKeywords: new Set() },
      collect: async (keyword) => {
        calls += 1;
        return okResult(keyword);
      },
      hooks: makeHooks({ pauseRequested: () => calls >= 1 }),
    }),
  );
  assert.equal(first.kind, 'paused');

  // Resume WITHOUT the flag: the persisted force-refresh semantics apply.
  const second = await executeRun(
    baseOptions(store, runId, runDirectory, cache, {
      mode: 'resume',
      keywords: [],
      cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
      collect: async (keyword) => {
        calls += 1;
        return okResult(keyword);
      },
    }),
  );
  assert.equal(second.kind, 'finished');
  assert.equal(second.state, 'completed');
  assert.equal(calls, 4);
  assert.deepEqual(
    store.loadKeywords(runId).map((item) => item.cacheStatus),
    ['refreshed', 'refreshed', 'refreshed', 'refreshed'],
  );
  assert.equal(store.loadRun(runId)?.forceRefresh, true);
  store.close();
  cache.close();
});

test('cache hit rate appears in progress lines', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  for (const keyword of KEYWORDS.slice(0, 1)) {
    primeCache(cache, keyword.normalizedKeyword, 'completed', ttl);
  }
  const logs: string[] = [];
  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'cache-progress-')), cache, {
      hooks: makeHooks({ logger: (line) => logs.push(line) }),
    }),
  );
  assert.equal(outcome.kind, 'finished');
  const progressLines = logs.filter((line) => line.startsWith('Keywords '));
  assert.match(progressLines[0] as string, /Cache 100% \(1 hit \/ 0 miss\)/);
  assert.match(progressLines[1] as string, /Cache 50% \(1 hit \/ 1 miss\)/);
  assert.match(progressLines[3] as string, /Cache 25% \(1 hit \/ 3 miss\) \| Browser lookups 3 \| Errors 0/);
  store.close();
  cache.close();
});

function testConfig(overrides: Partial<ResearchConfig>): ResearchConfig {
  return { ...BASE_CONFIG, ...overrides };
}
