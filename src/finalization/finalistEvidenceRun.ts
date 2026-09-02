import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  loadFinalistDecisions,
  replaceFinalistDecisions,
  type FinalistDecisionInput,
  type FinalistDecisionRecord,
} from '../db/finalistDecisions.js';
import { entrantCohortFingerprint, loadCohortHistoryState } from '../db/cohortHistory.js';
import { loadCohortHistoricalPresenceState } from '../db/cohortHistoricalPresence.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { loadRepresentativeQueryState } from '../db/representativeSets.js';
import {
  loadTrafficEvidencePolicy,
  loadTrafficImportRecords,
} from '../db/trafficEvidence.js';
import { RunStore } from '../db/store.js';
import { parseFinalistDecisionsJson } from '../enrichment/finalistDecisionConfig.js';
import { buildFinalistEvidenceMatrix } from '../enrichment/finalistEvidence.js';
import {
  writeFinalistEvidenceCsv,
  writeFinalistEvidenceJson,
  type FinalistEvidenceArtifact,
} from '../enrichment/finalistEvidenceOutputs.js';
import {
  assertFinalistEvidencePublicationParent,
  invalidateFinalistEvidencePublication,
  publishFinalistEvidenceMetadata,
} from '../enrichment/finalistEvidencePublication.js';
import { evidenceSnapshotFingerprint } from '../enrichment/evidenceSnapshotFingerprint.js';
import type { SiteStructureRecord } from '../enrichment/site_structure/types.js';
import { projectCurrentTrafficEvidence } from '../enrichment/trafficEvidenceCurrent.js';
import {
  attachSampledHistoricalPresenceToFinalistMatrix,
  type FinalistEvidenceMatrixWithSampledHistory,
} from '../historicalPresence/evidenceProjection.js';
import { buildRunQuality } from '../runs/runQuality.js';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
  resolveRunLocation,
} from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';

export const FINALIST_EVIDENCE_WITH_SAMPLED_HISTORY_VERSION = '1.1.0';

export type FinalistEvidenceRunRequest = {
  outputRoot: string;
  enrichmentId: string;
  decisionsPath?: string | null;
  logger?: (line: string) => void;
};

export type FinalistEvidenceRunResult = {
  enrichmentId: string;
  sourceRunId: string;
  representativeRevision: number;
  entrantFingerprint: string;
  finalistCount: number;
  cohortHistoryAvailableCount: number;
  sampledHistoryCollectedCount: number;
  importedTrafficSnapshotCount: number;
  currentHumanDecisionCount: number;
  staleHumanDecisionCount: number;
  unrecordedHumanDecisionCount: number;
  auditFlagCount: number;
  csvPath: string;
  jsonPath: string;
};

