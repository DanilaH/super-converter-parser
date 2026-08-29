import type { StoredKeyword } from '../db/store.js';
import type { RunQuality } from '../runs/runQuality.js';
import type { CohortHistoryProjection } from './cohortHistory.js';
import type { EntrantCohort } from './entrantCohort.js';
import type { RepresentativeQuerySet } from './representativeQueries.js';
import type { SiteStructureRecord } from './site_structure/types.js';
import type { CurrentTrafficEvidenceProjection } from './trafficEvidenceCurrent.js';
import type { TrafficSnapshot, TrafficVelocity } from './trafficEvidence.js';
import type { KeywordCluster } from './types.js';

export const FINALIST_EVIDENCE_MATRIX_VERSION = '1.0.0';

export type FinalistBuildDecision = 'build' | 'watch' | 'reject' | 'unknown';

export type FinalistSeoProductRole =
  | 'acquisition_anchor'
  | 'strong_supporting_tool'
  | 'completeness_tool'
  | 'experimental'
  | 'not_applicable';

export type FinalistHumanDecision = {
  clusterId: string;
  buildDecision: FinalistBuildDecision | null;
  seoProductRole: FinalistSeoProductRole | null;
  representativeRevision: number;
  entrantFingerprint: string;
  updatedAt: string;
};

export type EvidenceCoverage = {
  numerator: number;
  denominator: number;
  ratio: number | null;
};

export type EvidenceDistribution = {
  min: number;
  median: number;
  max: number;
};

export type FinalistAuditFlag =
  | 'DEMAND_VOLUME_INCOMPLETE'
  | 'CLUSTER_COHESION_UNAVAILABLE'
  | 'DR_EVIDENCE_INCOMPLETE'
  | 'TRAFFIC_POLICY_MISSING'
  | 'TRAFFIC_TARGET_MISMATCH'
  | 'COHORT_HISTORY_NOT_COLLECTED'
  | 'COHORT_HISTORY_INCOMPLETE'
  | 'SITE_STRUCTURE_NOT_COLLECTED'
  | 'SITE_STRUCTURE_INCOMPLETE'
  | 'MONETIZATION_CPC_INCOMPLETE'
  | 'REPRESENTATIVE_GEO_WARNING'
  | 'PRODUCT_FEASIBILITY_REQUIRES_HUMAN_REVIEW'
  | 'HUMAN_DECISION_UNRECORDED'
  | 'HUMAN_DECISION_STALE';

export type FinalistTrafficEvidenceInput = {
  importedSnapshots: TrafficSnapshot[];
  policyAvailable: boolean;
  current: CurrentTrafficEvidenceProjection | null;
};

export type FinalistSiteStructureInput = {
  moduleIncluded: boolean;
  records: SiteStructureRecord[];
};

export type BuildFinalistEvidenceMatrixInput = {
  clusters: KeywordCluster[];
  representativeSets: RepresentativeQuerySet[];
  sourceKeywords: StoredKeyword[];
  cohorts: EntrantCohort[];
  history: CohortHistoryProjection[] | null;
  traffic: FinalistTrafficEvidenceInput;
  siteStructure: FinalistSiteStructureInput;
  sourceRunQuality: RunQuality;
  currentRepresentativeRevision: number;
  currentEntrantFingerprint: string;
  decisions?: FinalistHumanDecision[];
};

export type FinalistEvidenceMatrix = {
  version: string;
  finalistCount: number;
  sourceRunQuality: RunQuality;
  staleTrafficTargetCount: number;
  staleHumanDecisionCount: number;
  retiredHumanDecisions: FinalistHumanDecision[];
  finalists: FinalistEvidenceRow[];
};

