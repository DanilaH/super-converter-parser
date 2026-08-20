import type { ResearchConfig } from '../config/config.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import type { MicrosoftKeyword } from '../input/microsoft/normalize.js';
import type { CollectionResult, SurferRelatedOutcome } from '../browser/collect.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import type { SurferRelatedKeyword } from '../surfer/parser.js';
import { ResearchError } from '../shared/errors.js';
import {
  RunStore,
  isTerminalKeywordStatus,
  storedKeywordToRecord,
  type CacheStatus,
  type StoredKeyword,
  type StoredRun,
} from '../db/store.js';
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
import { mergedCacheRefresh, resolveKeywordAccess, type CacheResolution } from '../cache/resolve.js';
import { ttlMsForKeywordStatus, ttlMsForRelatedStatus, type CachedRelatedEntry, type KeywordCache, type CachedRelatedStatus } from '../cache/store.js';

export type CollectKeywordFn = (
  keyword: KeywordRecord,
  debugRoot: string,
) => Promise<CollectionResult>;

export type SnapshotsPublisher = (
  store: RunStore,
  runId: string,
  runDirectory: string,
  state: RunState,
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
};

export type RunOutcome =
  | { kind: 'finished'; state: 'completed' | 'completed_with_errors' }
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
  hooks: EngineHooks;
  publishSnapshots?: SnapshotsPublisher;
  cache?: EngineCacheOptions;
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
  const { store, runId, mode, keywords, config, input, runDirectory, debugRoot, collect, hooks } =
    options;
  const { logger } = hooks;
  const publish = options.publishSnapshots ?? writeSnapshots;

  const identity = keywordCacheIdentity(config);
  let forceRefresh = options.cache?.forceRefresh ?? false;
  let refreshKeywords = new Set(options.cache?.refreshKeywords ?? []);

  let run: StoredRun;
  if (mode === 'fresh') {
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
      store.commitKeyword(runId, committed, entry.serpRows, 'hit');
      logger(
        `  ✓ cache hit (${entry.record.status}) | volume: ${formatVolume(entry.record.surfer?.volume ?? null)} | organic: ${entry.serpRows.length}`,
      );

      // Warm expansion: a cached keyword still expands from the related cache
      // without touching the browser, preserving the cache-hit benefit. An
      // expired related entry must not be used, otherwise stale candidates
      // would be revived.
      if (config.expansion.enabled && config.expansion.depth >= 1 && isExpandableKeyword(stored)) {
        const relatedEntry = options.cache?.store.getRelated?.(
          buildRelatedCacheKey(stored.normalizedKeyword, identity),
        );
        if (relatedEntry && relatedEntry.status === 'ok' && isRelatedEntryFresh(relatedEntry, hooks.now())) {
          const added = applySurferExpansion({
            runId,
            store,
            parentKeyword: stored.keyword,
            related: relatedRowsToSurferKeywords(relatedEntry.rows),
            config,
            seenNormalized,
            logger,
          });
          for (const name of added) {
            logger(`  ↳ expansion (cached): +${name} (parent: ${stored.keyword})`);
          }
        }
      }
    } else {
      const startAt = hooks.now();
      let result: CollectionResult | null = null;

      for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
        store.incrementLookups(runId);
        result = await collect(storedKeywordToRecord(stored), debugRoot);
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
      store.commitKeyword(runId, committed, result?.serpRows ?? [], cacheStatus);
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

      // Persist the structured related-keyword outcome (ok / empty / error).
      // The status is taken verbatim from collection: a broken related widget
      // is stored as 'error' even when the primary collection succeeded, and a
      // main-parser error combined with a related-parser error keeps 'error'.
      persistRelatedCache({
        cache: options.cache,
        identity,
        keyword: record,
        related: result?.related ?? { status: 'empty', error: null, rows: [] },
        config,
        collectedAt,
      });

      // Expansion runs only for seed keywords; depth-one related candidates are
      // queued for collection but never expanded themselves. It triggers only
      // when the related outcome is 'ok' (i.e. rows were actually parsed).
      if (config.expansion.enabled && config.expansion.depth >= 1 && result && result.related.status === 'ok' && isExpandableKeyword(stored)) {
        const added = applySurferExpansion({
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
    const state: 'completed' | 'completed_with_errors' =
      progress.errors > 0 ? 'completed_with_errors' : 'completed';
    // Publish the final snapshots while the run is still resumable: a failed
    // JSON write must never leave a terminal run without published artifacts.
    // If publication fails, the run stays "running" and resume republishes.
    await publish(store, runId, runDirectory, state);
    store.setRunState(runId, state);
    outcome = { kind: 'finished', state };
  } else {
    store.setRunState(runId, 'paused', { pauseReason: outcome.reason });
    await publish(store, runId, runDirectory, 'paused');
    logger('');
    logger(`Run paused: ${outcome.reason}`);
    logger('Resume with:');
    logger(`  ${RESUME_COMMAND_PREFIX} ${runId}`);
  }

  return outcome;
}

// A keyword is expanded only when it originated from a seed (depth 0). Related
// candidates added by expansion carry a surfer_related source and are collected
// but never expanded further, which keeps expansion strictly depth-one.
function isExpandableKeyword(keyword: StoredKeyword): boolean {
  return keyword.sources.some((source) => source.type === 'seed');
}

function relatedRowsToSurferKeywords(
  rows: ReadonlyArray<{ relatedKeyword: string; overlap: number | null; volume: number | null }>,
): SurferRelatedKeyword[] {
  return rows.map((row) => ({
    keyword: row.relatedKeyword,
    normalizedKeyword: row.relatedKeyword.toLowerCase(),
    overlap: row.overlap,
    volume: row.volume,
  }));
}

function isRelatedEntryFresh(entry: CachedRelatedEntry, now: number): boolean {
  return Date.parse(entry.expiresAt) > now;
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
  if (!cache?.store.putRelated) return;
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

export type { RetrySettings, BreakerSettings };