import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import type { SerpResult } from '../google/serp.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import {
  allocateResearchLocation,
  resolveRunLocation,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { ResearchError } from '../shared/errors.js';
import {
  acquireResearchBatchLock,
  prepareResearchAppend,
  readResearchContainer,
} from './batches.js';

const INITIAL_RUN_ID = 'run_batch_initial';

type BatchAwareSource = {
  type: string;
  batchId?: string;
  inputPath?: string;
  rowNumbers?: number[];
};

async function createCompletedResearch(root: string): Promise<{
  researchDirectory: string;
  discoveryDirectory: string;
  initialInput: string;
}> {
  const initialInput = join(root, 'initial.csv');
  await writeFile(initialInput, 'keyword\nfavicon generator\nfavicon maker\n', 'utf8');
  const location = await allocateResearchLocation(
    root,
    'Favicon Batch Test',
    new Date('2026-08-30T00:00:00.000Z'),
  );
  const store = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
  const initialSeeds: SeedKeyword[] = [
    { keyword: 'favicon generator', normalizedKeyword: 'favicon generator', sourceRows: [2] },
    { keyword: 'favicon maker', normalizedKeyword: 'favicon maker', sourceRows: [3] },
  ];
  store.createRun({
    runId: INITIAL_RUN_ID,
    configSnapshot: loadConfig({}),
    parserVersions: {
      surfer: SURFER_PARSER_VERSION,
      google: GOOGLE_PARSER_VERSION,
    },
    input: { kind: 'seeds', path: initialInput },
    keywords: initialSeeds,
  });

  const firstRow: SerpResult = {
    keyword: 'favicon generator',
    keywordIdx: 0,
    position: 1,
    title: 'Example favicon tool',
    url: 'https://example.com/favicon',
    hostname: 'example.com',
    registrableDomain: 'example.com',
    dr: 12,
    drStatus: 'ok',
    drError: null,
    resultType: 'organic',
  };
  completeKeyword(store, INITIAL_RUN_ID, 0, [firstRow]);
  completeKeyword(store, INITIAL_RUN_ID, 1, []);

  const expanded = store.addKeyword(INITIAL_RUN_ID, {
    keyword: 'favicon checker',
    normalizedKeyword: 'favicon checker',
    sources: [{ type: 'surfer_related', parentKeyword: 'favicon generator', overlap: 7 }],
  });
  assert.equal(expanded.idx, 2);
  completeKeyword(store, INITIAL_RUN_ID, 2, []);
  store.recordRelatedKeywords(
    INITIAL_RUN_ID,
    0,
    'favicon generator',
    {
      status: 'ok',
      error: null,
      rows: [{ keyword: 'favicon checker', overlap: 7, volume: 900 }],
    },
    new Set(['favicon checker']),
  );
  store.recordDomains(
    INITIAL_RUN_ID,
    0,
    'favicon generator',
    [firstRow],
    new Map([['example.com', { source: 'fresh' as const, fetchedAt: '2026-08-30T00:05:00.000Z' }]]),
  );
  store.incrementLookups(INITIAL_RUN_ID);
  store.incrementLookups(INITIAL_RUN_ID);
  store.incrementLookups(INITIAL_RUN_ID);
  store.setRunState(INITIAL_RUN_ID, 'completed', { updatedAt: '2026-08-30T00:10:00.000Z' });
  store.close();

  await writeRunIndex(root, {
    version: 1,
    runId: INITIAL_RUN_ID,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });
  return {
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
    initialInput,
  };
}

function completeKeyword(
  store: RunStore,
  runId: string,
  idx: number,
  rows: SerpResult[],
): void {
  const keyword = store.loadKeyword(runId, idx);
  assert.ok(keyword);
  store.commitKeyword(
    runId,
    {
      ...keyword,
      status: 'completed',
      collectedAt: '2026-08-30T00:05:00.000Z',
    },
    rows,
    'miss',
  );
}

async function finishPendingKeywords(root: string, runId: string): Promise<void> {
  const location = await resolveRunLocation(root, runId);
  const store = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
  try {
    for (const keyword of store.loadKeywords(runId).filter((row) => row.status === 'pending')) {
      completeKeyword(store, runId, keyword.idx, []);
    }
    store.setRunState(runId, 'completed');
  } finally {
    store.close();
  }
}

