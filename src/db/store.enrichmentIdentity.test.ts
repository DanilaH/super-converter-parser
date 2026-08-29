import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RunStore, SCHEMA_VERSION } from './store.js';

const CLUSTER_CONFIG = {
  topN: 10,
  edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
  algorithmVersion: '1.0.0',
};

function createEnrichment(store: RunStore, enrichmentId = 'enr-identity'): void {
  store.createEnrichmentRun({
    enrichmentId,
    sourceRunId: 'run-1',
    modules: ['clusters', 'query_suggestions'],
    config: '{}',
    sourceRunDirectory: 'runs/run-1',
    enrichmentDirectory: `enrichments/${enrichmentId}`,
  });
}

test('new enrichment relations are owned by source keyword idx, not normalized text', () => {
  const store = RunStore.openInMemory();
  createEnrichment(store);

  store.saveKeywordClusters('enr-identity', [{
    clusterId: 'cluster-1',
    canonicalKeywordIdx: 3,
    canonicalKeyword: 'json diff',
    members: [
      { keywordIdx: 3, keyword: 'JSON Diff', normalizedKeyword: 'json diff', volume: 100, serpSize: 3 },
      { keywordIdx: 4, keyword: ' json   diff ', normalizedKeyword: 'json diff', volume: 90, serpSize: 3 },
    ],
    representativeDomains: ['example.com'],
    medianVolume: 95,
    averageVolume: 95,
    algorithmVersion: '1.0.0',
    config: CLUSTER_CONFIG,
  }]);

  store.saveEnrichmentPairs('enr-identity', [{
    keywordAIdx: 3,
    keywordBIdx: 4,
    keywordA: 'json diff',
    keywordB: 'json diff',
    intersectionCount: 3,
    unionCount: 3,
    jaccard: 1,
    sharedDomains: ['example.com'],
    isEdge: true,
  }]);

  store.saveEnrichmentExclusions('enr-identity', [
    { keywordIdx: 3, keyword: 'JSON Diff', normalizedKeyword: 'json diff', reason: 'no_serp', serpSize: 0 },
    { keywordIdx: 4, keyword: ' json   diff ', normalizedKeyword: 'json diff', reason: 'no_serp', serpSize: 0 },
  ]);

  const sourceResult = {
    source: 'google_autocomplete' as const,
    status: 'ok',
    error: null,
    fetchedAt: '2026-08-29T00:00:00.000Z',
    requestCount: 1,
    cacheStatus: 'miss',
    parserVersion: '1.0.0',
  };
  const suggestion = (parentKeywordIdx: number, parentKeyword: string) => ({
    normalizedSuggestion: 'json compare',
    rawText: 'json compare',
    volume: null,
    cpc: null,
    ordinal: 0,
    collectionStatus: 'ok',
    occurrences: [{
      parentKeywordIdx,
      parentKeyword,
      normalizedParent: 'json diff',
      source: 'google_autocomplete',
      market: 'US',
      hl: 'en',
      gl: 'us',
      parserVersion: '1.0.0',
      collectionStatus: 'ok',
    }],
  });

  store.persistParentAtomic(
    'enr-identity', 3, 'json diff', 'US', 'en', 'us', [sourceResult], [suggestion(3, 'JSON Diff')],
  );
  store.persistParentAtomic(
    'enr-identity', 4, 'json diff', 'US', 'en', 'us', [sourceResult], [suggestion(4, ' json   diff ')],
  );

  const clusters = store.loadKeywordClusters('enr-identity');
  assert.equal(clusters[0]?.canonicalKeywordIdx, 3);
  assert.deepEqual(clusters[0]?.members.map((member) => member.keywordIdx), [3, 4]);

  const pairs = store.loadEnrichmentPairs('enr-identity');
  assert.deepEqual(pairs.map((pair) => [pair.keywordAIdx, pair.keywordBIdx]), [[3, 4]]);

  const exclusions = store.loadEnrichmentExclusions('enr-identity');
  assert.deepEqual(exclusions.map((row) => row.keywordIdx), [3, 4]);

  const sourceRows = store.loadQuerySuggestionSources('enr-identity');
  assert.deepEqual(sourceRows.map((row) => row.parentKeywordIdx).sort((a, b) => (a ?? -1) - (b ?? -1)), [3, 4]);
  assert.equal(sourceRows.every((row) => row.normalizedParent === 'json diff'), true);

  const savedSuggestion = store.loadQuerySuggestions('enr-identity')[0];
  assert.deepEqual(
    savedSuggestion?.occurrences.map((occurrence) => occurrence.parentKeywordIdx).sort((a, b) => (a ?? -1) - (b ?? -1)),
    [3, 4],
  );

  const itemIds = store.loadEnrichmentItems('enr-identity')
    .filter((item) => item.module === 'query_suggestions')
    .map((item) => item.itemId)
    .sort();
  assert.deepEqual(itemIds, ['google_autocomplete:3', 'google_autocomplete:4']);
  store.close();
});

