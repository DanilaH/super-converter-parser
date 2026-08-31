import test from 'node:test';
import assert from 'node:assert/strict';
import type { CohortHistoricalPresenceState } from '../db/cohortHistoricalPresence.js';
import type { EntrantCohort } from '../enrichment/entrantCohort.js';
import type { FinalistEvidenceMatrix } from '../enrichment/finalistEvidence.js';
import { DEFAULT_HISTORICAL_PRESENCE_CONFIG } from './types.js';
import {
  SAMPLED_HISTORICAL_PRESENCE_SEMANTICS,
  attachSampledHistoricalPresenceToFinalistMatrix,
  projectSampledHistoricalPresenceCoverage,
} from './evidenceProjection.js';

const cohorts = [{
  clusterId: 'cluster-1',
  domains: [
    { registrableDomain: 'a.test' },
    { registrableDomain: 'b.test' },
    { registrableDomain: 'c.test' },
    { registrableDomain: 'd.test' },
  ],
}] as EntrantCohort[];

function state(): CohortHistoricalPresenceState {
  return {
    enrichmentId: 'enr-1',
    sourceRunId: 'run-1',
    entrantRepresentativeRevision: 1,
    entrantFingerprint: 'a'.repeat(64),
    collectionVersion: '1.0.0',
    config: {
      ...DEFAULT_HISTORICAL_PRESENCE_CONFIG,
      domainCap: 3,
    },
    collection: {
      version: '1.0.0',
      domainCap: 3,
      domains: [
        {
          registrableDomain: 'a.test', coverageStatus: 'checked', omitReason: null,
          priority: { bestRank: 1, occurrenceCount: 1, clusterCount: 1 }, cacheStatus: 'miss',
          result: {
            domain: 'a.test', status: 'ok', earliestSampledCaptureAt: '2020-01-01T00:00:00Z',
            earliestSampledCaptureUrl: 'https://a.test/', earliestSampledCaptureHttpStatus: '200',
            earliestMatchedCollectionId: 'CC-1', earliestMatchedCollectionFrom: '2020-01-01T00:00:00Z',
            earliestMatchedCollectionTo: '2020-01-31T00:00:00Z', historyCompleteForSelectedCollections: false,
            selectedCollectionCount: 3, checkedCollectionCount: 2, source: 'common_crawl', sourceReason: 'sampled',
            error: null, fetchedAt: '2026-08-31T00:00:00Z', requestCount: 2, httpStatus: 200,
          },
        },
        {
          registrableDomain: 'b.test', coverageStatus: 'checked', omitReason: null,
          priority: { bestRank: 2, occurrenceCount: 1, clusterCount: 1 }, cacheStatus: 'miss',
          result: {
            domain: 'b.test', status: 'not_found', earliestSampledCaptureAt: null,
            earliestSampledCaptureUrl: null, earliestSampledCaptureHttpStatus: null,
            earliestMatchedCollectionId: null, earliestMatchedCollectionFrom: null,
            earliestMatchedCollectionTo: null, historyCompleteForSelectedCollections: true,
            selectedCollectionCount: 3, checkedCollectionCount: 3, source: 'common_crawl',
            sourceReason: 'No capture observed; not proof of absence.', error: null,
            fetchedAt: '2026-08-31T00:00:00Z', requestCount: 3, httpStatus: 404,
          },
        },
        {
          registrableDomain: 'c.test', coverageStatus: 'checked', omitReason: null,
          priority: { bestRank: 3, occurrenceCount: 1, clusterCount: 1 }, cacheStatus: 'miss',
          result: {
            domain: 'c.test', status: 'unavailable', earliestSampledCaptureAt: null,
            earliestSampledCaptureUrl: null, earliestSampledCaptureHttpStatus: null,
            earliestMatchedCollectionId: null, earliestMatchedCollectionFrom: null,
            earliestMatchedCollectionTo: null, historyCompleteForSelectedCollections: false,
            selectedCollectionCount: 3, checkedCollectionCount: 0, source: 'common_crawl', sourceReason: 'circuit open',
            error: null, fetchedAt: '2026-08-31T00:00:00Z', requestCount: 0, httpStatus: null,
          },
        },
        {
          registrableDomain: 'd.test', coverageStatus: 'omitted', omitReason: 'domain_cap',
          priority: { bestRank: 4, occurrenceCount: 1, clusterCount: 1 }, cacheStatus: 'omitted', result: null,
        },
      ],
      summary: {
        uniqueDomainCount: 4, checkedDomainCount: 3, omittedDomainCount: 1,
        knownPresenceDomainCount: 1, notFoundDomainCount: 1, unavailableDomainCount: 1, errorDomainCount: 0,
        completeSelectedHistoryDomainCount: 0, cacheHitCount: 0, networkRequestCount: 5,
        statusCounts: { ok: 1, not_found: 1, unavailable: 1 },
      },
    },
    updatedAt: '2026-08-31T00:01:00Z',
  };
}

