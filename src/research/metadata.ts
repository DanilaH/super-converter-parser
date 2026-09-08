import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readResearchContainer, RESEARCH_CONTAINER_FILE, type ResearchContainer } from './batches.js';
import { ResearchError } from '../shared/errors.js';

export type ResearchLabelUpdateV1 = {
  version: 1;
  researchId: string;
  researchDirectory: string;
  previousLabel: string;
  label: string;
  changed: boolean;
  updatedAt: string;
};

/**
 * Update only mutable research display metadata.
 *
 * The caller must serialize mutations for this research. This function reads the
 * canonical container through the lineage-validating adapter and rewrites only
 * `label` and `updatedAt`; directory/IDs/batches remain byte-for-byte equivalent
 * at the JSON value level.
 */
export async function updateResearchDisplayLabel(
  researchDirectory: string,
  label: string,
  now: Date = new Date(),
): Promise<ResearchLabelUpdateV1> {
  const container = await readResearchContainer(researchDirectory);
  if (container === null) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research at ${researchDirectory} has no managed research container; display-label rename is unavailable.`,
    );
  }

  if (container.label === label) {
    return result(researchDirectory, container, container.label, false);
  }

  const next: ResearchContainer = {
    ...container,
    label,
    updatedAt: now.toISOString(),
  };
  await writeContainerAtomic(researchDirectory, next);
  return result(researchDirectory, next, container.label, true);
}

function result(
  researchDirectory: string,
  container: ResearchContainer,
  previousLabel: string,
  changed: boolean,
): ResearchLabelUpdateV1 {
  return {
    version: 1,
    researchId: container.researchId,
    researchDirectory,
    previousLabel,
    label: container.label,
    changed,
    updatedAt: container.updatedAt,
  };
}

async function writeContainerAtomic(
  researchDirectory: string,
  container: ResearchContainer,
): Promise<void> {
  const path = join(researchDirectory, RESEARCH_CONTAINER_FILE);
  const tempPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(container, null, 2)}\n`, 'utf8');
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to update research display metadata ${path}.`,
      { cause: error },
    );
  }
}
