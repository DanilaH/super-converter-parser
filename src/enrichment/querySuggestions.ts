import type { BrowserContext, Page } from 'playwright-core';
import { ResearchError } from '../shared/errors.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { connectResearchChrome, getPrimaryContext } from '../browser/cdp.js';
import { readSurferRelated } from '../surfer/parser.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { buildSearchUrl } from '../google/serp.js';
import {
  buildAutocompleteUrlForConfig,
  parseGoogleAutocomplete,
  GOOGLE_AUTOCOMPLETE_PARSER_VERSION,
} from '../google/autocomplete.js';
import {
  parseGoogleRelatedSearch,
  RELATED_SEARCH_EXTRACT_SCRIPT,
  GOOGLE_RELATED_SEARCH_PARSER_VERSION,
} from '../google/relatedSearch.js';
import {
  parseGooglePaa,
  PAA_EXTRACT_SCRIPT,
  GOOGLE_PAA_PARSER_VERSION,
} from '../google/paa.js';
import { keywordSlug } from '../runs/run.js';
import {
  saveParserFailureArtifacts,
  buildParserFailureContext,
} from '../diagnostics/artifacts.js';
import type { ResearchConfig } from '../config/config.js';
import type { SuggestionCache } from '../cache/store.js';
import { ttlMsForSuggestionStatus } from '../cache/store.js';
import { buildSuggestionCacheKey, keywordCacheIdentity, type CacheIdentity } from '../cache/keys.js';
import type { RunStore } from '../db/store.js';
import {
  QUERY_SUGGESTION_PARSER_VERSION,
  EnrichmentCancelledError,
  type EnrichmentLogger,
  type CancellationSignal,
  type QuerySuggestionSource,
  type QuerySuggestion,
  type QuerySuggestionCollectionStatus,
  type QuerySuggestionPerSourceStatus,
  type QuerySuggestionResult,
  type QuerySuggestionsConfig,
} from './types.js';

// One collected raw occurrence before dedup. Dedup keys on normalizedSuggestion;
// every occurrence is retained so a collision across parents/sources keeps its
// full provenance. Google-sourced rows keep volume/cpc null — this module never
// invents demand for them.
export type RawSuggestionOccurrence = {
  parentKeyword: string;
  normalizedParent: string;
  source: QuerySuggestionSource;
  rawText: string;
  normalizedSuggestion: string;
  ordinal: number | null;
  volume: number | null;
  cpc: number | null;
};

// One collected result for a single (parent, source) before dedup. The collector
// returns one of these per requested source.
export type RawSourceCollection = {
  source: QuerySuggestionSource;
  status: QuerySuggestionCollectionStatus;
  occurrences: RawSuggestionOccurrence[];
  error: string | null;
  cacheStatus: 'hit' | 'miss' | 'expired' | 'refreshed' | 'none';
};

// Abstraction over the browser so the module is unit-testable without a live
// Research Chrome. The real implementation navigates one SERP page and reads all
// requested sources from it (including the autocomplete XHR).
export interface SuggestionCollector {
  open(): Promise<void>;
  close(): Promise<void>;
  collect(
    parentKeyword: string,
    normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<RawSourceCollection[]>;
}

function parserVersionForSource(source: QuerySuggestionSource): string {
  switch (source) {
    case 'surfer_related':
      return SURFER_PARSER_VERSION;
    case 'google_autocomplete':
      return GOOGLE_AUTOCOMPLETE_PARSER_VERSION;
    case 'google_related_search':
      return GOOGLE_RELATED_SEARCH_PARSER_VERSION;
    case 'google_paa':
      return GOOGLE_PAA_PARSER_VERSION;
  }
}

function sourceEnrichmentItemSource(source: QuerySuggestionSource): 'google' | 'surfer' {
  return source === 'surfer_related' ? 'surfer' : 'google';
}

function makeOccurrences(
  parentKeyword: string,
  normalizedParent: string,
  source: QuerySuggestionSource,
  rawTexts: string[],
  structured: Array<{ text: string; volume: number | null; cpc: number | null; ordinal: number | null }>,
): RawSuggestionOccurrence[] {
  const out: RawSuggestionOccurrence[] = [];
  const useStructured = source === 'surfer_related' && structured.length > 0;
  const items = useStructured
    ? structured.map((row, index) => ({ text: row.text, volume: row.volume, cpc: row.cpc, ordinal: row.ordinal ?? index }))
    : rawTexts.map((text, index) => ({ text, volume: null, cpc: null, ordinal: index }));
  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    out.push({
      parentKeyword,
      normalizedParent,
      source,
      rawText: text,
      normalizedSuggestion: normalizeKeyword(text),
      ordinal: item.ordinal,
      volume: item.volume,
      cpc: item.cpc,
    });
  }
  return out;
}

