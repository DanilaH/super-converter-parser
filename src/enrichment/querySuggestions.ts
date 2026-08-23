import type { Browser, BrowserContext, Page } from 'playwright-core';
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

export type RawSourceCollection = {
  source: QuerySuggestionSource;
  status: QuerySuggestionCollectionStatus;
  occurrences: RawSuggestionOccurrence[];
  error: string | null;
  cacheStatus: 'hit' | 'miss' | 'expired' | 'refreshed' | 'none';
};

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

export class BrowserSuggestionCollector implements SuggestionCollector {
  private readonly context: BrowserContext;
  private readonly browser: Browser;
  private readonly config: ResearchConfig;
  private readonly debugRoot: string;
  private readonly signal: CancellationSignal;
  private page: Page | null = null;

  constructor(
    context: BrowserContext,
    browser: Browser,
    config: ResearchConfig,
    debugRoot: string,
    signal: CancellationSignal,
  ) {
    this.context = context;
    this.browser = browser;
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
    await this.browser.close().catch(() => undefined);
  }

  async collect(
    parentKeyword: string,
    normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<RawSourceCollection[]> {
    if (!this.page) throw new ResearchError('ENRICHMENT_ERROR', 'Collector used before open()');
    const page = this.page;

    const gotoResult = await page
      .goto(buildSearchUrl(this.config, parentKeyword), {
        waitUntil: 'domcontentloaded',
        timeout: this.config.browser.navigationTimeoutMs,
      })
      .then(() => ({ ok: true as const }))
      .catch((error) => ({ ok: false as const, error }));

    if (!gotoResult.ok) {
      const message = gotoResult.error instanceof Error ? gotoResult.error.message : String(gotoResult.error);
      throw new ResearchError('GOOGLE_UNAVAILABLE', `Navigation failed for "${parentKeyword}": ${message}`);
    }

    const results: RawSourceCollection[] = [];
    if (sources.includes('surfer_related')) {
      results.push(await this.collectSurferRelated(page, parentKeyword, normalizedParent));
    }
    if (sources.includes('google_related_search')) {
      results.push(await this.collectFromScript(page, parentKeyword, normalizedParent, 'google_related_search', RELATED_SEARCH_EXTRACT_SCRIPT, parseGoogleRelatedSearch));
    }
    if (sources.includes('google_paa')) {
      results.push(await this.collectFromScript(page, parentKeyword, normalizedParent, 'google_paa', PAA_EXTRACT_SCRIPT, parseGooglePaa));
    }
    if (sources.includes('google_autocomplete')) {
      results.push(await this.collectAutocomplete(page, parentKeyword, normalizedParent));
    }

    return results;
  }

  private async collectSurferRelated(page: Page, parentKeyword: string, normalizedParent: string): Promise<RawSourceCollection> {
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
        parentKeyword,
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
    parentKeyword: string,
    normalizedParent: string,
    source: QuerySuggestionSource,
    script: string,
    parse: (raw: string[]) => string[],
  ): Promise<RawSourceCollection> {
    try {
      const raw = (await page.evaluate(script)) as string[];
      const texts = parse((raw ?? []).map((r) => String(r)));
      const occurrences = makeOccurrences(parentKeyword, normalizedParent, source, texts, []);
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
      const occurrences = makeOccurrences(parentKeyword, normalizedParent, 'google_autocomplete', texts, []);
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

export async function createBrowserSuggestionCollector(
  config: ResearchConfig,
  debugRoot: string,
  signal: CancellationSignal,
): Promise<SuggestionCollector> {
  const browser = await connectResearchChrome(config.browser.cdpUrl);
  const context = getPrimaryContext(browser);
  return new BrowserSuggestionCollector(context, browser, config, debugRoot, signal);
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

  if (selectedKeywords.length > config.maxParents) {
    throw new ResearchError(
      'ENRICHMENT_ERROR',
      `Too many parent keywords (${selectedKeywords.length}) for query_suggestions; limit is ${config.maxParents}. Use --shortlist to limit the set.`,
    );
  }

  const completedItems = new Set(
    enrichmentStore
      .loadEnrichmentItems(enrichmentId)
      .filter((item) => item.module === 'query_suggestions' && item.status === 'completed')
      .map((item) => item.itemId),
  );

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

  const persistOccurrences = (): void => {
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

      const cacheMissSources: QuerySuggestionSource[] = [];
      for (const source of missingSources) {
        const cacheKey = buildSuggestionCacheKey(source, keyword.normalizedKeyword, identity, parserVersionForSource(source));
        const cached = cache.getSuggestion(cacheKey);
        if (cached && cached.status !== 'error') {
          const isExpired = Date.parse(cached.expiresAt) <= Date.now();
          if (!isExpired) {
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
            continue;
          }
          cacheMissSources.push(source);
        } else {
          cacheMissSources.push(source);
        }
      }

      if (cacheMissSources.length > 0) {
        const collected = await collectWithRetry(keyword.keyword, keyword.normalizedKeyword, cacheMissSources);
        for (const col of collected) {
          const cacheKey = buildSuggestionCacheKey(col.source, keyword.normalizedKeyword, identity, parserVersionForSource(col.source));
          const storedAt = new Date().toISOString();
          const rows = col.occurrences.slice(0, config.maxSuggestionsPerSource).map((o) => ({ text: o.rawText, volume: o.volume, cpc: o.cpc, ordinal: o.ordinal }));
          cache.putSuggestion(
            {
              cacheKey,
              source: col.source,
              normalizedParent: keyword.normalizedKeyword,
              identity,
              parserVersion: parserVersionForSource(col.source),
              status: col.status,
              error: col.error,
              suggestions: rows,
            },
            storedAt,
            ttlMsForSuggestionStatus(col.status, researchConfig.cache.ttl),
          );
          fetched.push({ ...col, cacheStatus: 'miss' });
        }
      }

      for (const collection of fetched) {
        for (const occ of collection.occurrences.slice(0, config.maxSuggestionsPerSource)) {
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

      persistOccurrences();

      for (const collection of fetched) {
        enrichmentStore.upsertEnrichmentItem({
          enrichmentId,
          itemId: `${collection.source}:${keyword.normalizedKeyword}`,
          module: 'query_suggestions',
          status: collection.status === 'error' ? 'error' : 'completed',
          source: sourceEnrichmentItemSource(collection.source),
          requestCount: collection.cacheStatus === 'hit' ? 0 : 1,
          fetchedAt: new Date().toISOString(),
          cacheStatus: collection.cacheStatus,
          error: collection.error,
        });

        enrichmentStore.saveQuerySuggestionSource(
          enrichmentId,
          keyword.normalizedKeyword,
          collection.source,
          collection.status,
          collection.error,
          new Date().toISOString(),
        );
      }

      logger(
        `  ${keyword.keyword}: ${fetched.map((f) => `${f.source}=${f.status}`).join(', ')}`,
      );

      if (config.rateLimitMinDelayMs > 0 || config.rateLimitMaxDelayMs > 0) {
        const minDelay = config.rateLimitMinDelayMs;
        const maxDelay = Math.max(minDelay, config.rateLimitMaxDelayMs);
        const delay = minDelay === maxDelay ? minDelay : minDelay + Math.floor(Math.random() * (maxDelay - minDelay));
        await sleep(delay);
      }
    }
  } finally {
    await collector.close();
  }

  const suggestions = dedupSuggestions(occurrences, market, hl, gl);

  persistOccurrences();

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

export function buildQueryResultFromStore(
  enrichmentId: string,
  enrichmentStore: RunStore,
  config: QuerySuggestionsConfig,
  researchConfig: ResearchConfig,
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

  const sourceRecords = enrichmentStore.loadQuerySuggestionSources(enrichmentId);
  for (const record of sourceRecords) {
    const source = record.source;
    const status = bySource.get(source);
    if (!status) continue;
    if (record.status === 'ok') {
      status.status = 'ok';
    } else if (record.status === 'empty') {
      if (status.status !== 'ok') status.status = 'empty';
      sourceStats[source].empty += 1;
    } else if (record.status === 'unavailable') {
      if (status.status !== 'ok') status.status = 'unavailable';
      sourceStats[source].unavailable += 1;
    } else {
      status.status = 'error';
      status.error = record.error;
      sourceStats[source].error += 1;
    }
  }

  for (const saved of enrichmentStore.loadQuerySuggestions(enrichmentId)) {
    for (const occ of saved.occurrences) {
      const source = occ.source as QuerySuggestionSource;
      const status = bySource.get(source);
      if (!status) continue;
      if (occ.collectionStatus === 'ok') {
        status.collected += 1;
      }
    }
  }

  const market = researchConfig.research.market;
  const hl = researchConfig.research.googleHl;
  const gl = researchConfig.research.googleGl;
  const suggestions = dedupSuggestions(occurrences, market, hl, gl);
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
    maxParents: 30,
    rateLimitMinDelayMs: 1000,
    rateLimitMaxDelayMs: 10000,
    algorithmVersion: QUERY_SUGGESTION_PARSER_VERSION,
  };
}
