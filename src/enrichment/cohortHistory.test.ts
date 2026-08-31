import test from 'node:test';
import assert from 'node:assert/strict';
import type { DomainAgeRecord } from '../runs/domainAge.js';
import type { EntrantCohort } from './entrantCohort.js';
import {
  COHORT_HISTORY_PROJECTION_VERSION,
  projectCohortHistory,
  type CohortHistoryPolicy,
} from './cohortHistory.js';

const POLICY: CohortHistoryPolicy = {
  version: COHORT_HISTORY_PROJECTION_VERSION,
  youngDomainMaxAgeDays: 365,
  recentWebPresenceMaxAgeDays: 365,
  repurposeGapMinDays: 1_000,
};

function cohort(domains: string[]): EntrantCohort {
  return {
    clusterId: 'cluster-1',
    representativeKeywordIds: [1, 2],
    representativeQueryCount: 2,
    version: '1.0.0',
    serpTopN: 10,
    occurrences: [],
    excludedOccurrences: [],
    domains: domains.map((registrableDomain) => ({
      registrableDomain,
      occurrences: [],
      occurrenceCount: 0,
      bestRank: 1,
      medianRank: 1,
      queryIdsPresent: [],
      queryCoverage: { numerator: 0, denominator: 2, ratio: 0 },
      rankingUrls: [],
      normalizedPageIdentities: [],
      pageIdentityCoverage: { numerator: 0, denominator: 0, ratio: 0 },
      samePageRepetition: { repeatedAcrossQueries: false, repeatedPageCount: 0, maxQueriesPerPage: 0 },
      sameDomainDifferentPageRepetition: { repeatedAcrossQueries: false, distinctPageCount: 0 },
      drEvidence: {
        status: 'missing',
        value: null,
        observedValues: [],
        knownOccurrenceCount: 0,
        occurrenceCount: 0,
        isWeak: null,
      },
    })),
    summary: {
      observedOccurrenceCount: 0,
      excludedOccurrenceCount: 0,
      uniqueDomainCount: domains.length,
      pageIdentityCoverage: { numerator: 0, denominator: 0, ratio: null },
      knownDrDomainCount: 0,
      missingDrDomainCount: domains.length,
      conflictingDrDomainCount: 0,
      weakDomainCount: 0,
      weakDomainCoverage: { numerator: 0, denominator: 0, ratio: null },
      repeatedDomainCount: 0,
      repeatedDomainCoverage: { numerator: 0, denominator: domains.length, ratio: domains.length === 0 ? null : 0 },
      samePageRepeatedDomainCount: 0,
      differentPageRepeatedDomainCount: 0,
    },
    warnings: [],
  };
}

function history(input: Partial<DomainAgeRecord> & { domain: string }): DomainAgeRecord {
  return {
    registrationDate: null,
    registrationStatus: 'not_attempted',
    registrationRule: '',
    registrationIsRedacted: false,
    registrationFetchedAt: null,
    registrationSource: 'rdap',
    registrationEvents: [],
    firstSeenDate: null,
    firstSeenStatus: 'not_attempted',
    firstSeenSource: null,
    firstSeenFetchedAt: null,
    sourceKeywords: [],
    sourceRanks: [],
    domainAgeDays: null,
    observedAt: '2026-08-29T00:00:00.000Z',
    cacheHit: false,
    cacheStatus: 'none',
    omitted: false,
    omitReason: null,
    fetchedAt: '2026-08-29T00:00:00.000Z',
    registrationError: null,
    firstSeenError: null,
    firstSeenSourceReason: null,
    registrationHttpStatus: null,
    registrationRequestCount: 0,
    firstSeenHttpStatus: null,
    firstSeenRequestCount: 0,
    error: null,
    ...input,
  };
}

