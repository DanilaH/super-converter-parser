import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { createRunDirectory } from '../runs/run.js';
import { loadConfig } from '../config/config.js';
import { runEnrichment, type EnrichmentOptions, type EnrichmentHttpConfig, type EnrichmentPagesConfig, type EnrichmentSiteStructureConfig } from './engine.js';
import { CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig } from './clustering.js';

const CLUSTERING_CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
};

const HTTP_CONFIG: EnrichmentHttpConfig = {
  enabled: true,
  maxRedirects: 5,
  timeoutMs: 15_000,
  maxBytes: 2_000_000,
  maxTextBytes: 500_000,
  userAgent: 'Test/1.0',
  respectRetryAfter: true,
  minDelayMs: 0,
  maxDelayMs: 0,
  maxRetries: 2,
  baseRetryDelayMs: 1000,
};

const PAGES_CONFIG: EnrichmentPagesConfig = {
  enabled: true,
  topUrlsPerKeyword: 3,
  includeMainText: false,
  mainTextMaxChars: 5000,
};

const SITE_STRUCTURE_CONFIG: EnrichmentSiteStructureConfig = {
  enabled: true,
  maxSitemapFiles: 10,
  maxUrlsPerSitemap: 100,
  maxSampleUrls: 50,
  maxDomains: 30,
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
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    logger: (line) => logs.push(line),
  });

  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.state, 'completed');
  assert.ok(outcome.result);
  assert.ok(outcome.result!.clusters);
  assert.equal(outcome.result!.clusters!.clusters.length, 1);
  assert.equal(outcome.result!.clusters!.clusters[0]!.memberCount, 2);

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
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.ok(outcome.result);
  assert.ok(outcome.result!.clusters);
  assert.equal(outcome.result!.clusters!.excludedCount, 1);

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
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.error ?? '', /No completed keywords/);

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('runEnrichment: resume reuses the same run and completed module without duplicate rows', async () => {
  const runId = 'resume-source';
  const sourceStore = createTestSourceStore(runId);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'enrichment-resume-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'enrichment.sqlite'));
  const enrichmentId = 'resume-enrichment';
  const options: EnrichmentOptions = {
    enrichmentId,
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['clusters'],
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    logger: () => {},
  };

  const first = await runEnrichment(options);
  assert.equal(first.kind, 'completed');
  const pairCount = enrichmentStore.loadEnrichmentPairs(enrichmentId).length;
  const clusterCount = enrichmentStore.loadKeywordClusters(enrichmentId).length;
  enrichmentStore.setEnrichmentState(enrichmentId, 'paused');

  const resumed = await runEnrichment({ ...options, resume: true });
  assert.equal(resumed.kind, 'completed');
  assert.equal(enrichmentStore.loadEnrichmentPairs(enrichmentId).length, pairCount);
  assert.equal(enrichmentStore.loadKeywordClusters(enrichmentId).length, clusterCount);
  assert.equal(enrichmentStore.loadEnrichmentRun(enrichmentId)?.state, 'completed');

  const artifact = JSON.parse(
    await readFile(join(enrichmentDir, 'keyword-clusters.json'), 'utf8'),
  ) as { sourceRunId: string; pairs: unknown[]; exclusions: unknown[]; inputCount: number };
  assert.equal(artifact.sourceRunId, runId);
  assert.equal(artifact.pairs.length, pairCount);
  assert.ok(Array.isArray(artifact.exclusions));
  assert.equal(artifact.inputCount, 2);
  assert.equal(sourceStore.loadKeywords(runId).length, 2, 'borrowed source store remains open');

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('runEnrichment: resume resets stale running items before pausing', async () => {
  const runId = 'paused-source';
  const sourceStore = createTestSourceStore(runId);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'enrichment-paused-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'enrichment.sqlite'));
  const enrichmentId = 'paused-enrichment';

  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId: runId,
    modules: ['clusters'],
    config: JSON.stringify({ clusters: CLUSTERING_CONFIG }),
    sourceRunDirectory: '/tmp/source',
    enrichmentDirectory: enrichmentDir,
    shortlistKeywords: [],
  });
  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'clusters',
    module: 'clusters',
    status: 'running',
    source: 'serp_overlap',
    cacheStatus: 'none',
  });

  const outcome = await runEnrichment({
    enrichmentId,
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['clusters'],
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    shortlist: [],
    logger: () => {},
    signal: { cancelled: true },
    resume: true,
  });

  assert.equal(outcome.kind, 'paused');
  assert.equal(enrichmentStore.loadEnrichmentRun(enrichmentId)?.state, 'paused');
  assert.equal(enrichmentStore.loadEnrichmentItems(enrichmentId)[0]?.status, 'pending');

  sourceStore.close();
  enrichmentStore.close();
  await rm(enrichmentDir, { recursive: true, force: true });
});

test('runEnrichment: artifact publication failure leaves the run failed, not completed', async () => {
  const runId = 'output-failure-source';
  const sourceStore = createTestSourceStore(runId);
  const tempDir = await mkdtemp(join(tmpdir(), 'enrichment-output-failure-'));
  const blockedOutputPath = join(tempDir, 'not-a-directory');
  await writeFile(blockedOutputPath, 'file');
  const enrichmentStore = RunStore.open(join(tempDir, 'enrichment.sqlite'));
  const enrichmentId = 'output-failure-enrichment';

  const outcome = await runEnrichment({
    enrichmentId,
    sourceStoreOrPath: sourceStore,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: blockedOutputPath,
    modules: ['clusters'],
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'failed');
  assert.equal(enrichmentStore.loadEnrichmentRun(enrichmentId)?.state, 'failed');

  sourceStore.close();
  enrichmentStore.close();
  await rm(tempDir, { recursive: true, force: true });
});
