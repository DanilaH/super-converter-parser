import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { CacheStore, type CachedKeywordEntry, type KeywordCache } from '../cache/store.js';
import { buildKeywordCacheKey, keywordCacheIdentity } from '../cache/keys.js';
import type { CacheResolution } from '../cache/resolve.js';
import { loadConfig, type ResearchConfig } from '../config/config.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
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
    related: { status: 'empty', error: null, rows: [] },
  };
}

// Builds one cached entry exactly as the engine writes it. Defaults are
// relative to "now" so entries are live, not expired.
function cachedEntryFor(
  normalizedKeyword: string,
  status: KeywordRecord['status'],
  ttlMs: number,
  collectedAt = new Date(Date.now() - 60_000).toISOString(),
  volume = 49500,
): CachedKeywordEntry {
  const keyword = KEYWORDS.find((item) => item.normalizedKeyword === normalizedKeyword) as SeedKeyword;
  return {
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
  };
}

// Primes a cache entry for one keyword, mirroring what the engine writes.
function primeCache(
  cache: CacheStore,
  normalizedKeyword: string,
  status: KeywordRecord['status'],
  ttlMs: number,
  collectedAt = new Date(Date.now() - 60_000).toISOString(),
  volume = 49500,
): void {
  cache.putKeyword(cachedEntryFor(normalizedKeyword, status, ttlMs, collectedAt, volume));
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
  ) as { progress: { completedKeywords: number; cache: { hits: number; misses: number; expired: number; refreshed: number; hitRatePercent: number }; lookups: number } };
  assert.deepEqual(manifest.progress.cache, { hits: 4, misses: 0, expired: 0, refreshed: 0, hitRatePercent: 100 });
  // The buckets are disjoint and add up to the processed keyword count.
  const cacheBuckets = manifest.progress.cache;
  assert.equal(
    cacheBuckets.hits + cacheBuckets.misses + cacheBuckets.expired + cacheBuckets.refreshed,
    manifest.progress.completedKeywords,
  );
  assert.equal(manifest.progress.lookups, 0);
  store.close();
  cache.close();
});

test('expired entries refresh the cache with a new expiry and are their own bucket', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'cache-expired-'));
  primeCache(cache, 'compare lists', 'completed', 1000, '2020-01-01T00:00:00.000Z');

  const logs: string[] = [];
  const outcome = await executeRun(
    baseOptions(store, runId, runDirectory, cache, {
      keywords: KEYWORDS.slice(0, 1),
      hooks: makeHooks({ logger: (line) => logs.push(line) }),
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(store.loadKeyword(runId, 0)?.cacheStatus, 'expired');
  assert.equal(store.loadRun(runId)?.lookups, 1);
  const refreshed = cache.getKeyword(buildKeywordCacheKey('compare lists', IDENTITY));
  assert.ok(refreshed !== null);
  assert.ok(Date.parse(refreshed.expiresAt) > Date.parse('2020-01-01T00:00:00.000Z'));
  assert.equal(refreshed.collectedAt, store.loadKeyword(runId, 0)?.collectedAt);

  // Expired entries are their own bucket everywhere: never double-counted as
  // misses, so the buckets add up to the processed keyword count.
  const progressLines = logs.filter((line) => line.startsWith('Keywords '));
  assert.match(progressLines[0] as string, /Cache 0% \(0 hit \/ 0 miss \/ 1 expired \/ 0 refreshed\)/);
  const manifest = JSON.parse(
    await readFile(join(runDirectory, 'manifest.json'), 'utf8'),
  ) as { progress: { cache: { hits: number; misses: number; expired: number; refreshed: number; hitRatePercent: number } } };
  assert.deepEqual(manifest.progress.cache, { hits: 0, misses: 0, expired: 1, refreshed: 0, hitRatePercent: 0 });
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
  assert.match(progressLines[0] as string, /Cache 100% \(1 hit \/ 0 miss \/ 0 expired \/ 0 refreshed\)/);
  assert.match(progressLines[1] as string, /Cache 50% \(1 hit \/ 1 miss \/ 0 expired \/ 0 refreshed\)/);
  assert.match(progressLines[3] as string, /Cache 25% \(1 hit \/ 3 miss \/ 0 expired \/ 0 refreshed\) \| Browser lookups 3 \| Errors 0/);
  store.close();
  cache.close();
});

test('expired entries are accounted in their own bucket in the live line and the manifest', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'cache-expired-mixed-'));
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  primeCache(cache, 'compare lists', 'completed', 1000, '2020-01-01T00:00:00.000Z');
  for (const keyword of KEYWORDS.slice(1)) {
    primeCache(cache, keyword.normalizedKeyword, 'completed', ttl);
  }

  const logs: string[] = [];
  const outcome = await executeRun(
    baseOptions(store, runId, runDirectory, cache, {
      hooks: makeHooks({ logger: (line) => logs.push(line) }),
    }),
  );
  assert.equal(outcome.kind, 'finished');
  const progressLines = logs.filter((line) => line.startsWith('Keywords '));
  assert.match(progressLines[3] as string, /Cache 75% \(3 hit \/ 0 miss \/ 1 expired \/ 0 refreshed\)/);
  const manifest = JSON.parse(
    await readFile(join(runDirectory, 'manifest.json'), 'utf8'),
  ) as { progress: { cache: { hits: number; misses: number; expired: number; refreshed: number; hitRatePercent: number } } };
  // expired is its own bucket, never double-counted inside misses: the four
  // buckets add up to the processed keyword count (3 + 0 + 1 + 0 = 4).
  assert.deepEqual(manifest.progress.cache, { hits: 3, misses: 0, expired: 1, refreshed: 0, hitRatePercent: 75 });
  store.close();
  cache.close();
});

