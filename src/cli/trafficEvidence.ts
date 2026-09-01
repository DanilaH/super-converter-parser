import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import { runTrafficEvidence } from '../finalization/trafficEvidenceRun.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  enrichmentId: string;
  inputPath: string | null;
  outputRoot: string | null;
  lowBaseOrganicTrafficThreshold: number | undefined;
};

function nextOptionValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value`);
  }
  return value;
}

function parseNonNegativeNumber(raw: string, option: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `${option} must be a non-negative finite number, got ${raw}`,
    );
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let help = false;
  let enrichmentId = '';
  let inputPath: string | null = null;
  let outputRoot: string | null = null;
  let lowBaseOrganicTrafficThreshold: number | undefined;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--enrichment') {
      enrichmentId = nextOptionValue(args, '--enrichment');
    } else if (arg === '--input') {
      inputPath = nextOptionValue(args, '--input');
    } else if (arg === '--output-root') {
      outputRoot = nextOptionValue(args, '--output-root');
    } else if (arg === '--low-base-organic-traffic-threshold') {
      lowBaseOrganicTrafficThreshold = parseNonNegativeNumber(
        nextOptionValue(args, '--low-base-organic-traffic-threshold'),
        '--low-base-organic-traffic-threshold',
      );
    } else if (arg?.startsWith('-')) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    } else if (arg) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
    }
  }

  if (!help && enrichmentId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--enrichment <id> is required');
  }
  return {
    help,
    enrichmentId,
    inputPath,
    outputRoot,
    lowBaseOrganicTrafficThreshold,
  };
}

function printUsage(): void {
  console.log('Utility Research Competitor Traffic Evidence');
  console.log('');
  console.log('Usage:');
  console.log('  npm run traffic-evidence -- --enrichment <enrichment-id> [--input <traffic.csv>] \\');
  console.log('    [--low-base-organic-traffic-threshold <traffic>]');
  console.log('');
  console.log('Options:');
  console.log('  --input <path>                              Append canonical manual/imported traffic snapshots.');
  console.log('  --low-base-organic-traffic-threshold <n>    Explicit low-base warning threshold. Required on first run.');
  console.log('                                                Later reruns reuse the persisted value when omitted.');
  console.log('  --output-root <path>                         Durable research output root.');
  console.log('  --help                                       Show this help.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  await runTrafficEvidence({
    outputRoot: resolveOutputRoot(args.outputRoot),
    enrichmentId: args.enrichmentId,
    inputPath: args.inputPath,
    ...(args.lowBaseOrganicTrafficThreshold === undefined
      ? {}
      : { lowBaseOrganicTrafficThreshold: args.lowBaseOrganicTrafficThreshold }),
  });
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
