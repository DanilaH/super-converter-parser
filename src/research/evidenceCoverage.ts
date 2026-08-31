import type { CohortHistoryProjection } from '../enrichment/cohortHistory.js';
import type { EntrantCohort } from '../enrichment/entrantCohort.js';
import type { RepresentativeQuerySet } from '../enrichment/representativeQueries.js';
import type { CurrentTrafficEvidenceProjection } from '../enrichment/trafficEvidenceCurrent.js';

export type CoverageFraction = {
  numerator: number;
  denominator: number;
  ratio: number | null;
};

export type DeepEvidenceCoverageWarningCode =
  | 'REPRESENTATIVE_URL_COVERAGE_INCOMPLETE'
  | 'REPRESENTATIVE_URL_COVERAGE_UNAVAILABLE'
  | 'ENTRANT_COHORT_NOT_COLLECTED'
  | 'DR_EVIDENCE_INCOMPLETE'
  | 'PAGE_IDENTITY_COVERAGE_INCOMPLETE'
  | 'COHORT_HISTORY_NOT_COLLECTED'
  | 'COHORT_HISTORY_OMITTED'
  | 'COHORT_HISTORY_UNOBSERVED'
  | 'RDAP_REGISTRATION_COVERAGE_INCOMPLETE'
  | 'RDAP_PROVIDER_ERRORS'
  | 'HISTORICAL_WEB_PRESENCE_COVERAGE_INCOMPLETE'
  | 'FIRST_SEEN_PROVIDER_UNAVAILABLE'
  | 'FIRST_SEEN_PROVIDER_ERRORS'
  | 'TRAFFIC_EVIDENCE_NOT_COLLECTED'
  | 'TRAFFIC_POLICY_MISSING'
  | 'TRAFFIC_STALE_TARGETS'
  | 'TRAFFIC_TARGET_MISMATCH'
  | 'TRAFFIC_DOMAIN_COVERAGE_INCOMPLETE'
  | 'FINALIST_EVIDENCE_NOT_CURRENT';

export type DeepEvidenceCoverageWarning = {
  code: DeepEvidenceCoverageWarningCode;
  affectedCount: number;
  denominator: number | null;
  message: string;
};

export type DeepTrafficEvidenceInput = {
  importedSnapshotCount: number;
  policyAvailable: boolean;
  current: CurrentTrafficEvidenceProjection | null;
};

export type DeepEvidenceCoverage = {
  representativeUrlCoverage: CoverageFraction | null;
  entrantDomainRows: number;
  drKnownCoverage: CoverageFraction | null;
  pageIdentityCoverage: CoverageFraction | null;
  history: {
    checkedCoverage: CoverageFraction;
    registrationKnownCoverage: CoverageFraction;
    firstSeenKnownCoverage: CoverageFraction;
    omittedDomainCount: number;
    unobservedDomainCount: number;
    registrationErrorCount: number;
    firstSeenUnavailableCount: number;
    firstSeenErrorCount: number;
  } | null;
  traffic: {
    importedSnapshotCount: number;
    policyAvailable: boolean;
    currentTargetSnapshotCount: number | null;
    staleTargetSnapshotCount: number | null;
    matchedSnapshotCount: number | null;
    mismatchedSnapshotCount: number | null;
    matchedDomainCoverage: CoverageFraction | null;
  } | null;
  warnings: DeepEvidenceCoverageWarning[];
};

