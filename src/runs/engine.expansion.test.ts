import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { loadConfig, type ResearchConfig } from '../config/config.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { executeRun, type EngineHooks } from './engine.js';
import { createRunId, type KeywordRecord } from './run.js';
import type { CollectionResult } from '../browser/collect.js';
import type { SerpResult } from '../google/serp.js';
import { CacheStore } from '../cache/store.js';
import { keywordCacheIdentity, buildKeywordCacheKey, buildRelatedCacheKey } from '../cache/keys.js';

const BASE_CONFIG = loadConfig({});
const INPUT = { kind: 'seeds' as const, path: 'input/seeds.csv' };
const KEYWORDS: SeedKeyword[] = buildSeedKeywords([{ keyword: 'compare lists', rowNumber: 1 }]);

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

const GOOGLE_META = {
  hl: 'en',
  gl: 'us',
  pageUrl: 'https://google.com/search?q=x',
  detectedLocation: null,
  geoWarning: false,
};

function relatedResult(keyword: KeywordRecord, related: CollectionResult['related']): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: { volume: 100, cpc: 1.5, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: { ...GOOGLE_META },
      error: null,
    },
    serpRows: serpRowsFor(keyword.normalizedKeyword, 2),
    debugArtifactPath: null,
    related,
  };
}

function expansionConfig(overrides: Partial<ResearchConfig['expansion']>): ResearchConfig {
  return {
    ...BASE_CONFIG,
    expansion: {
      enabled: true,
      depth: 1,
      maxCandidatesPerKeyword: 20,
      minOverlap: 0,
      minVolume: 0,
      ...overrides,
    },
  };
}

test('expansion adds related candidates and skips the duplicated seed', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-expand-'));

  await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: expansionConfig({}),
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (keyword) =>
      relatedResult(keyword, [
        { keyword: 'list comparison', normalizedKeyword: 'list comparison', volume: 5000, overlap: 0.8 },
        { keyword: 'compare two lists', normalizedKeyword: 'compare two lists', volume: 200, overlap: null },
        { keyword: 'compare lists', normalizedKeyword: 'compare lists', volume: 100, overlap: null },
      ]),
    hooks: makeHooks(),
  });

  const keywords = store.loadKeywords(runId);
  // original seed + 2 unique related (the third is the seed itself, skipped)
  assert.equal(keywords.length, 3);
  const related = keywords.filter((k) =>
    k.sources.some((s) => s.type === 'surfer_related'),
  );
  assert.equal(related.length, 2);
  assert.ok(
    related.every((k) =>
      k.sources.some((s) => s.type === 'surfer_related' && s.parentKeyword === 'compare lists'),
    ),
  );
  store.close();
});

test('expansion is skipped when disabled', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-expand-off-'));

  await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: expansionConfig({ enabled: false }),
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (keyword) =>
      relatedResult(keyword, [
        { keyword: 'list comparison', normalizedKeyword: 'list comparison', volume: 5000, overlap: 0.8 },
      ]),
    hooks: makeHooks(),
  });

  assert.equal(store.loadKeywords(runId).length, 1);
  store.close();
});

test('expansion respects maxCandidatesPerKeyword and minVolume', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-expand-limit-'));

  await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: expansionConfig({ maxCandidatesPerKeyword: 1, minVolume: 1000 }),
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (keyword) =>
      relatedResult(keyword, [
        { keyword: 'low volume', normalizedKeyword: 'low volume', volume: 50, overlap: null },
        { keyword: 'high volume', normalizedKeyword: 'high volume', volume: 5000, overlap: null },
      ]),
    hooks: makeHooks(),
  });

  const related = store
    .loadKeywords(runId)
    .filter((k) => k.sources.some((s) => s.type === 'surfer_related'));
  // minVolume 1000 drops "low volume"; maxCandidates 1 keeps only the first passing
  assert.equal(related.length, 1);
  assert.equal(related[0]!.keyword, 'high volume');
  store.close();
});

test('expansion candidates are collected within the same run (dynamic queue)', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-expand-queue-'));
  const collected: string[] = [];

  await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: expansionConfig({}),
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (keyword) => {
      collected.push(keyword.normalizedKeyword);
      // The seed yields one related candidate; the candidate itself must be
      // collected by the same run (not left pending).
      return relatedResult(keyword, [
        { keyword: 'list comparison', normalizedKeyword: 'list comparison', volume: 5000, overlap: 80 },
      ]);
    },
    hooks: makeHooks(),
  });

  const keywords = store.loadKeywords(runId);
  assert.equal(keywords.length, 2);
  // Both the seed and the related candidate finished in one pass.
  assert.ok(keywords.every((k) => k.status === 'completed'));
  assert.deepEqual([...collected].sort(), ['compare lists', 'list comparison']);
  store.close();
});

test('warm cache hit expands from the related cache without the browser', async () => {
  const cacheStore = CacheStore.openInMemory();
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-expand-warm-'));
  const identity = keywordCacheIdentity(expansionConfig({}));
  const storedAt = '2026-01-01T00:00:00.000Z';
  const collected: string[] = [];

  // Seed and its related candidate are both cached as completed hits.
  for (const normalized of ['compare lists', 'list comparison']) {
    cacheStore.putKeyword({
      cacheKey: buildKeywordCacheKey(normalized, identity),
      keyword: normalized,
      normalizedKeyword: normalized,
      identity,
      record: {
        id: `kw-${normalized}`,
        keyword: normalized,
        normalizedKeyword: normalized,
        sources: [{ type: 'seed', rowNumbers: [1] }],
        status: 'completed',
        surfer: { volume: 100, cpc: 1.5, market: 'US', fetchedAt: storedAt },
        google: { ...GOOGLE_META },
        error: null,
      },
      serpRows: serpRowsFor(normalized, 2),
      collectedAt: storedAt,
      storedAt,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  }
  // The seed's related list is cached (ok) so expansion needs no browser.
  cacheStore.putRelated(
    {
      cacheKey: buildRelatedCacheKey('compare lists', identity),
      normalizedKeyword: 'compare lists',
      identity,
      status: 'ok',
      error: null,
      rows: [{ relatedKeyword: 'list comparison', overlap: 80, volume: 5000 }],
    },
    storedAt,
    7 * 24 * 60 * 60 * 1000,
  );

  await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: expansionConfig({}),
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (keyword) => {
      collected.push(keyword.normalizedKeyword);
      return relatedResult(keyword, []);
    },
    hooks: makeHooks(),
    cache: { store: cacheStore, forceRefresh: false, refreshKeywords: new Set(), resolutions: new Map() },
  });

  // No keyword was collected: both served from cache, expansion from related cache.
  assert.deepEqual(collected, []);
  const keywords = store.loadKeywords(runId);
  assert.equal(keywords.length, 2);
  assert.ok(
    keywords.some((k) =>
      k.sources.some((s) => s.type === 'surfer_related' && s.parentKeyword === 'compare lists'),
    ),
  );
  store.close();
  cacheStore.close();
});

// Live acceptance: the real Surfer extension renders the related-keywords widget
// inside an assets.keywordsur.fr iframe. This requires a connected Research
// Chrome with the extension injected and cannot run in CI; perform it manually
// against the spike page and confirm the table rows parse as Keyword | Overlap
// | Volume with overlap stored as 0..100.
test.skip('live acceptance: real Surfer iframe related-keywords table parses', () => {
  throw new Error('manual acceptance only');
});
