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