export function projectDeepEvidenceCoverage(input: {
  representatives: RepresentativeQuerySet[] | null;
  cohorts: EntrantCohort[] | null;
  history: CohortHistoryProjection[] | null;
  traffic: DeepTrafficEvidenceInput | null;
  finalistMatrixPublished: boolean;
}): DeepEvidenceCoverage {
  const warnings: DeepEvidenceCoverageWarning[] = [];

  const representativeUrlCoverage = projectRepresentativeUrlCoverage(input.representatives);
  if (input.representatives !== null) {
    const zeroUrlSetCount = input.representatives.filter((set) => set.clusterUrlCount === 0).length;
    if (zeroUrlSetCount > 0) {
      warnings.push({
        code: 'REPRESENTATIVE_URL_COVERAGE_UNAVAILABLE',
        affectedCount: zeroUrlSetCount,
        denominator: input.representatives.length,
        message: `${zeroUrlSetCount}/${input.representatives.length} finalist representative set(s) have no cluster URL identity denominator. Missing URL identity is uncertainty, not zero coverage.`,
      });
    }
    if (
      representativeUrlCoverage !== null
      && representativeUrlCoverage.denominator > 0
      && representativeUrlCoverage.numerator < representativeUrlCoverage.denominator
    ) {
      const missing = representativeUrlCoverage.denominator - representativeUrlCoverage.numerator;
      warnings.push({
        code: 'REPRESENTATIVE_URL_COVERAGE_INCOMPLETE',
        affectedCount: missing,
        denominator: representativeUrlCoverage.denominator,
        message: `${representativeUrlCoverage.numerator}/${representativeUrlCoverage.denominator} finalist cluster URL identities are covered by representative queries; ${missing} remain uncovered.`,
      });
    }
  }

  const entrantDomainRows = input.cohorts === null
    ? 0
    : input.cohorts.reduce((sum, cohort) => sum + cohort.domains.length, 0);
  const drKnownCoverage = input.cohorts === null
    ? null
    : fraction(
        input.cohorts.reduce((sum, cohort) => sum + cohort.summary.knownDrDomainCount, 0),
        entrantDomainRows,
      );
  const pageIdentityCoverage = input.cohorts === null
    ? null
    : fraction(
        input.cohorts.reduce((sum, cohort) => sum + cohort.summary.pageIdentityCoverage.numerator, 0),
        input.cohorts.reduce((sum, cohort) => sum + cohort.summary.pageIdentityCoverage.denominator, 0),
      );

  if (input.representatives !== null && input.representatives.length > 0 && input.cohorts === null) {
    warnings.push({
      code: 'ENTRANT_COHORT_NOT_COLLECTED',
      affectedCount: input.representatives.length,
      denominator: input.representatives.length,
      message: `Entrant cohort evidence is not collected for ${input.representatives.length} finalist representative set(s).`,
    });
  }

  if (drKnownCoverage !== null && drKnownCoverage.numerator < drKnownCoverage.denominator) {
    const missing = drKnownCoverage.denominator - drKnownCoverage.numerator;
    warnings.push({
      code: 'DR_EVIDENCE_INCOMPLETE',
      affectedCount: missing,
      denominator: drKnownCoverage.denominator,
      message: `${drKnownCoverage.numerator}/${drKnownCoverage.denominator} finalist entrant-domain rows have known, non-conflicting DR evidence. Missing/conflicting DR is excluded rather than treated as zero.`,
    });
  }

  if (pageIdentityCoverage !== null && pageIdentityCoverage.numerator < pageIdentityCoverage.denominator) {
    const missing = pageIdentityCoverage.denominator - pageIdentityCoverage.numerator;
    warnings.push({
      code: 'PAGE_IDENTITY_COVERAGE_INCOMPLETE',
      affectedCount: missing,
      denominator: pageIdentityCoverage.denominator,
      message: `${pageIdentityCoverage.numerator}/${pageIdentityCoverage.denominator} entrant ranking occurrences have normalized page identity; ${missing} occurrence(s) remain unknown.`,
    });
  }

  const history = projectHistoryCoverage(input.cohorts, input.history, entrantDomainRows, warnings);
  const traffic = projectTrafficCoverage(input.cohorts, input.traffic, entrantDomainRows, warnings);

  if (
    input.representatives !== null
    && input.representatives.length > 0
    && input.cohorts !== null
    && !input.finalistMatrixPublished
  ) {
    warnings.push({
      code: 'FINALIST_EVIDENCE_NOT_CURRENT',
      affectedCount: input.representatives.length,
      denominator: input.representatives.length,
      message: 'The current finalist evidence matrix is not published for the current representative/entrant generation.',
    });
  }

  return {
    representativeUrlCoverage,
    entrantDomainRows,
    drKnownCoverage,
    pageIdentityCoverage,
    history,
    traffic,
    warnings,
  };
}

