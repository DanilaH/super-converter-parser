import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoadedOperatorResearchConfig, ResolvedOperatorContinuation } from '../operatorConfig/resolve.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  type ResearchRunDeps,
  type ResearchRunExecution,
} from './researchWorkflow.js';
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

const BASE_DEPS = DEFAULT_RESEARCH_RUN_DEPS;

test('executeNewResearch injects the supplied loaded config without a config file read', async () => {
  const loaded = { plan: { effectiveConfigFingerprint: 'typed-config' } } as LoadedOperatorResearchConfig;
  let observed: LoadedOperatorResearchConfig | null = null;
  const runtime: ResearchControlRuntime = {
    runFromConfig: async (path, outputRoot, deps, env, signal) => {
      assert.equal(path, '/application/operator-config.json');
      assert.equal(outputRoot, null);
      assert.ok(deps);
      assert.ok(signal);
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
      assert.ok(deps);
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
  const deps: ResearchRunDeps = {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    loadContinuation: sentinelLoader,
  };
  const runtime: ResearchControlRuntime = {
    runFromConfig: async () => EXECUTION,
    runFromExisting: async (researchId, path, outputRoot, receivedDeps) => {
      assert.equal(researchId, 'research-1');
      assert.equal(path, null);
      assert.equal(outputRoot, null);
      assert.equal(receivedDeps, deps);
      assert.equal(receivedDeps?.loadContinuation, sentinelLoader);
      return EXECUTION;
    },
  };

  await executeExistingResearch('research-1', null, { deps, runtime, env: {} });
});

test('application adapters can disable discovery process-signal ownership without changing workflow orchestration', async () => {
  const loaded = { plan: { effectiveConfigFingerprint: 'typed-config' } } as LoadedOperatorResearchConfig;
  let observedPolicy: boolean | undefined;
  const deps: ResearchRunDeps = {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    runDiscovery: async (request) => {
      observedPolicy = request.manageProcessSignals;
      return {
        exitCode: 0,
        researchId: 'research-1',
        runId: 'run-1',
        researchDirectory: '/research',
        discoveryDirectory: '/research/discovery',
        state: 'completed',
      };
    },
  };
  const runtime: ResearchControlRuntime = {
    runFromConfig: async (_path, _outputRoot, receivedDeps) => {
      assert.ok(receivedDeps);
      await receivedDeps.runDiscovery(
        { input: { kind: 'resume', runId: 'run-1' } },
        receivedDeps.cliDeps,
        {},
      );
      return EXECUTION;
    },
    runFromExisting: async () => EXECUTION,
  };

  await executeNewResearch(loaded, {
    deps,
    runtime,
    env: {},
    manageProcessSignals: false,
  });

  assert.equal(observedPolicy, false);
});

test('host cancellation policy preserves a live cancellation signal in both directions', async () => {
  const loaded = { plan: { effectiveConfigFingerprint: 'typed-config' } } as LoadedOperatorResearchConfig;
  const sourceSignal = { cancelled: false };
  let observedPolicy: boolean | undefined;
  const runtime: ResearchControlRuntime = {
    runFromConfig: async (_path, _outputRoot, _deps, _env, signal) => {
      const hostSignal = signal as typeof signal & { manageProcessSignals?: boolean };
      observedPolicy = hostSignal.manageProcessSignals;
      assert.equal(hostSignal.cancelled, false);
      sourceSignal.cancelled = true;
      assert.equal(hostSignal.cancelled, true);
      hostSignal.cancelled = false;
      assert.equal(sourceSignal.cancelled, false);
      return EXECUTION;
    },
    runFromExisting: async () => EXECUTION,
  };

  await executeNewResearch(loaded, {
    deps: BASE_DEPS,
    runtime,
    env: {},
    signal: sourceSignal,
    manageProcessSignals: false,
  });

  assert.equal(observedPolicy, false);
  assert.equal(sourceSignal.cancelled, false);
});
