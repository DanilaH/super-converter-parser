import { RunStore, storedKeywordToRecord, type StoredKeyword, type StoredRun } from '../db/store.js';
import { writeJsonAtomic, type RunManifest, type RunState } from './run.js';

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
}