function projectRepresentativeUrlCoverage(
  representatives: RepresentativeQuerySet[] | null,
): CoverageFraction | null {
  if (representatives === null) return null;
  return fraction(
    representatives.reduce((sum, set) => sum + set.coveredUrlCount, 0),
    representatives.reduce((sum, set) => sum + set.clusterUrlCount, 0),
  );
}

function projectHistoryCoverage(
  cohorts: EntrantCohort[] | null,
  history: CohortHistoryProjection[] | null,
  entrantDomainRows: number,
  warnings: DeepEvidenceCoverageWarning[],
): DeepEvidenceCoverage['history'] {
  if (cohorts === null) {
    if (history !== null) throw new Error('Cohort history cannot exist without a current entrant cohort');
    return null;
  }
  if (history === null) {
    if (entrantDomainRows > 0) {
      warnings.push({
        code: 'COHORT_HISTORY_NOT_COLLECTED',
        affectedCount: entrantDomainRows,
        denominator: entrantDomainRows,
        message: `Historical evidence is not collected for ${entrantDomainRows} finalist entrant-domain row(s). Absence of history is not evidence that domains are old or established.`,
      });
    }
    return null;
  }

  assertMatchingClusters(cohorts, history);
  const cohortDomainCount = history.reduce((sum, projection) => sum + projection.summary.cohortDomainCount, 0);
  if (cohortDomainCount !== entrantDomainRows) {
    throw new Error(`Cohort history denominator ${cohortDomainCount} does not match current entrant-domain rows ${entrantDomainRows}`);
  }
  const checkedDomainCount = sumHistory(history, 'checkedDomainCount');
  const omittedDomainCount = sumHistory(history, 'omittedDomainCount');
  const unobservedDomainCount = sumHistory(history, 'unobservedDomainCount');
  const registrationKnownDomainCount = sumHistory(history, 'registrationKnownDomainCount');
  const firstSeenKnownDomainCount = sumHistory(history, 'firstSeenKnownDomainCount');
  const registrationErrorCount = sumStatus(history, 'registrationStatusCounts', 'error');
  const firstSeenUnavailableCount = sumStatus(history, 'firstSeenStatusCounts', 'unavailable');
  const firstSeenErrorCount = sumStatus(history, 'firstSeenStatusCounts', 'error');

  if (omittedDomainCount > 0) {
    warnings.push({
      code: 'COHORT_HISTORY_OMITTED',
      affectedCount: omittedDomainCount,
      denominator: cohortDomainCount,
      message: `${omittedDomainCount}/${cohortDomainCount} finalist entrant-domain row(s) were omitted by an explicit history collection cap. Omitted rows are not negative evidence.`,
    });
  }
  if (unobservedDomainCount > 0) {
    warnings.push({
      code: 'COHORT_HISTORY_UNOBSERVED',
      affectedCount: unobservedDomainCount,
      denominator: cohortDomainCount,
      message: `${unobservedDomainCount}/${cohortDomainCount} finalist entrant-domain row(s) have no history checkpoint evidence and remain unobserved.`,
    });
  }
  if (registrationKnownDomainCount < cohortDomainCount) {
    warnings.push({
      code: 'RDAP_REGISTRATION_COVERAGE_INCOMPLETE',
      affectedCount: cohortDomainCount - registrationKnownDomainCount,
      denominator: cohortDomainCount,
      message: `${registrationKnownDomainCount}/${cohortDomainCount} finalist entrant-domain row(s) have known RDAP registration age. Missing/unsupported/error/omitted rows remain unknown, not old.`,
    });
  }
  if (registrationErrorCount > 0) {
    warnings.push({
      code: 'RDAP_PROVIDER_ERRORS',
      affectedCount: registrationErrorCount,
      denominator: cohortDomainCount,
      message: `${registrationErrorCount}/${cohortDomainCount} finalist entrant-domain row(s) have RDAP error status and are excluded from known registration coverage.`,
    });
  }
  if (firstSeenKnownDomainCount < cohortDomainCount) {
    warnings.push({
      code: 'HISTORICAL_WEB_PRESENCE_COVERAGE_INCOMPLETE',
      affectedCount: cohortDomainCount - firstSeenKnownDomainCount,
      denominator: cohortDomainCount,
      message: `${firstSeenKnownDomainCount}/${cohortDomainCount} finalist entrant-domain row(s) have observed web first-seen evidence. Unobserved rows must not be interpreted as established/old.`,
    });
  }
  if (firstSeenUnavailableCount > 0) {
    warnings.push({
      code: 'FIRST_SEEN_PROVIDER_UNAVAILABLE',
      affectedCount: firstSeenUnavailableCount,
      denominator: cohortDomainCount,
      message: `${firstSeenUnavailableCount}/${cohortDomainCount} finalist entrant-domain row(s) have first-seen provider status unavailable.`,
    });
  }
  if (firstSeenErrorCount > 0) {
    warnings.push({
      code: 'FIRST_SEEN_PROVIDER_ERRORS',
      affectedCount: firstSeenErrorCount,
      denominator: cohortDomainCount,
      message: `${firstSeenErrorCount}/${cohortDomainCount} finalist entrant-domain row(s) have first-seen provider error status.`,
    });
  }

  return {
    checkedCoverage: fraction(checkedDomainCount, cohortDomainCount),
    registrationKnownCoverage: fraction(registrationKnownDomainCount, cohortDomainCount),
    firstSeenKnownCoverage: fraction(firstSeenKnownDomainCount, cohortDomainCount),
    omittedDomainCount,
    unobservedDomainCount,
    registrationErrorCount,
    firstSeenUnavailableCount,
    firstSeenErrorCount,
  };
}

