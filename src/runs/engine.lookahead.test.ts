import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AhrefsClient } from '../ahrefs/client.js';
import type { CollectionResult, RelatedCollectionResult } from '../browser/collect.js';
import { buildKeywordCacheKey, keywordCacheIdentity } from '../cache/keys.js';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import type { SerpResult } from '../google/serp.js';
import { executeRun, type EngineHooks } from './engine.js';
import type { KeywordRecord } from './run.js';

const CONFIG = loadConfig({});
const INPUT = { kind: 'seeds' as const, path: 'input/seeds.csv' };
const KEYWORDS = buildSeedKeywords([
  { keyword: 'alpha tool', rowNumber: 1 },
  { keyword: 'beta tool', rowNumber: 2 },
]);

function hooks(): EngineHooks {
  return {
    sleep: async () => undefined,
    now: () => Date.now(),
    random: () => 0.5,
    logger: () => undefined,
    pauseRequested: () => false,
  };
}

function domainFor(keyword: string): string {
  return keyword.startsWith('alpha') ? 'alpha.com' : 'beta.com';
}

function serpRow(keyword: string): SerpResult {
  const domain = domainFor(keyword);
  return {
    keyword,
    position: 1,
    title: `${keyword} result`,
    url: `https://${domain}/`,
    hostname: domain,
    registrableDomain: domain,
    dr: null,
    drStatus: null,
    resultType: 'organic',
  };
}

function completed(record: KeywordRecord): CollectionResult {
  return {
    record: {
      ...record,
      status: 'completed',
      surfer: {
        volume: 100,
        cpc: 1,
        market: 'US',
        fetchedAt: '2026-09-01T00:00:00.000Z',
      },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: `https://google.com/search?q=${encodeURIComponent(record.normalizedKeyword)}`,
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'ok',
        serpError: null,
      },
      error: null,
    },
    serpRows: [serpRow(record.normalizedKeyword)],
    related: { status: 'empty', error: null, rows: [] },
    debugArtifactPath: null,
  };
}

function transientFailure(record: KeywordRecord): CollectionResult {
  return {
    record: {
      ...record,
      status: 'failed',
      surfer: null,
      google: null,
      error: { code: 'GOOGLE_UNAVAILABLE', message: 'temporary navigation failure' },
    },
    serpRows: [],
    related: { status: 'not_attempted', error: null, rows: [] },
    debugArtifactPath: null,
  };
}

