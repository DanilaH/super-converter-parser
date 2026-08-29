import type { Browser, BrowserContext, Page } from 'playwright-core';
import { ResearchError, type ResearchErrorCode } from '../shared/errors.js';
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
import { waitForManualCaptcha, pauseForManualCaptcha } from '../browser/captcha.js';
import type { ResearchConfig } from '../config/config.js';
import type { SuggestionCache } from '../cache/store.js';
import { ttlMsForSuggestionStatus } from '../cache/store.js';
import { buildSuggestionCacheKey, keywordCacheIdentity, type CacheIdentity } from '../cache/keys.js';
import type { RunStore, StoredRelatedKeyword } from '../db/store.js';
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
  // Browser/cache collectors operate on semantic text and may not know the
  // source-run relation. runQuerySuggestionsModule assigns the concrete idx
  // before persistence. Historical persisted occurrences can remain null.
  parentKeywordIdx?: number | null;
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
  cacheStatus: 'hit' | 'source_run' | 'miss' | 'expired' | 'refreshed' | 'none';
};

export interface CollectResult {
  collections: RawSourceCollection[];
  navigationRequests: number;
  xhrRequests: number;
  partialError?: ResearchError | null;
}

export interface SuggestionCollector {
  open(): Promise<void>;
  close(): Promise<void>;
  collect(
    parentKeyword: string,
    normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<CollectResult>;
}

export function classifyHttpResponse(status: number, parentKeyword: string): ResearchError {
  return new ResearchError('GOOGLE_UNAVAILABLE', `Autocomplete HTTP ${status} for "${parentKeyword}"`, { httpStatus: status });
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

function makeOccurrences(
  parentKeyword: string,
  normalizedParent: string,
  source: QuerySuggestionSource,
  rawTexts: string[],
  structured: Array<{ text: string; volume: number | null; cpc: number | null; ordinal: number | null }>,
  parentKeywordIdx: number | null = null,
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
      parentKeywordIdx,
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

function parentIdentityKey(parentKeywordIdx: number | null | undefined, normalizedParent: string): string {
  return parentKeywordIdx === null || parentKeywordIdx === undefined
    ? `legacy:${normalizedParent}`
    : `idx:${parentKeywordIdx}`;
}

function occurrenceIdentityKey(occurrence: RawSuggestionOccurrence): string {
  return `${occurrence.source}:${parentIdentityKey(occurrence.parentKeywordIdx, occurrence.normalizedParent)}:${occurrence.normalizedSuggestion}`;
}

export function countPersistedQueryParents(
  records: readonly Array<{ parentKeywordIdx: number | null; normalizedParent: string }>,
): number {
  const concreteIds = new Set<number>();
  const concreteTexts = new Set<string>();
  const legacyTexts = new Set<string>();

  for (const record of records) {
    if (record.parentKeywordIdx === null) {
      legacyTexts.add(record.normalizedParent);
      continue;
    }
    concreteIds.add(record.parentKeywordIdx);
    concreteTexts.add(record.normalizedParent);
  }

  let legacyOnlyCount = 0;
  for (const normalizedParent of legacyTexts) {
    if (!concreteTexts.has(normalizedParent)) legacyOnlyCount += 1;
  }
  return concreteIds.size + legacyOnlyCount;
}

export function dedupSuggestions(
  occurrences: RawSuggestionOccurrence[],
  market: string,
  hl: string,
  gl: string,
): QuerySuggestion[] {
  const bySuggestion = new Map<string, QuerySuggestion>();
  for (const occ of occurrences) {
    const parentKeywordIdx = occ.parentKeywordIdx ?? null;
    const existing = bySuggestion.get(occ.normalizedSuggestion);
    if (existing) {
      existing.occurrences.push({
        parentKeywordIdx,
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
      parentKeywordIdx,
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
          parentKeywordIdx,
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

export function buildDiscoverySurferCollections(
  rows: readonly StoredRelatedKeyword[],
): Map<number, RawSourceCollection> {
  const grouped = new Map<number, StoredRelatedKeyword[]>();
  for (const row of rows) {
    const group = grouped.get(row.parentIdx) ?? [];
    group.push(row);
    grouped.set(row.parentIdx, group);
  }

  const collections = new Map<number, RawSourceCollection>();
  for (const [parentKeywordIdx, group] of grouped) {
    const parentKeyword = group[0]?.parentKeyword ?? '';
    const normalizedParent = normalizeKeyword(parentKeyword);
    const successful = group.filter((row) => row.status === 'ok' && row.relatedKeyword.trim() !== '');
    if (successful.length > 0) {
      collections.set(parentKeywordIdx, {
        source: 'surfer_related',
        status: 'ok',
        occurrences: successful.map((row, ordinal) => ({
          parentKeywordIdx,
          parentKeyword: row.parentKeyword,
          normalizedParent,
          source: 'surfer_related',
          rawText: row.relatedKeyword,
          normalizedSuggestion: normalizeKeyword(row.relatedKeyword),
          ordinal,
          volume: row.volume,
          cpc: null,
        })),
        error: null,
        cacheStatus: 'source_run',
      });
      continue;
    }

    if (group.some((row) => row.status === 'empty')) {
      collections.set(parentKeywordIdx, {
        source: 'surfer_related',
        status: 'empty',
        occurrences: [],
        error: null,
        cacheStatus: 'source_run',
      });
    }
  }
  return collections;
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

  private async saveFailureArtifacts(
    page: Page,
    parentKeyword: string,
    errorCode: ResearchErrorCode,
    errorMessage: string,
  ): Promise<void> {
    if (!this.debugRoot) return;
    const context = buildParserFailureContext(
      parentKeyword,
      page.url(),
      this.config,
      errorCode,
      errorMessage,
    );
    await saveParserFailureArtifacts(
      page,
      this.config,
      this.debugRoot,
      keywordSlug(parentKeyword),
      context,
    ).catch(() => undefined);
  }

  async collect(
    parentKeyword: string,
    normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<CollectResult> {
    if (!this.page) throw new ResearchError('ENRICHMENT_ERROR', 'Collector used before open()');
    if (this.signal.cancelled) throw new EnrichmentCancelledError();
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

    if (this.signal.cancelled) throw new EnrichmentCancelledError();

    try {
      await waitForManualCaptcha(page);
    } catch (error) {
      if (error instanceof ResearchError && error.code === 'CAPTCHA_REQUIRED') {
        await this.saveFailureArtifacts(page, parentKeyword, 'CAPTCHA_REQUIRED', 'Google is asking for manual verification');
        const captchaSignal = { isCancelled: () => this.signal.cancelled };
        const solved = await pauseForManualCaptcha(page, captchaSignal);
        if (!solved) throw new EnrichmentCancelledError();
      } else {
        throw error;
      }
    }

    let xhrRequests = 0;
    const results: RawSourceCollection[] = [];
    let partialError: ResearchError | null = null;
    const collectSource = async (work: () => Promise<RawSourceCollection>): Promise<void> => {
      try {
        results.push(await work());
      } catch (error) {
        if (error instanceof EnrichmentCancelledError) throw error;
        const sourceError = error instanceof ResearchError
          ? error
          : new ResearchError('ENRICHMENT_ERROR', error instanceof Error ? error.message : String(error));
        partialError ??= sourceError;
      }
    };

    // Each source is isolated within the same SERP navigation. A failing source
    // must not prevent later sources from being attempted; successful siblings
    // are returned immediately and the retry wrapper will request only sources
    // that produced no collection.
    if (sources.includes('surfer_related')) {
      await collectSource(() => this.collectSurferRelated(page, parentKeyword, normalizedParent));
    }
    if (sources.includes('google_related_search')) {
      await collectSource(() => this.collectFromScript(page, parentKeyword, normalizedParent, 'google_related_search', RELATED_SEARCH_EXTRACT_SCRIPT, parseGoogleRelatedSearch));
    }
    if (sources.includes('google_paa')) {
      await collectSource(() => this.collectFromScript(page, parentKeyword, normalizedParent, 'google_paa', PAA_EXTRACT_SCRIPT, parseGooglePaa));
    }
    if (sources.includes('google_autocomplete')) {
      xhrRequests += 1;
      await collectSource(() => this.collectAutocomplete(page, parentKeyword, normalizedParent));
    }

    return { collections: results, navigationRequests: 1, xhrRequests, partialError };
  }

  private async collectSurferRelated(page: Page, parentKeyword: string, normalizedParent: string): Promise<RawSourceCollection> {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
    await page.waitForTimeout(1000);
    const rows = await readSurferRelated(
      page,
      this.config.browser.surferRelatedWidgetSelector,
      this.config.browser.surferWaitTimeoutMs,
      this.config.browser.surferRelatedMissingWidgetTimeoutMs,
    );
    if (rows === null) {
      await this.saveFailureArtifacts(page, parentKeyword, 'SURFER_RELATED_WIDGET_MISSING', 'Surfer related widget not found on page');
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
      await this.saveFailureArtifacts(page, parentKeyword, 'GOOGLE_SERP_PARSE_ERROR', `Script evaluate/parse failed for ${source}: ${message}`);
      throw new ResearchError('GOOGLE_SERP_PARSE_ERROR', `Script evaluate/parse failed for ${source}: ${message}`);
    }
  }

  private async collectAutocomplete(page: Page, parentKeyword: string, normalizedParent: string): Promise<RawSourceCollection> {
    try {
      const url = buildAutocompleteUrlForConfig(this.config, parentKeyword);
      const timeoutMs = this.config.browser.navigationTimeoutMs;
      const response = (await page.evaluate(async ({ target, timeoutMs }: { target: string; timeoutMs: number }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(target, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          });
          const body = await res.text();
          return { status: res.status, ok: res.ok, body };
        } finally {
          clearTimeout(timer);
        }
      }, { target: url, timeoutMs })) as { status: number; ok: boolean; body: string };

      if (!response.ok) {
        throw classifyHttpResponse(response.status, parentKeyword);
      }

      const texts = parseGoogleAutocomplete(response.body ?? '');
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
      await this.saveFailureArtifacts(page, parentKeyword, 'GOOGLE_SERP_PARSE_ERROR', `Autocomplete fetch/parse failed: ${message}`);
      if (error instanceof ResearchError) throw error;
      throw new ResearchError('GOOGLE_SERP_PARSE_ERROR', `Autocomplete fetch/parse failed: ${message}`);
    }
  }
}

export function createBrowserSuggestionCollector(
  config: ResearchConfig,
  debugRoot: string,
  signal: CancellationSignal,
): SuggestionCollector {
  return new LazyBrowserSuggestionCollector(config, debugRoot, signal);
}

class LazyBrowserSuggestionCollector implements SuggestionCollector {
  private readonly config: ResearchConfig;
  private readonly debugRoot: string;
  private readonly signal: CancellationSignal;
  private inner: BrowserSuggestionCollector | null = null;
  private browser: Browser | null = null;

  constructor(config: ResearchConfig, debugRoot: string, signal: CancellationSignal) {
    this.config = config;
    this.debugRoot = debugRoot;
    this.signal = signal;
  }

  private async ensureConnected(): Promise<BrowserSuggestionCollector> {
    if (!this.inner) {
      this.browser = await connectResearchChrome(this.config.browser.cdpUrl);
      const context = getPrimaryContext(this.browser);
      this.inner = new BrowserSuggestionCollector(context, this.browser, this.config, this.debugRoot, this.signal);
    }
    return this.inner;
  }

  async open(): Promise<void> {
    const inner = await this.ensureConnected();
    await inner.open();
  }

  async close(): Promise<void> {
    if (this.inner) {
      await this.inner.close();
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
    this.inner = null;
  }

  async collect(
    parentKeyword: string,
    normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<CollectResult> {
    const inner = await this.ensureConnected();
    return inner.collect(parentKeyword, normalizedParent, sources);
  }
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
    .map((k) => ({ keywordIdx: k.idx, keyword: k.keyword, normalizedKeyword: k.normalizedKeyword }));

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
  } else {
    throw new ResearchError(
      'ENRICHMENT_ERROR',
      'query_suggestions requires an explicit --shortlist of 5-200 parent keywords. Full-source-run mode is not supported for deep enrichment.',
    );
  }

  if (selectedKeywords.length > config.maxParents) {
    throw new ResearchError(
      'ENRICHMENT_ERROR',
      `Too many parent keywords (${selectedKeywords.length}) for query_suggestions; limit is ${config.maxParents}. Use --shortlist to limit the set.`,
    );
  }

  if (selectedKeywords.length < 5) {
    throw new ResearchError(
      'ENRICHMENT_ERROR',
      `Too few parent keywords (${selectedKeywords.length}) for query_suggestions; minimum is 5. Use --shortlist to specify at least 5 parents.`,
    );
  }

  const normalizedParentCounts = new Map<string, number>();
  for (const keyword of selectedKeywords) {
    normalizedParentCounts.set(
      keyword.normalizedKeyword,
      (normalizedParentCounts.get(keyword.normalizedKeyword) ?? 0) + 1,
    );
  }
  const unambiguousLegacyParents = new Set(
    [...normalizedParentCounts.entries()]
      .filter(([, count]) => count === 1)
      .map(([normalizedParent]) => normalizedParent),
  );

  const persistedSourceCheckpoints = enrichmentStore.loadQuerySuggestionSources(enrichmentId);
  const completedCurrentSources = new Set(
    persistedSourceCheckpoints
      .filter((row) => row.parentKeywordIdx !== null && row.status !== 'error')
      .map((row) => `${row.source}:${row.parentKeywordIdx}`),
  );
  const completedLegacySources = new Set(
    persistedSourceCheckpoints
      .filter((row) => row.parentKeywordIdx === null && row.status !== 'error')
      .map((row) => `${row.source}:${row.normalizedParent}`),
  );

  const occurrences: RawSuggestionOccurrence[] = [];
  for (const saved of enrichmentStore.loadQuerySuggestions(enrichmentId)) {
    for (const occ of saved.occurrences) {
      occurrences.push({
        parentKeywordIdx: occ.parentKeywordIdx,
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
  const seenSuggestionKeys = new Set(occurrences.map(occurrenceIdentityKey));
  const discoverySurferCollections = buildDiscoverySurferCollections(
    sourceStore.loadRelatedKeywords(sourceRunId),
  );

  const collectWithRetry = async (
    parentKeyword: string,
    normalizedParent: string,
    sources: QuerySuggestionSource[],
  ): Promise<{ result: CollectResult; attempts: number; totalNavigations: number; totalXhrs: number }> => {
    const maxAttempts = 3;
    const completed = new Map<QuerySuggestionSource, RawSourceCollection>();
    let pendingSources = [...sources];
    let lastError: string | null = null;
    let totalNavigations = 0;
    let totalXhrs = 0;

    for (let attempt = 1; attempt <= maxAttempts && pendingSources.length > 0; attempt += 1) {
      try {
        const result = await collector.collect(parentKeyword, normalizedParent, pendingSources);
        totalNavigations += result.navigationRequests;
        totalXhrs += result.xhrRequests;

        for (const collection of result.collections) {
          completed.set(collection.source, collection);
        }
        pendingSources = sources.filter((source) => !completed.has(source));

        if (pendingSources.length === 0) {
          return {
            result: {
              collections: sources.map((source) => completed.get(source)!),
              navigationRequests: 0,
              xhrRequests: 0,
            },
            attempts: attempt,
            totalNavigations,
            totalXhrs,
          };
        }

        if (result.partialError) {
          lastError = result.partialError.code;
        } else {
          // A collector that returns neither a source result nor an error has
          // violated the source contract. Keep the missing sources retryable,
          // then surface an explicit error if the bounded attempts are exhausted.
          lastError = 'ENRICHMENT_ERROR';
        }
      } catch (error) {
        if (error instanceof EnrichmentCancelledError) throw error;
        totalNavigations += 1;
        const code = error instanceof ResearchError ? error.code : 'GOOGLE_UNAVAILABLE';
        if (code === 'RUN_PAUSED') throw error;
        lastError = code;
      }

      if (attempt < maxAttempts && pendingSources.length > 0) {
        await sleep(1000 * attempt);
      }
    }

    return {
      result: {
        collections: sources.map((source) => completed.get(source) ?? ({
          source,
          status: 'error' as QuerySuggestionCollectionStatus,
          occurrences: [],
          error: lastError,
          cacheStatus: 'none' as const,
        })),
        navigationRequests: 0,
        xhrRequests: 0,
      },
      attempts: maxAttempts,
      totalNavigations,
      totalXhrs,
    };
  };

  let collectorOpened = false;
  try {
    for (const keyword of selectedKeywords) {
      await new Promise(resolve => setImmediate(resolve));
      checkCancellation(signal, EnrichmentCancelledError);

      const missingSources = config.sources.filter((source) => {
        const currentKey = `${source}:${keyword.keywordIdx}`;
        const legacyKey = `${source}:${keyword.normalizedKeyword}`;
        const legacyCompleted = unambiguousLegacyParents.has(keyword.normalizedKeyword)
          && completedLegacySources.has(legacyKey);
        return !completedCurrentSources.has(currentKey) && !legacyCompleted;
      });
      if (missingSources.length === 0) continue;

      const fetched: RawSourceCollection[] = [];

      let usedBrowser = false;
      let transportRequests = 0;
      const expiredSources: QuerySuggestionSource[] = [];
      const cacheMissSources: QuerySuggestionSource[] = [];
      for (const source of missingSources) {
        if (source === 'surfer_related') {
          const sourceRunCollection = discoverySurferCollections.get(keyword.keywordIdx);
          if (sourceRunCollection) {
            fetched.push(sourceRunCollection);
            continue;
          }
        }
        // Cross-run cache identity intentionally remains semantic text. The
        // source-run idx is not portable across different discovery runs.
        const cacheKey = buildSuggestionCacheKey(source, keyword.normalizedKeyword, identity, parserVersionForSource(source));
        const cached = cache.getSuggestion(cacheKey);
        if (cached) {
          const isExpired = Date.parse(cached.expiresAt) <= Date.now();
          if (!isExpired) {
            if (cached.status === 'error') {
              fetched.push({
                source,
                status: 'error',
                occurrences: [],
                error: cached.error,
                cacheStatus: 'hit',
              });
              continue;
            }
            const rows = cached.suggestions;
            const occurrencesForSource = makeOccurrences(
              keyword.keyword,
              keyword.normalizedKeyword,
              source,
              rows.map((r) => r.text),
              rows.map((r, i) => ({ text: r.text, volume: r.volume, cpc: r.cpc, ordinal: r.ordinal ?? i })),
              keyword.keywordIdx,
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
          expiredSources.push(source);
        }
        cacheMissSources.push(source);
      }

      if (cacheMissSources.length > 0) {
        usedBrowser = true;
        if (!collectorOpened) {
          await collector.open();
          collectorOpened = true;
        }
        const { result, totalNavigations, totalXhrs } = await collectWithRetry(keyword.keyword, keyword.normalizedKeyword, cacheMissSources);
        transportRequests = totalNavigations + totalXhrs;
        for (const col of result.collections) {
          await new Promise(resolve => setImmediate(resolve));
          const ownedOccurrences = col.occurrences.map((occurrence) => ({
            ...occurrence,
            parentKeywordIdx: keyword.keywordIdx,
          }));
          const cacheKey = buildSuggestionCacheKey(col.source, keyword.normalizedKeyword, identity, parserVersionForSource(col.source));
          const storedAt = new Date().toISOString();
          const rows = ownedOccurrences.slice(0, config.maxSuggestionsPerSource).map((o) => ({ text: o.rawText, volume: o.volume, cpc: o.cpc, ordinal: o.ordinal }));
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
          const wasExpired = expiredSources.includes(col.source);
          fetched.push({ ...col, occurrences: ownedOccurrences, cacheStatus: wasExpired ? 'expired' : 'miss' });
        }
      }

      const keywordSuggestions = new Map<string, {
        rawText: string;
        volume: number | null;
        cpc: number | null;
        ordinal: number | null;
        collectionStatus: string;
        occurrences: Array<{
          parentKeywordIdx: number;
          parentKeyword: string;
          normalizedParent: string;
          source: string;
          market: string;
          hl: string;
          gl: string;
          parserVersion: string;
          collectionStatus: string;
        }>;
      }>();

      for (const collection of fetched) {
        const cappedOccurrences = collection.occurrences.slice(0, config.maxSuggestionsPerSource);
        for (const rawOccurrence of cappedOccurrences) {
          const occ = { ...rawOccurrence, parentKeywordIdx: rawOccurrence.parentKeywordIdx ?? keyword.keywordIdx };
          const key = occurrenceIdentityKey(occ);
          if (seenSuggestionKeys.has(key)) {
            const existing = keywordSuggestions.get(occ.normalizedSuggestion);
            if (existing) {
              existing.occurrences.push({
                parentKeywordIdx: occ.parentKeywordIdx,
                parentKeyword: occ.parentKeyword,
                normalizedParent: occ.normalizedParent,
                source: occ.source,
                market,
                hl,
                gl,
                parserVersion: parserVersionForSource(occ.source),
                collectionStatus: 'ok',
              });
            }
            continue;
          }
          seenSuggestionKeys.add(key);
          occurrences.push(occ);
          const existingSuggestion = keywordSuggestions.get(occ.normalizedSuggestion);
          if (existingSuggestion) {
            existingSuggestion.occurrences.push({
              parentKeywordIdx: occ.parentKeywordIdx,
              parentKeyword: occ.parentKeyword,
              normalizedParent: occ.normalizedParent,
              source: occ.source,
              market,
              hl,
              gl,
              parserVersion: parserVersionForSource(occ.source),
              collectionStatus: 'ok',
            });
          } else {
            keywordSuggestions.set(occ.normalizedSuggestion, {
              rawText: occ.rawText,
              volume: occ.volume,
              cpc: occ.cpc,
              ordinal: occ.ordinal,
              collectionStatus: 'ok',
              occurrences: [{
                parentKeywordIdx: occ.parentKeywordIdx,
                parentKeyword: occ.parentKeyword,
                normalizedParent: occ.normalizedParent,
                source: occ.source,
                market,
                hl,
                gl,
                parserVersion: parserVersionForSource(occ.source),
                collectionStatus: 'ok',
              }],
            });
          }
        }

        const status = perSourceStatus.get(collection.source)!;
        if (collection.status === 'ok') {
          status.status = 'ok';
          status.collected += cappedOccurrences.length;
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

      const sourceResults: Array<{
        source: QuerySuggestionSource;
        status: string;
        error: string | null;
        fetchedAt: string;
        requestCount: number;
        cacheStatus: string;
        market: string;
        hl: string;
        gl: string;
        parserVersion: string;
      }> = [];
      let countedRequestForParent = false;
      const fetchedAt = new Date().toISOString();
      for (const collection of fetched) {
        await new Promise(resolve => setImmediate(resolve));
        const isBrowserSource = collection.cacheStatus === 'miss'
          || collection.cacheStatus === 'expired'
          || collection.cacheStatus === 'refreshed';
        const requestCount = isBrowserSource && !countedRequestForParent ? transportRequests : 0;
        if (isBrowserSource) {
          countedRequestForParent = true;
        }
        sourceResults.push({
          source: collection.source,
          status: collection.status,
          error: collection.error,
          fetchedAt,
          requestCount,
          cacheStatus: collection.cacheStatus,
          market,
          hl,
          gl,
          parserVersion: parserVersionForSource(collection.source),
        });
      }

      const suggestionsPayload = [...keywordSuggestions.entries()].map(([normalizedSuggestion, s]) => ({
        normalizedSuggestion,
        rawText: s.rawText,
        volume: s.volume,
        cpc: s.cpc,
        ordinal: s.ordinal,
        collectionStatus: s.collectionStatus,
        occurrences: s.occurrences,
      }));

      enrichmentStore.persistParentAtomic(
        enrichmentId,
        keyword.keywordIdx,
        keyword.normalizedKeyword,
        market,
        hl,
        gl,
        sourceResults,
        suggestionsPayload,
      );

      logger(
        `  ${keyword.keyword}: ${fetched.map((f) => `${f.source}=${f.status}`).join(', ')}`,
      );

      if (usedBrowser && (config.rateLimitMinDelayMs > 0 || config.rateLimitMaxDelayMs > 0)) {
        const minDelay = config.rateLimitMinDelayMs;
        const maxDelay = Math.max(minDelay, config.rateLimitMaxDelayMs);
        const delay = minDelay === maxDelay ? minDelay : minDelay + Math.floor(Math.random() * (maxDelay - minDelay));
        await sleep(delay);
      }
    }
  } finally {
    if (collectorOpened) {
      await collector.close();
    }
  }

  // SQLite is the source of truth for both cold runs and resumes. Local
  // counters only describe work performed in this process and would otherwise
  // zero out sourceStats for checkpoints completed before resume.
  return buildQueryResultFromStore(
    enrichmentId,
    enrichmentStore,
    config,
    researchConfig,
  );
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
        parentKeywordIdx: occ.parentKeywordIdx,
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
      sourceStats[source].ok += 1;
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
  const emptyCount = sourceRecords.filter((r) => r.status === 'empty').length;
  const errorCount = sourceRecords.filter((r) => r.status === 'error').length;
  const inputCount = countPersistedQueryParents(sourceRecords);

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
    maxParents: 200,
    rateLimitMinDelayMs: 1000,
    rateLimitMaxDelayMs: 10000,
    algorithmVersion: QUERY_SUGGESTION_PARSER_VERSION,
  };
}
