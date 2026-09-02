import {
  runEnrichment as runEnrichmentCore,
  type EnrichmentOptions,
  type EnrichmentOutcome,
} from './engine.js';
import { acquireEnrichmentExecutionLock } from './executionLock.js';

/**
 * Operator-facing enrichment execution boundary.
 *
 * Only the owner of this per-generation lock may interpret persisted `running`
 * checkpoints as crash residue. A live concurrent process therefore fails
 * before the core can reset checkpoints or mutate the durable run state.
 */
export async function runEnrichmentLocked(options: EnrichmentOptions): Promise<EnrichmentOutcome> {
  const releaseExecutionLock = await acquireEnrichmentExecutionLock(
    options.enrichmentDirectory,
    options.enrichmentId,
  );
  try {
    return await runEnrichmentCore(options);
  } finally {
    await releaseExecutionLock();
  }
}
