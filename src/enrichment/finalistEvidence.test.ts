import test from 'node:test';
import assert from 'node:assert/strict';
import type { StoredKeyword } from '../db/store.js';
import { RUN_QUALITY_VERSION, type RunQuality } from '../runs/runQuality.js';
import type { EntrantCohort } from './entrantCohort.js';
import {
  buildFinalistEvidenceMatrix,
  type FinalistHumanDecision,
} from './finalistEvidence.js';
import type { RepresentativeQuerySet } from './representativeQueries.js';
import type { KeywordCluster } from './types.js';

const CURRENT_REVISION = 2;
const CURRENT_FINGERPRINT = 'a'.repeat(64);
const DECISION_UPDATED_AT = '2026-08-29T12:00:00.000Z';

function cluster(clusterId = 'cluster-1'): KeywordCluster {
  return {
    clusterId,
    canonicalKeywordIdx: 1,
    canonicalKeyword: 'speaker test',
    members: [
      { keywordIdx: 1, keyword: 'speaker test', normalizedKeyword: 'speaker test', volume: 100, serpSize: 10 },
      { keywordIdx: 2, keyword: 'audio test', normalizedKeyword: 'audio test', volume: null, serpSize: 10 },
    ],
    representativeDomains: ['example.test'],
    medianVolume: 100,
    averageVolume: 100,
    memberCount: 2,
    cohesion: {
      pairCount: 1,
      urlJaccard: { min: 0.25, median: 0.25, mean: 0.25 },
      domainJaccard: { min: 0.5, median: 0.5, mean: 0.5 },
    },
  };
}

function representativeSet(clusterId = 'cluster-1'): RepresentativeQuerySet {
  return {
    clusterId,
    setVersion: '1.0.0',
    representativeKeywordIds: [1, 2],
    representatives: [
      {
        keywordIdx: 1,
        keyword: 'speaker test',
        normalizedKeyword: 'speaker test',
        volume: 100,
        selectionReason: 'medoid',
        coverageGain: 5,
      },
      {
        keywordIdx: 2,
        keyword: 'audio test',
        normalizedKeyword: 'audio test',
        volume: null,
        selectionReason: 'coverage_expansion',
        coverageGain: 3,
      },
    ],
    targetCount: 2,
    clusterUrlCount: 10,
    coveredUrlCount: 8,
    manualOverride: false,
    manualOverrideReason: null,
  };
}

function cohort(clusterId = 'cluster-1'): EntrantCohort {
  const occurrence = {
    keywordIdx: 1,
    position: 2,
    rankingUrl: 'https://example.test/tool',
    registrableDomain: 'example.test',
    normalizedPageIdentity: 'example.test/tool',
    dr: 20,
  };
  return {
    clusterId,
    representativeKeywordIds: [1, 2],
    representativeQueryCount: 2,
    version: '1.0.0',
    serpTopN: 10,
    occurrences: [occurrence],
    excludedOccurrences: [],
    domains: [{
      registrableDomain: 'example.test',
      occurrences: [occurrence],
      occurrenceCount: 1,
      bestRank: 2,
      medianRank: 2,
      queryIdsPresent: [1],
      queryCoverage: { numerator: 1, denominator: 2, ratio: 0.5 },
      rankingUrls: ['https://example.test/tool'],
      normalizedPageIdentities: ['example.test/tool'],
      pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      samePageRepetition: { repeatedAcrossQueries: false, repeatedPageCount: 0, maxQueriesPerPage: 1 },
      sameDomainDifferentPageRepetition: { repeatedAcrossQueries: false, distinctPageCount: 1 },
      drEvidence: {
        status: 'known',
        value: 20,
        observedValues: [20],
        knownOccurrenceCount: 1,
        occurrenceCount: 1,
        isWeak: true,
      },
    }],
    summary: {
      observedOccurrenceCount: 1,
      excludedOccurrenceCount: 0,
      uniqueDomainCount: 1,
      pageIdentityCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      knownDrDomainCount: 1,
      missingDrDomainCount: 0,
      conflictingDrDomainCount: 0,
      weakDomainCount: 1,
      weakDomainCoverage: { numerator: 1, denominator: 1, ratio: 1 },
      repeatedDomainCount: 0,
      repeatedDomainCoverage: { numerator: 0, denominator: 1, ratio: 0 },
      samePageRepeatedDomainCount: 0,
      differentPageRepeatedDomainCount: 0,
    },
    warnings: ['survivorship warning'],
  };
}

