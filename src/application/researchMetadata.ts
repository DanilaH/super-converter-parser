import process from 'node:process';
import { archiveResearchDirectory } from '../outputs/researchLayout.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { acquireResearchAppendLock } from '../research/appendLock.js';
import {
  updateResearchDisplayLabel,
  type ResearchLabelUpdateV1,
} from '../research/metadata.js';
import { ResearchError } from '../shared/errors.js';

export type RenameResearchLabelResultV1 = ResearchLabelUpdateV1 & {
  archiveWarning: string | null;
};

export type RenameResearchLabelDeps = {
  acquireResearchLock: typeof acquireResearchAppendLock;
  updateDisplayLabel: typeof updateResearchDisplayLabel;
  archiveResearchDirectory: typeof archiveResearchDirectory;
};

export const DEFAULT_RENAME_RESEARCH_LABEL_DEPS: RenameResearchLabelDeps = {
  acquireResearchLock: acquireResearchAppendLock,
  updateDisplayLabel: updateResearchDisplayLabel,
  archiveResearchDirectory,
};

export type RenameResearchLabelOptions = {
  outputRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  deps?: RenameResearchLabelDeps;
  now?: () => Date;
};

/**
 * Rename mutable research display metadata without changing directory identity,
 * stable/run IDs, lineage, immutable evidence, or OperatorConfig provenance.
 */
export async function renameResearchLabel(
  researchId: string,
  labelValue: unknown,
  options: RenameResearchLabelOptions = {},
): Promise<RenameResearchLabelResultV1> {
  const normalizedId = researchId.trim();
  if (normalizedId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Research id is required for display-label rename.');
  }
  if (typeof labelValue !== 'string') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Research display label must be a string.');
  }
  const label = labelValue.trim();
  if (label === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Research display label must not be blank.');
  }

  const env = options.env ?? process.env;
  const deps = options.deps ?? DEFAULT_RENAME_RESEARCH_LABEL_DEPS;
  const outputRoot = resolveOutputRoot(options.outputRoot ?? null, env);
  const lock = await deps.acquireResearchLock(outputRoot, normalizedId);
  try {
    const updated = await deps.updateDisplayLabel(
      lock.researchDirectory,
      label,
      options.now?.() ?? new Date(),
    );
    if (updated.researchId !== lock.researchId) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Research identity changed while renaming display metadata: ${lock.researchId} -> ${updated.researchId}.`,
      );
    }

    let archiveWarning: string | null = null;
    if (updated.changed) {
      try {
        await deps.archiveResearchDirectory(lock.researchDirectory);
      } catch (error) {
        archiveWarning = error instanceof Error ? error.message : String(error);
      }
    }
    return { ...updated, archiveWarning };
  } finally {
    await lock.release();
  }
}
