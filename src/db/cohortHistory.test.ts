import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStore, SCHEMA_VERSION } from './store.js';
import {
  entrantCohortFingerprint,
  loadCohortHistoryPolicy,
  loadCohortHistoryState,
  saveCohortHistorySnapshot,
} from './cohortHistory.js';
import {
  loadEntrantCohortState,
  saveEntrantCohortSnapshot,
  type EntrantCohortSnapshot,
} from './entrantCohorts.js';
import { saveRepresentativeQuerySnapshot } from './representativeSets.js';
import {
  COHORT_HISTORY_PROJECTION_VERSION,
  projectCohortHistory,
  type CohortHistoryPolicy,
} from '../enrichment/cohortHistory.js';

const POLICY: CohortHistoryPolicy = {
  version: COHORT_HISTORY_PROJECTION_VERSION,
  youngDomainMaxAgeDays: 365,
  recentWebPresenceMaxAgeDays: 365,
  repurposeGapMinDays: 1_000,
};

function seedParent(store: RunStore): EntrantCohortSnapshot {
  store.createEnrichmentRun({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    modules: ['clusters', 'domain_age'],
    config: JSON.stringify({ shortlist: ['speaker test', 'audio test'] }),
    sourceRunDirectory: '/source',
    enrichmentDirectory: '/enrichment',
    shortlistKeywords: ['speaker test', 'audio test'],
  });
  store.setEnrichmentState('enr-1', 'completed');
  saveRepresentativeQuerySnapshot(
    store,
    'enr-1',
    {
      targetCount: 5,
      overrides: [],
      setVersion: '1.0.0',
      selectedClusterIds: ['cluster-1'],
    },
    [{
      clusterId: 'cluster-1',
      setVersion: '1.0.0',
      representativeKeywordIds: [17, 20],
      representatives: [
        {
          keywordIdx: 17,
          keyword: 'speaker test',
          normalizedKeyword: 'speaker test',
          volume: 100,
          selectionReason: 'medoid',
          coverageGain: 1,
        },
        {
          keywordIdx: 20,
          keyword: 'audio test',
          normalizedKeyword: 'audio test',
          volume: 200,
          selectionReason: 'high_demand',
          coverageGain: 0,
        },
      ],
      targetCount: 2,
      clusterUrlCount: 1,
      coveredUrlCount: 1,
      manualOverride: false,
      manualOverrideReason: null,
    }],
  );

  const occurrence = {
    keywordIdx: 17,
    position: 1,
    rankingUrl: 'https://example.test/tool',
    registrableDomain: 'example.test',
    normalizedPageIdentity: 'example.test/tool',
    dr: 20,
  };
  const entrant: EntrantCohortSnapshot = {
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    representativeRevision: 1,
    cohortVersion: '1.0.0',
    serpTopN: 10,
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
    sourceRunUpdatedAt: '2026-08-29T10:00:00.000Z',
    clusteringUpdatedAt: '2026-08-29T10:05:00.000Z',
    cohorts: [{
      clusterId: 'cluster-1',
      representativeKeywordIds: [17, 20],
      representativeQueryCount: 2,
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
        queryCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
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
      warnings: ['observed winners only'],
    }],
  };
  saveEntrantCohortSnapshot(store, entrant);
  return entrant;
}

function currentSnapshot(store: RunStore) {
  const entrant = loadEntrantCohortState(store, 'enr-1')!;
  const projections = projectCohortHistory({
    cohorts: entrant.cohorts,
    historyRecords: [],
    policy: POLICY,
  });
  return {
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    entrantRepresentativeRevision: entrant.representativeRevision,
    entrantFingerprint: entrantCohortFingerprint(entrant),
    projectionVersion: COHORT_HISTORY_PROJECTION_VERSION,
    policy: POLICY,
    projections,
  };
}

function saveHistory(store: RunStore) {
  return saveCohortHistorySnapshot(store, currentSnapshot(store));
}

function saveDomainAgeCheckpoint(store: RunStore, payload: string): void {
  store.upsertEnrichmentItem({
    enrichmentId: 'enr-1',
    itemId: 'example.test',
    module: 'domain_age',
    status: 'completed',
    source: 'rdap',
    cacheStatus: 'none',
    payload,
  });
}

