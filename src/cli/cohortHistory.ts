import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import { runCohortHistory } from '../finalization/cohortHistoryRun.js';
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
  outputRoot: string | null;
  youngDomainMaxAgeDays: number | undefined;
  recentWebPresenceMaxAgeDays: number | undefined;
  repurposeGapMinDays: number | undefined;
};

function nextOptionValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value`);
  }
  return value;
}

function parseNonNegativeInteger(raw: string, option: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `${option} must be a non-negative integer, got ${raw}`,
    );
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let help = false;
  let enrichmentId = '';
  let outputRoot: string | null = null;
  let youngDomainMaxAgeDays: number | undefined;
  let recentWebPresenceMaxAgeDays: number | undefined;
  let repurposeGapMinDays: number | undefined;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--enrichment') {
      enrichmentId = nextOptionValue(args, '--enrichment');
    } else if (arg === '--output-root') {
      outputRoot = nextOptionValue(args, '--output-root');
    } else if (arg === '--young-domain-max-age-days') {
      youngDomainMaxAgeDays = parseNonNegativeInteger(
        nextOptionValue(args, '--young-domain-max-age-days'),
        '--young-domain-max-age-days',
      );
    } else if (arg === '--recent-web-presence-max-age-days') {
      recentWebPresenceMaxAgeDays = parseNonNegativeInteger(
        nextOptionValue(args, '--recent-web-presence-max-age-days'),
        '--recent-web-presence-max-age-days',
      );
    } else if (arg === '--repurpose-gap-min-days') {
      repurposeGapMinDays = parseNonNegativeInteger(
        nextOptionValue(args, '--repurpose-gap-min-days'),
        '--repurpose-gap-min-days',
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
    outputRoot,
    youngDomainMaxAgeDays,
    recentWebPresenceMaxAgeDays,
    repurposeGapMinDays,
  };
}

function printUsage(): void {
  console.log('Utility Research Cohort History');
  console.log('');
  console.log('Usage:');
  console.log('  npm run cohort-history -- --enrichment <enrichment-id> \\');
  console.log('    --young-domain-max-age-days <days> \\');
  console.log('    --recent-web-presence-max-age-days <days> \\');
  console.log('    --repurpose-gap-min-days <days>');
  console.log('');
  console.log('Options:');
  console.log('  --young-domain-max-age-days <days>        Explicit registration-age threshold for young observations.');
  console.log('  --recent-web-presence-max-age-days <days> Explicit first-seen age threshold for recent web presence.');
  console.log('  --repurpose-gap-min-days <days>           Explicit registration-to-first-seen gap threshold for possible history conflict.');
  console.log('                                             First run requires all three; reruns reuse persisted values for omitted flags.');
  console.log('  --output-root <path>                       Durable research output root.');
  console.log('  --help                                     Show this help.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const outputRoot = resolveOutputRoot(args.outputRoot);
  await withFinalizationOperatorExecutionLock(outputRoot, args.enrichmentId, () => runCohortHistory({
    outputRoot,
    enrichmentId: args.enrichmentId,
    ...(args.youngDomainMaxAgeDays === undefined ? {} : { youngDomainMaxAgeDays: args.youngDomainMaxAgeDays }),
    ...(args.recentWebPresenceMaxAgeDays === undefined ? {} : { recentWebPresenceMaxAgeDays: args.recentWebPresenceMaxAgeDays }),
    ...(args.repurposeGapMinDays === undefined ? {} : { repurposeGapMinDays: args.repurposeGapMinDays }),
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
