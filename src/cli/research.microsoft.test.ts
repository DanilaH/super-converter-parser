import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCli, EXIT_INVALID_INPUT, EXIT_OK, DEFAULT_CLI_DEPS } from './research.js';
import { RunStore } from '../db/store.js';
import type { CliDeps } from './research.js';
import type { Browser } from 'playwright-core';

test('runCli rejects --microsoft and --seeds together', async () => {
  const code = await runCli(
    ['--microsoft', 'a.csv', '--seeds', 'b.csv'],
    DEFAULT_CLI_DEPS,
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(code, EXIT_INVALID_INPUT);
});

test('runCli rejects --microsoft and --resume together', async () => {
  const code = await runCli(
    ['--microsoft', 'a.csv', '--resume', 'run-1'],
    DEFAULT_CLI_DEPS,
    {} as NodeJS.ProcessEnv,
  );
  assert.equal(code, EXIT_INVALID_INPUT);
});

test('runCli --microsoft builds a real run and preserves every duplicate row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-ms-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(
    join(directory, 'input', 'microsoft.csv'),
    [
      'Ad group,Keyword,Average monthly searches,Competition,Suggested Bid',
      'A,dup keyword,"1K - 10K",-,-',
      'B,dup keyword,-,"0.50","0.20"',
      'C,dup keyword,"100 - 1K",-,-',
      'Solo,solo keyword,"100 - 1K","0.85","0.11"',
    ].join('\n'),
    'utf8',
  );

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
    // The collector is a stub; it keeps the incoming sources (occurrences) and
    // simply marks the keyword complete, so we can assert the Microsoft
    // provenance survived the full pipeline without a real browser.
    collect: async (_context, _config, record) => ({
      record: { ...record, status: 'completed', surfer: null, google: null, error: null },
      serpRows: [],
      debugArtifactPath: null,
      related: { status: 'empty', error: null, rows: [] },
    }),
  };

  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(
      ['--microsoft', 'input/microsoft.csv'],
      deps,
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(code, EXIT_OK);
    assert.equal(connectCalls, 1, 'a fresh Microsoft run still needs the browser for the pipeline');

    const runsDir = join(directory, 'runs');
    const runId = (await readdir(runsDir))[0] as string;

    const store = RunStore.open(join(runsDir, runId, 'run.sqlite'));
    const stored = store.loadKeywords(runId);
    assert.equal(stored.length, 2, 'dup keyword + solo keyword');

    const dup = stored.find((k) => k.normalizedKeyword === 'dup keyword')!;
    const microsoftSources = dup.sources.filter((s) => s.type === 'microsoft');
    // All three source rows survive, not just sourceRows[0].
    assert.equal(microsoftSources.length, 3);
    assert.deepEqual(
      microsoftSources.map((s) => (s.type === 'microsoft' ? s.sourceRow : -1)),
      [2, 3, 4],
    );
    assert.deepEqual(
      microsoftSources.map((s) => (s.type === 'microsoft' ? s.adGroup : '')),
      ['A', 'B', 'C'],
    );

    const solo = stored.find((k) => k.normalizedKeyword === 'solo keyword')!;
    assert.equal(solo.sources.filter((s) => s.type === 'microsoft').length, 1);
    store.close();

    // The operator-facing CSV must expose the aggregated source rows too.
    const keywordsCsv = await readFile(join(runsDir, runId, 'keywords.csv'), 'utf8');
    const dupLine = keywordsCsv.split('\r\n').find((line) => line.startsWith('dup keyword'));
    assert.ok(dupLine, 'expected dup keyword in keywords.csv');
    assert.ok(dupLine.includes('2|3|4'), 'source_rows should list every Microsoft row');
  } finally {
    process.chdir(previousCwd);
  }
});
