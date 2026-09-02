import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { acquireResearchExecutionLock } from '../operatorConfig/executionLock.js';
import { resolveEnrichmentLocation } from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';

export async function acquireFinalizationOperatorExecutionLock(
  outputRoot: string,
  enrichmentId: string,
): Promise<() => Promise<void>> {
  const location = await resolveEnrichmentLocation(outputRoot, enrichmentId);
  const store = RunStore.openReadOnly(join(location.enrichmentDirectory, 'enrichment.sqlite'));
  try {
    const run = store.loadEnrichmentRun(enrichmentId);
    if (!run) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${enrichmentId}.`);
    }
    return await acquireResearchExecutionLock(outputRoot, run.sourceRunId);
  } finally {
    store.close();
  }
}

export async function withFinalizationOperatorExecutionLock<T>(
  outputRoot: string,
  enrichmentId: string,
  action: () => Promise<T>,
): Promise<T> {
  const release = await acquireFinalizationOperatorExecutionLock(outputRoot, enrichmentId);
  try {
    return await action();
  } finally {
    await release();
  }
}
