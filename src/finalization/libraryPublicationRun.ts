import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveEnrichmentLocation } from '../outputs/researchLayout.js';
import {
  publishResearchToLibrary,
  RESEARCH_LIBRARY_DIRECTORY,
} from '../library/researchLibrary.js';
import { acquirePublishLock } from '../library/publishLock.js';
import { relinkResearchPublicationHistory } from '../library/researchLineage.js';
import { acquireResearchBatchLock, readResearchContainer } from '../research/batches.js';
import { ResearchError } from '../shared/errors.js';

export type LibraryPublicationRunRequest = {
  outputRoot: string;
  enrichmentId: string;
  logger?: (line: string) => void;
};

export type LibraryPublicationRunResult = {
  publicationId: string;
  changed: boolean;
  supersedesPublicationId: string | null;
  publicationCount: number;
  libraryDbPath: string;
  libraryJsonPath: string;
  libraryArchivePath: string;
};

type PublicationTarget = {
  sourceRunId: string;
  legacy: boolean;
};

export async function runLibraryPublication(
  request: LibraryPublicationRunRequest,
): Promise<LibraryPublicationRunResult> {
  const logger = request.logger ?? ((line: string) => console.log(line));
  let releaseResearchLock: (() => Promise<void>) | undefined;
  let releaseLibraryLock: (() => Promise<void>) | undefined;
  let primaryError: unknown = null;

  try {
    const target = await inspectPublicationTarget(request.outputRoot, request.enrichmentId);
    if (!target.legacy) {
      const researchLock = await acquireResearchBatchLock(request.outputRoot, target.sourceRunId);
      releaseResearchLock = researchLock.release;
    }

    await assertCurrentResearchEnrichment(request.outputRoot, request.enrichmentId);
    releaseLibraryLock = await acquirePublishLock(join(request.outputRoot, RESEARCH_LIBRARY_DIRECTORY));

    const first = await publishResearchToLibrary({
      outputRoot: request.outputRoot,
      enrichmentId: request.enrichmentId,
    });
    const lineagePrevious = relinkResearchPublicationHistory(
      first.libraryDbPath,
      first.publicationId,
    );
    const refreshed = await publishResearchToLibrary({
      outputRoot: request.outputRoot,
      enrichmentId: request.enrichmentId,
    });
    const result: LibraryPublicationRunResult = {
      ...refreshed,
      changed: first.changed,
      supersedesPublicationId: lineagePrevious,
    };

    logger(result.changed
      ? `Published ${result.publicationId}`
      : `Already published ${result.publicationId}`);
    if (result.supersedesPublicationId) {
      logger(`Supersedes: ${result.supersedesPublicationId}`);
    }
    logger(`Library publications: ${result.publicationCount}`);
    logger(`SQLite: ${result.libraryDbPath}`);
    logger(`Index: ${result.libraryJsonPath}`);
    logger(`Archive: ${result.libraryArchivePath}`);
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let releaseError: unknown = null;
    if (releaseLibraryLock) {
      try {
        await releaseLibraryLock();
      } catch (error) {
        releaseError = error;
      }
    }
    if (releaseResearchLock) {
      try {
        await releaseResearchLock();
      } catch (error) {
        releaseError ??= error;
      }
    }
    if (primaryError === null && releaseError !== null) {
      throw releaseError;
    }
  }
}

async function inspectPublicationTarget(
  outputRoot: string,
  enrichmentId: string,
): Promise<PublicationTarget> {
  const location = await resolveEnrichmentLocation(outputRoot, enrichmentId);
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(join(location.enrichmentDirectory, 'manifest.json'), 'utf8'),
    ) as unknown;
  } catch (error) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Cannot read enrichment manifest for ${enrichmentId}.`,
      { cause: error },
    );
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Invalid enrichment manifest for ${enrichmentId}.`);
  }
  const sourceRunId = (manifest as Record<string, unknown>).sourceRunId;
  if (typeof sourceRunId !== 'string' || sourceRunId === '') {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Enrichment ${enrichmentId} has no sourceRunId.`);
  }
  return { sourceRunId, legacy: location.legacy };
}

async function assertCurrentResearchEnrichment(
  outputRoot: string,
  enrichmentId: string,
): Promise<void> {
  const location = await resolveEnrichmentLocation(outputRoot, enrichmentId);
  if (location.legacy) return;
  const container = await readResearchContainer(location.researchDirectory);
  if (!container) return;

  const target = await inspectPublicationTarget(outputRoot, enrichmentId);
  if (target.sourceRunId !== container.currentRunId) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Enrichment ${enrichmentId} belongs to historical run ${target.sourceRunId}; research ${container.researchId} currently points to ${container.currentRunId}. Run enrichment for the current discovery snapshot before publishing to the library.`,
    );
  }
}
