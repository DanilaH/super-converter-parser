import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { RunStore } from '../db/store.js';
import {
  CLUSTER_KEYWORD_IDENTITY_SNAPSHOT,
  loadPersistedClusteringRelations,
} from './clusteringSnapshot.js';

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

    const current = loadPersistedClusteringRelations(store, enrichmentId, null);
    assert.equal(current.pairs.length, 1);
    assert.equal(current.exclusions.length, 1);
    assert.equal(current.pairs[0]?.keywordAIdx, null);
    assert.equal(current.exclusions[0]?.keywordIdx, null);
  } finally {
    store.close();
  }
});

test('fresh empty idx-owned snapshot does not resurrect legacy text-owned relations', () => {
  const store = RunStore.openInMemory();
  const enrichmentId = 'fresh-empty-clusters';
  createEnrichment(store, enrichmentId);
  insertLegacyRelations(store, enrichmentId);

  // A fresh clustering generation can legitimately produce zero pair rows and
  // zero exclusions. Keep those v2 tables empty: this is the exact case that
  // made raw compatibility readers fall back to stale legacy rows.
  store.saveEnrichmentPairs(enrichmentId, []);
  store.saveEnrichmentExclusions(enrichmentId, []);
  store.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'clusters',
    module: 'clusters',
    status: 'completed',
    source: 'serp_overlap',
    cacheStatus: 'none',
    fetchedAt: '2026-08-29T00:00:00.000Z',
    payload: CLUSTER_KEYWORD_IDENTITY_SNAPSHOT,
  });

  try {
    // Raw readers intentionally preserve historical compatibility, so they can
    // still expose the legacy fallback when the current v2 relation is empty.
    assert.equal(store.loadEnrichmentPairs(enrichmentId).length, 1);
    assert.equal(store.loadEnrichmentExclusions(enrichmentId).length, 1);

    const item = store.loadEnrichmentItems(enrichmentId).find(
      (row) => row.itemId === 'clusters' && row.module === 'clusters',
    );
    assert.equal(item?.payload, CLUSTER_KEYWORD_IDENTITY_SNAPSHOT);

    const current = loadPersistedClusteringRelations(
      store,
      enrichmentId,
      item?.payload ?? null,
    );
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

  store.saveEnrichmentPairs(enrichmentId, [{
    keywordAIdx: 3,
    keywordBIdx: 4,
    keywordA: 'json compare',
    keywordB: 'json diff',
    intersectionCount: 4,
    unionCount: 4,
    jaccard: 1,
    sharedDomains: ['a.com', 'b.com', 'c.com', 'd.com'],
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
    const current = loadPersistedClusteringRelations(
      store,
      enrichmentId,
      CLUSTER_KEYWORD_IDENTITY_SNAPSHOT,
    );
    assert.deepEqual(current.pairs.map((row) => [row.keywordAIdx, row.keywordBIdx]), [[3, 4]]);
    assert.deepEqual(current.exclusions.map((row) => row.keywordIdx), [5]);
  } finally {
    store.close();
  }
});
