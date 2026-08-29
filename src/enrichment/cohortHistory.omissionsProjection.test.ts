import test from 'node:test';
import assert from 'node:assert/strict';
import type { DomainAgeRecord } from '../runs/domainAge.js';
import type { EntrantCohort } from './entrantCohort.js';
import {
  COHORT_HISTORY_PROJECTION_VERSION,
  projectCohortHistory,
} from './cohortHistory.js';

function cohort(domain: string): EntrantCohort {
  return {
    clusterId: 'cluster-1',
    representativeKeywordIds: [1],
    representativeQueryCount: 1,
    version: '1.0.0',
    serpTopN: 10,
    occurrences: [],
    excludedOccurrences: [],
    domains: [{
      registrableDomain: domain,
      occurrences: [],
      occurrenceCount: 0,
      bestRank: 1,
      medianRank: 1,
      queryIdsPresent: [],
      queryCoverage: { numerator: 0, denominator: 1, ratio: 0 },
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
    }],
    summary: {
      observedOccurrenceCount: 0,
      excludedOccurrenceCount: 0,
      uniqueDomainCount: 1,
      pageIdentityCoverage: { numerator: 0, denominator: 0, ratio: null },
      knownDrDomainCount: 0,
      missingDrDomainCount: 1,
      conflictingDrDomainCount: 0,
      weakDomainCount: 0,
      weakDomainCoverage: { numerator: 0, denominator: 0, ratio: null },
      repeatedDomainCount: 0,
      repeatedDomainCoverage: { numerator: 0, denominator: 1, ratio: 0 },
      samePageRepeatedDomainCount: 0,
      differentPageRepeatedDomainCount: 0,
    },
    warnings: [],
  };
}

function omittedRecord(domain: string): DomainAgeRecord {
  return {
    domain,
    registrationDate: null,
    registrationStatus: 'not_attempted',
    registrationRule: 'omitted by cap',
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
    omitted: true,
    omitReason: 'domain_cap',
    fetchedAt: '2026-08-29T00:00:00.000Z',
    registrationError: null,
    firstSeenError: null,
    firstSeenSourceReason: null,
    registrationHttpStatus: null,
    registrationRequestCount: 0,
    firstSeenHttpStatus: null,
    firstSeenRequestCount: 0,
    error: null,
  };
}

const policy = {
  version: COHORT_HISTORY_PROJECTION_VERSION,
  youngDomainMaxAgeDays: 365,
  recentWebPresenceMaxAgeDays: 365,
  repurposeGapMinDays: 1_000,
};

test('reconstructed cap omission stays separate from provider history records', () => {
  const projection = projectCohortHistory({
    cohorts: [cohort('omitted.test')],
    historyRecords: [],
    omittedDomains: new Map([['omitted.test', 'domain_cap']]),
    policy,
  })[0]!;

  assert.equal(projection.summary.checkedDomainCount, 0);
  assert.equal(projection.summary.omittedDomainCount, 1);
  assert.equal(projection.summary.unobservedDomainCount, 0);
  assert.deepEqual(projection.summary.checkedCoverage, { numerator: 0, denominator: 1, ratio: 0 });

  const row = projection.domains[0]!;
  assert.equal(row.coverageStatus, 'omitted');
  assert.equal(row.omitReason, 'domain_cap');
  assert.equal(row.registration.status, 'not_attempted');
  assert.equal(row.firstSeen.status, 'not_attempted');
  assert.equal(row.observedAt, null);
});

test('a matching persisted omitted checkpoint and reconstructed cap omission are compatible', () => {
  const projection = projectCohortHistory({
    cohorts: [cohort('omitted.test')],
    historyRecords: [omittedRecord('omitted.test')],
    omittedDomains: new Map([['omitted.test', 'domain_cap']]),
    policy,
  })[0]!;

  assert.equal(projection.summary.omittedDomainCount, 1);
  assert.equal(projection.summary.checkedDomainCount, 0);
  assert.equal(projection.domains[0]?.coverageStatus, 'omitted');
  assert.equal(projection.domains[0]?.omitReason, 'domain_cap');
  assert.equal(projection.domains[0]?.observedAt, '2026-08-29T00:00:00.000Z');
});

test('a domain cannot be both checked and reconstructed as cap-omitted', () => {
  assert.throws(
    () => projectCohortHistory({
      cohorts: [cohort('collision.test')],
      historyRecords: [{
        domain: 'collision.test',
        registrationDate: null,
        registrationStatus: 'not_found',
        registrationRule: '',
        registrationIsRedacted: false,
        registrationFetchedAt: null,
        registrationSource: 'rdap',
        registrationEvents: [],
        firstSeenDate: null,
        firstSeenStatus: 'not_found',
        firstSeenSource: 'wayback',
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
        registrationRequestCount: 1,
        firstSeenHttpStatus: null,
        firstSeenRequestCount: 1,
        error: null,
      }],
      omittedDomains: new Map([['collision.test', 'domain_cap']]),
      policy,
    }),
    /cannot be both persisted history evidence and cap-omitted/,
  );
});
