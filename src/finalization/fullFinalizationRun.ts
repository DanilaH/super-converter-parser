import { join } from 'node:path';
import { loadFinalistDecisions } from '../db/finalistDecisions.js';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { loadRepresentativeQueryState } from '../db/representativeSets.js';
import { loadTrafficEvidencePolicy, loadTrafficImportRecords } from '../db/trafficEvidence.js';
import { RunStore } from '../db/store.js';
import { DEFAULT_HISTORICAL_PRESENCE_CONFIG, type HistoricalPresenceCollectionMode } from '../historicalPresence/types.js';
import { resolveEnrichmentLocation } from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';
import { runRepresentativeQueries, type RepresentativeRunResult } from './representativeRun.js';
import { runEntrantCohort, type EntrantCohortRunResult } from './entrantCohortRun.js';
import { runCohortHistoricalPresence, type HistoricalPresenceRunResult } from './historicalPresenceRun.js';
import { runCohortHistory, type CohortHistoryRunResult } from './cohortHistoryRun.js';
import { runTrafficEvidence, type TrafficEvidenceRunResult } from './trafficEvidenceRun.js';
import { runFinalistEvidence, type FinalistEvidenceRunResult } from './finalistEvidenceRun.js';
import { runLibraryPublication, type LibraryPublicationRunResult } from './libraryPublicationRun.js';

export type FullFinalizationRunRequest = {
  outputRoot: string;
  enrichmentId: string;
  selectedClusterIds?: string[];
  allClusters?: boolean;
  representativeCount?: number;
  representativeOverridesPath?: string;
  youngDomainMaxAgeDays?: number;
  recentWebPresenceMaxAgeDays?: number;
  repurposeGapMinDays?: number;
  historicalPresence?: {
    collectionMode: HistoricalPresenceCollectionMode;
    recentMonths: number;
    maxCollections: number;
    domainCap: number;
  };
  trafficInputPath?: string | null;
  lowBaseOrganicTrafficThreshold?: number;
  decisionsPath?: string | null;
  publishWithoutDecisions?: boolean;
  env?: NodeJS.ProcessEnv;
  logger?: (line: string) => void;
};

export type FullFinalizationRunResult = {
  state: 'awaiting_decisions' | 'published';
  representative: RepresentativeRunResult;
  entrant: EntrantCohortRunResult;
  historicalPresence: HistoricalPresenceRunResult;
  cohortHistory: CohortHistoryRunResult;
  traffic: TrafficEvidenceRunResult | null;
  finalistEvidence: FinalistEvidenceRunResult;
  publication: LibraryPublicationRunResult | null;
};

