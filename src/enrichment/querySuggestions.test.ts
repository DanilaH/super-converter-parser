import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from '../db/store.js';
import { CacheStore } from '../cache/store.js';
import { loadConfig } from '../config/config.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { ResearchError } from '../shared/errors.js';
import {
  runQuerySuggestionsModule,
  buildQueryResultFromStore,
  defaultQuerySuggestionsConfig,
  dedupSuggestions,
  type SuggestionCollector,
  type RawSourceCollection,
  type RawSuggestionOccurrence,
} from './querySuggestions.js';
import type { QuerySuggestionSource } from './types.js';

function occ(
  parent: string,
  source: QuerySuggestionSource,
  text: string,
  extra: { volume?: number | null; cpc?: number | null; ordinal?: number | null } = {},
): RawSuggestionOccurrence {
  return {
    parentKeyword: parent,
    normalizedParent: normalizeKeyword(parent),
    source,
    rawText: text,
    normalizedSuggestion: normalizeKeyword(text),
    ordinal: extra.ordinal ?? null,
    volume: extra.volume ?? null,
    cpc: extra.cpc ?? null,
  };
}

function collection(source: QuerySuggestionSource, occurrences: RawSuggestionOccurrence[], status: RawSourceCollection['status'] = 'ok'): RawSourceCollection {
  return { source, status, occurrences, error: null, cacheStatus: 'none' };
}

