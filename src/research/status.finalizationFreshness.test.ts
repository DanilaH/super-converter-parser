import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import {
  entrantHistoricalPresenceFingerprint,
  loadCohortHistoricalPresenceState,
  saveCohortHistoricalPresenceSnapshot,
  type CohortHistoricalPresenceSnapshot,
} from '../db/cohortHistoricalPresence.js';
import { saveEntrantCohortSnapshot, type EntrantCohortSnapshot } from '../db/entrantCohorts.js';
import { saveRepresentativeQuerySnapshot } from '../db/representativeSets.js';
import { RunStore } from '../db/store.js';
import { evidenceSnapshotFingerprint } from '../enrichment/evidenceSnapshotFingerprint.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { DEFAULT_HISTORICAL_PRESENCE_CONFIG } from '../historicalPresence/types.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import {
  allocateEnrichmentDirectory,
  allocateResearchLocation,
  writeEnrichmentIndex,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { buildResearchStatus } from './status.js';

const CONFIG = loadConfig({});

async function createCompletedDiscovery(input: {
  outputRoot: string;
  researchDirectory: string;
  discoveryDirectory: string;
  runId: string;
}): Promise<void> {
  const keywords = buildSeedKeywords([{ keyword: 'speaker test', rowNumber: 1 }]);
  const store = RunStore.open(join(input.discoveryDirectory, 'run.sqlite'));
  store.createRun({
    runId: input.runId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
    input: { kind: 'seeds', path: 'fixture.csv' },
    keywords,
  });
  const keyword = store.loadKeywords(input.runId)[0]!;
  store.commitKeyword(input.runId, {
    ...keyword,
    status: 'completed',
    surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-09-02T10:00:00.000Z' },
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: 'https://google.com/search?q=speaker+test',
      detectedLocation: null,
      geoWarning: false,
      serpStatus: 'empty',
      serpError: null,
    },
    error: null,
    collectedAt: '2026-09-02T10:00:00.000Z',
  }, [], 'miss');
  store.setRunState(input.runId, 'completed', { updatedAt: '2026-09-02T10:01:00.000Z' });
  store.close();

  await writeRunIndex(input.outputRoot, {
    version: 1,
    runId: input.runId,
    researchDirectory: input.researchDirectory,
    discoveryDirectory: input.discoveryDirectory,
  });
  await writeFile(join(input.researchDirectory, 'research.json'), `${JSON.stringify({
    version: 1,
    researchId: input.runId,
    label: 'finalization freshness fixture',
    createdAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:01:00.000Z',
    currentRunId: input.runId,
    batches: [],
  }, null, 2)}\n`, 'utf8');
}

function saveFinalistParents(store: RunStore, enrichmentId: string, sourceRunId: string): EntrantCohortSnapshot {
  saveRepresentativeQuerySnapshot(store, enrichmentId, {
    targetCount: 3,
    overrides: [],
    setVersion: '1.0.0',
    selectedClusterIds: ['cluster-1'],
  }, [{
    clusterId: 'cluster-1',
    setVersion: '1.0.0',
    representativeKeywordIds: [17],
    representatives: [{
      keywordIdx: 17,
      keyword: 'speaker test',
      normalizedKeyword: 'speaker test',
      volume: 100,
      selectionReason: 'medoid',
      coverageGain: 1,
    }],
    targetCount: 1,
    clusterUrlCount: 1,
    coveredUrlCount: 1,
    manualOverride: false,
    manualOverrideReason: null,
  }]);

  const occurrence = {
    keywordIdx: 17,
    position: 1,
    rankingUrl: 'https://example.test/tool',
    registrableDomain: 'example.test',
    normalizedPageIdentity: 'example.test/tool',
    dr: 20,
  };
  const entrant: EntrantCohortSnapshot = {
    enrichmentId,
    sourceRunId,
    representativeRevision: 1,
    cohortVersion: '1.0.0',
    serpTopN: 10,
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
    sourceRunUpdatedAt: '2026-09-02T10:01:00.000Z',
    clusteringUpdatedAt: '2026-09-02T10:02:00.000Z',
    cohorts: [{
      clusterId: 'cluster-1',
      representativeKeywordIds: [17],
      representativeQueryCount: 1,
      version: '1.0.0',
      serpTopN: 10,
      occurrences: [occurrence],
      excludedOccurrences: [],
      domains: [{
        registrableDomain: 'example.test',
        occurrences: [occurrence],
        occurrenceCount: 1,
        bestRank: 1,
        medianRank: 1,
        queryIdsPresent: [17],
        queryCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        rankingUrls: ['https://example.test/tool'],
        normalizedPageIdentities: ['example.test/tool'],
        pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        samePageRepetition: { repeatedAcrossQueries: false, repeatedPageCount: 0, maxQueriesPerPage: 1 },
        sameDomainDifferentPageRepetition: { repeatedAcrossQueries: false, distinctPageCount: 1 },
        drEvidence: {
          status: 'known',
          value: 20,
          observedValues: [20],
          knownOccurrenceCount: 1,
          occurrenceCount: 1,
          isWeak: true,
        },
      }],
      summary: {
        observedOccurrenceCount: 1,
        excludedOccurrenceCount: 0,
        uniqueDomainCount: 1,
        pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        knownDrDomainCount: 1,
        missingDrDomainCount: 0,
        conflictingDrDomainCount: 0,
        weakDomainCount: 1,
        weakDomainCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        repeatedDomainCount: 0,
        repeatedDomainCoverage: { numerator: 0, denominator: 1, ratio: 0 },
        samePageRepeatedDomainCount: 0,
        differentPageRepeatedDomainCount: 0,
      },
      warnings: ['survivorship warning'],
    }],
  };
  saveEntrantCohortSnapshot(store, entrant);
  return entrant;
}

