import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCli, effectiveConfigForResume, EXIT_PAUSED, EXIT_OK, EXIT_INVALID_INPUT, EXIT_PREFLIGHT, DEFAULT_CLI_DEPS } from './research.js';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { CacheStore } from '../cache/store.js';
import { buildKeywordCacheKey, buildRelatedCacheKey, keywordCacheIdentity } from '../cache/keys.js';
import { ResearchError } from '../shared/errors.js';
import type { CliDeps } from './research.js';
import type { Browser } from 'playwright-core';
import type { KeywordRecord } from '../runs/run.js';
import type { CollectionResult } from '../browser/collect.js';

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

test('effectiveConfigForResume refuses a changed SURFER_WIDGET_SELECTOR', () => {
  const current = loadConfig({} as NodeJS.ProcessEnv);
  const persisted = loadConfig({ SURFER_WIDGET_SELECTOR: '#other-widget' } as NodeJS.ProcessEnv);
  assert.throws(
    () => effectiveConfigForResume(current, persisted, 'run-1'),
    (error: unknown) => error instanceof ResearchError && error.code === 'RESUME_CONFIG_MISMATCH',
  );
});

test('effectiveConfigForResume keeps operational settings from current env and research from the snapshot', () => {
  const current = loadConfig({
    CDP_URL: 'http://127.0.0.1:9333',
    SURFER_WAIT_MS: '45000',
  } as NodeJS.ProcessEnv);
  const persisted = loadConfig({
    RESEARCH_MARKET: 'DE',
    TOP_N: '15',
  } as NodeJS.ProcessEnv);
  const merged = effectiveConfigForResume(current, persisted, 'run-1');
  assert.equal(merged.browser.cdpUrl, 'http://127.0.0.1:9333');
  assert.equal(merged.browser.surferWaitTimeoutMs, 45000);
  assert.equal(merged.research.market, 'DE');
  assert.equal(merged.research.topN, 15);
});

test('SIGINT during an active keyword pauses the run and exits 130', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-sigint-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\nk2', 'utf8');

  let connectCalls = 0;
  let browserClosed = false;
  const deps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return {
        contexts: () => [{}],
        close: async () => {
          browserClosed = true;
        },
      } as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, _config, record) => {
      if (record.normalizedKeyword === 'k1') {
        process.emit('SIGINT');
      }
      return okResult(record);
    },
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(code, EXIT_PAUSED);
    assert.equal(connectCalls, 1);
    assert.equal(browserClosed, true);

    const runsDir = join(directory, 'runs');
    const entries = await readdir(runsDir);
    assert.equal(entries.length, 1);
    const runId = entries[0] as string;

    const store = RunStore.open(join(runsDir, runId, 'run.sqlite'));
    assert.equal(store.loadRun(runId)?.state, 'paused');
    assert.deepEqual(
      store.loadKeywords(runId).map((k) => k.status),
      ['completed', 'pending'],
    );
    store.close();

    const manifest = JSON.parse(
      await readFile(join(runsDir, runId, 'manifest.json'), 'utf8'),
    ) as { state: string };
    assert.equal(manifest.state, 'paused');

    // Resuming a run that still has pending keywords needs the browser.
    const resumed = await runCli(['--resume', runId], deps, {} as NodeJS.ProcessEnv);
    assert.equal(resumed, EXIT_OK);
    assert.equal(connectCalls, 2);
    const completed = RunStore.open(join(runsDir, runId, 'run.sqlite'));
    assert.equal(completed.loadRun(runId)?.state, 'completed');
    assert.deepEqual(
      completed.loadKeywords(runId).map((k) => k.status),
      ['completed', 'completed'],
    );
    completed.close();
  } finally {
    process.chdir(previousCwd);
  }
});

test('resuming a fully collected run finalizes without browser work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-resume-empty-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1', 'utf8');

  let connectCalls = 0;
  const deps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return {
        contexts: () => [{}],
        close: async () => undefined,
      } as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, _config, record) => okResult(record),
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(first, EXIT_OK);
    assert.equal(connectCalls, 1);

    const runsDir = join(directory, 'runs');
    const runId = (await readdir(runsDir))[0] as string;

    // A paused-with-everything-collected run still finalizes: pause it first.
    const store = RunStore.open(join(runsDir, runId, 'run.sqlite'));
    store.setRunState(runId, 'paused', { pauseReason: 'test' });
    store.close();

    const resumed = await runCli(['--resume', runId], deps, {} as NodeJS.ProcessEnv);
    assert.equal(resumed, EXIT_OK);
    assert.equal(connectCalls, 1);

    const finalStore = RunStore.open(join(runsDir, runId, 'run.sqlite'));
    assert.equal(finalStore.loadRun(runId)?.state, 'completed');
    assert.equal(finalStore.loadRun(runId)?.lookups, 1);
    finalStore.close();
  } finally {
    process.chdir(previousCwd);
  }
});

