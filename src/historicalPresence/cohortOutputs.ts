import type { CohortHistoricalPresenceSnapshot } from '../db/cohortHistoricalPresence.js';
import { renderCsv } from '../exports/csv.js';
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
      String(domain.priority.bestRank),
      String(domain.priority.occurrenceCount),
      String(domain.priority.clusterCount),
      domain.cacheStatus,
      result?.status ?? '',
      result?.earliestSampledCaptureAt ?? '',
      result?.earliestSampledCaptureUrl ?? '',
      result?.earliestSampledCaptureHttpStatus ?? '',
      result?.earliestMatchedCollectionId ?? '',
      result?.earliestMatchedCollectionFrom ?? '',
      result?.earliestMatchedCollectionTo ?? '',
      result ? String(result.historyCompleteForSelectedCollections) : '',
      result ? String(result.selectedCollectionCount) : '',
      result ? String(result.checkedCollectionCount) : '',
      result?.source ?? '',
      result?.sourceReason ?? '',
      result?.error ?? '',
      result?.fetchedAt ?? '',
      result ? String(result.requestCount) : '',
      result?.httpStatus === null || result?.httpStatus === undefined ? '' : String(result.httpStatus),
    ];
  });
  await writeTextAtomic(
    path,
    renderCsv([headers, ...rows]),
    'cohort sampled historical-presence CSV',
  );
}
