import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { StoredKeyword } from '../db/store.js';
import type { SerpResult } from '../google/serp.js';
import type { DomainAgeRecord } from '../runs/domainAge.js';
import { RUN_QUALITY_VERSION, type RunQuality } from '../runs/runQuality.js';
import {
  CLUSTERING_ALGORITHM_VERSION,
  clusterKeywords,
  type ClusteringConfig,
  type ClusteringInput,
} from './clustering.js';
import {
  COHORT_HISTORY_PROJECTION_VERSION,
  projectCohortHistory,
} from './cohortHistory.js';
import { buildEntrantCohorts } from './entrantCohort.js';
import { buildFinalistEvidenceMatrix } from './finalistEvidence.js';
import {
  selectRepresentativeQueries,
  type RepresentativeQuerySet,
} from './representativeQueries.js';

const FIXTURE_ROOT = new URL('./fixtures/hardware-audio-v1/', import.meta.url);
const OBSERVED_AT = '2026-08-27T19:02:32.658Z';

const CLUSTERING_CONFIG: ClusteringConfig = {
  topN: 10,
  edgeRule: {
    minSharedDomains: 3,
    minJaccard: 0.3,
    minSharedUrls: 2,
    minUrlJaccard: 0.1,
  },
  algorithmVersion: CLUSTERING_ALGORITHM_VERSION,
};

const DR_THRESHOLDS = {
  veryWeakMax: 10,
  weakMax: 30,
  strongMin: 60,
  strongMax: 75,
};

const HISTORY_POLICY = {
  version: COHORT_HISTORY_PROJECTION_VERSION,
  youngDomainMaxAgeDays: 365,
  recentWebPresenceMaxAgeDays: 180,
  repurposeGapMinDays: 1_000,
};

type Observation = {
  keywordIdx: number;
  keyword: string;
  normalizedKeyword: string;
  market: string | null;
  volume: number | null;
  cpc: number | null;
  organicTop10: Array<{
    position: number;
    url: string;
    domain: string;
    dr: number | null;
  }>;
};

type FrozenHistory = {
  domain: string;
  registrationDate: string | null;
  registrationStatus: DomainAgeRecord['registrationStatus'];
  firstSeenDate: string | null;
  firstSeenStatus: DomainAgeRecord['firstSeenStatus'];
  domainAgeDays: number | null;
  omitted: boolean;
  omitReason: string | null;
};

type RunFixture = {
  label: string;
  v1Clustering: {
    observations: Observation[];
    expectedClusters: Array<{
      canonicalKeywordIdx: number;
      memberKeywordIdxs: number[];
    }>;
    selectedDomainHistory: FrozenHistory[];
  };
};

function toClusteringInput(observation: Observation): ClusteringInput {
  const rows = [...observation.organicTop10].sort((a, b) => a.position - b.position);
  return {
    keywordIdx: observation.keywordIdx,
    keyword: observation.keyword,
    normalizedKeyword: observation.normalizedKeyword,
    volume: observation.volume,
    domains: rows.map((row) => row.domain),
    urls: rows.map((row) => row.url),
  };
}

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

function memberUrls(observations: Observation[]): Map<number, string[]> {
  return new Map(observations.map((observation) => [
    observation.keywordIdx,
    [...observation.organicTop10]
      .sort((a, b) => a.position - b.position)
      .map((row) => row.url),
  ]));
}

function selectAllRepresentatives(
  observations: Observation[],
  clustering: ReturnType<typeof clusterKeywords>,
): RepresentativeQuerySet[] {
  const urls = memberUrls(observations);
  return clustering.clusters.map((cluster) => selectRepresentativeQueries({
    cluster,
    pairs: clustering.pairs,
    memberUrls: urls,
  }));
}

