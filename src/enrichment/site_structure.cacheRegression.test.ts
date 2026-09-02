import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import {
  runEnrichment,
  type EnrichmentHttpConfig,
  type EnrichmentPagesConfig,
  type EnrichmentSiteStructureConfig,
  type SsrfChecker,
} from './engine.js';
import { CLUSTERING_ALGORITHM_VERSION, type ClusteringConfig } from './clustering.js';

const BASE_CONFIG = loadConfig({});
const DOMAIN = 'cache-provenance.example';
const CACHE_TTL = {
  successMs: 60_000,
  notFoundMs: 60_000,
  errorMs: 60_000,
};

const HTTP_CONFIG: EnrichmentHttpConfig = {
  enabled: true,
  maxRedirects: 5,
  timeoutMs: 100,
  maxBytes: 10_000,
  maxTextBytes: 5_000,
  userAgent: 'CacheRegressionTest/1.0',
  respectRetryAfter: true,
  minDelayMs: 0,
  maxDelayMs: 0,
  maxRetries: 0,
  baseRetryDelayMs: 0,
};

const PAGES_CONFIG: EnrichmentPagesConfig = {
  enabled: false,
  topUrlsPerKeyword: 3,
  includeMainText: false,
  mainTextMaxChars: 5_000,
};

const SITE_STRUCTURE_CONFIG: EnrichmentSiteStructureConfig = {
  enabled: true,
  maxSitemapFiles: 10,
  maxUrlsPerSitemap: 100,
  maxSampleUrls: 50,
  maxDomains: 30,
};

const CLUSTERING_CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
};

const blockedSsrf: SsrfChecker = async () => ({
  allowed: false,
  reason: 'cache regression test',
  kind: 'blocked',
});

function createSourceStore(runId: string, prefix: string, bestPosition: number): { store: RunStore; shortlist: string[] } {
  const store = RunStore.openInMemory();
  const keywords = Array.from({ length: 5 }, (_, index) => ({
    keyword: `${prefix} ${index + 1}`,
    normalizedKeyword: `${prefix} ${index + 1}`,
    sourceRows: [index + 1],
  }));
  const configSnapshot = {
    ...BASE_CONFIG,
    cache: { ...BASE_CONFIG.cache, path: ':memory:' },
  };
  store.createRun({
    runId,
    configSnapshot,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'test.csv' },
    keywords,
  });

  const now = new Date().toISOString();
  keywords.forEach((keyword, index) => {
    const position = bestPosition + index;
    store.commitKeyword(
      runId,
      {
        id: `k-${index}`,
        idx: index,
        keyword: keyword.keyword,
        normalizedKeyword: keyword.normalizedKeyword,
        sources: [{ type: 'seed', rowNumbers: keyword.sourceRows }],
        status: 'completed',
        surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: now },
        google: { hl: 'en', gl: 'us', pageUrl: 'https://google.test/', detectedLocation: null, geoWarning: false },
        error: null,
        collectedAt: now,
        cacheStatus: 'refreshed',
      },
      [{
        keyword: keyword.keyword,
        position,
        title: '',
        url: `https://${DOMAIN}/`,
        hostname: DOMAIN,
        registrableDomain: DOMAIN,
        dr: null,
        drStatus: 'not_attempted',
        resultType: 'organic',
      }],
    );
  });

  return { store, shortlist: keywords.map((keyword) => keyword.keyword) };
}

async function runSiteStructure(input: {
  root: string;
  cachePath: string;
  runId: string;
  enrichmentId: string;
  prefix: string;
  bestPosition: number;
  siteStructureConfig?: EnrichmentSiteStructureConfig;
}) {
  const source = createSourceStore(input.runId, input.prefix, input.bestPosition);
  const enrichmentDirectory = join(input.root, input.enrichmentId);
  await mkdir(enrichmentDirectory, { recursive: true });
  const enrichmentStore = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
  try {
    return await runEnrichment({
      enrichmentId: input.enrichmentId,
      sourceStoreOrPath: source.store,
      sourceRunId: input.runId,
      enrichmentStore,
      enrichmentDirectory,
      modules: ['site_structure'],
      shortlist: source.shortlist,
      config: { clusters: CLUSTERING_CONFIG },
      httpConfig: HTTP_CONFIG,
      pagesConfig: PAGES_CONFIG,
      siteStructureConfig: input.siteStructureConfig ?? SITE_STRUCTURE_CONFIG,
      cacheConfig: { dbPath: input.cachePath, ttl: CACHE_TTL },
      ssrfChecker: blockedSsrf,
      logger: () => {},
    });
  } finally {
    source.store.close();
    enrichmentStore.close();
  }
}

test('site_structure cache rebinds current provenance and separates content-affecting limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'site-structure-cache-regression-'));
  const cachePath = join(root, 'cache.sqlite');
  try {
    const first = await runSiteStructure({
      root,
      cachePath,
      runId: 'source-alpha',
      enrichmentId: 'enrichment-alpha',
      prefix: 'alpha',
      bestPosition: 5,
    });
    assert.equal(first.kind, 'completed');
    assert.equal(first.result?.siteStructure?.[0]?.cacheStatus, 'refreshed');
    assert.deepEqual(first.result?.siteStructure?.[0]?.sourceKeywords, ['alpha 1', 'alpha 2', 'alpha 3', 'alpha 4', 'alpha 5']);
    assert.equal(first.result?.siteStructure?.[0]?.sourceBestPosition, 5);

    const second = await runSiteStructure({
      root,
      cachePath,
      runId: 'source-beta',
      enrichmentId: 'enrichment-beta',
      prefix: 'beta',
      bestPosition: 2,
    });
    assert.equal(second.kind, 'completed');
    assert.equal(second.result?.siteStructure?.[0]?.cacheStatus, 'hit');
    assert.deepEqual(second.result?.siteStructure?.[0]?.sourceKeywords, ['beta 1', 'beta 2', 'beta 3', 'beta 4', 'beta 5']);
    assert.equal(second.result?.siteStructure?.[0]?.sourceBestPosition, 2);

    const changedLimits = await runSiteStructure({
      root,
      cachePath,
      runId: 'source-gamma',
      enrichmentId: 'enrichment-gamma',
      prefix: 'gamma',
      bestPosition: 1,
      siteStructureConfig: { ...SITE_STRUCTURE_CONFIG, maxSampleUrls: SITE_STRUCTURE_CONFIG.maxSampleUrls + 1 },
    });
    assert.equal(changedLimits.kind, 'completed');
    assert.equal(changedLimits.result?.siteStructure?.[0]?.cacheStatus, 'refreshed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