test('runCli rejects --seeds and --resume together', async () => {
  const code = await runCli(
    ['--seeds', 'a.csv', '--resume', 'run-1'],
    DEFAULT_CLI_DEPS,
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(code, EXIT_INVALID_INPUT);
});

test('--refresh-keyword without a value exits 2', async () => {
  const code = await runCli(['--seeds', 'a.csv', '--refresh-keyword'], DEFAULT_CLI_DEPS, {} as NodeJS.ProcessEnv);
  assert.equal(code, EXIT_INVALID_INPUT);
});

test('--refresh-keyword for an unknown keyword exits 2', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-refresh-unknown-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1', 'utf8');

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(
      ['--seeds', 'input/seeds.csv', '--refresh-keyword', 'not a keyword'],
      DEFAULT_CLI_DEPS,
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(code, EXIT_INVALID_INPUT);
  } finally {
    process.chdir(previousCwd);
  }
});

test('a warm cache lets a second run finish without any browser work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-cache-warm-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1', 'utf8');

  let connectCalls = 0;
  const deps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return {
        contexts: () => [{}],
        close: async () => undefined,
      } as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, _config, record) => okResult(record),
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(first, EXIT_OK);
    assert.equal(connectCalls, 1);

    const runsDir = join(directory, 'runs');
    const firstRunId = (await readdir(runsDir))[0] as string;
    const firstStore = RunStore.open(join(runsDir, firstRunId, 'run.sqlite'));
    assert.equal(firstStore.loadRun(firstRunId)?.lookups, 1);
    firstStore.close();

    const second = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(second, EXIT_OK);
    assert.equal(connectCalls, 1, 'an all-hit run must not connect to Chrome');

    const runIds = (await readdir(runsDir)).sort();
    const secondRunId = runIds[runIds.length - 1] as string;
    const secondStore = RunStore.open(join(runsDir, secondRunId, 'run.sqlite'));
    assert.equal(secondStore.loadRun(secondRunId)?.lookups, 0);
    assert.equal(secondStore.loadKeyword(secondRunId, 0)?.cacheStatus, 'hit');
    secondStore.close();

    const manifest = JSON.parse(
      await readFile(join(runsDir, secondRunId, 'manifest.json'), 'utf8'),
    ) as { progress: { cache: { hits: number }; lookups: number } };
    assert.equal(manifest.progress.cache.hits, 1);
    assert.equal(manifest.progress.lookups, 0);
  } finally {
    process.chdir(previousCwd);
  }
});

test('--force-refresh re-collects keywords despite a warm cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-force-refresh-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1', 'utf8');

  let connectCalls = 0;
  const deps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return {
        contexts: () => [{}],
        close: async () => undefined,
      } as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, _config, record) => okResult(record),
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(first, EXIT_OK);

    const second = await runCli(['--seeds', 'input/seeds.csv', '--force-refresh'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(second, EXIT_OK);
    assert.equal(connectCalls, 2);

    const runsDir = join(directory, 'runs');
    const runIds = (await readdir(runsDir)).sort();
    const secondRunId = runIds[runIds.length - 1] as string;
    const store = RunStore.open(join(runsDir, secondRunId, 'run.sqlite'));
    assert.equal(store.loadRun(secondRunId)?.lookups, 1);
    assert.equal(store.loadKeyword(secondRunId, 0)?.cacheStatus, 'refreshed');
    assert.equal(store.loadRun(secondRunId)?.forceRefresh, true);
    store.close();
  } finally {
    process.chdir(previousCwd);
  }
});

test('--refresh-keyword for an unknown keyword on resume exits 2', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-refresh-resume-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\nk2', 'utf8');

  const deps: CliDeps = {
    connect: async () =>
      ({
        contexts: () => [{}],
        close: async () => undefined,
      }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, _config, record) => okResult(record),
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(first, EXIT_OK);
    const runId = (await readdir(join(directory, 'runs')))[0] as string;

    const code = await runCli(
      ['--resume', runId, '--refresh-keyword', 'missing keyword'],
      deps,
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(code, EXIT_INVALID_INPUT);
  } finally {
    process.chdir(previousCwd);
  }
});

