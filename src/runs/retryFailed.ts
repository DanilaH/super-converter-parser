import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { RunStore, type StoredRun } from '../db/store.js';
import { RESUMABLE_RUN_STATES } from './run.js';
import { ResearchError } from '../shared/errors.js';

export type FailedKeywordRetryPreparation = {
  run: StoredRun;
  reopenedKeywordIdxs: number[];
  openKeywordIdxs: number[];
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

/**
 * Explicitly reopens only failed keyword checkpoints. The store snapshots every
 * failed checkpoint before mutation and leaves an open retry-attempt marker that
 * survives process interruption. Ordinary resume can then continue that repair
 * without needing --retry-failed again.
 */
export function prepareFailedKeywordRetry(
  store: RunStore,
  runId: string,
): FailedKeywordRetryPreparation {
  const run = store.loadRun(runId);
  if (!run) {
    throw new ResearchError(
      'RESUME_NOT_FOUND',
      `Run "${runId}" was not found. Use --seeds to start a new run.`,
    );
  }

  assertRetryParserCompatibility(run);

  const stateEligible = RESUMABLE_RUN_STATES.has(run.state) || run.state === 'completed_with_errors';
  if (!stateEligible) {
    throw new ResearchError(
      'RESUME_TERMINAL_RUN',
      `Run "${runId}" is in state "${run.state}" and cannot be reopened for failed-keyword repair. Only resumable runs or completed_with_errors runs are eligible.`,
    );
  }

  const alreadyOpen = store.loadOpenKeywordRetryIndexes(runId);
  const failed = store.loadKeywords(runId).filter((keyword) => keyword.status === 'failed');

  if (failed.length === 0) {
    if (alreadyOpen.length > 0) {
      return {
        run,
        reopenedKeywordIdxs: [],
        openKeywordIdxs: alreadyOpen,
      };
    }
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Run "${runId}" has no failed keywords to retry.`,
    );
  }

  const reopenedKeywordIdxs = store.beginFailedKeywordRetries(runId);
  const updatedRun = store.loadRun(runId);
  if (!updatedRun) {
    throw new ResearchError('DB_ERROR', `Run "${runId}" disappeared while preparing failed-keyword repair.`);
  }

  return {
    run: updatedRun,
    reopenedKeywordIdxs,
    openKeywordIdxs: store.loadOpenKeywordRetryIndexes(runId),
  };
}
