import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { EXIT_OK, EXIT_PAUSED, type CliDeps } from './research.js';
import { runCliInTestLayout as runCli } from './testCli.js';
import type { Browser } from 'playwright-core';
import type { KeywordRecord } from '../runs/run.js';
import type { CollectionResult } from '../browser/collect.js';

function okResult(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
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
    serpRows: [],
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  };
}

function failedResult(keyword: KeywordRecord): CollectionResult {
  return {
    record: {
      ...keyword,
      status: 'failed',
      surfer: null,
      google: {
        hl: 'en',
        gl: 'us',
        pageUrl: 'https://google.com/search?q=x',
        detectedLocation: null,
        geoWarning: false,
      },
      error: { code: 'GOOGLE_SERP_PARSE_ERROR', message: 'organic block not found' },
    },
    serpRows: [],
    debugArtifactPath: null,
    related: { status: 'empty', error: null, rows: [] },
  };
}

function makeDeps(): CliDeps {
  return {
    connect: async () =>
      ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
    preflight: async () => undefined,
    collect: async (_context, _config, record) => okResult(record),
  };
}

function expectSingleFinalJson(lines: string[]): Record<string, unknown> {
  const jsonLines = lines.filter((line) => line.trim().startsWith('{'));
  assert.equal(
    jsonLines.length,
    1,
    `stdout must contain exactly one JSON line (found ${jsonLines.length})`,
  );
  assert.equal(
    lines[lines.length - 1],
    jsonLines[0],
    'the JSON status line must be the last stdout line',
  );
  return JSON.parse(jsonLines[0]!) as Record<string, unknown>;
}

test('--json-status emits a single parseable JSON line pointing at real artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-json-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1', 'utf8');

  const logLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(
      ['--seeds', 'input/seeds.csv', '--json-status'],
      makeDeps(),
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(code, EXIT_OK);

    const status = expectSingleFinalJson(logLines) as {
      status: string;
      runId: string;
      artifacts: { report: string; candidatesCsv: string };
    };
    assert.equal(status.status, 'completed');
    assert.equal(status.runId, (await readdir(join(directory, 'runs')))[0]);

    assert.ok(status.artifacts.report.endsWith('report.md'), 'report path points at report.md');
    assert.ok(
      status.artifacts.candidatesCsv.endsWith('candidates.csv'),
      'candidates path points at candidates.csv',
    );
    const reportExists = await readFile(status.artifacts.report, 'utf8')
      .then(() => true)
      .catch(() => false);
    assert.equal(reportExists, true, 'report path from JSON must actually exist');

    const jsonLine = logLines.filter((line) => line.trim().startsWith('{')).pop()!;
    assert.equal(/\[[0-9;]*m/.test(jsonLine), false, 'JSON status line must not contain ANSI codes');
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
  }
});

test('--json-status final line reports completed_with_errors when a keyword fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-json-errors-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\nk2', 'utf8');

  const logLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(
      ['--seeds', 'input/seeds.csv', '--json-status'],
      {
        connect: async () =>
          ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
        preflight: async () => undefined,
        collect: async (_context, _config, record) =>
          record.normalizedKeyword === 'k1' ? failedResult(record) : okResult(record),
      },
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(code, EXIT_OK, 'completed_with_errors still exits 0');

    const status = expectSingleFinalJson(logLines) as { status: string };
    assert.equal(status.status, 'completed_with_errors', 'final JSON status must reflect the error');
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
  }
});

test('--json-status final line reports paused when interrupted with Ctrl+C', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-json-paused-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), 'keyword\nk1\nk2', 'utf8');

  const logLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(
      ['--seeds', 'input/seeds.csv', '--json-status'],
      {
        connect: async () =>
          ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
        preflight: async () => undefined,
        collect: async (_context, _config, record) => {
          if (record.normalizedKeyword === 'k1') process.emit('SIGINT');
          return okResult(record);
        },
      },
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(code, EXIT_PAUSED, 'interrupted run exits 130');

    const status = expectSingleFinalJson(logLines) as { status: string };
    assert.equal(status.status, 'paused', 'final JSON status must reflect the pause');
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
  }
});
