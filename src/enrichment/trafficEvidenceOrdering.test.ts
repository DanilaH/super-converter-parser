import test from 'node:test';
import assert from 'node:assert/strict';
import type { EntrantCohort } from './entrantCohort.js';
import {
  TRAFFIC_EVIDENCE_VERSION,
  normalizeTrafficSnapshots,
  projectTrafficEvidence,
  type TrafficSnapshot,
  type TrafficSnapshotInput,
} from './trafficEvidence.js';
import { projectCurrentTrafficEvidence } from './trafficEvidenceCurrent.js';

function cohort(): EntrantCohort {
  const occurrence = {
    keywordIdx: 1,
    position: 1,
    rankingUrl: 'https://example.test/tool',
    registrableDomain: 'example.test',
    normalizedPageIdentity: 'example.test/tool',
    dr: 20,
  };
  return {
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
      normalizedPageIdentities: [occurrence.normalizedPageIdentity],
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
  };
}

const POLICY = {
  version: TRAFFIC_EVIDENCE_VERSION,
  lowBaseOrganicTrafficThreshold: 50,
};

function input(overrides: Partial<TrafficSnapshotInput> = {}): TrafficSnapshotInput {
  return {
    targetClusterId: 'cluster-1',
    scope: 'domain',
    entity: 'example.test',
    observedAt: '2026-08-29T12:00:00.000Z',
    providerDataDate: '2026-08-28',
    market: 'US',
    source: 'provider-a',
    organicTraffic: 100,
    trafficValue: null,
    trafficValueCurrency: null,
    provenance: 'same provenance',
    ...overrides,
  };
}

function snapshotOrder(snapshots: TrafficSnapshot[]): string[] {
  return snapshots.map((snapshot) => [
    snapshot.market,
    snapshot.source,
    snapshot.organicTraffic,
  ].join('|'));
}

test('mismatch output ordering is permutation-stable across market, source, and final snapshot tie-breaks', () => {
  const rows = [
    input({ entity: 'other.test', market: 'US', source: 'provider-b', organicTraffic: 200 }),
    input({ entity: 'other.test', market: 'UK', source: 'provider-a', organicTraffic: 100 }),
    input({ entity: 'other.test', market: 'US', source: 'provider-a', organicTraffic: 150 }),
    input({ entity: 'other.test', market: 'US', source: 'provider-a', organicTraffic: 125 }),
  ];
  const project = (orderedRows: TrafficSnapshotInput[]) => {
    const snapshots = normalizeTrafficSnapshots({ rows: orderedRows, cohorts: [cohort()] });
    return snapshotOrder(projectTrafficEvidence({ snapshots, policy: POLICY }).mismatchedSnapshots);
  };

  const forward = project(rows);
  const reversed = project([...rows].reverse());

  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, [
    'uk|provider-a|100',
    'us|provider-a|125',
    'us|provider-a|150',
    'us|provider-b|200',
  ]);
});

test('stale target ordering reuses the same permutation-stable snapshot comparator', () => {
  const rows = [
    input({ market: 'US', source: 'provider-b', organicTraffic: 200 }),
    input({ market: 'UK', source: 'provider-a', organicTraffic: 100 }),
    input({ market: 'US', source: 'provider-a', organicTraffic: 150 }),
    input({ market: 'US', source: 'provider-a', organicTraffic: 125 }),
  ];
  const project = (orderedRows: TrafficSnapshotInput[]) => {
    const importedSnapshots = normalizeTrafficSnapshots({ rows: orderedRows, cohorts: [cohort()] });
    const current = projectCurrentTrafficEvidence({
      importedSnapshots,
      cohorts: [],
      policy: POLICY,
    });
    return snapshotOrder(current.staleTargets.map((target) => target.snapshot));
  };

  const forward = project(rows);
  const reversed = project([...rows].reverse());

  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, [
    'uk|provider-a|100',
    'us|provider-a|125',
    'us|provider-a|150',
    'us|provider-b|200',
  ]);
});