test('cohort history extension is lazy and leaves core RunStore schema unchanged', () => {
  const store = RunStore.openInMemory();
  try {
    assert.equal(store.version, SCHEMA_VERSION);
    assert.equal(loadCohortHistoryState(store, 'enr-1'), null);
    seedParent(store);
    assert.deepEqual(saveHistory(store), { changed: true });
    assert.equal(store.version, SCHEMA_VERSION);
  } finally {
    store.close();
  }
});

test('history snapshot round-trips and identical rerun is unchanged', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    assert.deepEqual(saveHistory(store), { changed: true });
    assert.deepEqual(saveHistory(store), { changed: false });
    const state = loadCohortHistoryState(store, 'enr-1');
    assert.equal(state?.entrantRepresentativeRevision, 1);
    assert.deepEqual(state?.policy, POLICY);
    assert.equal(state?.projections[0]?.summary.unobservedDomainCount, 1);
  } finally {
    store.close();
  }
});

test('domain-age checkpoint mutation invalidates result but preserves policy', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    saveHistory(store);
    store.upsertEnrichmentItem({
      enrichmentId: 'enr-1',
      itemId: 'example.test',
      module: 'domain_age',
      status: 'running',
      source: 'rdap',
      cacheStatus: 'none',
    });
    assert.equal(loadCohortHistoryState(store, 'enr-1'), null);
    assert.deepEqual(loadCohortHistoryPolicy(store, 'enr-1'), POLICY);
  } finally {
    store.close();
  }
});

test('identical domain-age checkpoint replay preserves history while evidence change invalidates it', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    saveDomainAgeCheckpoint(store, '{"evidence":1}');
    saveHistory(store);

    saveDomainAgeCheckpoint(store, '{"evidence":1}');
    assert.notEqual(loadCohortHistoryState(store, 'enr-1'), null);

    saveDomainAgeCheckpoint(store, '{"evidence":2}');
    assert.equal(loadCohortHistoryState(store, 'enr-1'), null);
    assert.deepEqual(loadCohortHistoryPolicy(store, 'enr-1'), POLICY);
  } finally {
    store.close();
  }
});

test('entrant snapshot change invalidates history while preserving policy', () => {
  const store = RunStore.openInMemory();
  try {
    const entrant = seedParent(store);
    saveHistory(store);
    const changed: EntrantCohortSnapshot = {
      ...entrant,
      cohorts: entrant.cohorts.map((cohort) => ({
        ...cohort,
        warnings: [...cohort.warnings, 'new parent evidence marker'],
      })),
    };
    saveEntrantCohortSnapshot(store, changed);
    assert.equal(loadCohortHistoryState(store, 'enr-1'), null);
    assert.deepEqual(loadCohortHistoryPolicy(store, 'enr-1'), POLICY);
  } finally {
    store.close();
  }
});

test('history save rejects a stale entrant fingerprint', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    const snapshot = currentSnapshot(store);
    assert.throws(
      () => saveCohortHistorySnapshot(store, {
        ...snapshot,
        entrantFingerprint: '0'.repeat(64),
      }),
      /entrant fingerprint does not match current parent snapshot/,
    );
  } finally {
    store.close();
  }
});

test('history persistence rejects summary counts not derivable from domain rows', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    const snapshot = currentSnapshot(store);
    snapshot.projections[0]!.summary.youngDomainCount = 1;
    assert.throws(
      () => saveCohortHistorySnapshot(store, snapshot),
      /youngDomainCount is 1; expected 0 from domain rows/,
    );
    assert.equal(loadCohortHistoryPolicy(store, 'enr-1'), null);
  } finally {
    store.close();
  }
});

test('history persistence rejects coverage ratios that do not match their denominator', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    const snapshot = currentSnapshot(store);
    snapshot.projections[0]!.summary.checkedCoverage = {
      numerator: 0,
      denominator: 2,
      ratio: 0,
    };
    assert.throws(
      () => saveCohortHistorySnapshot(store, snapshot),
      /checkedCoverage does not match domain evidence \(0\/1\)/,
    );
    assert.equal(loadCohortHistoryPolicy(store, 'enr-1'), null);
  } finally {
    store.close();
  }
});
