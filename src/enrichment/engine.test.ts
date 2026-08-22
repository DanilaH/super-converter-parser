import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { createRunDirectory } from '../runs/run.js';
import { loadConfig } from '../config/config.js';
import { runEnrichment } from './engine.js';
import { CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig } from './clustering.js';

const CLUSTERING_CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
};

const BASE_CONFIG = loadConfig({});

function createTestSourceStore(runId: string): RunStore {
  const store = RunStore.openInMemory();
  const configSnapshot = {
    ...BASE_CONFIG,
    cache: { ...BASE_CONFIG.cache, path: ':memory:' },
  };
  store.createRun({
    runId,
    configSnapshot,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'test.csv' },
    keywords: [
      { keyword: 'json diff', normalizedKeyword: 'json diff', sourceRows: [1] },
      { keyword: 'json compare', normalizedKeyword: 'json compare', sourceRows: [2] },
    ],
  });

  const now = new Date().toISOString();
  store.commitKeyword(
    runId,
    {
      id: 'k1',
      idx: 0,
      keyword: 'json diff',
      normalizedKeyword: 'json diff',
      sources: [{ type: 'seed', rowNumbers: [1] }],
      status: 'completed',
      surfer: { volume: 800, cpc: 2.5, market: 'US', fetchedAt: now },
      google: { hl: 'en', gl: 'us', pageUrl: 'https://example.com', detectedLocation: null, geoWarning: false },
      error: null,
      collectedAt: now,
      cacheStatus: 'refreshed',
    },
    [
      { keyword: 'json diff', position: 1, title: '', url: 'https://a.com', hostname: 'a.com', registrableDomain: 'a.com', dr: 50, drStatus: 'ok', resultType: 'organic' },
      { keyword: 'json diff', position: 2, title: '', url: 'https://b.com', hostname: 'b.com', registrableDomain: 'b.com', dr: 60, drStatus: 'ok', resultType: 'organic' },
      { keyword: 'json diff', position: 3, title: '', url: 'https://c.com', hostname: 'c.com', registrableDomain: 'c.com', dr: 70, drStatus: 'ok', resultType: 'organic' },
      { keyword: 'json diff', position: 4, title: '', url: 'https://e.com', hostname: 'e.com', registrableDomain: 'e.com', dr: 40, drStatus: 'ok', resultType: 'organic' },
    ],
  );

  store.commitKeyword(
    runId,
    {
      id: 'k2',
      idx: 1,
      keyword: 'json compare',
      normalizedKeyword: 'json compare',
      sources: [{ type: 'seed', rowNumbers: [2] }],
      status: 'completed',
      surfer: { volume: 600, cpc: 2.0, market: 'US', fetchedAt: now },
      google: { hl: 'en', gl: 'us', pageUrl: 'https://example.com', detectedLocation: null, geoWarning: false },
      error: null,
      collectedAt: now,
      cacheStatus: 'refreshed',
    },
    [
      { keyword: 'json compare', position: 1, title: '', url: 'https://a.com', hostname: 'a.com', registrableDomain: 'a.com', dr: 50, drStatus: 'ok', resultType: 'organic' },
      { keyword: 'json compare', position: 2, title: '', url: 'https://b.com', hostname: 'b.com', registrableDomain: 'b.com', dr: 60, drStatus: 'ok', resultType: 'organic' },
      { keyword: 'json compare', position: 3, title: '', url: 'https://c.com', hostname: 'c.com', registrableDomain: 'c.com', dr: 70, drStatus: 'ok', resultType: 'organic' },
      { keyword: 'json compare', position: 4, title: '', url: 'https://f.com', hostname: 'f.com', registrableDomain: 'f.com', dr: 80, drStatus: 'ok', resultType: 'organic' },
    ],
  );

  return store;
}

