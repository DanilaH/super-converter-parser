import { join, resolve } from 'node:path';
import { RunStore, isTerminalKeywordStatus } from '../db/store.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import { resolveRunLocation } from '../outputs/researchLayout.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { ResearchError } from '../shared/errors.js';
import { readResearchContainer } from './batches.js';

export type ResearchAppendPreviewV1 = {
  version: 1;
  researchId: string;
  researchDirectory: string;
  currentRunId: string;
  batchId: string;
  inputUniqueKeywordCount: number;
  addedKeywordCount: number;
  duplicateKeywordCount: number;
  promotedKeywordCount: number;
  promotedNormalizedKeywords: string[];
  changed: boolean;
};

/**
 * Read-only advisory append classification for an existing managed research.
 *
 * Commit-time append remains authoritative and repeats these checks under the
 * canonical composite research lock before writing any batch/fork state.
 */
export async function previewResearchAppend(input: {
  outputRoot: string;
  targetRunId: string;
  seeds: SeedKeyword[];
}): Promise<ResearchAppendPreviewV1> {
  const target = await resolveRunLocation(input.outputRoot, input.targetRunId);
  if (target.legacy) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'Batch append preview is available only for managed researches in the current durable output layout.',
    );
  }

  const container = await readResearchContainer(target.researchDirectory);
  if (container === null) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${input.targetRunId} has no managed research container; UI batch append is unavailable.`,
    );
  }

  const current = await resolveRunLocation(input.outputRoot, container.currentRunId);
  if (current.legacy || resolve(current.researchDirectory) !== resolve(target.researchDirectory)) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Research ${container.researchId} current run points outside its managed research directory.`,
    );
  }

  const store = RunStore.openReadOnly(join(current.discoveryDirectory, 'run.sqlite'));
  try {
    const run = store.loadRun(container.currentRunId);
    if (!run) {
      throw new ResearchError('RESUME_NOT_FOUND', `Current research run not found: ${container.currentRunId}`);
    }
    if (run.state !== 'completed' && run.state !== 'completed_with_errors') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Cannot append while current run ${container.currentRunId} is ${run.state}. Resume/finish it first.`,
      );
    }
    if (
      run.parserVersions.surfer !== SURFER_PARSER_VERSION
      || run.parserVersions.google !== GOOGLE_PARSER_VERSION
    ) {
      throw new ResearchError(
        'RESUME_PARSER_MISMATCH',
        `Current research run used parser versions ${run.parserVersions.surfer}/${run.parserVersions.google}; this build uses ${SURFER_PARSER_VERSION}/${GOOGLE_PARSER_VERSION}. Start a new research instead of mixing parser generations.`,
      );
    }

    const sourceKeywords = store.loadKeywords(container.currentRunId);
    if (sourceKeywords.some((keyword) => !isTerminalKeywordStatus(keyword.status))) {
      throw new ResearchError(
        'DB_ERROR',
        `Current research run ${container.currentRunId} is terminal but contains non-terminal keyword checkpoints.`,
      );
    }

    const sourceByNormalized = new Map(
      sourceKeywords.map((keyword) => [keyword.normalizedKeyword, keyword] as const),
    );
    const promotedNormalizedKeywords = input.seeds
      .filter((seed) => {
        const keyword = sourceByNormalized.get(seed.normalizedKeyword);
        return keyword !== undefined && keyword.sources.some((source) => source.type === 'surfer_related');
      })
      .map((seed) => seed.normalizedKeyword);
    const addedKeywordCount = input.seeds.filter(
      (seed) => !sourceByNormalized.has(seed.normalizedKeyword),
    ).length;
    const promotedKeywordCount = promotedNormalizedKeywords.length;

    return {
      version: 1,
      researchId: container.researchId,
      researchDirectory: target.researchDirectory,
      currentRunId: container.currentRunId,
      batchId: `batch-${String(container.batches.length + 1).padStart(4, '0')}`,
      inputUniqueKeywordCount: input.seeds.length,
      addedKeywordCount,
      duplicateKeywordCount: input.seeds.length - addedKeywordCount,
      promotedKeywordCount,
      promotedNormalizedKeywords,
      changed: addedKeywordCount > 0 || promotedKeywordCount > 0,
    };
  } finally {
    store.close();
  }
}
