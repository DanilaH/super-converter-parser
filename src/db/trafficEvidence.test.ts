import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStore, SCHEMA_VERSION } from './store.js';
import {
  appendTrafficSnapshots,
  loadTrafficEvidencePolicy,
  loadTrafficImportRecords,
  saveTrafficEvidencePolicy,
} from './trafficEvidence.js';
import { saveRepresentativeQuerySnapshot } from './representativeSets.js';
import {
  loadEntrantCohortState,
  saveEntrantCohortSnapshot,
  type EntrantCohortSnapshot,
} from './entrantCohorts.js';
import {
  TRAFFIC_EVIDENCE_VERSION,
  normalizeTrafficSnapshots,
  type TrafficSnapshot,
} from '../enrichment/trafficEvidence.js';

function seedParent(store: RunStore): EntrantCohortSnapshot {
  store.createEnrichmentRun({
    enrichmentId: 'enr-traffic',
    sourceRunId: 'source-traffic',
    modules: ['clusters'],
    config: JSON.stringify({ shortlist: ['tool test'] }),
    sourceRunDirectory: '/source',
    enrichmentDirectory: '/enrichment',
    shortlistKeywords: ['tool test'],
  });
  store.setEnrichmentState('enr-traffic', 'completed');
  saveRepresentativeQuerySnapshot(
    store,
    'enr-traffic',
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
    rankingUrl: 'https://example.test/tool?utm_source=serp',
    registrableDomain: 'example.test',
    normalizedPageIdentity: 'example.test/tool',
    dr: 20,
  };
  const entrant: EntrantCohortSnapshot = {
    enrichmentId: 'enr-traffic',
    sourceRunId: 'source-traffic',
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
      warnings: [],
    }],
  };
  saveEntrantCohortSnapshot(store, entrant);
  return entrant;
}

function snapshot(store: RunStore, overrides: Partial<{
  observedAt: string;
  providerDataDate: string;
  organicTraffic: number;
  entity: string;
  scope: 'domain' | 'url';
  provenance: string;
}> = {}): TrafficSnapshot {
  const entrant = loadEntrantCohortState(store, 'enr-traffic');
  if (!entrant) throw new Error('seedParent must run first');
  return normalizeTrafficSnapshots({
    rows: [{
      targetClusterId: 'cluster-1',
      scope: overrides.scope ?? 'domain',
      entity: overrides.entity ?? 'example.test',
      observedAt: overrides.observedAt ?? '2026-08-29T12:00:00.000Z',
      providerDataDate: overrides.providerDataDate ?? '2026-08-28',
      market: 'US',
      source: 'manual-provider',
      organicTraffic: overrides.organicTraffic ?? 100,
      trafficValue: null,
      trafficValueCurrency: null,
      provenance: overrides.provenance ?? 'manual import row',
    }],
    cohorts: entrant.cohorts,
  })[0]!;
}

const POLICY = {
  version: TRAFFIC_EVIDENCE_VERSION,
  lowBaseOrganicTrafficThreshold: 100,
};

test('traffic evidence extension is lazy and leaves core schema version unchanged', () => {
  const store = RunStore.openInMemory();
  try {
    assert.equal(store.version, SCHEMA_VERSION);
    assert.deepEqual(loadTrafficImportRecords(store, 'enr-traffic'), []);
    assert.equal(loadTrafficEvidencePolicy(store, 'enr-traffic'), null);
    seedParent(store);
    saveTrafficEvidencePolicy(store, 'enr-traffic', POLICY);
    assert.equal(store.version, SCHEMA_VERSION);
  } finally {
    store.close();
  }
});

test('traffic policy cannot create orphan state for a missing enrichment', () => {
  const store = RunStore.openInMemory();
  try {
    assert.throws(
      () => saveTrafficEvidencePolicy(store, 'missing-enrichment', POLICY),
      /enrichment missing-enrichment does not exist/,
    );
    assert.equal(loadTrafficEvidencePolicy(store, 'missing-enrichment'), null);
  } finally {
    store.close();
  }
});

test('traffic policy round-trips independently from imported evidence', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    saveTrafficEvidencePolicy(store, 'enr-traffic', POLICY);
    assert.deepEqual(loadTrafficEvidencePolicy(store, 'enr-traffic'), POLICY);
    assert.deepEqual(loadTrafficImportRecords(store, 'enr-traffic'), []);
  } finally {
    store.close();
  }
});

