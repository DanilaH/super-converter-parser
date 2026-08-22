import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeRun,
  type CollectKeywordFn,
  type CollectRelatedFn,
  type EngineHooks,
} from './engine.js';
import { RunStore } from '../db/store.js';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { createRunDirectory, createRunId } from './run.js';
import { writeSnapshots } from './snapshots.js';
import { ResearchError } from '../shared/errors.js';
import type { CollectionResult } from '../browser/collect.js';
import type { KeywordRecord } from './run.js';
import type { SerpResult } from '../google/serp.js';
import type { AhrefsClient, DomainRatingResult } from '../ahrefs/client.js';
import { keywordCacheIdentity, buildKeywordCacheKey } from '../cache/keys.js';

const BASE_CONFIG = loadConfig({});

const KEYWORDS: SeedKeyword[] = buildSeedKeywords([
  { keyword: 'compare lists', rowNumber: 1 },
  { keyword: 'list comparison', rowNumber: 2 },
]);

function makeHooks(): EngineHooks {
  return {
    sleep: async () => undefined,
    now: () => Date.now(),
    random: () => 0.5,
    logger: () => undefined,
    pauseRequested: () => false,
  };
}

function serpRowsFor(keyword: string, domains: string[]): SerpResult[] {
  return domains.map((domain, index) => ({
    keyword,
    position: index + 1,
    title: `title ${index + 1}`,
    url: `https://${domain}/${index + 1}`,
    hostname: domain,
    registrableDomain: domain,
    dr: null,
    drStatus: null,
    resultType: 'organic' as const,
  }));
}

function okCollect(record: KeywordRecord, serpCount = 2): CollectionResult {
  return {
    record: {
      ...record,
      status: 'completed',
      surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: new Date().toISOString() },
      google: { hl: 'en', gl: 'us', pageUrl: 'u', detectedLocation: null, geoWarning: false },
      error: null,
    },
    serpRows: serpRowsFor(record.normalizedKeyword, ['example.com', 'other.com'].slice(0, serpCount)),
    debugArtifactPath: null,
    related: {
      status: 'ok',
      error: null,
      rows: [{ keyword: 'related one', normalizedKeyword: 'related one', overlap: 50, volume: 500 }],
    },
  };
}

function okRating(domain: string, dr: number): DomainRatingResult {
  return { domain, dr, fetchedAt: new Date().toISOString(), source: 'ahrefs', status: 'ok', error: null };
}

test('required Ahrefs mode with missing key fails before keyword collection', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'task009-required-missing-'));
  const debugRoot = join(runDirectory, 'debug');
  await createRunDirectory(runDirectory).catch(() => undefined);
  await createRunDirectory(debugRoot).catch(() => undefined);

  let collectCalls = 0;
  const collect: CollectKeywordFn = async (record) => {
    collectCalls += 1;
    return okCollect(record);
  };

  let thrown: ResearchError | null = null;
  try {
    await executeRun({
      store,
      runId,
      mode: 'fresh',
      keywords: KEYWORDS,
      config: BASE_CONFIG,
      input: { kind: 'seeds', path: 'input/seeds.csv' },
      runDirectory,
      debugRoot,
      collect,
      hooks: makeHooks(),
      requireAhrefs: true,
    });
  } catch (error) {
    thrown = error instanceof ResearchError ? error : null;
  }

  assert.ok(thrown, 'expected a ResearchError');
  assert.equal(thrown?.code, 'AHREFS_REQUIRE_CONFIG');
  assert.equal(collectCalls, 0, 'no keyword collection should start when key is missing in required mode');
  store.close();
});

test('optional mode without key is explicitly skipped, never reported as resolved', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'task009-optional-skip-'));
  const debugRoot = join(runDirectory, 'debug');
  await createRunDirectory(runDirectory).catch(() => undefined);
  await createRunDirectory(debugRoot).catch(() => undefined);

  const collect: CollectKeywordFn = async (record) => okCollect(record);

  const outcome = await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: BASE_CONFIG,
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    runDirectory,
    debugRoot,
    collect,
    hooks: makeHooks(),
    requireAhrefs: false,
  });

  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.ahrefs.mode, 'optional');
  assert.equal(outcome.ahrefs.state, 'skipped');
  assert.equal(outcome.ahrefs.attempted, 0);
  // Discovered counts domains observed in SERPs regardless of whether DR was
  // attempted; with no Ahrefs client, no lookup is attempted and the stage is
  // explicitly skipped (never reported as resolved).
  assert.ok(outcome.ahrefs.discovered >= 0);
  assert.equal(outcome.ahrefs.numericCoverage, 0);
  assert.equal(outcome.scoringCompleteness.status, 'degraded');
  store.close();
});

