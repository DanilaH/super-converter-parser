import process from 'node:process';
import { join } from 'node:path';
import { loadDotEnv } from '../config/env.js';
import { RunStore } from '../db/store.js';
import { loadRepresentativeQueryState } from '../db/representativeSets.js';
import { saveEntrantCohortSnapshot } from '../db/entrantCohorts.js';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
  resolveOutputRoot,
  resolveRunLocation,
} from '../outputs/researchLayout.js';
import {
  ENTRANT_COHORT_SERP_TOP_N,
  ENTRANT_COHORT_VERSION,
  ENTRANT_SURVIVORSHIP_WARNING,
  buildEntrantCohorts,
} from '../enrichment/entrantCohort.js';
import {
  writeEntrantCohortDomainsCsv,
  writeEntrantCohortJson,
  writeEntrantCohortOccurrencesCsv,
} from '../enrichment/entrantCohortOutputs.js';
import { publishEntrantCohortMetadata } from '../enrichment/entrantCohortPublication.js';
import { assertRepresentativeSourceFreshness } from '../enrichment/representativeSourceFreshness.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

interface ParsedArgs {
  help: boolean;
  enrichmentId: string;
  outputRoot: string | null;
}

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
  let outputRoot: string | null = null;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--enrichment') {
      enrichmentId = nextOptionValue(args, '--enrichment');
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
  return { help, enrichmentId, outputRoot };
}

function printUsage(): void {
  console.log('Utility Research Entrant Cohort');
  console.log('');
  console.log('Usage:');
  console.log('  npm run entrant-cohort -- --enrichment <enrichment-id>');
  console.log('');
  console.log('Options:');
  console.log('  --output-root <path>  Durable research output root.');
  console.log('  --help                Show this help.');
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
        `Entrant cohort requires a completed enrichment; ${args.enrichmentId} is ${enrichment.state}.`,
      );
    }

    const representativeState = loadRepresentativeQueryState(enrichmentStore, args.enrichmentId);
    if (!representativeState) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${args.enrichmentId} has no persisted representative-query snapshot. Run npm run representatives first.`,
      );
    }

    const clusteringItem = enrichmentStore.loadEnrichmentItems(args.enrichmentId).find(
      (item) => item.itemId === 'clusters' && item.module === 'clusters',
    );
    if (!clusteringItem || clusteringItem.status !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${args.enrichmentId} has no completed clusters checkpoint.`,
      );
    }

    const sourceLocation = await resolveRunLocation(outputRoot, enrichment.sourceRunId);
    sourceStore = RunStore.openReadOnly(join(sourceLocation.discoveryDirectory, 'run.sqlite'));
    const sourceRun = sourceStore.loadRun(enrichment.sourceRunId);
    if (!sourceRun) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Source run not found: ${enrichment.sourceRunId}`);
    }
    if (sourceRun.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Source run ${enrichment.sourceRunId} is ${sourceRun.state}; entrant cohort requires the completed source snapshot used by clustering.`,
      );
    }
    try {
      assertRepresentativeSourceFreshness({
        sourceRunId: enrichment.sourceRunId,
        sourceUpdatedAt: sourceRun.updatedAt,
        clusteringUpdatedAt: clusteringItem.updatedAt,
      });
    } catch (error) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    const drThresholds = sourceRun.configSnapshot.scoring.drThresholds;
    const cohorts = buildEntrantCohorts({
      representativeSets: representativeState.sets,
      serpRows: sourceStore.loadSerpRows(enrichment.sourceRunId),
      drThresholds,
    });

    const snapshot = {
      enrichmentId: args.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      representativeRevision: representativeState.revision,
      cohortVersion: ENTRANT_COHORT_VERSION,
      serpTopN: ENTRANT_COHORT_SERP_TOP_N,
      drThresholds,
      sourceRunUpdatedAt: sourceRun.updatedAt,
      clusteringUpdatedAt: clusteringItem.updatedAt,
      cohorts,
    };
    const saveResult = saveEntrantCohortSnapshot(enrichmentStore, snapshot);

    const domainsPath = join(enrichmentLocation.enrichmentDirectory, 'entrant-cohort.csv');
    const occurrencesPath = join(enrichmentLocation.enrichmentDirectory, 'entrant-cohort-occurrences.csv');
    const jsonPath = join(enrichmentLocation.enrichmentDirectory, 'entrant-cohort.json');
    await writeEntrantCohortDomainsCsv(domainsPath, cohorts);
    await writeEntrantCohortOccurrencesCsv(occurrencesPath, cohorts);
    await writeEntrantCohortJson(jsonPath, {
      enrichmentId: args.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      representativeRevision: representativeState.revision,
      sourceRunUpdatedAt: sourceRun.updatedAt,
      clusteringUpdatedAt: clusteringItem.updatedAt,
      drThresholds,
      cohorts,
    });

    const uniqueDomainCount = cohorts.reduce((sum, cohort) => sum + cohort.summary.uniqueDomainCount, 0);
    const observedOccurrenceCount = cohorts.reduce(
      (sum, cohort) => sum + cohort.summary.observedOccurrenceCount,
      0,
    );
    const excludedOccurrenceCount = cohorts.reduce(
      (sum, cohort) => sum + cohort.summary.excludedOccurrenceCount,
      0,
    );
    const weakDomainCount = cohorts.reduce((sum, cohort) => sum + cohort.summary.weakDomainCount, 0);
    const knownDrDomainCount = cohorts.reduce((sum, cohort) => sum + cohort.summary.knownDrDomainCount, 0);
    const repeatedDomainCount = cohorts.reduce((sum, cohort) => sum + cohort.summary.repeatedDomainCount, 0);

    await publishEntrantCohortMetadata({
      enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
      enrichmentId: args.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      summary: {
        changed: saveResult.changed,
        version: ENTRANT_COHORT_VERSION,
        representativeRevision: representativeState.revision,
        serpTopN: ENTRANT_COHORT_SERP_TOP_N,
        finalistClusterCount: cohorts.length,
        uniqueDomainCount,
        observedOccurrenceCount,
        excludedOccurrenceCount,
        weakDomainCount,
        knownDrDomainCount,
        repeatedDomainCount,
        survivorshipWarning: ENTRANT_SURVIVORSHIP_WARNING,
        drThresholds,
      },
    });
    await archiveResearchDirectory(enrichmentLocation.researchDirectory);

    console.log(
      `Entrant cohort: ${cohorts.length} finalist cluster(s), ${uniqueDomainCount} domain cohort row(s), `
      + `${observedOccurrenceCount} ranking occurrence(s), representative revision ${representativeState.revision}`
      + `${saveResult.changed ? ' (changed)' : ' (unchanged)'}.`,
    );
    console.log(
      `Weak domains: ${weakDomainCount}/${knownDrDomainCount} domains with known DR; repeated across representative queries: ${repeatedDomainCount}.`,
    );
    console.log(`Warning: ${ENTRANT_SURVIVORSHIP_WARNING}`);
    console.log(`Artifacts: ${domainsPath}, ${occurrencesPath}, ${jsonPath}`);
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