// Deduplicates raw occurrences on normalizedSuggestion, retaining every parent/source
// occurrence. Representative rawText/volume/cpc/ordinal come from the first-seen
// occurrence; volume/cpc prefer the first non-null (only surfer_related supplies them).
export function dedupSuggestions(
  occurrences: RawSuggestionOccurrence[],
  market: string,
  hl: string,
  gl: string,
): QuerySuggestion[] {
  const bySuggestion = new Map<string, QuerySuggestion>();
  for (const occ of occurrences) {
    const existing = bySuggestion.get(occ.normalizedSuggestion);
    if (existing) {
      existing.occurrences.push({
        parentKeyword: occ.parentKeyword,
        normalizedParent: occ.normalizedParent,
        source: occ.source,
        market,
        hl,
        gl,
        parserVersion: parserVersionForSource(occ.source),
        collectionStatus: 'ok',
      });
      if (existing.volume === null && occ.volume !== null) existing.volume = occ.volume;
      if (existing.cpc === null && occ.cpc !== null) existing.cpc = occ.cpc;
      if (existing.ordinal === null && occ.ordinal !== null) existing.ordinal = occ.ordinal;
      continue;
    }
    bySuggestion.set(occ.normalizedSuggestion, {
      parentKeyword: occ.parentKeyword,
      normalizedParent: occ.normalizedParent,
      source: occ.source,
      rawText: occ.rawText,
      normalizedSuggestion: occ.normalizedSuggestion,
      ordinal: occ.ordinal,
      volume: occ.volume,
      cpc: occ.cpc,
      market,
      hl,
      gl,
      parserVersion: parserVersionForSource(occ.source),
      collectionStatus: 'ok',
      occurrences: [
        {
          parentKeyword: occ.parentKeyword,
          normalizedParent: occ.normalizedParent,
          source: occ.source,
          market,
          hl,
          gl,
          parserVersion: parserVersionForSource(occ.source),
          collectionStatus: 'ok',
        },
      ],
    });
  }
  return [...bySuggestion.values()];
}

function emptySourceStats(): QuerySuggestionResult['sourceStats'] {
  return {
    surfer_related: { ok: 0, empty: 0, unavailable: 0, error: 0 },
    google_autocomplete: { ok: 0, empty: 0, unavailable: 0, error: 0 },
    google_related_search: { ok: 0, empty: 0, unavailable: 0, error: 0 },
    google_paa: { ok: 0, empty: 0, unavailable: 0, error: 0 },
  };
}

function checkCancellation(signal: CancellationSignal, error: typeof EnrichmentCancelledError): void {
  if (signal.cancelled) throw new error();
}

// Real browser-backed collector. Opens the dedicated Research Chrome (TASK-009
// profile), navigates one SERP page per parent, and reads every requested source
// from that single page load: surfer_related via the Surfer sidebar, the Google
// related-searches and PAA blocks from the rendered DOM, and autocomplete via an
// XHR from the page context. Collected suggestion text is factual only; volume/CPC
// stay null for Google sources.
export class BrowserSuggestionCollector implements SuggestionCollector {
  private readonly context: BrowserContext;
  private readonly config: ResearchConfig;
  private readonly debugRoot: string;
  private readonly signal: CancellationSignal;
  private page: Page | null = null;

  constructor(
    context: BrowserContext,
    config: ResearchConfig,
    debugRoot: string,
    signal: CancellationSignal,
  ) {
    this.context = context;
    this.config = config;
    this.debugRoot = debugRoot;
    this.signal = signal;
  }

