import { join } from 'node:path';
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

export type CohortHistoryRunRequest = {
  outputRoot: string;
  enrichmentId: string;
  youngDomainMaxAgeDays?: number;
  recentWebPresenceMaxAgeDays?: number;
  repurposeGapMinDays?: number;
  logger?: (line: string) => void;
};

export type CohortHistoryRunResult = {
  enrichmentId: string;
  sourceRunId: string;
  changed: boolean;
  policy: CohortHistoryPolicy;
  finalistClusterCount: number;
  cohortDomainCount: number;
  checkedDomainCount: number;
  omittedDomainCount: number;
  unobservedDomainCount: number;
  registrationKnownDomainCount: number;
  youngDomainCount: number;
  firstSeenKnownDomainCount: number;
  recentWebPresenceCount: number;
  comparableHistoryDomainCount: number;
  possibleHistoryConflictCount: number;
  domainsPath: string;
  summaryPath: string;
  jsonPath: string;
};

export async function runCohortHistory(
  request: CohortHistoryRunRequest,
): Promise<CohortHistoryRunResult> {
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
        `Cohort history requires a completed enrichment; ${request.enrichmentId} is ${enrichment.state}.`,
      );
    }

    const entrant = loadEntrantCohortState(enrichmentStore, request.enrichmentId);
    if (!entrant) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${request.enrichmentId} has no persisted entrant-cohort snapshot. Run npm run entrant-cohort first.`,
      );
    }

    let policy: CohortHistoryPolicy;
    try {
      policy = resolveCohortHistoryPolicy({
        previous: loadCohortHistoryPolicy(enrichmentStore, request.enrichmentId),
        overrides: {
          ...(request.youngDomainMaxAgeDays !== undefined
            ? { youngDomainMaxAgeDays: request.youngDomainMaxAgeDays }
            : {}),
          ...(request.recentWebPresenceMaxAgeDays !== undefined
            ? { recentWebPresenceMaxAgeDays: request.recentWebPresenceMaxAgeDays }
            : {}),
          ...(request.repurposeGapMinDays !== undefined
            ? { repurposeGapMinDays: request.repurposeGapMinDays }
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

    const sourceLocation = await resolveRunLocation(request.outputRoot, entrant.sourceRunId);
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

    const historyRecords = loadPersistedCohortHistoryRecords(enrichmentStore, request.enrichmentId);
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
      enrichmentId: request.enrichmentId,
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
      enrichmentId: request.enrichmentId,
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

    logger(
      `Cohort history: ${totals.checkedDomainCount}/${totals.cohortDomainCount} cohort domain(s) checked, `
      + `${totals.omittedDomainCount} cap-omitted, ${totals.unobservedDomainCount} unobserved`
      + `${saveResult.changed ? ' (changed)' : ' (unchanged)'}.`,
    );
    logger(
      `Known registration: ${totals.registrationKnownDomainCount}; young: ${totals.youngDomainCount}. `
      + `Known first-seen: ${totals.firstSeenKnownDomainCount}; recent: ${totals.recentWebPresenceCount}. `
      + `Possible history conflicts: ${totals.possibleHistoryConflictCount}/${totals.comparableHistoryDomainCount}.`,
    );
    logger(`Policy: young<=${policy.youngDomainMaxAgeDays}d, recent<=${policy.recentWebPresenceMaxAgeDays}d, repurpose-gap>=${policy.repurposeGapMinDays}d.`);
    logger(`Artifacts: ${domainsPath}, ${summaryPath}, ${jsonPath}`);

    return {
      enrichmentId: request.enrichmentId,
      sourceRunId: entrant.sourceRunId,
      changed: saveResult.changed,
      policy,
      finalistClusterCount: projections.length,
      ...totals,
      domainsPath,
      summaryPath,
      jsonPath,
    };
  } finally {
    sourceStore?.close();
    enrichmentStore.close();
  }
}