class FakeCollector implements SuggestionCollector {
  openCalls = 0;
  closeCalls = 0;
  collectCalls = 0;
  constructor(private readonly plan: Record<string, RawSourceCollection[]>) {}
  async open(): Promise<void> {
    this.openCalls += 1;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
  async collect(parentKeyword: string, normalizedParent: string, sources: QuerySuggestionSource[]): Promise<RawSourceCollection[]> {
    this.collectCalls += 1;
    const planned = this.plan[normalizedParent] ?? [];
    return sources.map((source) => planned.find((c) => c.source === source) ?? collection(source, [], 'empty'));
  }
}

function setupSourceRun(store: RunStore, config: ReturnType<typeof loadConfig>): string {
  const runId = 'run-source';
  store.createRun({
    runId,
    configSnapshot: config,
    parserVersions: { surfer: '1.0.0', google: '1.2.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: [
      { keyword: 'json diff', normalizedKeyword: normalizeKeyword('json diff'), sourceRows: [1] },
      { keyword: 'compare lists', normalizedKeyword: normalizeKeyword('compare lists'), sourceRows: [2] },
      { keyword: 'csv parser', normalizedKeyword: normalizeKeyword('csv parser'), sourceRows: [3] },
      { keyword: 'data merge', normalizedKeyword: normalizeKeyword('data merge'), sourceRows: [4] },
      { keyword: 'file converter', normalizedKeyword: normalizeKeyword('file converter'), sourceRows: [5] },
    ],
  });
  for (const keyword of store.loadKeywords(runId)) {
    store.updateKeyword(runId, { ...keyword, status: 'completed', collectedAt: '2026-01-01T00:00:00.000Z' });
  }
  return runId;
}

function testShortlist(): string[] {
  return ['json diff', 'compare lists', 'csv parser', 'data merge', 'file converter'];
}

function createTestEnrichmentRun(
  store: RunStore,
  enrichmentId: string,
  sourceRunId: string,
  config: ReturnType<typeof loadConfig>,
  moduleConfig: Record<string, unknown> = { query_suggestions: defaultQuerySuggestionsConfig() },
): void {
  store.createEnrichmentRun({
    enrichmentId,
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify(moduleConfig),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: `/tmp/${enrichmentId}`,
    shortlistKeywords: testShortlist(),
  });
}

function plan(): Record<string, RawSourceCollection[]> {
  return {
    [normalizeKeyword('json diff')]: [
      collection('surfer_related', [occ('json diff', 'surfer_related', 'json diff tool', { volume: 5000, ordinal: 0 })]),
      collection('google_autocomplete', [occ('json diff', 'google_autocomplete', 'json diff online')]),
      collection('google_related_search', [occ('json diff', 'google_related_search', 'json comparison')]),
      collection('google_paa', [occ('json diff', 'google_paa', 'what is a json diff?')]),
    ],
    [normalizeKeyword('compare lists')]: [
      collection('surfer_related', [occ('compare lists', 'surfer_related', 'compare lists excel', { volume: 1200, ordinal: 0 })]),
      collection('google_autocomplete', [occ('compare lists', 'google_autocomplete', 'compare lists online')]),
      collection('google_related_search', [], 'empty'),
      collection('google_paa', [occ('compare lists', 'google_paa', 'how to compare two lists?')]),
    ],
    [normalizeKeyword('csv parser')]: [
      collection('surfer_related', [occ('csv parser', 'surfer_related', 'csv parser tool', { volume: 800, ordinal: 0 })]),
      collection('google_autocomplete', [occ('csv parser', 'google_autocomplete', 'csv parser online')]),
      collection('google_related_search', [occ('csv parser', 'google_related_search', 'csv viewer')]),
      collection('google_paa', [occ('csv parser', 'google_paa', 'what is a csv parser?')]),
    ],
    [normalizeKeyword('data merge')]: [
      collection('surfer_related', [occ('data merge', 'surfer_related', 'data merge tool', { volume: 600, ordinal: 0 })]),
      collection('google_autocomplete', [occ('data merge', 'google_autocomplete', 'data merge online')]),
      collection('google_related_search', [occ('data merge', 'google_related_search', 'merge datasets')]),
      collection('google_paa', [occ('data merge', 'google_paa', 'how to merge data?')]),
    ],
    [normalizeKeyword('file converter')]: [
      collection('surfer_related', [occ('file converter', 'surfer_related', 'file converter tool', { volume: 400, ordinal: 0 })]),
      collection('google_autocomplete', [occ('file converter', 'google_autocomplete', 'file converter online')]),
      collection('google_related_search', [occ('file converter', 'google_related_search', 'convert file format')]),
      collection('google_paa', [occ('file converter', 'google_paa', 'what is a file converter?')]),
    ],
  };
}

test('collects factual suggestions across all sources and dedups by normalized identity', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-1',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: defaultQuerySuggestionsConfig() }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-1',
    shortlistKeywords: testShortlist(),
  });
  const collector = new FakeCollector(plan());
  const cache = CacheStore.openInMemory();

  const result = await runQuerySuggestionsModule({
    enrichmentId: 'enr-1',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: defaultQuerySuggestionsConfig(),
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector,
    cache,
    researchConfig: config,
    debugRoot: '/tmp/enr-1/debug',
  });

  // 5 keywords: 4 + 3 + 4 + 4 + 4 = 19 distinct suggestions
  assert.equal(result.suggestions.length, 19);
  const surfer = result.suggestions.find((s) => s.normalizedSuggestion === normalizeKeyword('json diff tool'));
  assert.ok(surfer);
  assert.equal(surfer?.volume, 5000);
  assert.equal(surfer?.cpc, null);
  const autocomplete = result.suggestions.find((s) => s.normalizedSuggestion === normalizeKeyword('json diff online'));
  assert.ok(autocomplete);
  assert.equal(autocomplete?.volume, null, 'Google-sourced suggestions must keep volume null');

  // persisted in SQLite
  const saved = enrichmentStore.loadQuerySuggestions('enr-1');
  assert.equal(saved.length, 19);

  // does NOT mutate the discovery queue
  assert.equal(sourceStore.loadKeywords(sourceRunId).length, 5);
  assert.equal(collector.openCalls, 1);
  assert.equal(collector.closeCalls, 1);
});

test('one normalized suggestion retains every (parent, source) occurrence', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-2',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: defaultQuerySuggestionsConfig() }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-2',
    shortlistKeywords: testShortlist(),
  });
  // Both parents collect the SAME normalized suggestion text via different sources.
  const sharedPlan: Record<string, RawSourceCollection[]> = {
    [normalizeKeyword('json diff')]: [
      collection('google_autocomplete', [occ('json diff', 'google_autocomplete', 'shared phrase')]),
      collection('google_related_search', [occ('json diff', 'google_related_search', 'Shared Phrase')]),
    ],
    [normalizeKeyword('compare lists')]: [
      collection('google_autocomplete', [occ('compare lists', 'google_autocomplete', 'shared phrase')]),
    ],
  };
  const collector = new FakeCollector(sharedPlan);
  const result = await runQuerySuggestionsModule({
    enrichmentId: 'enr-2',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: defaultQuerySuggestionsConfig(),
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector,
    cache: CacheStore.openInMemory(),
    researchConfig: config,
    debugRoot: '/tmp/enr-2/debug',
  });
  const shared = result.suggestions.find((s) => s.normalizedSuggestion === normalizeKeyword('shared phrase'));
  assert.ok(shared);
  // 3 distinct occurrences: json diff autocomplete, json diff related, compare lists autocomplete
  assert.equal(shared?.occurrences.length, 3);
});

