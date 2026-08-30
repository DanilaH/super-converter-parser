import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

const CLI_DIR = dirname(fileURLToPath(import.meta.url));

type ParsedArgs = {
  help: boolean;
  enrichmentId: string;
  outputRoot: string | null;
  clusters: string | null;
  allClusters: boolean;
  representativeCount: string | null;
  representativeOverrides: string | null;
  youngDomainMaxAgeDays: string | null;
  recentWebPresenceMaxAgeDays: string | null;
  repurposeGapMinDays: string | null;
  trafficInput: string | null;
  lowBaseOrganicTrafficThreshold: string | null;
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

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = {
    help: false,
    enrichmentId: '',
    outputRoot: null,
    clusters: null,
    allClusters: false,
    representativeCount: null,
    representativeOverrides: null,
    youngDomainMaxAgeDays: null,
    recentWebPresenceMaxAgeDays: null,
    repurposeGapMinDays: null,
    trafficInput: null,
    lowBaseOrganicTrafficThreshold: null,
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
    else if (arg === '--representative-count') parsed.representativeCount = nextValue(args, '--representative-count');
    else if (arg === '--representative-overrides') parsed.representativeOverrides = nextValue(args, '--representative-overrides');
    else if (arg === '--young-domain-max-age-days') parsed.youngDomainMaxAgeDays = nextValue(args, '--young-domain-max-age-days');
    else if (arg === '--recent-web-presence-max-age-days') parsed.recentWebPresenceMaxAgeDays = nextValue(args, '--recent-web-presence-max-age-days');
    else if (arg === '--repurpose-gap-min-days') parsed.repurposeGapMinDays = nextValue(args, '--repurpose-gap-min-days');
    else if (arg === '--traffic') parsed.trafficInput = nextValue(args, '--traffic');
    else if (arg === '--low-base-organic-traffic-threshold') parsed.lowBaseOrganicTrafficThreshold = nextValue(args, '--low-base-organic-traffic-threshold');
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
  if (parsed.trafficInput === null && parsed.lowBaseOrganicTrafficThreshold !== null) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      '--low-base-organic-traffic-threshold is only meaningful with --traffic on this orchestration run.',
    );
  }
  return parsed;
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
  console.log('  representatives -> entrant cohort -> cohort history -> optional traffic -> finalist evidence -> library publish');
  console.log('');
  console.log('Notes:');
  console.log('  - First representative run still needs --clusters or --all-clusters; reruns may reuse persisted scope.');
  console.log('  - First cohort-history run still needs all three explicit policy thresholds; reruns may reuse them.');
  console.log('  - Traffic is optional. Without --traffic, persisted traffic is reused if available; otherwise traffic remains missing.');
  console.log('  - Library publication requires --decisions by default. Use --publish-without-decisions only deliberately.');
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
  console.log('  --publish-without-decisions               Allow explicit publication with no decisions file.');
  console.log('  --output-root <path>                      Durable output root.');
}

function commonArgs(parsed: ParsedArgs): string[] {
  return [
    '--enrichment',
    parsed.enrichmentId,
    ...(parsed.outputRoot ? ['--output-root', resolve(parsed.outputRoot)] : []),
  ];
}

async function runCliFile(label: string, filename: string, args: string[]): Promise<void> {
  console.log('');
  console.log(`=== ${label} ===`);
  const path = join(CLI_DIR, filename);
  const code = await new Promise<number>((resolveCode, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path, ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (signal) {
        reject(new Error(`${label} terminated by signal ${signal}.`));
        return;
      }
      resolveCode(exitCode ?? EXIT_INTERNAL);
    });
  });
  if (code !== EXIT_OK) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${label} failed with exit code ${code}.`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return;
  }

  const common = commonArgs(parsed);
  const representativeArgs = [
    ...common,
    ...(parsed.clusters ? ['--clusters', parsed.clusters] : []),
    ...(parsed.allClusters ? ['--all-clusters'] : []),
    ...(parsed.representativeCount ? ['--representative-count', parsed.representativeCount] : []),
    ...(parsed.representativeOverrides ? ['--representative-overrides', parsed.representativeOverrides] : []),
  ];
  await runCliFile('Representative queries', 'representatives.ts', representativeArgs);
  await runCliFile('Entrant cohort', 'entrantCohort.ts', common);

  const historyArgs = [
    ...common,
    ...(parsed.youngDomainMaxAgeDays ? ['--young-domain-max-age-days', parsed.youngDomainMaxAgeDays] : []),
    ...(parsed.recentWebPresenceMaxAgeDays ? ['--recent-web-presence-max-age-days', parsed.recentWebPresenceMaxAgeDays] : []),
    ...(parsed.repurposeGapMinDays ? ['--repurpose-gap-min-days', parsed.repurposeGapMinDays] : []),
  ];
  await runCliFile('Cohort history', 'cohortHistory.ts', historyArgs);

  if (parsed.trafficInput !== null) {
    const trafficArgs = [
      ...common,
      '--input',
      parsed.trafficInput,
      ...(parsed.lowBaseOrganicTrafficThreshold
        ? ['--low-base-organic-traffic-threshold', parsed.lowBaseOrganicTrafficThreshold]
        : []),
    ];
    await runCliFile('Traffic evidence', 'trafficEvidence.ts', trafficArgs);
  } else {
    console.log('');
    console.log('=== Traffic evidence ===');
    console.log('No --traffic file supplied; skipping import. Finalist evidence will reuse persisted traffic when available, otherwise keep traffic missing.');
  }

  const finalistArgs = [
    ...common,
    ...(parsed.decisions ? ['--decisions', parsed.decisions] : []),
  ];
  await runCliFile('Finalist evidence', 'finalistEvidence.ts', finalistArgs);

  if (parsed.decisions === null && !parsed.publishWithoutDecisions) {
    console.log('');
    console.log('Finalist matrix is current, but library publication was intentionally skipped because no --decisions file was supplied.');
    console.log('Re-run this same command with --decisions <path>, or pass --publish-without-decisions deliberately.');
    return;
  }

  await runCliFile('Research library publication', 'publishLibrary.ts', common);
  console.log('');
  console.log('Full finalization completed.');
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
