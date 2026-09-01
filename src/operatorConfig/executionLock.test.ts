import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import { acquireResearchExecutionLock } from './executionLock.js';

test('research execution lock rejects a concurrent config-driven runner and is reusable after release', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-execution-lock-'));
  const releaseFirst = await acquireResearchExecutionLock(outputRoot, 'research-1');
  try {
    await assert.rejects(
      acquireResearchExecutionLock(outputRoot, 'research-1'),
      (error: unknown) => error instanceof ResearchError
        && error.code === 'OUTPUT_WRITE_ERROR'
        && /already running/i.test(error.message),
    );
  } finally {
    await releaseFirst();
  }

  const releaseSecond = await acquireResearchExecutionLock(outputRoot, 'research-1');
  await releaseSecond();
});

test('research execution locks are scoped by stable research id', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-execution-lock-scope-'));
  const releaseA = await acquireResearchExecutionLock(outputRoot, 'research-a');
  const releaseB = await acquireResearchExecutionLock(outputRoot, 'research-b');
  await releaseB();
  await releaseA();
});
