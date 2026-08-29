import test from 'node:test';
import assert from 'node:assert/strict';
import type { DomainAgeRecord } from '../runs/domainAge.js';
import type { EntrantCohort } from './entrantCohort.js';
import {
  COHORT_HISTORY_PROJECTION_VERSION,
  projectCohortHistory,
} from './cohortHistory.js';

function history(domain: string): DomainAgeRecord {
  return {
    domain,
    registrationDate: null,
    registrationStatus: 'not_found',
    registrationRule: '',
    registrationIsRedacted: false,
    registrationFetchedAt: '2026-08-29T00:00:00.000Z',
    registrationSource: 'rdap',
    registrationEvents: [],
    firstSeenDate: null,
    firstSeenStatus: 'unavailable',
    firstSeenSource: 'unconfigured',
    firstSeenFetchedAt: '2026-08-29T00:00:00.000Z',
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
    firstSeenSourceReason: 'provider_not_configured',
    registrationHttpStatus: 404,
    registrationRequestCount: 1,
    firstSeenHttpStatus: null,
    firstSeenRequestCount: 0,
    error: null,
  };
}

test('30 checked of 47 is reported as 30/47 with omitted and unobserved separated', () => {
  const domains = Array.from({ length: 47 }, (_, index) => `domain-${index + 1}.test`);
  const cohort = {
    clusterId: 'cluster-1',
    domains: domains.map((registrableDomain) => ({ registrableDomain })),
  } as unknown as EntrantCohort;
  const historyRecords = domains.slice(0, 30).map(history);
  const omittedDomains = new Map(
    domains.slice(30, 40).map((domain) => [domain, 'domain_cap'] as const),
  );

  const projection = projectCohortHistory({
    cohorts: [cohort],
    historyRecords,
    omittedDomains,
    policy: {
      version: COHORT_HISTORY_PROJECTION_VERSION,
      youngDomainMaxAgeDays: 365,
      recentWebPresenceMaxAgeDays: 365,
      repurposeGapMinDays: 1_000,
    },
  })[0]!;

  assert.deepEqual(projection.summary.checkedCoverage, {
    numerator: 30,
    denominator: 47,
    ratio: 30 / 47,
  });
  assert.equal(projection.summary.checkedDomainCount, 30);
  assert.equal(projection.summary.omittedDomainCount, 10);
  assert.equal(projection.summary.unobservedDomainCount, 7);
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
});