test('a paused forced-refresh run stays forced when resumed without flags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-force-resume-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\nk2', 'utf8');

  let connectCalls = 0;
  const deps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return {
        contexts: () => [{}],
        close: async () => undefined,
      } as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, _config, record) => {
      if (record.normalizedKeyword === 'k1') {
        process.emit('SIGINT');
      }
      return okResult(record);
    },
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = await runCli(
      ['--seeds', 'input/seeds.csv', '--force-refresh'],
      deps,
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(first, EXIT_PAUSED);
    assert.equal(connectCalls, 1);
    const runId = (await readdir(join(directory, 'runs')))[0] as string;

    // Resuming WITHOUT the flag must not silently fall back to cache hits:
    // the persisted force-refresh semantics still apply to the browser plan.
    const resumed = await runCli(['--resume', runId], deps, {} as NodeJS.ProcessEnv);
    assert.equal(resumed, EXIT_OK);
    assert.equal(connectCalls, 2, 'persisted force refresh still needs the browser');

    const store = RunStore.open(join(directory, 'runs', runId, 'run.sqlite'));
    assert.equal(store.loadRun(runId)?.state, 'completed');
    assert.equal(store.loadRun(runId)?.forceRefresh, true);
    assert.equal(store.loadRun(runId)?.lookups, 2);
    assert.deepEqual(
      store.loadKeywords(runId).map((k) => k.cacheStatus),
      ['refreshed', 'refreshed'],
    );
    store.close();
  } finally {
    process.chdir(previousCwd);
  }
});

test('resume --refresh-keyword re-collects only the listed keyword', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-refresh-resume-valid-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\nk2', 'utf8');

  let connectCalls = 0;
  const deps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return {
        contexts: () => [{}],
        close: async () => undefined,
      } as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, _config, record) => {
      if (record.normalizedKeyword === 'k1') {
        process.emit('SIGINT');
      }
      return okResult(record);
    },
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(first, EXIT_PAUSED);
    const runId = (await readdir(join(directory, 'runs')))[0] as string;

    const resumed = await runCli(
      ['--resume', runId, '--refresh-keyword', 'k2'],
      deps,
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(resumed, EXIT_OK);
    assert.equal(connectCalls, 2);

    const store = RunStore.open(join(directory, 'runs', runId, 'run.sqlite'));
    assert.equal(store.loadRun(runId)?.state, 'completed');
    // k1 was collected in run 1 and is not re-processed on resume (its run
    // status stays the run-1 miss); only k2 is re-collected as refreshed.
    assert.equal(store.loadRun(runId)?.lookups, 2);
    assert.deepEqual(
      store.loadKeywords(runId).map((k) => k.cacheStatus),
      ['miss', 'refreshed'],
    );
    // The refresh keyword persisted onto the run, so a later bare resume
    // would still re-collect k2.
    assert.deepEqual(store.loadRun(runId)?.refreshKeywords, ['k2']);
    store.close();
  } finally {
    process.chdir(previousCwd);
  }
});

