import process from 'node:process';
import { DEFAULT_CLI_DEPS, runDiscovery, type CliDeps } from '../discovery/runDiscovery.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import { archiveResearchDirectory, resolveOutputRoot } from '../outputs/researchLayout.js';
import { acquireResearchAppendLock } from '../research/appendLock.js';
import { previewResearchAppend, type ResearchAppendPreviewV1 } from '../research/appendPreview.js';
import { prepareResearchAppend, readResearchContainer } from '../research/batches.js';
import { ResearchError } from '../shared/errors.js';

export type ResearchBatchExecutionResultV1 = {
  version: 1;
  researchId: string;
  researchDirectory: string;
  batchId: string;
  previousRunId: string;
  currentRunId: string;
  inputUniqueKeywordCount: number;
  addedKeywordCount: number;
  duplicateKeywordCount: number;
  promotedKeywordCount: number;
  promotedNormalizedKeywords: string[];
  changed: boolean;
  discovery: {
    attempted: boolean;
    exitCode: number | null;
    state: string | null;
  };
  archiveWarning: string | null;
};

export type ResearchBatchDeps = {
  previewAppend: typeof previewResearchAppend;
  acquireAppendLock: typeof acquireResearchAppendLock;
  readContainer: typeof readResearchContainer;
  prepareAppend: typeof prepareResearchAppend;
  runDiscovery: typeof runDiscovery;
  archiveResearchDirectory: typeof archiveResearchDirectory;
  cliDeps: CliDeps;
};

export const DEFAULT_RESEARCH_BATCH_DEPS: ResearchBatchDeps = {
  previewAppend: previewResearchAppend,
  acquireAppendLock: acquireResearchAppendLock,
  readContainer: readResearchContainer,
  prepareAppend: prepareResearchAppend,
  runDiscovery,
  archiveResearchDirectory,
  cliDeps: DEFAULT_CLI_DEPS,
};

export type ResearchBatchOptions = {
  outputRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  deps?: ResearchBatchDeps;
};

export async function previewResearchBatch(
  researchId: string,
  seeds: SeedKeyword[],
  options: ResearchBatchOptions = {},
): Promise<ResearchAppendPreviewV1> {
  const normalizedId = requireResearchId(researchId);
  requireSeeds(seeds);
  const env = options.env ?? process.env;
  const deps = options.deps ?? DEFAULT_RESEARCH_BATCH_DEPS;
  const outputRoot = resolveOutputRoot(options.outputRoot ?? null, env);
  return deps.previewAppend({ outputRoot, targetRunId: normalizedId, seeds });
}

/**
 * Commit one batch and, when the append forks discovery, collect only the
 * resulting pending/promoted discovery checkpoints while the composite
 * execution -> batch lock remains held. Downstream config-first stages are not
 * entered implicitly; canonical nextAction decides what happens after discovery.
 */
export async function appendResearchBatch(
  researchId: string,
  seedsPath: string,
  seeds: SeedKeyword[],
  options: ResearchBatchOptions = {},
): Promise<ResearchBatchExecutionResultV1> {
  const normalizedId = requireResearchId(researchId);
  if (seedsPath.trim() === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Batch seeds path is required.');
  }
  requireSeeds(seeds);

  const env = options.env ?? process.env;
  const deps = options.deps ?? DEFAULT_RESEARCH_BATCH_DEPS;
  const outputRoot = resolveOutputRoot(options.outputRoot ?? null, env);
  const lock = await deps.acquireAppendLock(outputRoot, normalizedId);
  try {
    const container = await deps.readContainer(lock.researchDirectory);
    if (container === null) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Research ${normalizedId} has no managed research container; UI batch append is unavailable.`,
      );
    }
    if (container.researchId !== lock.researchId) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Research identity changed before batch append: lock=${lock.researchId}, container=${container.researchId}.`,
      );
    }

    const prepared = await deps.prepareAppend({
      outputRoot,
      targetRunId: container.researchId,
      seedsPath,
      seeds,
    });
    if (prepared.researchId !== container.researchId) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Batch append changed stable research identity: ${container.researchId} -> ${prepared.researchId}.`,
      );
    }

    if (!prepared.changed) {
      const archiveWarning = await refreshArchiveWarning(deps, prepared.researchDirectory);
      return batchResult(prepared, {
        attempted: false,
        exitCode: null,
        state: null,
      }, archiveWarning);
    }

    const discovery = await deps.runDiscovery(
      {
        input: { kind: 'resume', runId: prepared.currentRunId },
        outputRoot,
        manageProcessSignals: false,
      },
      deps.cliDeps,
      env,
    );
    const archiveWarning = discovery.exitCode === 0
      ? null
      : await refreshArchiveWarning(deps, prepared.researchDirectory);

    return batchResult(prepared, {
      attempted: true,
      exitCode: discovery.exitCode,
      state: discovery.state,
    }, archiveWarning);
  } finally {
    await lock.release();
  }
}

function batchResult(
  prepared: Awaited<ReturnType<typeof prepareResearchAppend>>,
  discovery: ResearchBatchExecutionResultV1['discovery'],
  archiveWarning: string | null,
): ResearchBatchExecutionResultV1 {
  return {
    version: 1,
    researchId: prepared.researchId,
    researchDirectory: prepared.researchDirectory,
    batchId: prepared.batchId,
    previousRunId: prepared.previousRunId,
    currentRunId: prepared.currentRunId,
    inputUniqueKeywordCount: prepared.inputUniqueKeywordCount,
    addedKeywordCount: prepared.addedKeywordCount,
    duplicateKeywordCount: prepared.duplicateKeywordCount,
    promotedKeywordCount: prepared.promotedKeywordCount,
    promotedNormalizedKeywords: [...prepared.promotedNormalizedKeywords],
    changed: prepared.changed,
    discovery,
    archiveWarning,
  };
}

async function refreshArchiveWarning(
  deps: ResearchBatchDeps,
  researchDirectory: string,
): Promise<string | null> {
  try {
    await deps.archiveResearchDirectory(researchDirectory);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function requireResearchId(value: string): string {
  const normalized = value.trim();
  if (normalized === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Research id is required for batch operation.');
  }
  return normalized;
}

function requireSeeds(seeds: SeedKeyword[]): void {
  if (seeds.length === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Batch input contains no research keywords.');
  }
}
