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

test('ambiguous legacy text checkpoint is not reused for multiple source keyword ids', async () => {
  const researchConfig = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const sourceRunId = 'identity-source';
  const enrichmentId = 'identity-enrichment';

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
  for (const keyword of sourceStore.loadKeywords(sourceRunId)) {
    sourceStore.updateKeyword(sourceRunId, {
      ...keyword,
      status: 'completed',
      collectedAt: '2026-08-29T00:00:00.000Z',
    });
  }

  const queryConfig = {
    sources: ['google_autocomplete'] as QuerySuggestionSource[],
    maxSuggestionsPerSource: 20,
    maxParents: 200,
    rateLimitMinDelayMs: 0,
    rateLimitMaxDelayMs: 0,
    algorithmVersion: '1.0.0',
  };
  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: queryConfig }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: `/tmp/${enrichmentId}`,
    shortlistKeywords: ['json diff', 'csv parser', 'data merge', 'file converter'],
  });

  // Historical checkpoints used normalized text as their item id. This row is
  // intentionally ambiguous because source idx 0 and 1 both normalize to it.
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
      config: queryConfig,
      shortlist: ['json diff', 'csv parser', 'data merge', 'file converter'],
      logger: () => {},
      signal: { cancelled: false },
      collector,
      cache,
      researchConfig,
      debugRoot: `/tmp/${enrichmentId}/debug`,
    });

    assert.equal(collector.openCalls, 1);
    assert.equal(collector.collectCalls.length, 5, 'ambiguous legacy checkpoint must not skip either colliding source keyword');
    assert.deepEqual(
      collector.collectCalls.slice(0, 2).map((call) => normalizeKeyword(call.parentKeyword)),
      ['json diff', 'json diff'],
    );

    const itemIds = enrichmentStore.loadEnrichmentItems(enrichmentId)
      .filter((item) => item.module === 'query_suggestions')
      .map((item) => item.itemId);
    assert.ok(itemIds.includes('google_autocomplete:0'));
    assert.ok(itemIds.includes('google_autocomplete:1'));
    assert.ok(itemIds.includes('google_autocomplete:json diff'), 'legacy checkpoint remains preserved as compatibility evidence');

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
