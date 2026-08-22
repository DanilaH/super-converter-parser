import type { ResearchConfig } from '../config/config.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import type { MicrosoftKeyword } from '../input/microsoft/normalize.js';
import type { CollectionResult, RelatedCollectionResult, SurferRelatedOutcome } from '../browser/collect.js';
import { GOOGLE_PARSER_VERSION, type SerpResult } from '../google/serp.js';
import { registrableDomain } from '../domains/normalize.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import type { SurferRelatedKeyword } from '../surfer/parser.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { ResearchError } from '../shared/errors.js';
import type { AhrefsClient } from '../ahrefs/client.js';
import {
  RunStore,
  isTerminalKeywordStatus,
  storedKeywordToRecord,
  type CacheStatus,
  type StoredDomain,
  type StoredKeyword,
  type StoredRun,
} from '../db/store.js';
import { NEVER_CANCELLED, type CancellationSignal } from '../browser/captcha.js';
import {
  RESUMABLE_RUN_STATES,
  TERMINAL_RUN_STATES,
  type KeywordRecord,
  type RunState,
} from './run.js';
import { countProgress, countCacheStats, cacheHitRatePercent, writeSnapshots } from './snapshots.js';
import {
  CircuitBreaker,
  isTransientErrorCode,
  retryDelayMs,
  type BreakerSettings,
  type RetrySettings,
} from './policies.js';
import { keywordCacheIdentity, buildKeywordCacheKey, buildRelatedCacheKey, type CacheIdentity } from '../cache/keys.js';
import { mergedCacheRefresh, resolveKeywordAccess, resolveRelatedAccess, type CacheResolution, type RelatedCacheResolution } from '../cache/resolve.js';
import { ttlMsForKeywordStatus, ttlMsForRelatedStatus, CacheStore, type KeywordCache, type CachedRelatedStatus } from '../cache/store.js';

export type CollectKeywordFn = (
  keyword: KeywordRecord,
  debugRoot: string,
  signal?: CancellationSignal,
) => Promise<CollectionResult>;

export type CollectRelatedFn = (
  keyword: KeywordRecord,
  debugRoot: string,
  signal?: CancellationSignal,
) => Promise<RelatedCollectionResult>;

export type SnapshotsPublisher = (
  store: RunStore,
  runId: string,
  runDirectory: string,
  state: RunState,
  ahrefs?: AhrefsSummary,
  scoringCompleteness?: ScoringCompleteness,
) => Promise<void>;

export type EngineHooks = {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  logger: (line: string) => void;
  pauseRequested: () => boolean;
};

export type EngineCacheOptions = {
  store: KeywordCache;
  forceRefresh: boolean;
  refreshKeywords: ReadonlySet<string>;
  // Precomputed per-keyword decisions (one read per keyword, made before the
  // browser decision); when present the engine must not re-read the cache.
  resolutions?: Map<string, CacheResolution>;
  relatedResolutions?: Map<string, RelatedCacheResolution>;
};

export type AhrefsSummary = {
  mode: 'required' | 'optional';
  state: 'complete' | 'degraded' | 'skipped' | 'failed';
  discovered: number;
  attempted: number;
  notAttempted: number;
  cache: number;
  fresh: number;
  ok: number;
  notFound: number;
  error: number;
  numericCoverage: number;
  requireAhrefs: boolean;
};

export type ScoringCompleteness = {
  status: 'complete' | 'degraded';
  numericDrCoverage: number;
  missingDrDomains: number;
};

export type RunOutcome =
  | { kind: 'finished'; state: 'completed' | 'completed_with_errors'; ahrefs: AhrefsSummary; scoringCompleteness: ScoringCompleteness }
  | { kind: 'paused'; reason: string };

export type ExecuteRunOptions = {
  store: RunStore;
  runId: string;
  mode: 'fresh' | 'resume';
  keywords: SeedKeyword[] | MicrosoftKeyword[];
  config: ResearchConfig;
  input: { kind: 'seeds' | 'microsoft'; path: string };
  runDirectory: string;
  debugRoot: string;
  collect: CollectKeywordFn;
  collectRelated?: CollectRelatedFn;
  // Unified cancellation signal from the CLI. Collection polls it during the
  // indefinite CAPTCHA wait; when it flips, collection aborts (RUN_PAUSED) and
  // the active keyword is left resumable rather than committed as terminal.
  signal?: CancellationSignal;
  hooks: EngineHooks;
  publishSnapshots?: SnapshotsPublisher;
  cache?: EngineCacheOptions;
  // Ahrefs Domain Rating enrichment. When present the engine resolves a DR for
  // every registrable domain in the organic SERP and persists it next to the
  // SERP row. Domain rating lookups are cached and rate limited.
  ahrefs?: { apiKey: string | null; client: AhrefsClient };
  // When true, a missing/blank AHREFS_API_KEY fails before keyword collection
  // and the run cannot finish as clean completed. Persists through resume.
  requireAhrefs?: boolean;
};

const RESUME_COMMAND_PREFIX = 'npm run research -- --resume';

