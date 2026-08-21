import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore, type StoredKeyword, type StoredRun } from '../db/store.js';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { createRunId, type RunState } from './run.js';
import { writeSnapshots, renderReportMd } from './snapshots.js';
import { applyDomainRatings, executeRun, type EngineHooks, type CollectKeywordFn } from './engine.js';
import { resolveDrThresholds, aggregate } from '../scoring/scoring.js';
import type { SerpResult } from '../google/serp.js';
import type { AhrefsClient } from '../ahrefs/client.js';
import { ResearchError } from '../shared/errors.js';

const CONFIG = loadConfig({});
const INPUT = { kind: 'seeds' as const, path: 'input/seeds.csv' };
const KEYWORDS: SeedKeyword[] = buildSeedKeywords([
  { keyword: 'compare lists', rowNumber: 1 },
  { keyword: 'best office chairs', rowNumber: 2 },
]);

function serp(keyword: string, position: number, domain: string, dr: number | null, drStatus: SerpResult['drStatus']): SerpResult {
  return {
    keyword,
    position,
    title: 't',
    url: `https://${domain}/${position}`,
    hostname: domain,
    registrableDomain: domain,
    dr,
    drStatus,
    resultType: 'organic',
  };
}

function makeHooks(): EngineHooks {
  return {
    sleep: async () => undefined,
    now: () => Date.now(),
    random: () => 0.5,
    logger: () => undefined,
    pauseRequested: () => false,
  };
}

function makeStore(runId = 'run-reg'): RunStore {
  const store = RunStore.openInMemory();
  store.createRun({
    runId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.2.0' },
    input: INPUT,
    keywords: KEYWORDS,
  });
  return store;
}

// Contract 1: legacy configSnapshot without a scoring section must not throw and
// must fall back to the documented default DR thresholds.
test('legacy configSnapshot without scoring still produces candidates', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const legacy = JSON.parse(JSON.stringify(CONFIG)) as Record<string, unknown>;
  delete legacy.scoring;
  store.createRun({
    runId,
    configSnapshot: legacy as never,
    parserVersions: { surfer: '1.0.0', google: '1.2.0' },
    input: INPUT,
    keywords: KEYWORDS,
  });
  const stored = store.loadKeywords(runId) as StoredKeyword[];
  store.commitKeyword(
    runId,
    {
      ...stored[0]!,
      status: 'completed',
      surfer: { volume: 1000, cpc: 1, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: { hl: 'en', gl: 'us', pageUrl: 'u', detectedLocation: null, geoWarning: false },
      error: null,
      collectedAt: '2026-01-01T00:00:00.000Z',
    },
    [serp('compare lists', 1, 'a.com', 80, 'ok')],
  );
  store.setRunState(runId, 'completed');

  const runDirectory = await mkdtemp(join(tmpdir(), 'reg-legacy-'));
  // Must not throw on the legacy snapshot.
  await writeSnapshots(store, runId, runDirectory, 'completed');

  const candidates = (await readFile(join(runDirectory, 'candidates.csv'), 'utf8')).slice(1).split('\r\n');
  assert.ok(candidates.some((line) => line.startsWith('compare lists,')), 'candidate row emitted');
  assert.ok(candidates[0]!.includes('score'), 'scored with default thresholds');
  store.close();
});

test('resolveDrThresholds falls back to defaults for legacy/empty snapshots', () => {
  assert.deepEqual(resolveDrThresholds(null), { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 });
  assert.deepEqual(resolveDrThresholds({}), { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 });
  assert.deepEqual(resolveDrThresholds({ scoring: {} }), { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 });
  assert.deepEqual(resolveDrThresholds({ scoring: { drThresholds: { veryWeakMax: 5 } } }), {
    veryWeakMax: 5,
    weakMax: 30,
    strongMin: 60,
    strongMax: 75,
  });
});

// Contract 2: when Ahrefs is skipped, every observed domain is still persisted
// (status 'not_attempted', source 'none') rather than dropped.
test('observed domains are persisted even when Ahrefs enrichment is skipped', async () => {
  const serpRows = [serp('k', 1, 'a.com', null, null), serp('k', 2, 'b.com', null, null)];
  await applyDomainRatings({
    serpRows,
    ahrefs: null,
    domainCache: null,
    config: CONFIG,
    now: () => Date.now(),
    sleep: async () => undefined,
    logger: () => undefined,
  });
  assert.equal(serpRows[0]!.drStatus, 'not_attempted');
  assert.equal(serpRows[1]!.drStatus, 'not_attempted');

  const store = makeStore();
  store.recordDomains('run-reg', 0, 'k', serpRows, new Map());
  const domains = store.loadDomains('run-reg');
  assert.equal(domains.length, 2);
  assert.ok(domains.every((d) => d.status === 'not_attempted' && d.source === 'none'));
  store.close();
});

// Contract 3: a failed Ahrefs lookup keeps its error code and source provenance.
test('domain error and source provenance are preserved', async () => {
  const ahrefs: AhrefsClient = async () => {
    throw new ResearchError('AHREFS_ERROR', 'boom');
  };
  const cache = CacheStore.openInMemory();
  const serpRows = [serp('k', 1, 'a.com', null, null)];
  const sourceByDomain = await applyDomainRatings({
    serpRows,
    ahrefs,
    domainCache: cache,
    config: CONFIG,
    now: () => Date.now(),
    sleep: async () => undefined,
    logger: () => undefined,
  });
  assert.equal(serpRows[0]!.drStatus, 'error');
  assert.equal(serpRows[0]!.drError, 'AHREFS_ERROR');

  const store = makeStore();
  store.recordDomains('run-reg', 0, 'k', serpRows, sourceByDomain);
  const domains = store.loadDomains('run-reg');
  assert.equal(domains.length, 1);
  assert.equal(domains[0]!.status, 'error');
  assert.equal(domains[0]!.error, 'AHREFS_ERROR');
  assert.equal(domains[0]!.source, 'fresh');
  store.close();
});