test('v16 migration keeps v15 text-owned enrichment rows readable without rewriting them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'store-enrichment-v15-'));
  const path = join(directory, 'run.sqlite');

  const created = RunStore.open(path);
  created.close();

  const legacy = new Database(path);
  legacy.exec(`
    DROP TABLE enrichment_pairs_v2;
    DROP TABLE enrichment_exclusions_v2;
    DROP TABLE enrichment_query_suggestion_sources_v2;
    ALTER TABLE keyword_clusters DROP COLUMN canonical_keyword_idx;
  `);
  legacy.pragma('user_version = 15');

  legacy.prepare(
    `INSERT INTO keyword_clusters
      (enrichment_id, cluster_id, canonical_keyword, member_count, median_volume, average_volume, members, representative_domains, algorithm_version, config, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-enr',
    'cluster-1',
    'json diff',
    1,
    100,
    100,
    JSON.stringify([{ keyword: 'JSON Diff', normalizedKeyword: 'json diff', volume: 100, serpSize: 3 }]),
    JSON.stringify(['example.com']),
    '1.0.0',
    JSON.stringify(CLUSTER_CONFIG),
    '2026-08-28T00:00:00.000Z',
  );
  legacy.prepare(
    `INSERT INTO enrichment_pairs
      (enrichment_id, keyword_a, keyword_b, intersection_count, union_count, jaccard, shared_domains, is_edge)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('legacy-enr', 'json diff', 'json compare', 2, 4, 0.5, JSON.stringify(['example.com']), 1);
  legacy.prepare(
    `INSERT INTO enrichment_exclusions
      (enrichment_id, keyword, normalized_keyword, reason, serp_size)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('legacy-enr', 'JSON Diff', 'json diff', 'no_serp', 0);
  legacy.prepare(
    `INSERT INTO enrichment_query_suggestion_sources
      (enrichment_id, normalized_parent, source, status, error, fetched_at, cache_status, request_count, market, hl, gl, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('legacy-enr', 'json diff', 'google_autocomplete', 'empty', null, '2026-08-28T00:00:00.000Z', 'miss', 1, 'US', 'en', 'us', '1.0.0');
  legacy.prepare(
    `INSERT INTO enrichment_query_suggestions
      (enrichment_id, normalized_suggestion, raw_text, volume, cpc, ordinal, market, hl, gl, parser_version, collection_status, occurrences_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-enr',
    'json compare',
    'json compare',
    null,
    null,
    0,
    'US',
    'en',
    'us',
    '1.0.0',
    'ok',
    JSON.stringify([{
      parentKeyword: 'JSON Diff',
      normalizedParent: 'json diff',
      source: 'google_autocomplete',
      market: 'US',
      hl: 'en',
      gl: 'us',
      parserVersion: '1.0.0',
      collectionStatus: 'ok',
    }]),
  );
  legacy.close();

  const migrated = RunStore.open(path);
  assert.equal(migrated.version, SCHEMA_VERSION);
  assert.equal(migrated.loadKeywordClusters('legacy-enr')[0]?.canonicalKeywordIdx, null);
  assert.equal(migrated.loadKeywordClusters('legacy-enr')[0]?.members[0]?.keywordIdx, null);
  assert.equal(migrated.loadEnrichmentPairs('legacy-enr')[0]?.keywordAIdx, null);
  assert.equal(migrated.loadEnrichmentPairs('legacy-enr')[0]?.keywordBIdx, null);
  assert.equal(migrated.loadEnrichmentExclusions('legacy-enr')[0]?.keywordIdx, null);
  assert.equal(migrated.loadQuerySuggestionSources('legacy-enr')[0]?.parentKeywordIdx, null);
  assert.equal(migrated.loadQuerySuggestions('legacy-enr')[0]?.occurrences[0]?.parentKeywordIdx, null);

  const raw = (migrated as unknown as { db: Database.Database }).db;
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  assert.ok(tables.some((row) => row.name === 'enrichment_pairs_v2'));
  assert.ok(tables.some((row) => row.name === 'enrichment_exclusions_v2'));
  assert.ok(tables.some((row) => row.name === 'enrichment_query_suggestion_sources_v2'));
  migrated.close();
});