// Validates that a run may be resumed. Throws RESUME_NOT_FOUND,
// RESUME_TERMINAL_RUN, or RESUME_PARSER_MISMATCH otherwise.
export function validateResume(store: RunStore, runId: string): StoredRun {
  const run = store.loadRun(runId);
  if (!run) {
    throw new ResearchError(
      'RESUME_NOT_FOUND',
      `Run "${runId}" was not found. Use --seeds to start a new run.`,
    );
  }
  if (!RESUMABLE_RUN_STATES.has(run.state)) {
    const terminal = TERMINAL_RUN_STATES.has(run.state);
    throw new ResearchError(
      terminal ? 'RESUME_TERMINAL_RUN' : 'RESUME_NOT_FOUND',
      `Run "${runId}" is in state "${run.state}" and cannot be resumed.`,
    );
  }
  if (
    run.parserVersions.surfer !== SURFER_PARSER_VERSION ||
    run.parserVersions.google !== GOOGLE_PARSER_VERSION
  ) {
    throw new ResearchError(
      'RESUME_PARSER_MISMATCH',
      `Run "${runId}" used parser versions ${run.parserVersions.surfer}/${run.parserVersions.google} but the current code is ${SURFER_PARSER_VERSION}/${GOOGLE_PARSER_VERSION}. Start a new run instead; parser versions must not be mixed inside one run.`,
    );
  }
  return run;
}

