import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import {
  MAX_REPRESENTATIVE_QUERY_COUNT,
  MIN_REPRESENTATIVE_QUERY_COUNT,
} from '../enrichment/representativeQueries.js';
import { runFullFinalization } from '../finalization/fullFinalizationRun.js';
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
  clusters: string | null;
  allClusters: boolean;
  representativeCount: number | undefined;
  representativeOverrides: string | undefined;
  youngDomainMaxAgeDays: number | undefined;
  recentWebPresenceMaxAgeDays: number | undefined;
  repurposeGapMinDays: number | undefined;
  trafficInput: string | null;
  lowBaseOrganicTrafficThreshold: number | undefined;
  decisions: string | null;
  publishWithoutDecisions: boolean;
};

function nextValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  }
  return value;
}

function nonNegativeInteger(raw: string, option: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} must be a non-negative integer, got ${raw}`);
  }
  return value;
}

function nonNegativeNumber(raw: string, option: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} must be a non-negative finite number, got ${raw}`);
  }
  return value;
}

function representativeCount(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_REPRESENTATIVE_QUERY_COUNT || value > MAX_REPRESENTATIVE_QUERY_COUNT) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `--representative-count must be an integer in [${MIN_REPRESENTATIVE_QUERY_COUNT}, ${MAX_REPRESENTATIVE_QUERY_COUNT}], got ${raw}`,
    );
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = {
    help: false,
    enrichmentId: '',
    outputRoot: null,
    clusters: null,
    allClusters: false,
    representativeCount: undefined,
    representativeOverrides: undefined,
    youngDomainMaxAgeDays: undefined,
    recentWebPresenceMaxAgeDays: undefined,
    repurposeGapMinDays: undefined,
    trafficInput: null,
    lowBaseOrganicTrafficThreshold: undefined,
    decisions: null,
    publishWithoutDecisions: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--enrichment') parsed.enrichmentId = nextValue(args, '--enrichment');
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg === '--clusters') parsed.clusters = nextValue(args, '--clusters');
    else if (arg === '--all-clusters') parsed.allClusters = true;
    else if (arg === '--representative-count') parsed.representativeCount = representativeCount(nextValue(args, '--representative-count'));
    else if (arg === '--representative-overrides') parsed.representativeOverrides = nextValue(args, '--representative-overrides');
    else if (arg === '--young-domain-max-age-days') parsed.youngDomainMaxAgeDays = nonNegativeInteger(nextValue(args, '--young-domain-max-age-days'), '--young-domain-max-age-days');
    else if (arg === '--recent-web-presence-max-age-days') parsed.recentWebPresenceMaxAgeDays = nonNegativeInteger(nextValue(args, '--recent-web-presence-max-age-days'), '--recent-web-presence-max-age-days');
    else if (arg === '--repurpose-gap-min-days') parsed.repurposeGapMinDays = nonNegativeInteger(nextValue(args, '--repurpose-gap-min-days'), '--repurpose-gap-min-days');
    else if (arg === '--traffic') parsed.trafficInput = nextValue(args, '--traffic');
    else if (arg === '--low-base-organic-traffic-threshold') parsed.lowBaseOrganicTrafficThreshold = nonNegativeNumber(nextValue(args, '--low-base-organic-traffic-threshold'), '--low-base-organic-traffic-threshold');
    else if (arg === '--decisions') parsed.decisions = nextValue(args, '--decisions');
    else if (arg === '--publish-without-decisions') parsed.publishWithoutDecisions = true;
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }

  if (!parsed.help && parsed.enrichmentId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--enrichment <id> is required.');
  }
  if (parsed.clusters !== null && parsed.allClusters) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Use either --clusters or --all-clusters, not both.');
  }
  if (parsed.trafficInput === null && parsed.lowBaseOrganicTrafficThreshold !== undefined) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      '--low-base-organic-traffic-threshold is only meaningful with --traffic on this orchestration run.',
    );
  }
  return parsed;
}

function parseClusterIds(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--clusters requires at least one cluster id');
  }
  return values;
}