test('expired entries survive a cache reopen and are accounted as expired', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-reopen-expired-'));
  const cachePath = join(directory, 'cache.sqlite');
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'cache-reopen-run-'));

  // Session 1: a previous process stored an entry whose TTL has since passed.
  const first = CacheStore.open(cachePath);
  primeCache(first, 'compare lists', 'completed', 1, new Date(Date.now() - 60_000).toISOString());
  first.close();

  // Session 2: the reopen must not purge the entry before it can be
  // classified; the run reports it as expired in its own bucket.
  const reopened = CacheStore.open(cachePath);
  const logs: string[] = [];
  const outcome = await executeRun(
    baseOptions(store, runId, runDirectory, reopened, {
      keywords: KEYWORDS.slice(0, 1),
      hooks: makeHooks({ logger: (line) => logs.push(line) }),
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(store.loadKeyword(runId, 0)?.cacheStatus, 'expired');
  assert.equal(store.loadRun(runId)?.lookups, 1);
  const progressLines = logs.filter((line) => line.startsWith('Keywords '));
  assert.match(progressLines[0] as string, /Cache 0% \(0 hit \/ 0 miss \/ 1 expired \/ 0 refreshed\)/);
  const manifest = JSON.parse(
    await readFile(join(runDirectory, 'manifest.json'), 'utf8'),
  ) as { progress: { cache: { hits: number; misses: number; expired: number; refreshed: number; hitRatePercent: number } } };
  assert.deepEqual(manifest.progress.cache, { hits: 0, misses: 0, expired: 1, refreshed: 0, hitRatePercent: 0 });
  assert.equal(
    manifest.progress.cache.hits + manifest.progress.cache.misses + manifest.progress.cache.expired + manifest.progress.cache.refreshed,
    1,
    'the cache buckets add up to the processed keyword count',
  );
  // The refresh overwrote the stale row with a live one.
  const refreshed = reopened.getKeyword(buildKeywordCacheKey('compare lists', IDENTITY)) as CachedKeywordEntry;
  assert.ok(refreshed !== null);
  assert.ok(Date.parse(refreshed.expiresAt) > Date.now());
  reopened.close();
  store.close();
});

function testConfig(overrides: Partial<ResearchConfig>): ResearchConfig {
  return { ...BASE_CONFIG, ...overrides };
}

test('a different research identity invalidates every cached entry', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  for (const keyword of KEYWORDS) {
    primeCache(cache, keyword.normalizedKeyword, 'completed', ttl);
  }
  const deConfig = testConfig({ research: { ...BASE_CONFIG.research, googleGl: 'de' } });

  let collectCalls = 0;
  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'cache-identity-')), cache, {
      config: deConfig,
      collect: async (keyword) => {
        collectCalls += 1;
        return okResult(keyword);
      },
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(collectCalls, 4);
  assert.equal(store.loadRun(runId)?.lookups, 4);
  assert.deepEqual(
    store.loadKeywords(runId).map((item) => item.cacheStatus),
    ['miss', 'miss', 'miss', 'miss'],
  );
  // Fresh data was cached under the de identity; the us entries are untouched.
  const deIdentity = keywordCacheIdentity(deConfig);
  assert.equal(cache.getKeyword(buildKeywordCacheKey('compare lists', deIdentity))?.record.surfer?.volume, 100);
  assert.equal(cache.getKeyword(buildKeywordCacheKey('compare lists', IDENTITY))?.record.surfer?.volume, 49500);
  store.close();
  cache.close();
});