export async function executeRun(options: ExecuteRunOptions): Promise<RunOutcome> {
  const {
    store,
    runId,
    mode,
    keywords,
    config,
    input,
    runDirectory,
    debugRoot,
    collect,
    hooks,
    signal = NEVER_CANCELLED,
  } = options;
  const requireAhrefs = options.requireAhrefs ?? false;
  const collectRelated: CollectRelatedFn = options.collectRelated ?? (async (keyword, relatedDebugRoot) => {
    const result = await collect(keyword, relatedDebugRoot, signal);
    return { related: result.related, debugArtifactPath: result.debugArtifactPath };
  });
  const { logger } = hooks;
  const publish = options.publishSnapshots ?? writeSnapshots;

  const identity = keywordCacheIdentity(config);
  let forceRefresh = options.cache?.forceRefresh ?? false;
  let refreshKeywords = new Set(options.cache?.refreshKeywords ?? []);

  // Tracks Ahrefs DR accounting across the run: discovered domains, attempted
  // lookups, cache/fresh provenance, terminal statuses and numeric coverage.
  const ahrefsTracker = new AhrefsTracker(options.ahrefs?.client ?? null, requireAhrefs);

  // In required mode, a missing/blank key or absent client fails before any
  // keyword collection begins. This mirrors the CLI preflight check and keeps
  // the engine self-consistent for direct (non-CLI) use.
  if (requireAhrefs && !options.ahrefs?.client) {
    throw new ResearchError(
      'AHREFS_REQUIRE_CONFIG',
      'Ahrefs DR is required (--require-ahrefs / REQUIRE_AHREFS=true) but no Ahrefs client is configured (AHREFS_API_KEY missing or blank).',
    );
  }

  let run: StoredRun;
  // The CLI pre-creates fresh runs (before preflight) so a cancellation during
  // preflight leaves a resumable run. Continue with the existing record instead
  // of recreating it (which would collide on the run primary key).
  const preCreated = mode === 'fresh' ? store.loadRun(runId) : null;
  if (preCreated) {
    store.markStaleRunningAsPending(runId);
    store.setRunState(runId, 'running');
    run = preCreated;
  } else if (mode === 'fresh') {
    store.createRun({
      runId,
      configSnapshot: config,
      parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
      input,
      keywords,
      forceRefresh,
      refreshKeywords: [...refreshKeywords],
    });
    store.setRunState(runId, 'running');
    run = store.loadRun(runId) as StoredRun;
  } else {
    run = validateResume(store, runId);
    const stale = store.markStaleRunningAsPending(runId);
    if (stale > 0) {
      logger(`  ✓ ${stale} stale running keyword(s) reset to pending`);
    }
    // Refresh semantics persist across pause/resume: merging with the stored
    // values keeps a forced-refresh run forced even if resumed without flags.
    const merged = mergedCacheRefresh(
      { forceRefresh, refreshKeywords },
      { forceRefresh: run.forceRefresh, refreshKeywords: run.refreshKeywords },
    );
    if (merged.forceRefresh !== run.forceRefresh || merged.refreshKeywords.length !== run.refreshKeywords.length) {
      store.setRunCacheRefresh(runId, merged.forceRefresh, merged.refreshKeywords);
    }
    forceRefresh = merged.forceRefresh;
    refreshKeywords = new Set(merged.refreshKeywords);
    store.setRunState(runId, 'running');
  }

  // All keywords currently known (seeds + any previously expanded rows from a
  // prior interrupted run) participate in de-duplication, so expansion never
  // re-adds a candidate that is already queued or processed.
  const seenNormalized = new Set(
    store.loadKeywords(runId).map((keyword) => keyword.normalizedKeyword),
  );

  const breaker = new CircuitBreaker(config.circuitBreaker);
  const samples: number[] = [];

  logger('');
  if (mode === 'resume') {
    const remaining = store
      .loadKeywords(runId)
      .filter((keyword) => !isTerminalKeywordStatus(keyword.status)).length;
    logger(`[resume] ${runId}: ${remaining} keyword(s) remaining`);
  }

  let outcome: RunOutcome | null = null;

  // Dynamic queue: the next keyword is re-read from the database on every
  // iteration, so keywords discovered by Surfer expansion mid-run are processed
  // in the same pass instead of being left pending (which previously forced the
  // run into a terminal state while related candidates stayed unprocessed).
  while (outcome === null) {
    if (hooks.pauseRequested()) {
      outcome = { kind: 'paused', reason: 'SIGINT received; run paused safely.' };
      break;
    }

    const tripReason = breaker.tripReason();
    if (tripReason !== null) {
      outcome = { kind: 'paused', reason: tripReason };
      break;
    }

    const stored = store
      .loadKeywords(runId)
      .filter((keyword) => !isTerminalKeywordStatus(keyword.status) && keyword.status !== 'running')
      .sort((a, b) => a.idx - b.idx)[0];

    // No pending/running keyword remains: the run is genuinely complete, even
    // if expansion added rows during this pass. The run must not be marked
    // terminal while related candidates are still queued.
    if (!stored) break;

    const idx = stored.idx;
    stored.status = 'running';
    store.updateKeyword(runId, stored);

    const total = store.loadKeywords(runId).length;
    const processedCount = store
      .loadKeywords(runId)
      .filter((keyword) => isTerminalKeywordStatus(keyword.status)).length;
    logger(`[${processedCount}/${total}] ${stored.normalizedKeyword}`);

    // The resolution is decided exactly once per keyword; a precomputed plan
    // (from the same read that drove the browser decision) is authoritative,
    // so execution can never see a different cache state than planning did.
    const resolution =
      options.cache?.resolutions?.get(stored.normalizedKeyword) ??
      resolveKeywordAccess(
        stored.normalizedKeyword,
        { identity, forceRefresh, refreshKeywords },
        options.cache?.store ?? null,
        hooks.now(),
      );

    if (resolution.kind === 'hit') {
      const entry = resolution.entry;
      const committed: StoredKeyword = {
        ...stored,
        status: entry.record.status,
        surfer: entry.record.surfer,
        google: entry.record.google,
        error: entry.record.error,
        collectedAt: entry.collectedAt,
      };

      // Keyword and related caches are resolved independently. A cached primary
      // result must not suppress related observation when its related lookup is
      // missing, expired, or an earlier error. Related observation runs for every
      // root keyword regardless of expansion.enabled; --expand only controls
      // whether observed rows are queued for depth-one Google lookups.
      if (config.expansion.depth >= 1 && isExpandableKeyword(stored)) {
        const relatedResolution =
          options.cache?.relatedResolutions?.get(stored.normalizedKeyword) ??
          resolveRelatedAccess(
            stored.normalizedKeyword,
            identity,
            options.cache?.store ?? null,
            hooks.now(),
          );
        let relatedOutcome: SurferRelatedOutcome;
        if (relatedResolution.kind === 'hit_ok') {
          relatedOutcome = { status: 'ok', error: null, rows: relatedRowsToSurferKeywords(relatedResolution.entry.rows) };
        } else if (relatedResolution.kind === 'hit_empty') {
          relatedOutcome = { status: 'empty', error: null, rows: [] };
        } else {
          store.incrementLookups(runId);
          let relatedResult: RelatedCollectionResult;
          try {
            relatedResult = await collectRelated(
              storedKeywordToRecord(stored),
              debugRoot,
              signal,
            );
          } catch (error) {
            if (error instanceof ResearchError && error.code === 'RUN_PAUSED') {
              outcome = {
                kind: 'paused',
                reason: 'SIGINT received during collection; active keyword left resumable.',
              };
              break;
            }
            throw error;
          }
          const collectedAt = new Date(hooks.now()).toISOString();
          persistRelatedCache({
            cache: options.cache,
            identity,
            keyword: storedKeywordToRecord(stored),
            related: relatedResult.related,
            config,
            collectedAt,
          });
          reportRelatedOutcome(relatedResult, stored.normalizedKeyword, logger);
          relatedOutcome = relatedResult.related;
        }
        let added: string[] = [];
        if (config.expansion.enabled && relatedOutcome.status === 'ok') {
          added = applySurferExpansion({
            runId,
            store,
            parentKeyword: stored.keyword,
            related: relatedOutcome.rows,
            config,
            seenNormalized,
            logger,
          });
          for (const name of added) {
            logger(`  ↳ expansion: +${name} (parent: ${stored.keyword})`);
          }
        }
        store.recordRelatedKeywords(runId, stored.idx, stored.keyword, relatedOutcome, new Set(added));
      }
      // Commit the cached primary only after any required related lookup. If
      // the process exits during that lookup, the root remains resumable and
      // related observation cannot be silently skipped on restart.
      const hitSourceByDomain = await applyDomainRatings({
        serpRows: entry.serpRows,
        ahrefs: options.ahrefs?.client ?? null,
        domainCache: (options.cache?.store ?? null) as CacheStore | null,
        config,
        now: hooks.now,
        sleep: hooks.sleep,
        logger,
        tracker: ahrefsTracker,
      });
      store.recordDomains(runId, stored.idx, stored.keyword, entry.serpRows, hitSourceByDomain);
      store.commitKeyword(runId, committed, entry.serpRows, 'hit');
      logger(
        `  ✓ cache hit (${entry.record.status}) | volume: ${formatVolume(entry.record.surfer?.volume ?? null)} | organic: ${entry.serpRows.length}`,
      );
    } else {
      const startAt = hooks.now();
      let result: CollectionResult | null = null;

      try {
        for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
          store.incrementLookups(runId);
          result = await collect(storedKeywordToRecord(stored), debugRoot, signal);
          const record = result.record;
        if (!isTerminalKeywordStatus(record.status)) {
          throw new ResearchError(
            'DB_ERROR',
            `Collector returned non-terminal status "${record.status}" for "${record.normalizedKeyword}".`,
          );
        }

        const retryable =
          record.status === 'failed' &&
          record.error !== null &&
          isTransientErrorCode(record.error.code) &&
          attempt < config.retry.maxAttempts;

        if (retryable) {
          const delay = retryDelayMs(attempt, config.retry, hooks.random);
          logger(`  ⚠ ${record.error?.code}: retry ${attempt}/${config.retry.maxAttempts} in ${delay}ms`);
          await hooks.sleep(delay);
          continue;
        }
        break;
      }
      } catch (error) {
        if (error instanceof ResearchError && error.code === 'RUN_PAUSED') {
          // Collection was cancelled (Ctrl+C) while this keyword was in flight.
          // Leave it as 'running' (resumable) instead of committing a false
          // terminal result; the run is recorded as paused below.
          outcome = {
            kind: 'paused',
            reason: 'SIGINT received during collection; active keyword left resumable.',
          };
        } else {
          throw error;
        }
      }

      if (outcome !== null) break;

      const record = result?.record as KeywordRecord;
      const collectedAt = new Date(hooks.now()).toISOString();
      const committed: StoredKeyword = {
        idx,
        id: record.id,
        keyword: record.keyword,
        normalizedKeyword: record.normalizedKeyword,
        sources: record.sources,
        status: record.status,
        surfer: record.surfer,
        google: record.google,
        error: record.error,
        collectedAt,
        cacheStatus: null,
      };
      const cacheStatus: CacheStatus | null = options.cache
        ? resolution.kind === 'forced'
          ? 'refreshed'
          : resolution.kind === 'expired'
            ? 'expired'
            : 'miss'
        : null;
      const serpRows = result?.serpRows ?? [];
      const missSourceByDomain = await applyDomainRatings({
        serpRows,
        ahrefs: options.ahrefs?.client ?? null,
        domainCache: (options.cache?.store ?? null) as CacheStore | null,
        config,
        now: hooks.now,
        sleep: hooks.sleep,
        logger,
        tracker: ahrefsTracker,
      });
      store.recordDomains(runId, idx, record.keyword, serpRows, missSourceByDomain);
      store.commitKeyword(runId, committed, serpRows, cacheStatus);
      breaker.record(record.status, record.error?.code ?? null);
      samples.push(hooks.now() - startAt);

      if (record.surfer) {
        const volume = formatVolume(record.surfer.volume);
        const cpc = record.surfer.cpc === null ? 'n/a' : `$${record.surfer.cpc.toFixed(2)}`;
        logger(`  ✓ volume: ${volume} | cpc: ${cpc} | organic: ${result?.serpRows.length}`);
      } else {
        logger(`  ✗ surfer: ${record.error?.code ?? 'unknown'} (${record.error?.message ?? ''})`);
      }

      if (record.google?.geoWarning) {
        logger(`  ⚠ SERP GEO WARNING: target ${config.research.market}, Google detected location: ${record.google.detectedLocation}`);
      }

      if (result?.debugArtifactPath) {
        logger(`  ⚠ parser debug artifacts saved to ${result.debugArtifactPath}`);
      }

      if (options.cache) {
        // Fresh results are cached only after the run checkpoint succeeded;
        // a cache write failure is visible but never corrupts the run.
        try {
          options.cache.store.putKeyword({
            cacheKey: buildKeywordCacheKey(record.normalizedKeyword, identity),
            keyword: record.keyword,
            normalizedKeyword: record.normalizedKeyword,
            identity,
            record,
            serpRows: result?.serpRows ?? [],
            collectedAt,
            storedAt: collectedAt,
            expiresAt: new Date(
              Date.parse(collectedAt) + ttlMsForKeywordStatus(record.status, config.cache.ttl),
            ).toISOString(),
          });
        } catch (error) {
          logger(
            `  ⚠ cache write failed for "${record.normalizedKeyword}": ${error instanceof ResearchError ? error.code : 'CACHE_DB_ERROR'} (run continues)`,
          );
        }
      }

      // Persist the structured related-keyword outcome (ok / empty / error / not_attempted).
      // The status is taken verbatim from collection: a broken related widget
      // is stored as 'error' even when the primary collection succeeded, and a
      // main-parser error combined with a related-parser error keeps 'error'.
      // Related observation is recorded for every root keyword regardless of
      // expansion.enabled; --expand only controls queueing below.
      if (isExpandableKeyword(stored)) {
        persistRelatedCache({
          cache: options.cache,
          identity,
          keyword: record,
          related: result?.related ?? { status: 'not_attempted', error: null, rows: [] },
          config,
          collectedAt,
        });
        if (result) reportRelatedOutcome(result, record.normalizedKeyword, logger);

        // Expansion queues depth-one related candidates for Google collection.
        // It triggers only when expansion is enabled and the related outcome is
        // 'ok' (rows were actually parsed). Related children never expand further.
        let added: string[] = [];
        if (
          config.expansion.enabled &&
          config.expansion.depth >= 1 &&
          result &&
          result.related.status === 'ok'
        ) {
          added = applySurferExpansion({
            runId,
            store,
            parentKeyword: record.keyword,
            related: result.related.rows,
            config,
            seenNormalized,
            logger,
          });
          for (const name of added) {
            logger(`  ↳ expansion: +${name} (parent: ${record.keyword})`);
          }
        }
        store.recordRelatedKeywords(runId, idx, record.keyword, result?.related ?? { status: 'not_attempted', error: null, rows: [] }, new Set(added));
      }
    }

    await publish(store, runId, runDirectory, 'running');
    const liveTotal = store.loadKeywords(runId).length;
    const liveProcessed = store
      .loadKeywords(runId)
      .filter((keyword) => isTerminalKeywordStatus(keyword.status)).length;
    logger(
      progressLine(
        liveTotal,
        countProgress(store.loadKeywords(runId)),
        countCacheStats(store.loadKeywords(runId)),
        store.loadRun(runId)?.lookups ?? 0,
        liveTotal - liveProcessed,
        samples,
      ),
    );

    // A SIGINT that arrived while this keyword was being collected must pause
    // the run even when this was the last keyword. The keyword result is
    // already committed and checkpointed above; the pause is recorded below.
    if (hooks.pauseRequested()) {
      outcome = { kind: 'paused', reason: 'SIGINT received; run paused safely.' };
      break;
    }
  }

  if (outcome === null) {
    const progress = countProgress(store.loadKeywords(runId));
    const ahrefs = ahrefsTracker.finish(store.loadDomains(runId));
    const baseState: 'completed' | 'completed_with_errors' =
      progress.errors > 0 ? 'completed_with_errors' : 'completed';
    // In required mode only, any not_attempted domain or systemic Ahrefs failure
    // prevents a clean completed state. In optional mode a skipped stage is
    // reported honestly but does not degrade the run state.
    const state: RunState =
      baseState === 'completed' && ahrefs.requireAhrefs && ahrefs.state !== 'complete'
        ? 'completed_with_errors'
        : baseState;
    const scoringCompleteness: ScoringCompleteness =
      ahrefs.numericCoverage >= ahrefs.discovered && ahrefs.discovered > 0
        ? { status: 'complete', numericDrCoverage: ahrefs.numericCoverage, missingDrDomains: ahrefs.discovered - ahrefs.numericCoverage }
        : { status: 'degraded', numericDrCoverage: ahrefs.numericCoverage, missingDrDomains: ahrefs.discovered - ahrefs.numericCoverage };
    // Publish the final snapshots while the run is still resumable: a failed
    // JSON write must never leave a terminal run without published artifacts.
    // If publication fails, the run stays "running" and resume republishes.
    await publish(store, runId, runDirectory, state, ahrefs, scoringCompleteness);
    store.setRunState(runId, state);
    outcome = { kind: 'finished', state, ahrefs, scoringCompleteness };
  } else {
    // Paused state: publish the Ahrefs summary + scoring completeness so the
    // paused run's artifacts are consistent with a final run (and with the
    // resume that recomputes them from persisted state).
    const pausedAhrefs = ahrefsTracker.finish(store.loadDomains(runId));
    const pausedScoring: ScoringCompleteness =
      pausedAhrefs.numericCoverage >= pausedAhrefs.discovered && pausedAhrefs.discovered > 0
        ? { status: 'complete', numericDrCoverage: pausedAhrefs.numericCoverage, missingDrDomains: pausedAhrefs.discovered - pausedAhrefs.numericCoverage }
        : { status: 'degraded', numericDrCoverage: pausedAhrefs.numericCoverage, missingDrDomains: pausedAhrefs.discovered - pausedAhrefs.numericCoverage };
    store.setRunState(runId, 'paused', { pauseReason: outcome.reason });
    await publish(store, runId, runDirectory, 'paused', pausedAhrefs, pausedScoring);
    logger('');
    logger(`Run paused: ${outcome.reason}`);
    logger('Resume with:');
    logger(`  ${RESUME_COMMAND_PREFIX} ${runId}`);
  }

  return outcome;
}