test('resume does not re-hit the browser for completed (parent, source) items', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-3',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: defaultQuerySuggestionsConfig() }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-3',
    shortlistKeywords: testShortlist(),
  });
  const collector = new FakeCollector(plan());
  const first = await runQuerySuggestionsModule({
    enrichmentId: 'enr-3',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: defaultQuerySuggestionsConfig(),
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector,
    cache: CacheStore.openInMemory(),
    researchConfig: config,
    debugRoot: '/tmp/enr-3/debug',
  });
  assert.equal(first.suggestions.length, 19);
  const collectCallsAfterFirst = collector.collectCalls;

  // Second run on the same enrichment store (items completed) with a fresh collector.
  const collector2 = new FakeCollector(plan());
  const second = await runQuerySuggestionsModule({
    enrichmentId: 'enr-3',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: defaultQuerySuggestionsConfig(),
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector: collector2,
    cache: CacheStore.openInMemory(),
    researchConfig: config,
    debugRoot: '/tmp/enr-3/debug',
  });
  assert.equal(collector2.collectCalls, 0, 'resume must not re-collect completed items');
  assert.equal(second.suggestions.length, 19);
  assert.ok(collectCallsAfterFirst > 0);
});

test('absent source is recorded as unavailable, not invented success', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-4',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: defaultQuerySuggestionsConfig() }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-4',
    shortlistKeywords: testShortlist(),
  });
  const unavailablePlan: Record<string, RawSourceCollection[]> = {
    [normalizeKeyword('json diff')]: [
      { source: 'surfer_related', status: 'unavailable', occurrences: [], error: 'SURFER_RELATED_WIDGET_MISSING', cacheStatus: 'none' },
      collection('google_autocomplete', [occ('json diff', 'google_autocomplete', 'json diff online')]),
    ],
  };
  const result = await runQuerySuggestionsModule({
    enrichmentId: 'enr-4',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: defaultQuerySuggestionsConfig(),
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector: new FakeCollector(unavailablePlan),
    cache: CacheStore.openInMemory(),
    researchConfig: config,
    debugRoot: '/tmp/enr-4/debug',
  });
  const surferStatus = result.perSourceStatus.find((s) => s.source === 'surfer_related');
  assert.equal(surferStatus?.status, 'unavailable');
  const saved = enrichmentStore.loadQuerySuggestions('enr-4');
  assert.ok(saved.every((s) => s.occurrences.every((o) => o.source !== 'surfer_related')));
});

test('buildQueryResultFromStore reconstructs without a browser', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-5',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: defaultQuerySuggestionsConfig() }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-5',
    shortlistKeywords: testShortlist(),
  });
  const result = await runQuerySuggestionsModule({
    enrichmentId: 'enr-5',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: defaultQuerySuggestionsConfig(),
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector: new FakeCollector(plan()),
    cache: CacheStore.openInMemory(),
    researchConfig: config,
    debugRoot: '/tmp/enr-1/debug',
  });

  // 5 keywords: 4 + 3 + 4 + 4 + 4 = 19 distinct suggestions
  assert.equal(result.suggestions.length, 19);
  const rebuilt = buildQueryResultFromStore('enr-5', enrichmentStore, defaultQuerySuggestionsConfig(), config);
  assert.equal(rebuilt.suggestions.length, 19);
});

test('dedupSuggestions keeps first non-null volume/cpc across colliding occurrences', () => {
  const occurrences: RawSuggestionOccurrence[] = [
    occ('json diff', 'surfer_related', 'shared term', { volume: 9000, ordinal: 0 }),
    occ('compare lists', 'google_autocomplete', 'shared term'),
  ];
  const suggestion = dedupSuggestions(occurrences, 'US', 'en', 'us')[0]!;
  assert.equal(suggestion.normalizedSuggestion, normalizeKeyword('shared term'));
  assert.equal(suggestion.volume, 9000);
  assert.equal(suggestion.cpc, null);
  assert.equal(suggestion.occurrences.length, 2);
});

