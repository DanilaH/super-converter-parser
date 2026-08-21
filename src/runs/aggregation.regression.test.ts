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
import { setRenameForTesting } from './run.js';
import { resolveDrThresholds, aggregate } from '../scoring/scoring.js';
import type { SerpResult } from '../google/serp.js';
import type { AhrefsClient } from '../ahrefs/client.js';
import { ResearchError } from '../shared/errors.js';

const realRename = async (oldPath: string, newPath: string): Promise<void> =>
  (await import('node:fs/promises')).rename(oldPath, newPath);

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
  // The report must source its timestamp from the stored run, not a freshly
  // generated one at render time (proven by r1 === r2 and by emission of the
  // stored updatedAt).
  assert.ok(r1.includes(`Updated: ${run.updatedAt ?? run.createdAt}`));
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
  store.recordDomains('run-reg', 0, 'compare lists', [serp('x', 1, 'a.com', 50, 'ok')], new Map());
  const domains = store.loadDomains('run-reg');
  assert.equal(domains.length, 1);
  assert.equal(domains[0]!.firstSeenKeyword, 'compare lists');
  store.close();
});

// Contract 9 (Block 3): the brand label is the first label of a multi-part
// suffix registrable domain, so "example.co.uk" matches the keyword "example".
test('exact-match uses the multi-part suffix brand label (example.co.uk -> example)', () => {
  const rows = [serp('example', 1, 'example.co.uk', 50, 'ok')];
  const agg = aggregate(
    { keyword: 'example', normalizedKeyword: 'example', surfer: null, serpRows: rows },
    { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
  );
  assert.equal(agg.exactMatchDomainCount, 1);
  assert.equal(agg.nicheDomainCount, 0, 'exact-match domain is excluded from niche');
});

// Contract 10 (Block 3): a domain that is an exact match must not also count as
// a niche signal for the same keyword.
test('an exact-match domain is excluded from the niche heuristic', () => {
  const rows = [serp('compare lists', 1, 'comparelists.com', 50, 'ok')];
  const agg = aggregate(
    { keyword: 'compare lists', normalizedKeyword: 'comparelists', surfer: null, serpRows: rows },
    { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
  );
  assert.equal(agg.exactMatchDomainCount, 1);
  assert.equal(agg.nicheDomainCount, 0);
});

// Contract 11 (Block 3): non-exact domains containing a >=4-char keyword token
// still count as niche signals.
test('niche heuristic still counts non-exact domains containing a keyword token', () => {
  const rows = [serp('compare lists', 1, 'comparetools.com', 50, 'ok')];
  const agg = aggregate(
    { keyword: 'compare lists', normalizedKeyword: 'comparelists', surfer: null, serpRows: rows },
    { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
  );
  assert.equal(agg.exactMatchDomainCount, 0);
  assert.equal(agg.nicheDomainCount, 1);
});

// Contract 12 (Block 2): a cached Ahrefs error keeps its code and cache
// provenance, and the error code is preserved on the row (not only fresh ones).
test('cached Ahrefs error preserves its code and cache provenance', async () => {
  const cache = CacheStore.openInMemory();
  const storedAt = '2026-01-01T00:00:00.000Z';
  const expiresAt = '2099-01-01T00:00:00.000Z';
  cache.putDomain('a.com', { dr: null, status: 'error', error: 'AHREFS_429' }, storedAt, Date.parse(expiresAt) - Date.parse(storedAt));
  // ahrefs must be present so the cache branch runs; it must NOT be consulted on a hit.
  const ahrefs: AhrefsClient = async () => {
    throw new ResearchError('AHREFS_ERROR', 'should not be called on a cache hit');
  };
  const serpRows = [serp('k', 1, 'a.com', null, null)];
  const sourceByDomain = await applyDomainRatings({
    serpRows,
    ahrefs,
    domainCache: cache,
    config: CONFIG,
    now: () => Date.parse(storedAt),
    sleep: async () => undefined,
    logger: () => undefined,
  });
  assert.equal(serpRows[0]!.drStatus, 'error');
  assert.equal(serpRows[0]!.drError, 'AHREFS_429', 'cached error code preserved on the row');

  const store = makeStore();
  store.recordDomains('run-reg', 0, 'k', serpRows, sourceByDomain);
  const domains = store.loadDomains('run-reg');
  assert.equal(domains.length, 1);
  assert.equal(domains[0]!.status, 'error');
  assert.equal(domains[0]!.error, 'AHREFS_429', 'cached error code persisted to the domains table');
  assert.equal(domains[0]!.source, 'cache', 'provenance records the cache source');
  store.close();
});

// Contract 13 (Block 2): a fresh domain record is never downgraded to 'cache'
// when the same domain is later seen on a cache-hit run; its source and error
// provenance are preserved while DR still updates to the latest value.
test('a fresh domain record is not overwritten by a later cache-hit of the same domain', () => {
  const store = makeStore();
  const fresh = new Map<string, { source: 'cache' | 'fresh'; fetchedAt: string }>([
    ['a.com', { source: 'fresh', fetchedAt: '2026-01-01T00:00:00.000Z' }],
  ]);
  store.recordDomains(
    'run-reg',
    0,
    'k0',
    [{ registrableDomain: 'a.com', dr: 50, drStatus: 'ok', position: 2, drError: 'FRESH_ERR' }],
    fresh,
  );
  const cache = new Map<string, { source: 'cache' | 'fresh'; fetchedAt: string }>([
    ['a.com', { source: 'cache', fetchedAt: '2026-02-01T00:00:00.000Z' }],
  ]);
  store.recordDomains(
    'run-reg',
    1,
    'k1',
    [{ registrableDomain: 'a.com', dr: 90, drStatus: 'ok', position: 1, drError: 'CACHE_ERR' }],
    cache,
  );
  const domains = store.loadDomains('run-reg');
  assert.equal(domains.length, 1);
  assert.equal(domains[0]!.source, 'fresh', 'fresh source preserved over a later cache-hit');
  assert.equal(domains[0]!.error, 'FRESH_ERR', 'fresh error preserved over a later cache-hit');
  assert.equal(domains[0]!.dr, 90, 'DR still updates to the latest value');
  store.close();
});

// Contract 13b (Block 2 fix): a fresh Ahrefs lookup that returns an error
// without throwing still records the returned error code and fresh provenance.
test('a fresh non-throwing Ahrefs error keeps its returned code and fresh provenance', async () => {
  const ahrefs: AhrefsClient = async () => ({
    domain: 'a.com',
    dr: null,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    source: 'ahrefs',
    status: 'error',
    error: 'AHREFS_503',
  });
  const cache = CacheStore.openInMemory();
  const serpRows = [serp('k', 1, 'a.com', null, null)];
  const sourceByDomain = await applyDomainRatings({
    serpRows,
    ahrefs,
    domainCache: cache,
    config: CONFIG,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    sleep: async () => undefined,
    logger: () => undefined,
  });
  assert.equal(serpRows[0]!.drStatus, 'error');
  assert.equal(serpRows[0]!.drError, 'AHREFS_503', 'fresh returned error code preserved on the row');

  const store = makeStore();
  store.recordDomains('run-reg', 0, 'k', serpRows, sourceByDomain);
  const domains = store.loadDomains('run-reg');
  assert.equal(domains.length, 1);
  assert.equal(domains[0]!.status, 'error');
  assert.equal(domains[0]!.error, 'AHREFS_503', 'fresh returned error persisted to the domains table');
  assert.equal(domains[0]!.source, 'fresh');
  store.close();
});

// Contract 13c (Block 2 fix): when one cached-error domain repeats within a
// single SERP, every occurrence inherits the cached error code (not just the
// first lookup).
test('a repeated cached-error domain in one SERP keeps the error on every row', async () => {
  const cache = CacheStore.openInMemory();
  const storedAt = '2026-01-01T00:00:00.000Z';
  const expiresAt = '2099-01-01T00:00:00.000Z';
  cache.putDomain('a.com', { dr: null, status: 'error', error: 'AHREFS_429' }, storedAt, Date.parse(expiresAt) - Date.parse(storedAt));
  // ahrefs present but never consulted (cache hit): must not throw.
  const ahrefs: AhrefsClient = async () => {
    throw new ResearchError('AHREFS_ERROR', 'should not be called on a cache hit');
  };
  const serpRows = [
    serp('k', 1, 'a.com', null, null),
    serp('k', 3, 'a.com', null, null),
  ];
  const sourceByDomain = await applyDomainRatings({
    serpRows,
    ahrefs,
    domainCache: cache,
    config: CONFIG,
    now: () => Date.parse(storedAt),
    sleep: async () => undefined,
    logger: () => undefined,
  });
  assert.equal(serpRows.length, 2);
  assert.equal(serpRows[0]!.drStatus, 'error');
  assert.equal(serpRows[0]!.drError, 'AHREFS_429', 'first occurrence gets cached error');
  assert.equal(serpRows[1]!.drStatus, 'error');
  assert.equal(serpRows[1]!.drError, 'AHREFS_429', 'repeated occurrence inherits the cached error');
});

// Contract 14 (Block 1): the manifest is the final artifact; status.json is
// published first and the manifest is produced last.
test('writeSnapshots publishes both status.json and manifest.json (manifest-last)', async () => {
  const store = makeStore();
  const runId = 'run-reg';
  const stored = store.loadKeywords(runId) as StoredKeyword[];
  store.commitKeyword(
    runId,
    {
      ...stored[0]!,
      status: 'completed',
      surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: { hl: 'en', gl: 'us', pageUrl: 'u', detectedLocation: null, geoWarning: false },
      error: null,
      collectedAt: '2026-01-01T00:00:00.000Z',
    },
    [serp('compare lists', 1, 'a.com', 80, 'ok')],
  );
  store.setRunState(runId, 'completed');
  const runDirectory = await mkdtemp(join(tmpdir(), 'reg-mani-'));
  setRenameForTesting(realRename);
  try {
    await writeSnapshots(store, runId, runDirectory, 'completed');
  } finally {
    setRenameForTesting(realRename);
  }
  const statusRaw = await readFile(join(runDirectory, 'status.json'), 'utf8');
  const manifestRaw = await readFile(join(runDirectory, 'manifest.json'), 'utf8');
  assert.equal(JSON.parse(statusRaw).status, 'completed');
  assert.equal(JSON.parse(manifestRaw).state, 'completed');
  store.close();
});

// Contract 15 (Block 1): if the manifest write fails, status.json is removed so
// a false terminal run state is never left behind.
test('a manifest write failure removes status.json so no false terminal state is left', async () => {
  const store = makeStore();
  const runId = 'run-reg';
  const stored = store.loadKeywords(runId) as StoredKeyword[];
  store.commitKeyword(
    runId,
    {
      ...stored[0]!,
      status: 'completed',
      surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: { hl: 'en', gl: 'us', pageUrl: 'u', detectedLocation: null, geoWarning: false },
      error: null,
      collectedAt: '2026-01-01T00:00:00.000Z',
    },
    [serp('compare lists', 1, 'a.com', 80, 'ok')],
  );
  store.setRunState(runId, 'completed');
  const runDirectory = await mkdtemp(join(tmpdir(), 'reg-manifail-'));
  const statusPath = join(runDirectory, 'status.json');
  setRenameForTesting(async (oldPath, newPath) => {
    if (newPath.endsWith('manifest.json')) {
      throw new ResearchError('OUTPUT_WRITE_ERROR', 'forced manifest failure');
    }
    await realRename(oldPath, newPath);
  });
  let threw = false;
  try {
    await writeSnapshots(store, runId, runDirectory, 'completed');
  } catch {
    threw = true;
  } finally {
    setRenameForTesting(realRename);
  }
  assert.ok(threw, 'manifest failure surfaces');
  let statusExists = true;
  try {
    await readFile(statusPath, 'utf8');
  } catch {
    statusExists = false;
  }
  assert.equal(statusExists, false, 'status.json cleaned up; no false terminal state');
  store.close();
});
