import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { RunStore } from '../db/store.js';
import {
  CLUSTERING_ALGORITHM_VERSION,
  DEFAULT_CLUSTER_MIN_SHARED_URLS,
  DEFAULT_CLUSTER_MIN_URL_JACCARD,
  type ClusteringConfig,
} from './clustering.js';
import { loadPersistedClusteringRelations } from './clusteringSnapshot.js';
import { CLUSTER_URL_IDENTITY_VERSION } from './urlIdentity.js';

const CLUSTER_CONFIG: ClusteringConfig = {
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

function createEnrichment(store: RunStore, enrichmentId: string): void {
  store.createEnrichmentRun({
    enrichmentId,
    sourceRunId: 'run-1',
    modules: ['clusters'],
    config: '{}',
    sourceRunDirectory: 'runs/run-1',
    enrichmentDirectory: `enrichments/${enrichmentId}`,
  });
}

function insertLegacyRelations(store: RunStore, enrichmentId: string): void {
  const db = (store as unknown as { db: Database.Database }).db;
  db.prepare(
    `INSERT INTO enrichment_pairs
      (enrichment_id, keyword_a, keyword_b, intersection_count, union_count, jaccard, shared_domains, is_edge)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    enrichmentId,
    'json compare',
    'json diff',
    3,
    5,
    0.6,
    JSON.stringify(['a.com', 'b.com', 'c.com']),
    1,
  );
  db.prepare(
    `INSERT INTO enrichment_exclusions
      (enrichment_id, keyword, normalized_keyword, reason, serp_size)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(enrichmentId, 'old keyword', 'old keyword', 'no_serp', 0);
}

function saveCurrentSingletonCluster(store: RunStore, enrichmentId: string): void {
  store.saveKeywordClusters(enrichmentId, [{
    clusterId: 'cluster-1',
    canonicalKeywordIdx: 7,
    canonicalKeyword: 'json diff',
    members: [{
      keywordIdx: 7,
      keyword: 'json diff',
      normalizedKeyword: 'json diff',
      volume: 100,
      serpSize: 3,
    }],
    representativeDomains: ['a.com', 'b.com', 'c.com'],
    medianVolume: 100,
    averageVolume: 100,
    algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
    config: CLUSTER_CONFIG,
  }]);
}

test('legacy clustering relations remain readable before an idx-owned snapshot exists', () => {
  const store = RunStore.openInMemory();
  const enrichmentId = 'legacy-clusters';
  createEnrichment(store, enrichmentId);
  insertLegacyRelations(store, enrichmentId);

  try {
    const rawPairs = store.loadEnrichmentPairs(enrichmentId);
    const rawExclusions = store.loadEnrichmentExclusions(enrichmentId);
    assert.equal(rawPairs[0]?.keywordAIdx, null);
    assert.equal(rawExclusions[0]?.keywordIdx, null);

    const current = loadPersistedClusteringRelations(store, enrichmentId);
    assert.equal(current.pairs.length, 1);
    assert.equal(current.exclusions.length, 1);
    assert.equal(current.pairs[0]?.keywordAIdx, null);
    assert.equal(current.exclusions[0]?.keywordIdx, null);
  } finally {
    store.close();
  }
});

test('fresh empty relations do not resurrect legacy text-owned rows', () => {
  const store = RunStore.openInMemory();
  const enrichmentId = 'fresh-empty-relations';
  createEnrichment(store, enrichmentId);
  insertLegacyRelations(store, enrichmentId);

  // A one-keyword cluster legitimately has no pair rows and no exclusions.
  // Those empty v2 relations must still supersede the historical fallback.
  saveCurrentSingletonCluster(store, enrichmentId);
  store.saveEnrichmentPairs(enrichmentId, []);
  store.saveEnrichmentExclusions(enrichmentId, []);

  try {
    assert.equal(store.loadEnrichmentPairs(enrichmentId).length, 1);
    assert.equal(store.loadEnrichmentExclusions(enrichmentId).length, 1);

    const current = loadPersistedClusteringRelations(store, enrichmentId);
    assert.deepEqual(current.pairs, []);
    assert.deepEqual(current.exclusions, []);
  } finally {
    store.close();
  }
});

test('idx-owned snapshot preserves non-empty current relations', () => {
  const store = RunStore.openInMemory();
  const enrichmentId = 'fresh-current-clusters';
  createEnrichment(store, enrichmentId);
  insertLegacyRelations(store, enrichmentId);
  saveCurrentSingletonCluster(store, enrichmentId);

  store.saveEnrichmentPairs(enrichmentId, [{
    keywordAIdx: 3,
    keywordBIdx: 4,
    keywordA: 'json compare',
    keywordB: 'json diff',
    intersectionCount: 4,
    unionCount: 4,
    jaccard: 1,
    sharedDomains: ['a.com', 'b.com', 'c.com', 'd.com'],
    sharedUrls: ['a.com/tool', 'b.com/tool', 'c.com/tool', 'd.com/tool'],
    urlIntersectionCount: 4,
    urlUnionCount: 4,
    urlJaccard: 1,
    domainIntersectionCount: 4,
    domainUnionCount: 4,
    domainJaccard: 1,
    classification: 'strong',
    isEdge: true,
  }]);
  store.saveEnrichmentExclusions(enrichmentId, [{
    keywordIdx: 5,
    keyword: 'new keyword',
    normalizedKeyword: 'new keyword',
    reason: 'no_serp',
    serpSize: 0,
  }]);

  try {
    const current = loadPersistedClusteringRelations(store, enrichmentId);
    assert.deepEqual(current.pairs.map((row) => [row.keywordAIdx, row.keywordBIdx]), [[3, 4]]);
    assert.deepEqual(current.exclusions.map((row) => row.keywordIdx), [5]);
  } finally {
    store.close();
  }
});
