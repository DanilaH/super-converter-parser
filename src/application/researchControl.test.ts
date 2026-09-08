import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoadedOperatorResearchConfig, ResolvedOperatorContinuation } from '../operatorConfig/resolve.js';
import type { ResearchRunDeps, ResearchRunExecution } from './researchWorkflow.js';
import {
  executeExistingResearch,
  executeNewResearch,
  type ResearchControlRuntime,
} from './researchControl.js';

const EXECUTION: ResearchRunExecution = {
  exitCode: 0,
  result: {
    version: 1,
    exitCode: 0,
    researchId: 'research-1',
    discoveryRunId: 'run-1',
    discoveryState: 'completed',
    enrichmentId: null,
    enrichmentState: null,
    finalizationState: null,
    publicationId: null,
    workflowTarget: 'discovery',
    workflowState: 'completed',
    stopPoint: 'complete',
    unresolvedHumanRequirements: [],
    effectiveConfigFingerprint: 'config-fingerprint',
    stageFingerprints: {
      discoverySemanticFingerprint: 'discovery-fingerprint',
      enrichmentSemanticFingerprint: 'enrichment-fingerprint',
      finalizationPolicyFingerprint: 'finalization-fingerprint',
    },
    operatorConfigPath: null,
  },
};

const BASE_DEPS = {} as ResearchRunDeps;

test('executeNewResearch injects the supplied loaded config without a config file read', async () => {
  const loaded = { plan: { effectiveConfigFingerprint: 'typed-config' } } as LoadedOperatorResearchConfig;
  let observed: LoadedOperatorResearchConfig | null = null;
  const runtime: ResearchControlRuntime = {
    runFromConfig: async (path, outputRoot, deps, env, signal) => {
      assert.equal(path, '/application/operator-config.json');
      assert.equal(outputRoot, null);
      assert.equal(signal.cancelled, false);
      observed = await deps.loadOperatorConfig(path);
      return EXECUTION;
    },
    runFromExisting: async () => EXECUTION,
  };

  const result = await executeNewResearch(loaded, {
    deps: BASE_DEPS,
    runtime,
    env: {},
  });

  assert.equal(result, EXECUTION);
  assert.equal(observed, loaded);
});

test('executeExistingResearch injects the supplied resolved continuation without a continuation file read', async () => {
  const continuation = {
    continuation: { version: 1, researchId: 'research-1', action: { type: 'finalists_all' } },
    continuationPath: '/virtual/continuation.json',
    declaredFilePath: null,
  } as ResolvedOperatorContinuation;
  let observed: ResolvedOperatorContinuation | null = null;
  const runtime: ResearchControlRuntime = {
    runFromConfig: async () => EXECUTION,
    runFromExisting: async (researchId, path, outputRoot, deps) => {
      assert.equal(researchId, 'research-1');
      assert.equal(path, '/application/continuation.json');
      assert.equal(outputRoot, null);
      observed = await deps.loadContinuation(path as string);
      return EXECUTION;
    },
  };

  const result = await executeExistingResearch('research-1', continuation, {
    deps: BASE_DEPS,
    runtime,
    env: {},
  });

  assert.equal(result, EXECUTION);
  assert.equal(observed, continuation);
});

test('executeExistingResearch resumes without inventing a continuation loader when none is supplied', async () => {
  const sentinelLoader = async (): Promise<ResolvedOperatorContinuation> => {
    throw new Error('must not be called');
  };
  const deps = { loadContinuation: sentinelLoader } as ResearchRunDeps;
  const runtime: ResearchControlRuntime = {
    runFromConfig: async () => EXECUTION,
    runFromExisting: async (researchId, path, outputRoot, receivedDeps) => {
      assert.equal(researchId, 'research-1');
      assert.equal(path, null);
      assert.equal(outputRoot, null);
      assert.equal(receivedDeps, deps);
      assert.equal(receivedDeps.loadContinuation, sentinelLoader);
      return EXECUTION;
    },
  };

  await executeExistingResearch('research-1', null, { deps, runtime, env: {} });
});