export type FinalistEvidenceRow = {
  clusterId: string;
  canonicalKeyword: string;
  representativeKeywordIds: number[];
  evidence: {
    demand: {
      representativeQueryCount: number;
      volumeCoverage: EvidenceCoverage;
      volumeDistribution: EvidenceDistribution | null;
      representativeQueries: Array<{
        keywordIdx: number;
        keyword: string;
        volume: number | null;
      }>;
    };
    serpAccessibility: {
      clusterMemberCount: number;
      cohesion: KeywordCluster['cohesion'] | null;
      representativeUrlCoverage: EvidenceCoverage;
      entrantDomainCount: number;
      knownDrDomainCount: number;
      missingDrDomainCount: number;
      conflictingDrDomainCount: number;
      weakDomainCoverage: EvidenceCoverage;
      repeatedDomainCoverage: EvidenceCoverage;
      pageIdentityCoverage: EvidenceCoverage;
      warnings: string[];
    };
    organicTrafficProof: {
      importedSnapshotCount: number;
      projectionAvailable: boolean;
      matchedSnapshotCount: number | null;
      mismatchedSnapshotCount: number | null;
      histories: Array<{
        scope: 'domain' | 'url';
        normalizedEntity: string;
        market: string;
        source: string;
        snapshotCount: number;
        effectiveSnapshotCount: number;
        latestSnapshot: {
          providerDataDate: string;
          observedAt: string;
          organicTraffic: number | null;
          trafficValue: number | null;
          trafficValueCurrency: string | null;
        } | null;
        latestVelocity: TrafficVelocity | null;
      }>;
      warnings: string[];
    };
    entrantRepeatability: {
      cohortDomainCount: number;
      repeatedDomainCount: number;
      repeatedDomainCoverage: EvidenceCoverage;
      samePageRepeatedDomainCount: number;
      differentPageRepeatedDomainCount: number;
      survivorshipWarnings: string[];
      history: CohortHistoryProjection['summary'] | null;
    };
    moat: {
      siteStructureModuleIncluded: boolean;
      observedDomainCoverage: EvidenceCoverage;
      observedDomains: Array<{
        domain: string;
        homepageStatus: SiteStructureRecord['homepageStatus'];
        robotsStatus: SiteStructureRecord['robotsStatus'];
        sitemapType: SiteStructureRecord['sitemapType'];
        declaredSitemapCount: number;
        discoveredUrlCount: number;
        sampledUrlCount: number;
        sampledUtilityUrlCount: number;
        sourceBestPosition: number | null;
      }>;
      warnings: string[];
    };
    monetizationGeography: {
      cpcCoverage: EvidenceCoverage;
      cpcDistribution: EvidenceDistribution | null;
      representativeQueries: Array<{
        keywordIdx: number;
        keyword: string;
        cpc: number | null;
        surferMarket: string | null;
        googleHl: string | null;
        googleGl: string | null;
        detectedGoogleLocation: string | null;
        geoWarning: boolean | null;
      }>;
      googleObservationCoverage: EvidenceCoverage;
      detectedLocationCoverage: EvidenceCoverage;
      geoWarningCount: number;
      warnings: string[];
    };
    productFeasibility: {
      automatedAssessment: null;
      warnings: string[];
    };
  };
  humanDecision: {
    buildDecision: FinalistBuildDecision | null;
    seoProductRole: FinalistSeoProductRole | null;
    recordedAt: string | null;
    evidenceCurrent: boolean | null;
  };
  auditFlags: FinalistAuditFlag[];
};