function emptyRelated(): RelatedCollectionResult {
  return {
    related: { status: 'empty', error: null, rows: [] },
    debugArtifactPath: null,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function okAhrefs(domain: string, dr = 50) {
  return {
    domain,
    dr,
    fetchedAt: '2026-09-01T00:00:00.000Z',
    source: 'ahrefs' as const,
    status: 'ok' as const,
    error: null,
  };
}

test('browser lookahead overlaps the next fresh keyword with current serial Ahrefs', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-lookahead-overlap-'));
  const collected: string[] = [];
  const firstAhrefsEntered = deferred();
  const releaseFirstAhrefs = deferred();
  let activeAhrefs = 0;
  let maxActiveAhrefs = 0;

  const ahrefs: AhrefsClient = async (domain) => {
    activeAhrefs += 1;
    maxActiveAhrefs = Math.max(maxActiveAhrefs, activeAhrefs);
    try {
      if (domain === 'alpha.com') {
        firstAhrefsEntered.resolve();
        await releaseFirstAhrefs.promise;
      }
      return okAhrefs(domain);
    } finally {
      activeAhrefs -= 1;
    }
  };

  const runPromise = executeRun({
    store,
    runId: 'lookahead-overlap',
    mode: 'fresh',
    keywords: KEYWORDS,
    config: CONFIG,
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (record) => {
      collected.push(record.normalizedKeyword);
      return completed(record);
    },
    collectRelated: async () => emptyRelated(),
    hooks: hooks(),
    publishSnapshots: async () => undefined,
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
    ahrefs: { apiKey: 'k', client: ahrefs },
  });

  try {
    await firstAhrefsEntered.promise;
    assert.deepEqual(
      collected,
      ['alpha tool', 'beta tool'],
      'beta browser collection must already have started while alpha Ahrefs is blocked',
    );
  } finally {
    releaseFirstAhrefs.resolve();
  }

  const outcome = await runPromise;
  assert.equal(outcome.kind, 'finished');
  assert.equal(maxActiveAhrefs, 1, 'Ahrefs requests must remain strictly serial');
  assert.equal(store.loadRun('lookahead-overlap')?.lookups, 2);
  assert.ok(store.loadSerpRows('lookahead-overlap').every((row) => row.dr === 50));
  store.close();
  cache.close();
});

test('lookahead never issues a primary browser request for a cache-hit next keyword', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-lookahead-hit-'));
  const identity = keywordCacheIdentity(CONFIG);
  const cachedAt = '2026-09-01T00:00:00.000Z';
  const collected: string[] = [];
  const firstAhrefsEntered = deferred();
  const releaseFirstAhrefs = deferred();

  cache.putKeyword({
    cacheKey: buildKeywordCacheKey('beta tool', identity),
    keyword: 'beta tool',
    normalizedKeyword: 'beta tool',
    identity,
    record: {
      id: 'cached-beta',
      keyword: 'beta tool',
      normalizedKeyword: 'beta tool',
      sources: [{ type: 'seed', rowNumbers: [2] }],
      status: 'completed',
      surfer: { volume: 200, cpc: 2, market: 'US', fetchedAt: cachedAt },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=beta+tool',
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'ok',
        serpError: null,
      },
      error: null,
    },
    serpRows: [serpRow('beta tool')],
    collectedAt: cachedAt,
    storedAt: cachedAt,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });

  const ahrefs: AhrefsClient = async (domain) => {
    if (domain === 'alpha.com') {
      firstAhrefsEntered.resolve();
      await releaseFirstAhrefs.promise;
    }
    return okAhrefs(domain);
  };

  const runPromise = executeRun({
    store,
    runId: 'lookahead-cache-hit',
    mode: 'fresh',
    keywords: KEYWORDS,
    config: CONFIG,
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (record) => {
      collected.push(record.normalizedKeyword);
      return completed(record);
    },
    collectRelated: async () => emptyRelated(),
    hooks: hooks(),
    publishSnapshots: async () => undefined,
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
    ahrefs: { apiKey: 'k', client: ahrefs },
  });

  try {
    await firstAhrefsEntered.promise;
    assert.deepEqual(
      collected,
      ['alpha tool'],
      'beta is a primary cache hit and must not be speculatively fetched from Google',
    );
  } finally {
    releaseFirstAhrefs.resolve();
  }

  const outcome = await runPromise;
  assert.equal(outcome.kind, 'finished');
  assert.deepEqual(collected, ['alpha tool']);
  assert.equal(
    store.loadKeywords('lookahead-cache-hit').find((keyword) => keyword.normalizedKeyword === 'beta tool')?.cacheStatus,
    'hit',
  );
  store.close();
  cache.close();
});

test('a transient prefetched result is attempt one and retry accounting is not doubled', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-lookahead-retry-'));
  const attempts = new Map<string, number>();
  const ahrefs: AhrefsClient = async (domain) => okAhrefs(domain);

  const outcome = await executeRun({
    store,
    runId: 'lookahead-retry',
    mode: 'fresh',
    keywords: KEYWORDS,
    config: CONFIG,
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (record) => {
      const attempt = (attempts.get(record.normalizedKeyword) ?? 0) + 1;
      attempts.set(record.normalizedKeyword, attempt);
      if (record.normalizedKeyword === 'beta tool' && attempt === 1) {
        return transientFailure(record);
      }
      return completed(record);
    },
    collectRelated: async () => emptyRelated(),
    hooks: hooks(),
    publishSnapshots: async () => undefined,
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
    ahrefs: { apiKey: 'k', client: ahrefs },
  });

  assert.equal(outcome.kind, 'finished');
  assert.equal(attempts.get('alpha tool'), 1);
  assert.equal(attempts.get('beta tool'), 2, 'prefetched failure must be retried exactly once');
  assert.equal(
    store.loadRun('lookahead-retry')?.lookups,
    3,
    'alpha + beta prefetch + beta retry; consuming prefetch must not increment again',
  );
  assert.equal(
    store.loadKeywords('lookahead-retry').find((keyword) => keyword.normalizedKeyword === 'beta tool')?.status,
    'completed',
  );
  store.close();
  cache.close();
});
