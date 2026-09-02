import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireDiscoveryExecutionLock } from './executionLock.js';
import { EXIT_PREFLIGHT, runDiscovery } from './runDiscovery.js';

test('runDiscovery fails before run resolution when another discovery execution owns the output-root lock', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'discovery-facade-lock-'));
  const release = await acquireDiscoveryExecutionLock(outputRoot);
  try {
    const result = await runDiscovery(
      { input: { kind: 'resume', runId: 'missing-run' }, outputRoot },
      undefined,
      {} as NodeJS.ProcessEnv,
    );
    assert.equal(result.exitCode, EXIT_PREFLIGHT);
    assert.equal(result.runId, 'missing-run');
    assert.equal(result.state, null);
  } finally {
    await release();
    await rm(outputRoot, { recursive: true, force: true });
  }
});