export async function runFinalistEvidence(
  request: FinalistEvidenceRunRequest,
): Promise<FinalistEvidenceRunResult> {
  const logger = request.logger ?? ((line: string) => console.log(line));
  const decisionsPath = request.decisionsPath ?? null;
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
        `Finalist evidence requires a completed enrichment; ${request.enrichmentId} is ${enrichment.state}.`,
      );
    }

    const representatives = loadRepresentativeQueryState(enrichmentStore, request.enrichmentId);
    if (!representatives) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${request.enrichmentId} has no representative-query state. Run npm run representatives first.`,
      );
    }
    const entrant = loadEntrantCohortState(enrichmentStore, request.enrichmentId);
    if (!entrant) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${request.enrichmentId} has no entrant-cohort state. Run npm run entrant-cohort first.`,
      );
    }
    if (entrant.representativeRevision !== representatives.revision) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Finalist parent mismatch: representative revision ${representatives.revision} != entrant revision ${entrant.representativeRevision}.`,
      );
    }
    const entrantFingerprint = entrantCohortFingerprint(entrant);

    const sourceLocation = await resolveRunLocation(request.outputRoot, entrant.sourceRunId);
    sourceStore = RunStore.openReadOnly(join(sourceLocation.discoveryDirectory, 'run.sqlite'));
    const sourceRun = sourceStore.loadRun(entrant.sourceRunId);
    if (!sourceRun) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Source run not found: ${entrant.sourceRunId}`);
    }
    if (sourceRun.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Source run ${entrant.sourceRunId} is ${sourceRun.state}; finalist evidence requires its completed frozen generation.`,
      );
    }
    if (sourceRun.updatedAt !== entrant.sourceRunUpdatedAt) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Source run ${entrant.sourceRunId} changed after the entrant-cohort snapshot `
        + `(${entrant.sourceRunUpdatedAt} -> ${sourceRun.updatedAt}). Rebuild upstream finalist evidence first.`,
      );
    }

    const sourceKeywords = sourceStore.loadKeywords(entrant.sourceRunId);
    const sourceRunQuality = buildRunQuality({
      run: sourceRun,
      state: sourceRun.state,
      keywords: sourceKeywords,
      serpRows: sourceStore.loadSerpRows(entrant.sourceRunId),
      relatedKeywords: sourceStore.loadRelatedKeywords(entrant.sourceRunId),
      domains: sourceStore.loadDomains(entrant.sourceRunId),
    });
    const finalistIds = new Set(representatives.sets.map((set) => set.clusterId));
    const clusters = enrichmentStore
      .loadKeywordClusters(request.enrichmentId)
      .filter((cluster) => finalistIds.has(cluster.clusterId));
    const historyState = loadCohortHistoryState(enrichmentStore, request.enrichmentId);
    const history = historyState?.projections ?? null;
    const sampledHistoricalPresence = loadCohortHistoricalPresenceState(enrichmentStore, request.enrichmentId);
    const cohortHistoryFingerprint = historyState === null ? null : evidenceSnapshotFingerprint(historyState);
    const historicalPresenceFingerprint = sampledHistoricalPresence === null
      ? null
      : evidenceSnapshotFingerprint(sampledHistoricalPresence);

    const trafficImports = loadTrafficImportRecords(enrichmentStore, request.enrichmentId);
    const trafficPolicy = loadTrafficEvidencePolicy(enrichmentStore, request.enrichmentId);
    const trafficCurrent = trafficPolicy === null
      ? null
      : projectCurrentTrafficEvidence({
          importedSnapshots: trafficImports.map((record) => record.snapshot),
          cohorts: entrant.cohorts,
          policy: trafficPolicy,
        });

    const siteStructure = {
      moduleIncluded: enrichment.modules.includes('site_structure'),
      records: enrichment.modules.includes('site_structure')
        ? mapSiteStructureRecords(enrichmentStore.loadEnrichmentSiteStructure(request.enrichmentId))
        : [],
    };

    const parsedDecisions = decisionsPath === null
      ? null
      : await loadDecisionInputs(decisionsPath);
    let decisions = loadFinalistDecisions(enrichmentStore, request.enrichmentId);

    const commonInput = {
      clusters,
      representativeSets: representatives.sets,
      sourceKeywords,
      cohorts: entrant.cohorts,
      history,
      traffic: {
        importedSnapshots: trafficImports.map((record) => record.snapshot),
        policyAvailable: trafficPolicy !== null,
        current: trafficCurrent,
      },
      siteStructure,
      sourceRunQuality,
      currentRepresentativeRevision: representatives.revision,
      currentEntrantFingerprint: entrantFingerprint,
    };

    if (parsedDecisions !== null) {
      assertDecisionScope(parsedDecisions, finalistIds);
      const staged = stageDecisions(
        parsedDecisions,
        representatives.revision,
        entrantFingerprint,
      );
      try {
        const stagedMatrix = buildFinalistEvidenceMatrix({ ...commonInput, decisions: staged });
        attachSampledHistoricalPresenceToFinalistMatrix({
          matrix: stagedMatrix,
          cohorts: entrant.cohorts,
          state: sampledHistoricalPresence,
        });
        await assertFinalistEvidencePublicationParent({
          enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
          enrichmentId: request.enrichmentId,
          sourceRunId: enrichment.sourceRunId,
          representativeRevision: representatives.revision,
          entrantFingerprint,
          cohortHistoryFingerprint,
          historicalPresenceFingerprint,
        });
      } catch (error) {
        throw inputError(error);
      }

      await invalidateFinalistEvidencePublication({
        enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
        enrichmentId: request.enrichmentId,
        sourceRunId: enrichment.sourceRunId,
      });
      decisions = replaceFinalistDecisions(enrichmentStore, request.enrichmentId, parsedDecisions);
    }

    let matrix: FinalistEvidenceMatrixWithSampledHistory;
    try {
      matrix = attachSampledHistoricalPresenceToFinalistMatrix({
        matrix: buildFinalistEvidenceMatrix({ ...commonInput, decisions }),
        cohorts: entrant.cohorts,
        state: sampledHistoricalPresence,
      });
      await assertFinalistEvidencePublicationParent({
        enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
        enrichmentId: request.enrichmentId,
        sourceRunId: enrichment.sourceRunId,
        representativeRevision: representatives.revision,
        entrantFingerprint,
        cohortHistoryFingerprint,
        historicalPresenceFingerprint,
      });
    } catch (error) {
      throw inputError(error);
    }

    const artifact: FinalistEvidenceArtifact = {
      version: FINALIST_EVIDENCE_WITH_SAMPLED_HISTORY_VERSION,
      enrichmentId: request.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      representativeRevision: representatives.revision,
      entrantFingerprint,
      matrix,
    };
    const csvPath = join(enrichmentLocation.enrichmentDirectory, 'finalist-evidence-matrix.csv');
    const jsonPath = join(enrichmentLocation.enrichmentDirectory, 'finalist-evidence-matrix.json');
    await writeFinalistEvidenceCsv(csvPath, matrix);
    await writeFinalistEvidenceJson(jsonPath, artifact);

    const currentHumanDecisionCount = matrix.finalists.filter(
      (finalist) => finalist.humanDecision.evidenceCurrent === true,
    ).length;
    const unrecordedHumanDecisionCount = matrix.finalists.filter(
      (finalist) => finalist.auditFlags.includes('HUMAN_DECISION_UNRECORDED'),
    ).length;
    const cohortHistoryAvailableCount = matrix.finalists.filter(
      (finalist) => finalist.evidence.entrantRepeatability.history !== null,
    ).length;
    const sampledHistoryCollectedCount = matrix.finalists.filter(
      (finalist) => finalist.evidence.sampledHistoricalPresence.collected,
    ).length;
    const auditFlagCount = matrix.finalists.reduce(
      (sum, finalist) => sum + finalist.auditFlags.length,
      0,
    );

    await publishFinalistEvidenceMetadata({
      enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
      enrichmentId: request.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      summary: {
        version: FINALIST_EVIDENCE_WITH_SAMPLED_HISTORY_VERSION,
        representativeRevision: representatives.revision,
        entrantFingerprint,
        cohortHistoryFingerprint,
        historicalPresenceFingerprint,
        finalistCount: matrix.finalistCount,
        cohortHistoryAvailableCount,
        importedTrafficSnapshotCount: trafficImports.length,
        matchedTrafficSnapshotCount: trafficCurrent?.projection.matchedSnapshotCount ?? null,
        mismatchedTrafficSnapshotCount: trafficCurrent?.projection.mismatchedSnapshotCount ?? null,
        staleTrafficTargetCount: matrix.staleTrafficTargetCount,
        currentHumanDecisionCount,
        staleHumanDecisionCount: matrix.staleHumanDecisionCount,
        unrecordedHumanDecisionCount,
        auditFlagCount,
      },
    });
    await archiveResearchDirectory(enrichmentLocation.researchDirectory);

    logger(
      `Finalist evidence: ${matrix.finalistCount} finalist(s); `
      + `${cohortHistoryAvailableCount} with cohort-history projection; `
      + `${sampledHistoryCollectedCount} with sampled historical-presence projection; `
      + `${trafficImports.length} imported traffic snapshot(s).`,
    );
    logger(
      `Human decisions: ${currentHumanDecisionCount} current, `
      + `${matrix.staleHumanDecisionCount} stale/retired, ${unrecordedHumanDecisionCount} unrecorded.`,
    );
    logger(`Audit flags: ${auditFlagCount}.`);
    logger(`Artifacts: ${csvPath}, ${jsonPath}`);

    return {
      enrichmentId: request.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      representativeRevision: representatives.revision,
      entrantFingerprint,
      finalistCount: matrix.finalistCount,
      cohortHistoryAvailableCount,
      sampledHistoryCollectedCount,
      importedTrafficSnapshotCount: trafficImports.length,
      currentHumanDecisionCount,
      staleHumanDecisionCount: matrix.staleHumanDecisionCount,
      unrecordedHumanDecisionCount,
      auditFlagCount,
      csvPath,
      jsonPath,
    };
  } finally {
    sourceStore?.close();
    enrichmentStore.close();
  }
}

