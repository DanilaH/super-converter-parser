import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import {
  runQuerySuggestionsModule,
  type CollectResult,
  type SuggestionCollector,
} from './querySuggestions.js';
import type { QuerySuggestionSource } from './types.js';

class EmptyCollector implements SuggestionCollector {
  openCalls = 0;
  collectCalls: Array<{ parentKeyword: string; sources: QuerySuggestionSource[] }> = [];

  async open(): Promise<void> {
    this.openCalls += 1;
  }

  async close(): Promise<void> {}

  async collect(
    parentKeyword: string,
    _normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<CollectResult> {
    this.collectCalls.push({ parentKeyword, sources: [...sources] });
    return {
      collections: sources.map((source) => ({
        source,
        status: 'empty',
        occurrences: [],
        error: null,
        cacheStatus: 'none',
      })),
      navigationRequests: 1,
      xhrRequests: sources.includes('google_autocomplete') ? 1 : 0,
    };
  }
}

function markSourceKeywordsCompleted(store: RunStore, runId: string): void {
  for (const keyword of store.loadKeywords(runId)) {
    store.updateKeyword(runId, {
      ...keyword,
      status: 'completed',
      collectedAt: '2026-08-29T00:00:00.000Z',
    });
  }
}

function queryConfig(): {
  sources: QuerySuggestionSource[];
  maxSuggestionsPerSource: number;
  maxParents: number;
  rateLimitMinDelayMs: number;
  rateLimitMaxDelayMs: number;
  algorithmVersion: string;
} {
  return {
    sources: ['google_autocomplete'],
    maxSuggestionsPerSource: 20,
    maxParents: 200,
    rateLimitMinDelayMs: 0,
    rateLimitMaxDelayMs: 0,
    algorithmVersion: '1.0.0',
  };
}

test('ambiguous legacy text checkpoint is not reused for multiple source keyword ids', async () => {
  const researchConfig = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const sourceRunId = 'identity-source';
  const enrichmentId = 'identity-enrichment';
  const config = queryConfig();

  sourceStore.createRun({
    runId: sourceRunId,
    configSnapshot: researchConfig,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: [
      { keyword: 'JSON Diff', normalizedKeyword: 'json diff', sourceRows: [1] },
      { keyword: ' json   diff ', normalizedKeyword: 'json diff', sourceRows: [2] },
      { keyword: 'csv parser', normalizedKeyword: 'csv parser', sourceRows: [3] },
      { keyword: 'data merge', normalizedKeyword: 'data merge', sourceRows: [4] },
      { keyword: 'file converter', normalizedKeyword: 'file converter', sourceRows: [5] },
    ],
  });
  markSourceKeywordsCompleted(sourceStore, sourceRunId);

  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: config }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: `/tmp/${enrichmentId}`,
    shortlistKeywords: ['json diff', 'csv parser', 'data merge', 'file converter'],
  });

  // Historical runs persisted both a text-owned source checkpoint and a
  // matching lifecycle item. Neither can be assigned to idx 0 or 1 because
  // both source keywords normalize to the same text.
  enrichmentStore.saveQuerySuggestionSource(
    enrichmentId,
    'json diff',
    'google_autocomplete',
    'empty',
    null,
    '2026-08-28T00:00:00.000Z',
    'none',
    0,
    researchConfig.research.market,
    researchConfig.research.googleHl,
    researchConfig.research.googleGl,
    '1.0.0',
  );
  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'google_autocomplete:json diff',
    module: 'query_suggestions',
    status: 'completed',
    source: 'google',
    cacheStatus: 'none',
    fetchedAt: '2026-08-28T00:00:00.000Z',
  });

  const collector = new EmptyCollector();
  try {
    const result = await runQuerySuggestionsModule({
      enrichmentId,
      sourceStore,
      enrichmentStore,
      sourceRunId,
      config,
      shortlist: ['json diff', 'csv parser', 'data merge', 'file converter'],
      logger: () => {},
      signal: { cancelled: false },
      collector,
      cache,
      researchConfig,
      debugRoot: `/tmp/${enrichmentId}/debug`,
    });

    assert.equal(collector.openCalls, 1);
    // idx 0 performs the semantic collection; idx 1 may legitimately reuse its
    // fresh text-keyed cache entry. Ownership is proven by the separate V2 rows.
    assert.equal(collector.collectCalls.filter((call) => normalizeKeyword(call.parentKeyword) === 'json diff').length, 1);

    const itemIds = enrichmentStore.loadEnrichmentItems(enrichmentId)
      .filter((item) => item.module === 'query_suggestions')
      .map((item) => item.itemId);
    assert.ok(itemIds.includes('google_autocomplete:0'));
    assert.ok(itemIds.includes('google_autocomplete:1'));
    assert.ok(itemIds.includes('google_autocomplete:json diff'), 'legacy lifecycle item remains preserved as compatibility evidence');

    const sourceRows = enrichmentStore.loadQuerySuggestionSources(enrichmentId);
    assert.deepEqual(
      sourceRows.map((row) => row.parentKeywordIdx).sort((a, b) => (a ?? -1) - (b ?? -1)),
      [0, 1, 2, 3, 4],
    );
    assert.equal(result.inputCount, 5);
  } finally {
    cache.close();
    sourceStore.close();
    enrichmentStore.close();
  }
});

