import { renderCsv } from '../exports/csv.js';
import { writeTextAtomic } from '../runs/run.js';
import type { CohortHistorySnapshot } from '../db/cohortHistory.js';
import type { CohortHistoryProjection } from './cohortHistory.js';

export function writeCohortHistoryDomainsCsv(
  outputPath: string,
  projections: CohortHistoryProjection[],
): Promise<void> {
  const rows: string[][] = [[
    'cluster_id',
    'registrable_domain',
    'coverage_status',
    'omit_reason',
    'registration_status',
    'registration_date',
    'registration_age_days',
    'is_young',
    'registration_is_redacted',
    'registration_error',
    'first_seen_status',
    'first_seen_date',
    'first_seen_age_days',
    'is_recent_web_presence',
    'first_seen_source',
    'first_seen_source_reason',
    'first_seen_error',
    'registration_first_seen_gap_days',
    'possible_history_conflict',
    'history_conflict_reason',
    'observed_at',
  ]];

  for (const projection of projections) {
    for (const domain of projection.domains) {
      rows.push([
        projection.clusterId,
        domain.registrableDomain,
        domain.coverageStatus,
        domain.omitReason ?? '',
        domain.registration.status,
        domain.registration.date ?? '',
        nullableNumber(domain.registration.ageDays),
        nullableBoolean(domain.registration.isYoung),
        nullableBoolean(domain.registration.isRedacted),
        domain.registration.error ?? '',
        domain.firstSeen.status,
        domain.firstSeen.date ?? '',
        nullableNumber(domain.firstSeen.ageDays),
        nullableBoolean(domain.firstSeen.isRecent),
        domain.firstSeen.source ?? '',
        domain.firstSeen.sourceReason ?? '',
        domain.firstSeen.error ?? '',
        nullableNumber(domain.registrationFirstSeenGapDays),
        nullableBoolean(domain.possibleHistoryConflict),
        domain.historyConflictReason ?? '',
        domain.observedAt ?? '',
      ]);
    }
  }

  return writeTextAtomic(outputPath, renderCsv(rows), 'cohort history domain CSV');
}

export function writeCohortHistorySummaryCsv(
  outputPath: string,
  projections: CohortHistoryProjection[],
): Promise<void> {
  const rows: string[][] = [[
    'cluster_id',
    'cohort_domain_count',
    'checked_domain_count',
    'omitted_domain_count',
    'unobserved_domain_count',
    'checked_coverage_numerator',
    'checked_coverage_denominator',
    'checked_coverage_ratio',
    'registration_known_domain_count',
    'young_domain_count',
    'young_coverage_numerator',
    'young_coverage_denominator',
    'young_coverage_ratio',
    'first_seen_known_domain_count',
    'recent_web_presence_count',
    'recent_web_presence_numerator',
    'recent_web_presence_denominator',
    'recent_web_presence_ratio',
    'comparable_history_domain_count',
    'possible_history_conflict_count',
    'history_conflict_numerator',
    'history_conflict_denominator',
    'history_conflict_ratio',
    'registration_status_counts_json',
    'first_seen_status_counts_json',
  ]];

  for (const projection of projections) {
    const summary = projection.summary;
    rows.push([
      projection.clusterId,
      String(summary.cohortDomainCount),
      String(summary.checkedDomainCount),
      String(summary.omittedDomainCount),
      String(summary.unobservedDomainCount),
      String(summary.checkedCoverage.numerator),
      String(summary.checkedCoverage.denominator),
      nullableNumber(summary.checkedCoverage.ratio),
      String(summary.registrationKnownDomainCount),
      String(summary.youngDomainCount),
      String(summary.youngDomainCoverage.numerator),
      String(summary.youngDomainCoverage.denominator),
      nullableNumber(summary.youngDomainCoverage.ratio),
      String(summary.firstSeenKnownDomainCount),
      String(summary.recentWebPresenceCount),
      String(summary.recentWebPresenceCoverage.numerator),
      String(summary.recentWebPresenceCoverage.denominator),
      nullableNumber(summary.recentWebPresenceCoverage.ratio),
      String(summary.comparableHistoryDomainCount),
      String(summary.possibleHistoryConflictCount),
      String(summary.possibleHistoryConflictCoverage.numerator),
      String(summary.possibleHistoryConflictCoverage.denominator),
      nullableNumber(summary.possibleHistoryConflictCoverage.ratio),
      JSON.stringify(summary.registrationStatusCounts),
      JSON.stringify(summary.firstSeenStatusCounts),
    ]);
  }

  return writeTextAtomic(outputPath, renderCsv(rows), 'cohort history summary CSV');
}

export function writeCohortHistoryJson(
  outputPath: string,
  snapshot: CohortHistorySnapshot,
): Promise<void> {
  return writeTextAtomic(
    outputPath,
    JSON.stringify(snapshot, null, 2) + '\n',
    'cohort history JSON',
  );
}

function nullableBoolean(value: boolean | null): string {
  return value === null ? '' : String(value);
}

function nullableNumber(value: number | null): string {
  return value === null ? '' : String(value);
}