test('runEnrichment: clusters keywords from source run', async () => {
  const runId = 'test-source-run';
  const sourceStore = createTestSourceStore(runId);

  const enrichmentDir = await mkdtemp(join(tmpdir(), 'enrichment-test-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const logs: string[] = [];
  const outcome = await runEnrichment({
    enrichmentId: 'test-enrichment',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['clusters'],
    config: { clusters: CLUSTERING_CONFIG },
    logger: (line) => logs.push(line),
  });

  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.state, 'completed');
  assert.ok(outcome.result);
  assert.equal(outcome.result!.clusters.length, 1);
  assert.equal(outcome.result!.clusters[0]!.memberCount, 2);

  const savedRun = enrichmentStore.loadEnrichmentRun('test-enrichment');
  assert.ok(savedRun);
  assert.equal(savedRun!.state, 'completed');

  const clusters = enrichmentStore.loadKeywordClusters('test-enrichment');
  assert.equal(clusters.length, 1);

  const pairs = enrichmentStore.loadEnrichmentPairs('test-enrichment');
  assert.ok(pairs.length >= 1);
  assert.ok(pairs[0]!.keywordA < pairs[0]!.keywordB);

  const exclusions = enrichmentStore.loadEnrichmentExclusions('test-enrichment');
  assert.equal(exclusions.length, 0);

  assert.equal(clusters[0]!.clusterId, 'cluster-1');

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('runEnrichment: persists exclusions for keywords without SERP', async () => {
  const runId = 'test-exclusions';
  const sourceStore = RunStore.openInMemory();
  const configSnapshot = {
    ...BASE_CONFIG,
    cache: { ...BASE_CONFIG.cache, path: ':memory:' },
  };
  sourceStore.createRun({
    runId,
    configSnapshot,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'test.csv' },
    keywords: [
      { keyword: 'has serp', normalizedKeyword: 'has serp', sourceRows: [1] },
      { keyword: 'no serp', normalizedKeyword: 'no serp', sourceRows: [2] },
    ],
  });

  const now = new Date().toISOString();
  sourceStore.commitKeyword(
    runId,
    {
      id: 'k1',
      idx: 0,
      keyword: 'has serp',
      normalizedKeyword: 'has serp',
      sources: [{ type: 'seed', rowNumbers: [1] }],
      status: 'completed',
      surfer: { volume: 100, cpc: 1.0, market: 'US', fetchedAt: now },
      google: { hl: 'en', gl: 'us', pageUrl: 'https://example.com', detectedLocation: null, geoWarning: false },
      error: null,
      collectedAt: now,
      cacheStatus: 'refreshed',
    },
    [
      { keyword: 'has serp', position: 1, title: '', url: 'https://a.com', hostname: 'a.com', registrableDomain: 'a.com', dr: 50, drStatus: 'ok', resultType: 'organic' },
      { keyword: 'has serp', position: 2, title: '', url: 'https://b.com', hostname: 'b.com', registrableDomain: 'b.com', dr: 60, drStatus: 'ok', resultType: 'organic' },
      { keyword: 'has serp', position: 3, title: '', url: 'https://c.com', hostname: 'c.com', registrableDomain: 'c.com', dr: 70, drStatus: 'ok', resultType: 'organic' },
    ],
  );
  sourceStore.commitKeyword(
    runId,
    {
      id: 'k2',
      idx: 1,
      keyword: 'no serp',
      normalizedKeyword: 'no serp',
      sources: [{ type: 'seed', rowNumbers: [2] }],
      status: 'completed',
      surfer: null,
      google: null,
      error: { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'No SERP' },
      collectedAt: now,
      cacheStatus: 'refreshed',
    },
    [],
  );

  const enrichmentDir = await mkdtemp(join(tmpdir(), 'enrichment-excl-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'test-excl',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['clusters'],
    config: { clusters: CLUSTERING_CONFIG },
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result);
  assert.equal(outcome.result!.excludedCount, 1);

  const exclusions = enrichmentStore.loadEnrichmentExclusions('test-excl');
  assert.equal(exclusions.length, 1);
  assert.equal(exclusions[0]!.normalizedKeyword, 'no serp');
  assert.equal(exclusions[0]!.reason, 'no_serp');

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('runEnrichment: fails when no completed keywords in source', async () => {
  const runId = 'empty-source';
  const sourceStore = RunStore.openInMemory();
  const configSnapshot = {
    ...BASE_CONFIG,
    cache: { ...BASE_CONFIG.cache, path: ':memory:' },
  };
  sourceStore.createRun({
    runId,
    configSnapshot,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'test.csv' },
    keywords: [],
  });

  const enrichmentDir = await mkdtemp(join(tmpdir(), 'enrichment-empty-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'test.sqlite'));

  const outcome = await runEnrichment({
    enrichmentId: 'test-empty',
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
        enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['clusters'],
    config: { clusters: CLUSTERING_CONFIG },
    logger: () => {},
  });

  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.error ?? '', /No completed keywords/);

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});
