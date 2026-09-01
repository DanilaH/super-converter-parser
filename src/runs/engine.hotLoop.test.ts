import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunStore } from '../db/store.js';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import type { CollectionResult } from '../browser/collect.js';
import { executeRun, type EngineHooks } from './engine.js';
import { createRunId, type KeywordRecord } from './run.js';

function hooks(): EngineHooks {
  return {
    sleep: async () => undefined,
    now: () => Date.now(),
    random: () => 0.5,
    logger: () => undefined,
    pauseRequested: () => false,
  };
}

function completed(keyword: KeywordRecord): CollectionResult {
  const isRoot = !keyword.sources.some((source) => source.type === 'surfer_related');
  return {
    record: {
      ...keyword,
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
        pageUrl: `https://google.com/search?q=${encodeURIComponent(keyword.normalizedKeyword)}`,
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'empty',
        serpError: null,
      },
      error: null,
    },
    serpRows: [],
    related: isRoot
      ? {
          status: 'ok',
          error: null,
          rows: [{
            keyword: `${keyword.keyword} child`,
            normalizedKeyword: `${keyword.normalizedKeyword} child`,
            overlap: 80,
            volume: 50,
          }],
        }
      : { status: 'not_attempted', error: null, rows: [] },
    debugArtifactPath: null,
  };
}

test('executeRun scans keyword rows once while keeping dynamic expansion durable', async () => {
  const store = RunStore.openInMemory();
  const originalLoadKeywords = store.loadKeywords.bind(store);
  let loadKeywordsCalls = 0;
  store.loadKeywords = ((runId: string) => {
    loadKeywordsCalls += 1;
    return originalLoadKeywords(runId);
  }) as typeof store.loadKeywords;

  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-hot-loop-'));
  const keywords = buildSeedKeywords([
    { keyword: 'alpha tool', rowNumber: 1 },
    { keyword: 'beta tool', rowNumber: 2 },
    { keyword: 'gamma tool', rowNumber: 3 },
  ]);
  const base = loadConfig({});
  const config = {
    ...base,
    expansion: {
      ...base.expansion,
      enabled: true,
      depth: 1,
      maxCandidatesPerKeyword: 20,
      minOverlap: 0,
      minVolume: 0,
    },
  };

  try {
    const outcome = await executeRun({
      store,
      runId,
      mode: 'fresh',
      keywords,
      config,
      input: { kind: 'seeds', path: 'input/seeds.csv' },
      runDirectory,
      debugRoot: join(runDirectory, 'debug'),
      collect: async (keyword) => completed(keyword),
      hooks: hooks(),
      publishSnapshots: async () => undefined,
    });

    assert.equal(outcome.kind, 'finished');
    assert.equal(loadKeywordsCalls, 1, 'hot loop must not rescan and JSON-map the whole keyword table');

    const durableKeywords = originalLoadKeywords(runId);
    assert.equal(durableKeywords.length, 6, 'three roots must persist three depth-one expansion children');
    assert.ok(durableKeywords.every((keyword) => keyword.status === 'completed'));
    assert.equal(
      durableKeywords.filter((keyword) => keyword.sources.some((source) => source.type === 'surfer_related')).length,
      3,
    );
  } finally {
    store.close();
  }
});