test('history coverage distinguishes checked, omitted and unobserved cohort domains', () => {
  const projection = projectCohortHistory({
    cohorts: [cohort([
      'young.test',
      'repurpose.test',
      'error.test',
      'unsupported.test',
      'omitted.test',
      'unobserved.test',
    ])],
    historyRecords: [
      history({
        domain: 'young.test',
        registrationStatus: 'ok',
        registrationDate: '2026-06-01T00:00:00.000Z',
        domainAgeDays: 89,
        firstSeenStatus: 'ok',
        firstSeenDate: '2026-07-01T00:00:00.000Z',
        firstSeenSource: 'wayback',
      }),
      history({
        domain: 'repurpose.test',
        registrationStatus: 'ok',
        registrationDate: '2020-01-01T00:00:00.000Z',
        domainAgeDays: 2_432,
        firstSeenStatus: 'ok',
        firstSeenDate: '2026-07-01T00:00:00.000Z',
        firstSeenSource: 'wayback',
      }),
      history({
        domain: 'error.test',
        registrationStatus: 'error',
        registrationError: 'rdap_timeout',
        firstSeenStatus: 'unavailable',
        firstSeenSource: 'unconfigured',
        firstSeenSourceReason: 'provider_not_configured',
      }),
      history({
        domain: 'unsupported.test',
        registrationStatus: 'unsupported',
        firstSeenStatus: 'not_found',
        firstSeenSource: 'wayback',
      }),
      history({
        domain: 'omitted.test',
        omitted: true,
        omitReason: 'domain_cap',
      }),
    ],
    policy: POLICY,
  })[0]!;

  assert.deepEqual(projection.summary.checkedCoverage, {
    numerator: 4,
    denominator: 6,
    ratio: 2 / 3,
  });
  assert.equal(projection.summary.omittedDomainCount, 1);
  assert.equal(projection.summary.unobservedDomainCount, 1);

  assert.equal(projection.summary.registrationKnownDomainCount, 2);
  assert.deepEqual(projection.summary.youngDomainCoverage, {
    numerator: 1,
    denominator: 2,
    ratio: 0.5,
  });
  assert.equal(projection.summary.firstSeenKnownDomainCount, 2);
  assert.deepEqual(projection.summary.recentWebPresenceCoverage, {
    numerator: 2,
    denominator: 2,
    ratio: 1,
  });
  assert.equal(projection.summary.comparableHistoryDomainCount, 2);
  assert.deepEqual(projection.summary.possibleHistoryConflictCoverage, {
    numerator: 1,
    denominator: 2,
    ratio: 0.5,
  });

  assert.deepEqual(projection.summary.registrationStatusCounts, {
    ok: 2,
    error: 1,
    unsupported: 1,
    not_attempted: 1,
    unobserved: 1,
  });
  assert.deepEqual(projection.summary.firstSeenStatusCounts, {
    ok: 2,
    unavailable: 1,
    not_found: 1,
    not_attempted: 1,
    unobserved: 1,
  });

  const omitted = projection.domains.find((row) => row.registrableDomain === 'omitted.test')!;
  assert.equal(omitted.coverageStatus, 'omitted');
  assert.equal(omitted.omitReason, 'domain_cap');
  assert.equal(omitted.registration.isYoung, null);
  assert.equal(omitted.firstSeen.isRecent, null);

  const unobserved = projection.domains.find((row) => row.registrableDomain === 'unobserved.test')!;
  assert.equal(unobserved.coverageStatus, 'unobserved');
  assert.equal(unobserved.registration.status, 'unobserved');

  const repurpose = projection.domains.find((row) => row.registrableDomain === 'repurpose.test')!;
  assert.equal(repurpose.registration.isYoung, false);
  assert.equal(repurpose.firstSeen.isRecent, true);
  assert.equal(repurpose.possibleHistoryConflict, true);
  assert.equal(repurpose.historyConflictReason, 'registration_long_before_first_seen');
});

test('first-seen before registration is a chronology conflict rather than a false negative', () => {
  const projection = projectCohortHistory({
    cohorts: [cohort(['chronology.test'])],
    historyRecords: [history({
      domain: 'chronology.test',
      registrationStatus: 'ok',
      registrationDate: '2026-06-01T00:00:00.000Z',
      domainAgeDays: 89,
      firstSeenStatus: 'ok',
      firstSeenDate: '2025-01-01T00:00:00.000Z',
      firstSeenSource: 'wayback',
    })],
    policy: POLICY,
  })[0]!;

  const domain = projection.domains[0]!;
  assert.equal(domain.registrationFirstSeenGapDays !== null && domain.registrationFirstSeenGapDays < 0, true);
  assert.equal(domain.possibleHistoryConflict, true);
  assert.equal(domain.historyConflictReason, 'first_seen_before_registration');
});

test('no known history evidence yields null ratios instead of synthetic zero confidence', () => {
  const projection = projectCohortHistory({
    cohorts: [cohort(['missing.test'])],
    historyRecords: [history({
      domain: 'missing.test',
      registrationStatus: 'not_found',
      firstSeenStatus: 'unavailable',
      firstSeenSource: 'unconfigured',
    })],
    policy: POLICY,
  })[0]!;

  assert.deepEqual(projection.summary.youngDomainCoverage, {
    numerator: 0,
    denominator: 0,
    ratio: null,
  });
  assert.deepEqual(projection.summary.recentWebPresenceCoverage, {
    numerator: 0,
    denominator: 0,
    ratio: null,
  });
  assert.deepEqual(projection.summary.possibleHistoryConflictCoverage, {
    numerator: 0,
    denominator: 0,
    ratio: null,
  });
});

test('projection rejects ok provider states without coherent date evidence', () => {
  assert.throws(
    () => projectCohortHistory({
      cohorts: [cohort(['broken.test'])],
      historyRecords: [history({
        domain: 'broken.test',
        registrationStatus: 'ok',
        registrationDate: null,
        domainAgeDays: null,
      })],
      policy: POLICY,
    }),
    /invalid registration age evidence/,
  );
});

test('history thresholds are explicit versioned policy, not hidden defaults', () => {
  assert.throws(
    () => projectCohortHistory({
      cohorts: [cohort([])],
      historyRecords: [],
      policy: { ...POLICY, version: 'unknown' },
    }),
    /Unsupported cohort history policy version/,
  );
  assert.throws(
    () => projectCohortHistory({
      cohorts: [cohort([])],
      historyRecords: [],
      policy: { ...POLICY, youngDomainMaxAgeDays: -1 },
    }),
    /youngDomainMaxAgeDays must be a non-negative integer/,
  );
});
