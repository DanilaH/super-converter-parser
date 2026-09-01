import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OperatorGuiService } from './service.js';

function completedExecution(researchId: string) {
  return {
    exitCode: 0,
    result: {
      version: 1 as const,
      exitCode: 0,
      researchId,
      discoveryRunId: researchId,
      discoveryState: 'completed',
      enrichmentId: null,
      enrichmentState: null,
      finalizationState: null,
      publicationId: null,
      workflowTarget: 'discovery' as const,
      workflowState: 'completed' as const,
      stopPoint: 'complete' as const,
      unresolvedHumanRequirements: [],
      effectiveConfigFingerprint: 'fingerprint',
      stageFingerprints: {
        discoverySemanticFingerprint: 'd',
        enrichmentSemanticFingerprint: 'e',
        finalizationPolicyFingerprint: 'f',
      },
      operatorConfigPath: '/tmp/operator-config.json',
    },
  };
}

test('new-research GUI draft cannot be double-submitted and is consumed after durable research identity exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-double-submit-'));
  const draftRoot = join(root, 'drafts');
  await mkdir(draftRoot, { recursive: true });

  let releaseRun: (() => void) | null = null;
  const runStarted = new Promise<void>((resolveStarted) => {
    releaseRun = resolveStarted;
  });
  let unblock: (() => void) | null = null;
  const gate = new Promise<void>((resolveGate) => {
    unblock = resolveGate;
  });

  const service = new OperatorGuiService({
    outputRoot: join(root, 'output'),
    draftRoot,
    deps: {
      runNew: async () => {
        releaseRun?.();
        await gate;
        return completedExecution('research-1');
      },
    },
  });

  const planned = await service.planNew({
    version: 1,
    preset: 'quick-scan',
    research: {
      label: 'double-submit',
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
  }, { 'input/seeds.csv': 'keyword\njson formatter\n' });
  assert.ok(planned.draftId);

  const first = service.runNew(planned.draftId);
  await runStarted;
  await assert.rejects(service.runNew(planned.draftId), /already executing/);
  unblock?.();
  const result = await first;
  assert.equal(result.result.researchId, 'research-1');
  await assert.rejects(service.runNew(planned.draftId), /Unknown or incompatible GUI draft/);

  await service.close();
});
