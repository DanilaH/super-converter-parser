import type { SerpResult } from '../google/serp.js';
import type { ResearchConfig } from '../config/config.js';
import { clusteringUrlIdentity } from './urlIdentity.js';
import type { RepresentativeQuerySet } from './representativeQueries.js';

export const ENTRANT_COHORT_VERSION = '1.0.0';
export const ENTRANT_COHORT_SERP_TOP_N = 10;
export const ENTRANT_SURVIVORSHIP_WARNING =
  'Observed entrant cohorts contain only domains currently visible in representative-query top-10 SERPs; non-ranking attempts and failed entrants are not observed.';

export type EntrantRankingOccurrence = {
  keywordIdx: number;
  position: number;
  rankingUrl: string;
  registrableDomain: string;
  normalizedPageIdentity: string | null;
  dr: number | null;
};

export type EntrantExcludedOccurrence = {
  keywordIdx: number;
  position: number;
  rankingUrl: string;
  reason: 'no_registrable_domain';
};

export type EntrantDomainDrEvidence = {
  status: 'known' | 'missing' | 'conflict';
  value: number | null;
  observedValues: number[];
  knownOccurrenceCount: number;
  occurrenceCount: number;
  isWeak: boolean | null;
};

export type EntrantDomainEvidence = {
  registrableDomain: string;
  occurrences: EntrantRankingOccurrence[];
  occurrenceCount: number;
  bestRank: number;
  medianRank: number;
  queryIdsPresent: number[];
  queryCoverage: {
    numerator: number;
    denominator: number;
    ratio: number;
  };
  rankingUrls: string[];
  normalizedPageIdentities: string[];
  pageIdentityCoverage: {
    numerator: number;
    denominator: number;
    ratio: number;
  };
  samePageRepetition: {
    repeatedAcrossQueries: boolean;
    repeatedPageCount: number;
    maxQueriesPerPage: number;
  };
  sameDomainDifferentPageRepetition: {
    repeatedAcrossQueries: boolean;
    distinctPageCount: number;
  };
  drEvidence: EntrantDomainDrEvidence;
};

export type EntrantCohort = {
  clusterId: string;
  representativeKeywordIds: number[];
  representativeQueryCount: number;
  version: string;
  serpTopN: number;
  occurrences: EntrantRankingOccurrence[];
  excludedOccurrences: EntrantExcludedOccurrence[];
  domains: EntrantDomainEvidence[];
  summary: {
    observedOccurrenceCount: number;
    excludedOccurrenceCount: number;
    uniqueDomainCount: number;
    pageIdentityCoverage: {
      numerator: number;
      denominator: number;
      ratio: number | null;
    };
    knownDrDomainCount: number;
    missingDrDomainCount: number;
    conflictingDrDomainCount: number;
    weakDomainCount: number;
    weakDomainCoverage: {
      numerator: number;
      denominator: number;
      ratio: number | null;
    };
    repeatedDomainCount: number;
    repeatedDomainCoverage: {
      numerator: number;
      denominator: number;
      ratio: number | null;
    };
    samePageRepeatedDomainCount: number;
    differentPageRepeatedDomainCount: number;
  };
  warnings: string[];
};

export type BuildEntrantCohortsInput = {
  representativeSets: RepresentativeQuerySet[];
  serpRows: SerpResult[];
  drThresholds: ResearchConfig['scoring']['drThresholds'];
};

export function buildEntrantCohorts(input: BuildEntrantCohortsInput): EntrantCohort[] {
  validateThresholds(input.drThresholds);
  const clusterIds = new Set<string>();
  const ownedKeyword = new Map<number, string>();
  for (const set of input.representativeSets) {
    if (clusterIds.has(set.clusterId)) {
      throw new Error(`Duplicate representative set for entrant cohort cluster ${set.clusterId}`);
    }
    clusterIds.add(set.clusterId);
    if (set.representativeKeywordIds.length === 0) {
      throw new Error(`Representative set ${set.clusterId} is empty`);
    }
    if (new Set(set.representativeKeywordIds).size !== set.representativeKeywordIds.length) {
      throw new Error(`Representative set ${set.clusterId} contains duplicate keyword ids`);
    }
    for (const keywordIdx of set.representativeKeywordIds) {
      const owner = ownedKeyword.get(keywordIdx);
      if (owner && owner !== set.clusterId) {
        throw new Error(
          `Representative keyword ${keywordIdx} is owned by multiple finalist clusters: ${owner}, ${set.clusterId}`,
        );
      }
      ownedKeyword.set(keywordIdx, set.clusterId);
    }
  }

  const rowsByKeyword = new Map<number, SerpResult[]>();
  for (const row of input.serpRows) {
    if (row.keywordIdx === undefined) continue;
    if (!ownedKeyword.has(row.keywordIdx)) continue;
    const rows = rowsByKeyword.get(row.keywordIdx) ?? [];
    rows.push(row);
    rowsByKeyword.set(row.keywordIdx, rows);
  }

  return [...input.representativeSets]
    .sort((a, b) => compareClusterIds(a.clusterId, b.clusterId))
    .map((set) => buildClusterCohort(set, rowsByKeyword, input.drThresholds));
}