test('append forks one combined run, preserves evidence, and leaves only new seeds pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-batches-'));
  const source = await createCompletedResearch(root);
  const appendInput = join(root, 'append.csv');
  await writeFile(appendInput, 'keyword\nfavicon maker\nfavicon converter\n', 'utf8');

  const result = await prepareResearchAppend({
    outputRoot: root,
    targetRunId: INITIAL_RUN_ID,
    seedsPath: appendInput,
    seeds: [
      { keyword: 'favicon maker', normalizedKeyword: 'favicon maker', sourceRows: [2] },
      { keyword: 'favicon converter', normalizedKeyword: 'favicon converter', sourceRows: [3] },
    ],
    now: () => new Date('2026-08-30T01:00:00.000Z'),
  });

  assert.equal(result.changed, true);
  assert.equal(result.researchId, INITIAL_RUN_ID);
  assert.equal(result.previousRunId, INITIAL_RUN_ID);
  assert.notEqual(result.currentRunId, INITIAL_RUN_ID);
  assert.equal(result.addedKeywordCount, 1);
  assert.equal(result.duplicateKeywordCount, 1);

  const currentLocation = await resolveRunLocation(root, result.currentRunId);
  assert.equal(currentLocation.researchDirectory, source.researchDirectory);
  assert.notEqual(currentLocation.discoveryDirectory, source.discoveryDirectory);

  const combined = RunStore.openReadOnly(join(currentLocation.discoveryDirectory, 'run.sqlite'));
  try {
    const run = combined.loadRun(result.currentRunId);
    assert.ok(run);
    assert.equal(run.state, 'created');
    assert.equal(run.lookups, 3);
    const keywords = combined.loadKeywords(result.currentRunId);
    assert.deepEqual(
      keywords.map((keyword) => [keyword.normalizedKeyword, keyword.status]),
      [
        ['favicon generator', 'completed'],
        ['favicon maker', 'completed'],
        ['favicon checker', 'completed'],
        ['favicon converter', 'pending'],
      ],
    );
    assert.equal(keywords[2]?.sources[0]?.type, 'surfer_related');

    const duplicateSources = keywords[1]?.sources as BatchAwareSource[] | undefined;
    assert.equal(duplicateSources?.length, 2);
    assert.equal(duplicateSources?.[1]?.type, 'seed');
    assert.equal(duplicateSources?.[1]?.batchId, 'batch-0002');
    assert.equal(duplicateSources?.[1]?.inputPath, 'batches/batch-0002.csv');
    assert.deepEqual(duplicateSources?.[1]?.rowNumbers, [2]);

    const newSources = keywords[3]?.sources as BatchAwareSource[] | undefined;
    assert.equal(newSources?.length, 1);
    assert.equal(newSources?.[0]?.type, 'seed');
    assert.equal(newSources?.[0]?.batchId, 'batch-0002');
    assert.equal(newSources?.[0]?.inputPath, 'batches/batch-0002.csv');
    assert.deepEqual(newSources?.[0]?.rowNumbers, [3]);

    assert.equal(combined.loadSerpRows(result.currentRunId).length, 1);
    const related = combined.loadRelatedKeywords(result.currentRunId);
    assert.equal(related.length, 1);
    assert.equal(related[0]?.relatedKeyword, 'favicon checker');
    const domains = combined.loadDomains(result.currentRunId);
    assert.equal(domains.length, 1);
    assert.equal(domains[0]?.domain, 'example.com');
    assert.equal(domains[0]?.dr, 12);
    assert.equal(domains[0]?.source, 'fresh');
  } finally {
    combined.close();
  }

  const original = RunStore.openReadOnly(join(source.discoveryDirectory, 'run.sqlite'));
  try {
    assert.equal(original.loadRun(INITIAL_RUN_ID)?.state, 'completed');
    assert.equal(original.loadKeywords(INITIAL_RUN_ID).length, 3);
  } finally {
    original.close();
  }

  const manifest = await readResearchContainer(source.researchDirectory);
  assert.ok(manifest);
  assert.equal(manifest.researchId, INITIAL_RUN_ID);
  assert.equal(manifest.currentRunId, result.currentRunId);
  assert.equal(manifest.batches.length, 2);
  assert.equal(manifest.batches[0]?.inputUniqueKeywordCount, 2);
  assert.equal(manifest.batches[1]?.addedKeywordCount, 1);
  assert.deepEqual(manifest.batches[1]?.normalizedKeywords, ['favicon maker', 'favicon converter']);
  assert.deepEqual(manifest.batches[1]?.newNormalizedKeywords, ['favicon converter']);
  const storedPath = manifest.batches[1]?.input.storedPath;
  assert.ok(storedPath);
  assert.equal(await readFile(join(source.researchDirectory, storedPath), 'utf8'), 'keyword\nfavicon maker\nfavicon converter\n');
});