// Tracks Ahrefs DR accounting across a run: counts discovered domains, attempted
// lookups, cache/fresh provenance, terminal statuses (ok / not_found / error),
// and numeric DR coverage. Systemic auth failures (a thrown 401/403 on the first
// real lookup) mark the whole stage as failed so the run cannot finish clean.
class AhrefsTracker {
  private readonly discovered = new Set<string>();
  private cacheCount = 0;
  private freshCount = 0;
  private readonly numericDomains = new Set<string>();
  private systemicFailure: string | null = null;
  private firstLookupObserved = false;

  constructor(
    private readonly ahrefs: AhrefsClient | null,
    private readonly requireAhrefs: boolean,
  ) {}

  get mode(): 'required' | 'optional' {
    return this.requireAhrefs ? 'required' : 'optional';
  }

  registerDomain(domain: string): void {
    this.discovered.add(domain);
  }

  recordLookup(source: 'cache' | 'fresh' | 'none', status: 'ok' | 'not_found' | 'error', dr: number | null, domain?: string): void {
    if (source === 'cache') this.cacheCount += 1;
    else if (source === 'fresh') this.freshCount += 1;
    // Track unique domains with numeric DR for the summary; terminal status
    // counts (ok/not_found/error) are derived from persisted domains in finish()
    // so they survive resume.
    if (status === 'ok' && dr !== null && domain) {
      this.numericDomains.add(domain);
    }
  }

