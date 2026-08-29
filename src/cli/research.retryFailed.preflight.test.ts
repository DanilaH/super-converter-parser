import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { Browser } from 'playwright-core';
import type { CollectionResult } from '../browser/collect.js';
import { RunStore } from '../db/store.js';
import { loadKeywordRetryAttempts } from '../db/retryAttempts.js';
import type { KeywordRecord } from '../runs/run.js';
import { EXIT_INVALID_INPUT, EXIT_OK, type CliDeps } from './research.js';
import { runCliInTestLayout as runCli } from './testCli.js';

function failedResult(record: KeywordRecord): CollectionResult {
  const error = { code: 'GOOGLE_UNAVAILABLE' as const, message: 'original transient failure' };
  return {
    record: {
      ...record,
      status: 'failed',
      surfer: null,
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=x',
        detectedLocation: null,
        geoWarning: false,
        serpStatus: 'fetch_error',
        serpError: error,
      },
      error,
    },
    serpRows: [{
      keyword: record.keyword,
      position: 1,
      title: 'old result',
      url: 'https://old.example/tool',
      hostname: 'old.example',
      registrableDomain: 'old.example',
      dr: null,
      drStatus: null,
      drError: null,
      resultType: 'organic',
    }],
    debugArtifactPath: null,
    related: { status: 'error', error: 'GOOGLE_UNAVAILABLE', rows: [] },
  };
}

test('resume config rejection leaves failed-keyword repair unapplied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-retry-preflight-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nfailed keyword', 'utf8');

  let collectCalls = 0;
  const deps: CliDeps = {
    connect: async () => ({
      contexts: () => [{}],
      close: async () => undefined,
    }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, _config, record) => {
      collectCalls += 1;
      return failedResult(record);
    },
  };
  const baseEnv = {
    CACHE_DB_PATH: join(directory, 'cache.sqlite'),
    RETRY_MAX_ATTEMPTS: '1',
    RETRY_BASE_DELAY_MS: '0',
    RETRY_MAX_DELAY_MS: '0',
  } as NodeJS.ProcessEnv;

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const first = await runCli(['--seeds', 'input/seeds.csv'], deps, baseEnv);
    assert.equal(first, EXIT_OK);
    assert.equal(collectCalls, 1);

    const runsDir = join(directory, 'runs');
    const runId = (await readdir(runsDir))[0] as string;
    const before = RunStore.open(join(runsDir, runId, 'run.sqlite'));
    assert.equal(before.loadRun(runId)?.state, 'completed_with_errors');
    assert.equal(before.loadKeyword(runId, 0)?.status, 'failed');
    assert.deepEqual(before.loadSerpRows(runId).map((row) => row.registrableDomain), ['old.example']);
    before.close();

    // The retry plan is read-only. effectiveConfigForResume rejects the changed
    // selector before applyFailedKeywordRetryPreparation() can mutate run.sqlite.
    const rejected = await runCli(
      ['--resume', runId, '--retry-failed'],
      deps,
      { ...baseEnv, SURFER_WIDGET_SELECTOR: '#different-widget' },
    );
    assert.equal(rejected, EXIT_INVALID_INPUT);
    assert.equal(collectCalls, 1, 'rejected repair must not reach browser collection');

    const after = RunStore.open(join(runsDir, runId, 'run.sqlite'));
    assert.equal(after.loadRun(runId)?.state, 'completed_with_errors');
    assert.equal(after.loadKeyword(runId, 0)?.status, 'failed');
    assert.equal(after.loadKeyword(runId, 0)?.error?.message, 'original transient failure');
    assert.deepEqual(after.loadSerpRows(runId).map((row) => row.registrableDomain), ['old.example']);
    assert.equal(loadKeywordRetryAttempts(after, runId).length, 0);
    after.close();
  } finally {
    process.chdir(previousCwd);
  }
});