function buildClusterCohort(
  set: RepresentativeQuerySet,
  rowsByKeyword: ReadonlyMap<number, SerpResult[]>,
  drThresholds: ResearchConfig['scoring']['drThresholds'],
): EntrantCohort {
  const occurrences: EntrantRankingOccurrence[] = [];
  const excludedOccurrences: EntrantExcludedOccurrence[] = [];

  for (const keywordIdx of set.representativeKeywordIds) {
    const organicRows = (rowsByKeyword.get(keywordIdx) ?? [])
      .filter((row) => row.resultType === 'organic')
      .sort(compareSerpRows)
      .slice(0, ENTRANT_COHORT_SERP_TOP_N);
    if (organicRows.length === 0) {
      throw new Error(
        `Representative keyword ${keywordIdx} in ${set.clusterId} has no organic source SERP rows for entrant cohort construction`,
      );
    }

    for (const row of organicRows) {
      if (row.registrableDomain.trim() === '') {
        excludedOccurrences.push({
          keywordIdx,
          position: row.position,
          rankingUrl: row.url,
          reason: 'no_registrable_domain',
        });
        continue;
      }
      occurrences.push({
        keywordIdx,
        position: row.position,
        rankingUrl: row.url,
        registrableDomain: row.registrableDomain,
        normalizedPageIdentity: clusteringUrlIdentity(row.url),
        dr: row.dr,
      });
    }
  }

  const byDomain = new Map<string, EntrantRankingOccurrence[]>();
  for (const occurrence of occurrences) {
    const rows = byDomain.get(occurrence.registrableDomain) ?? [];
    rows.push(occurrence);
    byDomain.set(occurrence.registrableDomain, rows);
  }

  const domains = [...byDomain.entries()]
    .map(([domain, domainOccurrences]) => buildDomainEvidence(
      domain,
      domainOccurrences,
      set.representativeKeywordIds.length,
      drThresholds,
    ))
    .sort((a, b) => a.registrableDomain.localeCompare(b.registrableDomain));

  const knownDrDomainCount = domains.filter((domain) => domain.drEvidence.status === 'known').length;
  const missingDrDomainCount = domains.filter((domain) => domain.drEvidence.status === 'missing').length;
  const conflictingDrDomainCount = domains.filter((domain) => domain.drEvidence.status === 'conflict').length;
  const weakDomainCount = domains.filter((domain) => domain.drEvidence.isWeak === true).length;
  const repeatedDomains = domains.filter((domain) => domain.queryCoverage.numerator >= 2);
  const uniqueDomainCount = domains.length;
  const normalizedOccurrenceCount = occurrences.filter(
    (occurrence) => occurrence.normalizedPageIdentity !== null,
  ).length;

  return {
    clusterId: set.clusterId,
    representativeKeywordIds: [...set.representativeKeywordIds],
    representativeQueryCount: set.representativeKeywordIds.length,
    version: ENTRANT_COHORT_VERSION,
    serpTopN: ENTRANT_COHORT_SERP_TOP_N,
    occurrences: [...occurrences].sort(compareOccurrences),
    excludedOccurrences: [...excludedOccurrences].sort(compareExcludedOccurrences),
    domains,
    summary: {
      observedOccurrenceCount: occurrences.length,
      excludedOccurrenceCount: excludedOccurrences.length,
      uniqueDomainCount,
      pageIdentityCoverage: ratio(normalizedOccurrenceCount, occurrences.length),
      knownDrDomainCount,
      missingDrDomainCount,
      conflictingDrDomainCount,
      weakDomainCount,
      weakDomainCoverage: ratio(weakDomainCount, knownDrDomainCount),
      repeatedDomainCount: repeatedDomains.length,
      repeatedDomainCoverage: ratio(repeatedDomains.length, uniqueDomainCount),
      samePageRepeatedDomainCount: domains.filter(
        (domain) => domain.samePageRepetition.repeatedAcrossQueries,
      ).length,
      differentPageRepeatedDomainCount: domains.filter(
        (domain) => domain.sameDomainDifferentPageRepetition.repeatedAcrossQueries,
      ).length,
    },
    warnings: [ENTRANT_SURVIVORSHIP_WARNING],
  };
}

