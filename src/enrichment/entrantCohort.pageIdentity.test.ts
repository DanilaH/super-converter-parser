import test from 'node:test';
import assert from 'node:assert/strict';
import type { SerpResult } from '../google/serp.js';
import type { RepresentativeQuerySet } from './representativeQueries.js';
import { buildEntrantCohorts } from './entrantCohort.js';

const REPRESENTATIVES: RepresentativeQuerySet = {
  clusterId: 'cluster-1',
  setVersion: '1.0.0',
  representativeKeywordIds: [1, 2],
  representatives: [
    {
      keywordIdx: 1,
      keyword: 'q1',
      normalizedKeyword: 'q1',
      volume: 100,
      selectionReason: 'medoid',
      coverageGain: 1,
    },
    {
      keywordIdx: 2,
      keyword: 'q2',
      normalizedKeyword: 'q2',
      volume: 200,
      selectionReason: 'high_demand',
      coverageGain: 1,
    },
  ],
  targetCount: 2,
  clusterUrlCount: 2,
  coveredUrlCount: 2,
  manualOverride: false,
  manualOverrideReason: null,
};

function row(keywordIdx: number, url: string): SerpResult {
  return {
    keyword: `q${keywordIdx}`,
    keywordIdx,
    position: 1,
    title: `result ${keywordIdx}`,
    url,
    hostname: 'example.test',
    registrableDomain: 'example.test',
    dr: 20,
    drStatus: 'ok',
    drError: null,
    resultType: 'organic',
  };
}

test('page repetition exposes incomplete URL-identity coverage instead of implying complete negative evidence', () => {
  const cohort = buildEntrantCohorts({
    representativeSets: [REPRESENTATIVES],
    serpRows: [
      row(1, 'https://example.test/tool'),
      row(2, 'mailto:example@example.test'),
    ],
    drThresholds: {
      veryWeakMax: 10,
      weakMax: 30,
      strongMin: 60,
      strongMax: 75,
    },
  })[0]!;

  const domain = cohort.domains[0]!;
  assert.deepEqual(domain.pageIdentityCoverage, {
    numerator: 1,
    denominator: 2,
    ratio: 0.5,
  });
  assert.equal(domain.samePageRepetition.repeatedAcrossQueries, false);
  assert.equal(domain.sameDomainDifferentPageRepetition.repeatedAcrossQueries, false);
  assert.deepEqual(cohort.summary.pageIdentityCoverage, {
    numerator: 1,
    denominator: 2,
    ratio: 0.5,
  });
});
