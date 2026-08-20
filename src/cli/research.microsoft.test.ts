import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, EXIT_INVALID_INPUT, DEFAULT_CLI_DEPS } from './research.js';

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
