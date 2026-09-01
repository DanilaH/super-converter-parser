import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import {
  MAX_REPRESENTATIVE_QUERY_COUNT,
  MIN_REPRESENTATIVE_QUERY_COUNT,
} from '../enrichment/representativeQueries.js';
import { runRepresentativeQueries } from '../finalization/representativeRun.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

interface ParsedArgs {
  help: boolean;
  enrichmentId: string;
  targetCount: number | undefined;
  overridesPath: string | undefined;
  selectedClusterIds: string[] | undefined;
  allClusters: boolean;
  outputRoot: string | null;
}

function nextOptionValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value`);
  }
  return value;
}

function parseClusterIds(raw: string): string[] {
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--clusters requires at least one cluster id');
  }
  return values;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let help = false;
  let enrichmentId = '';
  let targetCount: number | undefined;
  let overridesPath: string | undefined;
  let selectedClusterIds: string[] | undefined;
  let allClusters = false;
  let outputRoot: string | null = null;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--enrichment') {
      enrichmentId = nextOptionValue(args, '--enrichment');
    } else if (arg === '--clusters') {
      if (selectedClusterIds !== undefined) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--clusters may be supplied only once');
      }
      selectedClusterIds = parseClusterIds(nextOptionValue(args, '--clusters'));
    } else if (arg === '--all-clusters') {
      allClusters = true;
    } else if (arg === '--representative-count') {
      const raw = nextOptionValue(args, '--representative-count');
      const parsed = Number(raw);
      if (
        !Number.isInteger(parsed)
        || parsed < MIN_REPRESENTATIVE_QUERY_COUNT
        || parsed > MAX_REPRESENTATIVE_QUERY_COUNT
      ) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `--representative-count must be an integer in [${MIN_REPRESENTATIVE_QUERY_COUNT}, ${MAX_REPRESENTATIVE_QUERY_COUNT}], got ${raw}`,
        );
      }
      targetCount = parsed;
    } else if (arg === '--representative-overrides') {
      overridesPath = nextOptionValue(args, '--representative-overrides');
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
  if (selectedClusterIds !== undefined && allClusters) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Use either --clusters or --all-clusters, not both');
  }

  return {
    help,
    enrichmentId,
    targetCount,
    overridesPath,
    selectedClusterIds,
    allClusters,
    outputRoot,
  };
}

function printUsage(): void {
  console.log('Utility Research Representative Queries');
  console.log('');
  console.log('Usage:');
  console.log('  npm run representatives -- --enrichment <enrichment-id> --clusters cluster-1,cluster-4');
  console.log('  npm run representatives -- --enrichment <enrichment-id> --all-clusters');
  console.log('');
  console.log('Options:');
  console.log('  --clusters <ids>                  Explicit comma-separated finalist cluster ids.');
  console.log('  --all-clusters                    Explicitly treat every current cluster as a finalist.');
  console.log('                                   A rerun may omit both flags to reuse persisted scope.');
  console.log(`  --representative-count <${MIN_REPRESENTATIVE_QUERY_COUNT}-${MAX_REPRESENTATIVE_QUERY_COUNT}>  Target representatives per cluster (default 5; small clusters keep all members).`);
  console.log('  --representative-overrides <path>  JSON array of { clusterId, keywordIds, reason }.');
  console.log('                                   An explicit [] clears persisted overrides.');
  console.log('  --output-root <path>              Durable research output root.');
  console.log('  --help                            Show this help.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  await runRepresentativeQueries({
    outputRoot: resolveOutputRoot(args.outputRoot),
    enrichmentId: args.enrichmentId,
    ...(args.targetCount === undefined ? {} : { targetCount: args.targetCount }),
    ...(args.overridesPath === undefined ? {} : { overridesPath: args.overridesPath }),
    ...(args.selectedClusterIds === undefined ? {} : { selectedClusterIds: args.selectedClusterIds }),
    allClusters: args.allClusters,
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
