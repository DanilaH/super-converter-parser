import process from 'node:process';
import { join } from 'node:path';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import {
  publishResearchToLibrary,
  RESEARCH_LIBRARY_DIRECTORY,
} from '../library/researchLibrary.js';
import { acquirePublishLock } from '../library/publishLock.js';
import { ResearchError } from '../shared/errors.js';

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  enrichmentId: string;
  outputRoot: string | null;
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

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }

    const outputRoot = resolveOutputRoot(args.outputRoot, process.env);
    releaseLock = await acquirePublishLock(join(outputRoot, RESEARCH_LIBRARY_DIRECTORY));
    const result = await publishResearchToLibrary({
      outputRoot,
      enrichmentId: args.enrichmentId,
    });

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
    if (releaseLock) {
      try {
        await releaseLock();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        exitCode = EXIT_INTERNAL;
      }
    }
    process.exitCode = exitCode;
  }
}

void main();