export function buildFinalistEvidenceMatrix(input: BuildFinalistEvidenceMatrixInput): FinalistEvidenceMatrix {
  validateTrafficInput(input.traffic);
  validateSiteStructureInput(input.siteStructure);
  validateCurrentParent(input.currentRepresentativeRevision, input.currentEntrantFingerprint);

  const clusterById = uniqueByCluster(input.clusters, 'cluster');
  const representativeById = uniqueByCluster(input.representativeSets, 'representative set');
  const cohortById = uniqueByCluster(input.cohorts, 'entrant cohort');
  const historyById = input.history === null
    ? null
    : uniqueByCluster(input.history, 'cohort-history projection');
  const decisionById = uniqueDecisions(input.decisions ?? []);
  const keywordByIdx = uniqueKeywords(input.sourceKeywords);
  const siteStructureByDomain = uniqueSiteStructure(input.siteStructure.records);

  const finalistIds = [...representativeById.keys()].sort(compareClusterIds);
  if (finalistIds.length === 0) throw new Error('Finalist evidence matrix requires at least one representative set');
  assertSameClusterSet('cluster', clusterById, finalistIds);
  assertSameClusterSet('entrant cohort', cohortById, finalistIds);
  if (historyById !== null) assertSameClusterSet('cohort-history projection', historyById, finalistIds);

  const finalistIdSet = new Set(finalistIds);
  const retiredHumanDecisions = [...decisionById.values()]
    .filter((decision) => !finalistIdSet.has(decision.clusterId))
    .sort((a, b) => compareClusterIds(a.clusterId, b.clusterId));

  const finalists = finalistIds.map((clusterId) => {
    const cluster = clusterById.get(clusterId)!;
    const representativeSet = representativeById.get(clusterId)!;
    const cohort = cohortById.get(clusterId)!;
    const history = historyById?.get(clusterId) ?? null;
    const persistedDecision = decisionById.get(clusterId) ?? null;
    const decision = persistedDecision !== null
      && (persistedDecision.buildDecision !== null || persistedDecision.seoProductRole !== null)
      ? persistedDecision
      : null;
    validateFinalistParents(cluster, representativeSet, cohort);
    return buildFinalistRow({
      cluster,
      representativeSet,
      cohort,
      history,
      traffic: input.traffic,
      siteStructure: input.siteStructure,
      siteStructureByDomain,
      keywordByIdx,
      decision,
      currentRepresentativeRevision: input.currentRepresentativeRevision,
      currentEntrantFingerprint: input.currentEntrantFingerprint,
    });
  });

  const staleCurrentDecisions = finalists.filter(
    (finalist) => finalist.humanDecision.evidenceCurrent === false,
  ).length;

  return {
    version: FINALIST_EVIDENCE_MATRIX_VERSION,
    finalistCount: finalists.length,
    sourceRunQuality: input.sourceRunQuality,
    staleTrafficTargetCount: input.traffic.current?.staleTargetSnapshotCount ?? countStaleImportedTargets(
      input.traffic.importedSnapshots,
      finalistIdSet,
    ),
    staleHumanDecisionCount: staleCurrentDecisions + retiredHumanDecisions.length,
    retiredHumanDecisions,
    finalists,
  };
}

