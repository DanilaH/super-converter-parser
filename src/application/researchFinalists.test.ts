import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import type { ExistingResearchExecutionPlan } from '../operatorConfig/planner.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { resolveOperatorContinuationInput } from './operatorInputs.js';
import {
  executeResearchFinalistScopeSelection,
  inspectResearchFinalistScope,
  validateResearchFinalistScopeSelection,
  type ResearchFinalistClusterV1,
  type ResearchFinalistScopeServiceDeps,
} from './researchFinalists.js';
import type { ResearchRunDeps, ResearchRunExecution } from './researchWorkflow.js';

const status = {
  researchId: 'research-1',
  researchDirectory: '/output/research-1',
  legacy: false,
  discovery: { runId: 'run-1' },
  currentEnrichmentId: 'enrichment-1',
  finalization: { state: 'not_started' },
} as unknown as ResearchStatusWithHistoricalPresence;

const provenance = {} as PersistedOperatorConfigV1;
const plan = {
  unresolvedHumanRequirements: ['finalist_scope'],
} as unknown as ExistingResearchExecutionPlan;

const clusters: ResearchFinalistClusterV1[] = [
  {
    clusterId: 'cluster-1',
    canonicalKeyword: 'mic test',
    memberCount: 2,
    medianVolume: 900,
    averageVolume: 850,
    representativeDomains: ['example.com', 'sample.net'],
    cohesion: { urlJaccardMedian: 0.5, domainJaccardMedian: 0.6 },
    members: [
      { keyword: 'mic test', normalizedKeyword: 'mic test', volume: 1000, serpSize: 10 },
      { keyword: 'microphone test', normalizedKeyword: 'microphone test', volume: 700, serpSize: 10 },
    ],
  },
  {
    clusterId: 'cluster-2',
    canonicalKeyword: 'speaker test',
    memberCount: 1,
    medianVolume: 600,
    averageVolume: 600,
    representativeDomains: ['audio.example'],
    cohesion: null,
    members: [
      { keyword: 'speaker test', normalizedKeyword: 'speaker test', volume: 600, serpSize: 10 },
    ],
  },
];

const execution: ResearchRunExecution = {
  exitCode: 0,
  result: {
    version: 1,
    exitCode: 0,
    researchId: 'research-1',
    discoveryRunId: 'run-1',
    discoveryState: 'completed',
    enrichmentId: 'enrichment-1',
    enrichmentState: 'completed',
    finalizationState: 'awaiting_decisions',
    publicationId: null,
    workflowTarget: 'finalization',
    workflowState: 'awaiting_decisions',
    stopPoint: 'finalization',
    unresolvedHumanRequirements: ['human_decisions'],
    effectiveConfigFingerprint: 'config',
    stageFingerprints: {
      discoverySemanticFingerprint: 'discovery',
      enrichmentSemanticFingerprint: 'enrichment',
      finalizationPolicyFingerprint: 'finalization',
    },
    operatorConfigPath: '/output/research-1/operator-config.json',
  },
};

function serviceDeps(overrides: Partial<ResearchFinalistScopeServiceDeps> = {}): ResearchFinalistScopeServiceDeps {
  return {
    buildStatus: async () => status,
    loadProvenance: async () => provenance,
    buildPlan: () => plan,
    loadClusters: async () => clusters,
    resolveContinuation: resolveOperatorContinuationInput,
    executeExistingResearch: async () => execution,
    ...overrides,
  };
}

test('finalist scope inspection exposes current enrichment clusters only at the canonical human gate', async () => {
  const gate = await inspectResearchFinalistScope(' research-1 ', {
    outputRoot: '/tmp/finalist-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    serviceDeps: serviceDeps(),
  });
  assert.equal(gate.researchId, 'research-1');
  assert.equal(gate.discoveryRunId, 'run-1');
  assert.equal(gate.enrichmentId, 'enrichment-1');
  assert.equal(gate.clusterCount, 2);
  assert.deepEqual(gate.clusters, clusters);
});

test('finalist scope inspection fails closed when the canonical plan is not awaiting finalist input', async () => {
  await assert.rejects(
    () => inspectResearchFinalistScope('research-1', {
      outputRoot: '/tmp/finalist-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      serviceDeps: serviceDeps({
        buildPlan: () => ({ unresolvedHumanRequirements: [] }) as unknown as ExistingResearchExecutionPlan,
      }),
    }),
    /not currently awaiting an explicit finalist scope/,
  );
});