test('precomputed resolutions are authoritative: the engine never re-reads the cache', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'cache-single-read-'));
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  const resolutions = new Map<string, CacheResolution>();
  for (const keyword of KEYWORDS) {
    resolutions.set(keyword.normalizedKeyword, {
      kind: 'hit',
      entry: cachedEntryFor(keyword.normalizedKeyword, 'completed', ttl),
    });
  }
  // Any cache read would be a second, inconsistent look at the state the plan
  // was built from; a probe store makes such a read observable.
  let cacheReads = 0;
  let collectCalls = 0;
  const inert: KeywordCache = {
    getKeyword: () => {
      cacheReads += 1;
      return null;
    },
    putKeyword: () => undefined,
  };
  const outcome = await executeRun(
    baseOptions(store, runId, runDirectory, inert, {
      cache: {
        store: inert,
        forceRefresh: false,
        refreshKeywords: new Set(),
        resolutions,
      },
      collect: async (keyword) => {
        collectCalls += 1;
        return okResult(keyword);
      },
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.state, 'completed');
  assert.equal(collectCalls, 0);
  assert.equal(cacheReads, 0, 'the plan is authoritative: zero cache reads during execution');
  assert.deepEqual(
    store.loadKeywords(runId).map((item) => item.cacheStatus),
    ['hit', 'hit', 'hit', 'hit'],
  );
  const plannedEntry = (resolutions.get('compare lists') as { kind: 'hit'; entry: CachedKeywordEntry }).entry;
  assert.equal(store.loadKeyword(runId, 0)?.collectedAt, plannedEntry.collectedAt);
  store.close();
});

test('keywords.json reports the per-keyword cache status', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'cache-keywords-json-'));
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  primeCache(cache, 'compare lists', 'completed', ttl);

  const outcome = await executeRun(baseOptions(store, runId, runDirectory, cache, {}));
  assert.equal(outcome.kind, 'finished');
  const records = JSON.parse(await readFile(join(runDirectory, 'keywords.json'), 'utf8')) as Array<{
    normalizedKeyword: string;
    cacheStatus: 'hit' | 'miss' | 'expired' | 'refreshed' | null;
  }>;
  assert.equal(records.length, 4);
  assert.deepEqual(
    records.map((record) => record.cacheStatus),
    ['hit', 'miss', 'miss', 'miss'],
  );
  assert.equal(records[0]?.normalizedKeyword, 'compare lists');
  store.close();
  cache.close();
});

// The pre-cache (v1) run-store schema, as written by versions of the runner
// that had no cache support at all.
const V1_RUN_SCHEMA = `
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    input_kind TEXT NOT NULL,
    input_path TEXT NOT NULL,
    config_snapshot TEXT NOT NULL,
    parser_versions TEXT NOT NULL,
    lookups INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT
  );

  CREATE TABLE keywords (
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    id TEXT NOT NULL,
    keyword TEXT NOT NULL,
    normalized_keyword TEXT NOT NULL,
    sources TEXT NOT NULL,
    status TEXT NOT NULL,
    surfer TEXT,
    google TEXT,
    error TEXT,
    collected_at TEXT,
    PRIMARY KEY (run_id, idx)
  );

  CREATE TABLE serp_rows (
    run_id TEXT NOT NULL,
    keyword_idx INTEGER NOT NULL,
    position INTEGER NOT NULL,
    keyword TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    result_type TEXT NOT NULL,
    PRIMARY KEY (run_id, keyword_idx, position)
  );
`;