// Contract 4: exact-match uses the registrable domain label without its TLD.
test('exact-match uses the registrable domain label without the TLD suffix', () => {
  const rows = [
    serp('example', 1, 'example.com', 50, 'ok'),
    serp('example', 2, 'example.org', 50, 'ok'),
  ];
  const agg = aggregate({ keyword: 'example', normalizedKeyword: 'example', surfer: null, serpRows: rows }, { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 });
  // "example.com" and "example.org" both reduce to the label "example".
  assert.equal(agg.exactMatchDomainCount, 2);
  const unrelated = [
    serp('compare lists', 1, 'comparetools.com', 50, 'ok'),
  ];
  const agg2 = aggregate({ keyword: 'compare lists', normalizedKeyword: 'comparelists', surfer: null, serpRows: unrelated }, { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 });
  assert.equal(agg2.exactMatchDomainCount, 0);
});

// Contract 5: status.json exposes candidateReport pointing at candidates.csv.
test('status.json exposes candidateReport', async () => {
  const store = makeStore();
  const runId = 'run-reg';
  const stored = store.loadKeywords(runId) as StoredKeyword[];
  store.commitKeyword(
    runId,
    { ...stored[0]!, status: 'completed', surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' }, google: { hl: 'en', gl: 'us', pageUrl: 'u', detectedLocation: null, geoWarning: false }, error: null, collectedAt: '2026-01-01T00:00:00.000Z' },
    [serp('compare lists', 1, 'a.com', 80, 'ok')],
  );
  store.setRunState(runId, 'completed');
  const runDirectory = await mkdtemp(join(tmpdir(), 'reg-cand-'));
  await writeSnapshots(store, runId, runDirectory, 'completed');
  const status = JSON.parse(await readFile(join(runDirectory, 'status.json'), 'utf8'));
  assert.ok(typeof status.candidateReport === 'string');
  assert.ok(status.candidateReport.endsWith('candidates.csv'));
  store.close();
});

// Contract 6: the report is deterministic (no freshly generated timestamp) and
// reflects the target state passed in.
test('report is deterministic and shows the target state', () => {
  const store = makeStore();
  const run = store.loadRun('run-reg') as StoredRun;
  const keywords = store.loadKeywords('run-reg');
  const ctx = {
    state: 'completed' as RunState,
    run,
    keywords,
    candidates: [],
    relatedKeywords: [],
    domains: [],
    progress: { completed: 0, partial: 0, failed: 0, errors: 0 },
    cacheStats: { hits: 0, misses: 0, expired: 0, refreshed: 0 },
    uniqueDomains: 0,
    completedDomains: 0,
  };
  const r1 = renderReportMd(ctx);
  const r2 = renderReportMd(ctx);
  assert.equal(r1, r2, 'deterministic: no generated timestamp');
  assert.ok(r1.includes('State: **completed**'));
  assert.ok(!r1.includes('Updated: ' + new Date().toISOString()));
  store.close();
});

// Contract 7: if publishing (manifest) fails, the run is never marked terminal,
// so no false terminal status.json is emitted.
test('a publishing failure does not produce a false terminal run state', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  store.createRun({ runId, configSnapshot: CONFIG, parserVersions: { surfer: '1.0.0', google: '1.2.0' }, input: INPUT, keywords: KEYWORDS });
  const dir = await mkdtemp(join(tmpdir(), 'reg-pub-'));
  const runDirectory = join(dir, 'run');
  const debugRoot = join(dir, 'debug');
  await import('node:fs/promises').then((fs) => fs.mkdir(runDirectory, { recursive: true }));
  await import('node:fs/promises').then((fs) => fs.mkdir(debugRoot, { recursive: true }));

  const collect: CollectKeywordFn = async (record) => ({
    record: {
      ...record,
      status: 'completed',
      surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: { hl: 'en', gl: 'us', pageUrl: 'u', detectedLocation: null, geoWarning: false },
      error: null,
    },
    serpRows: [serp(record.normalizedKeyword, 1, 'a.com', 80, 'ok')],
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  });

  let threw = false;
  try {
    await executeRun({
      store,
      runId,
      mode: 'fresh',
      keywords: KEYWORDS,
      config: CONFIG,
      input: INPUT,
      runDirectory,
      debugRoot,
      collect,
      hooks: makeHooks(),
      publishSnapshots: async () => {
        throw new Error('manifest publication failed');
      },
    });
  } catch {
    threw = true;
  }
  assert.ok(threw, 'executeRun surfaces the publishing error');
  const state = store.loadRun(runId)?.state;
  assert.notEqual(state, 'completed');
  assert.notEqual(state, 'completed_with_errors');
  assert.notEqual(state, 'paused');
  store.close();
});

// Contract 8: the domains output carries the real first-seen keyword text.
test('domains output carries the real first-seen keyword', () => {
  const store = makeStore();
  store.recordDomains('run-reg', 0, 'compare lists', [serp('k', 1, 'a.com', 50, 'ok')], new Map());
  const domains = store.loadDomains('run-reg');
  assert.equal(domains.length, 1);
  assert.equal(domains[0]!.firstSeenKeyword, 'compare lists');
  store.close();
});