async function loadDecisionInputs(path: string): Promise<FinalistDecisionInput[]> {
  const absolute = resolve(path);
  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Cannot read finalist decisions file "${path}".`,
      { cause: error },
    );
  }
  try {
    return parseFinalistDecisionsJson(content, `Finalist decisions file "${path}"`);
  } catch (error) {
    throw inputError(error);
  }
}

function assertDecisionScope(
  decisions: FinalistDecisionInput[],
  currentFinalistIds: ReadonlySet<string>,
): void {
  const unknown = decisions
    .map((decision) => decision.clusterId)
    .filter((clusterId) => !currentFinalistIds.has(clusterId));
  if (unknown.length > 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Finalist decisions reference unknown current finalist(s): ${unknown.join(', ')}.`,
    );
  }
}

function stageDecisions(
  decisions: FinalistDecisionInput[],
  representativeRevision: number,
  entrantFingerprint: string,
): FinalistDecisionRecord[] {
  const updatedAt = new Date().toISOString();
  return decisions
    .filter((decision) => decision.buildDecision !== null || decision.seoProductRole !== null)
    .map((decision) => ({
      ...decision,
      representativeRevision,
      entrantFingerprint,
      updatedAt,
    }));
}

function mapSiteStructureRecords(
  rows: ReturnType<RunStore['loadEnrichmentSiteStructure']>,
): SiteStructureRecord[] {
  return rows.map((row) => ({
    domain: row.domain,
    homepageStatus: readHomepageStatus(row.homepageStatus, row.domain),
    homepageHttpStatus: row.homepageHttpStatus,
    robotsStatus: readRobotsStatus(row.robotsStatus, row.domain),
    robotsHttpStatus: row.robotsHttpStatus,
    robotsUrl: row.robotsUrl,
    sitemapUrlsFromRobots: [...row.sitemapUrlsFromRobots],
    sitemapFallbackUrl: row.sitemapFallbackUrl,
    sitemapType: readSitemapType(row.sitemapType, row.domain),
    declaredSitemapCount: row.declaredSitemapCount,
    discoveredUrlCount: row.discoveredUrlCount,
    sampledUrls: [...row.sampledUrls],
    sampledUtilityUrls: [...row.sampledUtilityUrls],
    errors: row.errors.map((error) => ({ ...error })),
    fetchedAt: row.fetchedAt,
    cacheStatus: readCacheStatus(row.cacheStatus, row.domain),
    sourceKeywords: [...row.sourceKeywords],
    sourceBestPosition: row.sourceBestPosition,
  }));
}

