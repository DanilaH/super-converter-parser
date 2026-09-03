import { resolveRunLocation } from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';
import * as core from './batchesCore.js';
import type { ResearchContainer } from './batchesCore.js';

export * from './batchesCore.js';

export async function readResearchContainer(researchDirectory: string): Promise<ResearchContainer | null> {
  const container = await core.readResearchContainer(researchDirectory);
  if (container === null) return null;
  assertCurrentContainerHead(container, researchDirectory);
  return container;
}

export async function prepareResearchAppend(
  input: Parameters<typeof core.prepareResearchAppend>[0],
): ReturnType<typeof core.prepareResearchAppend> {
  const target = await resolveRunLocation(input.outputRoot, input.targetRunId);
  if (!target.legacy) {
    await readResearchContainer(target.researchDirectory);
  }
  return core.prepareResearchAppend(input);
}

function assertCurrentContainerHead(container: ResearchContainer, researchDirectory: string): void {
  const latestBatch = container.batches.at(-1) as unknown;
  if (!isRecord(latestBatch) || typeof latestBatch.resultRunId !== 'string') {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Research container in ${researchDirectory} has no valid latest batch result.`,
    );
  }
  if (container.currentRunId !== latestBatch.resultRunId) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Research ${container.researchId} current run ${container.currentRunId} does not match latest batch result ${latestBatch.resultRunId}.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