test('status projection treats missing collection as uncertainty with unique-domain denominator', () => {
  const projected = projectSampledHistoricalPresenceCoverage({ cohorts, state: null });
  assert.equal(projected?.semantics, SAMPLED_HISTORICAL_PRESENCE_SEMANTICS);
  assert.deepEqual(projected?.checkedCoverage, { numerator: 0, denominator: 4, ratio: 0 });
  assert.deepEqual(projected?.warnings.map((warning) => warning.code), [
    'SAMPLED_HISTORICAL_PRESENCE_NOT_COLLECTED',
  ]);
});

test('status projection separates cap omissions, unavailable provider and incomplete selected history', () => {
  const projected = projectSampledHistoricalPresenceCoverage({ cohorts, state: state() });
  assert.deepEqual(projected?.checkedCoverage, { numerator: 3, denominator: 4, ratio: 0.75 });
  assert.deepEqual(projected?.observedPresenceCoverage, { numerator: 1, denominator: 4, ratio: 0.25 });
  assert.equal(projected?.notFoundDomainCount, 1);
  assert.equal(projected?.incompleteSelectedHistoryDomainCount, 1);
  assert.deepEqual(projected?.warnings.map((warning) => warning.code), [
    'SAMPLED_HISTORICAL_PRESENCE_OMITTED',
    'SAMPLED_HISTORICAL_PRESENCE_PROVIDER_UNAVAILABLE',
    'SAMPLED_HISTORICAL_PRESENCE_SELECTED_HISTORY_INCOMPLETE',
  ]);
});

test('not_found stays an observed provider outcome and is not converted into an absence warning', () => {
  const projected = projectSampledHistoricalPresenceCoverage({ cohorts, state: state() });
  assert.equal(projected?.notFoundDomainCount, 1);
  assert.equal(projected?.warnings.some((warning) => warning.message.includes('proof of absence')), false);
});

test('finalist projection adds a separate sampled-history block without replacing existing cohort history', () => {
  const matrix = {
    version: '1.0.0', finalistCount: 1, sourceRunQuality: {}, staleTrafficTargetCount: 0,
    staleHumanDecisionCount: 0, retiredHumanDecisions: [],
    finalists: [{
      clusterId: 'cluster-1', canonicalKeyword: 'x', representativeKeywordIds: [1],
      evidence: {
        entrantRepeatability: { history: { preserved: true } },
      },
      humanDecision: {}, auditFlags: [],
    }],
  } as unknown as FinalistEvidenceMatrix;
  const projected = attachSampledHistoricalPresenceToFinalistMatrix({ matrix, cohorts, state: state() });
  const finalist = projected.finalists[0]!;
  assert.deepEqual((finalist.evidence.entrantRepeatability.history as unknown as { preserved: boolean }).preserved, true);
  assert.equal(finalist.evidence.sampledHistoricalPresence.semantics, SAMPLED_HISTORICAL_PRESENCE_SEMANTICS);
  assert.equal(finalist.evidence.sampledHistoricalPresence.observedPresenceCount, 1);
  assert.equal(finalist.evidence.sampledHistoricalPresence.notFoundCount, 1);
  assert.equal(finalist.evidence.sampledHistoricalPresence.omittedDomainCount, 1);
  assert.equal(finalist.evidence.sampledHistoricalPresence.warnings.some((warning) => warning.includes('not proof of absence')), true);
});
