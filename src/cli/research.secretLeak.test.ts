import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { EXIT_OK, type CliDeps } from './research.js';
import { runCliInTestLayout as runCli } from './testCli.js';
import type { Browser } from 'playwright-core';
import type { CollectionResult } from '../browser/collect.js';
import { scanFilesForSecret, scanTextForSecret } from '../shared/secretScan.js';

// A clearly fake, never-real secret. The point is to prove the Ahrefs API key
// (which would live only in process.env) can never reach an artifact or log.
const SENTINEL = 'AHREFS_LEAK_SENTINEL_DO_NOT_USE_zz9Z';

function resultWithDomain(keyword: string): CollectionResult {
  return {
    record: {
      id: keyword,
      keyword,
      normalizedKeyword: keyword,
      sources: [{ type: 'seed', rowNumbers: [1] }],
      status: 'completed',
      surfer: { volume: 100, cpc: 1.5, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
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
      {
        keyword,
        position: 1,
        title: 't',
        url: 'https://example.com/1',
        hostname: 'example.com',
        registrableDomain: 'example.com',
        dr: null,
        drStatus: null,
        resultType: 'organic',
      },
    ],
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  };
}

test('AHREFS_API_KEY never leaks into artifacts, run DB, cache DB, or logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-secret-leak-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1', 'utf8');

  const deps: CliDeps = {
    connect: async () =>
      ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, _config, record) => resultWithDomain(record.keyword),
  };

  // Capture stdout/stderr so we can assert the sentinel never reaches logs.
  const logLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    // Point Ahrefs at a closed port and shrink delays so the DR phase fails
    // fast (network error) and still exercises the client that holds the key.
    const env = {
      AHREFS_API_KEY: SENTINEL,
      AHREFS_ENDPOINT: 'http://127.0.0.1:9',
      AHREFS_TIMEOUT_MS: '200',
      AHREFS_MIN_DELAY_MS: '5',
      AHREFS_MAX_DELAY_MS: '10',
    } as NodeJS.ProcessEnv;

    const code = await runCli(['--seeds', 'input/seeds.csv'], deps, env);
    assert.equal(code, EXIT_OK);

    const runsDir = join(directory, 'runs');
    const runId = (await readdir(runsDir))[0] as string;
    const runDir = join(runsDir, runId);

    // Every persisted surface must be scanned: the JSON/CSV artifacts AND the
    // run database (run.sqlite) which lives inside the run dir, plus the shared
    // cache database (cache.sqlite) under data/. A missing expected file makes
    // scanFilesForSecret reject, so an absent DB is a hard failure, not "safe".
    const scanPaths = (await readdir(runDir)).map((name) => join(runDir, name));
    scanPaths.push(join(directory, 'data', 'cache', 'cache.sqlite'));

    // Debug artifacts are created only on parser failure; include them when
    // present so the leak guard covers the whole surface area.
    const debugDir = join(directory, 'debug', runId);
    if ((await readdir(debugDir).catch(() => [] as string[])).length > 0) {
      for (const name of await readdir(debugDir)) {
        scanPaths.push(join(debugDir, name));
      }
    }

    assert.equal(
      await scanFilesForSecret(scanPaths, SENTINEL),
      false,
      'no artifact, run DB, cache DB, or debug file may contain the Ahrefs API key',
    );
    assert.equal(
      scanTextForSecret(logLines.join('\n'), SENTINEL),
      false,
      'no log line may contain the Ahrefs API key',
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(previousCwd);
  }
});
