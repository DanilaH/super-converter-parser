import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { loadRepresentativeQueryState } from '../db/representativeSets.js';
import { saveEntrantCohortSnapshot } from '../db/entrantCohorts.js';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
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

export type EntrantCohortRunRequest = {
  outputRoot: string;
  enrichmentId: string;
  logger?: (line: string) => void;
};

export type EntrantCohortRunResult = {
  enrichmentId: string;
  sourceRunId: string;
  representativeRevision: number;
  changed: boolean;
  finalistClusterCount: number;
  uniqueDomainCount: number;
  observedOccurrenceCount: number;
  excludedOccurrenceCount: number;
  weakDomainCount: number;
  knownDrDomainCount: number;
  repeatedDomainCount: number;
  domainsPath: string;
  occurrencesPath: string;
  jsonPath: string;
};

export async function runEntrantCohort(
  request: EntrantCohortRunRequest,
): Promise<EntrantCohortRunResult> {
  const logger = request.logger ?? ((line: string) => console.log(line));
  const enrichmentLocation = await resolveEnrichmentLocation(request.outputRoot, request.enrichmentId);
  const enrichmentStore = RunStore.open(join(enrichmentLocation.enrichmentDirectory, 'enrichment.sqlite'));
  let sourceStore: RunStore | undefined;

  try {
    const enrichment = enrichmentStore.loadEnrichmentRun(request.enrichmentId);
    if (!enrichment) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${request.enrichmentId}`);
    }
    if (enrichment.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Entrant cohort requires a completed enrichment; ${request.enrichmentId} is ${enrichment.state}.`,
      );
    }

    const representativeState = loadRepresentativeQueryState(enrichmentStore, request.enrichmentId);
    if (!representativeState) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${request.enrichmentId} has no persisted representative-query snapshot. Run npm run representatives first.`,
      );
    }

    const clusteringItem = enrichmentStore.loadEnrichmentItems(request.enrichmentId).find(
      (item) => item.itemId === 'clusters' && item.module === 'clusters',
    );
    if (!clusteringItem || clusteringItem.status !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${request.enrichmentId} has no completed clusters checkpoint.`,
      );
    }

    const sourceLocation = await resolveRunLocation(request.outputRoot, enrichment.sourceRunId);
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
      enrichmentId: request.enrichmentId,
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
      enrichmentId: request.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      representativeRevision: representativeState.revision,
      sourceRunUpdatedAt: sourceRun.updatedAt,
      clusteringUpdatedAt: clusteringItem.updatedAt,
      drThresholds,
      cohorts,
    });

    const uniqueDomainCount = cohorts.reduce((sum, cohort) => sum + cohort.summary.uniqueDomainCount, 0);
    const observedOccurrenceCount = cohorts.reduce((sum, cohort) => sum + cohort.summary.observedOccurrenceCount, 0);
    const excludedOccurrenceCount = cohorts.reduce((sum, cohort) => sum + cohort.summary.excludedOccurrenceCount, 0);
    const weakDomainCount = cohorts.reduce((sum, cohort) => sum + cohort.summary.weakDomainCount, 0);
    const knownDrDomainCount = cohorts.reduce((sum, cohort) => sum + cohort.summary.knownDrDomainCount, 0);
    const repeatedDomainCount = cohorts.reduce((sum, cohort) => sum + cohort.summary.repeatedDomainCount, 0);

    await publishEntrantCohortMetadata({
      enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
      enrichmentId: request.enrichmentId,
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

    logger(
      `Entrant cohort: ${cohorts.length} finalist cluster(s), ${uniqueDomainCount} domain cohort row(s), `
      + `${observedOccurrenceCount} ranking occurrence(s), representative revision ${representativeState.revision}`
      + `${saveResult.changed ? ' (changed)' : ' (unchanged)'}.`,
    );
    logger(`Weak domains: ${weakDomainCount}/${knownDrDomainCount} domains with known DR; repeated across representative queries: ${repeatedDomainCount}.`);
    logger(`Warning: ${ENTRANT_SURVIVORSHIP_WARNING}`);
    logger(`Artifacts: ${domainsPath}, ${occurrencesPath}, ${jsonPath}`);

    return {
      enrichmentId: request.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      representativeRevision: representativeState.revision,
      changed: saveResult.changed,
      finalistClusterCount: cohorts.length,
      uniqueDomainCount,
      observedOccurrenceCount,
      excludedOccurrenceCount,
      weakDomainCount,
      knownDrDomainCount,
      repeatedDomainCount,
      domainsPath,
      occurrencesPath,
      jsonPath,
    };
  } finally {
    sourceStore?.close();
    enrichmentStore.close();
  }
}
