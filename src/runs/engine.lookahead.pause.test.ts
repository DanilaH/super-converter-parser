import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AhrefsClient } from '../ahrefs/client.js';
import type { CollectionResult, RelatedCollectionResult } from '../browser/collect.js';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import type { SerpResult } from '../google/serp.js';
import { executeRun, type EngineHooks } from './engine.js';
import type { KeywordRecord } from './run.js';

const CONFIG = loadConfig({});
const KEYWORDS = buildSeedKeywords([
  { keyword: 'alpha tool', rowNumber: 1 },
  { keyword: 'beta tool', rowNumber: 2 },
]);
const INPUT = { kind: 'seeds' as const, path: 'input/seeds.csv' };

function resultFor(record: KeywordRecord): CollectionResult {
  const domain = record.normalizedKeyword.startsWith('alpha') ? 'alpha.com' : 'beta.com';
  const row: SerpResult = {
    keyword: record.normalizedKeyword,
    position: 1,
    title: `${record.normalizedKeyword} result`,
    url: `https://${domain}/`,
    hostname: domain,
    registrableDomain: domain,
    dr: null,
    drStatus: null,
    resultType: 'organic',
  };
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
    serpRows: [row],
    related: { status: 'empty', error: null, rows: [] },
    debugArtifactPath: null,
  };
}

function emptyRelated(): RelatedCollectionResult {
  return {
    related: { status: 'empty', error: null, rows: [] },
    debugArtifactPath: null,
  };
}

test('pause discards completed lookahead evidence and resume recollects the pending keyword', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-lookahead-pause-'));
  let pauseRequested = false;
  const collected: string[] = [];

  const hooks: EngineHooks = {
    sleep: async () => undefined,
    now: () => Date.now(),
    random: () => 0.5,
    logger: () => undefined,
    pauseRequested: () => pauseRequested,
  };

  const ahrefs: AhrefsClient = async (domain) => {
    if (domain === 'alpha.com') pauseRequested = true;
    return {
      domain,
      dr: 50,
      fetchedAt: '2026-09-01T00:00:00.000Z',
      source: 'ahrefs',
      status: 'ok',
      error: null,
    };
  };

  const collect = async (record: KeywordRecord): Promise<CollectionResult> => {
    collected.push(record.normalizedKeyword);
    return resultFor(record);
  };

  const first = await executeRun({
    store,
    runId: 'lookahead-pause',
    mode: 'fresh',
    keywords: KEYWORDS,
    config: CONFIG,
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect,
    collectRelated: async () => emptyRelated(),
    hooks,
    publishSnapshots: async () => undefined,
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
    ahrefs: { apiKey: 'k', client: ahrefs },
  });

  assert.equal(first.kind, 'paused');
  assert.deepEqual(
    collected,
    ['alpha tool', 'beta tool'],
    'beta browser evidence may finish speculatively before the pause is observed',
  );
  const afterPause = store.loadKeywords('lookahead-pause');
  assert.equal(afterPause.find((keyword) => keyword.normalizedKeyword === 'alpha tool')?.status, 'completed');
  assert.equal(
    afterPause.find((keyword) => keyword.normalizedKeyword === 'beta tool')?.status,
    'pending',
    'prefetched beta evidence must not be persisted before its normal execution turn',
  );
  assert.equal(store.loadRun('lookahead-pause')?.lookups, 2, 'both real browser attempts remain honestly counted');

  pauseRequested = false;
  const second = await executeRun({
    store,
    runId: 'lookahead-pause',
    mode: 'resume',
    keywords: KEYWORDS,
    config: CONFIG,
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect,
    collectRelated: async () => emptyRelated(),
    hooks,
    publishSnapshots: async () => undefined,
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
    ahrefs: { apiKey: 'k', client: ahrefs },
  });

  assert.equal(second.kind, 'finished');
  assert.deepEqual(
    collected,
    ['alpha tool', 'beta tool', 'beta tool'],
    'resume must recollect the discarded speculative beta request rather than treating it as durable evidence',
  );
  assert.ok(store.loadKeywords('lookahead-pause').every((keyword) => keyword.status === 'completed'));
  assert.equal(store.loadRun('lookahead-pause')?.lookups, 3);

  store.close();
  cache.close();
});