function buildFinalistRow(input: {
  cluster: KeywordCluster;
  representativeSet: RepresentativeQuerySet;
  cohort: EntrantCohort;
  history: CohortHistoryProjection | null;
  traffic: FinalistTrafficEvidenceInput;
  siteStructure: FinalistSiteStructureInput;
  siteStructureByDomain: ReadonlyMap<string, SiteStructureRecord>;
  keywordByIdx: ReadonlyMap<number, StoredKeyword>;
  decision: FinalistHumanDecision | null;
  currentRepresentativeRevision: number;
  currentEntrantFingerprint: string;
}): FinalistEvidenceRow {
  const representativeKeywords = input.representativeSet.representativeKeywordIds.map((keywordIdx) => {
    const keyword = input.keywordByIdx.get(keywordIdx);
    if (!keyword) throw new Error(`Finalist ${input.cluster.clusterId} references missing source keyword ${keywordIdx}`);
    return keyword;
  });

  const representativeVolumeByIdx = new Map(
    input.representativeSet.representatives.map((row) => [row.keywordIdx, row.volume]),
  );
  const volumes = representativeKeywords
    .map((keyword) => representativeVolumeByIdx.get(keyword.idx) ?? null)
    .filter((value): value is number => value !== null);
  const demand = {
    representativeQueryCount: representativeKeywords.length,
    volumeCoverage: coverage(volumes.length, representativeKeywords.length),
    volumeDistribution: distribution(volumes),
    representativeQueries: representativeKeywords.map((keyword) => ({
      keywordIdx: keyword.idx,
      keyword: keyword.keyword,
      volume: representativeVolumeByIdx.get(keyword.idx) ?? null,
    })),
  };

  const representativeUrlCoverage = coverage(
    input.representativeSet.coveredUrlCount,
    input.representativeSet.clusterUrlCount,
  );
  const serpAccessibility = {
    clusterMemberCount: input.cluster.memberCount,
    cohesion: input.cluster.cohesion ?? null,
    representativeUrlCoverage,
    entrantDomainCount: input.cohort.summary.uniqueDomainCount,
    knownDrDomainCount: input.cohort.summary.knownDrDomainCount,
    missingDrDomainCount: input.cohort.summary.missingDrDomainCount,
    conflictingDrDomainCount: input.cohort.summary.conflictingDrDomainCount,
    weakDomainCoverage: asCoverage(input.cohort.summary.weakDomainCoverage),
    repeatedDomainCoverage: asCoverage(input.cohort.summary.repeatedDomainCoverage),
    pageIdentityCoverage: asCoverage(input.cohort.summary.pageIdentityCoverage),
    warnings: [...input.cohort.warnings],
  };

  const trafficImported = input.traffic.importedSnapshots.filter(
    (snapshot) => snapshot.targetClusterId === input.cluster.clusterId,
  );
  const trafficHistories = input.traffic.current?.projection.histories.filter(
    (history) => history.targetClusterId === input.cluster.clusterId,
  ) ?? [];
  const trafficMismatches = input.traffic.current?.projection.mismatchedSnapshots.filter(
    (snapshot) => snapshot.targetClusterId === input.cluster.clusterId,
  ) ?? [];
  const organicTrafficWarnings = new Set<string>();
  for (const history of trafficHistories) {
    for (const velocity of history.velocities) {
      for (const warning of velocity.warnings) organicTrafficWarnings.add(warning);
    }
  }
  if (!input.traffic.policyAvailable && trafficImported.length > 0) {
    organicTrafficWarnings.add('traffic_policy_unavailable_for_current_projection');
  }
  if (trafficMismatches.length > 0) {
    organicTrafficWarnings.add('current_target_mismatches_excluded_from_velocity');
  }
  const organicTrafficProof = {
    importedSnapshotCount: trafficImported.length,
    projectionAvailable: input.traffic.current !== null,
    matchedSnapshotCount: input.traffic.current === null
      ? null
      : trafficHistories.reduce((sum, history) => sum + history.snapshots.length, 0),
    mismatchedSnapshotCount: input.traffic.current === null ? null : trafficMismatches.length,
    histories: trafficHistories.map((history) => {
      const latest = history.effectiveSnapshots.at(-1) ?? null;
      return {
        scope: history.scope,
        normalizedEntity: history.normalizedEntity,
        market: history.market,
        source: history.source,
        snapshotCount: history.snapshots.length,
        effectiveSnapshotCount: history.effectiveSnapshots.length,
        latestSnapshot: latest === null ? null : {
          providerDataDate: latest.providerDataDate,
          observedAt: latest.observedAt,
          organicTraffic: latest.organicTraffic,
          trafficValue: latest.trafficValue,
          trafficValueCurrency: latest.trafficValueCurrency,
        },
        latestVelocity: history.velocities.at(-1) ?? null,
      };
    }),
    warnings: [...organicTrafficWarnings].sort(),
  };

  const entrantRepeatability = {
    cohortDomainCount: input.cohort.summary.uniqueDomainCount,
    repeatedDomainCount: input.cohort.summary.repeatedDomainCount,
    repeatedDomainCoverage: asCoverage(input.cohort.summary.repeatedDomainCoverage),
    samePageRepeatedDomainCount: input.cohort.summary.samePageRepeatedDomainCount,
    differentPageRepeatedDomainCount: input.cohort.summary.differentPageRepeatedDomainCount,
    survivorshipWarnings: [...input.cohort.warnings],
    history: input.history?.summary ?? null,
  };

  const cohortDomains = new Set(input.cohort.domains.map((domain) => domain.registrableDomain));
  const observedStructure = [...cohortDomains]
    .map((domain) => input.siteStructureByDomain.get(domain) ?? null)
    .filter((record): record is SiteStructureRecord => record !== null)
    .sort((a, b) => a.domain.localeCompare(b.domain));
  const moatWarnings = [
    'Site-structure observations are descriptive competitor facts, not an automated moat verdict.',
  ];
  if (!input.siteStructure.moduleIncluded) {
    moatWarnings.push('Site-structure evidence was not collected for this enrichment.');
  } else if (observedStructure.length < cohortDomains.size) {
    moatWarnings.push(
      `Finalist-scoped site-structure coverage is ${observedStructure.length}/${cohortDomains.size}; unobserved domains are not negative moat evidence.`,
    );
  }
  const moat = {
    siteStructureModuleIncluded: input.siteStructure.moduleIncluded,
    observedDomainCoverage: coverage(observedStructure.length, cohortDomains.size),
    observedDomains: observedStructure.map((record) => ({
      domain: record.domain,
      homepageStatus: record.homepageStatus,
      robotsStatus: record.robotsStatus,
      sitemapType: record.sitemapType,
      declaredSitemapCount: record.declaredSitemapCount,
      discoveredUrlCount: record.discoveredUrlCount,
      sampledUrlCount: record.sampledUrls.length,
      sampledUtilityUrlCount: record.sampledUtilityUrls.length,
      sourceBestPosition: record.sourceBestPosition,
    })),
    warnings: moatWarnings,
  };

  const cpcs = representativeKeywords
    .map((keyword) => keyword.surfer?.cpc ?? null)
    .filter((value): value is number => value !== null);
  const googleObservedCount = representativeKeywords.filter((keyword) => keyword.google !== null).length;
  const detectedLocationCount = representativeKeywords.filter(
    (keyword) => (keyword.google?.detectedLocation ?? '').trim() !== '',
  ).length;
  const geoWarningCount = representativeKeywords.filter((keyword) => keyword.google?.geoWarning === true).length;
  const monetizationWarnings = [
    'CPC and geography are observed signals only; they do not establish monetization viability.',
  ];
  if (geoWarningCount > 0) {
    monetizationWarnings.push(`${geoWarningCount}/${representativeKeywords.length} representative query SERP(s) carry a geo warning.`);
  }
  const monetizationGeography = {
    cpcCoverage: coverage(cpcs.length, representativeKeywords.length),
    cpcDistribution: distribution(cpcs),
    representativeQueries: representativeKeywords.map((keyword) => ({
      keywordIdx: keyword.idx,
      keyword: keyword.keyword,
      cpc: keyword.surfer?.cpc ?? null,
      surferMarket: keyword.surfer?.market ?? null,
      googleHl: keyword.google?.hl ?? null,
      googleGl: keyword.google?.gl ?? null,
      detectedGoogleLocation: keyword.google?.detectedLocation ?? null,
      geoWarning: keyword.google?.geoWarning ?? null,
    })),
    googleObservationCoverage: coverage(googleObservedCount, representativeKeywords.length),
    detectedLocationCoverage: coverage(detectedLocationCount, representativeKeywords.length),
    geoWarningCount,
    warnings: monetizationWarnings,
  };

  const productFeasibility: FinalistEvidenceRow['evidence']['productFeasibility'] = {
    automatedAssessment: null,
    warnings: [
      'Product feasibility is a human-review block; the runner does not infer implementation feasibility from SEO/page proxies.',
    ],
  };

  const decisionEvidenceCurrent = input.decision === null
    ? null
    : input.decision.representativeRevision === input.currentRepresentativeRevision
      && input.decision.entrantFingerprint === input.currentEntrantFingerprint;

  const auditFlags: FinalistAuditFlag[] = [];
  if (demand.volumeCoverage.numerator < demand.volumeCoverage.denominator) {
    auditFlags.push('DEMAND_VOLUME_INCOMPLETE');
  }
  if (input.cluster.cohesion === undefined || input.cluster.cohesion === null) {
    auditFlags.push('CLUSTER_COHESION_UNAVAILABLE');
  }
  if (input.cohort.summary.knownDrDomainCount < input.cohort.summary.uniqueDomainCount) {
    auditFlags.push('DR_EVIDENCE_INCOMPLETE');
  }
  if (!input.traffic.policyAvailable && trafficImported.length > 0) {
    auditFlags.push('TRAFFIC_POLICY_MISSING');
  }
  if (trafficMismatches.length > 0) auditFlags.push('TRAFFIC_TARGET_MISMATCH');
  if (input.history === null) {
    auditFlags.push('COHORT_HISTORY_NOT_COLLECTED');
  } else if (input.history.summary.checkedDomainCount < input.history.summary.cohortDomainCount) {
    auditFlags.push('COHORT_HISTORY_INCOMPLETE');
  }
  if (!input.siteStructure.moduleIncluded) {
    auditFlags.push('SITE_STRUCTURE_NOT_COLLECTED');
  } else if (observedStructure.length < cohortDomains.size) {
    auditFlags.push('SITE_STRUCTURE_INCOMPLETE');
  }
  if (cpcs.length < representativeKeywords.length) auditFlags.push('MONETIZATION_CPC_INCOMPLETE');
  if (geoWarningCount > 0) auditFlags.push('REPRESENTATIVE_GEO_WARNING');
  auditFlags.push('PRODUCT_FEASIBILITY_REQUIRES_HUMAN_REVIEW');
  if (input.decision === null) auditFlags.push('HUMAN_DECISION_UNRECORDED');
  else if (!decisionEvidenceCurrent) auditFlags.push('HUMAN_DECISION_STALE');

  return {
    clusterId: input.cluster.clusterId,
    canonicalKeyword: input.cluster.canonicalKeyword,
    representativeKeywordIds: [...input.representativeSet.representativeKeywordIds],
    evidence: {
      demand,
      serpAccessibility,
      organicTrafficProof,
      entrantRepeatability,
      moat,
      monetizationGeography,
      productFeasibility,
    },
    humanDecision: {
      buildDecision: input.decision?.buildDecision ?? null,
      seoProductRole: input.decision?.seoProductRole ?? null,
      recordedAt: input.decision?.updatedAt ?? null,
      evidenceCurrent: decisionEvidenceCurrent,
    },
    auditFlags,
  };
}