function keyword(
  idx: number,
  overrides: Partial<StoredKeyword> = {},
): StoredKeyword {
  return {
    idx,
    id: `kw-${idx}`,
    keyword: idx === 1 ? 'speaker test' : 'audio test',
    normalizedKeyword: idx === 1 ? 'speaker test' : 'audio test',
    sources: [{ type: 'seed', rowNumbers: [idx] }],
    status: 'completed',
    surfer: idx === 1
      ? { volume: 100, cpc: 1.5, market: 'United States', fetchedAt: '2026-08-01T00:00:00.000Z' }
      : { volume: null, cpc: null, market: 'United States', fetchedAt: '2026-08-01T00:00:00.000Z' },
    google: idx === 1
      ? {
          hl: 'en',
          gl: 'us',
          pageUrl: 'https://www.google.com/search?q=speaker+test',
          detectedLocation: 'United States',
          geoWarning: false,
          serpStatus: 'ok',
          serpError: null,
        }
      : {
          hl: 'en',
          gl: 'us',
          pageUrl: 'https://www.google.com/search?q=audio+test',
          detectedLocation: null,
          geoWarning: true,
          serpStatus: 'ok',
          serpError: null,
        },
    error: null,
    collectedAt: '2026-08-01T00:00:00.000Z',
    cacheStatus: 'miss',
    ...overrides,
  };
}

function runQuality(): RunQuality {
  return {
    version: RUN_QUALITY_VERSION,
    runId: 'run-1',
    state: 'completed',
    sources: {
      googleSerp: {
        denominator: 2,
        trustworthy: 2,
        coveragePercent: 100,
        statuses: { ok: 2, empty: 0, fetchError: 0, parseError: 0, notFetched: 0, unknown: 0 },
      },
      surfer: {
        denominator: 2,
        observed: 2,
        coveragePercent: 100,
        volumeAvailable: 1,
        cpcAvailable: 1,
        statuses: { ok: 2, error: 0, notFetched: 0, unknown: 0 },
      },
      related: {
        denominator: 2,
        successful: 2,
        coveragePercent: 100,
        realRows: 0,
        statuses: { ok: 0, empty: 2, error: 0, notAttempted: 0 },
      },
      ahrefs: {
        denominator: 1,
        resolved: 1,
        resolvedCoveragePercent: 100,
        numeric: 1,
        numericCoveragePercent: 100,
        mode: 'optional',
        summaryState: null,
        statuses: { ok: 1, notFound: 0, error: 0, notAttempted: 0 },
      },
    },
    geo: {
      grade: 'logical_only',
      targetMarket: 'United States',
      googleHl: 'en',
      googleGl: 'us',
      detectedKeywords: 1,
      trustworthyDetectedKeywords: 1,
      mismatchKeywords: 1,
      detectedLocations: ['United States'],
    },
    bounds: {
      organicSerpTopN: 10,
      relatedExpansion: {
        enabled: false,
        depth: 0,
        maxCandidatesPerKeyword: 0,
        minOverlap: 0,
        minVolume: 0,
        selectedRows: 0,
        explicitOmissionCount: null,
        omissionAccounting: 'not_persisted',
      },
    },
    warnings: [],
  };
}

function decision(
  overrides: Partial<FinalistHumanDecision> = {},
): FinalistHumanDecision {
  return {
    clusterId: 'cluster-1',
    buildDecision: 'watch',
    seoProductRole: 'experimental',
    representativeRevision: CURRENT_REVISION,
    entrantFingerprint: CURRENT_FINGERPRINT,
    updatedAt: DECISION_UPDATED_AT,
    ...overrides,
  };
}

function build(decisions: FinalistHumanDecision[] = []) {
  return buildFinalistEvidenceMatrix({
    clusters: [cluster()],
    representativeSets: [representativeSet()],
    sourceKeywords: [keyword(1), keyword(2)],
    cohorts: [cohort()],
    history: null,
    traffic: {
      importedSnapshots: [],
      policyAvailable: false,
      current: null,
    },
    siteStructure: {
      moduleIncluded: false,
      records: [],
    },
    sourceRunQuality: runQuality(),
    currentRepresentativeRevision: CURRENT_REVISION,
    currentEntrantFingerprint: CURRENT_FINGERPRINT,
    decisions,
  });
}

test('projects independent evidence blocks without summing representative demand', () => {
  const matrix = build();
  const row = matrix.finalists[0]!;

  assert.equal(matrix.finalistCount, 1);
  assert.deepEqual(row.evidence.demand.volumeCoverage, { numerator: 1, denominator: 2, ratio: 0.5 });
  assert.deepEqual(row.evidence.demand.volumeDistribution, { min: 100, median: 100, max: 100 });
  assert.deepEqual(
    row.evidence.demand.representativeQueries.map((query) => query.volume),
    [100, null],
  );
  assert.equal('score' in row, false);
  assert.equal('score' in row.evidence.demand, false);
});