function printUsage(): void {
  console.log('Utility Research Full Finalization');
  console.log('');
  console.log('Usage:');
  console.log('  npm run finalize:full -- --enrichment <id> --clusters cluster-1,cluster-2 \\');
  console.log('    --young-domain-max-age-days 730 \\');
  console.log('    --recent-web-presence-max-age-days 730 \\');
  console.log('    --repurpose-gap-min-days 365 \\');
  console.log('    [--traffic traffic.csv --low-base-organic-traffic-threshold 1000] \\');
  console.log('    --decisions decisions.json');
  console.log('');
  console.log('Pipeline:');
  console.log('  representatives -> entrant cohort -> sampled historical presence -> cohort history -> optional/reused traffic -> finalist evidence -> library publish');
  console.log('');
  console.log('Notes:');
  console.log('  - First representative run still needs --clusters or --all-clusters; reruns may reuse persisted scope.');
  console.log('  - Common Crawl sampled history uses bounded safe defaults and an isolated cache; its timestamp is not an exact first-seen date.');
  console.log('  - First cohort-history run still needs all three explicit policy thresholds; reruns may reuse them.');
  console.log('  - Traffic is optional. Existing persisted traffic is automatically re-projected; otherwise missing traffic stays missing.');
  console.log('  - Library publication happens when every current finalist has a current human decision.');
  console.log('    --publish-without-decisions is an explicit escape hatch for deliberate incomplete publication.');
  console.log('');
  console.log('Options:');
  console.log('  --enrichment <id>                         Completed enrichment id.');
  console.log('  --clusters <ids>                          Explicit comma-separated finalist clusters.');
  console.log('  --all-clusters                            Explicitly treat all clusters as finalists.');
  console.log('  --representative-count <n>                Forwarded to representatives.');
  console.log('  --representative-overrides <path>         Forwarded to representatives.');
  console.log('  --young-domain-max-age-days <days>        Cohort-history policy.');
  console.log('  --recent-web-presence-max-age-days <days> Cohort-history policy.');
  console.log('  --repurpose-gap-min-days <days>            Cohort-history policy.');
  console.log('  --traffic <path>                          Optional canonical traffic CSV import.');
  console.log('  --low-base-organic-traffic-threshold <n>  Traffic warning policy; required by traffic CLI on first import.');
  console.log('  --decisions <path>                        Human finalist decisions JSON.');
  console.log('  --publish-without-decisions               Deliberately allow incomplete publication.');
  console.log('  --output-root <path>                      Durable output root.');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return;
  }
  const selectedClusterIds = parseClusterIds(parsed.clusters);
  const outputRoot = resolveOutputRoot(parsed.outputRoot, process.env);

  await withFinalizationOperatorExecutionLock(outputRoot, parsed.enrichmentId, () => runFullFinalization({
    outputRoot,
    enrichmentId: parsed.enrichmentId,
    ...(selectedClusterIds === undefined ? {} : { selectedClusterIds }),
    allClusters: parsed.allClusters,
    ...(parsed.representativeCount === undefined ? {} : { representativeCount: parsed.representativeCount }),
    ...(parsed.representativeOverrides === undefined ? {} : { representativeOverridesPath: parsed.representativeOverrides }),
    ...(parsed.youngDomainMaxAgeDays === undefined ? {} : { youngDomainMaxAgeDays: parsed.youngDomainMaxAgeDays }),
    ...(parsed.recentWebPresenceMaxAgeDays === undefined ? {} : { recentWebPresenceMaxAgeDays: parsed.recentWebPresenceMaxAgeDays }),
    ...(parsed.repurposeGapMinDays === undefined ? {} : { repurposeGapMinDays: parsed.repurposeGapMinDays }),
    trafficInputPath: parsed.trafficInput,
    ...(parsed.lowBaseOrganicTrafficThreshold === undefined
      ? {}
      : { lowBaseOrganicTrafficThreshold: parsed.lowBaseOrganicTrafficThreshold }),
    decisionsPath: parsed.decisions,
    publishWithoutDecisions: parsed.publishWithoutDecisions,
    env: process.env,
  }));
}

main()
  .then(() => {
    process.exitCode = EXIT_OK;
  })
  .catch((error) => {
    if (error instanceof ResearchError) {
      console.error(`${error.code}: ${error.message}`);
      process.exitCode = error.code === 'INPUT_SCHEMA_ERROR' ? EXIT_INVALID_INPUT : EXIT_INTERNAL;
      return;
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = EXIT_INTERNAL;
  });