function memberSet(cluster: { members: Array<{ keywordIdx: number | null }> }): number[] {
  return cluster.members.map((member) => member.keywordIdx!).sort((a, b) => a - b);
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function findClusterByMembers(
  clustering: ReturnType<typeof clusterKeywords>,
  ids: number[],
) {
  const expected = [...ids].sort((a, b) => a - b);
  return clustering.clusters.find((cluster) => sameIds(memberSet(cluster), expected));
}

function toDomainAgeRecord(record: FrozenHistory): DomainAgeRecord {
  // These provider/provenance fields only satisfy the production DomainAgeRecord
  // adapter shape. PR-10 assertions use only facts actually preserved by the corpus.
  return {
    domain: record.domain,
    registrationDate: record.registrationDate,
    registrationStatus: record.registrationStatus,
    registrationRule: 'frozen_corpus',
    registrationIsRedacted: false,
    registrationFetchedAt: null,
    registrationSource: 'frozen_corpus',
    registrationEvents: [],
    firstSeenDate: record.firstSeenDate,
    firstSeenStatus: record.firstSeenStatus,
    firstSeenSource: null,
    firstSeenFetchedAt: null,
    sourceKeywords: [],
    sourceRanks: [],
    domainAgeDays: record.domainAgeDays,
    observedAt: OBSERVED_AT,
    cacheHit: false,
    cacheStatus: 'none',
    omitted: record.omitted,
    omitReason: record.omitReason,
    fetchedAt: OBSERVED_AT,
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

function toStoredKeyword(observation: Observation): StoredKeyword {
  return {
    idx: observation.keywordIdx,
    id: `fixture-${observation.keywordIdx}`,
    keyword: observation.keyword,
    normalizedKeyword: observation.normalizedKeyword,
    sources: [{ type: 'seed', rowNumbers: [observation.keywordIdx + 1] }],
    status: 'completed',
    surfer: {
      volume: observation.volume,
      cpc: observation.cpc,
      market: observation.market ?? 'unknown',
      fetchedAt: OBSERVED_AT,
    },
    google: null,
    error: null,
    collectedAt: OBSERVED_AT,
    cacheStatus: 'miss',
  };
}

function frozenRunQuality(runId: string, keywordCount: number, domainCount: number): RunQuality {
  return {
    version: RUN_QUALITY_VERSION,
    runId,
    state: 'completed',
    sources: {
      googleSerp: {
        denominator: keywordCount,
        trustworthy: keywordCount,
        coveragePercent: 100,
        statuses: {
          ok: keywordCount,
          empty: 0,
          fetchError: 0,
          parseError: 0,
          notFetched: 0,
          unknown: 0,
        },
      },
      surfer: {
        denominator: keywordCount,
        observed: keywordCount,
        coveragePercent: 100,
        volumeAvailable: keywordCount,
        cpcAvailable: keywordCount,
        statuses: { ok: keywordCount, error: 0, notFetched: 0, unknown: 0 },
      },
      related: {
        denominator: keywordCount,
        successful: 0,
        coveragePercent: 0,
        realRows: 0,
        statuses: { ok: 0, empty: 0, error: 0, notAttempted: keywordCount },
      },
      ahrefs: {
        denominator: domainCount,
        resolved: domainCount,
        resolvedCoveragePercent: 100,
        numeric: domainCount,
        numericCoveragePercent: 100,
        mode: 'optional',
        summaryState: null,
        statuses: { ok: domainCount, notFound: 0, error: 0, notAttempted: 0 },
      },
    },
    geo: {
      grade: 'logical_only',
      targetMarket: 'US',
      googleHl: 'not_preserved',
      googleGl: 'not_preserved',
      detectedKeywords: 0,
      trustworthyDetectedKeywords: 0,
      mismatchKeywords: 0,
      detectedLocations: [],
    },
    bounds: {
      organicSerpTopN: 10,
      relatedExpansion: {
        enabled: null,
        depth: null,
        maxCandidatesPerKeyword: null,
        minOverlap: null,
        minVolume: null,
        selectedRows: 0,
        explicitOmissionCount: null,
        omissionAccounting: 'not_persisted',
      },
    },
    warnings: [{
      code: 'GEO_LOGICAL_ONLY',
      affected: keywordCount,
      denominator: keywordCount,
      message: 'Frozen corpus preserves target market and SERPs, but not detected physical Google locations.',
    }],
  };
}

async function readFixture(file: string): Promise<RunFixture> {
  return JSON.parse(await readFile(new URL(file, FIXTURE_ROOT), 'utf8')) as RunFixture;
}

test('V1 -> V2 cluster changes are limited to one evidence-traceable split', async () => {
  const initial = await readFixture('initial.json');
  const residual = await readFixture('residual-round-3.json');
  const targeted = await readFixture('targeted-round-2.json');
  const runs = [initial, residual, targeted];

  const changes: Array<{ run: string; kind: 'split' | 'merge'; members: number[] }> = [];
  let v1ClusterCount = 0;
  let v2ClusterCount = 0;
  for (const fixture of runs) {
    const v2 = clusterKeywords(fixture.v1Clustering.observations.map(toClusteringInput), CLUSTERING_CONFIG);
    const v1Clusters = fixture.v1Clustering.expectedClusters.map((cluster) =>
      [...cluster.memberKeywordIdxs].sort((a, b) => a - b));
    const v2Clusters = v2.clusters.map(memberSet);
    v1ClusterCount += v1Clusters.length;
    v2ClusterCount += v2Clusters.length;

    for (const v1 of v1Clusters) {
      const owners = new Set(v1.map((member) =>
        v2Clusters.findIndex((cluster) => cluster.includes(member))));
      if (owners.size > 1) changes.push({ run: fixture.label, kind: 'split', members: v1 });
    }
    for (const v2Cluster of v2Clusters) {
      const owners = new Set(v2Cluster.map((member) =>
        v1Clusters.findIndex((cluster) => cluster.includes(member))));
      if (owners.size > 1) changes.push({ run: fixture.label, kind: 'merge', members: v2Cluster });
    }
  }

  assert.equal(v1ClusterCount, 22);
  assert.equal(v2ClusterCount, 23);
  assert.deepEqual(changes, [{
    run: 'initial',
    kind: 'split',
    members: [29, 39],
  }]);

  const initialV2 = clusterKeywords(initial.v1Clustering.observations.map(toClusteringInput), CLUSTERING_CONFIG);
  const rejectedPair = initialV2.pairs.find(
    (pair) => pair.keywordAIdx === 29 && pair.keywordBIdx === 39,
  )!;
  assert.equal(rejectedPair.classification, 'domain_only');
  assert.equal(rejectedPair.domainIntersectionCount, 5);
  assert.equal(rejectedPair.domainUnionCount, 14);
  assert.equal(rejectedPair.urlIntersectionCount, 1);

  const targetedV2 = clusterKeywords(targeted.v1Clustering.observations.map(toClusteringInput), CLUSTERING_CONFIG);
  const retainedPair = targetedV2.pairs.find(
    (pair) => pair.keywordAIdx === 17 && pair.keywordBIdx === 20,
  )!;
  assert.equal(retainedPair.classification, 'strong');
  assert.equal(retainedPair.domainIntersectionCount, 4);
  assert.equal(retainedPair.domainUnionCount, 12);
  assert.equal(retainedPair.urlIntersectionCount, 3);
});

test('V2 representative sets make the split explicit and retain the supported audio pair', async () => {
  const initial = await readFixture('initial.json');
  const targeted = await readFixture('targeted-round-2.json');
  const initialV2 = clusterKeywords(initial.v1Clustering.observations.map(toClusteringInput), CLUSTERING_CONFIG);
  const targetedV2 = clusterKeywords(targeted.v1Clustering.observations.map(toClusteringInput), CLUSTERING_CONFIG);
  const initialSets = selectAllRepresentatives(initial.v1Clustering.observations, initialV2);
  const targetedSets = selectAllRepresentatives(targeted.v1Clustering.observations, targetedV2);

  const splitA = findClusterByMembers(initialV2, [29])!;
  const splitB = findClusterByMembers(initialV2, [39])!;
  assert.deepEqual(
    initialSets.find((set) => set.clusterId === splitA.clusterId)?.representativeKeywordIds,
    [29],
  );
  assert.deepEqual(
    initialSets.find((set) => set.clusterId === splitB.clusterId)?.representativeKeywordIds,
    [39],
  );

  const audio = findClusterByMembers(targetedV2, [17, 20])!;
  const audioSet = targetedSets.find((set) => set.clusterId === audio.clusterId)!;
  assert.deepEqual(audioSet.representativeKeywordIds, [17, 20]);
  assert.deepEqual(
    audioSet.representatives.map((representative) => [representative.keyword, representative.selectionReason]),
    [['speaker test', 'medoid'], ['audio test', 'high_demand']],
  );
  assert.equal(audioSet.clusterUrlCount, 15);
  assert.equal(audioSet.coveredUrlCount, 15);
});

test('V2 audio entrant/history/finalist surface preserves evidence gaps instead of turning them negative', async () => {
  const fixture = await readFixture('targeted-round-2.json');
  const observations = fixture.v1Clustering.observations;
  const clustering = clusterKeywords(observations.map(toClusteringInput), CLUSTERING_CONFIG);
  const audioCluster = findClusterByMembers(clustering, [17, 20])!;
  const representatives = selectRepresentativeQueries({
    cluster: audioCluster,
    pairs: clustering.pairs,
    memberUrls: memberUrls(observations),
  });
  const audioObservations = observations.filter((observation) =>
    representatives.representativeKeywordIds.includes(observation.keywordIdx));
  const cohort = buildEntrantCohorts({
    representativeSets: [representatives],
    serpRows: audioObservations.flatMap(toSerpRows),
    drThresholds: DR_THRESHOLDS,
  })[0]!;

  assert.equal(cohort.summary.uniqueDomainCount, 12);
  assert.equal(cohort.summary.repeatedDomainCount, 4);
  assert.deepEqual(cohort.summary.repeatedDomainCoverage, {
    numerator: 4,
    denominator: 12,
    ratio: 1 / 3,
  });
  assert.equal(cohort.summary.samePageRepeatedDomainCount, 3);
  assert.equal(cohort.summary.differentPageRepeatedDomainCount, 1);

  const history = projectCohortHistory({
    cohorts: [cohort],
    historyRecords: fixture.v1Clustering.selectedDomainHistory.map(toDomainAgeRecord),
    policy: HISTORY_POLICY,
  })[0]!;
  assert.deepEqual(history.summary.checkedCoverage, {
    numerator: 4,
    denominator: 12,
    ratio: 1 / 3,
  });
  assert.equal(history.summary.registrationKnownDomainCount, 3);
  assert.equal(history.summary.youngDomainCount, 0);
  assert.deepEqual(history.summary.youngDomainCoverage, {
    numerator: 0,
    denominator: 3,
    ratio: 0,
  });
  assert.equal(history.summary.firstSeenKnownDomainCount, 0);
  assert.deepEqual(history.summary.recentWebPresenceCoverage, {
    numerator: 0,
    denominator: 0,
    ratio: null,
  });
  assert.equal(history.summary.unobservedDomainCount, 8);

  const matrix = buildFinalistEvidenceMatrix({
    clusters: [audioCluster],
    representativeSets: [representatives],
    sourceKeywords: audioObservations.map(toStoredKeyword),
    cohorts: [cohort],
    history: [history],
    traffic: {
      importedSnapshots: [],
      policyAvailable: false,
      current: null,
    },
    siteStructure: {
      moduleIncluded: false,
      records: [],
    },
    sourceRunQuality: frozenRunQuality('frozen-targeted-round-2', 2, 12),
    currentRepresentativeRevision: 1,
    currentEntrantFingerprint: 'a'.repeat(64),
    decisions: [],
  });
  const finalist = matrix.finalists[0]!;

  assert.deepEqual(finalist.evidence.demand.volumeCoverage, {
    numerator: 2,
    denominator: 2,
    ratio: 1,
  });
  assert.deepEqual(finalist.evidence.demand.volumeDistribution, {
    min: 9_900,
    median: 12_350,
    max: 14_800,
  });
  assert.equal(finalist.evidence.serpAccessibility.entrantDomainCount, 12);
  assert.deepEqual(finalist.evidence.serpAccessibility.weakDomainCoverage, {
    numerator: 2,
    denominator: 12,
    ratio: 1 / 6,
  });
  assert.equal(finalist.evidence.organicTrafficProof.importedSnapshotCount, 0);
  assert.equal(finalist.evidence.organicTrafficProof.projectionAvailable, false);
  assert.equal(finalist.evidence.organicTrafficProof.matchedSnapshotCount, null);
  assert.equal(finalist.evidence.entrantRepeatability.history?.checkedDomainCount, 4);
  assert.equal(finalist.evidence.moat.siteStructureModuleIncluded, false);
  assert.deepEqual(finalist.evidence.monetizationGeography.cpcCoverage, {
    numerator: 2,
    denominator: 2,
    ratio: 1,
  });
  assert.deepEqual(finalist.evidence.monetizationGeography.cpcDistribution, {
    min: 0.54,
    median: 1.51,
    max: 2.48,
  });
  assert.deepEqual(finalist.evidence.monetizationGeography.googleObservationCoverage, {
    numerator: 0,
    denominator: 2,
    ratio: 0,
  });
  assert.equal(finalist.evidence.productFeasibility.automatedAssessment, null);
  assert.deepEqual(finalist.humanDecision, {
    buildDecision: null,
    seoProductRole: null,
    recordedAt: null,
    evidenceCurrent: null,
  });
  assert.ok(finalist.auditFlags.includes('COHORT_HISTORY_INCOMPLETE'));
  assert.ok(finalist.auditFlags.includes('SITE_STRUCTURE_NOT_COLLECTED'));
  assert.ok(finalist.auditFlags.includes('PRODUCT_FEASIBILITY_REQUIRES_HUMAN_REVIEW'));
  assert.ok(finalist.auditFlags.includes('HUMAN_DECISION_UNRECORDED'));
  assert.equal(finalist.auditFlags.includes('TRAFFIC_TARGET_MISMATCH'), false);
});