test('numeric legacy item id cannot masquerade as an idx-owned source checkpoint', async () => {
  const researchConfig = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const sourceRunId = 'numeric-identity-source';
  const enrichmentId = 'numeric-identity-enrichment';
  const config = queryConfig();

  sourceStore.createRun({
    runId: sourceRunId,
    configSnapshot: researchConfig,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: [
      { keyword: '0', normalizedKeyword: '0', sourceRows: [1] },
      { keyword: ' 0 ', normalizedKeyword: '0', sourceRows: [2] },
      { keyword: 'csv parser', normalizedKeyword: 'csv parser', sourceRows: [3] },
      { keyword: 'data merge', normalizedKeyword: 'data merge', sourceRows: [4] },
      { keyword: 'file converter', normalizedKeyword: 'file converter', sourceRows: [5] },
    ],
  });
  markSourceKeywordsCompleted(sourceStore, sourceRunId);

  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: config }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: `/tmp/${enrichmentId}`,
    shortlistKeywords: ['0', 'csv parser', 'data merge', 'file converter'],
  });

  enrichmentStore.saveQuerySuggestionSource(
    enrichmentId,
    '0',
    'google_autocomplete',
    'empty',
    null,
    '2026-08-28T00:00:00.000Z',
    'none',
    0,
    researchConfig.research.market,
    researchConfig.research.googleHl,
    researchConfig.research.googleGl,
    '1.0.0',
  );
  // This legacy text-owned lifecycle id is byte-for-byte identical to the
  // current compact lifecycle id for source keyword idx 0.
  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'google_autocomplete:0',
    module: 'query_suggestions',
    status: 'completed',
    source: 'google',
    cacheStatus: 'none',
    fetchedAt: '2026-08-28T00:00:00.000Z',
  });

  const collector = new EmptyCollector();
  try {
    const result = await runQuerySuggestionsModule({
      enrichmentId,
      sourceStore,
      enrichmentStore,
      sourceRunId,
      config,
      shortlist: ['0', 'csv parser', 'data merge', 'file converter'],
      logger: () => {},
      signal: { cancelled: false },
      collector,
      cache,
      researchConfig,
      debugRoot: `/tmp/${enrichmentId}/debug`,
    });

    assert.ok(
      collector.collectCalls.some((call) => normalizeKeyword(call.parentKeyword) === '0'),
      'legacy lifecycle collision must not suppress a fresh idx-owned collection',
    );

    const sourceRows = enrichmentStore.loadQuerySuggestionSources(enrichmentId);
    const concreteIds = sourceRows
      .map((row) => row.parentKeywordIdx)
      .filter((idx): idx is number => idx !== null)
      .sort((a, b) => a - b);
    assert.deepEqual(concreteIds, [0, 1, 2, 3, 4]);
    assert.ok(sourceRows.some((row) => row.parentKeywordIdx === 0 && row.normalizedParent === '0'));
    assert.equal(result.inputCount, 5);
  } finally {
    cache.close();
    sourceStore.close();
    enrichmentStore.close();
  }
});
