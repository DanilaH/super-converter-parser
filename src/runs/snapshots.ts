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
    },
  };

  await writeJsonAtomic(`${runDirectory}/manifest.json`, manifest, 'run manifest');
  await writeJsonAtomic(
    `${runDirectory}/keywords.json`,
    keywords.map(storedKeywordToRecord),
    'keywords output',
  );
  await writeJsonAtomic(`${runDirectory}/serp.json`, serpRows, 'SERP output');
}