function validateFinalistParents(
  cluster: KeywordCluster,
  representativeSet: RepresentativeQuerySet,
  cohort: EntrantCohort,
): void {
  if (cluster.clusterId !== representativeSet.clusterId || cluster.clusterId !== cohort.clusterId) {
    throw new Error(`Finalist parent mismatch for ${cluster.clusterId}`);
  }
  if (!sameNumberArray(representativeSet.representativeKeywordIds, cohort.representativeKeywordIds)) {
    throw new Error(`Finalist ${cluster.clusterId} representative ids do not match entrant cohort parent`);
  }
}

function validateTrafficInput(input: FinalistTrafficEvidenceInput): void {
  if (input.current !== null && !input.policyAvailable) {
    throw new Error('Current traffic projection cannot exist without a persisted traffic policy');
  }
  if (input.current !== null && input.current.importedSnapshotCount !== input.importedSnapshots.length) {
    throw new Error('Current traffic projection import count does not match imported traffic facts');
  }
}

function validateSiteStructureInput(input: FinalistSiteStructureInput): void {
  if (!input.moduleIncluded && input.records.length > 0) {
    throw new Error('Site-structure records cannot be supplied when the module was not included');
  }
}

function validateCurrentParent(representativeRevision: number, entrantFingerprint: string): void {
  if (!Number.isInteger(representativeRevision) || representativeRevision < 1) {
    throw new Error(`Invalid current representative revision ${representativeRevision}`);
  }
  if (!/^[a-f0-9]{64}$/.test(entrantFingerprint)) {
    throw new Error('Current entrant fingerprint must be a SHA-256 hex digest');
  }
}

