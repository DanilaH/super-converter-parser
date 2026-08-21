import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore, storedKeywordToRecord, type StoredKeyword } from '../db/store.js';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { createRunId, writeJsonAtomic } from './run.js';
import {
  executeRun,
  type ExecuteRunOptions,
  type SnapshotsPublisher,
} from './engine.js';
import { ResearchError } from '../shared/errors.js';
import type { CollectionResult } from '../browser/collect.js';
import type { KeywordRecord } from './run.js';

const BASE_CONFIG = loadConfig({});
const INPUT = { kind: 'seeds' as const, path: 'input/seeds.csv' };

const KEYWORDS: SeedKeyword[] = buildSeedKeywords([
  { keyword: 'compare lists', rowNumber: 1 },
  { keyword: 'best office chairs', rowNumber: 2 },
  { keyword: 'standing desk', rowNumber: 3 },
  { keyword: 'ergonomic mouse', rowNumber: 4 },
]);

let failTerminalPublish = true;

function fakeCountProgress(keywords: StoredKeyword[]): {
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

// Mirrors the real snapshot publisher but fails specifically when the run
// would become terminal, reproducing a final JSON write that crashes.
const failingFinalPublisher: SnapshotsPublisher = async (store, runId, runDirectory, state) => {
  const run = store.loadRun(runId) as NonNullable<ReturnType<RunStore['loadRun']>>;
  const keywords = store.loadKeywords(runId);
  const serpRows = store.loadSerpRows(runId);
  const progress = fakeCountProgress(keywords);

  await writeJsonAtomic(
    `${runDirectory}/manifest.json`,
    {
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
    },
    'run manifest',
  );
  await writeJsonAtomic(
    `${runDirectory}/keywords.json`,
    keywords.map(storedKeywordToRecord),
    'keywords output',
  );
  await writeJsonAtomic(`${runDirectory}/serp.json`, serpRows, 'SERP output');

  if (failTerminalPublish && (state === 'completed' || state === 'completed_with_errors')) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      'final snapshot publish failed (test injection)',
    );
  }
};

function baseOptions(
  store: RunStore,
  runId: string,
  runDirectory: string,
  extra: Partial<ExecuteRunOptions> = {},
): ExecuteRunOptions {
  return {
    store,
    runId,
    mode: 'fresh',
    keywords: KEYWORDS,
    config: BASE_CONFIG,
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (keyword) => okResult(keyword),
    hooks: {
      sleep: async () => undefined,
      now: () => Date.now(),
      random: () => 0.5,
      logger: () => undefined,
      pauseRequested: () => false,
    },
    publishSnapshots: failingFinalPublisher,
    ...extra,
  };
}

function okResult(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: {
        volume: 100,
        cpc: 1.5,
        market: 'US',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=x',
        detectedLocation: null,
        geoWarning: false,
      },
      error: null,
    },
    serpRows: [],
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  };
}

test('a failed final snapshot publish leaves the run non-terminal and resumable', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-final-publish-'));

  await assert.rejects(
    () => executeRun(baseOptions(store, runId, runDirectory)),
    (error: unknown) => error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR',
  );

  // The run must never have become terminal: all work is committed but the
  // run state stays resumable so a resume republishes the artifacts.
  assert.equal(store.loadRun(runId)?.state, 'running');
  assert.equal(
    store.loadKeywords(runId).filter((k) => k.status === 'completed').length,
    4,
  );
  assert.equal(store.loadRun(runId)?.lookups, 4);

  failTerminalPublish = false;
  const resumed = await executeRun(
    baseOptions(store, runId, runDirectory, { mode: 'resume', keywords: [] }),
  );
  assert.equal(resumed.kind, 'finished');
  assert.equal(resumed.state, 'completed');
  assert.equal(store.loadRun(runId)?.state, 'completed');

  const manifest = JSON.parse(
    await readFile(join(runDirectory, 'manifest.json'), 'utf8'),
  ) as { state: string };
  assert.equal(manifest.state, 'completed');
  store.close();
});
