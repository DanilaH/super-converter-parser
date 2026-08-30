import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveEnrichmentLocation, resolveOutputRoot } from '../outputs/researchLayout.js';
import {
  publishResearchToLibrary,
  RESEARCH_LIBRARY_DIRECTORY,
} from '../library/researchLibrary.js';
import { acquirePublishLock } from '../library/publishLock.js';
import { relinkResearchPublicationHistory } from '../library/researchLineage.js';
import { acquireResearchBatchLock, readResearchContainer } from '../research/batches.js';
import { ResearchError } from '../shared/errors.js';

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  enrichmentId: string;
  outputRoot: string | null;
};

type PublicationTarget = {
  sourceRunId: string;
  legacy: boolean;
};

function nextValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let help = false;
  let enrichmentId = '';
  let outputRoot: string | null = null;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--enrichment') {
      enrichmentId = nextValue(args, '--enrichment');
    } else if (arg === '--output-root') {
      outputRoot = nextValue(args, '--output-root');
    } else if (arg?.startsWith('-')) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    } else if (arg) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
    }
  }

  if (!help && enrichmentId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--enrichment <id> is required.');
  }
  return { help, enrichmentId, outputRoot };
}

function printUsage(): void {
  console.log('Utility Research Library Publisher');
  console.log('');
  console.log('Usage:');
  console.log('  npm run library:publish -- --enrichment <enrichment-id>');
  console.log('');
  console.log('Options:');
  console.log('  --enrichment <id>   Completed current-layout enrichment to publish.');
  console.log('  --output-root <path> Durable research output root.');
  console.log('  --help, -h          Show this help.');
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

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  let releaseResearchLock: (() => Promise<void>) | undefined;
  let releaseLibraryLock: (() => Promise<void>) | undefined;
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }

    const outputRoot = resolveOutputRoot(args.outputRoot, process.env);
    const target = await inspectPublicationTarget(outputRoot, args.enrichmentId);

    // Append and library publication both read/archive the same top-level
    // research directory. Serialize them on the research lock first, then take
    // the library-wide lock. Append never takes the library lock, so this order
    // cannot deadlock with the batch workflow.
    if (!target.legacy) {
      const researchLock = await acquireResearchBatchLock(outputRoot, target.sourceRunId);
      releaseResearchLock = researchLock.release;
    }

    // Re-check after acquiring the research lock. An append may have completed
    // between the initial manifest read and lock acquisition, making this
    // enrichment historical while we were waiting.
    await assertCurrentResearchEnrichment(outputRoot, args.enrichmentId);
    releaseLibraryLock = await acquirePublishLock(join(outputRoot, RESEARCH_LIBRARY_DIRECTORY));

    const first = await publishResearchToLibrary({
      outputRoot,
      enrichmentId: args.enrichmentId,
    });
    const lineagePrevious = relinkResearchPublicationHistory(
      first.libraryDbPath,
      first.publicationId,
    );
    // relinkResearchPublicationHistory mutates only the durable SQLite truth.
    // An idempotent second publish regenerates library.json/library.zip from that
    // corrected lineage without creating another publication.
    const refreshed = await publishResearchToLibrary({
      outputRoot,
      enrichmentId: args.enrichmentId,
    });
    const result = {
      ...refreshed,
      changed: first.changed,
      supersedesPublicationId: lineagePrevious,
    };

    console.log(result.changed
      ? `Published ${result.publicationId}`
      : `Already published ${result.publicationId}`);
    if (result.supersedesPublicationId) {
      console.log(`Supersedes: ${result.supersedesPublicationId}`);
    }
    console.log(`Library publications: ${result.publicationCount}`);
    console.log(`SQLite: ${result.libraryDbPath}`);
    console.log(`Index: ${result.libraryJsonPath}`);
    console.log(`Archive: ${result.libraryArchivePath}`);
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`${error.code}: ${error.message}`);
      exitCode = error.code === 'INPUT_SCHEMA_ERROR' || error.code === 'RESUME_NOT_FOUND'
        ? EXIT_INVALID_INPUT
        : EXIT_INTERNAL;
    } else {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      exitCode = EXIT_INTERNAL;
    }
  } finally {
    if (releaseLibraryLock) {
      try {
        await releaseLibraryLock();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        exitCode = EXIT_INTERNAL;
      }
    }
    if (releaseResearchLock) {
      try {
        await releaseResearchLock();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        exitCode = EXIT_INTERNAL;
      }
    }
    process.exitCode = exitCode;
  }
}

void main();
