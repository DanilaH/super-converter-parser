import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { RunStore } from './store.js';
import { saveRepresentativeQuerySnapshot } from './representativeSets.js';
import { saveEntrantCohortSnapshot, type EntrantCohortSnapshot } from './entrantCohorts.js';
import {
  entrantHistoricalPresenceFingerprint,
  loadCohortHistoricalPresenceState,
  saveCohortHistoricalPresenceSnapshot,
  type CohortHistoricalPresenceSnapshot,
} from './cohortHistoricalPresence.js';
import { DEFAULT_HISTORICAL_PRESENCE_CONFIG } from '../historicalPresence/types.js';

type StoreWithDb = { db: Database.Database };

function dbOf(store: RunStore): Database.Database {
  return (store as unknown as StoreWithDb).db;
}

function setupEntrant(store: RunStore): EntrantCohortSnapshot {
  store.createEnrichmentRun({
    enrichmentId: 'enr-1', sourceRunId: 'source-1', modules: ['clusters'], config: '{}',
    sourceRunDirectory: '/tmp/source', enrichmentDirectory: '/tmp/enrichment', shortlistKeywords: [],
  });
  saveRepresentativeQuerySnapshot(store, 'enr-1', {
    targetCount: 1, overrides: [], setVersion: '1.0.0', selectedClusterIds: ['cluster-1'],
  }, [{
    clusterId: 'cluster-1', setVersion: '1.0.0', representativeKeywordIds: [17],
    representatives: [{
      keywordIdx: 17, keyword: 'speaker test', normalizedKeyword: 'speaker test', volume: 100,
      selectionReason: 'medoid', coverageGain: 1,
    }],
    targetCount: 1, clusterUrlCount: 1, coveredUrlCount: 1, manualOverride: false, manualOverrideReason: null,
  }]);
  const occurrence = {
    keywordIdx: 17, position: 1, rankingUrl: 'https://example.test/tool',
    registrableDomain: 'example.test', normalizedPageIdentity: 'example.test/tool', dr: 20,
  };
  const snapshot: EntrantCohortSnapshot = {
    enrichmentId: 'enr-1', sourceRunId: 'source-1', representativeRevision: 1,
    cohortVersion: '1.0.0', serpTopN: 10,
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
    sourceRunUpdatedAt: '2026-08-31T00:00:00.000Z', clusteringUpdatedAt: '2026-08-31T00:01:00.000Z',
    cohorts: [{
      clusterId: 'cluster-1', representativeKeywordIds: [17], representativeQueryCount: 1,
      version: '1.0.0', serpTopN: 10, occurrences: [occurrence], excludedOccurrences: [],
      domains: [{
        registrableDomain: 'example.test', occurrences: [occurrence], occurrenceCount: 1, bestRank: 1, medianRank: 1,
        queryIdsPresent: [17], queryCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        rankingUrls: ['https://example.test/tool'], normalizedPageIdentities: ['example.test/tool'],
        pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        samePageRepetition: { repeatedAcrossQueries: false, repeatedPageCount: 0, maxQueriesPerPage: 1 },
        sameDomainDifferentPageRepetition: { repeatedAcrossQueries: false, distinctPageCount: 1 },
        drEvidence: { status: 'known', value: 20, observedValues: [20], knownOccurrenceCount: 1, occurrenceCount: 1, isWeak: true },
      }],
      summary: {
        observedOccurrenceCount: 1, excludedOccurrenceCount: 0, uniqueDomainCount: 1,
        pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        knownDrDomainCount: 1, missingDrDomainCount: 0, conflictingDrDomainCount: 0,
        weakDomainCount: 1, weakDomainCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        repeatedDomainCount: 0, repeatedDomainCoverage: { numerator: 0, denominator: 1, ratio: 0 },
        samePageRepeatedDomainCount: 0, differentPageRepeatedDomainCount: 0,
      },
      warnings: ['survivorship warning'],
    }],
  };
  saveEntrantCohortSnapshot(store, snapshot);
  return snapshot;
}

function sampledSnapshot(store: RunStore): CohortHistoricalPresenceSnapshot {
  const parent = setupEntrant(store);
  const fingerprint = entrantHistoricalPresenceFingerprint({ ...parent, updatedAt: 'ignored' });
  return {
    enrichmentId: 'enr-1', sourceRunId: 'source-1', entrantRepresentativeRevision: 1,
    entrantFingerprint: fingerprint, collectionVersion: '1.0.0',
    config: { ...DEFAULT_HISTORICAL_PRESENCE_CONFIG, domainCap: 30 },
    collection: {
      version: '1.0.0', domainCap: 30,
      domains: [{
        registrableDomain: 'example.test', coverageStatus: 'checked', omitReason: null,
        priority: { bestRank: 1, occurrenceCount: 1, clusterCount: 1 }, cacheStatus: 'miss',
        result: {
          domain: 'example.test', status: 'ok', earliestSampledCaptureAt: '2014-03-09T00:00:00Z',
          earliestSampledCaptureUrl: 'https://example.test/', earliestSampledCaptureHttpStatus: '200',
          earliestMatchedCollectionId: 'CC-MAIN-2014-10', earliestMatchedCollectionFrom: '2014-03-01T00:00:00Z',
          earliestMatchedCollectionTo: '2014-03-31T00:00:00Z', historyCompleteForSelectedCollections: true,
          selectedCollectionCount: 24, checkedCollectionCount: 7, source: 'common_crawl',
          sourceReason: 'bounded sampled web-presence', error: null, fetchedAt: '2026-08-31T00:00:00.000Z',
          requestCount: 7, httpStatus: 200,
        },
      }],
      summary: {
        uniqueDomainCount: 1, checkedDomainCount: 1, omittedDomainCount: 0, knownPresenceDomainCount: 1,
        notFoundDomainCount: 0, unavailableDomainCount: 0, errorDomainCount: 0,
        completeSelectedHistoryDomainCount: 1, cacheHitCount: 0, networkRequestCount: 7, statusCounts: { ok: 1 },
      },
    },
  };
}

test('sampled historical-presence snapshot round-trips against entrant parent', () => {
  const store = RunStore.openInMemory();
  try {
    const snapshot = sampledSnapshot(store);
    assert.deepEqual(saveCohortHistoricalPresenceSnapshot(store, snapshot), { changed: true });
    assert.deepEqual(saveCohortHistoricalPresenceSnapshot(store, snapshot), { changed: false });
    const state = loadCohortHistoricalPresenceState(store, 'enr-1');
    assert.equal(state?.entrantFingerprint, snapshot.entrantFingerprint);
    assert.equal(state?.collection.summary.knownPresenceDomainCount, 1);
    assert.equal(state?.collection.domains[0]?.result?.earliestSampledCaptureAt, '2014-03-09T00:00:00Z');
  } finally {
    store.close();
  }
});

test('entrant snapshot mutation invalidates sampled historical-presence snapshot', () => {
  const store = RunStore.openInMemory();
  try {
    const snapshot = sampledSnapshot(store);
    saveCohortHistoricalPresenceSnapshot(store, snapshot);
    const db = dbOf(store);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM enrichment_cohort_historical_presence_snapshots').get() as { count: number }).count,
      1,
    );
    db.prepare("UPDATE enrichment_entrant_cohort_snapshots SET snapshot_json = snapshot_json || ' '").run();
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM enrichment_cohort_historical_presence_snapshots').get() as { count: number }).count,
      0,
    );
  } finally {
    store.close();
  }
});
