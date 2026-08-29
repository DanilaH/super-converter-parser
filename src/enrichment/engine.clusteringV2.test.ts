import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import {
  CLUSTERING_ALGORITHM_VERSION,
  DEFAULT_CLUSTER_MIN_SHARED_URLS,
  DEFAULT_CLUSTER_MIN_URL_JACCARD,
  type ClusteringConfig,
} from './clustering.js';
import { CLUSTER_URL_IDENTITY_VERSION } from './urlIdentity.js';
import {
  runEnrichment,
  type EnrichmentHttpConfig,
  type EnrichmentPagesConfig,
  type EnrichmentSiteStructureConfig,
} from './engine.js';

const V2_CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: {
    minSharedDomains: 3,
    minJaccard: 0.3,
    minSharedUrls: DEFAULT_CLUSTER_MIN_SHARED_URLS,
    minUrlJaccard: DEFAULT_CLUSTER_MIN_URL_JACCARD,
  },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
  urlIdentityVersion: CLUSTER_URL_IDENTITY_VERSION,
  groupingRule: 'complete_link',
};

const V1_CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
  algorithmVersion: '1.0.0',
  groupingRule: 'connected_components',
};

const HTTP_CONFIG: EnrichmentHttpConfig = {
  enabled: false,
  maxRedirects: 5,
  timeoutMs: 15_000,
  maxBytes: 2_000_000,
  maxTextBytes: 500_000,
  userAgent: 'Test/1.0',
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
  enabled: false,
  maxSitemapFiles: 1,
  maxUrlsPerSitemap: 1,
  maxSampleUrls: 1,
  maxDomains: 1,
};

function createCompletedClusterItem(store: RunStore, enrichmentId: string): void {
  store.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'clusters',
    module: 'clusters',
    status: 'completed',
    source: 'serp_overlap',
    cacheStatus: 'none',
    fetchedAt: '2026-08-29T00:00:00.000Z',
  });
}

function createEnrichmentRecord(
  store: RunStore,
  enrichmentId: string,
  sourceRunId: string,
  directory: string,
  config: ClusteringConfig,
): void {
  store.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['clusters'],
    config: JSON.stringify({ clusters: config }),
    sourceRunDirectory: `/runs/${sourceRunId}`,
    enrichmentDirectory: directory,
    shortlistKeywords: [],
  });
}

test('runEnrichment: completed clustering-v2 resume restores numeric cluster order and cohesion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clustering-v2-resume-'));
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.open(join(directory, 'run.sqlite'));
  const enrichmentId = 'clustering-v2-resume';
  const sourceRunId = 'source-run';

  try {
    createEnrichmentRecord(enrichmentStore, enrichmentId, sourceRunId, directory, V2_CONFIG);
    enrichmentStore.saveKeywordClusters(
      enrichmentId,
      Array.from({ length: 12 }, (_, index) => {
        const keywordIdx = index + 1;
        const keyword = `keyword ${keywordIdx}`;
        return {
          clusterId: `cluster-${keywordIdx}`,
          canonicalKeywordIdx: keywordIdx,
          canonicalKeyword: keyword,
          members: [{
            keywordIdx,
            keyword,
            normalizedKeyword: keyword,
            volume: null,
            serpSize: 1,
          }],
          representativeDomains: [`domain-${keywordIdx}.example`],
          medianVolume: null,
          averageVolume: null,
          cohesion: { pairCount: 0, urlJaccard: null, domainJaccard: null },
          algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
          config: V2_CONFIG,
        };
      }),
    );
    createCompletedClusterItem(enrichmentStore, enrichmentId);

    const outcome = await runEnrichment({
      enrichmentId,
      sourceRunId,
      sourceStoreOrPath: sourceStore,
      enrichmentStore,
      enrichmentDirectory: directory,
      modules: ['clusters'],
      config: { clusters: V2_CONFIG },
      httpConfig: HTTP_CONFIG,
      pagesConfig: PAGES_CONFIG,
      siteStructureConfig: SITE_STRUCTURE_CONFIG,
      logger: () => {},
      resume: true,
    });

    assert.equal(outcome.kind, 'completed');
    const clusters = outcome.result?.clusters?.clusters ?? [];
    assert.deepEqual(
      clusters.map((cluster) => cluster.clusterId),
      Array.from({ length: 12 }, (_, index) => `cluster-${index + 1}`),
    );
    assert.deepEqual(clusters[0]?.cohesion, {
      pairCount: 0,
      urlJaccard: null,
      domainJaccard: null,
    });

    const artifact = JSON.parse(
      await readFile(join(directory, 'keyword-clusters.json'), 'utf8'),
    ) as { clusters: Array<{ clusterId: string; cohesion: unknown }> };
    assert.deepEqual(
      artifact.clusters.map((cluster) => cluster.clusterId),
      Array.from({ length: 12 }, (_, index) => `cluster-${index + 1}`),
    );
    assert.deepEqual(artifact.clusters[0]?.cohesion, {
      pairCount: 0,
      urlJaccard: null,
      domainJaccard: null,
    });
  } finally {
    sourceStore.close();
    enrichmentStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('runEnrichment: completed empty v1 clustering remains labelled historical on resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clustering-v1-empty-resume-'));
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.open(join(directory, 'run.sqlite'));
  const enrichmentId = 'clustering-v1-empty-resume';
  const sourceRunId = 'source-run';

  try {
    createEnrichmentRecord(enrichmentStore, enrichmentId, sourceRunId, directory, V1_CONFIG);
    createCompletedClusterItem(enrichmentStore, enrichmentId);

    const outcome = await runEnrichment({
      enrichmentId,
      sourceRunId,
      sourceStoreOrPath: sourceStore,
      enrichmentStore,
      enrichmentDirectory: directory,
      modules: ['clusters'],
      config: { clusters: V1_CONFIG },
      httpConfig: HTTP_CONFIG,
      pagesConfig: PAGES_CONFIG,
      siteStructureConfig: SITE_STRUCTURE_CONFIG,
      logger: () => {},
      resume: true,
    });

    assert.equal(outcome.kind, 'completed');
    assert.equal(outcome.result?.clusters?.algorithmVersion, '1.0.0');

    const artifact = JSON.parse(
      await readFile(join(directory, 'keyword-clusters.json'), 'utf8'),
    ) as { algorithmVersion: string; clusters: unknown[] };
    assert.equal(artifact.algorithmVersion, '1.0.0');
    assert.deepEqual(artifact.clusters, []);
  } finally {
    sourceStore.close();
    enrichmentStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});
