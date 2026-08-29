import test from 'node:test';
import assert from 'node:assert/strict';
import type { SerpResult } from '../google/serp.js';
import type { RepresentativeQuerySet } from './representativeQueries.js';
import {
  ENTRANT_COHORT_SERP_TOP_N,
  ENTRANT_SURVIVORSHIP_WARNING,
  buildEntrantCohorts,
} from './entrantCohort.js';

const THRESHOLDS = {
  veryWeakMax: 10,
  weakMax: 30,
  strongMin: 60,
  strongMax: 75,
};

function representativeSet(
  clusterId: string,
  keywordIds: number[],
): RepresentativeQuerySet {
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

function serp(input: {
  keywordIdx: number;
  position: number;
  domain: string;
  url: string;
  dr?: number | null;
}): SerpResult {
  return {
    keyword: `q${input.keywordIdx}`,
    keywordIdx: input.keywordIdx,
    position: input.position,
    title: `result ${input.position}`,
    url: input.url,
    hostname: input.domain || 'unknown.test',
    registrableDomain: input.domain,
    dr: input.dr ?? null,
    drStatus: input.dr === undefined || input.dr === null ? null : 'ok',
    drError: null,
    resultType: 'organic',
  };
}

test('cohort preserves every ranking occurrence while deduplicating domain entities', () => {
  const cohorts = buildEntrantCohorts({
    representativeSets: [representativeSet('cluster-1', [1, 2, 3])],
    serpRows: [
      serp({ keywordIdx: 1, position: 2, domain: 'repeat.test', url: 'https://repeat.test/tool', dr: 20 }),
      serp({ keywordIdx: 2, position: 6, domain: 'repeat.test', url: 'http://www.repeat.test/tool?utm_source=x', dr: 20 }),
      serp({ keywordIdx: 3, position: 4, domain: 'repeat.test', url: 'https://repeat.test/other', dr: 20 }),
      serp({ keywordIdx: 1, position: 1, domain: 'other.test', url: 'https://other.test/a', dr: 65 }),
    ],
    drThresholds: THRESHOLDS,
  });

  const cohort = cohorts[0]!;
  assert.equal(cohort.occurrences.length, 4);
  assert.equal(cohort.domains.length, 2);
  const domain = cohort.domains.find((row) => row.registrableDomain === 'repeat.test')!;
  assert.equal(domain.occurrenceCount, 3);
  assert.equal(domain.bestRank, 2);
  assert.equal(domain.medianRank, 4);
  assert.deepEqual(domain.queryIdsPresent, [1, 2, 3]);
  assert.deepEqual(domain.queryCoverage, { numerator: 3, denominator: 3, ratio: 1 });
  assert.equal(domain.rankingUrls.length, 3);
  assert.equal(domain.normalizedPageIdentities.length, 2);
  assert.deepEqual(domain.samePageRepetition, {
    repeatedAcrossQueries: true,
    repeatedPageCount: 1,
    maxQueriesPerPage: 2,
  });
  assert.deepEqual(domain.sameDomainDifferentPageRepetition, {
    repeatedAcrossQueries: true,
    distinctPageCount: 2,
  });
});

test('query coverage denominator is the full representative set, not observed domain occurrences', () => {
  const cohort = buildEntrantCohorts({
    representativeSets: [representativeSet('cluster-1', [1, 2, 3, 4])],
    serpRows: [
      serp({ keywordIdx: 1, position: 1, domain: 'a.test', url: 'https://a.test/tool', dr: 50 }),
      serp({ keywordIdx: 2, position: 2, domain: 'a.test', url: 'https://a.test/tool', dr: 50 }),
      serp({ keywordIdx: 3, position: 3, domain: 'b.test', url: 'https://b.test/tool', dr: 50 }),
      serp({ keywordIdx: 4, position: 4, domain: 'c.test', url: 'https://c.test/tool', dr: 50 }),
    ],
    drThresholds: THRESHOLDS,
  })[0]!;

  const domain = cohort.domains.find((row) => row.registrableDomain === 'a.test')!;
  assert.deepEqual(domain.queryCoverage, { numerator: 2, denominator: 4, ratio: 0.5 });
});

test('weak-domain counts expose known-DR denominator and never turn missing DR into zero', () => {
  const cohort = buildEntrantCohorts({
    representativeSets: [representativeSet('cluster-1', [1])],
    serpRows: [
      serp({ keywordIdx: 1, position: 1, domain: 'very-weak.test', url: 'https://very-weak.test/', dr: 5 }),
      serp({ keywordIdx: 1, position: 2, domain: 'weak.test', url: 'https://weak.test/', dr: 29 }),
      serp({ keywordIdx: 1, position: 3, domain: 'neutral.test', url: 'https://neutral.test/', dr: 30 }),
      serp({ keywordIdx: 1, position: 4, domain: 'missing.test', url: 'https://missing.test/' }),
    ],
    drThresholds: THRESHOLDS,
  })[0]!;

  assert.equal(cohort.summary.uniqueDomainCount, 4);
  assert.equal(cohort.summary.knownDrDomainCount, 3);
  assert.equal(cohort.summary.missingDrDomainCount, 1);
  assert.equal(cohort.summary.weakDomainCount, 2);
  assert.deepEqual(cohort.summary.weakDomainCoverage, {
    numerator: 2,
    denominator: 3,
    ratio: 2 / 3,
  });
  assert.equal(
    cohort.domains.find((row) => row.registrableDomain === 'missing.test')?.drEvidence.isWeak,
    null,
  );
});

test('conflicting known DR observations are surfaced and excluded from weak denominator', () => {
  const cohort = buildEntrantCohorts({
    representativeSets: [representativeSet('cluster-1', [1, 2])],
    serpRows: [
      serp({ keywordIdx: 1, position: 1, domain: 'conflict.test', url: 'https://conflict.test/a', dr: 10 }),
      serp({ keywordIdx: 2, position: 1, domain: 'conflict.test', url: 'https://conflict.test/b', dr: 40 }),
      serp({ keywordIdx: 1, position: 2, domain: 'known.test', url: 'https://known.test/a', dr: 20 }),
      serp({ keywordIdx: 2, position: 2, domain: 'known.test', url: 'https://known.test/a', dr: 20 }),
    ],
    drThresholds: THRESHOLDS,
  })[0]!;

  const conflict = cohort.domains.find((row) => row.registrableDomain === 'conflict.test')!;
  assert.deepEqual(conflict.drEvidence.observedValues, [10, 40]);
  assert.equal(conflict.drEvidence.status, 'conflict');
  assert.equal(conflict.drEvidence.value, null);
  assert.equal(conflict.drEvidence.isWeak, null);
  assert.equal(cohort.summary.conflictingDrDomainCount, 1);
  assert.equal(cohort.summary.knownDrDomainCount, 1);
  assert.deepEqual(cohort.summary.weakDomainCoverage, { numerator: 1, denominator: 1, ratio: 1 });
});

test('top-10 is applied to raw ranked rows before domain dedupe', () => {
  const rows: SerpResult[] = [];
  for (let position = 1; position <= 11; position += 1) {
    rows.push(serp({
      keywordIdx: 1,
      position,
      domain: position <= 10 ? 'early.test' : 'late.test',
      url: `https://${position <= 10 ? 'early.test' : 'late.test'}/${position}`,
      dr: 20,
    }));
  }
  const cohort = buildEntrantCohorts({
    representativeSets: [representativeSet('cluster-1', [1])],
    serpRows: rows,
    drThresholds: THRESHOLDS,
  })[0]!;

  assert.equal(cohort.serpTopN, ENTRANT_COHORT_SERP_TOP_N);
  assert.equal(cohort.occurrences.length, 10);
  assert.deepEqual(cohort.domains.map((domain) => domain.registrableDomain), ['early.test']);
  assert.equal(cohort.domains[0]?.occurrenceCount, 10);
});

test('uncohortable top-10 row is preserved as an explicit exclusion', () => {
  const cohort = buildEntrantCohorts({
    representativeSets: [representativeSet('cluster-1', [1])],
    serpRows: [
      serp({ keywordIdx: 1, position: 1, domain: '', url: 'https://localhost/tool' }),
      serp({ keywordIdx: 1, position: 2, domain: 'valid.test', url: 'https://valid.test/tool', dr: 40 }),
    ],
    drThresholds: THRESHOLDS,
  })[0]!;

  assert.equal(cohort.summary.observedOccurrenceCount, 1);
  assert.equal(cohort.summary.excludedOccurrenceCount, 1);
  assert.deepEqual(cohort.excludedOccurrences, [{
    keywordIdx: 1,
    position: 1,
    rankingUrl: 'https://localhost/tool',
    reason: 'no_registrable_domain',
  }]);
});

test('cohort always publishes the survivorship limitation', () => {
  const cohort = buildEntrantCohorts({
    representativeSets: [representativeSet('cluster-1', [1])],
    serpRows: [serp({ keywordIdx: 1, position: 1, domain: 'a.test', url: 'https://a.test/' })],
    drThresholds: THRESHOLDS,
  })[0]!;
  assert.deepEqual(cohort.warnings, [ENTRANT_SURVIVORSHIP_WARNING]);
});

test('one representative keyword cannot silently belong to two finalist cohorts', () => {
  assert.throws(
    () => buildEntrantCohorts({
      representativeSets: [
        representativeSet('cluster-1', [1]),
        representativeSet('cluster-2', [1]),
      ],
      serpRows: [serp({ keywordIdx: 1, position: 1, domain: 'a.test', url: 'https://a.test/' })],
      drThresholds: THRESHOLDS,
    }),
    /owned by multiple finalist clusters/,
  );
});