function uniqueByCluster<T extends { clusterId: string }>(rows: T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (result.has(row.clusterId)) throw new Error(`Duplicate ${label} ${row.clusterId}`);
    result.set(row.clusterId, row);
  }
  return result;
}

function uniqueDecisions(rows: FinalistHumanDecision[]): Map<string, FinalistHumanDecision> {
  const result = new Map<string, FinalistHumanDecision>();
  for (const row of rows) {
    const clusterId = row.clusterId.trim();
    if (clusterId === '') throw new Error('Finalist human decision requires clusterId');
    if (result.has(clusterId)) throw new Error(`Duplicate finalist human decision ${clusterId}`);
    validateBuildDecision(row.buildDecision);
    validateSeoProductRole(row.seoProductRole);
    if (!Number.isInteger(row.representativeRevision) || row.representativeRevision < 1) {
      throw new Error(`Finalist human decision ${clusterId} has invalid representative revision`);
    }
    if (!/^[a-f0-9]{64}$/.test(row.entrantFingerprint)) {
      throw new Error(`Finalist human decision ${clusterId} has invalid entrant fingerprint`);
    }
    if (!Number.isFinite(Date.parse(row.updatedAt))) {
      throw new Error(`Finalist human decision ${clusterId} has invalid updatedAt`);
    }
    result.set(clusterId, { ...row, clusterId });
  }
  return result;
}

