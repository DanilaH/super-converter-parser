import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore, type StoredKeyword } from '../db/store.js';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { createRunId } from './run.js';
import { writeSnapshots } from './snapshots.js';
import type { SerpResult } from '../google/serp.js';
import { executeRun, type EngineHooks, type ExecuteRunOptions } from './engine.js';
import { CacheStore, type KeywordCache } from '../cache/store.js';
import { buildKeywordCacheKey, keywordCacheIdentity } from '../cache/keys.js';
import { ResearchError } from '../shared/errors.js';
import type { CollectionResult } from '../browser/collect.js';
import type { KeywordRecord } from './run.js';

const BASE_CONFIG = loadConfig({});
const INPUT = { kind: 'seeds' as const, path: 'input/seeds.csv' };
const IDENTITY = keywordCacheIdentity(BASE_CONFIG);

const KEYWORDS: SeedKeyword[] = buildSeedKeywords([
  { keyword: 'compare lists', rowNumber: 1 },
  { keyword: 'best office chairs', rowNumber: 2 },
  { keyword: 'standing desk', rowNumber: 3 },
  { keyword: 'ergonomic mouse', rowNumber: 4 },
]);

function makeHooks(overrides: Partial<EngineHooks> = {}): EngineHooks {
  return {
    sleep: async () => undefined,
    now: () => Date.now(),
    random: () => 0.5,
    logger: () => undefined,
    pauseRequested: () => false,
    ...overrides,
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
    serpRows: [
      { keyword: keyword.normalizedKeyword, position: 1, title: 't1', url: 'https://a.com', hostname: 'a.com', resultType: 'organic' },
      { keyword: keyword.normalizedKeyword, position: 2, title: 't2', url: 'https://b.com', hostname: 'b.com', resultType: 'organic' },
    ],
    debugArtifactPath: null,
  };
}

function baseOptions(
  store: RunStore,
  runId: string,
  runDirectory: string,
  cache: KeywordCache,
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
    hooks: makeHooks(),
    cache: { store: cache, forceRefresh: false, refreshKeywords: new Set() },
    ...extra,
  };
}

test('keywords.csv follows the operator column contract with zero vs missing values', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'csv-keywords-'));
  store.createRun({
    runId,
    configSnapshot: BASE_CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.2.0' },
    input: INPUT,
    keywords: KEYWORDS,
  });
  const keywords = store.loadKeywords(runId);

  // Row 1: completed keyword with full Surfer/Google data and a detected
  // location that itself contains a comma.
  store.commitKeyword(
    runId,
    {
      ...(keywords[0] as StoredKeyword),
      status: 'completed',
      surfer: { volume: 49500, cpc: 7.9, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=compare+lists',
        detectedLocation: 'Moscow, Russia',
        geoWarning: true,
      },
      error: null,
      collectedAt: '2026-01-01T00:00:00.000Z',
    },
    [
      { keyword: 'compare lists', position: 1, title: 'a', url: 'https://a.com', hostname: 'a.com', resultType: 'organic' },
      { keyword: 'compare lists', position: 2, title: 'b', url: 'https://b.com', hostname: 'b.com', resultType: 'organic' },
    ],
    'hit',
  );
  // Row 2: zero volume is a real number, no Surfer CPC is a missing value,
  // and there are no organic results for this keyword.
  store.commitKeyword(
    runId,
    {
      ...(keywords[1] as StoredKeyword),
      status: 'completed',
      surfer: { volume: 0, cpc: null, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: null,
      error: null,
      collectedAt: '2026-01-01T00:00:00.000Z',
    },
    [],
    'miss',
  );
  // Row 3: failed keyword carries its error and stays terminal in the CSV.
  store.commitKeyword(
    runId,
    {
      ...(keywords[2] as StoredKeyword),
      status: 'failed',
      surfer: null,
      google: null,
      error: { code: 'SURFER_PARSE_ERROR', message: 'widget not found' },
      collectedAt: '2026-01-01T00:00:00.000Z',
    },
    [],
    'miss',
  );
  await writeSnapshots(store, runId, runDirectory, 'running');

  const csv = await readFile(join(runDirectory, 'keywords.csv'), 'utf8');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.equal(
    csv.slice(1).split('\r\n')[0],
    'keyword,normalized_keyword,source_rows,surfer_volume,surfer_cpc,surfer_market,google_hl,google_gl,google_url,detected_google_location,geo_warning,organic_result_count,status,error_code,error_message,cache_status,collected_at',
  );
  const lines = csv.slice(1).split('\r\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 5, 'header + 4 keyword rows');

  // Row 1: full data, provenance, organic count, cache provenance; the comma
  // inside the detected location is RFC 4180-quoted.
  assert.equal(
    lines[1],
    'compare lists,compare lists,1,49500,7.9,US,en,us,https://google.com/search?q=compare+lists,"Moscow, Russia",true,2,completed,,,hit,2026-01-01T00:00:00.000Z',
  );
  // Row 2: zero volume stays a number, zero organic results stays a number,
  // missing cpc/google fields are empty cells.
  assert.equal(
    lines[2],
    'best office chairs,best office chairs,2,0,,US,,,,,,0,completed,,,miss,2026-01-01T00:00:00.000Z',
  );
  // Row 3: failed keywords carry their error; no Surfer data means empty.
  assert.equal(
    lines[3],
    'standing desk,standing desk,3,,,,,,,,,0,failed,SURFER_PARSE_ERROR,widget not found,miss,2026-01-01T00:00:00.000Z',
  );
  // Row 4: pending keywords have no data yet and no organic count.
  assert.equal(lines[4], 'ergonomic mouse,ergonomic mouse,4,,,,,,,,,,pending,,,,');
  store.close();
});