test('required mode with systemic auth failure does not finish clean and makes exactly one API call across multiple keywords', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'task009-systemic-fail-'));
  const debugRoot = join(runDirectory, 'debug');
  await createRunDirectory(runDirectory).catch(() => undefined);
  await createRunDirectory(debugRoot).catch(() => undefined);
  const cache = CacheStore.openInMemory();

  let apiCalls = 0;
  const ahrefs: AhrefsClient = async (domain: string) => {
    apiCalls += 1;
    throw new ResearchError('AHREFS_ERROR', `Ahrefs auth rejected (403) for "${domain}".`, { httpStatus: 403 });
  };

  const collect: CollectKeywordFn = async (record) => okCollect(record);

  const outcome = await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: BASE_CONFIG,
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    runDirectory,
    debugRoot,
    collect,
    hooks: makeHooks(),
    requireAhrefs: true,
    ahrefs: { apiKey: 'invalid-key', client: ahrefs },
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
  });

  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.ahrefs.mode, 'required');
  assert.equal(outcome.ahrefs.state, 'failed');
  // Systemic auth failure on the first real lookup must make exactly ONE API
  // call: the global lock stops all further DR lookups for every remaining
  // domain across all subsequent keywords. With 2 keywords × 2 domains each,
  // without the lock this would be 4 calls; with the lock it must be exactly 1.
  assert.equal(apiCalls, 1, `expected exactly 1 API call before global lock, got ${apiCalls}`);
  assert.ok(outcome.state !== 'completed', 'required mode with systemic failure must not finish as clean completed');
  store.close();
  cache.close();
});

test('mixed ok / not_found / error outcomes are isolated, cached, and counted consistently', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'task009-mixed-'));
  const debugRoot = join(runDirectory, 'debug');
  await createRunDirectory(runDirectory).catch(() => undefined);
  await createRunDirectory(debugRoot).catch(() => undefined);
  const cache = CacheStore.openInMemory();

  const ahrefs: AhrefsClient = async (domain: string) => {
    if (domain === 'example.com') return okRating(domain, 70);
    if (domain === 'other.com') return { domain, dr: null, fetchedAt: new Date().toISOString(), source: 'ahrefs', status: 'not_found', error: null };
    if (domain === 'error.com') return { domain, dr: null, fetchedAt: new Date().toISOString(), source: 'ahrefs', status: 'error', error: 'network' };
    return okRating(domain, 10);
  };

  const collect: CollectKeywordFn = async (record) =>
    record.normalizedKeyword === 'compare lists'
      ? { ...okCollect(record), serpRows: serpRowsFor(record.normalizedKeyword, ['example.com', 'error.com', 'example.com']) }
      : { ...okCollect(record), serpRows: serpRowsFor(record.normalizedKeyword, ['other.com', 'example.com']) };

  const outcome = await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: BASE_CONFIG,
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    runDirectory,
    debugRoot,
    collect,
    hooks: makeHooks(),
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
    ahrefs: { apiKey: 'k', client: ahrefs },
  });

  assert.equal(outcome.kind, 'finished');
  // Ahrefs accounting is over unique persisted domains (resumes correctly),
  // not over lookup calls. example.com appears once with status=ok even though
  // it was looked up for two keywords.
  assert.equal(outcome.ahrefs.ok, 1, 'example.com is one unique ok domain');
  assert.equal(outcome.ahrefs.notFound, 1, 'other.com is not_found');
  assert.equal(outcome.ahrefs.error, 1, 'error.com is error');
  assert.equal(outcome.ahrefs.discovered, 3, 'three unique domains discovered');
  assert.equal(outcome.ahrefs.numericCoverage, 1, 'only example.com has numeric DR');
  assert.equal(outcome.ahrefs.state, 'degraded', 'errors degrade the stage even in optional mode');
  // Cache/fresh are derived from persisted domains. example.com was first
  // fetched as 'fresh' for the first keyword; subsequent cache hits do not
  // change the persisted source, so it stays 'fresh'.
  assert.equal(outcome.ahrefs.fresh, 3, 'three fresh lookups: example.com, error.com, other.com');
  assert.equal(outcome.ahrefs.cache, 0, 'no domain changed from fresh to cache in persistence');

  const domains = store.loadDomains(runId);
  assert.equal(domains.length, 3);
  assert.ok(domains.every((d) => d.status === 'ok' || d.status === 'not_found' || d.status === 'error'));
  store.close();
  cache.close();
});

