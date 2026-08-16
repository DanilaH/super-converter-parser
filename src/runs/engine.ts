import type { ResearchConfig } from '../config/config.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import type { CollectionResult } from '../browser/collect.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { ResearchError } from '../shared/errors.js';
import {
  RunStore,
  isTerminalKeywordStatus,
  storedKeywordToRecord,
  type StoredKeyword,
  type StoredRun,
} from '../db/store.js';
import {
  RESUMABLE_RUN_STATES,
  TERMINAL_RUN_STATES,
  writeJsonAtomic,
  type KeywordRecord,
  type RunManifest,
  type RunState,
} from './run.js';
import {
  CircuitBreaker,
  isTransientErrorCode,
  retryDelayMs,
  type BreakerSettings,
  type RetrySettings,
} from './policies.js';

export type CollectKeywordFn = (
  keyword: KeywordRecord,
  debugRoot: string,
) => Promise<CollectionResult>;

export type EngineHooks = {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  logger: (line: string) => void;
  pauseRequested: () => boolean;
};

export type RunOutcome =
  | { kind: 'finished'; state: 'completed' | 'completed_with_errors' }
  | { kind: 'paused'; reason: string };

export type ExecuteRunOptions = {
  store: RunStore;
  runId: string;
  mode: 'fresh' | 'resume';
  keywords: SeedKeyword[];
  config: ResearchConfig;
  input: { kind: 'seeds'; path: string };
  runDirectory: string;
  debugRoot: string;
  collect: CollectKeywordFn;
  hooks: EngineHooks;
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

  let run: StoredRun;
  if (mode === 'fresh') {
    store.createRun({
      runId,
      configSnapshot: config,
      parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
      input,
      keywords,
    });
    store.setRunState(runId, 'running');
    run = store.loadRun(runId) as StoredRun;
  } else {
    run = validateResume(store, runId);
    const stale = store.markStaleRunningAsPending(runId);
    if (stale > 0) {
      logger(`  ✓ ${stale} stale running keyword(s) reset to pending`);
    }
    store.setRunState(runId, 'running');
  }

  const pending = store
    .loadKeywords(runId)
    .filter((keyword) => !isTerminalKeywordStatus(keyword.status))
    .sort((a, b) => a.idx - b.idx);

  const total = store.loadKeywords(runId).length;
  const breaker = new CircuitBreaker(config.circuitBreaker);
  const samples: number[] = [];
  let processedCount = store
    .loadKeywords(runId)
    .filter((keyword) => isTerminalKeywordStatus(keyword.status)).length;

  logger('');
  if (mode === 'resume') {
    logger(`[resume] ${runId}: ${pending.length}/${total} keyword(s) remaining`);
  }

  let outcome: RunOutcome | null = null;

  for (let loopIndex = 0; loopIndex < pending.length; loopIndex += 1) {
    const stored = pending[loopIndex] as StoredKeyword;

    if (hooks.pauseRequested()) {
      outcome = { kind: 'paused', reason: 'SIGINT received; run paused safely.' };
      break;
    }

    const tripReason = breaker.tripReason();
    if (tripReason !== null) {
      outcome = { kind: 'paused', reason: tripReason };
      break;
    }

    const idx = stored.idx;
    stored.status = 'running';
    store.updateKeyword(runId, stored);
    processedCount += 1;
    logger(`[${processedCount}/${total}] ${stored.normalizedKeyword}`);

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
    };
    store.updateKeyword(runId, committed);
    store.replaceSerpRows(runId, idx, result?.serpRows ?? []);
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

    await writeSnapshots(store, runId, runDirectory, 'running');
    logger(
      progressLine(
        total,
        countProgress(store.loadKeywords(runId)),
        pending.length - loopIndex - 1,
        samples,
      ),
    );
  }

  if (outcome === null) {
    const progress = countProgress(store.loadKeywords(runId));
    const state: 'completed' | 'completed_with_errors' =
      progress.errors > 0 ? 'completed_with_errors' : 'completed';
    store.setRunState(runId, state);
    await writeSnapshots(store, runId, runDirectory, state);
    outcome = { kind: 'finished', state };
  } else {
    store.setRunState(runId, 'paused', { pauseReason: outcome.reason });
    await writeSnapshots(store, runId, runDirectory, 'paused');
    logger('');
    logger(`Run paused: ${outcome.reason}`);
    logger('Resume with:');
    logger(`  ${RESUME_COMMAND_PREFIX} ${runId}`);
  }

  return outcome;
}

function countProgress(keywords: StoredKeyword[]): {
  completed: number;
  partial: number;
  failed: number;
  errors: number;
} {
  const completed = keywords.filter((item) => item.status === 'completed').length;
  const partial = keywords.filter((item) => item.status === 'partial').length;
  const failed = keywords.filter((item) => item.status === 'failed').length;
  return { completed, partial, failed, errors: partial + failed };
}

function progressLine(
  total: number,
  progress: { completed: number; partial: number; failed: number; errors: number },
  remaining: number,
  samples: number[],
): string {
  const processed = progress.completed + progress.partial + progress.failed;
  let eta = '';
  if (samples.length >= 3 && remaining > 0) {
    const averageMs = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    eta = ` | ETA ~${formatDuration(Math.round(averageMs * remaining))}`;
  }
  return `Keywords ${processed}/${total} | completed ${progress.completed} | partial ${progress.partial} | failed ${progress.failed} | errors ${progress.errors}${eta}`;
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

export async function writeSnapshots(
  store: RunStore,
  runId: string,
  runDirectory: string,
  state: RunState,
): Promise<void> {
  const run = store.loadRun(runId) as StoredRun;
  const keywords = store.loadKeywords(runId);
  const serpRows = store.loadSerpRows(runId);
  const progress = countProgress(keywords);

  const manifest: RunManifest = {
    runId,
    createdAt: run.createdAt,
    updatedAt: new Date().toISOString(),
    state,
    input: run.input,
    configSnapshot: run.configSnapshot,
    parserVersions: run.parserVersions,
    pauseReason: run.pauseReason,
    progress: {
      totalKeywords: keywords.length,
      completedKeywords: progress.completed,
      partialKeywords: progress.partial,
      failedKeywords: progress.failed,
      errors: progress.errors,
      lookups: run.lookups,
    },
  };

  await writeJsonAtomic(`${runDirectory}/manifest.json`, manifest, 'run manifest');
  await writeJsonAtomic(
    `${runDirectory}/keywords.json`,
    keywords.map(storedKeywordToRecord),
    'keywords output',
  );
  await writeJsonAtomic(`${runDirectory}/serp.json`, serpRows, 'SERP output');
}

export type { RetrySettings, BreakerSettings };