function sampledSnapshot(entrant: EntrantCohortSnapshot): CohortHistoricalPresenceSnapshot {
  return {
    enrichmentId: entrant.enrichmentId,
    sourceRunId: entrant.sourceRunId,
    entrantRepresentativeRevision: entrant.representativeRevision,
    entrantFingerprint: entrantHistoricalPresenceFingerprint({ ...entrant, updatedAt: 'ignored' }),
    collectionVersion: '1.0.0',
    config: { ...DEFAULT_HISTORICAL_PRESENCE_CONFIG, domainCap: 30 },
    collection: {
      version: '1.0.0',
      domainCap: 30,
      domains: [{
        registrableDomain: 'example.test',
        coverageStatus: 'checked',
        omitReason: null,
        priority: { bestRank: 1, occurrenceCount: 1, clusterCount: 1 },
        cacheStatus: 'miss',
        result: {
          domain: 'example.test',
          status: 'ok',
          earliestSampledCaptureAt: '2014-03-09T00:00:00Z',
          earliestSampledCaptureUrl: 'https://example.test/',
          earliestSampledCaptureHttpStatus: '200',
          earliestMatchedCollectionId: 'CC-MAIN-2014-10',
          earliestMatchedCollectionFrom: '2014-03-01T00:00:00Z',
          earliestMatchedCollectionTo: '2014-03-31T00:00:00Z',
          historyCompleteForSelectedCollections: true,
          selectedCollectionCount: 24,
          checkedCollectionCount: 7,
          source: 'common_crawl',
          sourceReason: 'bounded sampled web-presence',
          error: null,
          fetchedAt: '2026-09-02T10:03:00.000Z',
          requestCount: 7,
          httpStatus: 200,
        },
      }],
      summary: {
        uniqueDomainCount: 1,
        checkedDomainCount: 1,
        omittedDomainCount: 0,
        knownPresenceDomainCount: 1,
        notFoundDomainCount: 0,
        unavailableDomainCount: 0,
        errorDomainCount: 0,
        completeSelectedHistoryDomainCount: 1,
        cacheHitCount: 0,
        networkRequestCount: 7,
        statusCounts: { ok: 1 },
      },
    },
  };
}

test('status projects a DB-newer sampled-history crash window as in-progress finalization', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-status-finalization-freshness-'));
  const location = await allocateResearchLocation(outputRoot, 'finalization freshness', new Date('2026-09-02T10:00:00Z'));
  const runId = 'run_finalization_freshness';
  const enrichmentId = 'enrichment_finalization_freshness';
  await createCompletedDiscovery({
    outputRoot,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
    runId,
  });

  const enrichmentDirectory = await allocateEnrichmentDirectory(location.researchDirectory);
  const store = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
  store.createEnrichmentRun({
    enrichmentId,
    sourceRunId: runId,
    modules: ['clusters'],
    config: '{}',
    sourceRunDirectory: location.discoveryDirectory,
    enrichmentDirectory,
    shortlistKeywords: [],
  });
  store.upsertEnrichmentItem({
    enrichmentId,
    itemId: 'clusters',
    module: 'clusters',
    status: 'completed',
    source: 'serp_overlap',
  });
  store.setEnrichmentState(enrichmentId, 'completed');

  const entrant = saveFinalistParents(store, enrichmentId, runId);
  const oldSampled = sampledSnapshot(entrant);
  saveCohortHistoricalPresenceSnapshot(store, oldSampled);
  const oldPersisted = loadCohortHistoricalPresenceState(store, enrichmentId)!;
  const oldFingerprint = evidenceSnapshotFingerprint(oldPersisted);
  const entrantFingerprint = entrantCohortFingerprint(entrant);

  await writeFile(join(enrichmentDirectory, 'manifest.json'), `${JSON.stringify({
    enrichmentId,
    sourceRunId: runId,
    state: 'completed',
    artifacts: [
      'representative-queries.json',
      'entrant-cohort.json',
      'cohort-historical-presence.json',
      'finalist-evidence-matrix.json',
    ],
    representativeQueries: { revision: 1 },
    entrantCohort: { representativeRevision: 1 },
    historicalPresence: { snapshotFingerprint: oldFingerprint },
    finalistEvidence: {
      representativeRevision: 1,
      entrantFingerprint,
      cohortHistoryFingerprint: null,
      historicalPresenceFingerprint: oldFingerprint,
    },
  }, null, 2)}\n`, 'utf8');

  const changedSampled: CohortHistoricalPresenceSnapshot = {
    ...oldSampled,
    config: {
      ...oldSampled.config,
      maxCollections: oldSampled.config.maxCollections + 1,
    },
  };
  assert.deepEqual(saveCohortHistoricalPresenceSnapshot(store, changedSampled), { changed: true });
  const newPersisted = loadCohortHistoricalPresenceState(store, enrichmentId)!;
  assert.notEqual(evidenceSnapshotFingerprint(newPersisted), oldFingerprint);
  store.close();

  await writeEnrichmentIndex(outputRoot, {
    version: 1,
    enrichmentId,
    runId,
    researchDirectory: location.researchDirectory,
    enrichmentDirectory,
  });

  const status = await buildResearchStatus({ outputRoot, targetRunId: runId });
  assert.equal(status.finalization.state, 'in_progress');
  assert.equal(status.finalization.finalistMatrixPublished, false);
  assert.match(status.finalization.artifactWarning ?? '', /stale relative to current durable parent snapshots/);
  assert.equal(status.nextAction.code, 'run_finalization');
});