  // Records a systemic auth failure (401/403 thrown by the client on the first
  // real lookup). A systemic failure is not an isolated domain error: it means
  // the key is unusable and no further lookups should be attempted.
  recordSystemicFailure(code: string): void {
    if (!this.firstLookupObserved) {
      this.systemicFailure = code;
    }
  }

  observeLookup(): void {
    this.firstLookupObserved = true;
  }

  hasObservedLookup(): boolean {
    return this.firstLookupObserved;
  }

  finish(persistedDomains: StoredDomain[]): AhrefsSummary {
    // Compute Ahrefs accounting from persisted domains so the summary survives
    // resume (the in-memory tracker is recreated on each process start).
    for (const domain of persistedDomains) {
      this.discovered.add(domain.domain);
    }
    const discovered = this.discovered.size;

    let ok = 0;
    let notFound = 0;
    let error = 0;
    let numericCoverage = 0;
    for (const domain of persistedDomains) {
      if (domain.status === 'ok') {
        ok += 1;
        if (domain.dr !== null) numericCoverage += 1;
      } else if (domain.status === 'not_found') {
        notFound += 1;
      } else if (domain.status === 'error') {
        error += 1;
      }
    }
    const attempted = persistedDomains.filter((d) => d.status !== 'not_attempted').length;
    const notAttempted = discovered - attempted;

    let state: AhrefsSummary['state'];
    if (!this.ahrefs) {
      // No client configured: stage was skipped entirely.
      state = this.requireAhrefs ? 'failed' : 'skipped';
    } else if (this.systemicFailure !== null) {
      state = 'failed';
    } else if (notAttempted > 0 && discovered > 0) {
      state = this.requireAhrefs ? 'failed' : 'skipped';
    } else if (error > 0) {
      // Any error (429, 5xx, network) degrades the stage regardless of mode.
      // Required mode cannot finish clean with errors; optional mode reports
      // degraded so the operator knows DR data is incomplete.
      state = 'degraded';
    } else {
      state = 'complete';
    }
    return {
      mode: this.mode,
      state,
      discovered,
      attempted,
      notAttempted,
      cache: this.cacheCount,
      fresh: this.freshCount,
      ok,
      notFound,
      error,
      numericCoverage,
      requireAhrefs: this.requireAhrefs,
    };
  }
}