export async function runFullFinalization(
  request: FullFinalizationRunRequest,
): Promise<FullFinalizationRunResult> {
  const logger = request.logger ?? ((line: string) => console.log(line));
  const trafficInputPath = request.trafficInputPath ?? null;
  const decisionsPath = request.decisionsPath ?? null;
  if (trafficInputPath === null && request.lowBaseOrganicTrafficThreshold !== undefined) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'lowBaseOrganicTrafficThreshold is only meaningful with a traffic input on this orchestration run.',
    );
  }

  logger('');
  logger('=== Representative queries ===');
  const representative = await runRepresentativeQueries({
    outputRoot: request.outputRoot,
    enrichmentId: request.enrichmentId,
    targetCount: request.representativeCount,
    overridesPath: request.representativeOverridesPath,
    selectedClusterIds: request.selectedClusterIds,
    allClusters: request.allClusters ?? false,
    logger,
  });

  logger('');
  logger('=== Entrant cohort ===');
  const entrant = await runEntrantCohort({
    outputRoot: request.outputRoot,
    enrichmentId: request.enrichmentId,
    logger,
  });

  const historicalConfig = request.historicalPresence ?? {
    collectionMode: DEFAULT_HISTORICAL_PRESENCE_CONFIG.collectionMode,
    recentMonths: DEFAULT_HISTORICAL_PRESENCE_CONFIG.recentMonths,
    maxCollections: DEFAULT_HISTORICAL_PRESENCE_CONFIG.maxCollections,
    domainCap: 30,
  };
  logger('');
  logger('=== Sampled historical presence ===');
  const historicalPresence = await runCohortHistoricalPresence({
    outputRoot: request.outputRoot,
    enrichmentId: request.enrichmentId,
    collectionMode: historicalConfig.collectionMode,
    recentMonths: historicalConfig.recentMonths,
    maxCollections: historicalConfig.maxCollections,
    domainCap: historicalConfig.domainCap,
    env: request.env,
    logger,
  });

  logger('');
  logger('=== Cohort history ===');
  const cohortHistory = await runCohortHistory({
    outputRoot: request.outputRoot,
    enrichmentId: request.enrichmentId,
    youngDomainMaxAgeDays: request.youngDomainMaxAgeDays,
    recentWebPresenceMaxAgeDays: request.recentWebPresenceMaxAgeDays,
    repurposeGapMinDays: request.repurposeGapMinDays,
    logger,
  });

  const beforeTraffic = await inspectPersistedFinalizationState(request.outputRoot, request.enrichmentId);
  let traffic: TrafficEvidenceRunResult | null = null;
  if (trafficInputPath !== null || beforeTraffic.hasReusableTraffic) {
    logger('');
    logger('=== Traffic evidence ===');
    traffic = await runTrafficEvidence({
      outputRoot: request.outputRoot,
      enrichmentId: request.enrichmentId,
      inputPath: trafficInputPath,
      lowBaseOrganicTrafficThreshold: request.lowBaseOrganicTrafficThreshold,
      logger,
    });
  } else {
    logger('');
    logger('=== Traffic evidence ===');
    logger('No imported traffic exists and no traffic file was supplied; traffic evidence remains missing by design.');
  }

  logger('');
  logger('=== Finalist evidence ===');
  const finalistEvidence = await runFinalistEvidence({
    outputRoot: request.outputRoot,
    enrichmentId: request.enrichmentId,
    decisionsPath,
    logger,
  });

  if (
    finalistEvidence.currentHumanDecisionCount !== finalistEvidence.finalistCount
    && !(request.publishWithoutDecisions ?? false)
  ) {
    logger('');
    logger(
      `Finalist matrix is current, but library publication was skipped: `
      + `${finalistEvidence.currentHumanDecisionCount}/${finalistEvidence.finalistCount} finalist(s) have current human decisions.`,
    );
    logger('Supply a decisions continuation, or use an explicit publication override deliberately.');
    return {
      state: 'awaiting_decisions',
      representative,
      entrant,
      historicalPresence,
      cohortHistory,
      traffic,
      finalistEvidence,
      publication: null,
    };
  }

  logger('');
  logger('=== Research library publication ===');
  const publication = await runLibraryPublication({
    outputRoot: request.outputRoot,
    enrichmentId: request.enrichmentId,
    logger,
  });
  logger('');
  logger('Full finalization completed.');
  return {
    state: 'published',
    representative,
    entrant,
    historicalPresence,
    cohortHistory,
    traffic,
    finalistEvidence,
    publication,
  };
}

async function inspectPersistedFinalizationState(
  outputRoot: string,
  enrichmentId: string,
): Promise<{ hasReusableTraffic: boolean; finalistCount: number; currentDecisionCount: number }> {
  const location = await resolveEnrichmentLocation(outputRoot, enrichmentId);
  const store = RunStore.openReadOnly(join(location.enrichmentDirectory, 'enrichment.sqlite'));
  try {
    const trafficPolicy = loadTrafficEvidencePolicy(store, enrichmentId);
    const trafficImports = loadTrafficImportRecords(store, enrichmentId);
    const representatives = loadRepresentativeQueryState(store, enrichmentId);
    const entrant = loadEntrantCohortState(store, enrichmentId);
    const decisions = loadFinalistDecisions(store, enrichmentId);

    const finalistIds = representatives?.sets.map((set) => set.clusterId) ?? [];
    let currentDecisionCount = 0;
    if (representatives && entrant) {
      const fingerprint = entrantCohortFingerprint(entrant);
      const currentDecisionIds = new Set(
        decisions
          .filter(
            (decision) => decision.representativeRevision === representatives.revision
              && decision.entrantFingerprint === fingerprint,
          )
          .map((decision) => decision.clusterId),
      );
      currentDecisionCount = finalistIds.filter((clusterId) => currentDecisionIds.has(clusterId)).length;
    }

    return {
      hasReusableTraffic: trafficPolicy !== null && trafficImports.length > 0,
      finalistCount: finalistIds.length,
      currentDecisionCount,
    };
  } finally {
    store.close();
  }
}