test('interruption after first keyword persists data for completed sources', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-int',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: defaultQuerySuggestionsConfig() }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-int',
    shortlistKeywords: testShortlist(),
  });

  const fullPlan = plan();
  const firstKeywordOnly: Record<string, RawSourceCollection[]> = {
    [normalizeKeyword('json diff')]: fullPlan[normalizeKeyword('json diff')]!,
  };
  const collector = new FakeCollector(firstKeywordOnly);
  const cache = CacheStore.openInMemory();

  const result = await runQuerySuggestionsModule({
    enrichmentId: 'enr-int',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: defaultQuerySuggestionsConfig(),
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector,
    cache,
    researchConfig: config,
    debugRoot: '/tmp/enr-int/debug',
  });

  assert.equal(result.suggestions.length, 4);
  const saved = enrichmentStore.loadQuerySuggestions('enr-int');
  assert.equal(saved.length, 4);
  const items = enrichmentStore.loadEnrichmentItems('enr-int').filter(
    (i) => i.module === 'query_suggestions' && i.status === 'completed',
  );
  assert.equal(items.length, 20);
});

test('resume with non-default sources and cap preserves config', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  const limitedConfig: ReturnType<typeof defaultQuerySuggestionsConfig> = {
    ...defaultQuerySuggestionsConfig(),
    sources: ['google_autocomplete', 'google_paa'],
    maxSuggestionsPerSource: 5,
  };
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-cfg',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: limitedConfig }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-cfg',
    shortlistKeywords: testShortlist(),
  });

  const limitedPlan: Record<string, RawSourceCollection[]> = {
    [normalizeKeyword('json diff')]: [
      collection('google_autocomplete', [occ('json diff', 'google_autocomplete', 'json diff online')]),
      collection('google_paa', [occ('json diff', 'google_paa', 'what is a json diff?')]),
    ],
    [normalizeKeyword('compare lists')]: [
      collection('google_autocomplete', [occ('compare lists', 'google_autocomplete', 'compare lists online')]),
      collection('google_paa', [occ('compare lists', 'google_paa', 'how to compare two lists?')]),
    ],
  };
  const collector = new FakeCollector(limitedPlan);
  const cache = CacheStore.openInMemory();

  const result = await runQuerySuggestionsModule({
    enrichmentId: 'enr-cfg',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: limitedConfig,
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector,
    cache,
    researchConfig: config,
    debugRoot: '/tmp/enr-cfg/debug',
  });

  assert.equal(result.suggestions.length, 4);
  assert.deepEqual(result.config.sources, ['google_autocomplete', 'google_paa']);
  assert.equal(result.config.maxSuggestionsPerSource, 5);

  const rebuilt = buildQueryResultFromStore('enr-cfg', enrichmentStore, limitedConfig, config);
  assert.equal(rebuilt.suggestions.length, 4);
  assert.deepEqual(rebuilt.config.sources, ['google_autocomplete', 'google_paa']);
});