// A keyword is expanded only when it originated from a seed (depth 0). Related
// candidates added by expansion carry a surfer_related source and are collected
// but never expanded further, which keeps expansion strictly depth-one.
function isExpandableKeyword(keyword: StoredKeyword): boolean {
  return !keyword.sources.some((source) => source.type === 'surfer_related');
}

function relatedRowsToSurferKeywords(
  rows: ReadonlyArray<{ relatedKeyword: string; overlap: number | null; volume: number | null }>,
): SurferRelatedKeyword[] {
  return rows.map((row) => ({
    keyword: row.relatedKeyword,
    normalizedKeyword: normalizeKeyword(row.relatedKeyword),
    overlap: row.overlap,
    volume: row.volume,
  }));
}

function persistRelatedCache(params: {
  cache: EngineCacheOptions | undefined;
  identity: CacheIdentity;
  keyword: KeywordRecord;
  related: SurferRelatedOutcome;
  config: ResearchConfig;
  collectedAt: string;
}): void {
  const { cache, identity, keyword, related, config, collectedAt } = params;
  if (!cache?.store.putRelated || related.status === 'not_attempted') return;
  const status: CachedRelatedStatus = related.status;
  try {
    cache.store.putRelated({
      cacheKey: buildRelatedCacheKey(keyword.normalizedKeyword, identity),
      normalizedKeyword: keyword.normalizedKeyword,
      identity,
      status,
      error: related.error,
      rows: related.rows.map((item) => ({
        relatedKeyword: item.keyword,
        overlap: item.overlap,
        volume: item.volume,
      })),
    }, collectedAt, ttlMsForRelatedStatus(status, config.cache.ttl));
  } catch {
    // A related-cache write failure must never corrupt the run.
  }
}