function readHomepageStatus(value: string, domain: string): SiteStructureRecord['homepageStatus'] {
  if (value === 'ok' || value === 'error' || value === 'timeout' || value === 'skipped') return value;
  throw new ResearchError('DB_ERROR', `Invalid site-structure homepage status ${value} for ${domain}.`);
}

function readRobotsStatus(value: string, domain: string): SiteStructureRecord['robotsStatus'] {
  if (value === 'ok' || value === 'not_found' || value === 'error' || value === 'timeout') return value;
  throw new ResearchError('DB_ERROR', `Invalid site-structure robots status ${value} for ${domain}.`);
}

function readSitemapType(value: string, domain: string): SiteStructureRecord['sitemapType'] {
  if (value === 'index' || value === 'urlset' || value === 'unknown' || value === 'none') return value;
  throw new ResearchError('DB_ERROR', `Invalid site-structure sitemap type ${value} for ${domain}.`);
}

function readCacheStatus(value: string, domain: string): SiteStructureRecord['cacheStatus'] {
  if (value === 'hit' || value === 'miss' || value === 'expired' || value === 'refreshed' || value === 'none') return value;
  throw new ResearchError('DB_ERROR', `Invalid site-structure cache status ${value} for ${domain}.`);
}

function inputError(error: unknown): ResearchError {
  return new ResearchError(
    'INPUT_SCHEMA_ERROR',
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}
