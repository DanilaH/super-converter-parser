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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function planQuickScan(service: OperatorGuiService, label: string): Promise<string> {
  const planned = await service.planNew({
    version: 1,
    preset: 'quick-scan',
    research: {
      label,
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
  }, { 'input/seeds.csv': `keyword\n${label}\n` });
  assert.ok(planned.draftId);
  return planned.draftId;
}

test('GUI serializes all research execution and consumes a successful new-research draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-double-submit-'));
  const draftRoot = join(root, 'drafts');
  await mkdir(draftRoot, { recursive: true });

  const runStarted = deferred();
  const gate = deferred();
  let executions = 0;

  const service = new OperatorGuiService({
    outputRoot: join(root, 'output'),
    draftRoot,
    deps: {
      runNew: async () => {
        executions += 1;
        runStarted.resolve();
        await gate.promise;
        return completedExecution(`research-${executions}`);
      },
    },
  });

  const firstDraft = await planQuickScan(service, 'first');
  const secondDraft = await planQuickScan(service, 'second');

  const first = service.runNew(firstDraft);
  await runStarted.promise;

  await assert.rejects(
    service.runNew(firstDraft),
    /Another research execution is already active through this GUI/,
  );
  await assert.rejects(
    service.runNew(secondDraft),
    /Another research execution is already active through this GUI/,
  );
  assert.equal(executions, 1, 'a second research executor must not start while the first is active');

  gate.resolve();
  const result = await first;
  assert.equal(result.result.researchId, 'research-1');
  await assert.rejects(service.runNew(firstDraft), /Unknown or incompatible GUI draft/);

  const second = await service.runNew(secondDraft);
  assert.equal(second.result.researchId, 'research-2');
  assert.equal(executions, 2);

  await service.close();
});
