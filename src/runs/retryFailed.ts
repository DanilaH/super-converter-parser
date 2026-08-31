import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { RunStore, type StoredKeyword, type StoredRun } from '../db/store.js';
import {
  applyFailedKeywordRetries,
  isRetryRepairStateEligible,
  loadOpenKeywordRetryIndexes,
} from '../db/retryAttempts.js';
import { ResearchError } from '../shared/errors.js';

export type FailedKeywordRetryPreparation = {
  run: StoredRun;
  plannedKeywordIdxs: number[];
  openKeywordIdxs: number[];
  requestedAt: string;
};

function assertRetryParserCompatibility(run: StoredRun): void {
  if (
    run.parserVersions.surfer !== SURFER_PARSER_VERSION ||
    run.parserVersions.google !== GOOGLE_PARSER_VERSION
  ) {
    throw new ResearchError(
      'RESUME_PARSER_MISMATCH',
      `Run "${run.runId}" used parser versions ${run.parserVersions.surfer}/${run.parserVersions.google} but the current code is ${SURFER_PARSER_VERSION}/${GOOGLE_PARSER_VERSION}. Start a new run instead; parser versions must not be mixed inside one run.`,
    );
  }
}

export function isPrimaryRepairEligible(keyword: StoredKeyword): boolean {
  if (keyword.status === 'failed') return true;
  if (keyword.status !== 'partial' || keyword.error === null) return false;

  const googleStatus = keyword.google?.serpStatus;
  const googleIncomplete =
    googleStatus === 'fetch_error'
    || googleStatus === 'parse_error'
    || googleStatus === 'not_fetched'
    || googleStatus === 'unknown';
  const legacyGoogleIncomplete =
    googleStatus === undefined
    && (keyword.error.code === 'GOOGLE_SERP_PARSE_ERROR' || keyword.error.code === 'GOOGLE_UNAVAILABLE');
  const surferIncomplete = keyword.surfer === null;

  return surferIncomplete || googleIncomplete || legacyGoogleIncomplete;
}

/**
 * Builds a read-only repair plan. No run state, keyword checkpoint, SERP row,
 * domain aggregate, or retry schema is changed here. The CLI can therefore run
 * all resume config/cache/output preflight before applying operator intent.
 *
 * The historical flag remains --retry-failed, but the repair surface also
 * includes partial primary checkpoints with a persisted Surfer/Google failure.
 * Optional related-keyword errors do not make a keyword partial and are not
 * reopened by this path.
 */
export function prepareFailedKeywordRetry(
  store: RunStore,
  runId: string,
  requestedAt: string = new Date().toISOString(),
): FailedKeywordRetryPreparation {
  const run = store.loadRun(runId);
  if (!run) {
    throw new ResearchError(
      'RESUME_NOT_FOUND',
      `Run "${runId}" was not found. Use --seeds to start a new run.`,
    );
  }

  assertRetryParserCompatibility(run);

  if (!isRetryRepairStateEligible(run.state)) {
    throw new ResearchError(
      'RESUME_TERMINAL_RUN',
      `Run "${runId}" is in state "${run.state}" and cannot be reopened for failed-keyword repair. Only resumable runs or completed_with_errors runs are eligible.`,
    );
  }

  // An interrupted repair already carries durable intent. Re-entering with
  // --retry-failed is idempotent: finish that generation first instead of
  // opening a second attempt for another repairable row mid-repair.
  const alreadyOpen = loadOpenKeywordRetryIndexes(store, runId);
  if (alreadyOpen.length > 0) {
    return {
      run,
      plannedKeywordIdxs: [],
      openKeywordIdxs: alreadyOpen,
      requestedAt,
    };
  }

  const repairable = store
    .loadKeywords(runId)
    .filter(isPrimaryRepairEligible)
    .map((keyword) => keyword.idx);
  if (repairable.length === 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Run "${runId}" has no failed or repairable partial keywords to retry.`,
    );
  }

  return {
    run,
    plannedKeywordIdxs: repairable,
    openKeywordIdxs: [],
    requestedAt,
  };
}

/**
 * Applies a previously validated repair plan after CLI preflight. The DB layer
 * re-checks that every planned checkpoint is still failed/partial, so a stale
 * plan cannot silently overwrite concurrent state.
 */
export function applyFailedKeywordRetryPreparation(
  store: RunStore,
  preparation: FailedKeywordRetryPreparation,
): number[] {
  if (preparation.plannedKeywordIdxs.length === 0) return [];
  return applyFailedKeywordRetries(
    store,
    preparation.run.runId,
    preparation.plannedKeywordIdxs,
    preparation.requestedAt,
  );
}