test('identical traffic re-import is idempotent while corrected observation appends history', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    const first = snapshot(store);
    assert.deepEqual(appendTrafficSnapshots(store, 'enr-traffic', [first]), {
      inserted: 1,
      duplicates: 0,
    });
    assert.deepEqual(appendTrafficSnapshots(store, 'enr-traffic', [first]), {
      inserted: 0,
      duplicates: 1,
    });
    const corrected = snapshot(store, {
      observedAt: '2026-08-29T13:00:00.000Z',
      organicTraffic: 120,
      provenance: 'corrected manual import',
    });
    assert.deepEqual(appendTrafficSnapshots(store, 'enr-traffic', [corrected]), {
      inserted: 1,
      duplicates: 0,
    });
    const records = loadTrafficImportRecords(store, 'enr-traffic');
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.snapshot.organicTraffic), [100, 120]);
    assert.equal(records.every((record) => /^[a-f0-9]{64}$/.test(record.snapshotId)), true);
    assert.equal(records.every((record) => /^[a-f0-9]{64}$/.test(record.entrantFingerprint)), true);
  } finally {
    store.close();
  }
});

test('raw entity spelling does not duplicate the same normalized traffic fact', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    const first = snapshot(store, {
      scope: 'url',
      entity: 'https://example.test/tool?utm_source=a',
    });
    const sameFact = snapshot(store, {
      scope: 'url',
      entity: 'https://www.example.test/tool?utm_campaign=b',
    });
    assert.deepEqual(appendTrafficSnapshots(store, 'enr-traffic', [first, sameFact]), {
      inserted: 1,
      duplicates: 1,
    });
    assert.equal(loadTrafficImportRecords(store, 'enr-traffic').length, 1);
  } finally {
    store.close();
  }
});

test('persistence rejects fabricated target validation instead of trusting callers', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    const traffic = snapshot(store);
    const fabricated: TrafficSnapshot = {
      ...traffic,
      targetValidation: {
        status: 'mismatch',
        basis: 'registrable_domain',
        matchedDomain: null,
        matchedRankingUrl: null,
        reason: 'domain_not_in_target',
      },
    };
    assert.throws(
      () => appendTrafficSnapshots(store, 'enr-traffic', [fabricated]),
      /not canonical for the current entrant cohort/,
    );
    assert.deepEqual(loadTrafficImportRecords(store, 'enr-traffic'), []);
  } finally {
    store.close();
  }
});

test('mixed valid/fabricated batch is rejected before any traffic row is written', () => {
  const store = RunStore.openInMemory();
  try {
    seedParent(store);
    const valid = snapshot(store, { organicTraffic: 100 });
    const second = snapshot(store, {
      observedAt: '2026-08-29T13:00:00.000Z',
      organicTraffic: 120,
      provenance: 'second row',
    });
    const fabricated: TrafficSnapshot = {
      ...second,
      targetValidation: {
        status: 'mismatch',
        basis: 'registrable_domain',
        matchedDomain: null,
        matchedRankingUrl: null,
        reason: 'domain_not_in_target',
      },
    };
    assert.throws(
      () => appendTrafficSnapshots(store, 'enr-traffic', [valid, fabricated]),
      /not canonical for the current entrant cohort/,
    );
    assert.deepEqual(loadTrafficImportRecords(store, 'enr-traffic'), []);
  } finally {
    store.close();
  }
});

test('entrant cohort changes do not delete append-only historical traffic facts', () => {
  const store = RunStore.openInMemory();
  try {
    const entrant = seedParent(store);
    appendTrafficSnapshots(store, 'enr-traffic', [snapshot(store)]);
    const before = loadTrafficImportRecords(store, 'enr-traffic')[0]!;

    saveEntrantCohortSnapshot(store, {
      ...entrant,
      cohorts: entrant.cohorts.map((cohort) => ({
        ...cohort,
        warnings: [...cohort.warnings, 'parent changed after traffic import'],
      })),
    });

    const after = loadTrafficImportRecords(store, 'enr-traffic')[0]!;
    assert.equal(after.snapshotId, before.snapshotId);
    assert.equal(after.entrantFingerprint, before.entrantFingerprint);
    assert.deepEqual(after.snapshot, before.snapshot);
  } finally {
    store.close();
  }
});
