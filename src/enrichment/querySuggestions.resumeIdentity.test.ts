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
import type { QuerySuggestionSource, QuerySuggestionsConfig } from './types.js';

const QUERY_CONFIG: QuerySuggestionsConfig = {
  sources: ['google_autocomplete'],
  maxSuggestionsPerSource: 20,
  maxParents: 200,
  rateLimitMinDelayMs: 0,
  rateLimitMaxDelayMs: 0,
  algorithmVersion: '1.0.0',
};

const KEYWORDS = ['legacy parent', 'second parent', 'third parent', 'fourth parent', 'fifth parent'];

class EmptyCollector implements SuggestionCollector {
  openCalls = 0;
  collectCalls: string[] = [];

  async open(): Promise<void> {
    this.openCalls += 1;
  }

  async close(): Promise<void> {}

  async collect(
    parentKeyword: string,
    _normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<CollectResult> {
    this.collectCalls.push(parentKeyword);
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

function setup(): {
  researchConfig: ReturnType<typeof loadConfig>;
  sourceStore: RunStore;
  enrichmentStore: RunStore;
  cache: CacheStore;
  sourceRunId: string;
  enrichmentId: string;
} {
  const researchConfig = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const sourceRunId = 'resume-identity-source';
  const enrichmentId = 'resume-identity-enrichment';

  sourceStore.createRun({
    runId: sourceRunId,
    configSnapshot: researchConfig,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: KEYWORDS.map((keyword, index) => ({
      keyword,
      normalizedKeyword: normalizeKeyword(keyword),
      sourceRows: [index + 1],
    })),
  });
  for (const keyword of sourceStore.loadKeywords(sourceRunId)) {
    sourceStore.updateKeyword(sourceRunId, {
      ...keyword,
      status: 'completed',
      collectedAt: '2026-08-29T00:00:00.000Z',
    });
  }

  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: QUERY_CONFIG }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: `/tmp/${enrichmentId}`,
    shortlistKeywords: KEYWORDS,
  });

  return { researchConfig, sourceStore, enrichmentStore, cache, sourceRunId, enrichmentId };
}

function saveSourceCheckpoint(
  store: RunStore,
  enrichmentId: string,
  researchConfig: ReturnType<typeof loadConfig>,
  status: 'empty' | 'error',
  parentKeywordIdx: number | null,
): void {
  store.saveQuerySuggestionSource(
    enrichmentId,
    normalizeKeyword(KEYWORDS[0]!),
    'google_autocomplete',
    status,
    status === 'error' ? 'GOOGLE_UNAVAILABLE' : null,
    '2026-08-28T00:00:00.000Z',
    'none',
    0,
    researchConfig.research.market,
    researchConfig.research.googleHl,
    researchConfig.research.googleGl,
    '1.0.0',
    parentKeywordIdx,
  );
}

test('unambiguous legacy source checkpoint is reused without inventing idx ownership', async () => {
  const { researchConfig, sourceStore, enrichmentStore, cache, sourceRunId, enrichmentId } = setup();
  saveSourceCheckpoint(enrichmentStore, enrichmentId, researchConfig, 'empty', null);
  enrichmentStore.upsertEnrichmentItem({
    enrichmentId,
    itemId: `google_autocomplete:${normalizeKeyword(KEYWORDS[0]!)}`,
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
      config: QUERY_CONFIG,
      shortlist: KEYWORDS,
      logger: () => {},
      signal: { cancelled: false },
      collector,
      cache,
      researchConfig,
      debugRoot: `/tmp/${enrichmentId}/debug`,
    });

    assert.equal(collector.openCalls, 1);
    assert.equal(collector.collectCalls.length, 4);
    assert.equal(collector.collectCalls.some((keyword) => normalizeKeyword(keyword) === normalizeKeyword(KEYWORDS[0]!)), false);

    const sourceRows = enrichmentStore.loadQuerySuggestionSources(enrichmentId);
    const legacy = sourceRows.find((row) => row.parentKeywordIdx === null);
    assert.equal(legacy?.normalizedParent, normalizeKeyword(KEYWORDS[0]!));
    assert.deepEqual(
      sourceRows
        .map((row) => row.parentKeywordIdx)
        .filter((idx): idx is number => idx !== null)
        .sort((a, b) => a - b),
      [1, 2, 3, 4],
    );
    assert.equal(result.inputCount, 5);
  } finally {
    cache.close();
    sourceStore.close();
    enrichmentStore.close();
  }
});

test('idx-owned error source checkpoint remains retryable regardless of lifecycle item state', async () => {
  const { researchConfig, sourceStore, enrichmentStore, cache, sourceRunId, enrichmentId } = setup();
  saveSourceCheckpoint(enrichmentStore, enrichmentId, researchConfig, 'error', 0);
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
      config: QUERY_CONFIG,
      shortlist: KEYWORDS,
      logger: () => {},
      signal: { cancelled: false },
      collector,
      cache,
      researchConfig,
      debugRoot: `/tmp/${enrichmentId}/debug`,
    });

    assert.equal(collector.openCalls, 1);
    assert.equal(collector.collectCalls.length, 5);
    assert.ok(collector.collectCalls.some((keyword) => normalizeKeyword(keyword) === normalizeKeyword(KEYWORDS[0]!)));

    const retried = enrichmentStore.loadQuerySuggestionSources(enrichmentId)
      .find((row) => row.parentKeywordIdx === 0 && row.source === 'google_autocomplete');
    assert.equal(retried?.status, 'empty');
    assert.equal(retried?.error, null);
    assert.equal(result.errorCount, 0);
    assert.equal(result.inputCount, 5);
  } finally {
    cache.close();
    sourceStore.close();
    enrichmentStore.close();
  }
});
