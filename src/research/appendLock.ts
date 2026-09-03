import { acquireResearchExecutionLock } from '../operatorConfig/executionLock.js';
import { resolveRunLocation } from '../outputs/researchLayout.js';
import { acquireResearchBatchLock, readResearchContainer } from './batches.js';

export type ResearchAppendLock = {
  researchId: string;
  researchDirectory: string;
  release: () => Promise<void>;
};

/**
 * Serialize append against config-first continuation for the same stable research.
 *
 * Lock order is intentionally execution -> batch. Config-driven finalization
 * already holds the execution lock before Library publication acquires the batch
 * lock, so matching that order avoids an AB/BA deadlock. The append caller keeps
 * this composite lock through its discovery collection, not only through the fork.
 */
export async function acquireResearchAppendLock(
  outputRoot: string,
  targetRunId: string,
): Promise<ResearchAppendLock> {
  const targetLocation = await resolveRunLocation(outputRoot, targetRunId);
  const container = await readResearchContainer(targetLocation.researchDirectory);
  const researchId = container?.researchId ?? targetRunId;

  const releaseExecution = await acquireResearchExecutionLock(outputRoot, researchId);
  let releaseBatch: (() => Promise<void>) | null = null;
  try {
    const batch = await acquireResearchBatchLock(outputRoot, targetRunId);
    releaseBatch = batch.release;
    let released = false;
    return {
      researchId,
      researchDirectory: batch.researchDirectory,
      release: async () => {
        if (released) return;
        released = true;
        let releaseError: unknown = null;
        try {
          await batch.release();
        } catch (error) {
          releaseError = error;
        }
        try {
          await releaseExecution();
        } catch (error) {
          releaseError ??= error;
        }
        if (releaseError !== null) throw releaseError;
      },
    };
  } catch (error) {
    if (releaseBatch === null) {
      try {
        await releaseExecution();
      } catch {
        // Preserve the acquisition failure. Closing the execution-lock connection
        // releases SQLite ownership even when its explicit COMMIT reported an error.
      }
    }
    throw error;
  }
}
