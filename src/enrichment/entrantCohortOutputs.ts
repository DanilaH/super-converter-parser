import { renderCsv } from '../exports/csv.js';
import { writeTextAtomic } from '../runs/run.js';
import type { ResearchConfig } from '../config/config.js';
import type { EntrantCohort } from './entrantCohort.js';

export type EntrantCohortOutputOptions = {
  enrichmentId: string;
  sourceRunId: string;
  representativeRevision: number;
  sourceRunUpdatedAt: string;
  clusteringUpdatedAt: string;
  drThresholds: ResearchConfig['scoring']['drThresholds'];
  cohorts: EntrantCohort[];
};

export function writeEntrantCohortDomainsCsv(
  outputPath: string,
  cohorts: EntrantCohort[],
): Promise<void> {
  const rows: string[][] = [[
    'cluster_id',
    'registrable_domain',
    'best_rank',
    'median_rank',
    'occurrence_count',
    'queries_present',
    'query_ids_present',
    'query_coverage_numerator',
    'query_coverage_denominator',
    'query_coverage_ratio',
    'ranking_urls',
    'normalized_page_identities',
    'page_identity_coverage_numerator',
    'page_identity_coverage_denominator',
    'page_identity_coverage_ratio',
    'same_page_repeated_across_queries',
    'repeated_page_count',
    'max_queries_per_page',
    'different_page_repeated_across_queries',
    'distinct_page_count',
    'dr_status',
    'dr',
    'observed_dr_values',
    'known_dr_occurrences',
    'dr_occurrence_denominator',
    'is_weak',
  ]];

  for (const cohort of cohorts) {
    for (const domain of cohort.domains) {
      rows.push([
        cohort.clusterId,
        domain.registrableDomain,
        String(domain.bestRank),
        String(domain.medianRank),
        String(domain.occurrenceCount),
        String(domain.queryIdsPresent.length),
        domain.queryIdsPresent.join(';'),
        String(domain.queryCoverage.numerator),
        String(domain.queryCoverage.denominator),
        String(domain.queryCoverage.ratio),
        domain.rankingUrls.join('; '),
        domain.normalizedPageIdentities.join('; '),
        String(domain.pageIdentityCoverage.numerator),
        String(domain.pageIdentityCoverage.denominator),
        String(domain.pageIdentityCoverage.ratio),
        String(domain.samePageRepetition.repeatedAcrossQueries),
        String(domain.samePageRepetition.repeatedPageCount),
        String(domain.samePageRepetition.maxQueriesPerPage),
        String(domain.sameDomainDifferentPageRepetition.repeatedAcrossQueries),
        String(domain.sameDomainDifferentPageRepetition.distinctPageCount),
        domain.drEvidence.status,
        domain.drEvidence.value === null ? '' : String(domain.drEvidence.value),
        domain.drEvidence.observedValues.join(';'),
        String(domain.drEvidence.knownOccurrenceCount),
        String(domain.drEvidence.occurrenceCount),
        domain.drEvidence.isWeak === null ? '' : String(domain.drEvidence.isWeak),
      ]);
    }
  }

  return writeTextAtomic(outputPath, renderCsv(rows), 'entrant cohort domain CSV');
}

export function writeEntrantCohortOccurrencesCsv(
  outputPath: string,
  cohorts: EntrantCohort[],
): Promise<void> {
  const rows: string[][] = [[
    'cluster_id',
    'keyword_idx',
    'position',
    'ranking_url',
    'registrable_domain',
    'normalized_page_identity',
    'dr',
    'included_in_domain_cohort',
    'exclusion_reason',
  ]];

  for (const cohort of cohorts) {
    for (const occurrence of cohort.occurrences) {
      rows.push([
        cohort.clusterId,
        String(occurrence.keywordIdx),
        String(occurrence.position),
        occurrence.rankingUrl,
        occurrence.registrableDomain,
        occurrence.normalizedPageIdentity ?? '',
        occurrence.dr === null ? '' : String(occurrence.dr),
        'true',
        '',
      ]);
    }
    for (const occurrence of cohort.excludedOccurrences) {
      rows.push([
        cohort.clusterId,
        String(occurrence.keywordIdx),
        String(occurrence.position),
        occurrence.rankingUrl,
        '',
        '',
        '',
        'false',
        occurrence.reason,
      ]);
    }
  }

  return writeTextAtomic(outputPath, renderCsv(rows), 'entrant cohort occurrence CSV');
}

export function writeEntrantCohortJson(
  outputPath: string,
  options: EntrantCohortOutputOptions,
): Promise<void> {
  const payload = {
    enrichmentId: options.enrichmentId,
    sourceRunId: options.sourceRunId,
    representativeRevision: options.representativeRevision,
    sourceRunUpdatedAt: options.sourceRunUpdatedAt,
    clusteringUpdatedAt: options.clusteringUpdatedAt,
    drThresholds: options.drThresholds,
    cohortVersion: options.cohorts[0]?.version ?? null,
    serpTopN: options.cohorts[0]?.serpTopN ?? null,
    finalistClusterCount: options.cohorts.length,
    cohorts: options.cohorts,
  };
  return writeTextAtomic(
    outputPath,
    JSON.stringify(payload, null, 2) + '\n',
    'entrant cohort JSON',
  );
}
