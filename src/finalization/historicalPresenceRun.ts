import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import {
  loadCohortHistoricalPresenceState,
  saveCohortHistoricalPresenceSnapshot,
} from '../db/cohortHistoricalPresence.js';
import { evidenceSnapshotFingerprint } from '../enrichment/evidenceSnapshotFingerprint.js';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
} from '../outputs/researchLayout.js';
import { HistoricalPresenceCache, defaultHistoricalPresenceCachePath } from '../historicalPresence/cache.js';
import {
  COHORT_HISTORICAL_PRESENCE_LEGACY_SELECTION_POLICY,
  COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1,
  collectCohortHistoricalPresence,
} from '../historicalPresence/cohortCollector.js';
import { createCommonCrawlHistoricalPresenceClient } from '../historicalPresence/commonCrawl.js';
import {
  writeCohortHistoricalPresenceCsv,
  writeCohortHistoricalPresenceJson,
} from '../historicalPresence/cohortOutputs.js';
import { publishCohortHistoricalPresenceMetadata } from '../historicalPresence/cohortPublication.js';
import {
  DEFAULT_HISTORICAL_PRESENCE_CONFIG,
  type HistoricalPresenceCollectionMode,
} from '../historicalPresence/types.js';
import { ResearchError } from '../shared/errors.js';

export type HistoricalPresenceRunRequest = {
  outputRoot: string;
  enrichmentId: string;
  collectionMode: HistoricalPresenceCollectionMode;
  recentMonths: number;
  maxCollections: number;
  domainCap: number;
  env?: NodeJS.ProcessEnv;
  logger?: (line: string) => void;
};

export type HistoricalPresenceRunResult = {
  enrichmentId: string;
  sourceRunId: string;
  changed: boolean;
  checkedDomainCount: number;
  uniqueDomainCount: number;
  omittedDomainCount: number;
  knownPresenceDomainCount: number;
  notFoundDomainCount: number;
  unavailableDomainCount: number;
  errorDomainCount: number;
  completeSelectedHistoryDomainCount: number;
  cacheHitCount: number;
  networkRequestCount: number;
  csvPath: string;
  jsonPath: string;
};

export async function runCohortHistoricalPresence(
  request: HistoricalPresenceRunRequest,
): Promise<HistoricalPresenceRunResult> {
  const logger = request.logger ?? ((line: string) => console.log(line));
  const location = await resolveEnrichmentLocation(request.outputRoot, request.enrichmentId);
  const store = RunStore.open(join(location.enrichmentDirectory, 'enrichment.sqlite'));
  const appConfig = loadConfig(request.env ?? process.env);
  const cachePath = defaultHistoricalPresenceCachePath(appConfig.cache.path);
  const cache = HistoricalPresenceCache.open(cachePath);

  try {
    const enrichment = store.loadEnrichmentRun(request.enrichmentId);
    if (!enrichment) throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${request.enrichmentId}`);
    if (enrichment.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Sampled historical presence requires a completed enrichment; ${request.enrichmentId} is ${enrichment.state}.`,
      );
    }
    const entrant = loadEntrantCohortState(store, request.enrichmentId);
    if (!entrant) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${request.enrichmentId} has no persisted entrant cohort. Run npm run entrant-cohort first.`,
      );
    }

    const config = {
      ...DEFAULT_HISTORICAL_PRESENCE_CONFIG,
      collectionMode: request.collectionMode,
      recentMonths: request.recentMonths,
      maxCollections: request.maxCollections,
    };
    const existingSnapshot = loadCohortHistoricalPresenceState(store, request.enrichmentId);
    const selectionPolicyVersion = existingSnapshot && existingSnapshot.collection.selectionPolicyVersion === undefined
      ? COHORT_HISTORICAL_PRESENCE_LEGACY_SELECTION_POLICY
      : COHORT_HISTORICAL_PRESENCE_SELECTION_POLICY_V1;
    const client = createCommonCrawlHistoricalPresenceClient(config);
    const collection = await collectCohortHistoricalPresence({
      cohorts: entrant.cohorts,
      client,
      cache,
      domainCap: request.domainCap,
      selectionPolicyVersion,
    });
    const snapshot = {
      enrichmentId: request.enrichmentId,
      sourceRunId: entrant.sourceRunId,
      entrantRepresentativeRevision: entrant.representativeRevision,
      entrantFingerprint: entrantCohortFingerprint(entrant),
      collectionVersion: collection.version,
      config: { ...config, domainCap: request.domainCap },
      collection,
    };
    const saved = saveCohortHistoricalPresenceSnapshot(store, snapshot);
    const persistedSnapshot = loadCohortHistoricalPresenceState(store, request.enrichmentId);
    if (!persistedSnapshot) {
      throw new ResearchError('DB_ERROR', `Sampled historical-presence snapshot disappeared after save for ${request.enrichmentId}.`);
    }
    const snapshotFingerprint = evidenceSnapshotFingerprint(persistedSnapshot);

    const csvPath = join(location.enrichmentDirectory, 'cohort-historical-presence.csv');
    const jsonPath = join(location.enrichmentDirectory, 'cohort-historical-presence.json');
    await writeCohortHistoricalPresenceCsv(csvPath, snapshot);
    await writeCohortHistoricalPresenceJson(jsonPath, snapshot);
    await publishCohortHistoricalPresenceMetadata({
      enrichmentDirectory: location.enrichmentDirectory,
      snapshot,
      snapshotFingerprint,
      changed: saved.changed,
    });
    await archiveResearchDirectory(location.researchDirectory);

    const summary = collection.summary;
    logger(
      `Sampled historical presence: ${summary.checkedDomainCount}/${summary.uniqueDomainCount} entrant domain(s) checked, `
      + `${summary.omittedDomainCount} cap-omitted.`,
    );
    logger(
      `Observed=${summary.knownPresenceDomainCount}, not_found=${summary.notFoundDomainCount}, `
      + `unavailable=${summary.unavailableDomainCount}, error=${summary.errorDomainCount}.`,
    );
    logger(
      `Complete selected-history observations=${summary.completeSelectedHistoryDomainCount}/${summary.knownPresenceDomainCount}; `
      + `cache hits=${summary.cacheHitCount}; domain lookup requests=${summary.networkRequestCount}.`,
    );
    logger(`Selection policy: ${selectionPolicyVersion}.`);
    logger('Semantics: earliestSampledCaptureAt is bounded sampled Common Crawl evidence, not exact first-seen.');
    logger(`Artifacts: ${csvPath}, ${jsonPath}`);

    return {
      enrichmentId: request.enrichmentId,
      sourceRunId: entrant.sourceRunId,
      changed: saved.changed,
      checkedDomainCount: summary.checkedDomainCount,
      uniqueDomainCount: summary.uniqueDomainCount,
      omittedDomainCount: summary.omittedDomainCount,
      knownPresenceDomainCount: summary.knownPresenceDomainCount,
      notFoundDomainCount: summary.notFoundDomainCount,
      unavailableDomainCount: summary.unavailableDomainCount,
      errorDomainCount: summary.errorDomainCount,
      completeSelectedHistoryDomainCount: summary.completeSelectedHistoryDomainCount,
      cacheHitCount: summary.cacheHitCount,
      networkRequestCount: summary.networkRequestCount,
      csvPath,
      jsonPath,
    };
  } finally {
    cache.close();
    store.close();
  }
}
