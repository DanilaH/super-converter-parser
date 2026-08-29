import process from 'node:process';
import { join } from 'node:path';
import { loadDotEnv } from '../config/env.js';
import { RunStore } from '../db/store.js';
import {
  entrantCohortFingerprint,
  loadCohortHistoryPolicy,
  saveCohortHistorySnapshot,
  type CohortHistorySnapshot,
} from '../db/cohortHistory.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
  resolveOutputRoot,
  resolveRunLocation,
} from '../outputs/researchLayout.js';
import {
  COHORT_HISTORY_PROJECTION_VERSION,
  projectCohortHistory,
  type CohortHistoryPolicy,
} from '../enrichment/cohortHistory.js';
import { resolveCohortHistoryPolicy } from '../enrichment/cohortHistoryConfig.js';
import { reconstructDomainAgeCapOmissions } from '../enrichment/cohortHistoryOmissions.js';
import {
  writeCohortHistoryDomainsCsv,
  writeCohortHistoryJson,
  writeCohortHistorySummaryCsv,
} from '../enrichment/cohortHistoryOutputs.js';
import { publishCohortHistoryMetadata } from '../enrichment/cohortHistoryPublication.js';
import { loadPersistedCohortHistoryRecords } from '../enrichment/cohortHistorySource.js';
import { assertCohortHistorySourceFreshness } from '../enrichment/cohortHistorySourceFreshness.js';
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
  const enrichmentLocation = await resolveEnrichmentLocation(outputRoot, args.enrichmentId);
  const enrichmentStore = RunStore.open(join(enrichmentLocation.enrichmentDirectory, 'enrichment.sqlite'));
  let sourceStore: RunStore | undefined;

  try {
    const enrichment = enrichmentStore.loadEnrichmentRun(args.enrichmentId);
    if (!enrichment) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${args.enrichmentId}`);
    }
    if (enrichment.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Cohort history requires a completed enrichment; ${args.enrichmentId} is ${enrichment.state}.`,
      );
    }

    const entrant = loadEntrantCohortState(enrichmentStore, args.enrichmentId);
    if (!entrant) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${args.enrichmentId} has no persisted entrant-cohort snapshot. Run npm run entrant-cohort first.`,
      );
    }

    let policy: CohortHistoryPolicy;
    try {
      policy = resolveCohortHistoryPolicy({
        previous: loadCohortHistoryPolicy(enrichmentStore, args.enrichmentId),
        overrides: {
          ...(args.youngDomainMaxAgeDays !== undefined
            ? { youngDomainMaxAgeDays: args.youngDomainMaxAgeDays }
            : {}),
          ...(args.recentWebPresenceMaxAgeDays !== undefined
            ? { recentWebPresenceMaxAgeDays: args.recentWebPresenceMaxAgeDays }
            : {}),
          ...(args.repurposeGapMinDays !== undefined
            ? { repurposeGapMinDays: args.repurposeGapMinDays }
            : {}),
        },
      });
    } catch (error) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    const sourceLocation = await resolveRunLocation(outputRoot, entrant.sourceRunId);
    sourceStore = RunStore.openReadOnly(join(sourceLocation.discoveryDirectory, 'run.sqlite'));
    const sourceRun = sourceStore.loadRun(entrant.sourceRunId);
    if (!sourceRun) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Source run not found: ${entrant.sourceRunId}`);
    }
    if (sourceRun.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Source run ${entrant.sourceRunId} is ${sourceRun.state}; cohort history requires its completed frozen generation.`,
      );
    }
    try {
      assertCohortHistorySourceFreshness({
        sourceRunId: entrant.sourceRunId,
        currentSourceUpdatedAt: sourceRun.updatedAt,
        entrantSourceUpdatedAt: entrant.sourceRunUpdatedAt,
      });
    } catch (error) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    const historyRecords = loadPersistedCohortHistoryRecords(enrichmentStore, args.enrichmentId);
    const omittedDomains = enrichment.modules.includes('domain_age')
      ? reconstructDomainAgeCapOmissions({
          sourceStore,
          sourceRunId: entrant.sourceRunId,
          shortlist: enrichment.shortlistKeywords,
        })
      : new Map<string, 'domain_cap'>();

    const projections = projectCohortHistory({
      cohorts: entrant.cohorts,
      historyRecords,
      omittedDomains,
      policy,
    });
    const snapshot: CohortHistorySnapshot = {
      enrichmentId: args.enrichmentId,
      sourceRunId: entrant.sourceRunId,
      entrantRepresentativeRevision: entrant.representativeRevision,
      entrantFingerprint: entrantCohortFingerprint(entrant),
      projectionVersion: COHORT_HISTORY_PROJECTION_VERSION,
      policy,
      projections,
    };
    const saveResult = saveCohortHistorySnapshot(enrichmentStore, snapshot);

    const domainsPath = join(enrichmentLocation.enrichmentDirectory, 'cohort-history.csv');
    const summaryPath = join(enrichmentLocation.enrichmentDirectory, 'cohort-history-summary.csv');
    const jsonPath = join(enrichmentLocation.enrichmentDirectory, 'cohort-history.json');
    await writeCohortHistoryDomainsCsv(domainsPath, projections);
    await writeCohortHistorySummaryCsv(summaryPath, projections);
    await writeCohortHistoryJson(jsonPath, snapshot);

    const totals = projections.reduce(
      (sum, projection) => ({
        cohortDomainCount: sum.cohortDomainCount + projection.summary.cohortDomainCount,
        checkedDomainCount: sum.checkedDomainCount + projection.summary.checkedDomainCount,
        omittedDomainCount: sum.omittedDomainCount + projection.summary.omittedDomainCount,
        unobservedDomainCount: sum.unobservedDomainCount + projection.summary.unobservedDomainCount,
        registrationKnownDomainCount: sum.registrationKnownDomainCount + projection.summary.registrationKnownDomainCount,
        youngDomainCount: sum.youngDomainCount + projection.summary.youngDomainCount,
        firstSeenKnownDomainCount: sum.firstSeenKnownDomainCount + projection.summary.firstSeenKnownDomainCount,
        recentWebPresenceCount: sum.recentWebPresenceCount + projection.summary.recentWebPresenceCount,
        comparableHistoryDomainCount: sum.comparableHistoryDomainCount + projection.summary.comparableHistoryDomainCount,
        possibleHistoryConflictCount: sum.possibleHistoryConflictCount + projection.summary.possibleHistoryConflictCount,
      }),
      {
        cohortDomainCount: 0,
        checkedDomainCount: 0,
        omittedDomainCount: 0,
        unobservedDomainCount: 0,
        registrationKnownDomainCount: 0,
        youngDomainCount: 0,
        firstSeenKnownDomainCount: 0,
        recentWebPresenceCount: 0,
        comparableHistoryDomainCount: 0,
        possibleHistoryConflictCount: 0,
      },
    );

    await publishCohortHistoryMetadata({
      enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
      enrichmentId: args.enrichmentId,
      sourceRunId: entrant.sourceRunId,
      summary: {
        changed: saveResult.changed,
        version: COHORT_HISTORY_PROJECTION_VERSION,
        entrantRepresentativeRevision: entrant.representativeRevision,
        entrantFingerprint: snapshot.entrantFingerprint,
        finalistClusterCount: projections.length,
        ...totals,
        policy,
      },
    });
    await archiveResearchDirectory(enrichmentLocation.researchDirectory);

    console.log(
      `Cohort history: ${totals.checkedDomainCount}/${totals.cohortDomainCount} cohort domain(s) checked, `
      + `${totals.omittedDomainCount} cap-omitted, ${totals.unobservedDomainCount} unobserved`
      + `${saveResult.changed ? ' (changed)' : ' (unchanged)'}.`,
    );
    console.log(
      `Known registration: ${totals.registrationKnownDomainCount}; young: ${totals.youngDomainCount}. `
      + `Known first-seen: ${totals.firstSeenKnownDomainCount}; recent: ${totals.recentWebPresenceCount}. `
      + `Possible history conflicts: ${totals.possibleHistoryConflictCount}/${totals.comparableHistoryDomainCount}.`,
    );
    console.log(`Policy: young<=${policy.youngDomainMaxAgeDays}d, recent<=${policy.recentWebPresenceMaxAgeDays}d, repurpose-gap>=${policy.repurposeGapMinDays}d.`);
    console.log(`Artifacts: ${domainsPath}, ${summaryPath}, ${jsonPath}`);
  } finally {
    sourceStore?.close();
    enrichmentStore.close();
  }
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
