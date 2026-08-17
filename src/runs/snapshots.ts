import {
  RunStore,
  isTerminalKeywordStatus,
  storedKeywordToRecord,
  type StoredKeyword,
  type StoredRun,
} from '../db/store.js';
import { writeJsonAtomic, writeTextAtomic, type RunManifest, type RunState } from './run.js';
import { renderCsv } from '../exports/csv.js';
import type { SerpResult } from '../google/serp.js';

export function countProgress(keywords: StoredKeyword[]): {
  completed: number;
  partial: number;
  failed: number;
  errors: number;
} {
  const completed = keywords.filter((item) => item.status === 'completed').length;
  const partial = keywords.filter((item) => item.status === 'partial').length;
  const failed = keywords.filter((item) => item.status === 'failed').length;
  return { completed, partial, failed, errors: partial + failed };
}

// One definition of the truth for cache accounting. The four buckets are
// mutually exclusive and add up to the number of processed keywords: `hits`
// were served from the cache, `misses` were genuinely absent, `expired`
// entries were present but past their TTL (their own bucket, never also
// counted as misses), and `refreshed` keywords were deliberately bypassed.
// The live progress line, the manifest rollup, and keywords.json all use this
// single definition, so the numbers always agree and never double-count.
export function countCacheStats(keywords: StoredKeyword[]): {
  hits: number;
  misses: number;
  expired: number;
  refreshed: number;
} {
  const stats = { hits: 0, misses: 0, expired: 0, refreshed: 0 };
  for (const item of keywords) {
    if (item.cacheStatus === 'hit') stats.hits += 1;
    else if (item.cacheStatus === 'expired') stats.expired += 1;
    else if (item.cacheStatus === 'miss') stats.misses += 1;
    else if (item.cacheStatus === 'refreshed') stats.refreshed += 1;
  }
  return stats;
}

// Hit rate is the share of processed keywords served from the cache, rounded
// like the live CLI line. A forced refresh is a deliberate bypass (browser
// work was done), so it is never a hit; expired entries are misses by
// definition but are not subtracted from the denominator.
export function cacheHitRatePercent(hits: number, processed: number): number {
  return processed > 0 ? Math.round((hits / processed) * 100) : 0;
}

export async function writeSnapshots(
  store: RunStore,
  runId: string,
  runDirectory: string,
  state: RunState,
): Promise<void> {
  const run = store.loadRun(runId) as StoredRun;
  const keywords = store.loadKeywords(runId);
  const serpRows = store.loadSerpRows(runId);
  const progress = countProgress(keywords);
  const cacheStats = countCacheStats(keywords);

  const manifest: RunManifest = {
    runId,
    createdAt: run.createdAt,
    updatedAt: new Date().toISOString(),
    state,
    input: run.input,
    configSnapshot: run.configSnapshot,
    parserVersions: run.parserVersions,
    pauseReason: run.pauseReason,
    progress: {
      totalKeywords: keywords.length,
      completedKeywords: progress.completed,
      partialKeywords: progress.partial,
      failedKeywords: progress.failed,
      errors: progress.errors,
      lookups: run.lookups,
      cache: {
        ...cacheStats,
        hitRatePercent: cacheHitRatePercent(
          cacheStats.hits,
          progress.completed + progress.partial + progress.failed,
        ),
      },
    },
  };

  await writeJsonAtomic(`${runDirectory}/manifest.json`, manifest, 'run manifest');
  // keywords.json carries the per-keyword cache decision alongside the raw
  // data, so downstream consumers can always tell cached from fresh rows.
  await writeJsonAtomic(
    `${runDirectory}/keywords.json`,
    keywords.map((keyword) => ({ ...storedKeywordToRecord(keyword), cacheStatus: keyword.cacheStatus })),
    'keywords output',
  );
  await writeJsonAtomic(`${runDirectory}/serp.json`, serpRows, 'SERP output');
  await writeTextAtomic(
    `${runDirectory}/keywords.csv`,
    renderKeywordsCsv(keywords, organicCounts(runId, store)),
    'keywords CSV',
  );
  await writeTextAtomic(`${runDirectory}/serp.csv`, renderSerpCsv(serpRows), 'SERP CSV');
}

function organicCounts(runId: string, store: RunStore): Map<number, number> {
  return new Map(store.loadSerpRowCounts(runId).map((item) => [item.keywordIdx, item.count]));
}

// Operator-facing keyword export: exactly one row per canonical keyword in
// input order, with the fixed column contract of TASK-004. Missing values are
// empty cells (never "null"/"undefined"); numeric zero is a real value. The
// organic count comes from the run checkpoint, not from cache state.
export function renderKeywordsCsv(keywords: StoredKeyword[], organicCounts: Map<number, number>): string {
  const rows = [KEYWORDS_CSV_HEADERS];
  for (const keyword of keywords) {
    const organic =
      isTerminalKeywordStatus(keyword.status)
        ? String(organicCounts.get(keyword.idx) ?? 0)
        : '';
    rows.push([
      keyword.keyword,
      keyword.normalizedKeyword,
      sourceRowsValue(keyword),
      keyword.surfer === null || keyword.surfer.volume === null ? '' : String(keyword.surfer.volume),
      keyword.surfer === null || keyword.surfer.cpc === null ? '' : String(keyword.surfer.cpc),
      keyword.surfer?.market ?? '',
      keyword.google?.hl ?? '',
      keyword.google?.gl ?? '',
      keyword.google?.pageUrl ?? '',
      keyword.google?.detectedLocation ?? '',
      keyword.google === null ? '' : String(keyword.google.geoWarning),
      organic,
      keyword.status,
      keyword.error?.code ?? '',
      keyword.error?.message ?? '',
      keyword.cacheStatus ?? '',
      keyword.collectedAt ?? '',
    ]);
  }
  return renderCsv(rows);
}

// One row per stored organic result, ordered by keyword input index and then
// position; keywords without organic results contribute no rows.
export function renderSerpCsv(serpRows: SerpResult[]): string {
  const rows = [SERP_CSV_HEADERS];
  for (const row of serpRows) {
    rows.push([row.keyword, String(row.position), row.title, row.url, row.hostname, row.resultType]);
  }
  return renderCsv(rows);
}

function sourceRowsValue(keyword: StoredKeyword): string {
  const rows = Array.from(
    new Set(keyword.sources.flatMap((source) => source.rowNumbers)),
  );
  rows.sort((a, b) => a - b);
  return rows.join('|');
}

const KEYWORDS_CSV_HEADERS = [
  'keyword',
  'normalized_keyword',
  'source_rows',
  'surfer_volume',
  'surfer_cpc',
  'surfer_market',
  'google_hl',
  'google_gl',
  'google_url',
  'detected_google_location',
  'geo_warning',
  'organic_result_count',
  'status',
  'error_code',
  'error_message',
  'cache_status',
  'collected_at',
];

const SERP_CSV_HEADERS = ['keyword', 'position', 'title', 'url', 'hostname', 'result_type'];