test('serp.csv has one row per stored organic result in input and position order', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'csv-serp-'));
  store.createRun({
    runId,
    configSnapshot: BASE_CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.2.0' },
    input: INPUT,
    keywords: KEYWORDS,
  });
  const keywords = store.loadKeywords(runId);
  const serp: SerpResult[] = [
    { keyword: 'standing desk', position: 2, title: 'b', url: 'https://b.com', hostname: 'b.com', resultType: 'organic' },
    { keyword: 'standing desk', position: 1, title: 'a', url: 'https://a.com', hostname: 'a.com', resultType: 'organic' },
  ];
  store.commitKeyword(
    runId,
    {
      ...(keywords[2] as StoredKeyword),
      status: 'completed',
      surfer: null,
      google: null,
      error: null,
      collectedAt: '2026-01-01T00:00:00.000Z',
    },
    serp,
    'miss',
  );
  await writeSnapshots(store, runId, runDirectory, 'completed');

  const csv = await readFile(join(runDirectory, 'serp.csv'), 'utf8');
  const lines = csv.slice(1).split('\r\n').filter((line) => line.length > 0);
  assert.equal(lines[0], 'keyword,position,title,url,hostname,result_type');
  // Rows are reordered by position, and only keywords with organic results
  // contribute rows (no fabricated rows for the other three keywords).
  assert.deepEqual(lines.slice(1), [
    'standing desk,1,a,https://a.com,a.com,organic',
    'standing desk,2,b,https://b.com,b.com,organic',
  ]);
  store.close();
});

test('source_rows concatenates duplicate seed rows deterministically', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'csv-sources-'));
  const duplicateSeeds = buildSeedKeywords([
    { keyword: 'compare lists', rowNumber: 8 },
    { keyword: 'compare lists', rowNumber: 2 },
    { keyword: 'compare lists', rowNumber: 5 },
    { keyword: 'Compare  Lists', rowNumber: 2 },
  ]);
  store.createRun({
    runId,
    configSnapshot: BASE_CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.2.0' },
    input: INPUT,
    keywords: duplicateSeeds,
  });
  await writeSnapshots(store, runId, runDirectory, 'running');

  const csv = await readFile(join(runDirectory, 'keywords.csv'), 'utf8');
  const lines = csv.slice(1).split('\r\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 2, 'one canonical keyword row');
  assert.ok(lines[1]?.startsWith('compare lists,compare lists,2|5|8,'), lines[1]);
  store.close();
});

