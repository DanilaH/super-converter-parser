import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { SerpResult } from '../google/serp.js';
import type { RepresentativeQuerySet } from './representativeQueries.js';
import { buildEntrantCohorts } from './entrantCohort.js';

const FIXTURE = new URL('./fixtures/hardware-audio-v1/targeted-round-2.json', import.meta.url);

const THRESHOLDS = {
  veryWeakMax: 10,
  weakMax: 30,
  strongMin: 60,
  strongMax: 75,
};

type Observation = {
  keywordIdx: number;
  keyword: string;
  normalizedKeyword: string;
  organicTop10: Array<{ position: number; url: string; domain: string; dr: number | null }>;
};

type Fixture = {
  v1Clustering: {
    observations: Observation[];
  };
};

const REPRESENTATIVES: RepresentativeQuerySet = {
  clusterId: 'cluster-4',
  setVersion: '1.0.0',
  representativeKeywordIds: [17, 20],
  representatives: [
    {
      keywordIdx: 17,
      keyword: 'speaker test',
      normalizedKeyword: 'speaker test',
      volume: 9900,
      selectionReason: 'medoid',
      coverageGain: 8,
    },
    {
      keywordIdx: 20,
      keyword: 'audio test',
      normalizedKeyword: 'audio test',
      volume: 14800,
      selectionReason: 'high_demand',
      coverageGain: 7,
    },
  ],
  targetCount: 2,
  clusterUrlCount: 15,
  coveredUrlCount: 15,
  manualOverride: false,
  manualOverrideReason: null,
};

function toSerpRows(observation: Observation): SerpResult[] {
  return observation.organicTop10.map((row) => ({
    keyword: observation.keyword,
    keywordIdx: observation.keywordIdx,
    position: row.position,
    title: `${observation.keyword} ${row.position}`,
    url: row.url,
    hostname: row.domain,
    registrableDomain: row.domain,
    dr: row.dr,
    drStatus: row.dr === null ? null : 'ok',
    drError: null,
    resultType: 'organic',
  }));
}

test('frozen speaker/audio cohort preserves repeated entrants and page-level repetition semantics', async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8')) as Fixture;
  const observations = fixture.v1Clustering.observations.filter(
    (row) => row.keywordIdx === 17 || row.keywordIdx === 20,
  );
  const cohort = buildEntrantCohorts({
    representativeSets: [REPRESENTATIVES],
    serpRows: observations.flatMap(toSerpRows),
    drThresholds: THRESHOLDS,
  })[0]!;

  assert.equal(cohort.summary.observedOccurrenceCount, 18);
  assert.equal(cohort.summary.excludedOccurrenceCount, 0);
  assert.equal(cohort.summary.uniqueDomainCount, 12);
  assert.deepEqual(cohort.summary.pageIdentityCoverage, {
    numerator: 18,
    denominator: 18,
    ratio: 1,
  });
  assert.equal(cohort.summary.knownDrDomainCount, 12);
  assert.equal(cohort.summary.weakDomainCount, 2);
  assert.deepEqual(cohort.summary.weakDomainCoverage, {
    numerator: 2,
    denominator: 12,
    ratio: 1 / 6,
  });
  assert.equal(cohort.summary.repeatedDomainCount, 4);
  assert.deepEqual(cohort.summary.repeatedDomainCoverage, {
    numerator: 4,
    denominator: 12,
    ratio: 1 / 3,
  });
  assert.equal(cohort.summary.samePageRepeatedDomainCount, 3);
  assert.equal(cohort.summary.differentPageRepeatedDomainCount, 1);

  for (const domain of ['onlinemictest.com', 'audiocheck.net', 'soundtest.io']) {
    const evidence = cohort.domains.find((row) => row.registrableDomain === domain);
    assert.equal(evidence?.queryCoverage.numerator, 2, domain);
    assert.equal(evidence?.samePageRepetition.repeatedAcrossQueries, true, domain);
    assert.equal(evidence?.sameDomainDifferentPageRepetition.repeatedAcrossQueries, false, domain);
  }

  const youtube = cohort.domains.find((row) => row.registrableDomain === 'youtube.com')!;
  assert.equal(youtube.bestRank, 2);
  assert.equal(youtube.medianRank, 5.5);
  assert.deepEqual(youtube.queryCoverage, { numerator: 2, denominator: 2, ratio: 1 });
  assert.equal(youtube.samePageRepetition.repeatedAcrossQueries, false);
  assert.equal(youtube.sameDomainDifferentPageRepetition.repeatedAcrossQueries, true);
  assert.equal(youtube.normalizedPageIdentities.length, 4);
});