test('cold run provenance uses real parentKeyword (not empty string)', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-prov',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: defaultQuerySuggestionsConfig() }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-prov',
    shortlistKeywords: testShortlist(),
  });

  const simplePlan: Record<string, RawSourceCollection[]> = {
    [normalizeKeyword('json diff')]: [
      collection('google_autocomplete', [occ('json diff', 'google_autocomplete', 'json diff online')]),
    ],
    [normalizeKeyword('compare lists')]: [
      collection('google_autocomplete', [occ('compare lists', 'google_autocomplete', 'compare lists online')]),
    ],
    [normalizeKeyword('csv parser')]: [
      collection('google_autocomplete', [occ('csv parser', 'google_autocomplete', 'csv parser online')]),
    ],
    [normalizeKeyword('data merge')]: [
      collection('google_autocomplete', [occ('data merge', 'google_autocomplete', 'data merge online')]),
    ],
    [normalizeKeyword('file converter')]: [
      collection('google_autocomplete', [occ('file converter', 'google_autocomplete', 'file converter online')]),
    ],
  };
  const collector = new FakeCollector(simplePlan);
  const cache = CacheStore.openInMemory();

  const result = await runQuerySuggestionsModule({
    enrichmentId: 'enr-prov',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: defaultQuerySuggestionsConfig(),
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector,
    cache,
    researchConfig: config,
    debugRoot: '/tmp/enr-prov/debug',
  });

  const jsonDiffSuggestion = result.suggestions.find((s) => s.rawText === 'json diff online');
  assert.ok(jsonDiffSuggestion, 'json diff suggestion should exist');
  assert.equal(jsonDiffSuggestion?.parentKeyword, 'json diff');
  assert.equal(jsonDiffSuggestion?.occurrences[0]?.parentKeyword, 'json diff');

  const saved = enrichmentStore.loadQuerySuggestions('enr-prov');
  const savedJsonDiff = saved.find((s) => s.rawText === 'json diff online');
  assert.ok(savedJsonDiff, 'json diff suggestion should be persisted');
  assert.equal(savedJsonDiff?.occurrences[0]?.parentKeyword, 'json diff');

  const rebuilt = buildQueryResultFromStore('enr-prov', enrichmentStore, defaultQuerySuggestionsConfig(), config);
  const rebuiltJsonDiff = rebuilt.suggestions.find((s) => s.rawText === 'json diff online');
  assert.ok(rebuiltJsonDiff, 'json diff suggestion should be rebuilt');
  assert.equal(rebuiltJsonDiff?.parentKeyword, 'json diff');
  assert.equal(rebuiltJsonDiff?.occurrences[0]?.parentKeyword, 'json diff');
});

test('navigation failure throws and does not parse previous DOM', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-nav',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: defaultQuerySuggestionsConfig() }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-nav',
    shortlistKeywords: testShortlist(),
  });

  let callCount = 0;
  class NavFailCollector implements SuggestionCollector {
    openCalls = 0;
    closeCalls = 0;
    collectCalls = 0;
    async open(): Promise<void> {
      this.openCalls += 1;
    }
    async close(): Promise<void> {
      this.closeCalls += 1;
    }
    async collect(): Promise<RawSourceCollection[]> {
      this.collectCalls += 1;
      callCount += 1;
      if (callCount === 1) {
        throw new ResearchError('GOOGLE_UNAVAILABLE', 'Navigation failed');
      }
      return [
        {
          source: 'google_autocomplete',
          status: 'ok',
          occurrences: [occ('compare lists', 'google_autocomplete', 'compare lists online')],
          error: null,
          cacheStatus: 'none',
        },
      ];
    }
  }
  const collector = new NavFailCollector();
  const cache = CacheStore.openInMemory();

  const result = await runQuerySuggestionsModule({
    enrichmentId: 'enr-nav',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: { ...defaultQuerySuggestionsConfig(), sources: ['google_autocomplete'] },
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector,
    cache,
    researchConfig: config,
    debugRoot: '/tmp/enr-nav/debug',
  });

  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0]?.rawText, 'compare lists online');
  assert.ok(collector.collectCalls >= 2, 'should have retried after navigation failure');
});