function projectTrafficCoverage(
  cohorts: EntrantCohort[] | null,
  traffic: DeepTrafficEvidenceInput | null,
  entrantDomainRows: number,
  warnings: DeepEvidenceCoverageWarning[],
): DeepEvidenceCoverage['traffic'] {
  if (traffic === null) return null;

  let matchedDomainCoverage: CoverageFraction | null = null;
  if (cohorts !== null && entrantDomainRows > 0 && traffic.current !== null) {
    const entrantKeys = new Set<string>();
    for (const cohort of cohorts) {
      for (const domain of cohort.domains) entrantKeys.add(`${cohort.clusterId}\0${domain.registrableDomain}`);
    }
    const matchedDomainKeys = new Set(
      traffic.current.projection.histories
        .filter((history) => history.scope === 'domain')
        .map((history) => `${history.targetClusterId}\0${history.normalizedEntity}`)
        .filter((key) => entrantKeys.has(key)),
    );
    matchedDomainCoverage = fraction(matchedDomainKeys.size, entrantKeys.size);
  }

  if (cohorts !== null && entrantDomainRows > 0 && traffic.importedSnapshotCount === 0) {
    warnings.push({
      code: 'TRAFFIC_EVIDENCE_NOT_COLLECTED',
      affectedCount: entrantDomainRows,
      denominator: entrantDomainRows,
      message: `No traffic snapshots are imported for the ${entrantDomainRows} current finalist entrant-domain row(s). Missing traffic evidence is not zero traffic.`,
    });
  }
  if (traffic.importedSnapshotCount > 0 && !traffic.policyAvailable) {
    warnings.push({
      code: 'TRAFFIC_POLICY_MISSING',
      affectedCount: traffic.importedSnapshotCount,
      denominator: traffic.importedSnapshotCount,
      message: `${traffic.importedSnapshotCount} imported traffic snapshot(s) cannot be projected because the explicit traffic policy is missing.`,
    });
  }
  if (traffic.current !== null) {
    if (traffic.current.staleTargetSnapshotCount > 0) {
      warnings.push({
        code: 'TRAFFIC_STALE_TARGETS',
        affectedCount: traffic.current.staleTargetSnapshotCount,
        denominator: traffic.current.importedSnapshotCount,
        message: `${traffic.current.staleTargetSnapshotCount}/${traffic.current.importedSnapshotCount} imported traffic snapshot(s) target finalist clusters that are no longer current.`,
      });
    }
    if (traffic.current.projection.mismatchedSnapshotCount > 0) {
      warnings.push({
        code: 'TRAFFIC_TARGET_MISMATCH',
        affectedCount: traffic.current.projection.mismatchedSnapshotCount,
        denominator: traffic.current.currentTargetSnapshotCount,
        message: `${traffic.current.projection.mismatchedSnapshotCount}/${traffic.current.currentTargetSnapshotCount} current-target traffic snapshot(s) do not match the current entrant entity/page intent.`,
      });
    }
    if (
      matchedDomainCoverage !== null
      && matchedDomainCoverage.denominator > 0
      && matchedDomainCoverage.numerator < matchedDomainCoverage.denominator
      && traffic.importedSnapshotCount > 0
    ) {
      warnings.push({
        code: 'TRAFFIC_DOMAIN_COVERAGE_INCOMPLETE',
        affectedCount: matchedDomainCoverage.denominator - matchedDomainCoverage.numerator,
        denominator: matchedDomainCoverage.denominator,
        message: `${matchedDomainCoverage.numerator}/${matchedDomainCoverage.denominator} current finalist entrant-domain row(s) have matched domain-scope traffic history. URL-scope evidence is not silently counted as domain coverage.`,
      });
    }
  }

  return {
    importedSnapshotCount: traffic.importedSnapshotCount,
    policyAvailable: traffic.policyAvailable,
    currentTargetSnapshotCount: traffic.current?.currentTargetSnapshotCount ?? null,
    staleTargetSnapshotCount: traffic.current?.staleTargetSnapshotCount ?? null,
    matchedSnapshotCount: traffic.current?.projection.matchedSnapshotCount ?? null,
    mismatchedSnapshotCount: traffic.current?.projection.mismatchedSnapshotCount ?? null,
    matchedDomainCoverage,
  };
}

