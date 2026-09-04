import type { EntrantCohort } from './entrantCohort.js';

export type EntrantCohortAggregateSummary = {
  finalistClusterCount: number;
  rankingOccurrenceCount: number;
  excludedRankingOccurrenceCount: number;
  clusterDomainMembershipCount: number;
  globalUniqueDomainCount: number;
  crossClusterDomainCount: number;
  knownDrDomainMembershipCount: number;
  weakDomainMembershipCount: number;
  withinClusterRepeatedDomainMembershipCount: number;
};

/**
 * Aggregate entrant-cohort facts without collapsing distinct units of measure.
 * A domain that appears in two finalist clusters contributes two cluster-domain
 * memberships but only one globally unique domain.
 */
export function summarizeEntrantCohorts(
  cohorts: readonly EntrantCohort[],
): EntrantCohortAggregateSummary {
  const clustersByDomain = new Map<string, Set<string>>();
  let rankingOccurrenceCount = 0;
  let excludedRankingOccurrenceCount = 0;
  let clusterDomainMembershipCount = 0;
  let knownDrDomainMembershipCount = 0;
  let weakDomainMembershipCount = 0;
  let withinClusterRepeatedDomainMembershipCount = 0;

  for (const cohort of cohorts) {
    rankingOccurrenceCount += cohort.occurrences.length;
    excludedRankingOccurrenceCount += cohort.excludedOccurrences.length;

    for (const domain of cohort.domains) {
      clusterDomainMembershipCount += 1;
      if (domain.drEvidence.status === 'known') knownDrDomainMembershipCount += 1;
      if (domain.drEvidence.isWeak === true) weakDomainMembershipCount += 1;
      if (domain.queryCoverage.numerator >= 2) withinClusterRepeatedDomainMembershipCount += 1;

      const clusterIds = clustersByDomain.get(domain.registrableDomain) ?? new Set<string>();
      clusterIds.add(cohort.clusterId);
      clustersByDomain.set(domain.registrableDomain, clusterIds);
    }
  }

  return {
    finalistClusterCount: cohorts.length,
    rankingOccurrenceCount,
    excludedRankingOccurrenceCount,
    clusterDomainMembershipCount,
    globalUniqueDomainCount: clustersByDomain.size,
    crossClusterDomainCount: [...clustersByDomain.values()].filter((clusterIds) => clusterIds.size >= 2).length,
    knownDrDomainMembershipCount,
    weakDomainMembershipCount,
    withinClusterRepeatedDomainMembershipCount,
  };
}