test('persisted empty/unavailable/error states are restored on rebuild', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-states',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: defaultQuerySuggestionsConfig() }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-states',
    shortlistKeywords: testShortlist(),
  });

  const mixedPlan: Record<string, RawSourceCollection[]> = {
    [normalizeKeyword('json diff')]: [
      { source: 'surfer_related', status: 'unavailable', occurrences: [], error: 'SURFER_RELATED_WIDGET_MISSING', cacheStatus: 'none' },
      collection('google_autocomplete', [occ('json diff', 'google_autocomplete', 'json diff online')]),
      { source: 'google_related_search', status: 'empty', occurrences: [], error: null, cacheStatus: 'none' },
      { source: 'google_paa', status: 'error', occurrences: [], error: 'PAA_PARSE_ERROR', cacheStatus: 'none' },
    ],
    [normalizeKeyword('compare lists')]: [
      { source: 'surfer_related', status: 'unavailable', occurrences: [], error: 'SURFER_RELATED_WIDGET_MISSING', cacheStatus: 'none' },
      collection('google_autocomplete', [occ('compare lists', 'google_autocomplete', 'compare lists online')]),
      { source: 'google_related_search', status: 'empty', occurrences: [], error: null, cacheStatus: 'none' },
      { source: 'google_paa', status: 'error', occurrences: [], error: 'PAA_PARSE_ERROR', cacheStatus: 'none' },
    ],
    [normalizeKeyword('csv parser')]: [
      { source: 'surfer_related', status: 'unavailable', occurrences: [], error: 'SURFER_RELATED_WIDGET_MISSING', cacheStatus: 'none' },
      collection('google_autocomplete', [occ('csv parser', 'google_autocomplete', 'csv parser online')]),
      { source: 'google_related_search', status: 'empty', occurrences: [], error: null, cacheStatus: 'none' },
      { source: 'google_paa', status: 'error', occurrences: [], error: 'PAA_PARSE_ERROR', cacheStatus: 'none' },
    ],
    [normalizeKeyword('data merge')]: [
      { source: 'surfer_related', status: 'unavailable', occurrences: [], error: 'SURFER_RELATED_WIDGET_MISSING', cacheStatus: 'none' },
      collection('google_autocomplete', [occ('data merge', 'google_autocomplete', 'data merge online')]),
      { source: 'google_related_search', status: 'empty', occurrences: [], error: null, cacheStatus: 'none' },
      { source: 'google_paa', status: 'error', occurrences: [], error: 'PAA_PARSE_ERROR', cacheStatus: 'none' },
    ],
    [normalizeKeyword('file converter')]: [
      { source: 'surfer_related', status: 'unavailable', occurrences: [], error: 'SURFER_RELATED_WIDGET_MISSING', cacheStatus: 'none' },
      collection('google_autocomplete', [occ('file converter', 'google_autocomplete', 'file converter online')]),
      { source: 'google_related_search', status: 'empty', occurrences: [], error: null, cacheStatus: 'none' },
      { source: 'google_paa', status: 'error', occurrences: [], error: 'PAA_PARSE_ERROR', cacheStatus: 'none' },
    ],
  };
  const collector = new FakeCollector(mixedPlan);
  const cache = CacheStore.openInMemory();

  const result = await runQuerySuggestionsModule({
    enrichmentId: 'enr-states',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: defaultQuerySuggestionsConfig(),
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector,
    cache,
    researchConfig: config,
    debugRoot: '/tmp/enr-states/debug',
  });

  const surferStatus = result.perSourceStatus.find((s) => s.source === 'surfer_related');
  assert.equal(surferStatus?.status, 'unavailable');
  const autocompleteStatus = result.perSourceStatus.find((s) => s.source === 'google_autocomplete');
  assert.equal(autocompleteStatus?.status, 'ok');
  const relatedStatus = result.perSourceStatus.find((s) => s.source === 'google_related_search');
  assert.equal(relatedStatus?.status, 'empty');
  const paaStatus = result.perSourceStatus.find((s) => s.source === 'google_paa');
  assert.equal(paaStatus?.status, 'error');

  const rebuilt = buildQueryResultFromStore('enr-states', enrichmentStore, defaultQuerySuggestionsConfig(), config);
  const rebuiltSurfer = rebuilt.perSourceStatus.find((s) => s.source === 'surfer_related');
  assert.equal(rebuiltSurfer?.status, 'unavailable');
  const rebuiltAutocomplete = rebuilt.perSourceStatus.find((s) => s.source === 'google_autocomplete');
  assert.equal(rebuiltAutocomplete?.status, 'ok');
  const rebuiltRelated = rebuilt.perSourceStatus.find((s) => s.source === 'google_related_search');
  assert.equal(rebuiltRelated?.status, 'empty');
  const rebuiltPaa = rebuilt.perSourceStatus.find((s) => s.source === 'google_paa');
  assert.equal(rebuiltPaa?.status, 'error');

  const sourceRecords = enrichmentStore.loadQuerySuggestionSources('enr-states');
  const zeroRowRecords = sourceRecords.filter((r) => r.status !== 'ok');
  assert.equal(zeroRowRecords.length, 15);
});

