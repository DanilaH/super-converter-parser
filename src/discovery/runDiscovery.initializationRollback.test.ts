import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunStore } from '../db/store.js';
import {
  EXIT_INTERNAL,
  runDiscovery,
  type CliDeps,
} from './runDiscoveryCore.js';

test('fresh discovery initialization failure does not publish a run index before durable identity exists', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'discovery-init-rollback-'));
  const outputRoot = join(parent, 'output');
  const seedsPath = join(parent, 'seeds.csv');
  const cachePath = join(parent, 'cache.sqlite');
  await writeFile(seedsPath, 'keyword\njson formatter\n', 'utf8');

  const originalCreateRun = RunStore.prototype.createRun;
  RunStore.prototype.createRun = function simulatedCreateRunFailure() {
    throw new Error('simulated createRun failure');
  };

  const deps = {
    connect: async () => {
      throw new Error('browser must not be reached before durable run initialization');
    },
    preflight: async () => undefined,
    collect: async () => {
      throw new Error('collection must not be reached before durable run initialization');
    },
  } as unknown as CliDeps;

  try {
    const result = await runDiscovery(
      {
        input: { kind: 'seeds', path: seedsPath },
        outputRoot,
        name: 'Initialization rollback',
      },
      deps,
      { CACHE_DB_PATH: cachePath } as NodeJS.ProcessEnv,
    );

    assert.equal(result.exitCode, EXIT_INTERNAL);
    assert.equal(result.runId, null);
    assert.equal(result.researchDirectory, null);
    await assert.rejects(() => access(join(outputRoot, 'index', 'runs')));
    assert.deepEqual(await readdir(outputRoot), []);
  } finally {
    RunStore.prototype.createRun = originalCreateRun;
    await rm(parent, { recursive: true, force: true });
  }
});
