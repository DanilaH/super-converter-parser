import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CohortHistoryProjection } from '../enrichment/cohortHistory.js';
import type { EntrantCohort } from '../enrichment/entrantCohort.js';
import type { RepresentativeQuerySet } from '../enrichment/representativeQueries.js';
import type { CurrentTrafficEvidenceProjection } from '../enrichment/trafficEvidenceCurrent.js';
import { projectDeepEvidenceCoverage } from './evidenceCoverage.js';

function representatives(): RepresentativeQuerySet[] {
  return [{
    clusterId: 'cluster-1',
    setVersion: '1.0.0',
    representativeKeywordIds: [0],
    representatives: [],
    targetCount: 1,
    clusterUrlCount: 4,
    coveredUrlCount: 3,
    manualOverride: false,
    manualOverrideReason: null,
  }];
}

function cohorts(): EntrantCohort[] {
  return [{
    clusterId: 'cluster-1',
    representativeKeywordIds: [0],
    representativeQueryCount: 1,
    version: '1.0.0',
    serpTopN: 10,
    occurrences: [],
    excludedOccurrences: [],
    domains: [
      { registrableDomain: 'a.example' },
      { registrableDomain: 'b.example' },
      { registrableDomain: 'c.example' },
    ],
    summary: {
      observedOccurrenceCount: 3,
      excludedOccurrenceCount: 0,
      uniqueDomainCount: 3,
      pageIdentityCoverage: { numerator: 2, denominator: 3, ratio: 2 / 3 },
      knownDrDomainCount: 1,
      missingDrDomainCount: 1,
      conflictingDrDomainCount: 1,
      weakDomainCount: 0,
      weakDomainCoverage: { numerator: 0, denominator: 1, ratio: 0 },
      repeatedDomainCount: 0,
      repeatedDomainCoverage: { numerator: 0, denominator: 3, ratio: 0 },
      samePageRepeatedDomainCount: 0,
      differentPageRepeatedDomainCount: 0,
    },
    warnings: [],
  } as unknown as EntrantCohort];
}

function history(): CohortHistoryProjection[] {
  return [{
    clusterId: 'cluster-1',
    version: '1.0.0',
    policy: {
      version: '1.0.0',
      youngDomainMaxAgeDays: 730,
      recentWebPresenceMaxAgeDays: 730,
      repurposeGapMinDays: 365,
    },
    domains: [],
    summary: {
      cohortDomainCount: 3,
      checkedDomainCount: 2,
      omittedDomainCount: 1,
      unobservedDomainCount: 0,
      checkedCoverage: { numerator: 2, denominator: 3, ratio: 2 / 3 },
      registrationKnownDomainCount: 2,
      youngDomainCount: 1,
      youngDomainCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
      firstSeenKnownDomainCount: 1,
      recentWebPresenceCount: 1,
      recentWebPresenceCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      comparableHistoryDomainCount: 1,
      possibleHistoryConflictCount: 0,
      possibleHistoryConflictCoverage: { numerator: 0, denominator: 1, ratio: 0 },
      registrationStatusCounts: { ok: 2, not_attempted: 1 },
      firstSeenStatusCounts: { ok: 1, unavailable: 1, not_attempted: 1 },
    },
  }];
}