test('maxSuggestionsPerSource caps collected suggestions', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-cap',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: { ...defaultQuerySuggestionsConfig(), maxSuggestionsPerSource: 2 } }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-cap',
    shortlistKeywords: testShortlist(),
  });

  const makeOccurrences = (parent: string) =>
    Array.from({ length: 10 }, (_, i) =>
      occ(parent, 'google_autocomplete', `${parent} suggestion ${i}`, { ordinal: i }),
    );
  const capPlan: Record<string, RawSourceCollection[]> = {
    [normalizeKeyword('json diff')]: [
      collection('google_autocomplete', makeOccurrences('json diff')),
    ],
    [normalizeKeyword('compare lists')]: [
      collection('google_autocomplete', makeOccurrences('compare lists')),
    ],
    [normalizeKeyword('csv parser')]: [
      collection('google_autocomplete', makeOccurrences('csv parser')),
    ],
    [normalizeKeyword('data merge')]: [
      collection('google_autocomplete', makeOccurrences('data merge')),
    ],
    [normalizeKeyword('file converter')]: [
      collection('google_autocomplete', makeOccurrences('file converter')),
    ],
  };
  const collector = new FakeCollector(capPlan);
  const cache = CacheStore.openInMemory();

  const result = await runQuerySuggestionsModule({
    enrichmentId: 'enr-cap',
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config: { ...defaultQuerySuggestionsConfig(), maxSuggestionsPerSource: 2 },
    shortlist: testShortlist(),
    logger: () => {},
    signal: { cancelled: false },
    collector,
    cache,
    researchConfig: config,
    debugRoot: '/tmp/enr-cap/debug',
  });

  assert.equal(result.suggestions.length, 10);
});

test('no-shortlist is rejected', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const sourceRunId = setupSourceRun(sourceStore, config);
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-nosl',
    sourceRunId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: defaultQuerySuggestionsConfig() }),
    sourceRunDirectory: `runs/${sourceRunId}`,
    enrichmentDirectory: '/tmp/enr-nosl',
    shortlistKeywords: testShortlist(),
  });

  const collector = new FakeCollector(plan());
  const cache = CacheStore.openInMemory();

  await assert.rejects(
    () => runQuerySuggestionsModule({
      enrichmentId: 'enr-nosl',
      sourceStore,
      enrichmentStore,
      sourceRunId,
      config: defaultQuerySuggestionsConfig(),
      shortlist: undefined,
      logger: () => {},
      signal: { cancelled: false },
      collector,
      cache,
      researchConfig: config,
      debugRoot: '/tmp/enr-nosl/debug',
    }),
    (error: Error) => error.message.includes('requires an explicit --shortlist'),
  );
});

test('maxParents limit prevents accidental large batches', async () => {
  const config = loadConfig(process.env);
  const sourceStore = RunStore.openInMemory();
  const enrichmentStore = RunStore.openInMemory();
  const runId = 'run-many';
  sourceStore.createRun({
    runId,
    configSnapshot: config,
    parserVersions: { surfer: '1.0.0', google: '1.2.0' },
    input: { kind: 'seeds', path: 'input/seeds.csv' },
    keywords: Array.from({ length: 50 }, (_, i) => ({
      keyword: `keyword ${i}`,
      normalizedKeyword: normalizeKeyword(`keyword ${i}`),
      sourceRows: [i + 1],
    })),
  });
  for (const keyword of sourceStore.loadKeywords(runId)) {
    sourceStore.updateKeyword(runId, { ...keyword, status: 'completed', collectedAt: '2026-01-01T00:00:00.000Z' });
  }
  enrichmentStore.createEnrichmentRun({
    enrichmentId: 'enr-maxp',
    sourceRunId: runId,
    modules: ['query_suggestions'],
    config: JSON.stringify({ query_suggestions: { ...defaultQuerySuggestionsConfig(), maxParents: 30 } }),
    sourceRunDirectory: `runs/${runId}`,
    enrichmentDirectory: '/tmp/enr-maxp',
    shortlistKeywords: Array.from({ length: 50 }, (_, i) => `keyword ${i}`),
  });

  const emptyPlan: Record<string, RawSourceCollection[]> = {};
  const collector = new FakeCollector(emptyPlan);

  await assert.rejects(
    () => runQuerySuggestionsModule({
      enrichmentId: 'enr-maxp',
      sourceStore,
      enrichmentStore,
      sourceRunId: runId,
      config: { ...defaultQuerySuggestionsConfig(), maxParents: 30 },
      shortlist: Array.from({ length: 50 }, (_, i) => `keyword ${i}`),
      logger: () => {},
      signal: { cancelled: false },
      collector,
      cache: CacheStore.openInMemory(),
      researchConfig: config,
      debugRoot: '/tmp/enr-maxp/debug',
    }),
    (error: Error) => error.message.includes('Too many parent keywords'),
  );
});
