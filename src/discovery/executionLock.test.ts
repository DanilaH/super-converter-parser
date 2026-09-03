import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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

test('acquiring the discovery lock does not materialize an otherwise missing output root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'discovery-lock-pre-durable-'));
  const outputRoot = join(parent, 'not-created');
  try {
    const release = await acquireDiscoveryExecutionLock(outputRoot);
    try {
      await assert.rejects(() => access(outputRoot));
    } finally {
      await release();
    }
    await assert.rejects(() => access(outputRoot));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('discovery execution lock canonicalizes symlinked parents for a missing output root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'discovery-lock-alias-'));
  const realParent = join(parent, 'real-parent');
  const aliasParent = join(parent, 'alias-parent');
  await mkdir(realParent);
  await symlink(realParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
  const realRoot = join(realParent, 'not-created');
  const aliasRoot = join(aliasParent, 'not-created');

  try {
    const release = await acquireDiscoveryExecutionLock(realRoot);
    try {
      await assert.rejects(
        () => acquireDiscoveryExecutionLock(aliasRoot),
        (error: unknown) => error instanceof ResearchError
          && error.code === 'OUTPUT_WRITE_ERROR'
          && /another discovery execution is already running/i.test(error.message),
      );
      await assert.rejects(() => access(realRoot));
      await assert.rejects(() => access(aliasRoot));
    } finally {
      await release();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