test('selected finalist scope maps exact cluster ids to canonical finalists continuation', async () => {
  let action: unknown = null;
  const deps = serviceDeps({
    executeExistingResearch: async (researchId, continuation, options) => {
      assert.equal(researchId, 'research-1');
      action = continuation?.continuation.action;
      assert.equal(options?.manageProcessSignals, false);
      return execution;
    },
  });

  const result = await executeResearchFinalistScopeSelection(
    'research-1',
    { version: 1, enrichmentId: 'enrichment-1', mode: 'selected', clusterIds: ['cluster-2', 'cluster-1'] },
    {
      outputRoot: '/tmp/finalist-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      serviceDeps: deps,
    },
  );
  assert.deepEqual(action, { type: 'finalists', clusters: ['cluster-2', 'cluster-1'] });
  assert.equal(result.result.workflowState, 'awaiting_decisions');
});

test('all finalist scope preserves canonical finalists_all semantics instead of expanding a selected list', async () => {
  let action: unknown = null;
  const deps = serviceDeps({
    executeExistingResearch: async (_researchId, continuation) => {
      action = continuation?.continuation.action;
      return execution;
    },
  });

  await executeResearchFinalistScopeSelection(
    'research-1',
    { version: 1, enrichmentId: 'enrichment-1', mode: 'all' },
    {
      outputRoot: '/tmp/finalist-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      serviceDeps: deps,
    },
  );
  assert.deepEqual(action, { type: 'finalists_all' });
});

test('explicit finalist selection rejects unknown clusters without normalizing or inventing ids', async () => {
  await assert.rejects(
    () => executeResearchFinalistScopeSelection(
      'research-1',
      { version: 1, enrichmentId: 'enrichment-1', mode: 'selected', clusterIds: ['cluster-1', 'CLUSTER-2'] },
      {
        outputRoot: '/tmp/finalist-output',
        env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
        serviceDeps: serviceDeps(),
      },
    ),
    /unknown current cluster\(s\).*CLUSTER-2/,
  );
});

test('finalist scope selection rejects empty, duplicate, and whitespace-mutated explicit ids', () => {
  assert.throws(
    () => validateResearchFinalistScopeSelection({
      version: 1,
      enrichmentId: 'enrichment-1',
      mode: 'selected',
      clusterIds: [],
    }),
    /at least one cluster id/,
  );
  assert.throws(
    () => validateResearchFinalistScopeSelection({
      version: 1,
      enrichmentId: 'enrichment-1',
      mode: 'selected',
      clusterIds: ['cluster-1', 'cluster-1'],
    }),
    /must be unique/,
  );
  assert.throws(
    () => validateResearchFinalistScopeSelection({
      version: 1,
      enrichmentId: 'enrichment-1',
      mode: 'selected',
      clusterIds: [' cluster-1'],
    }),
    /leading or trailing whitespace/,
  );
});

test('finalist scope execution rejects stale enrichment under the canonical workflow status guard', async () => {
  const staleStatus = {
    ...status,
    currentEnrichmentId: 'enrichment-2',
  } as ResearchStatusWithHistoricalPresence;
  const workflowDeps = {
    buildStatus: async () => staleStatus,
  } as unknown as ResearchRunDeps;
  const deps = serviceDeps({
    executeExistingResearch: async (_researchId, _continuation, options) => {
      assert.ok(options?.deps);
      await options.deps.buildStatus({ outputRoot: '/tmp/finalist-output', targetRunId: 'research-1' });
      return execution;
    },
  });

  await assert.rejects(
    () => executeResearchFinalistScopeSelection(
      'research-1',
      { version: 1, enrichmentId: 'enrichment-1', mode: 'selected', clusterIds: ['cluster-1'] },
      {
        outputRoot: '/tmp/finalist-output',
        env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
        serviceDeps: deps,
        workflowDeps,
      },
    ),
    /Finalist scope selection is stale/,
  );
});

test('finalist scope execution rejects a gate that advanced into finalization while waiting for the lock', async () => {
  const advancedStatus = {
    ...status,
    finalization: { ...status.finalization, state: 'in_progress' },
  } as ResearchStatusWithHistoricalPresence;
  const workflowDeps = {
    buildStatus: async () => advancedStatus,
  } as unknown as ResearchRunDeps;
  const deps = serviceDeps({
    executeExistingResearch: async (_researchId, _continuation, options) => {
      assert.ok(options?.deps);
      await options.deps.buildStatus({ outputRoot: '/tmp/finalist-output', targetRunId: 'research-1' });
      return execution;
    },
  });

  await assert.rejects(
    () => executeResearchFinalistScopeSelection(
      'research-1',
      { version: 1, enrichmentId: 'enrichment-1', mode: 'all' },
      {
        outputRoot: '/tmp/finalist-output',
        env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
        serviceDeps: deps,
        workflowDeps,
      },
    ),
    /finalization in_progress/,
  );
});