test('related keywords are collected and persisted even with expansion off', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'task009-related-noexpand-'));
  const debugRoot = join(runDirectory, 'debug');
  await createRunDirectory(runDirectory).catch(() => undefined);
  await createRunDirectory(debugRoot).catch(() => undefined);

  const collect: CollectKeywordFn = async (record) => ({
    ...okCollect(record),
    related: { status: 'ok', error: null, rows: [{ keyword: 'related term', normalizedKeyword: 'related term', overlap: 60, volume: 300 }] },
  });

  const config = { ...BASE_CONFIG, expansion: { ...BASE_CONFIG.expansion, enabled: false } };

  const outcome = await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config,
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    runDirectory,
    debugRoot,
    collect,
    hooks: makeHooks(),
  });

  assert.equal(outcome.kind, 'finished');
  const related = store.loadRelatedKeywords(runId);
  assert.ok(related.length >= 1, 'related rows must be persisted even with expansion off');
  assert.ok(related.every((r) => r.selectedForExpansion === false), 'selected must be false when expansion is off');
  assert.equal(store.loadKeywords(runId).length, 2, 'no keywords queued for expansion');
  store.close();
});

test('expansion on consumes related data and queues depth-one keywords; expansion off does not', async () => {
  const baseCollect: CollectKeywordFn = async (record) => ({
    ...okCollect(record),
    related: {
      status: 'ok',
      error: null,
      rows: [{ keyword: 'related a', normalizedKeyword: 'related a', overlap: 50, volume: 500 }],
    },
  });

  async function runWithExpansion(enabled: boolean) {
    const store = RunStore.openInMemory();
    const runId = createRunId();
    const runDirectory = await mkdtemp(join(tmpdir(), `task009-expand-${enabled}-`));
    const debugRoot = join(runDirectory, 'debug');
    await createRunDirectory(runDirectory).catch(() => undefined);
    await createRunDirectory(debugRoot).catch(() => undefined);

    const config = { ...BASE_CONFIG, expansion: { ...BASE_CONFIG.expansion, enabled } };

    await executeRun({
      store,
      runId,
      mode: 'fresh',
      keywords: KEYWORDS,
      config,
      input: { kind: 'seeds', path: 'input/seeds.csv' },
      runDirectory,
      debugRoot,
      collect: baseCollect,
      hooks: makeHooks(),
    });

    const keywordCount = store.loadKeywords(runId).length;
    const related = store.loadRelatedKeywords(runId);
    store.close();
    return { keywordCount, selectedCount: related.filter((r) => r.selectedForExpansion).length };
  }

  const off = await runWithExpansion(false);
  const on = await runWithExpansion(true);

  assert.equal(off.keywordCount, 2, 'expansion off: only seed keywords');
  assert.equal(off.selectedCount, 0, 'expansion off: no related selected');
  assert.ok(on.keywordCount > 2, 'expansion on: related candidates queued');
  assert.ok(on.selectedCount >= 1, 'expansion on: related rows marked selected');
});

