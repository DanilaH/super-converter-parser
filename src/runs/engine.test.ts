import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { loadConfig, type ResearchConfig } from '../config/config.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import {
  executeRun,
  validateResume,
  type EngineHooks,
} from './engine.js';
import { createRunId, type KeywordRecord } from './run.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { ResearchError } from '../shared/errors.js';
import type { CollectionResult } from '../browser/collect.js';
import type { SerpResult } from '../google/serp.js';

const BASE_CONFIG = loadConfig({});
const INPUT = { kind: 'seeds' as const, path: 'input/seeds.csv' };

const KEYWORDS: SeedKeyword[] = buildSeedKeywords([
  { keyword: 'compare lists', rowNumber: 1 },
  { keyword: 'best office chairs', rowNumber: 2 },
  { keyword: 'standing desk', rowNumber: 3 },
  { keyword: 'ergonomic mouse', rowNumber: 4 },
]);

function testConfig(overrides: Partial<ResearchConfig>): ResearchConfig {
  return { ...BASE_CONFIG, ...overrides };
}

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

function serpRowsFor(keyword: string, count: number): SerpResult[] {
  return Array.from({ length: count }, (_, index) => ({
    keyword,
    position: index + 1,
    title: `title ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    hostname: 'example.com',
    resultType: 'organic' as const,
  }));
}

const GOOGLE_META = {
  hl: 'en',
  gl: 'us',
  pageUrl: 'https://google.com/search?q=x',
  detectedLocation: null,
  geoWarning: false,
} as const;

function okResult(keyword: KeywordRecord, serpCount = 2): CollectionResult {
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
      google: { ...GOOGLE_META },
      error: null,
    },
    serpRows: serpRowsFor(keyword.normalizedKeyword, serpCount),
    debugArtifactPath: null,
  };
}

function googleFailResult(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'partial',
      surfer: {
        volume: 50,
        cpc: null,
        market: 'US',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
      google: { ...GOOGLE_META },
      error: { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'zero organic rows' },
    },
    serpRows: [],
    debugArtifactPath: null,
  };
}

function surferFailResult(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'failed',
      surfer: null,
      google: { ...GOOGLE_META },
      error: { code: 'SURFER_PARSE_ERROR', message: 'widget not found' },
    },
    serpRows: [],
    debugArtifactPath: null,
  };
}

function transientFailResult(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'failed',
      surfer: null,
      google: { ...GOOGLE_META },
      error: { code: 'GOOGLE_UNAVAILABLE', message: 'network error' },
    },
    serpRows: [],
    debugArtifactPath: null,
  };
}

function baseOptions(
  store: RunStore,
  runId: string,
  runDirectory: string,
  extra: Partial<Parameters<typeof executeRun>[0]> = {},
): Parameters<typeof executeRun>[0] {
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
    ...extra,
  };
}

test('pause after two keywords; resume collects only the remaining two', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-pause-'));
  const calls: string[] = [];
  const first = await executeRun(
    baseOptions(store, runId, runDirectory, {
      collect: async (keyword) => {
        calls.push(keyword.normalizedKeyword);
        return okResult(keyword);
      },
      hooks: makeHooks({ pauseRequested: () => calls.length >= 2 }),
    }),
  );
  assert.deepEqual(first, { kind: 'paused', reason: 'SIGINT received; run paused safely.' });
  assert.deepEqual(calls, ['compare lists', 'best office chairs']);

  const keywords = store.loadKeywords(runId);
  assert.equal(keywords.filter((k) => k.status === 'completed').length, 2);
  assert.equal(keywords.filter((k) => k.status === 'pending').length, 2);
  assert.equal(store.loadRun(runId)?.state, 'paused');

  const manifest = JSON.parse(
    await readFile(join(runDirectory, 'manifest.json'), 'utf8'),
  ) as { state: string; progress: { completedKeywords: number; totalKeywords: number } };
  assert.equal(manifest.state, 'paused');
  assert.equal(manifest.progress.completedKeywords, 2);
  assert.equal(manifest.progress.totalKeywords, 4);

  const resumeCalls: string[] = [];
  const second = await executeRun(
    baseOptions(store, runId, runDirectory, {
      mode: 'resume',
      keywords: [],
      collect: async (keyword) => {
        resumeCalls.push(keyword.normalizedKeyword);
        return okResult(keyword);
      },
    }),
  );
  assert.equal(second.kind, 'finished');
  assert.equal(second.state, 'completed');
  assert.deepEqual(resumeCalls, ['standing desk', 'ergonomic mouse']);
  assert.equal(store.loadRun(runId)?.lookups, 4);
  assert.equal(store.loadSerpRows(runId).length, 8);
  store.close();
});

test('stale running keywords reset to pending on resume', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-stale-'));
  await executeRun(
    baseOptions(store, runId, runDirectory, {
      hooks: makeHooks({ pauseRequested: () => true }),
    }),
  );

  const stuck = store.loadKeyword(runId, 0) as NonNullable<ReturnType<RunStore['loadKeyword']>>;
  store.updateKeyword(runId, { ...stuck, status: 'running' });

  const logs: string[] = [];
  const outcome = await executeRun(
    baseOptions(store, runId, runDirectory, {
      mode: 'resume',
      keywords: [],
      hooks: makeHooks({ logger: (line) => logs.push(line) }),
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.state, 'completed');
  assert.ok(logs.some((line) => line.includes('stale running keyword(s) reset to pending')));
  assert.equal(store.loadKeyword(runId, 0)?.status, 'completed');
  assert.equal(store.loadRun(runId)?.lookups, 4);
  store.close();
});

test('resume does not re-collect terminal keywords', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  store.createRun({
    runId,
    configSnapshot: BASE_CONFIG,
    parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
    input: INPUT,
    keywords: KEYWORDS,
  });
  const finished: Array<['completed' | 'partial' | 'failed', number]> = [
    ['completed', 0],
    ['partial', 1],
    ['failed', 2],
  ];
  for (const [status, idx] of finished) {
    const keyword = store.loadKeyword(runId, idx) as NonNullable<
      ReturnType<RunStore['loadKeyword']>
    >;
    store.updateKeyword(runId, { ...keyword, status, collectedAt: '2026-01-01T00:00:00.000Z' });
  }
  store.setRunState(runId, 'paused');

  const calls: string[] = [];
  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'engine-terminal-')), {
      mode: 'resume',
      keywords: [],
      collect: async (keyword) => {
        calls.push(keyword.normalizedKeyword);
        return okResult(keyword);
      },
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.state, 'completed_with_errors');
  assert.deepEqual(calls, ['ergonomic mouse']);
  store.close();
});

test('each keyword is committed before the next one starts', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-checkpoint-'));
  let collected = 0;
  const outcome = await executeRun(
    baseOptions(store, runId, runDirectory, {
      collect: async (keyword) => {
        if (collected > 0) {
          const previous = store.loadKeyword(runId, collected - 1) as NonNullable<
            ReturnType<RunStore['loadKeyword']>
          >;
          assert.equal(previous.status, 'completed');
          assert.ok(previous.collectedAt);
          assert.equal(store.loadSerpRows(runId).length, collected * 2);
          const manifest = JSON.parse(
            await readFile(join(runDirectory, 'manifest.json'), 'utf8'),
          ) as {
            state: string;
            progress: { completedKeywords: number; totalKeywords: number };
          };
          assert.equal(manifest.state, 'running');
          assert.equal(manifest.progress.completedKeywords, collected);
          assert.equal(manifest.progress.totalKeywords, 4);
        }
        collected += 1;
        return okResult(keyword);
      },
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.state, 'completed');
  store.close();
});

test('resuming a completed run is refused and leaves artifacts untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-immutable-'));
  const dbPath = join(directory, 'run.sqlite');
  const runDirectory = join(directory, 'run-1');
  await mkdir(runDirectory, { recursive: true });

  const store = RunStore.open(dbPath);
  const runId = createRunId();
  const outcome = await executeRun(baseOptions(store, runId, runDirectory));
  assert.equal(outcome.kind, 'finished');
  store.close();

  const dbBefore = await readFile(dbPath);
  const manifestBefore = await readFile(join(runDirectory, 'manifest.json'));
  const keywordsBefore = await readFile(join(runDirectory, 'keywords.json'));
  const serpBefore = await readFile(join(runDirectory, 'serp.json'));

  const reopened = RunStore.open(dbPath);
  await assert.rejects(
    () =>
      executeRun(
        baseOptions(reopened, runId, runDirectory, {
          mode: 'resume',
          keywords: [],
        }),
      ),
    (error: unknown) => error instanceof ResearchError && error.code === 'RESUME_TERMINAL_RUN',
  );
  reopened.close();

  assert.deepEqual(await readFile(dbPath), dbBefore);
  assert.deepEqual(await readFile(join(runDirectory, 'manifest.json')), manifestBefore);
  assert.deepEqual(await readFile(join(runDirectory, 'keywords.json')), keywordsBefore);
  assert.deepEqual(await readFile(join(runDirectory, 'serp.json')), serpBefore);
});

test('resume refuses a parser version mismatch', () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  store.createRun({
    runId,
    configSnapshot: BASE_CONFIG,
    parserVersions: { surfer: '0.0.0', google: GOOGLE_PARSER_VERSION },
    input: INPUT,
    keywords: KEYWORDS,
  });
  assert.throws(
    () => validateResume(store, runId),
    (error: unknown) => error instanceof ResearchError && error.code === 'RESUME_PARSER_MISMATCH',
  );
  store.close();
});

test('validateResume reports missing runs', () => {
  const store = RunStore.openInMemory();
  assert.throws(
    () => validateResume(store, 'nope'),
    (error: unknown) => error instanceof ResearchError && error.code === 'RESUME_NOT_FOUND',
  );
  store.close();
});

test('transient failures retry with backoff until success', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const sleeps: number[] = [];
  const config = testConfig({
    retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
  });
  let calls = 0;
  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'engine-retry-')), {
      keywords: KEYWORDS.slice(0, 1),
      config,
      collect: async (keyword) => {
        calls += 1;
        return calls <= 2 ? transientFailResult(keyword) : okResult(keyword);
      },
      hooks: makeHooks({
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.state, 'completed');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [75, 150]);
  assert.equal(store.loadRun(runId)?.lookups, 3);
  store.close();
});

test('transient failures stop after maxAttempts and leave the keyword failed', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const sleeps: number[] = [];
  const config = testConfig({
    retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
  });
  let calls = 0;
  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'engine-exhaust-')), {
      keywords: KEYWORDS.slice(0, 1),
      config,
      collect: async (keyword) => {
        calls += 1;
        return transientFailResult(keyword);
      },
      hooks: makeHooks({
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    }),
  );
  assert.equal(outcome.kind, 'finished');
  assert.equal(outcome.state, 'completed_with_errors');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [75, 150]);
  const keyword = store.loadKeyword(runId, 0) as NonNullable<
    ReturnType<RunStore['loadKeyword']>
  >;
  assert.equal(keyword.status, 'failed');
  assert.equal(keyword.error?.code, 'GOOGLE_UNAVAILABLE');
  store.close();
});

test('parser failures are not retried', async () => {
  const scenarios: Array<{ maker: typeof surferFailResult; expectedStatus: string }> = [
    { maker: surferFailResult, expectedStatus: 'failed' },
    { maker: googleFailResult, expectedStatus: 'partial' },
  ];
  for (const scenario of scenarios) {
    const store = RunStore.openInMemory();
    const runId = createRunId();
    let calls = 0;
    const outcome = await executeRun(
      baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'engine-noretry-')), {
        keywords: KEYWORDS.slice(0, 1),
        collect: async (keyword) => {
          calls += 1;
          return scenario.maker(keyword);
        },
      }),
    );
    assert.equal(outcome.kind, 'finished');
    assert.equal(calls, 1);
    const keyword = store.loadKeyword(runId, 0) as NonNullable<
      ReturnType<RunStore['loadKeyword']>
    >;
    assert.equal(keyword.status, scenario.expectedStatus);
    store.close();
  }
});

test('google circuit breaker pauses the run; resume completes it', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-breaker-'));
  const config = testConfig({
    circuitBreaker: { surferWindow: 15, surferFailureThreshold: 12, googleConsecutiveThreshold: 3 },
  });
  const logs: string[] = [];
  const first = await executeRun(
    baseOptions(store, runId, runDirectory, {
      config,
      collect: async (keyword) => googleFailResult(keyword),
      hooks: makeHooks({ logger: (line) => logs.push(line) }),
    }),
  );
  assert.equal(first.kind, 'paused');
  assert.match((first as { reason: string }).reason, /Google/);
  assert.equal(store.loadRun(runId)?.state, 'paused');
  assert.equal(store.loadKeywords(runId).filter((k) => k.status === 'pending').length, 1);
  assert.equal(store.loadRun(runId)?.lookups, 3);
  assert.ok(logs.some((line) => line.includes('npm run research -- --resume')));
  assert.ok(logs.some((line) => line.includes(runId)));

  const second = await executeRun(
    baseOptions(store, runId, runDirectory, {
      mode: 'resume',
      keywords: [],
      config,
    }),
  );
  assert.equal(second.kind, 'finished');
  assert.equal(second.state, 'completed_with_errors');
  assert.equal(store.loadRun(runId)?.state, 'completed_with_errors');
  assert.equal(store.loadRun(runId)?.lookups, 4);
  store.close();
});

test('surfer circuit breaker pauses before further collection', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const config = testConfig({
    circuitBreaker: { surferWindow: 3, surferFailureThreshold: 3, googleConsecutiveThreshold: 10 },
  });
  const first = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'engine-breaker-surfer-')), {
      config,
      collect: async (keyword) => surferFailResult(keyword),
    }),
  );
  assert.equal(first.kind, 'paused');
  assert.match((first as { reason: string }).reason, /Keyword Surfer/);
  assert.equal(store.loadKeywords(runId).filter((k) => k.status === 'pending').length, 1);
  assert.equal(store.loadRun(runId)?.lookups, 3);
  store.close();
});

test('progress lines include ETA once three samples exist', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const logs: string[] = [];
  const outcome = await executeRun(
    baseOptions(store, runId, await mkdtemp(join(tmpdir(), 'engine-progress-')), {
      hooks: makeHooks({ logger: (line) => logs.push(line) }),
    }),
  );
  assert.equal(outcome.kind, 'finished');
  const progressLines = logs.filter((line) => line.startsWith('Keywords '));
  assert.equal(progressLines.length, 4);
  assert.match(progressLines[0] as string, /Keywords 1\/4 \| completed 1 \| partial 0 \| failed 0/);
  assert.ok(!(progressLines[0] as string).includes('ETA'));
  assert.ok(!(progressLines[1] as string).includes('ETA'));
  assert.match(progressLines[2] as string, /Keywords 3\/4 .*ETA ~/);
  assert.match(progressLines[3] as string, /Keywords 4\/4/);
  store.close();
});

test('a collector returning a non-terminal status raises DB_ERROR', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  const runDirectory = await mkdtemp(join(tmpdir(), 'engine-invariant-'));
  await assert.rejects(
    () =>
      executeRun(
        baseOptions(store, runId, runDirectory, {
          keywords: KEYWORDS.slice(0, 1),
          collect: async (keyword) => ({
            record: {
              ...keyword,
              status: 'running' as const,
              surfer: null,
              google: null,
              error: null,
            },
            serpRows: [],
            debugArtifactPath: null,
          }),
        }),
      ),
    (error: unknown) => error instanceof ResearchError && error.code === 'DB_ERROR',
  );
  store.close();
});