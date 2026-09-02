import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import { runFinalistEvidence } from '../finalization/finalistEvidenceRun.js';
import { withFinalizationOperatorExecutionLock } from '../finalization/operatorExecutionLock.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  enrichmentId: string;
  decisionsPath: string | null;
  outputRoot: string | null;
};

function nextOptionValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let help = false;
  let enrichmentId = '';
  let decisionsPath: string | null = null;
  let outputRoot: string | null = null;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--enrichment') {
      enrichmentId = nextOptionValue(args, '--enrichment');
    } else if (arg === '--decisions') {
      if (decisionsPath !== null) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--decisions may be supplied only once');
      }
      decisionsPath = nextOptionValue(args, '--decisions');
    } else if (arg === '--output-root') {
      outputRoot = nextOptionValue(args, '--output-root');
    } else if (arg?.startsWith('-')) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    } else if (arg) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
    }
  }

  if (!help && enrichmentId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--enrichment <id> is required');
  }
  return { help, enrichmentId, decisionsPath, outputRoot };
}

function printUsage(): void {
  console.log('Utility Research Finalist Evidence Matrix');
  console.log('');
  console.log('Usage:');
  console.log('  npm run finalist-evidence -- --enrichment <enrichment-id> [--decisions <decisions.json>]');
  console.log('');
  console.log('Options:');
  console.log('  --decisions <path>   Replace current human decisions from a strict JSON array.');
  console.log('                       Use [] to clear recorded current decisions.');
  console.log('  --output-root <path> Durable research output root.');
  console.log('  --help               Show this help.');
  console.log('');
  console.log('Common Crawl sampled historical presence is attached as a separate factual block; it is never treated as exact first-seen evidence or an automatic build decision.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const outputRoot = resolveOutputRoot(args.outputRoot);
  await withFinalizationOperatorExecutionLock(outputRoot, args.enrichmentId, () => runFinalistEvidence({
    outputRoot,
    enrichmentId: args.enrichmentId,
    decisionsPath: args.decisionsPath,
  }));
}

main()
  .then(() => {
    process.exitCode = EXIT_OK;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR'
      ? EXIT_INVALID_INPUT
      : EXIT_INTERNAL;
  });
