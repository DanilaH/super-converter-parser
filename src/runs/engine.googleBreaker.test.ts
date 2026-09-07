import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CollectionResult } from '../browser/collect.js';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
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

function googleUnavailable(keyword: KeywordRecord): CollectionResult {
  const error = {
    code: 'GOOGLE_UNAVAILABLE' as const,
    message: 'fixture navigation unavailable',
  };
  return {
    record: {
      ...keyword,
      status: 'failed',
      surfer: null,
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: '',
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'fetch_error',
        serpError: error,
      },
      error,
    },
    serpRows: [],
    related: { status: 'not_attempted', error: null, rows: [] },
    debugArtifactPath: null,
  };
}

test('executeRun pauses before fan-out after consecutive keywords exhaust Google availability retries', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-google-breaker-'));
  const keywords = buildSeedKeywords([
    { keyword: 'alpha tool', rowNumber: 1 },
    { keyword: 'beta tool', rowNumber: 2 },
    { keyword: 'gamma tool', rowNumber: 3 },
  ]);
  const base = loadConfig({});
  const config = {
    ...base,
    retry: {
      ...base.retry,
      maxAttempts: 3,
    },
    circuitBreaker: {
      ...base.circuitBreaker,
      googleConsecutiveThreshold: 2,
    },
  };
  let collectCalls = 0;

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
      collect: async (keyword) => {
        collectCalls += 1;
        return googleUnavailable(keyword);
      },
      hooks: hooks(),
      publishSnapshots: async () => undefined,
    });

    assert.equal(outcome.kind, 'paused');
    if (outcome.kind !== 'paused') return;
    assert.match(outcome.reason, /2 consecutive Google collection failures/);
    assert.equal(collectCalls, 6, 'two keywords should each exhaust three transient attempts before the breaker pauses');

    const persisted = store.loadKeywords(runId);
    assert.deepEqual(
      persisted.map((keyword) => keyword.status),
      ['failed', 'failed', 'pending'],
      'the third keyword must remain untouched and resumable instead of repeating the outage fan-out',
    );
    assert.equal(store.loadRun(runId)?.state, 'paused');
  } finally {
    store.close();
  }
});
