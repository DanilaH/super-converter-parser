import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCli, effectiveConfigForResume, EXIT_PAUSED, EXIT_INVALID_INPUT, DEFAULT_CLI_DEPS } from './research.js';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
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

  let paused = false;
  const deps: CliDeps = {
    connect: async () =>
      ({
        contexts: () => [{}],
        close: async () => undefined,
      }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, _config, record) => {
      if (record.normalizedKeyword === 'k1') {
        process.emit('SIGINT');
      }
      paused = true;
      return okResult(record);
    },
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(code, EXIT_PAUSED);

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
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(paused, true);
});

test('runCli rejects --seeds and --resume together', async () => {
  const code = await runCli(
    ['--seeds', 'a.csv', '--resume', 'run-1'],
    DEFAULT_CLI_DEPS,
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(code, EXIT_INVALID_INPUT);
});