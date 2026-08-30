import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('research CLI usage describes the full retry repair surface', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      join(process.cwd(), 'src', 'cli', 'research.ts'),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
    },
  );

  assert.equal(result.status, 2);
  assert.match(
    result.stdout,
    /repair failed or provably incomplete partial primary checkpoints, preserving attempt history/,
  );
  assert.doesNotMatch(result.stdout, /reopen only failed keyword checkpoints/);
});