function validateBuildDecision(value: FinalistBuildDecision | null): void {
  if (value === null) return;
  if (value !== 'build' && value !== 'watch' && value !== 'reject' && value !== 'unknown') {
    throw new Error(`Invalid finalist build decision ${String(value)}`);
  }
}

function validateSeoProductRole(value: FinalistSeoProductRole | null): void {
  if (value === null) return;
  if (
    value !== 'acquisition_anchor'
    && value !== 'strong_supporting_tool'
    && value !== 'completeness_tool'
    && value !== 'experimental'
    && value !== 'not_applicable'
  ) {
    throw new Error(`Invalid finalist SEO/product role ${String(value)}`);
  }
}

function uniqueKeywords(rows: StoredKeyword[]): Map<number, StoredKeyword> {
  const result = new Map<number, StoredKeyword>();
  for (const row of rows) {
    if (result.has(row.idx)) throw new Error(`Duplicate source keyword idx ${row.idx}`);
    result.set(row.idx, row);
  }
  return result;
}

function uniqueSiteStructure(rows: SiteStructureRecord[]): Map<string, SiteStructureRecord> {
  const result = new Map<string, SiteStructureRecord>();
  for (const row of rows) {
    if (result.has(row.domain)) throw new Error(`Duplicate site-structure domain ${row.domain}`);
    result.set(row.domain, row);
  }
  return result;
}

function assertSameClusterSet<T>(label: string, rows: ReadonlyMap<string, T>, finalistIds: string[]): void {
  if (rows.size !== finalistIds.length) {
    throw new Error(`${label} count ${rows.size} does not match finalist count ${finalistIds.length}`);
  }
  for (const clusterId of finalistIds) {
    if (!rows.has(clusterId)) throw new Error(`${label} is missing finalist ${clusterId}`);
  }
}

function coverage(numerator: number, denominator: number): EvidenceCoverage {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator < 0 || numerator > denominator) {
    throw new Error(`Invalid evidence coverage ${numerator}/${denominator}`);
  }
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
  };
}

function asCoverage(value: { numerator: number; denominator: number; ratio: number | null }): EvidenceCoverage {
  const normalized = coverage(value.numerator, value.denominator);
  if (normalized.ratio !== value.ratio) {
    throw new Error(`Persisted evidence coverage ratio does not match ${value.numerator}/${value.denominator}`);
  }
  return normalized;
}

function distribution(values: number[]): EvidenceDistribution | null {
  if (values.length === 0) return null;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid evidence metric ${value}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { min: sorted[0]!, median, max: sorted.at(-1)! };
}

function sameNumberArray(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function countStaleImportedTargets(snapshots: TrafficSnapshot[], finalistIds: ReadonlySet<string>): number {
  return snapshots.filter((snapshot) => !finalistIds.has(snapshot.targetClusterId)).length;
}

function compareClusterIds(a: string, b: string): number {
  const aMatch = /^cluster-(\d+)$/.exec(a);
  const bMatch = /^cluster-(\d+)$/.exec(b);
  if (aMatch && bMatch) {
    const numeric = Number(aMatch[1]) - Number(bMatch[1]);
    if (numeric !== 0) return numeric;
  }
  return a.localeCompare(b);
}
