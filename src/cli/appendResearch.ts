import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import { loadSeedRows } from '../input/seeds/load.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { resolveOutputRoot, archiveResearchDirectory } from '../outputs/researchLayout.js';
import { DEFAULT_CLI_DEPS, runCli } from './research.js';
import {
  acquireResearchBatchLock,
  prepareResearchAppend,
} from '../research/batches.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  targetRunId: string;
  seedsPath: string;
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
  let targetRunId = '';
  let seedsPath = '';
  let outputRoot: string | null = null;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--to' || arg === '--append-to') targetRunId = nextValue(args, arg);
    else if (arg === '--seeds') seedsPath = nextValue(args, '--seeds');
    else if (arg === '--output-root') outputRoot = nextValue(args, '--output-root');
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }
  if (!help && targetRunId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--to <research-id-or-run-id> is required.');
  }
  if (!help && seedsPath === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--seeds <path> is required.');
  }
  return { help, targetRunId, seedsPath, outputRoot };
}

function printUsage(): void {
  console.log('Utility Research Batch Append');
  console.log('');
  console.log('Usage:');
  console.log('  npm run research:append -- --to <research-id-or-run-id> --seeds <path>');
  console.log('');
  console.log('Behavior:');
  console.log('  - preserves the existing completed discovery run unchanged;');
  console.log('  - stores the input batch under the same research directory;');
  console.log('  - de-duplicates by normalized keyword;');
  console.log('  - forks a new combined discovery run only when new keywords exist;');
  console.log('  - carries old checkpoints/evidence forward and collects only new pending keywords.');
  console.log('');
  console.log('Options:');
  console.log('  --to, --append-to <id>  Stable research id (initial run id) or any run id in the research.');
  console.log('  --seeds <path>           CSV with required keyword column.');
  console.log('  --output-root <path>     Durable research output root.');
  console.log('  --help, -h               Show this help.');
}

async function refreshArchiveBestEffort(researchDirectory: string): Promise<void> {
  try {
    await archiveResearchDirectory(researchDirectory);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Archive warning: ${message}`);
  }
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

    const rows = await loadSeedRows(args.seedsPath);
    const seeds = buildSeedKeywords(rows);
    if (seeds.length === 0) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', 'Input contains no research keywords.');
    }

    const outputRoot = resolveOutputRoot(args.outputRoot, process.env);
    const lock = await acquireResearchBatchLock(outputRoot, args.targetRunId);
    releaseLock = lock.release;

    const prepared = await prepareResearchAppend({
      outputRoot,
      targetRunId: args.targetRunId,
      seedsPath: args.seedsPath,
      seeds,
    });

    console.log('Research batch');
    console.log(`  Research ID: ${prepared.researchId}`);
    console.log(`  Batch: ${prepared.batchId}`);
    console.log(`  Input unique: ${prepared.inputUniqueKeywordCount}`);
    console.log(`  New: ${prepared.addedKeywordCount}`);
    console.log(`  Already known: ${prepared.duplicateKeywordCount}`);

    if (!prepared.changed) {
      // Batch metadata is already durable. ZIP is a derived convenience surface,
      // so a packaging failure must not turn this committed append into a retry
      // that would record the same batch again.
      await refreshArchiveBestEffort(prepared.researchDirectory);
      console.log(`  Current run unchanged: ${prepared.currentRunId}`);
      console.log(`  Research directory: ${prepared.researchDirectory}`);
      return;
    }

    console.log(`  Previous run: ${prepared.previousRunId}`);
    console.log(`  New combined run: ${prepared.currentRunId}`);
    console.log('');
    console.log('Collecting only the new pending keyword checkpoints...');
    console.log('');

    exitCode = await runCli(
      ['--resume', prepared.currentRunId, '--output-root', outputRoot],
      DEFAULT_CLI_DEPS,
      process.env,
    );
    // A successful runCli invocation already rebuilt results.zip. On pause/error
    // it intentionally does not, so refresh the portable research snapshot here.
    // This remains best-effort because run.sqlite/research.json are durable truth.
    if (exitCode !== EXIT_OK) {
      await refreshArchiveBestEffort(prepared.researchDirectory);
    }

    if (exitCode === EXIT_OK) {
      console.log('');
      console.log(`Research current run: ${prepared.currentRunId}`);
      console.log('Previous enrichment directories remain immutable historical snapshots.');
      console.log(`Run new enrichment against: npm run enrich -- --run ${prepared.currentRunId} ...`);
    }
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`${error.code}: ${error.message}`);
      exitCode = error.code === 'INPUT_SCHEMA_ERROR'
        || error.code === 'RESUME_NOT_FOUND'
        || error.code === 'RESUME_PARSER_MISMATCH'
        || error.code === 'RESUME_CONFIG_MISMATCH'
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
