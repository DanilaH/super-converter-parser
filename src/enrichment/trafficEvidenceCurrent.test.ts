import test from 'node:test';
import assert from 'node:assert/strict';
import type { EntrantCohort } from './entrantCohort.js';
import {
  TRAFFIC_EVIDENCE_VERSION,
  normalizeTrafficSnapshots,
  type TrafficSnapshotInput,
} from './trafficEvidence.js';
import { projectCurrentTrafficEvidence } from './trafficEvidenceCurrent.js';

function cohort(includePage = true): EntrantCohort {
  const occurrence = {
    keywordIdx: 1,
    position: 1,
    rankingUrl: 'https://example.test/tool',
    registrableDomain: 'example.test',
    normalizedPageIdentity: includePage ? 'example.test/tool' : 'example.test/other',
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
      normalizedPageIdentities: [occurrence.normalizedPageIdentity!],
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

function input(overrides: Partial<TrafficSnapshotInput> = {}): TrafficSnapshotInput {
  return {
    targetClusterId: 'cluster-1',
    scope: 'url',
    entity: 'https://example.test/tool',
    observedAt: '2026-08-29T12:00:00Z',
    providerDataDate: '2026-08-28',
    market: 'US',
    source: 'manual',
    organicTraffic: 100,
    trafficValue: null,
    trafficValueCurrency: null,
    provenance: 'manual row',
    ...overrides,
  };
}

const POLICY = {
  version: TRAFFIC_EVIDENCE_VERSION,
  lowBaseOrganicTrafficThreshold: 50,
};

test('current projection revalidates stored target intent against current entrant pages', () => {
  const imported = normalizeTrafficSnapshots({ rows: [input()], cohorts: [cohort(true)] });
  const current = projectCurrentTrafficEvidence({
    importedSnapshots: imported,
    cohorts: [cohort(false)],
    policy: POLICY,
  });
  assert.equal(current.importedSnapshotCount, 1);
  assert.equal(current.currentTargetSnapshotCount, 1);
  assert.equal(current.staleTargetSnapshotCount, 0);
  assert.equal(current.projection.matchedSnapshotCount, 0);
  assert.equal(current.projection.mismatchedSnapshotCount, 1);
  assert.equal(
    current.projection.mismatchedSnapshots[0]?.targetValidation.reason,
    'ranking_url_not_in_target',
  );
});

test('removed finalist cluster becomes stale target without deleting imported evidence', () => {
  const imported = normalizeTrafficSnapshots({ rows: [input()], cohorts: [cohort(true)] });
  const current = projectCurrentTrafficEvidence({
    importedSnapshots: imported,
    cohorts: [],
    policy: POLICY,
  });
  assert.equal(current.importedSnapshotCount, 1);
  assert.equal(current.currentTargetSnapshotCount, 0);
  assert.equal(current.staleTargetSnapshotCount, 1);
  assert.equal(current.projection.snapshotCount, 0);
  assert.equal(current.projection.histories.length, 0);
  assert.equal(current.staleTargets[0]?.reason, 'target_cluster_not_current');
  assert.equal(current.staleTargets[0]?.snapshot.normalizedEntity, 'example.test/tool');
});

test('current projection can turn an old mismatch into matched evidence when cohort intent changes', () => {
  const initial = cohort(true);
  const imported = normalizeTrafficSnapshots({
    rows: [input({ entity: 'https://example.test/other' })],
    cohorts: [initial],
  });
  assert.equal(imported[0]?.targetValidation.status, 'mismatch');

  const changed = cohort(false);
  changed.occurrences[0]!.rankingUrl = 'https://example.test/other';
  const current = projectCurrentTrafficEvidence({
    importedSnapshots: imported,
    cohorts: [changed],
    policy: POLICY,
  });
  assert.equal(current.projection.matchedSnapshotCount, 1);
  assert.equal(current.projection.mismatchedSnapshotCount, 0);
  assert.equal(current.projection.histories.length, 1);
});
