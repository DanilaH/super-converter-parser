import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from '../db/store.js';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { ResearchError } from '../shared/errors.js';
import {
  defaultQuerySuggestionsConfig,
  runQuerySuggestionsModule,
  type CollectResult,
  type RawSourceCollection,
  type RawSuggestionOccurrence,
  type SuggestionCollector,
} from './querySuggestions.js';
import type { QuerySuggestionSource } from './types.js';

const SHORTLIST = ['json diff', 'compare lists', 'csv parser', 'data merge', 'file converter'];

function occurrence(
  parentKeyword: string,
  source: QuerySuggestionSource,
  rawText: string,
): RawSuggestionOccurrence {
  return {
    parentKeyword,
    normalizedParent: normalizeKeyword(parentKeyword),
    source,
    rawText,
    normalizedSuggestion: normalizeKeyword(rawText),
    ordinal: 0,
    volume: source === 'surfer_related' ? 100 : null,
    cpc: null,
  };
}

function collection(
  source: QuerySuggestionSource,
  occurrences: RawSuggestionOccurrence[] = [],
): RawSourceCollection {
  return {
    source,
    status: occurrences.length > 0 ? 'ok' : 'empty',
    occurrences,
    error: null,
    cacheStatus: 'none',
  };
}

function setupSourceRun(store: RunStore, config: ReturnType<typeof loadConfig>): string {
  const runId = 'partial-source-run';
  store.createRun({
    runId,
    configSnapshot: config,
    parserVersions: { surfer: '1.0.0', google: '1.2.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: SHORTLIST.map((keyword, index) => ({
      keyword,
      normalizedKeyword: normalizeKeyword(keyword),
      sourceRows: [index + 1],
    })),
  });
  for (const keyword of store.loadKeywords(runId)) {
    store.updateKeyword(runId, {
      ...keyword,
      status: 'completed',
      collectedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  return runId;
}

class PartialThenRecoveredCollector implements SuggestionCollector {
  calls: QuerySuggestionSource[][] = [];

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async collect(
    parentKeyword: string,
    _normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<CollectResult> {
    this.calls.push([...sources]);

    if (parentKeyword === 'json diff' && this.calls.length === 1) {
      return {
        collections: [
          collection('surfer_related', [occurrence(parentKeyword, 'surfer_related', 'json diff tool')]),
        ],
        navigationRequests: 1,
        xhrRequests: 1,
        partialError: new ResearchError('GOOGLE_UNAVAILABLE', 'Autocomplete HTTP 429 for "json diff"'),
      };
    }

    if (parentKeyword === 'json diff') {
      return {
        collections: [
          collection('google_autocomplete', [occurrence(parentKeyword, 'google_autocomplete', 'json diff online')]),
        ],
        navigationRequests: 1,
        xhrRequests: 1,
      };
    }

    return {
      collections: sources.map((source) => collection(source)),
      navigationRequests: 1,
      xhrRequests: sources.includes('google_autocomplete') ? 1 : 0,
    };
  }
}

test('partial source failure preserves completed sources and retries only missing sources', async () => {
  const researchConfig = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, researchConfig);
  const enrichmentId = 'partial-enrichment';
  const queryConfig = {
    ...defaultQuerySuggestionsConfig(),
    sources: ['surfer_related', 'google_autocomplete'] as QuerySuggestionSource[],
    rateLimitMinDelayMs: 0,
    rateLimitMaxDelayMs: 0,
  };

  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: queryConfig }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: `/tmp/${enrichmentId}`,
    shortlistKeywords: SHORTLIST,
  });

  const collector = new PartialThenRecoveredCollector();
  try {
    const result = await runQuerySuggestionsModule({
      enrichmentId,
      sourceStore,
      enrichmentStore,
      sourceRunId,
      config: queryConfig,
      shortlist: SHORTLIST,
      logger: () => {},
      signal: { cancelled: false },
      collector,
      cache,
      researchConfig,
      debugRoot: `/tmp/${enrichmentId}/debug`,
    });

    assert.deepEqual(
      collector.calls[0],
      ['surfer_related', 'google_autocomplete'],
      'first attempt requests both missing sources',
    );
    assert.deepEqual(
      collector.calls[1],
      ['google_autocomplete'],
      'retry must not re-request the already successful Surfer source',
    );

    assert.ok(
      result.suggestions.some((item) => item.normalizedSuggestion === normalizeKeyword('json diff tool')),
      'successful Surfer evidence from the partial first attempt must survive',
    );
    assert.ok(
      result.suggestions.some((item) => item.normalizedSuggestion === normalizeKeyword('json diff online')),
      'recovered autocomplete evidence must be merged with the preserved result',
    );
    assert.equal(result.sourceStats.surfer_related.ok, 1);
    assert.equal(result.sourceStats.google_autocomplete.ok, 1);
  } finally {
    sourceStore.close();
    enrichmentStore.close();
  }
});
