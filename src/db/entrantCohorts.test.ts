import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStore, SCHEMA_VERSION } from './store.js';
import {
  loadEntrantCohortState,
  saveEntrantCohortSnapshot,
  type EntrantCohortSnapshot,
} from './entrantCohorts.js';
import { saveRepresentativeQuerySnapshot } from './representativeSets.js';

function ensureEnrichment(store: RunStore): void {
  if (store.loadEnrichmentRun('enr-1')) return;
  store.createEnrichmentRun({
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    modules: ['clusters'],
    config: JSON.stringify({}),
    sourceRunDirectory: '/tmp/source',
    enrichmentDirectory: '/tmp/enrichment',
    shortlistKeywords: [],
  });
}

function saveRepresentativeParent(store: RunStore, secondVolume: number = 200) {
  ensureEnrichment(store);
  return saveRepresentativeQuerySnapshot(
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
          volume: secondVolume,
          selectionReason: 'high_demand',
          coverageGain: 1,
        },
      ],
      targetCount: 2,
      clusterUrlCount: 2,
      coveredUrlCount: 2,
      manualOverride: false,
      manualOverrideReason: null,
    }],
  );
}

function snapshot(): EntrantCohortSnapshot {
  return {
    enrichmentId: 'enr-1',
    sourceRunId: 'source-1',
    representativeRevision: 1,
    cohortVersion: '1.0.0',
    serpTopN: 10,
    drThresholds: {
      veryWeakMax: 10,
      weakMax: 30,
      strongMin: 60,
      strongMax: 75,
    },
    sourceRunUpdatedAt: '2026-08-29T10:00:00.000Z',
    clusteringUpdatedAt: '2026-08-29T10:05:00.000Z',
    cohorts: [{
      clusterId: 'cluster-1',
      representativeKeywordIds: [17, 20],
      representativeQueryCount: 2,
      version: '1.0.0',
      serpTopN: 10,
      occurrences: [{
        keywordIdx: 17,
        position: 1,
        rankingUrl: 'https://example.test/tool',
        registrableDomain: 'example.test',
        normalizedPageIdentity: 'example.test/tool',
        dr: 20,
      }],
      excludedOccurrences: [],
      domains: [{
        registrableDomain: 'example.test',
        occurrences: [{
          keywordIdx: 17,
          position: 1,
          rankingUrl: 'https://example.test/tool',
          registrableDomain: 'example.test',
          normalizedPageIdentity: 'example.test/tool',
          dr: 20,
        }],
        occurrenceCount: 1,
        bestRank: 1,
        medianRank: 1,
        queryIdsPresent: [17],
        queryCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
        rankingUrls: ['https://example.test/tool'],
        normalizedPageIdentities: ['example.test/tool'],
        pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        samePageRepetition: {
          repeatedAcrossQueries: false,
          repeatedPageCount: 0,
          maxQueriesPerPage: 1,
        },
        sameDomainDifferentPageRepetition: {
          repeatedAcrossQueries: false,
          distinctPageCount: 1,
        },
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
}

test('entrant cohort extension is lazy and does not bump core RunStore schema', () => {
  const store = RunStore.openInMemory();
  try {
    assert.equal(store.version, SCHEMA_VERSION);
    assert.equal(loadEntrantCohortState(store, 'enr-1'), null);
    saveRepresentativeParent(store);
    saveEntrantCohortSnapshot(store, snapshot());
    assert.equal(store.version, SCHEMA_VERSION);
  } finally {
    store.close();
  }
});

test('entrant cohort snapshot round-trips provenance and derived evidence', () => {
  const store = RunStore.openInMemory();
  try {
    saveRepresentativeParent(store);
    const value = snapshot();
    assert.deepEqual(saveEntrantCohortSnapshot(store, value), { changed: true });
    const state = loadEntrantCohortState(store, 'enr-1');
    assert.equal(state?.representativeRevision, 1);
    assert.deepEqual(state?.drThresholds, value.drThresholds);
    assert.equal(state?.sourceRunUpdatedAt, value.sourceRunUpdatedAt);
    assert.equal(state?.clusteringUpdatedAt, value.clusteringUpdatedAt);
    assert.deepEqual(state?.cohorts, value.cohorts);
    assert.equal(typeof state?.updatedAt, 'string');
  } finally {
    store.close();
  }
});

test('identical cohort rerun is unchanged and representative revision change invalidates it atomically', () => {
  const store = RunStore.openInMemory();
  try {
    assert.deepEqual(saveRepresentativeParent(store), { revision: 1, changed: true });
    const value = snapshot();
    assert.deepEqual(saveEntrantCohortSnapshot(store, value), { changed: true });
    assert.deepEqual(saveEntrantCohortSnapshot(store, value), { changed: false });
    assert.equal(loadEntrantCohortState(store, 'enr-1')?.representativeRevision, 1);

    assert.deepEqual(saveRepresentativeParent(store, 201), { revision: 2, changed: true });
    assert.equal(loadEntrantCohortState(store, 'enr-1'), null);
  } finally {
    store.close();
  }
});

test('cohort snapshot requires the current representative revision and exact keyword ids', () => {
  const store = RunStore.openInMemory();
  try {
    ensureEnrichment(store);
    assert.throws(
      () => saveEntrantCohortSnapshot(store, snapshot()),
      /requires a persisted representative-query snapshot/,
    );

    saveRepresentativeParent(store);
    const wrongRevision = { ...snapshot(), representativeRevision: 2 };
    assert.throws(
      () => saveEntrantCohortSnapshot(store, wrongRevision),
      /does not match current revision 1/,
    );

    const wrongIds = snapshot();
    wrongIds.cohorts[0] = {
      ...wrongIds.cohorts[0]!,
      representativeKeywordIds: [20, 17],
    };
    assert.throws(
      () => saveEntrantCohortSnapshot(store, wrongIds),
      /keyword ids do not match representative revision 1/,
    );
  } finally {
    store.close();
  }
});

test('cohort snapshot source identity must match the owning enrichment', () => {
  const store = RunStore.openInMemory();
  try {
    saveRepresentativeParent(store);
    const invalid = { ...snapshot(), sourceRunId: 'other-source' };
    assert.throws(
      () => saveEntrantCohortSnapshot(store, invalid),
      /does not match enrichment source source-1/,
    );
  } finally {
    store.close();
  }
});

test('snapshot refuses mismatched cohort top-N before mutating SQLite', () => {
  const store = RunStore.openInMemory();
  try {
    saveRepresentativeParent(store);
    const invalid = snapshot();
    invalid.cohorts[0] = { ...invalid.cohorts[0]!, serpTopN: 9 };
    assert.throws(
      () => saveEntrantCohortSnapshot(store, invalid),
      /version\/top-N does not match snapshot metadata/,
    );
    assert.equal(loadEntrantCohortState(store, 'enr-1'), null);
  } finally {
    store.close();
  }
});

test('snapshot refuses inconsistent occurrence and denominator projections', () => {
  const store = RunStore.openInMemory();
  try {
    saveRepresentativeParent(store);
    const invalid = snapshot();
    invalid.cohorts[0] = {
      ...invalid.cohorts[0]!,
      summary: {
        ...invalid.cohorts[0]!.summary,
        pageIdentityCoverage: { numerator: 0, denominator: 1, ratio: 0 },
      },
    };
    assert.throws(
      () => saveEntrantCohortSnapshot(store, invalid),
      /page identity coverage is inconsistent/,
    );
  } finally {
    store.close();
  }
});
