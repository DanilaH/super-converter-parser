import test from 'node:test';
import assert from 'node:assert/strict';
import type { SerpResult } from '../google/serp.js';
import { buildEntrantCohorts } from './entrantCohort.js';
import type { RepresentativeQuerySet } from './representativeQueries.js';
import { summarizeEntrantCohorts } from './entrantCohortSummary.js';

const THRESHOLDS = { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 };

function representativeSet(clusterId: string, keywordIds: number[]): RepresentativeQuerySet {
  return {
    clusterId,
    setVersion: '1.0.0',
    representativeKeywordIds: keywordIds,
    representatives: keywordIds.map((keywordIdx, index) => ({
      keywordIdx,
      keyword: `q${keywordIdx}`,
      normalizedKeyword: `q${keywordIdx}`,
      volume: null,
      selectionReason: index === 0 ? 'medoid' : 'coverage_expansion',
      coverageGain: 1,
    })),
    targetCount: keywordIds.length,
    clusterUrlCount: keywordIds.length,
    coveredUrlCount: keywordIds.length,
    manualOverride: false,
    manualOverrideReason: null,
  };
}

function serp(keywordIdx: number, position: number, domain: string, dr: number | null): SerpResult {
  return {
    keyword: `q${keywordIdx}`,
    keywordIdx,
    position,
    title: domain,
    url: `https://${domain}/${keywordIdx}/${position}`,
    hostname: domain,
    registrableDomain: domain,
    dr,
    drStatus: dr === null ? null : 'ok',
    drError: null,
    resultType: 'organic',
  };
}

test('aggregate summary separates occurrences, cluster memberships and global domains', () => {
  const cohorts = buildEntrantCohorts({
    representativeSets: [
      representativeSet('cluster-1', [1, 2]),
      representativeSet('cluster-2', [3]),
    ],
    serpRows: [
      serp(1, 1, 'shared.test', 20),
      serp(2, 2, 'shared.test', 20),
      serp(1, 3, 'only-a.test', 70),
      serp(3, 1, 'shared.test', 20),
      serp(3, 2, 'only-b.test', null),
    ],
    drThresholds: THRESHOLDS,
  });

  assert.deepEqual(summarizeEntrantCohorts(cohorts), {
    finalistClusterCount: 2,
    rankingOccurrenceCount: 5,
    excludedRankingOccurrenceCount: 0,
    clusterDomainMembershipCount: 4,
    globalUniqueDomainCount: 3,
    crossClusterDomainCount: 1,
    knownDrDomainMembershipCount: 3,
    weakDomainMembershipCount: 2,
    withinClusterRepeatedDomainMembershipCount: 1,
  });
});