function assertMatchingClusters(cohorts: EntrantCohort[], history: CohortHistoryProjection[]): void {
  const cohortIds = cohorts.map((cohort) => cohort.clusterId).sort(compareClusterIds);
  const historyIds = history.map((projection) => projection.clusterId).sort(compareClusterIds);
  if (
    cohortIds.length !== historyIds.length
    || cohortIds.some((clusterId, index) => clusterId !== historyIds[index])
  ) {
    throw new Error('Cohort history cluster set does not match the current entrant cohort');
  }
}

function sumHistory(
  history: CohortHistoryProjection[],
  field:
    | 'checkedDomainCount'
    | 'omittedDomainCount'
    | 'unobservedDomainCount'
    | 'registrationKnownDomainCount'
    | 'firstSeenKnownDomainCount',
): number {
  return history.reduce((sum, projection) => sum + projection.summary[field], 0);
}

function sumStatus(
  history: CohortHistoryProjection[],
  field: 'registrationStatusCounts' | 'firstSeenStatusCounts',
  status: string,
): number {
  return history.reduce((sum, projection) => sum + (projection.summary[field][status] ?? 0), 0);
}

function fraction(numerator: number, denominator: number): CoverageFraction {
  if (!Number.isInteger(numerator) || numerator < 0 || !Number.isInteger(denominator) || denominator < 0) {
    throw new Error(`Invalid coverage ${numerator}/${denominator}`);
  }
  if (numerator > denominator) throw new Error(`Coverage numerator ${numerator} exceeds denominator ${denominator}`);
  return { numerator, denominator, ratio: denominator === 0 ? null : numerator / denominator };
}

function compareClusterIds(a: string, b: string): number {
  const aMatch = a.match(/^(.*?)(\d+)$/);
  const bMatch = b.match(/^(.*?)(\d+)$/);
  if (aMatch && bMatch && aMatch[1] === bMatch[1]) {
    const diff = Number(aMatch[2]) - Number(bMatch[2]);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}
