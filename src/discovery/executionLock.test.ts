import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import { acquireDiscoveryExecutionLock } from './executionLock.js';

test('discovery execution lock rejects concurrent work for the same output root and is reusable after release', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'discovery-lock-'));
  try {
    const releaseFirst = await acquireDiscoveryExecutionLock(outputRoot);
    await assert.rejects(
      () => acquireDiscoveryExecutionLock(outputRoot),
      (error: unknown) => error instanceof ResearchError
        && error.code === 'OUTPUT_WRITE_ERROR'
        && /another discovery execution is already running/i.test(error.message),
    );
    await releaseFirst();

    const releaseSecond = await acquireDiscoveryExecutionLock(outputRoot);
    await releaseSecond();
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('discovery execution locks are independent across output roots', async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), 'discovery-lock-a-'));
  const secondRoot = await mkdtemp(join(tmpdir(), 'discovery-lock-b-'));
  try {
    const releaseFirst = await acquireDiscoveryExecutionLock(firstRoot);
    const releaseSecond = await acquireDiscoveryExecutionLock(secondRoot);
    await releaseSecond();
    await releaseFirst();
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});