test('repeated append through the stable initial research id forks from currentRunId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-batches-repeat-'));
  const source = await createCompletedResearch(root);
  const secondInput = join(root, 'batch-2.csv');
  await writeFile(secondInput, 'keyword\nfavicon converter\n', 'utf8');
  const second = await prepareResearchAppend({
    outputRoot: root,
    targetRunId: INITIAL_RUN_ID,
    seedsPath: secondInput,
    seeds: [{ keyword: 'favicon converter', normalizedKeyword: 'favicon converter', sourceRows: [2] }],
    now: () => new Date('2026-08-30T01:00:00.000Z'),
  });
  assert.equal(second.changed, true);
  await finishPendingKeywords(root, second.currentRunId);

  const thirdInput = join(root, 'batch-3.csv');
  await writeFile(thirdInput, 'keyword\nfavicon converter\nfavicon extractor\n', 'utf8');
  const third = await prepareResearchAppend({
    outputRoot: root,
    // Deliberately use the stable initial id instead of the latest run id.
    targetRunId: INITIAL_RUN_ID,
    seedsPath: thirdInput,
    seeds: [
      { keyword: 'favicon converter', normalizedKeyword: 'favicon converter', sourceRows: [2] },
      { keyword: 'favicon extractor', normalizedKeyword: 'favicon extractor', sourceRows: [3] },
    ],
    now: () => new Date('2026-08-30T02:00:00.000Z'),
  });

  assert.equal(third.changed, true);
  assert.equal(third.researchId, INITIAL_RUN_ID);
  assert.equal(third.previousRunId, second.currentRunId);
  assert.notEqual(third.currentRunId, second.currentRunId);
  assert.equal(third.addedKeywordCount, 1);
  assert.equal(third.duplicateKeywordCount, 1);

  const current = await resolveRunLocation(root, third.currentRunId);
  assert.equal(current.researchDirectory, source.researchDirectory);
  const store = RunStore.openReadOnly(join(current.discoveryDirectory, 'run.sqlite'));
  try {
    assert.deepEqual(
      store.loadKeywords(third.currentRunId).map((keyword) => [keyword.normalizedKeyword, keyword.status]),
      [
        ['favicon generator', 'completed'],
        ['favicon maker', 'completed'],
        ['favicon checker', 'completed'],
        ['favicon converter', 'completed'],
        ['favicon extractor', 'pending'],
      ],
    );
  } finally {
    store.close();
  }

  const manifest = await readResearchContainer(source.researchDirectory);
  assert.ok(manifest);
  assert.equal(manifest.currentRunId, third.currentRunId);
  assert.equal(manifest.batches.length, 3);
  assert.equal(manifest.batches[1]?.resultRunId, second.currentRunId);
  assert.equal(manifest.batches[2]?.resultRunId, third.currentRunId);
  assert.equal(manifest.batches[2]?.batchId, 'batch-0003');
});

test('all-duplicate batch is recorded without creating another discovery run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-batches-duplicates-'));
  const source = await createCompletedResearch(root);
  const appendInput = join(root, 'duplicates.csv');
  await writeFile(appendInput, 'keyword\nfavicon maker\n', 'utf8');

  const result = await prepareResearchAppend({
    outputRoot: root,
    targetRunId: INITIAL_RUN_ID,
    seedsPath: appendInput,
    seeds: [{ keyword: 'favicon maker', normalizedKeyword: 'favicon maker', sourceRows: [2] }],
    now: () => new Date('2026-08-30T02:00:00.000Z'),
  });

  assert.equal(result.changed, false);
  assert.equal(result.currentRunId, INITIAL_RUN_ID);
  assert.equal(result.addedKeywordCount, 0);
  assert.equal(result.duplicateKeywordCount, 1);
  const manifest = await readResearchContainer(source.researchDirectory);
  assert.ok(manifest);
  assert.equal(manifest.batches.length, 2);
  assert.equal(manifest.batches[1]?.resultRunId, INITIAL_RUN_ID);
  const storedPath = manifest.batches[1]?.input.storedPath;
  assert.ok(storedPath);
  await access(join(source.researchDirectory, storedPath));
});

test('research batch lock rejects concurrent append and is reusable after release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-batches-lock-'));
  await createCompletedResearch(root);
  const first = await acquireResearchBatchLock(root, INITIAL_RUN_ID);
  await assert.rejects(
    () => acquireResearchBatchLock(root, INITIAL_RUN_ID),
    (error: unknown) =>
      error instanceof ResearchError
      && error.code === 'OUTPUT_WRITE_ERROR'
      && error.message.includes('already running'),
  );
  await first.release();
  await first.release();
  const second = await acquireResearchBatchLock(root, INITIAL_RUN_ID);
  await second.release();
});