test('a resumed run whose pending keywords are cached finalizes without browser work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-resume-cached-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\nk2', 'utf8');

  let connectCalls = 0;
  const deps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return {
        contexts: () => [{}],
        close: async () => undefined,
      } as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, _config, record) => {
      if (record.normalizedKeyword === 'k1') {
        process.emit('SIGINT');
      }
      return okResult(record);
    },
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(first, EXIT_PAUSED);
    assert.equal(connectCalls, 1);
    const runId = (await readdir(join(directory, 'runs')))[0] as string;

    // The pending keyword was cached by earlier research work (the persistent
    // cache is shared across runs); prime k2 in the exact store the CLI uses.
    const identity = keywordCacheIdentity(loadConfig({}));
    const cacheStore = CacheStore.open(join(directory, 'data', 'cache', 'cache.sqlite'));
    const collectedAt = new Date(Date.now() - 60_000).toISOString();
    cacheStore.putKeyword({
      cacheKey: buildKeywordCacheKey('k2', identity),
      keyword: 'k2',
      normalizedKeyword: 'k2',
      identity,
      record: {
        id: 'cached',
        keyword: 'k2',
        normalizedKeyword: 'k2',
        sources: [],
        status: 'completed',
        surfer: { volume: 100, cpc: 1.5, market: 'US', fetchedAt: collectedAt },
        google: {
          hl: 'en',
          gl: 'us',
          pageUrl: 'https://google.com/search?q=k2',
          detectedLocation: null,
          geoWarning: false,
        },
        error: null,
      },
      serpRows: [],
      collectedAt,
      storedAt: collectedAt,
      expiresAt: new Date(Date.now() + loadConfig({}).cache.ttl.completedMs).toISOString(),
    });
    cacheStore.close();

    // No flags, no browser: the plan serves every remaining keyword from cache.
    const resumed = await runCli(['--resume', runId], deps, {} as NodeJS.ProcessEnv);
    assert.equal(resumed, EXIT_OK);
    assert.equal(connectCalls, 1, 'a cached-pending resume must not connect to Chrome');

    const store = RunStore.open(join(directory, 'runs', runId, 'run.sqlite'));
    assert.equal(store.loadRun(runId)?.state, 'completed');
    assert.equal(store.loadRun(runId)?.lookups, 1);
    assert.deepEqual(
      store.loadKeywords(runId).map((k) => k.cacheStatus),
      ['miss', 'hit'],
    );
    store.close();
  } finally {
    process.chdir(previousCwd);
  }
});

test('an unreadable cache database exits 3 (preflight)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-cache-corrupt-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1', 'utf8');
  await mkdir(join(directory, 'data', 'cache'), { recursive: true });
  await writeFile(join(directory, 'data', 'cache', 'cache.sqlite'), 'not a sqlite database', 'utf8');

  let connectCalls = 0;
  const deps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return {
        contexts: () => [{}],
        close: async () => undefined,
      } as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, _config, record) => okResult(record),
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(code, EXIT_PREFLIGHT);
    assert.equal(connectCalls, 0, 'no browser work happens before the cache is healthy');
  } finally {
    process.chdir(previousCwd);
  }
});

test('all-hit seed with a cached related list pointing at a missing candidate engages the browser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-expand-warm-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\ncompare lists', 'utf8');

  const cachePath = join(directory, 'cache', 'cache.sqlite');
  await mkdir(join(directory, 'cache'), { recursive: true });
  const identity = keywordCacheIdentity(loadConfig({}));
  const cacheStore = CacheStore.open(cachePath);
  // Seed is a completed cache hit.
  cacheStore.putKeyword(
    {
      cacheKey: buildKeywordCacheKey('compare lists', identity),
      keyword: 'compare lists',
      normalizedKeyword: 'compare lists',
      identity,
      record: {
        id: 'kw-compare lists',
        keyword: 'compare lists',
        normalizedKeyword: 'compare lists',
        sources: [{ type: 'seed', rowNumbers: [1] }],
        status: 'completed',
        surfer: { volume: 100, cpc: 1.5, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
        google: { hl: 'en', gl: 'us', pageUrl: 'https://google.com/search?q=x', detectedLocation: null, geoWarning: false },
        error: null,
      },
      serpRows: [],
      collectedAt: '2026-01-01T00:00:00.000Z',
      storedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  );
  // Related list is cached (ok, still fresh) and points at a candidate that is
  // NOT in the keyword cache; the browser must be engaged for it.
  cacheStore.putRelated(
    {
      cacheKey: buildRelatedCacheKey('compare lists', identity),
      normalizedKeyword: 'compare lists',
      identity,
      status: 'ok',
      error: null,
      rows: [{ relatedKeyword: 'list comparison', overlap: 80, volume: 5000 }],
    },
    new Date(Date.now() - 1000).toISOString(),
    7 * 24 * 60 * 60 * 1000,
  );
  cacheStore.close();

  const collected: string[] = [];
  let connectCalls = 0;
  const deps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return {
        contexts: () => [{}],
        close: async () => undefined,
      } as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async (_context, _config, record) => {
      collected.push(record.normalizedKeyword);
      return okResult(record);
    },
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(
      ['--seeds', 'input/seeds.csv', '--expand'],
      deps,
      { CACHE_DB_PATH: cachePath } as NodeJS.ProcessEnv,
    );
    assert.equal(code, EXIT_OK);
    // The browser was needed for the missing candidate, not the hit seed.
    assert.equal(connectCalls, 1);
    assert.deepEqual([...collected].sort(), ['list comparison']);
  } finally {
    process.chdir(previousCwd);
  }
});