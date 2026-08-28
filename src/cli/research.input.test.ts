import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { runCli, EXIT_INVALID_INPUT, EXIT_PREFLIGHT, DEFAULT_CLI_DEPS } from './research.js';

async function withSeedsCwd(csv: string, run: (dir: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'cli-input-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'seeds.csv'), csv, 'utf8');
  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    await run(directory);
  } finally {
    process.chdir(previousCwd);
  }
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path));
}

test('missing seeds file exits 2', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-missing-'));
  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(['--seeds', 'does-not-exist.csv'], DEFAULT_CLI_DEPS, {} as NodeJS.ProcessEnv);
    assert.equal(code, EXIT_INVALID_INPUT);
  } finally {
    process.chdir(previousCwd);
  }
});

test('empty seeds CSV exits 2', async () => {
  await withSeedsCwd('', async () => {
    const code = await runCli(['--seeds', 'input/seeds.csv'], DEFAULT_CLI_DEPS, {} as NodeJS.ProcessEnv);
    assert.equal(code, EXIT_INVALID_INPUT);
  });
});

test('malformed seeds CSV (unclosed quote) exits 2', async () => {
  await withSeedsCwd('keyword\n"unclosed', async () => {
    const code = await runCli(['--seeds', 'input/seeds.csv'], DEFAULT_CLI_DEPS, {} as NodeJS.ProcessEnv);
    assert.equal(code, EXIT_INVALID_INPUT);
  });
});

test('seeds CSV without a keyword column exits 2', async () => {
  await withSeedsCwd('notkeyword\nfoo', async () => {
    const code = await runCli(['--seeds', 'input/seeds.csv'], DEFAULT_CLI_DEPS, {} as NodeJS.ProcessEnv);
    assert.equal(code, EXIT_INVALID_INPUT);
  });
});

test('seeds CSV with an empty keyword value exits 2', async () => {
  await withSeedsCwd('keyword\n', async () => {
    const code = await runCli(['--seeds', 'input/seeds.csv'], DEFAULT_CLI_DEPS, {} as NodeJS.ProcessEnv);
    assert.equal(code, EXIT_INVALID_INPUT);
  });
});

test('unknown --refresh-keyword is rejected before a durable research directory is allocated', async () => {
  await withSeedsCwd('keyword\njson diff\n', async (directory) => {
    const outputRoot = join(directory, 'research-output');
    const code = await runCli(
      [
        '--seeds',
        'input/seeds.csv',
        '--output-root',
        outputRoot,
        '--refresh-keyword',
        'not in input',
      ],
      DEFAULT_CLI_DEPS,
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(code, EXIT_INVALID_INPUT);
    await assertMissing(outputRoot);
  });
});

test('--require-ahrefs without a key is rejected before a durable research directory is allocated', async () => {
  await withSeedsCwd('keyword\njson diff\n', async (directory) => {
    const outputRoot = join(directory, 'research-output');
    const code = await runCli(
      [
        '--seeds',
        'input/seeds.csv',
        '--output-root',
        outputRoot,
        '--require-ahrefs',
      ],
      DEFAULT_CLI_DEPS,
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(code, EXIT_PREFLIGHT);
    await assertMissing(outputRoot);
  });
});

test('Microsoft CSV without a Keyword column exits 2', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-ms-'));
  await mkdir(join(directory, 'input'), { recursive: true });
  await writeFile(join(directory, 'input', 'ms.csv'), 'Campaign,Avg Monthly Searches\nAd group A,100', 'utf8');
  const previousCwd = process.cwd();
  process.chdir(directory);
  try {
    const code = await runCli(['--microsoft', 'input/ms.csv'], DEFAULT_CLI_DEPS, {} as NodeJS.ProcessEnv);
    assert.equal(code, EXIT_INVALID_INPUT);
  } finally {
    process.chdir(previousCwd);
  }
});