  async open(): Promise<void> {
    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => undefined);
    this.page = null;
  }

  async collect(
    parentKeyword: string,
    normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<RawSourceCollection[]> {
    if (!this.page) throw new ResearchError('ENRICHMENT_ERROR', 'Collector used before open()');
    const page = this.page;
    const results: RawSourceCollection[] = [];

    await page
      .goto(buildSearchUrl(this.config, parentKeyword), {
        waitUntil: 'domcontentloaded',
        timeout: this.config.browser.navigationTimeoutMs,
      })
      .catch(() => undefined);

    // surfer_related
    if (sources.includes('surfer_related')) {
      results.push(await this.collectSurferRelated(page, normalizedParent));
    }
    // google_related_search
    if (sources.includes('google_related_search')) {
      results.push(await this.collectFromScript(page, normalizedParent, 'google_related_search', RELATED_SEARCH_EXTRACT_SCRIPT, parseGoogleRelatedSearch));
    }
    // google_paa
    if (sources.includes('google_paa')) {
      results.push(await this.collectFromScript(page, normalizedParent, 'google_paa', PAA_EXTRACT_SCRIPT, parseGooglePaa));
    }
    // google_autocomplete (XHR from the page context)
    if (sources.includes('google_autocomplete')) {
      results.push(await this.collectAutocomplete(page, parentKeyword, normalizedParent));
    }

    return results;
  }

  private async collectSurferRelated(page: Page, normalizedParent: string): Promise<RawSourceCollection> {
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
      await page.waitForTimeout(1000);
      const rows = await readSurferRelated(
        page,
        this.config.browser.surferRelatedWidgetSelector,
        this.config.browser.surferWaitTimeoutMs,
        this.config.browser.surferRelatedMissingWidgetTimeoutMs,
      );
      if (rows === null) {
        return {
          source: 'surfer_related',
          status: 'unavailable',
          occurrences: [],
          error: 'SURFER_RELATED_WIDGET_MISSING',
          cacheStatus: 'none',
        };
      }
      const occurrences = makeOccurrences(
        '',
        normalizedParent,
        'surfer_related',
        [],
        rows.map((r, i) => ({ text: r.keyword, volume: r.volume, cpc: null, ordinal: i })),
      );
      return {
        source: 'surfer_related',
        status: occurrences.length > 0 ? 'ok' : 'empty',
        occurrences,
        error: null,
        cacheStatus: 'none',
      };
    } catch (error) {
      const code = error instanceof ResearchError ? error.code : 'SURFER_RELATED_PARSE_ERROR';
      return {
        source: 'surfer_related',
        status: 'error',
        occurrences: [],
        error: code,
        cacheStatus: 'none',
      };
    }
  }

  private async collectFromScript(
    page: Page,
    normalizedParent: string,
    source: QuerySuggestionSource,
    script: string,
    parse: (raw: string[]) => string[],
  ): Promise<RawSourceCollection> {
    try {
      const raw = (await page.evaluate(script)) as string[];
      const texts = parse((raw ?? []).map((r) => String(r)));
      const occurrences = makeOccurrences('', normalizedParent, source, texts, []);
      return {
        source,
        status: occurrences.length > 0 ? 'ok' : 'empty',
        occurrences,
        error: null,
        cacheStatus: 'none',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { source, status: 'error', occurrences: [], error: message, cacheStatus: 'none' };
    }
  }

  private async collectAutocomplete(page: Page, parentKeyword: string, normalizedParent: string): Promise<RawSourceCollection> {
    try {
      const url = buildAutocompleteUrlForConfig(this.config, parentKeyword);
      const payload = (await page.evaluate(async (target: string) => {
        const response = await fetch(target, { headers: { Accept: 'application/json' } });
        return response.text();
      }, url)) as string;
      const texts = parseGoogleAutocomplete(payload ?? '');
      const occurrences = makeOccurrences('', normalizedParent, 'google_autocomplete', texts, []);
      return {
        source: 'google_autocomplete',
        status: occurrences.length > 0 ? 'ok' : 'empty',
        occurrences,
        error: null,
        cacheStatus: 'none',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { source: 'google_autocomplete', status: 'error', occurrences: [], error: message, cacheStatus: 'none' };
    }
  }
}

// Builds the real collector from config, opening the dedicated Research Chrome
// connection so the module never touches the user's daily profile.
export async function createBrowserSuggestionCollector(
  config: ResearchConfig,
  debugRoot: string,
  signal: CancellationSignal,
): Promise<SuggestionCollector> {
  const browser = await connectResearchChrome(config.browser.cdpUrl);
  const context = getPrimaryContext(browser);
  return new BrowserSuggestionCollector(context, config, debugRoot, signal);
}

export type RunQuerySuggestionsOptions = {
  enrichmentId: string;
  sourceStore: RunStore;
  enrichmentStore: RunStore;
  sourceRunId: string;
  config: QuerySuggestionsConfig;
  shortlist: string[] | undefined;
  logger: EnrichmentLogger;
  signal: CancellationSignal;
  collector: SuggestionCollector;
  cache: SuggestionCache;
  researchConfig: ResearchConfig;
  debugRoot: string;
};

// Module runner. Collects factual query-language suggestions for every selected
// parent keyword across the configured sources. Crucially it ONLY reads existing
// discovery data and the browser; it never pushes collected suggestions back into
// the research/expansion queue. State is checkpointed per (parent, source) so an
// interruption resumes without repeating browser work. The cross-run cache avoids
// browser hits for already-collected (parent, source) pairs.
export async function runQuerySuggestionsModule(
  options: RunQuerySuggestionsOptions,
): Promise<QuerySuggestionResult> {
  const {
    enrichmentId,
    sourceStore,
    enrichmentStore,
    sourceRunId,
    config,
    shortlist,
    logger,
    signal,
    collector,
    cache,
    researchConfig,
    debugRoot,
  } = options;

  const identity: CacheIdentity = keywordCacheIdentity(researchConfig);
  const market = researchConfig.research.market;
  const hl = researchConfig.research.googleHl;
  const gl = researchConfig.research.googleGl;

  const allKeywords = sourceStore
    .loadKeywords(sourceRunId)
    .filter((k) => k.status === 'completed' || k.status === 'partial')
    .map((k) => ({ keyword: k.keyword, normalizedKeyword: k.normalizedKeyword }));

  if (allKeywords.length === 0) {
    throw new ResearchError(
      'ENRICHMENT_ERROR',
      `No completed keywords with data found in source run (got ${allKeywords.length} keywords from ${sourceRunId})`,
    );
  }

  let selectedKeywords = allKeywords;
  if (shortlist && shortlist.length > 0) {
    const shortlistSet = new Set(shortlist.map(normalizeKeyword));
    const available = new Set(allKeywords.map((k) => k.normalizedKeyword));
    const rejected = [...shortlistSet].filter((k) => !available.has(k));
    if (rejected.length > 0) {
      throw new ResearchError('ENRICHMENT_ERROR', `Shortlist keywords not found in source run: ${rejected.join(', ')}`);
    }
    selectedKeywords = allKeywords.filter((k) => shortlistSet.has(k.normalizedKeyword));
  }

  // Completed (parent, source) checkpoints from a prior run/resume.
  const completedItems = new Set(
    enrichmentStore
      .loadEnrichmentItems(enrichmentId)
      .filter((item) => item.module === 'query_suggestions' && item.status === 'completed')
      .map((item) => item.itemId),
  );

  // Load already-persisted deduped suggestions (resume) so we keep them.
  const occurrences: RawSuggestionOccurrence[] = [];
  for (const saved of enrichmentStore.loadQuerySuggestions(enrichmentId)) {
    for (const occ of saved.occurrences) {
      occurrences.push({
        parentKeyword: occ.parentKeyword,
        normalizedParent: occ.normalizedParent,
        source: occ.source as QuerySuggestionSource,
        rawText: saved.rawText,
        normalizedSuggestion: saved.normalizedSuggestion,
        ordinal: saved.ordinal,
        volume: saved.volume,
        cpc: saved.cpc,
      });
    }
  }

  const perSourceStatus = new Map<QuerySuggestionSource, QuerySuggestionPerSourceStatus>();
  for (const source of config.sources) {
    perSourceStatus.set(source, { source, status: 'empty', collected: 0, error: null });
  }
  const sourceStats = emptySourceStats();
  const seenSuggestionKeys = new Set(occurrences.map((o) => `${o.source}:${o.normalizedParent}:${o.normalizedSuggestion}`));

  // Bounded retry helper for retryable browser/network errors per (parent, source).
  const collectWithRetry = async (
    parentKeyword: string,
    normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<RawSourceCollection[]> => {
    const maxAttempts = 3;
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await collector.collect(parentKeyword, normalizedParent, sources);
      } catch (error) {
        const code = error instanceof ResearchError ? error.code : 'GOOGLE_UNAVAILABLE';
        if (code === 'RUN_PAUSED') throw error;
        lastError = code;
        if (attempt < maxAttempts) await sleep(1000 * attempt);
      }
    }
    return sources.map((source) => ({
      source,
      status: 'error' as QuerySuggestionCollectionStatus,
      occurrences: [],
      error: lastError,
      cacheStatus: 'none' as const,
    }));
  };

  await collector.open();
  try {
    for (const keyword of selectedKeywords) {
      checkCancellation(signal, EnrichmentCancelledError);

      const missingSources = config.sources.filter(
        (source) => !completedItems.has(`${source}:${keyword.normalizedKeyword}`),
      );
      if (missingSources.length === 0) continue;

      const fetched: RawSourceCollection[] = [];
      for (const source of missingSources) {
        const cacheKey = buildSuggestionCacheKey(source, keyword.normalizedKeyword, identity, parserVersionForSource(source));
        const cached = cache.getSuggestion(cacheKey);
        if (cached && cached.status !== 'error') {
          const rows = cached.suggestions;
          const occurrencesForSource = makeOccurrences(
            keyword.keyword,
            keyword.normalizedKeyword,
            source,
            rows.map((r) => r.text),
            rows.map((r, i) => ({ text: r.text, volume: r.volume, cpc: r.cpc, ordinal: r.ordinal ?? i })),
          );
          fetched.push({
            source,
            status: cached.status === 'ok' ? (occurrencesForSource.length > 0 ? 'ok' : 'empty') : cached.status,
            occurrences: occurrencesForSource,
            error: cached.error,
            cacheStatus: 'hit',
          });
        } else {
          const collected = (await collectWithRetry(keyword.keyword, keyword.normalizedKeyword, [source]))[0]!;
          fetched.push(collected);
        }
      }

      for (const collection of fetched) {
        // Persist cache (records texts so a future run skips the browser).
        const cacheKey = buildSuggestionCacheKey(
          collection.source,
          keyword.normalizedKeyword,
          identity,
          parserVersionForSource(collection.source),
        );
        const storedAt = new Date().toISOString();
        const rows = collection.occurrences.map((o) => ({ text: o.rawText, volume: o.volume, cpc: o.cpc, ordinal: o.ordinal }));
        cache.putSuggestion(
          {
            cacheKey,
            source: collection.source,
            normalizedParent: keyword.normalizedKeyword,
            identity,
            parserVersion: parserVersionForSource(collection.source),
            status: collection.status,
            error: collection.error,
            suggestions: rows,
          },
          storedAt,
          ttlMsForSuggestionStatus(collection.status, researchConfig.cache.ttl),
        );

        // Per (parent, source) checkpoint item.
        enrichmentStore.upsertEnrichmentItem({
          enrichmentId,
          itemId: `${collection.source}:${keyword.normalizedKeyword}`,
          module: 'query_suggestions',
          status: collection.status === 'error' ? 'error' : 'completed',
          source: sourceEnrichmentItemSource(collection.source),
          requestCount: 1,
          fetchedAt: storedAt,
          cacheStatus: collection.cacheStatus,
          error: collection.error,
        });

        // Accumulate occurrences (skip ones already present from a prior save).
        for (const occ of collection.occurrences) {
          const key = `${occ.source}:${occ.normalizedParent}:${occ.normalizedSuggestion}`;
          if (seenSuggestionKeys.has(key)) continue;
          seenSuggestionKeys.add(key);
          occurrences.push(occ);
        }

        const status = perSourceStatus.get(collection.source)!;
        if (collection.status === 'ok') {
          status.status = 'ok';
          status.collected += collection.occurrences.length;
          sourceStats[collection.source].ok += 1;
        } else if (collection.status === 'empty') {
          if (status.status === 'empty') status.status = 'empty';
          sourceStats[collection.source].empty += 1;
        } else if (collection.status === 'unavailable') {
          status.status = 'unavailable';
          sourceStats[collection.source].unavailable += 1;
        } else {
          status.status = 'error';
          status.error = collection.error;
          sourceStats[collection.source].error += 1;
        }
      }

      logger(
        `  ${keyword.keyword}: ${fetched.map((f) => `${f.source}=${f.status}`).join(', ')}`,
      );
    }
  } finally {
    await collector.close();
  }

  const suggestions = dedupSuggestions(occurrences, market, hl, gl);

  enrichmentStore.saveQuerySuggestions(
    enrichmentId,
    suggestions.map((s) => ({
      normalizedSuggestion: s.normalizedSuggestion,
      rawText: s.rawText,
      volume: s.volume,
      cpc: s.cpc,
      ordinal: s.ordinal,
      market: s.market,
      hl: s.hl,
      gl: s.gl,
      parserVersion: s.parserVersion,
      collectionStatus: s.collectionStatus,
      occurrences: s.occurrences.map((o) => ({
        parentKeyword: o.parentKeyword,
        normalizedParent: o.normalizedParent,
        source: o.source,
        market: o.market,
        hl: o.hl,
        gl: o.gl,
        parserVersion: o.parserVersion,
        collectionStatus: o.collectionStatus,
      })),
    })),
  );

  const emptyCount = suggestions.filter((s) => s.occurrences.every((o) => o.collectionStatus !== 'ok')).length;
  const errorCount = [...perSourceStatus.values()].filter((s) => s.status === 'error').length;

  return {
    enrichmentId,
    suggestions,
    perSourceStatus: [...perSourceStatus.values()],
    inputCount: selectedKeywords.length,
    emptyCount,
    errorCount,
    sourceStats,
    algorithmVersion: QUERY_SUGGESTION_PARSER_VERSION,
    config,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Rebuilds a QuerySuggestionResult purely from persisted store state, so a
// resume of an already-completed query_suggestions module does not reopen the
// browser. Distinct from a fresh run: this trusts the persisted deduped set.
export function buildQueryResultFromStore(
  enrichmentId: string,
  enrichmentStore: RunStore,
  config: QuerySuggestionsConfig,
): QuerySuggestionResult {
  const occurrences: RawSuggestionOccurrence[] = [];
  for (const saved of enrichmentStore.loadQuerySuggestions(enrichmentId)) {
    for (const occ of saved.occurrences) {
      occurrences.push({
        parentKeyword: occ.parentKeyword,
        normalizedParent: occ.normalizedParent,
        source: occ.source as QuerySuggestionSource,
        rawText: saved.rawText,
        normalizedSuggestion: saved.normalizedSuggestion,
        ordinal: saved.ordinal,
        volume: saved.volume,
        cpc: saved.cpc,
      });
    }
  }

  const bySource = new Map<QuerySuggestionSource, QuerySuggestionPerSourceStatus>();
  for (const source of config.sources) {
    bySource.set(source, { source, status: 'empty', collected: 0, error: null });
  }
  const sourceStats = emptySourceStats();

  // Per-source truth comes from the persisted collection statuses on each saved
  // suggestion occurrence, not from the coarse item status (which collapses
  // 'unavailable' into 'completed'). This keeps unavailable/empty/error truthful
  // across a resume without reopening the browser.
  for (const saved of enrichmentStore.loadQuerySuggestions(enrichmentId)) {
    for (const occ of saved.occurrences) {
      const source = occ.source as QuerySuggestionSource;
      const status = bySource.get(source);
      if (!status) continue;
      if (occ.collectionStatus === 'ok') {
        status.status = 'ok';
        status.collected += 1;
        sourceStats[source].ok += 1;
      } else if (occ.collectionStatus === 'empty') {
        status.status = 'empty';
        sourceStats[source].empty += 1;
      } else if (occ.collectionStatus === 'unavailable') {
        status.status = 'unavailable';
        sourceStats[source].unavailable += 1;
      } else {
        status.status = 'error';
        status.error = occ.collectionStatus;
        sourceStats[source].error += 1;
      }
    }
  }

  const market = occurrences[0]?.source ? '' : '';
  const suggestions = dedupSuggestions(occurrences, market, '', '');
  const emptyCount = suggestions.filter((s) => s.occurrences.every((o) => o.collectionStatus !== 'ok')).length;
  const errorCount = [...bySource.values()].filter((s) => s.status === 'error').length;
  const inputCount = new Set(occurrences.map((o) => o.normalizedParent)).size;

  return {
    enrichmentId,
    suggestions,
    perSourceStatus: [...bySource.values()],
    inputCount,
    emptyCount,
    errorCount,
    sourceStats,
    algorithmVersion: QUERY_SUGGESTION_PARSER_VERSION,
    config,
  };
}

export function defaultQuerySuggestionsConfig(): QuerySuggestionsConfig {
  return {
    sources: ['surfer_related', 'google_autocomplete', 'google_related_search', 'google_paa'],
    maxSuggestionsPerSource: 20,
    rateLimitMinDelayMs: 1000,
    rateLimitMaxDelayMs: 10000,
    algorithmVersion: QUERY_SUGGESTION_PARSER_VERSION,
  };
}