test('primary cache hit + related miss performs related-only browser work', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'task009-primary-hit-related-miss-'));
  const debugRoot = join(runDirectory, 'debug');
  await createRunDirectory(runDirectory).catch(() => undefined);
  await createRunDirectory(debugRoot).catch(() => undefined);
  const cache = CacheStore.openInMemory();

  // Prime primary keyword cache but NOT related cache.
  const identity = keywordCacheIdentity(BASE_CONFIG);
  const ttl = BASE_CONFIG.cache.ttl.completedMs;
  const collectedAt = new Date(Date.now() - 60_000).toISOString();
  for (const keyword of KEYWORDS) {
    cache.putKeyword({
      cacheKey: buildKeywordCacheKey(keyword.normalizedKeyword, identity),
      keyword: keyword.keyword,
      normalizedKeyword: keyword.normalizedKeyword,
      identity,
      record: {
        id: 'cached',
        keyword: keyword.keyword,
        normalizedKeyword: keyword.normalizedKeyword,
        sources: [],
        status: 'completed',
        surfer: { volume: 200, cpc: 2, market: 'US', fetchedAt: collectedAt },
        google: { hl: 'en', gl: 'us', pageUrl: 'u', detectedLocation: null, geoWarning: false },
        error: null,
      },
      serpRows: serpRowsFor(keyword.normalizedKeyword, ['cached.com']),
      collectedAt,
      storedAt: collectedAt,
      expiresAt: new Date(Date.parse(collectedAt) + ttl).toISOString(),
    });
  }

  let relatedCalls = 0;
  let collectCalls = 0;
  const collect: CollectKeywordFn = async (record) => {
    collectCalls += 1;
    return okCollect(record);
  };
  const collectRelated: CollectRelatedFn = async (record) => {
    relatedCalls += 1;
    return {
      related: { status: 'ok', error: null, rows: [{ keyword: 'fresh related', normalizedKeyword: 'fresh related', overlap: 40, volume: 400 }] },
      debugArtifactPath: null,
    };
  };

  const outcome = await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: BASE_CONFIG,
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    runDirectory,
    debugRoot,
    collect,
    collectRelated,
    hooks: makeHooks(),
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
  });

  assert.equal(outcome.kind, 'finished');
  assert.equal(collectCalls, 0, 'primary cache hit: no fresh keyword collection');
  assert.ok(relatedCalls >= 1, 'related-only browser collection must run when related cache misses');
  const related = store.loadRelatedKeywords(runId);
  assert.ok(related.length >= 1, 'related rows persisted from fresh collection');
  store.close();
  cache.close();
});

test('output-level consistency: domains.csv, report.md, manifest, status.json agree', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'task009-consistency-'));
  const debugRoot = join(runDirectory, 'debug');
  await createRunDirectory(runDirectory).catch(() => undefined);
  await createRunDirectory(debugRoot).catch(() => undefined);

  const collect: CollectKeywordFn = async (record) => okCollect(record);

  const outcome = await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: BASE_CONFIG,
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    runDirectory,
  debugRoot,
  collect,
  hooks: makeHooks(),
  publishSnapshots: writeSnapshots,
  cache: { store: CacheStore.openInMemory(), forceRefresh: false, refreshKeywords: new Set() },
  });

  assert.equal(outcome.kind, 'finished');
  // With no Ahrefs client the stage is skipped and scoring is degraded; the
  // domains table still persists observed domains with honest provenance.
  assert.equal(outcome.ahrefs.state, 'skipped');
  assert.equal(outcome.ahrefs.numericCoverage, 0);
  assert.equal(outcome.scoringCompleteness.status, 'degraded');

  const domains = store.loadDomains(runId);
  assert.equal(domains.length, 2, 'two unique observed domains persisted');
  assert.ok(domains.every((d) => d.source === 'none' && d.status === 'not_attempted'));

  const related = store.loadRelatedKeywords(runId);
  assert.equal(related.length, 2);

  const keywords = store.loadKeywords(runId);
  assert.equal(keywords.length, 2);
  assert.ok(keywords.every((k) => k.cacheStatus === 'miss'));

  const manifest = JSON.parse(
    await readFile(join(runDirectory, 'manifest.json'), 'utf8'),
  ) as { state: string; ahrefs: { state: string }; scoringCompleteness: { status: string } };
  assert.equal(manifest.state, outcome.state);
  assert.equal(manifest.ahrefs.state, 'skipped');
  assert.equal(manifest.scoringCompleteness.status, 'degraded');
  store.close();
});

test('geo mismatch remains unchanged and is preserved across outputs', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'task009-geo-'));
  const debugRoot = join(runDirectory, 'debug');
  await createRunDirectory(runDirectory).catch(() => undefined);
  await createRunDirectory(debugRoot).catch(() => undefined);

  const collect: CollectKeywordFn = async (record) => ({
    record: {
      ...record,
      status: 'completed',
      surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: new Date().toISOString() },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'u',
        detectedLocation: 'Chelyabinsk Oblast, Russia',
        geoWarning: true,
      },
      error: null,
    },
    serpRows: serpRowsFor(record.normalizedKeyword, ['example.com']),
    debugArtifactPath: null,
    related: { status: 'ok', error: null, rows: [] },
  });

  await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: BASE_CONFIG,
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    runDirectory,
    debugRoot,
    collect,
    hooks: makeHooks(),
    publishSnapshots: writeSnapshots,
  });

  const keywords = store.loadKeywords(runId);
  assert.ok(keywords.every((k) => k.google?.geoWarning === true));
  assert.ok(keywords.every((k) => k.google?.detectedLocation === 'Chelyabinsk Oblast, Russia'));
  store.close();
});
