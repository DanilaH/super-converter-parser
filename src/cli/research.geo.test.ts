import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCli, EXIT_OK, type CliDeps } from './research.js';
import type { Browser } from 'playwright-core';
import type { KeywordRecord } from '../runs/run.js';
import type { CollectionResult } from '../browser/collect.js';

function geoResult(
  keyword: KeywordRecord,
  detectedLocation: string | null,
  geoWarning: boolean,
): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'completed',
      surfer: { volume: 100, cpc: 1.5, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' },
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=x',
        detectedLocation,
        geoWarning,
      },
      error: null,
    },
    serpRows: [],
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  };
}

test('geo mismatch surfaces in keywords.csv and report.md without false localization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-geo-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\nk2', 'utf8');

  const deps: CliDeps = {
    connect: async () =>
      ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, _config, record) =>
      record.normalizedKeyword === 'k1'
        ? geoResult(record, 'Moscow, Russia', true)
        : geoResult(record, null, false),
  };

  const previousCwd = process.cwd();
  process.chdir(directory);

  const logLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };

  try {
    const code = await runCli(['--seeds', 'input/seeds.csv'], deps, {} as NodeJS.ProcessEnv);
    assert.equal(code, EXIT_OK);

    const runsDir = join(directory, 'runs');
    const runId = (await readdir(runsDir))[0] as string;
    const runDir = join(runsDir, runId);

    const keywordsCsv = await readFile(join(runDir, 'keywords.csv'), 'utf8');
    assert.ok(keywordsCsv.includes('detected_google_location'), 'keywords.csv must expose detected_google_location');
    assert.ok(keywordsCsv.includes('geo_warning'), 'keywords.csv must expose geo_warning');
    assert.ok(keywordsCsv.includes('Moscow, Russia'), 'detected location must be persisted');

    const keywordsJson = await readFile(join(runDir, 'keywords.json'), 'utf8');
    assert.ok(keywordsJson.includes('Moscow, Russia'), 'keywords.json must persist the detected location');
    assert.ok(keywordsJson.includes('geoWarning'), 'keywords.json must persist the geo warning flag');

    const report = await readFile(join(runDir, 'report.md'), 'utf8');
    assert.ok(report.includes('## Geo warnings'), 'report must have a geo warnings section');
    assert.ok(report.includes('Moscow, Russia'), 'report must name the detected location');
    assert.ok(report.includes('`k1`'), 'report must identify the mismatched keyword');
    assert.ok(report.includes('geo-mismatched'), 'report must list geo as a next manual check');

    const joinedLogs = logLines.join('\n');
    assert.ok(joinedLogs.includes('GEO WARNING'), 'CLI must print a geo warning during the run');
    assert.ok(joinedLogs.includes('Moscow, Russia'), 'CLI geo warning must name the detected location');
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
  }
});
