import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeKeywordClustersCsv, writeKeywordClustersJson } from './outputs.js';
import { writeQuerySuggestionsCsv, writeQuerySuggestionsJson } from './querySuggestionsOutputs.js';
import type { ClusteringConfig, QuerySuggestionResult, QuerySuggestionsConfig } from './types.js';

const clusteringConfig: ClusteringConfig = {
  topN: 10,
  edgeRule: { minSharedDomains: 3, minJaccard: 0.3 },
  algorithmVersion: '1.0.0',
};

const queryConfig: QuerySuggestionsConfig = {
  sources: ['google_autocomplete'],
  maxSuggestionsPerSource: 20,
  maxParents: 200,
  rateLimitMinDelayMs: 0,
  rateLimitMaxDelayMs: 0,
  algorithmVersion: '1.0.0',
};

test('cluster CSV and JSON publish source keyword ids alongside display text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cluster-identity-output-'));
  const csvPath = join(directory, 'keyword-clusters.csv');
  const jsonPath = join(directory, 'keyword-clusters.json');
  const clusters = [{
    clusterId: 'cluster-1',
    canonicalKeywordIdx: 7,
    canonicalKeyword: 'json diff',
    memberCount: 2,
    members: [
      { keywordIdx: 7, keyword: 'JSON Diff', normalizedKeyword: 'json diff', volume: 100, serpSize: 3 },
      { keywordIdx: 8, keyword: ' json   diff ', normalizedKeyword: 'json diff', volume: 90, serpSize: 3 },
    ],
    medianVolume: 95,
    averageVolume: 95,
    representativeDomains: ['example.com'],
  }];
  const pairs = [{
    keywordAIdx: 7,
    keywordBIdx: 8,
    keywordA: 'json diff',
    keywordB: 'json diff',
    intersectionCount: 3,
    unionCount: 3,
    jaccard: 1,
    sharedDomains: ['example.com'],
    isEdge: true,
  }];
  const exclusions = [{
    keywordIdx: 8,
    keyword: ' json   diff ',
    normalizedKeyword: 'json diff',
    reason: 'no_serp' as const,
    serpSize: 0,
  }];

  try {
    await writeKeywordClustersCsv(csvPath, clusters);
    await writeKeywordClustersJson(jsonPath, {
      enrichmentId: 'enr-identity',
      sourceRunId: 'run-1',
      outputDirectory: directory,
      clusters,
      pairs,
      exclusions,
      edgeCount: 1,
      inputCount: 2,
      excludedCount: 1,
      algorithmVersion: '1.0.0',
      config: clusteringConfig,
    });

    const csv = await readFile(csvPath, 'utf8');
    assert.match(csv, /"canonical_keyword_idx"/);
    assert.match(csv, /"member_keyword_idxs"/);
    assert.match(csv, /"7"/);
    assert.match(csv, /"7; 8"/);

    const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
      clusters: Array<{ canonicalKeywordIdx: number; members: Array<{ keywordIdx: number }> }>;
      pairs: Array<{ keywordAIdx: number; keywordBIdx: number }>;
      exclusions: Array<{ keywordIdx: number }>;
    };
    assert.equal(json.clusters[0]?.canonicalKeywordIdx, 7);
    assert.deepEqual(json.clusters[0]?.members.map((member) => member.keywordIdx), [7, 8]);
    assert.deepEqual([json.pairs[0]?.keywordAIdx, json.pairs[0]?.keywordBIdx], [7, 8]);
    assert.equal(json.exclusions[0]?.keywordIdx, 8);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('query suggestion CSV and JSON publish parent source keyword ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'query-identity-output-'));
  const csvPath = join(directory, 'query-suggestions.csv');
  const jsonPath = join(directory, 'query-suggestions.json');
  const result: QuerySuggestionResult = {
    enrichmentId: 'enr-identity',
    suggestions: [{
      parentKeywordIdx: 7,
      parentKeyword: 'JSON Diff',
      normalizedParent: 'json diff',
      source: 'google_autocomplete',
      rawText: 'json compare',
      normalizedSuggestion: 'json compare',
      ordinal: 0,
      volume: null,
      cpc: null,
      market: 'US',
      hl: 'en',
      gl: 'us',
      parserVersion: '1.0.0',
      collectionStatus: 'ok',
      occurrences: [
        {
          parentKeywordIdx: 7,
          parentKeyword: 'JSON Diff',
          normalizedParent: 'json diff',
          source: 'google_autocomplete',
          market: 'US',
          hl: 'en',
          gl: 'us',
          parserVersion: '1.0.0',
          collectionStatus: 'ok',
        },
        {
          parentKeywordIdx: 8,
          parentKeyword: ' json   diff ',
          normalizedParent: 'json diff',
          source: 'google_autocomplete',
          market: 'US',
          hl: 'en',
          gl: 'us',
          parserVersion: '1.0.0',
          collectionStatus: 'ok',
        },
      ],
    }],
    perSourceStatus: [{ source: 'google_autocomplete', status: 'ok', collected: 2, error: null }],
    inputCount: 2,
    emptyCount: 0,
    errorCount: 0,
    sourceStats: {
      surfer_related: { ok: 0, empty: 0, unavailable: 0, error: 0 },
      google_autocomplete: { ok: 2, empty: 0, unavailable: 0, error: 0 },
      google_related_search: { ok: 0, empty: 0, unavailable: 0, error: 0 },
      google_paa: { ok: 0, empty: 0, unavailable: 0, error: 0 },
    },
    algorithmVersion: '1.0.0',
    config: queryConfig,
  };

  try {
    await writeQuerySuggestionsCsv(csvPath, result);
    await writeQuerySuggestionsJson(jsonPath, {
      enrichmentId: 'enr-identity',
      sourceRunId: 'run-1',
      outputDirectory: directory,
      suggestions: result.suggestions,
      perSourceStatus: result.perSourceStatus,
      sourceStats: result.sourceStats,
      sourceRecords: [{
        parentKeywordIdx: 7,
        normalizedParent: 'json diff',
        source: 'google_autocomplete',
        status: 'ok',
        error: null,
        fetchedAt: '2026-08-29T00:00:00.000Z',
        cacheStatus: 'miss',
        requestCount: 1,
        market: 'US',
        hl: 'en',
        gl: 'us',
        parserVersion: '1.0.0',
      }],
      inputCount: 2,
      emptyCount: 0,
      errorCount: 0,
      algorithmVersion: '1.0.0',
      config: queryConfig,
    });

    const csv = await readFile(csvPath, 'utf8');
    assert.match(csv, /"parent_keyword_idxs"/);
    assert.match(csv, /"7; 8"/);

    const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
      sourceRecords: Array<{ parentKeywordIdx: number }>;
      suggestions: Array<{ occurrences: Array<{ parentKeywordIdx: number }> }>;
    };
    assert.equal(json.sourceRecords[0]?.parentKeywordIdx, 7);
    assert.deepEqual(json.suggestions[0]?.occurrences.map((occurrence) => occurrence.parentKeywordIdx), [7, 8]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