test('keeps missing evidence visible instead of converting it to negative evidence', () => {
  const row = build().finalists[0]!;

  assert.equal(row.evidence.entrantRepeatability.history, null);
  assert.equal(row.evidence.organicTrafficProof.importedSnapshotCount, 0);
  assert.equal(row.evidence.organicTrafficProof.projectionAvailable, false);
  assert.equal(row.evidence.organicTrafficProof.matchedSnapshotCount, null);
  assert.deepEqual(row.evidence.moat.observedDomainCoverage, { numerator: 0, denominator: 1, ratio: 0 });
  assert.equal(row.evidence.moat.siteStructureModuleIncluded, false);
  assert.equal(row.evidence.productFeasibility.automatedAssessment, null);
  assert.ok(row.auditFlags.includes('COHORT_HISTORY_NOT_COLLECTED'));
  assert.ok(row.auditFlags.includes('SITE_STRUCTURE_NOT_COLLECTED'));
  assert.ok(row.auditFlags.includes('PRODUCT_FEASIBILITY_REQUIRES_HUMAN_REVIEW'));
});

test('distinguishes an unrecorded human decision from an explicit unknown decision', () => {
  const unrecorded = build().finalists[0]!;
  const explicitUnknown = build([decision({
    buildDecision: 'unknown',
    seoProductRole: 'experimental',
  })]).finalists[0]!;

  assert.deepEqual(unrecorded.humanDecision, {
    buildDecision: null,
    seoProductRole: null,
    recordedAt: null,
    evidenceCurrent: null,
  });
  assert.ok(unrecorded.auditFlags.includes('HUMAN_DECISION_UNRECORDED'));
  assert.deepEqual(explicitUnknown.humanDecision, {
    buildDecision: 'unknown',
    seoProductRole: 'experimental',
    recordedAt: DECISION_UPDATED_AT,
    evidenceCurrent: true,
  });
  assert.equal(explicitUnknown.auditFlags.includes('HUMAN_DECISION_UNRECORDED'), false);
});

test('marks a human decision stale when its evidence generation changed', () => {
  const matrix = build([decision({ representativeRevision: CURRENT_REVISION - 1 })]);
  const row = matrix.finalists[0]!;

  assert.equal(row.humanDecision.evidenceCurrent, false);
  assert.ok(row.auditFlags.includes('HUMAN_DECISION_STALE'));
  assert.equal(matrix.staleHumanDecisionCount, 1);
});

test('keeps CPC/geography descriptive and exposes representative-level coverage', () => {
  const evidence = build().finalists[0]!.evidence.monetizationGeography;

  assert.deepEqual(evidence.cpcCoverage, { numerator: 1, denominator: 2, ratio: 0.5 });
  assert.deepEqual(evidence.cpcDistribution, { min: 1.5, median: 1.5, max: 1.5 });
  assert.deepEqual(evidence.detectedLocationCoverage, { numerator: 1, denominator: 2, ratio: 0.5 });
  assert.equal(evidence.geoWarningCount, 1);
  assert.ok(evidence.warnings.some((warning) => warning.includes('do not establish monetization viability')));
});

test('sorts finalist rows by numeric cluster id and retains retired decisions separately', () => {
  const first = cluster('cluster-10');
  first.canonicalKeyword = 'ten';
  const firstSet = representativeSet('cluster-10');
  const firstCohort = cohort('cluster-10');
  const second = cluster('cluster-2');
  second.canonicalKeyword = 'two';
  const secondSet = representativeSet('cluster-2');
  const secondCohort = cohort('cluster-2');

  const retired = decision({ clusterId: 'cluster-99' });
  const matrix = buildFinalistEvidenceMatrix({
    clusters: [first, second],
    representativeSets: [firstSet, secondSet],
    sourceKeywords: [keyword(1), keyword(2)],
    cohorts: [firstCohort, secondCohort],
    history: null,
    traffic: { importedSnapshots: [], policyAvailable: false, current: null },
    siteStructure: { moduleIncluded: false, records: [] },
    sourceRunQuality: runQuality(),
    currentRepresentativeRevision: CURRENT_REVISION,
    currentEntrantFingerprint: CURRENT_FINGERPRINT,
    decisions: [retired],
  });

  assert.deepEqual(matrix.finalists.map((row) => row.clusterId), ['cluster-2', 'cluster-10']);
  assert.deepEqual(matrix.retiredHumanDecisions, [retired]);
  assert.equal(matrix.staleHumanDecisionCount, 1);
});
