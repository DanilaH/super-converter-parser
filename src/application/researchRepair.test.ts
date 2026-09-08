import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiscoveryRunResult } from '../discovery/runDiscovery.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import {
  repairResearchDiscovery,
  type ResearchDiscoveryRepairDeps,
} from './researchRepair.js';

function status(overrides: {
  nextAction?: string;
  repairable?: number;
  runId?: string;
  state?: string;
} = {}): ResearchStatusWithHistoricalPresence {
  return {
    researchId: 'research-1',
    legacy: false,
    discovery: {
      runId: overrides.runId ?? 'run-1',
      state: overrides.state ?? 'completed_with_errors',
      keywordCounts: { total: 3, pending: 0, running: 0, completed: 2, partial: 1, failed: 0, repairable: overrides.repairable ?? 1 },
    },
    nextAction: {
      code: overrides.nextAction ?? 'repair_discovery',
      message: 'repair',
      command: 'npm run research -- --resume run-1 --retry-failed',
    },
  } as unknown as ResearchStatusWithHistoricalPresence;
}

const repaired: DiscoveryRunResult = {
  exitCode: 0,
  researchId: 'run-1',
  runId: 'run-1',
  researchDirectory: '/output/research-1',
  discoveryDirectory: '/output/research-1/discovery',
  state: 'completed',
};

function deps(sequence: string[], statuses: ResearchStatusWithHistoricalPresence[]): ResearchDiscoveryRepairDeps {
  let statusIndex = 0;
  return {
    buildStatus: async () => {
      sequence.push(`status:${statusIndex}`);
      return statuses[Math.min(statusIndex++, statuses.length - 1)]!;
    },
    acquireExecutionLock: async () => {
      sequence.push('lock');
      return async () => { sequence.push('release'); };
    },
    runDiscovery: async (request) => {
      sequence.push('repair');
      assert.deepEqual(request.input, { kind: 'resume', runId: 'run-1' });
      assert.equal(request.retryFailed, true);
      assert.equal(request.manageProcessSignals, false);
      return repaired;
    },
    cliDeps: {} as ResearchDiscoveryRepairDeps['cliDeps'],
  };
}

test('explicit repair revalidates canonical eligibility under the execution lock and uses retryFailed', async () => {
  const sequence: string[] = [];
  const result = await repairResearchDiscovery(' research-1 ', {
    outputRoot: '/tmp/repair-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    deps: deps(sequence, [status(), status(), status({ repairable: 0, nextAction: 'run_enrichment', state: 'completed' })]),
  });

  assert.deepEqual(sequence, ['status:0', 'lock', 'status:1', 'repair', 'status:2', 'release']);
  assert.equal(result.researchId, 'research-1');
  assert.equal(result.discoveryRunId, 'run-1');
  assert.equal(result.repairableBefore, 1);
  assert.equal(result.repairableAfter, 0);
  assert.equal(result.discoveryState, 'completed');
});

test('repair fails closed when canonical nextAction does not authorize repair', async () => {
  const sequence: string[] = [];
  await assert.rejects(
    () => repairResearchDiscovery('research-1', {
      outputRoot: '/tmp/repair-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      deps: deps(sequence, [status({ nextAction: 'resume_discovery' })]),
    }),
    /not currently eligible for explicit discovery repair/,
  );
  assert.deepEqual(sequence, ['status:0']);
});

test('repair revalidation prevents mutation if current discovery changed before lock acquisition', async () => {
  const sequence: string[] = [];
  await assert.rejects(
    () => repairResearchDiscovery('research-1', {
      outputRoot: '/tmp/repair-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      deps: deps(sequence, [status(), status({ runId: 'run-2' })]),
    }),
    /Current discovery changed from run-1 to run-2/,
  );
  assert.deepEqual(sequence, ['status:0', 'lock', 'status:1', 'release']);
});

test('repair revalidation fails closed if repairability disappears while waiting for the lock', async () => {
  const sequence: string[] = [];
  await assert.rejects(
    () => repairResearchDiscovery('research-1', {
      outputRoot: '/tmp/repair-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      deps: deps(sequence, [status(), status({ repairable: 0, nextAction: 'run_enrichment' })]),
    }),
    /not currently eligible for explicit discovery repair/,
  );
  assert.deepEqual(sequence, ['status:0', 'lock', 'status:1', 'release']);
});
