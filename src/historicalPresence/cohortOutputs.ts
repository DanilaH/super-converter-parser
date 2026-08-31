import type { CohortHistoricalPresenceSnapshot } from '../db/cohortHistoricalPresence.js';
import { writeJsonAtomic, writeTextAtomic } from '../runs/run.js';

export async function writeCohortHistoricalPresenceJson(
  path: string,
  snapshot: CohortHistoricalPresenceSnapshot,
): Promise<void> {
  await writeJsonAtomic(path, snapshot, 'cohort sampled historical-presence JSON');
}

export async function writeCohortHistoricalPresenceCsv(
  path: string,
  snapshot: CohortHistoricalPresenceSnapshot,
): Promise<void> {
  const headers = [
    'registrable_domain',
    'coverage_status',
    'omit_reason',
    'best_rank',
    'occurrence_count',
    'cluster_count',
    'cache_status',
    'status',
    'earliest_sampled_capture_at',
    'earliest_sampled_capture_url',
    'earliest_sampled_capture_http_status',
    'earliest_matched_collection_id',
    'earliest_matched_collection_from',
    'earliest_matched_collection_to',
    'history_complete_for_selected_collections',
    'selected_collection_count',
    'checked_collection_count',
    'source',
    'source_reason',
    'error',
    'fetched_at',
    'request_count',
    'provider_http_status',
  ];
  const rows = snapshot.collection.domains.map((domain) => {
    const result = domain.result;
    return [
      domain.registrableDomain,
      domain.coverageStatus,
      domain.omitReason ?? '',
      domain.priority.bestRank,
      domain.priority.occurrenceCount,
      domain.priority.clusterCount,
      domain.cacheStatus,
      result?.status ?? '',
      result?.earliestSampledCaptureAt ?? '',
      result?.earliestSampledCaptureUrl ?? '',
      result?.earliestSampledCaptureHttpStatus ?? '',
      result?.earliestMatchedCollectionId ?? '',
      result?.earliestMatchedCollectionFrom ?? '',
      result?.earliestMatchedCollectionTo ?? '',
      result ? String(result.historyCompleteForSelectedCollections) : '',
      result?.selectedCollectionCount ?? '',
      result?.checkedCollectionCount ?? '',
      result?.source ?? '',
      result?.sourceReason ?? '',
      result?.error ?? '',
      result?.fetchedAt ?? '',
      result?.requestCount ?? '',
      result?.httpStatus ?? '',
    ];
  });
  await writeTextAtomic(
    path,
    `${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`,
    'cohort sampled historical-presence CSV',
  );
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
