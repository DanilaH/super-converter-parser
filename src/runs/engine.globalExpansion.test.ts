import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CollectionResult, SurferRelatedOutcome } from '../browser/collect.js';
import { loadConfig, type ResearchConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { ResearchError } from '../shared/errors.js';
import type { SurferRelatedKeyword } from '../surfer/parser.js';
import { executeRun, type EngineHooks } from './engine.js';
import { withCurrentExpansionAdmission } from './expansionRuntime.js';
import { createRunId, type KeywordRecord } from './run.js';
import type { SerpResult } from '../google/serp.js';

const BASE_CONFIG = loadConfig({});
const INPUT = { kind: 'seeds' as const, path: 'input/seeds.csv' };
const ROOTS: SeedKeyword[] = buildSeedKeywords([
  { keyword: 'compare google sheets', rowNumber: 1 },
  { keyword: 'merge spreadsheet columns', rowNumber: 2 },
]);

const GOOGLE_META = {
  hl: 'en',
  gl: 'us',
  pageUrl: 'https://google.com/search?q=x',
  detectedLocation: null,
  geoWarning: false,
};

function globalConfig(): ResearchConfig {
  return {
    ...BASE_CONFIG,
    expansion: withCurrentExpansionAdmission({
      ...BASE_CONFIG.expansion,
      enabled: true,
      depth: 1,
      maxCandidatesPerKeyword: 20,
      minOverlap: 0,
      minVolume: 0,
    }),
  };
}

function makeHooks(pauseRequested: () => boolean = () => false): EngineHooks {
  return {
    sleep: async () => undefined,
    now: () => Date.now(),
    random: () => 0.5,
    logger: () => undefined,
    pauseRequested,
  };
}

function serpRowsFor(keyword: string): SerpResult[] {
  return [{
    keyword,
    position: 1,
    title: `title for ${keyword}`,
    url: 'https://example.com/tool',
    hostname: 'example.com',
    registrableDomain: 'example.com',
    dr: null,
    drStatus: null,
    resultType: 'organic' as const,
  }];
}

function collected(
  keyword: KeywordRecord,
  related: SurferRelatedKeyword[],
): CollectionResult {
  const relatedOutcome: SurferRelatedOutcome = related.length === 0
    ? { status: 'empty', error: null, rows: [] }
    : { status: 'ok', error: null, rows: related };
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-09-03T00:00:00.000Z' },
      google: { ...GOOGLE_META },
      error: null,
    },
    serpRows: serpRowsFor(keyword.normalizedKeyword),
    debugArtifactPath: null,
    related: relatedOutcome,
  };
}

function relatedFor(keyword: string): SurferRelatedKeyword[] {
  if (keyword === 'compare google sheets' || keyword === 'merge spreadsheet columns') {
    return [
      { keyword: 'sheets', normalizedKeyword: 'sheets', overlap: 100, volume: 1_000_000 },
      { keyword: 'compare sheet columns', normalizedKeyword: 'compare sheet columns', overlap: 80, volume: 5_000 },
    ];
  }
  return [];
}

test('V1 collects every root before materializing and collecting the global expansion frontier', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-global-expand-'));
  const calls: string[] = [];

  const outcome = await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: ROOTS,
    config: globalConfig(),
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (keyword) => {
      calls.push(keyword.normalizedKeyword);
      return collected(keyword, relatedFor(keyword.normalizedKeyword));
    },
    hooks: makeHooks(),
  });

  assert.equal(outcome.kind, 'finished');
  assert.deepEqual(calls, [
    'compare google sheets',
    'merge spreadsheet columns',
    'compare sheet columns',
  ]);

  const keywords = store.loadKeywords(runId);
  assert.equal(keywords.some((keyword) => keyword.normalizedKeyword === 'sheets'), false);
  const admitted = keywords.find((keyword) => keyword.normalizedKeyword === 'compare sheet columns');
  assert.ok(admitted);
  assert.equal(admitted.sources.filter((source) => source.type === 'surfer_related').length, 2);

  const related = store.loadRelatedKeywords(runId);
  assert.ok(related.filter((row) => row.relatedKeyword === 'compare sheet columns').every((row) => row.selectedForExpansion));
  assert.ok(related.filter((row) => row.relatedKeyword === 'sheets').every((row) => !row.selectedForExpansion));

  const report = JSON.parse(await readFile(join(runDirectory, 'expansion-admission.json'), 'utf8')) as {
    version: string;
    finalSelectedCount: number;
  };
  assert.equal(report.version, 'v1');
  assert.equal(report.finalSelectedCount, 1);
  store.close();
});

test('V1 pause after the last root resumes from durable Related evidence before collecting children', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-global-resume-'));
  let pause = false;
  let rootCollections = 0;

  const firstOutcome = await executeRun({
    store,
    runId,
    mode: 'fresh',
    keywords: ROOTS,
    config: globalConfig(),
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (keyword) => {
      if (keyword.sources.every((source) => source.type !== 'surfer_related')) {
        rootCollections += 1;
        if (rootCollections === ROOTS.length) pause = true;
      }
      return collected(keyword, relatedFor(keyword.normalizedKeyword));
    },
    hooks: makeHooks(() => pause),
  });

  assert.equal(firstOutcome.kind, 'paused');
  assert.equal(rootCollections, 2);
  assert.equal(store.loadKeywords(runId).length, 2);
  assert.equal(store.loadRelatedKeywords(runId).length, 4);

  pause = false;
  const resumeCalls: string[] = [];
  const secondOutcome = await executeRun({
    store,
    runId,
    mode: 'resume',
    keywords: ROOTS,
    config: globalConfig(),
    input: INPUT,
    runDirectory,
    debugRoot: join(runDirectory, 'debug'),
    collect: async (keyword) => {
      resumeCalls.push(keyword.normalizedKeyword);
      return collected(keyword, []);
    },
    hooks: makeHooks(),
  });

  assert.equal(secondOutcome.kind, 'finished');
  assert.deepEqual(resumeCalls, ['compare sheet columns']);
  assert.equal(rootCollections, 2);
  assert.equal(store.loadKeywords(runId).some((keyword) => keyword.normalizedKeyword === 'sheets'), false);
  assert.equal(store.loadRun(runId)?.state, 'completed');
  store.close();
});

test('unknown expansion admission version fails before a fresh run is created', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-global-version-'));
  const config: ResearchConfig = {
    ...BASE_CONFIG,
    expansion: {
      ...BASE_CONFIG.expansion,
      enabled: true,
      admissionVersion: 'v999',
    } as ResearchConfig['expansion'],
  };

  await assert.rejects(
    executeRun({
      store,
      runId,
      mode: 'fresh',
      keywords: ROOTS,
      config,
      input: INPUT,
      runDirectory,
      debugRoot: join(runDirectory, 'debug'),
      collect: async (keyword) => collected(keyword, []),
      hooks: makeHooks(),
    }),
    (error: unknown) => error instanceof ResearchError && error.code === 'RESUME_CONFIG_MISMATCH',
  );
  assert.equal(store.loadRun(runId), null);
  store.close();
});