test('a CSV snapshot failure leaves the run resumable and a resume republishes all artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'csv-fail-resume-'));
  const runDirectory = join(directory, 'run');
  await mkdir(runDirectory);
  const store = RunStore.open(join(runDirectory, 'run.sqlite'));
  const cache = CacheStore.openInMemory();
  const runId = createRunId();

  // Prime the cache for the three keywords that remain pending after the
  // first (failing) publish, so the resume runs purely from cache.
  for (const keyword of KEYWORDS.slice(1)) {
    cache.putKeyword({
      cacheKey: buildKeywordCacheKey(keyword.normalizedKeyword, IDENTITY),
      keyword: keyword.keyword,
      normalizedKeyword: keyword.normalizedKeyword,
      identity: IDENTITY,
      record: {
        id: 'cached',
        keyword: keyword.keyword,
        normalizedKeyword: keyword.normalizedKeyword,
        sources: [],
        status: 'completed',
        surfer: { volume: 100, cpc: 1.5, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
        google: null,
        error: null,
      },
      serpRows: [
        { keyword: keyword.normalizedKeyword, position: 1, title: 'cached', url: 'https://cached.com', hostname: 'cached.com', resultType: 'organic' },
      ],
      collectedAt: '2026-01-01T00:00:00.000Z',
      storedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  }

  // A directory at the keywords.csv path makes the first snapshot publish
  // fail after the JSON artifacts were written.
  const blocker = join(runDirectory, 'keywords.csv');
  await mkdir(blocker);

  await assert.rejects(
    () => executeRun(baseOptions(store, runId, runDirectory, cache, {})),
    (error: unknown) => error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR',
  );
  // The run never became terminal: it stays resumable and the first keyword
  // was committed before the failing publish.
  assert.equal(store.loadRun(runId)?.state, 'running');
  assert.equal(
    store.loadKeywords(runId).filter((keyword) => keyword.status === 'completed').length,
    1,
  );
  // No partially-written target: the blocked path is still a directory and no
  // temp files remain anywhere in the run directory.
  assert.equal(await readdir(blocker).then(() => true), true);
  const leftovers = (await readdir(runDirectory)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);

  // Remove the blocker and resume: CSV artifacts are republished from the
  // current checkpoint; the remaining keywords come from cache, so no new
  // browser lookups happen.
  await rm(blocker, { recursive: true, force: true });
  const outcome = await executeRun(
    baseOptions(store, runId, runDirectory, cache, { mode: 'resume', keywords: [] }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.state, 'completed');
  assert.equal(store.loadRun(runId)?.lookups, 1, 'only the first keyword was ever collected');

  const csv = await readFile(join(runDirectory, 'keywords.csv'), 'utf8');
  const lines = csv.slice(1).split('\r\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 5, 'header + all 4 keyword rows after resume');
  // The first keyword was collected in the first attempt: fresh data with a
  // live collectedAt and the SERP count from the run checkpoint.
  assert.ok(
    lines[1]?.startsWith('compare lists,compare lists,1,100,1.5,US,en,us,https://google.com/search?q=x,,false,2,completed,,,miss,') &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(lines[1]!.split(',').at(-1) ?? ''),
    lines[1],
  );
  // The remaining three keywords came from cache after the resume.
  for (const line of lines.slice(2, 5)) {
    assert.ok(line.endsWith(',1,completed,,,hit,2026-01-01T00:00:00.000Z'), line);
  }
  assert.ok(await readFile(join(runDirectory, 'serp.csv'), 'utf8').then((content) => content.length > 0));
  store.close();
  cache.close();
});

test('cached runs serialize through the same CSV contract as fresh runs', async () => {
  const store = RunStore.openInMemory();
  const cache = CacheStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'csv-cached-'));
  for (const keyword of KEYWORDS) {
    cache.putKeyword({
      cacheKey: buildKeywordCacheKey(keyword.normalizedKeyword, IDENTITY),
      keyword: keyword.keyword,
      normalizedKeyword: keyword.normalizedKeyword,
      identity: IDENTITY,
      record: {
        id: 'cached',
        keyword: keyword.keyword,
        normalizedKeyword: keyword.normalizedKeyword,
        sources: [],
        status: 'completed',
        surfer: { volume: 49500, cpc: 7.9, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
        google: {
          hl: 'en',
          gl: 'us',
          pageUrl: 'https://google.com/search?q=cached',
          detectedLocation: null,
          geoWarning: false,
        },
        error: null,
      },
      serpRows: [
        { keyword: keyword.normalizedKeyword, position: 1, title: 'cached title', url: 'https://cached.com', hostname: 'cached.com', resultType: 'organic' },
      ],
      collectedAt: '2026-01-01T00:00:00.000Z',
      storedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  }
  const outcome = await executeRun(baseOptions(store, runId, runDirectory, cache, {}));
  assert.equal(outcome.kind, 'finished');
  assert.equal(store.loadRun(runId)?.lookups, 0);

  const csv = await readFile(join(runDirectory, 'keywords.csv'), 'utf8');
  const lines = csv.slice(1).split('\r\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 5);
  assert.ok(
    lines[1]?.startsWith('compare lists,compare lists,1,49500,7.9,US,en,us,https://google.com/search?q=cached,') &&
      lines[1]?.endsWith(',1,completed,,,hit,2026-01-01T00:00:00.000Z'),
    lines[1],
  );
  const serp = await readFile(join(runDirectory, 'serp.csv'), 'utf8');
  assert.ok(serp.includes('compare lists,1,cached title,https://cached.com,cached.com,organic'));
  store.close();
  cache.close();
});

test('a partial keyword appears in keywords.csv with its organic count', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'csv-partial-'));
  store.createRun({
    runId,
    configSnapshot: BASE_CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.2.0' },
    input: INPUT,
    keywords: KEYWORDS,
  });
  const keywords = store.loadKeywords(runId);
  store.commitKeyword(
    runId,
    {
      ...(keywords[0] as StoredKeyword),
      status: 'partial',
      surfer: { volume: 49500, cpc: 7.9, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: null,
      error: null,
      collectedAt: '2026-01-01T00:00:00.000Z',
    },
    [
      { keyword: 'compare lists', position: 1, title: 'a', url: 'https://a.com', hostname: 'a.com', resultType: 'organic' },
      { keyword: 'compare lists', position: 2, title: 'b', url: 'https://b.com', hostname: 'b.com', resultType: 'organic' },
      { keyword: 'compare lists', position: 3, title: 'c', url: 'https://c.com', hostname: 'c.com', resultType: 'organic' },
    ],
    'miss',
  );
  await writeSnapshots(store, runId, runDirectory, 'running');

  const csv = await readFile(join(runDirectory, 'keywords.csv'), 'utf8');
  const lines = csv.slice(1).split('\r\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 5, 'header + 4 keyword rows, only the first is committed');
  // Partial keywords are terminal: they carry their Surfer data and the
  // organic count from the checkpoint, with empty Google/error cells.
  assert.equal(
    lines[1],
    'compare lists,compare lists,1,49500,7.9,US,,,,,,3,partial,,,miss,2026-01-01T00:00:00.000Z',
  );
  store.close();
});

test('an atomic snapshot failure leaves the previously published CSV intact', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'csv-atomic-preserve-'));
  store.createRun({
    runId,
    configSnapshot: BASE_CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.2.0' },
    input: INPUT,
    keywords: KEYWORDS,
  });
  const keywords = store.loadKeywords(runId);
  store.commitKeyword(
    runId,
    {
      ...(keywords[0] as StoredKeyword),
      status: 'completed',
      surfer: { volume: 49500, cpc: 7.9, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=compare+lists',
        detectedLocation: null,
        geoWarning: false,
      },
      error: null,
      collectedAt: '2026-01-01T00:00:00.000Z',
    },
    [
      { keyword: 'compare lists', position: 1, title: 'a', url: 'https://a.com', hostname: 'a.com', resultType: 'organic' },
      { keyword: 'compare lists', position: 2, title: 'b', url: 'https://b.com', hostname: 'b.com', resultType: 'organic' },
    ],
    'hit',
  );

  // First publish succeeds and produces the previously published artifact.
  await writeSnapshots(store, runId, runDirectory, 'running');
  const published = await readFile(join(runDirectory, 'keywords.csv'), 'utf8');
  await writeFile(join(runDirectory, 'keywords.csv.old'), published, 'utf8');

  // Block the next publish at the keywords.csv path: a directory at the
  // target makes the atomic rename fail, exactly like a blocked artifact
  // location. The previously published file is moved out of the way first.
  await rm(join(runDirectory, 'keywords.csv'));
  const blocker = join(runDirectory, 'keywords.csv');
  await mkdir(blocker);

  await assert.rejects(
    () => writeSnapshots(store, runId, runDirectory, 'running'),
    (error: unknown) => error instanceof ResearchError && error.code === 'OUTPUT_WRITE_ERROR',
  );

  // The previously published CSV is untouched, no partial file or temp file
  // leaked, and the run stays resumable (manifestless snapshot).
  assert.equal(await readFile(join(runDirectory, 'keywords.csv.old'), 'utf8'), published);
  const leftovers = (await readdir(runDirectory)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  // The run never reached a terminal state, so it stays resumable even though
  // the snapshot publish failed.
  assert.equal(store.loadRun(runId)?.state, 'created');

  // Removing the block and republishing succeeds and restores keywords.csv
  // from the current checkpoint; the preserved copy is still readable.
  await rm(blocker, { recursive: true, force: true });
  await writeSnapshots(store, runId, runDirectory, 'completed');
  assert.equal(await readFile(join(runDirectory, 'keywords.csv'), 'utf8'), published);
  assert.equal(await readFile(join(runDirectory, 'keywords.csv.old'), 'utf8'), published);
  store.close();
});