function buildDomainEvidence(
  registrableDomain: string,
  inputOccurrences: EntrantRankingOccurrence[],
  representativeQueryCount: number,
  drThresholds: ResearchConfig['scoring']['drThresholds'],
): EntrantDomainEvidence {
  const occurrences = [...inputOccurrences].sort(compareOccurrences);
  const queryIdsPresent = [...new Set(occurrences.map((occurrence) => occurrence.keywordIdx))].sort((a, b) => a - b);
  const rankingUrls = uniqueInOrder(occurrences.map((occurrence) => occurrence.rankingUrl));
  const normalizedOccurrenceCount = occurrences.filter(
    (occurrence) => occurrence.normalizedPageIdentity !== null,
  ).length;
  const normalizedPageIdentities = uniqueInOrder(
    occurrences
      .map((occurrence) => occurrence.normalizedPageIdentity)
      .filter((identity): identity is string => identity !== null),
  );

  const pageQueries = new Map<string, Set<number>>();
  for (const occurrence of occurrences) {
    if (occurrence.normalizedPageIdentity === null) continue;
    const queries = pageQueries.get(occurrence.normalizedPageIdentity) ?? new Set<number>();
    queries.add(occurrence.keywordIdx);
    pageQueries.set(occurrence.normalizedPageIdentity, queries);
  }
  const repeatedPages = [...pageQueries.values()].filter((queries) => queries.size >= 2);
  const maxQueriesPerPage = pageQueries.size === 0
    ? 0
    : Math.max(...[...pageQueries.values()].map((queries) => queries.size));

  const knownDrValues = [...new Set(
    occurrences
      .map((occurrence) => occurrence.dr)
      .filter((value): value is number => value !== null),
  )].sort((a, b) => a - b);
  const knownOccurrenceCount = occurrences.filter((occurrence) => occurrence.dr !== null).length;
  const drStatus = knownDrValues.length === 0
    ? 'missing'
    : knownDrValues.length === 1
      ? 'known'
      : 'conflict';
  const drValue = drStatus === 'known' ? knownDrValues[0]! : null;

  return {
    registrableDomain,
    occurrences,
    occurrenceCount: occurrences.length,
    bestRank: Math.min(...occurrences.map((occurrence) => occurrence.position)),
    medianRank: median(occurrences.map((occurrence) => occurrence.position)),
    queryIdsPresent,
    queryCoverage: {
      numerator: queryIdsPresent.length,
      denominator: representativeQueryCount,
      ratio: queryIdsPresent.length / representativeQueryCount,
    },
    rankingUrls,
    normalizedPageIdentities,
    pageIdentityCoverage: {
      numerator: normalizedOccurrenceCount,
      denominator: occurrences.length,
      ratio: normalizedOccurrenceCount / occurrences.length,
    },
    samePageRepetition: {
      repeatedAcrossQueries: repeatedPages.length > 0,
      repeatedPageCount: repeatedPages.length,
      maxQueriesPerPage,
    },
    sameDomainDifferentPageRepetition: {
      repeatedAcrossQueries: queryIdsPresent.length >= 2 && normalizedPageIdentities.length >= 2,
      distinctPageCount: normalizedPageIdentities.length,
    },
    drEvidence: {
      status: drStatus,
      value: drValue,
      observedValues: knownDrValues,
      knownOccurrenceCount,
      occurrenceCount: occurrences.length,
      isWeak: drValue === null ? null : drValue < drThresholds.weakMax,
    },
  };
}

function ratio(numerator: number, denominator: number): {
  numerator: number;
  denominator: number;
  ratio: number | null;
} {
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
  };
}

function median(values: number[]): number {
  if (values.length === 0) throw new Error('Cannot calculate median of an empty entrant evidence set');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function uniqueInOrder<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function compareSerpRows(a: SerpResult, b: SerpResult): number {
  return a.position - b.position || a.url.localeCompare(b.url);
}

function compareOccurrences(a: EntrantRankingOccurrence, b: EntrantRankingOccurrence): number {
  return a.keywordIdx - b.keywordIdx
    || a.position - b.position
    || a.registrableDomain.localeCompare(b.registrableDomain)
    || a.rankingUrl.localeCompare(b.rankingUrl);
}

function compareExcludedOccurrences(a: EntrantExcludedOccurrence, b: EntrantExcludedOccurrence): number {
  return a.keywordIdx - b.keywordIdx || a.position - b.position || a.rankingUrl.localeCompare(b.rankingUrl);
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

function validateThresholds(thresholds: ResearchConfig['scoring']['drThresholds']): void {
  if (
    !Number.isFinite(thresholds.veryWeakMax)
    || !Number.isFinite(thresholds.weakMax)
    || thresholds.veryWeakMax < 0
    || thresholds.weakMax <= thresholds.veryWeakMax
  ) {
    throw new Error('Invalid DR thresholds for entrant cohort weak-domain classification');
  }
}
