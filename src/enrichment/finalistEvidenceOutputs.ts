import { renderCsv } from '../exports/csv.js';
import { writeTextAtomic } from '../runs/run.js';
import type { FinalistSampledHistoricalPresenceEvidence } from '../historicalPresence/evidenceProjection.js';
import type {
  EvidenceCoverage,
  EvidenceDistribution,
  FinalistEvidenceMatrix,
} from './finalistEvidence.js';

export type FinalistEvidenceArtifact = {
  version: string;
  enrichmentId: string;
  sourceRunId: string;
  representativeRevision: number;
  entrantFingerprint: string;
  matrix: FinalistEvidenceMatrix;
};

export function writeFinalistEvidenceJson(
  outputPath: string,
  artifact: FinalistEvidenceArtifact,
): Promise<void> {
  return writeTextAtomic(
    outputPath,
    JSON.stringify(artifact, null, 2) + '\n',
    'finalist evidence matrix JSON',
  );
}

export function writeFinalistEvidenceCsv(
  outputPath: string,
  matrix: FinalistEvidenceMatrix,
): Promise<void> {
  const rows: string[][] = [[
    'cluster_id',
    'canonical_keyword',
    'representative_keyword_ids',
    'demand_volume_numerator',
    'demand_volume_denominator',
    'demand_volume_ratio',
    'demand_volume_min',
    'demand_volume_median',
    'demand_volume_max',
    'representative_url_numerator',
    'representative_url_denominator',
    'representative_url_ratio',
    'entrant_domain_count',
    'known_dr_domain_count',
    'missing_dr_domain_count',
    'conflicting_dr_domain_count',
    'weak_domain_numerator',
    'weak_domain_denominator',
    'weak_domain_ratio',
    'repeated_domain_numerator',
    'repeated_domain_denominator',
    'repeated_domain_ratio',
    'page_identity_numerator',
    'page_identity_denominator',
    'page_identity_ratio',
    'serp_warnings',
    'traffic_imported_snapshot_count',
    'traffic_matched_snapshot_count',
    'traffic_mismatched_snapshot_count',
    'traffic_history_count',
    'traffic_warnings',
    'history_checked_numerator',
    'history_checked_denominator',
    'history_checked_ratio',
    'history_young_numerator',
    'history_young_denominator',
    'history_young_ratio',
    'history_recent_web_presence_numerator',
    'history_recent_web_presence_denominator',
    'history_recent_web_presence_ratio',
    'history_conflict_numerator',
    'history_conflict_denominator',
    'history_conflict_ratio',
    'sampled_history_collected',
    'sampled_history_cohort_domain_count',
    'sampled_history_checked_domain_count',
    'sampled_history_observed_presence_count',
    'sampled_history_not_found_count',
    'sampled_history_omitted_domain_count',
    'sampled_history_unavailable_count',
    'sampled_history_error_count',
    'sampled_history_incomplete_selected_history_count',
    'sampled_history_warnings',
    'survivorship_warnings',
    'site_structure_numerator',
    'site_structure_denominator',
    'site_structure_ratio',
    'moat_warnings',
    'cpc_numerator',
    'cpc_denominator',
    'cpc_ratio',
    'cpc_min',
    'cpc_median',
    'cpc_max',
    'google_observation_numerator',
    'google_observation_denominator',
    'google_observation_ratio',
    'detected_location_numerator',
    'detected_location_denominator',
    'detected_location_ratio',
    'geo_warning_count',
    'monetization_warnings',
    'product_feasibility_automated_assessment',
    'product_feasibility_warnings',
    'build_decision',
    'seo_product_role',
    'human_decision_recorded_at',
    'human_decision_evidence_current',
    'audit_flags',
  ]];

  for (const finalist of matrix.finalists) {
    const demand = finalist.evidence.demand;
    const serp = finalist.evidence.serpAccessibility;
    const traffic = finalist.evidence.organicTrafficProof;
    const repeatability = finalist.evidence.entrantRepeatability;
    const sampled = readSampledHistoricalPresence(finalist.evidence);
    const moat = finalist.evidence.moat;
    const monetization = finalist.evidence.monetizationGeography;
    const productFeasibility = finalist.evidence.productFeasibility;
    const history = repeatability.history;

    rows.push([
      finalist.clusterId,
      finalist.canonicalKeyword,
      finalist.representativeKeywordIds.join('; '),
      ...coverageCells(demand.volumeCoverage),
      ...distributionCells(demand.volumeDistribution),
      ...coverageCells(serp.representativeUrlCoverage),
      String(serp.entrantDomainCount),
      String(serp.knownDrDomainCount),
      String(serp.missingDrDomainCount),
      String(serp.conflictingDrDomainCount),
      ...coverageCells(serp.weakDomainCoverage),
      ...coverageCells(serp.repeatedDomainCoverage),
      ...coverageCells(serp.pageIdentityCoverage),
      warningCell(serp.warnings),
      String(traffic.importedSnapshotCount),
      numberCell(traffic.matchedSnapshotCount),
      numberCell(traffic.mismatchedSnapshotCount),
      String(traffic.histories.length),
      warningCell(traffic.warnings),
      ...optionalCoverageCells(history?.checkedCoverage ?? null),
      ...optionalCoverageCells(history?.youngDomainCoverage ?? null),
      ...optionalCoverageCells(history?.recentWebPresenceCoverage ?? null),
      ...optionalCoverageCells(history?.possibleHistoryConflictCoverage ?? null),
      sampled === null ? '' : String(sampled.collected),
      sampled === null ? '' : String(sampled.cohortDomainCount),
      sampled === null ? '' : String(sampled.checkedDomainCount),
      sampled === null ? '' : String(sampled.observedPresenceCount),
      sampled === null ? '' : String(sampled.notFoundCount),
      sampled === null ? '' : String(sampled.omittedDomainCount),
      sampled === null ? '' : String(sampled.unavailableCount),
      sampled === null ? '' : String(sampled.errorCount),
      sampled === null ? '' : String(sampled.incompleteSelectedHistoryCount),
      sampled === null ? '' : warningCell(sampled.warnings),
      warningCell(repeatability.survivorshipWarnings),
      ...coverageCells(moat.observedDomainCoverage),
      warningCell(moat.warnings),
      ...coverageCells(monetization.cpcCoverage),
      ...distributionCells(monetization.cpcDistribution),
      ...coverageCells(monetization.googleObservationCoverage),
      ...coverageCells(monetization.detectedLocationCoverage),
      String(monetization.geoWarningCount),
      warningCell(monetization.warnings),
      '',
      warningCell(productFeasibility.warnings),
      finalist.humanDecision.buildDecision ?? '',
      finalist.humanDecision.seoProductRole ?? '',
      finalist.humanDecision.recordedAt ?? '',
      booleanCell(finalist.humanDecision.evidenceCurrent),
      finalist.auditFlags.join('; '),
    ]);
  }

  return writeTextAtomic(outputPath, renderCsv(rows), 'finalist evidence matrix CSV');
}

function readSampledHistoricalPresence(
  evidence: FinalistEvidenceMatrix['finalists'][number]['evidence'],
): FinalistSampledHistoricalPresenceEvidence | null {
  const value = (evidence as unknown as { sampledHistoricalPresence?: unknown }).sampledHistoricalPresence;
  return value === undefined ? null : value as FinalistSampledHistoricalPresenceEvidence;
}

function coverageCells(value: EvidenceCoverage): [string, string, string] {
  return [
    String(value.numerator),
    String(value.denominator),
    numberCell(value.ratio),
  ];
}

function optionalCoverageCells(value: EvidenceCoverage | null): [string, string, string] {
  return value === null ? ['', '', ''] : coverageCells(value);
}

function distributionCells(value: EvidenceDistribution | null): [string, string, string] {
  return value === null
    ? ['', '', '']
    : [String(value.min), String(value.median), String(value.max)];
}

function warningCell(values: string[]): string {
  return values.join('; ');
}

function numberCell(value: number | null): string {
  return value === null ? '' : String(value);
}

function booleanCell(value: boolean | null): string {
  return value === null ? '' : String(value);
}