test('deep coverage keeps omitted/unavailable/missing evidence out of known coverage', () => {
  const result = projectDeepEvidenceCoverage({
    representatives: representatives(),
    cohorts: cohorts(),
    history: history(),
    traffic: { importedSnapshotCount: 0, policyAvailable: false, current: null },
    finalistMatrixPublished: true,
  });

  assert.deepEqual(result.representativeUrlCoverage, { numerator: 3, denominator: 4, ratio: 0.75 });
  assert.deepEqual(result.drKnownCoverage, { numerator: 1, denominator: 3, ratio: 1 / 3 });
  assert.deepEqual(result.pageIdentityCoverage, { numerator: 2, denominator: 3, ratio: 2 / 3 });
  assert.deepEqual(result.history?.registrationKnownCoverage, { numerator: 2, denominator: 3, ratio: 2 / 3 });
  assert.deepEqual(result.history?.firstSeenKnownCoverage, { numerator: 1, denominator: 3, ratio: 1 / 3 });
  assert.equal(result.history?.omittedDomainCount, 1);
  assert.equal(result.history?.firstSeenUnavailableCount, 1);

  const codes = result.warnings.map((warning) => warning.code);
  assert.deepEqual(codes, [
    'REPRESENTATIVE_URL_COVERAGE_INCOMPLETE',
    'DR_EVIDENCE_INCOMPLETE',
    'PAGE_IDENTITY_COVERAGE_INCOMPLETE',
    'COHORT_HISTORY_OMITTED',
    'RDAP_REGISTRATION_COVERAGE_INCOMPLETE',
    'HISTORICAL_WEB_PRESENCE_COVERAGE_INCOMPLETE',
    'FIRST_SEEN_PROVIDER_UNAVAILABLE',
    'TRAFFIC_EVIDENCE_NOT_COLLECTED',
  ]);
  assert.match(
    result.warnings.find((warning) => warning.code === 'HISTORICAL_WEB_PRESENCE_COVERAGE_INCOMPLETE')!.message,
    /must not be interpreted as established\/old/,
  );
  assert.match(
    result.warnings.find((warning) => warning.code === 'TRAFFIC_EVIDENCE_NOT_COLLECTED')!.message,
    /not zero traffic/,
  );
});

test('missing cohort history remains absent instead of fabricating zero provider coverage', () => {
  const result = projectDeepEvidenceCoverage({
    representatives: representatives(),
    cohorts: cohorts(),
    history: null,
    traffic: null,
    finalistMatrixPublished: true,
  });

  assert.equal(result.history, null);
  assert.deepEqual(
    result.warnings.filter((warning) => warning.code.startsWith('RDAP_') || warning.code.startsWith('HISTORICAL_')),
    [],
  );
  assert.equal(result.warnings.some((warning) => warning.code === 'COHORT_HISTORY_NOT_COLLECTED'), true);
});

test('traffic coverage counts only current matched domain-scope evidence', () => {
  const current = {
    importedSnapshotCount: 4,
    currentTargetSnapshotCount: 3,
    staleTargetSnapshotCount: 1,
    projection: {
      version: '1.0.0',
      policy: { version: '1.0.0', lowBaseOrganicTrafficThreshold: 10 },
      snapshotCount: 3,
      matchedSnapshotCount: 2,
      mismatchedSnapshotCount: 1,
      histories: [
        {
          targetClusterId: 'cluster-1',
          scope: 'domain',
          normalizedEntity: 'a.example',
        },
        {
          targetClusterId: 'cluster-1',
          scope: 'url',
          normalizedEntity: 'https://b.example/page',
        },
      ],
      mismatchedSnapshots: [],
    },
    staleTargets: [],
  } as unknown as CurrentTrafficEvidenceProjection;

  const result = projectDeepEvidenceCoverage({
    representatives: representatives(),
    cohorts: cohorts(),
    history: history(),
    traffic: { importedSnapshotCount: 4, policyAvailable: true, current },
    finalistMatrixPublished: true,
  });

  assert.deepEqual(result.traffic?.matchedDomainCoverage, { numerator: 1, denominator: 3, ratio: 1 / 3 });
  const codes = result.warnings.map((warning) => warning.code);
  assert.equal(codes.includes('TRAFFIC_STALE_TARGETS'), true);
  assert.equal(codes.includes('TRAFFIC_TARGET_MISMATCH'), true);
  assert.equal(codes.includes('TRAFFIC_DOMAIN_COVERAGE_INCOMPLETE'), true);
  assert.equal(codes.includes('TRAFFIC_EVIDENCE_NOT_COLLECTED'), false);
});

test('no finalization state produces no invented deep warnings', () => {
  const result = projectDeepEvidenceCoverage({
    representatives: null,
    cohorts: null,
    history: null,
    traffic: null,
    finalistMatrixPublished: false,
  });

  assert.equal(result.representativeUrlCoverage, null);
  assert.equal(result.drKnownCoverage, null);
  assert.equal(result.pageIdentityCoverage, null);
  assert.equal(result.history, null);
  assert.equal(result.traffic, null);
  assert.deepEqual(result.warnings, []);
});