test('a paused v1 run migrates and resumes with complete cache accounting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-v1-resume-cache-'));
  const runPath = join(directory, 'run.sqlite');
  const cache = CacheStore.openInMemory();
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  // The one pending keyword will be served from the cache after the resume.
  primeCache(cache, 'standing desk', 'completed', ttl);

  // A real pre-cache (v1) paused run: two terminal keywords collected fresh,
  // one pending keyword left over.
  const v1 = new Database(runPath);
  v1.pragma('user_version = 1');
  v1.exec(V1_RUN_SCHEMA);
  v1.prepare(
    `INSERT INTO runs (run_id, state, created_at, updated_at, input_kind, input_path, config_snapshot, parser_versions, lookups, pause_reason)
     VALUES ('run-1', 'paused', ?, ?, 'seeds', 'input/seeds.csv', ?, ?, 2, NULL)`,
  ).run(
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    JSON.stringify(BASE_CONFIG),
    JSON.stringify({ surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION }),
  );
  const insertKeyword = v1.prepare(
    `INSERT INTO keywords (run_id, idx, id, keyword, normalized_keyword, sources, status)
     VALUES ('run-1', ?, ?, ?, ?, ?, ?)`,
  );
  insertKeyword.run(0, 'kw-0001', 'compare lists', 'compare lists', '[]', 'completed');
  insertKeyword.run(1, 'kw-0002', 'best office chairs', 'best office chairs', '[]', 'failed');
  insertKeyword.run(2, 'kw-0003', 'standing desk', 'standing desk', '[]', 'pending');
  v1.prepare(
    `INSERT INTO serp_rows (run_id, keyword_idx, position, keyword, title, url, hostname, result_type)
     VALUES ('run-1', 0, 1, 'compare lists', 'title', 'https://example.com/1', 'example.com', 'organic')`,
  ).run();
  v1.close();

  // Opening the store migrates v1 -> v2: terminal keywords gain 'miss'
  // provenance (they were collected fresh), the pending one stays null.
  const store = RunStore.open(runPath);
  assert.equal(store.version, 2);
  assert.deepEqual(
    store.loadKeywords('run-1').map((keyword) => keyword.cacheStatus),
    ['miss', 'miss', null],
  );

  const runId = 'run-1';
  const runDirectory = await mkdtemp(join(tmpdir(), 'run-v1-resume-out-'));
  const outcome = await executeRun(
    baseOptions(store, runId, runDirectory, cache, {
      mode: 'resume',
      keywords: [],
    }),
  );
  assert.equal(outcome.kind, 'finished');
  // The failed keyword stays terminal, so the run finishes with errors.
  assert.equal(outcome.state, 'completed_with_errors');
  assert.equal(store.loadRun(runId)?.lookups, 2, 'no fresh lookups: the pending keyword was a cache hit');
  assert.deepEqual(
    store.loadKeywords(runId).map((keyword) => keyword.cacheStatus),
    ['miss', 'miss', 'hit'],
  );

  const manifest = JSON.parse(
    await readFile(join(runDirectory, 'manifest.json'), 'utf8'),
  ) as {
    progress: {
      totalKeywords: number;
      completedKeywords: number;
      partialKeywords: number;
      failedKeywords: number;
      cache: { hits: number; misses: number; expired: number; refreshed: number; hitRatePercent: number };
    };
  };
  assert.deepEqual(manifest.progress.cache, { hits: 1, misses: 2, expired: 0, refreshed: 0, hitRatePercent: 33 });
  // The buckets are disjoint and add up to the processed keyword count
  // (completed + partial + failed): the two migrated terminals count as
  // misses, the resumed keyword as a hit.
  const cacheBuckets = manifest.progress.cache;
  assert.equal(
    cacheBuckets.hits + cacheBuckets.misses + cacheBuckets.expired + cacheBuckets.refreshed,
    manifest.progress.completedKeywords + manifest.progress.partialKeywords + manifest.progress.failedKeywords,
  );
  assert.equal(
    cacheBuckets.hits + cacheBuckets.misses + cacheBuckets.expired + cacheBuckets.refreshed,
    manifest.progress.totalKeywords,
  );
  store.close();
  cache.close();
});