function reportRelatedOutcome(
  result: RelatedCollectionResult,
  normalizedKeyword: string,
  logger: (line: string) => void,
): void {
  if (result.related.status !== 'error') return;
  logger(
    `  ⚠ related keywords failed for "${normalizedKeyword}": ${result.related.error ?? 'SURFER_RELATED_PARSE_ERROR'}`,
  );
  if (result.debugArtifactPath) {
    logger(`  ⚠ related parser debug artifacts saved to ${result.debugArtifactPath}`);
  }
}

function progressLine(
  total: number,
  progress: { completed: number; partial: number; failed: number; errors: number },
  cache: { hits: number; misses: number; expired: number; refreshed: number },
  lookups: number,
  remaining: number,
  samples: number[],
): string {
  const processed = progress.completed + progress.partial + progress.failed;
  // Hit rate is the share of processed keywords served from the cache; a
  // forced refresh is a deliberate bypass (browser work was done), so it is
  // not a hit. The buckets are mutually exclusive and always add up to the
  // processed count: hits + misses + expired + refreshed = processed.
  const hitRate = cacheHitRatePercent(cache.hits, processed);
  let eta = '';
  if (samples.length >= 3 && remaining > 0) {
    const averageMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    eta = ` | ETA ~${formatDuration(Math.round(averageMs * remaining))}`;
  }
  return `Keywords ${processed}/${total} | Cache ${hitRate}% (${cache.hits} hit / ${cache.misses} miss / ${cache.expired} expired / ${cache.refreshed} refreshed) | Browser lookups ${lookups} | Errors ${progress.errors}${eta}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatVolume(volume: number | null): string {
  if (volume === null) return 'n/a';
  return volume.toLocaleString('en-US');
}

function applySurferExpansion(params: {
  runId: string;
  store: RunStore;
  parentKeyword: string;
  related: SurferRelatedKeyword[];
  config: ResearchConfig;
  seenNormalized: Set<string>;
  logger: (line: string) => void;
}): string[] {
  const { runId, store, parentKeyword, related, config, seenNormalized, logger } = params;
  if (!config.expansion.enabled || config.expansion.depth < 1) return [];

  const candidates = related
    .filter(
      (item) =>
        config.expansion.minVolume === 0 || (item.volume ?? 0) >= config.expansion.minVolume,
    )
    .filter(
      (item) =>
        config.expansion.minOverlap === 0 || (item.overlap ?? 0) >= config.expansion.minOverlap,
    )
    .filter((item) => !seenNormalized.has(item.normalizedKeyword))
    .slice(0, config.expansion.maxCandidatesPerKeyword);

  const added: string[] = [];
  for (const candidate of candidates) {
    seenNormalized.add(candidate.normalizedKeyword);
    store.addKeyword(runId, {
      keyword: candidate.keyword,
      normalizedKeyword: candidate.normalizedKeyword,
      sources: [{ type: 'surfer_related', parentKeyword, overlap: candidate.overlap ?? null }],
    });
    added.push(candidate.keyword);
  }
  return added;
}

// Resolves an Ahrefs Domain Rating for every distinct registrable domain in the
// organic SERP, reusing the domain cache so repeated domains across keywords
// trigger a single fresh lookup per TTL window. Mutates `serpRows` in place,
// including back-filling `registrableDomain` for older cached rows that were
// stored before the field existed (so they still get enriched).
export async function applyDomainRatings(params: {
  serpRows: SerpResult[];
  ahrefs: AhrefsClient | null;
  domainCache: CacheStore | null;
  config: ResearchConfig;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  logger: (line: string) => void;
  tracker?: AhrefsTracker;
}): Promise<Map<string, { source: 'cache' | 'fresh' | 'none'; fetchedAt: string | null }>> {
  const { serpRows, ahrefs, domainCache, config, now, sleep, logger, tracker } = params;
  // Per-domain DR for in-call dedupe (a domain on several rows is fetched once).
  // Carries the error code too, so a repeated occurrence of the same domain in
  // one SERP inherits the exact error provenance of the first lookup.
  const resolvedDrs = new Map<string, { dr: number | null; status: 'ok' | 'not_found' | 'error'; error: string | null }>();
  // Provenance returned to the caller so the run-level domains table can record
  // whether each value came from the domain cache or a fresh Ahrefs lookup.
  const sourceByDomain = new Map<string, { source: 'cache' | 'fresh' | 'none'; fetchedAt: string | null }>();
  // Ahrefs enrichment intentionally skipped (no client or no domain cache):
  // mark every observed row as 'not_attempted' so the run-level domains table
  // still persists the observed domains with honest provenance (source 'none').
  if (!ahrefs || !domainCache) {
    for (const row of serpRows) {
      if (row.registrableDomain && row.drStatus === null) row.drStatus = 'not_attempted';
      if (row.registrableDomain) tracker?.registerDomain(row.registrableDomain);
    }
    return sourceByDomain;
  }

  for (const row of serpRows) {
    // Older keyword-cache entries may carry an empty registrable_domain.
    // Re-derive it from the hostname (falling back to the URL) so enrichment
    // still runs for those rows instead of being silently skipped.
    if (!row.registrableDomain) {
      const derived =
        registrableDomain(row.hostname) ??
        (row.url ? registrableDomain(new URL(row.url).hostname) : null);
      row.registrableDomain = derived ?? '';
    }
    const domain = row.registrableDomain;
    if (!domain) continue;

    tracker?.registerDomain(domain);

    const prior = resolvedDrs.get(domain);
    if (prior) {
      row.dr = prior.dr;
      row.drStatus = prior.status;
      // Carry the error code forward so every occurrence of the domain in the
      // SERP shares the same provenance (not just the first lookup).
      row.drError = prior.error ?? null;
      continue;
    }

    const cached = domainCache.getDomain(domain);
    if (cached && Date.parse(cached.expiresAt) > now()) {
      row.dr = cached.dr;
      row.drStatus = cached.status;
      // Preserve the cached error code verbatim so a cached Ahrefs error is
      // traceable downstream (the domains table keeps it, not just fresh ones).
      row.drError = cached.error ?? null;
      resolvedDrs.set(domain, { dr: cached.dr, status: cached.status, error: cached.error ?? null });
      sourceByDomain.set(domain, { source: 'cache', fetchedAt: cached.storedAt });
      tracker?.recordLookup('cache', cached.status, cached.dr, domain);
      continue;
    }

    tracker?.observeLookup();
    try {
      const rating = await ahrefs(domain);
      const ttl =
        rating.status === 'ok'
          ? config.cache.ttl.domainOkMs
          : rating.status === 'not_found'
            ? config.cache.ttl.domainNotFoundMs
            : config.cache.ttl.domainErrorMs;
      domainCache.putDomain(
        domain,
        { dr: rating.dr, status: rating.status, error: rating.error ?? null },
        new Date(now()).toISOString(),
        ttl,
      );
      row.dr = rating.dr;
      row.drStatus = rating.status;
      // A fresh lookup that returns an error (without throwing) must keep its
      // returned error code, exactly like a thrown failure.
      row.drError = rating.error ?? null;
      resolvedDrs.set(domain, { dr: rating.dr, status: rating.status, error: rating.error ?? null });
      sourceByDomain.set(domain, { source: 'fresh', fetchedAt: rating.fetchedAt });
      tracker?.recordLookup('fresh', rating.status, rating.dr, domain);
    } catch (error) {
      const code = error instanceof ResearchError ? error.code : 'AHREFS_ERROR';
      // A thrown 401/403 on the first real lookup is a systemic auth failure,
      // not an isolated domain error. Classify by explicit httpStatus, never by
      // regex on the message (which can false-positive on unrelated text). Record
      // it so the stage is marked failed and no doomed fan-out occurs.
      if (!tracker?.hasObservedLookup() && error instanceof ResearchError && (error.httpStatus === 401 || error.httpStatus === 403)) {
        tracker?.recordSystemicFailure(code);
        // Systemic auth failure: stop the DR stage entirely. Do not fan out doomed
        // requests for the remaining domains — the key is unusable.
        logger(`  ✗ Ahrefs systemic auth failure (${error.httpStatus}) on ${domain}. Stopping DR stage.`);
        break;
      }
      logger(`  ⚠ Ahrefs DR lookup failed for ${domain}: ${code}${error instanceof ResearchError && error.httpStatus ? ` (${error.httpStatus})` : ''}`);
      row.dr = null;
      row.drStatus = 'error';
      row.drError = code;
      resolvedDrs.set(domain, { dr: null, status: 'error', error: code });
      sourceByDomain.set(domain, { source: 'fresh', fetchedAt: new Date(now()).toISOString() });
      // Persistent 429/5xx and unexpected throws are cached as errors so the
      // domain is not re-fetched until domainErrorMs elapses.
      domainCache.putDomain(
        domain,
        { dr: null, status: 'error', error: code },
        new Date(now()).toISOString(),
        config.cache.ttl.domainErrorMs,
      );
      tracker?.recordLookup('fresh', 'error', null, domain);
    }
    await sleep(config.ahrefs.rateLimitMinDelayMs);
  }

  return sourceByDomain;
}

export type { RetrySettings, BreakerSettings };
