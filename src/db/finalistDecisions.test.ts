import test from 'node:test';
import assert from 'node:assert/strict';
import { entrantCohortFingerprint } from './cohortHistory.js';
import {
  loadFinalistDecisions,
  replaceFinalistDecisions,
} from './finalistDecisions.js';
import {
  loadEntrantCohortState,
  saveEntrantCohortSnapshot,
  type EntrantCohortSnapshot,
} from './entrantCohorts.js';
import { saveRepresentativeQuerySnapshot } from './representativeSets.js';
import { RunStore, SCHEMA_VERSION } from './store.js';

function seedParent(store: RunStore): EntrantCohortSnapshot {
  store.createEnrichmentRun({
    enrichmentId: 'enr-finalists',
    sourceRunId: 'source-finalists',
    modules: ['clusters'],
    config: JSON.stringify({ shortlist: ['tool test'] }),
    sourceRunDirectory: '/source',
    enrichmentDirectory: '/enrichment',
    shortlistKeywords: ['tool test'],
  });
  store.setEnrichmentState('enr-finalists', 'completed');
  saveRepresentativeQuerySnapshot(
    store,
    'enr-finalists',
    {
      targetCount: 3,
      overrides: [],
      setVersion: '1.0.0',
      selectedClusterIds: ['cluster-1'],
    },
    [{
      clusterId: 'cluster-1',
      setVersion: '1.0.0',
      representativeKeywordIds: [1],
      representatives: [{
        keywordIdx: 1,
        keyword: 'tool test',
        normalizedKeyword: 'tool test',
        volume: 100,
        selectionReason: 'medoid',
        coverageGain: 1,
      }],
      targetCount: 1,
      clusterUrlCount: 1,
      coveredUrlCount: 1,
      manualOverride: false,
      manualOverrideReason: null,
    }],
  );

  const occurrence = {
    keywordIdx: 1,
    position: 1,
    rankingUrl: 'https://example.test/tool',
    registrableDomain: 'example.test',
    normalizedPageIdentity: 'example.test/tool',
    dr: 20,
  };
  const entrant: EntrantCohortSnapshot = {
    enrichmentId: 'enr-finalists',
    sourceRunId: 'source-finalists',
    representativeRevision: 1,
    cohortVersion: '1.0.0',
    serpTopN: 10,
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
    sourceRunUpdatedAt: '2026-08-29T10:00:00.000Z',
    clusteringUpdatedAt: '2026-08-29T10:05:00.000Z',
    cohorts: [{
      clusterId: 'cluster-1',
      representativeKeywordIds: [1],
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
        queryIdsPresent: [1],
        queryCoverage: { numerator: 1, denominator: 1, ratio: 1 },
        rankingUrls: [occurrence.rankingUrl],
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
      warnings: [],
    }],
  };
  saveEntrantCohortSnapshot(store, entrant);
  return entrant;
}

test('finalist decision extension is lazy and leaves core schema version unchanged', () => {
  const store = RunStore.openInMemory();
  try {
    assert.equal(store.version, SCHEMA_VERSION);
    assert.deepEqual(loadFinalistDecisions(store, 'enr-finalists'), []);
    seedParent(store);
    replaceFinalistDecisions(store, 'enr-finalists', [{
      clusterId: 'cluster-1',
      buildDecision: 'watch',
      seoProductRole: 'experimental',
    }]);
    assert.equal(store.version, SCHEMA_VERSION);
  } finally {
    store.close();
  }
});

test('human decisions are pinned to the current representative revision and entrant fingerprint', () => {
  const store = RunStore.openInMemory();
  try {
    const entrant = seedParent(store);
    const saved = replaceFinalistDecisions(store, 'enr-finalists', [{
      clusterId: 'cluster-1',
      buildDecision: 'build',
      seoProductRole: 'acquisition_anchor',
    }]);

    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.representativeRevision, 1);
    assert.equal(saved[0]!.entrantFingerprint, entrantCohortFingerprint(entrant));
    assert.equal(Number.isFinite(Date.parse(saved[0]!.updatedAt)), true);
    assert.deepEqual(loadFinalistDecisions(store, 'enr-finalists'), saved);
  } finally {
    store.close();
  }
});

test('invalid replacement scope is rejected before existing decisions are deleted', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    const before = replaceFinalistDecisions(store, 'enr-finalists', [{
      clusterId: 'cluster-1',
      buildDecision: 'watch',
      seoProductRole: null,
    }]);

    assert.throws(
      () => replaceFinalistDecisions(store, 'enr-finalists', [{
        clusterId: 'cluster-99',
        buildDecision: 'reject',
        seoProductRole: null,
      }]),
      /unknown current finalist cluster-99/,
    );
    assert.deepEqual(loadFinalistDecisions(store, 'enr-finalists'), before);
  } finally {
    store.close();
  }
});

test('upstream entrant changes preserve the historical decision generation for stale review', () => {
  const store = RunStore.openInMemory();
  try {
    const entrant = seedParent(store);
    const before = replaceFinalistDecisions(store, 'enr-finalists', [{
      clusterId: 'cluster-1',
      buildDecision: 'watch',
      seoProductRole: 'strong_supporting_tool',
    }])[0]!;

    saveEntrantCohortSnapshot(store, {
      ...entrant,
      cohorts: entrant.cohorts.map((cohort) => ({
        ...cohort,
        warnings: [...cohort.warnings, 'new entrant observation'],
      })),
    });
    const currentEntrant = loadEntrantCohortState(store, 'enr-finalists');
    if (!currentEntrant) throw new Error('expected entrant state');
    const after = loadFinalistDecisions(store, 'enr-finalists')[0]!;

    assert.equal(after.entrantFingerprint, before.entrantFingerprint);
    assert.notEqual(after.entrantFingerprint, entrantCohortFingerprint(currentEntrant));
    assert.equal(after.buildDecision, 'watch');
  } finally {
    store.close();
  }
});

test('explicit empty replacement clears current decision rows', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    replaceFinalistDecisions(store, 'enr-finalists', [{
      clusterId: 'cluster-1',
      buildDecision: 'unknown',
      seoProductRole: 'experimental',
    }]);
    assert.equal(loadFinalistDecisions(store, 'enr-finalists').length, 1);

    assert.deepEqual(replaceFinalistDecisions(store, 'enr-finalists', []), []);
    assert.deepEqual(loadFinalistDecisions(store, 'enr-finalists'), []);
  } finally {
    store.close();
  }
});
