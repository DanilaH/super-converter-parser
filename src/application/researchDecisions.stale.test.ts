import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import type { ExistingResearchExecutionPlan } from '../operatorConfig/planner.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { resolveOperatorContinuationInput } from './operatorInputs.js';
import {
  executeResearchDecisionSelection,
  type ResearchDecisionServiceDeps,
} from './researchDecisions.js';
import type { ResearchRunDeps, ResearchRunExecution } from './researchWorkflow.js';

const fingerprint = 'a'.repeat(64);
const otherFingerprint = 'b'.repeat(64);
const updatedAt = '2026-09-08T18:00:00.000Z';
const status = {
  researchId: 'research-1',
  researchDirectory: '/output/research-1',
  legacy: false,
  discovery: { runId: 'run-1' },
  currentEnrichmentId: 'enrichment-1',
  finalization: { state: 'awaiting_decisions', finalistMatrixPublished: true },
} as unknown as ResearchStatusWithHistoricalPresence;
const provenance = {} as PersistedOperatorConfigV1;
const plan = { unresolvedHumanRequirements: ['human_decisions'] } as unknown as ExistingResearchExecutionPlan;
const execution = {
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
    operatorConfigPath: null,
  },
} as ResearchRunExecution;
const evidence = {
  sourceRunId: 'run-1',
  enrichmentId: 'enrichment-1',
  representativeRevision: 3,
  entrantFingerprint: fingerprint,
  decisionStateUpdatedAt: updatedAt,
  finalistCount: 2,
  currentDecisionCount: 1,
  buildDecisionValues: ['build', 'watch', 'reject', 'unknown'],
  seoProductRoleValues: ['acquisition_anchor', 'strong_supporting_tool', 'completeness_tool', 'experimental', 'not_applicable'],
  finalists: [
    {
      clusterId: 'cluster-1',
      canonicalKeyword: 'mic test',
      representativeKeywordIds: [1],
      evidence: {},
      auditFlags: [],
      currentDecision: {
        clusterId: 'cluster-1',
        buildDecision: 'build',
        seoProductRole: 'acquisition_anchor',
        updatedAt,
      },
    },
    {
      clusterId: 'cluster-2',
      canonicalKeyword: 'speaker test',
      representativeKeywordIds: [2],
      evidence: {},
      auditFlags: [],
      currentDecision: null,
    },
  ],
} as unknown as Awaited<ReturnType<ResearchDecisionServiceDeps['loadDecisionEvidence']>>;

function selection() {
  return {
    version: 1,
    discoveryRunId: 'run-1',
    enrichmentId: 'enrichment-1',
    representativeRevision: 3,
    entrantFingerprint: fingerprint,
    decisionStateUpdatedAt: updatedAt,
    decisions: [
      { clusterId: 'cluster-1', buildDecision: 'build', seoProductRole: 'acquisition_anchor' },
      { clusterId: 'cluster-2', buildDecision: 'watch', seoProductRole: null },
    ],
  };
}

function deps(
  refreshedEvidence: Awaited<ReturnType<ResearchDecisionServiceDeps['loadDecisionEvidence']>>,
  refreshedStatus: ResearchStatusWithHistoricalPresence = status,
): ResearchDecisionServiceDeps {
  let evidenceReads = 0;
  return {
    buildStatus: async () => status,
    loadProvenance: async () => provenance,
    buildPlan: () => plan,
    loadDecisionEvidence: async () => (++evidenceReads === 1 ? evidence : refreshedEvidence),
    resolveContinuation: resolveOperatorContinuationInput,
    executeExistingResearch: async (_researchId, _continuation, options) => {
      assert.ok(options?.deps);
      await options.deps.buildStatus({ outputRoot: '/tmp/decision-output', targetRunId: 'research-1' });
      return execution;
    },
  };
}

const workflowDeps = (refreshedStatus: ResearchStatusWithHistoricalPresence): ResearchRunDeps => ({
  buildStatus: async () => refreshedStatus,
} as unknown as ResearchRunDeps);

async function expectStale(
  refreshedEvidence: Awaited<ReturnType<ResearchDecisionServiceDeps['loadDecisionEvidence']>>,
  refreshedStatus: ResearchStatusWithHistoricalPresence = status,
): Promise<void> {
  await assert.rejects(
    () => executeResearchDecisionSelection('research-1', selection(), {
      outputRoot: '/tmp/decision-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      serviceDeps: deps(refreshedEvidence, refreshedStatus),
      workflowDeps: workflowDeps(refreshedStatus),
    }),
    /stale/i,
  );
}

test('human decisions reject entrant fingerprint drift under the execution lock', async () => {
  await expectStale({ ...evidence, entrantFingerprint: otherFingerprint });
});

test('human decisions reject persisted decision-state drift under the execution lock', async () => {
  await expectStale({ ...evidence, decisionStateUpdatedAt: '2026-09-08T18:01:00.000Z' });
});

test('human decisions reject finalist membership drift under the execution lock', async () => {
  await expectStale({
    ...evidence,
    finalistCount: 1,
    finalists: [evidence.finalists[0]!],
  });
});

test('human decisions reject discovery or enrichment advancement under the execution lock', async () => {
  const advanced = {
    ...status,
    discovery: { ...status.discovery, runId: 'run-2' },
    currentEnrichmentId: 'enrichment-2',
  } as ResearchStatusWithHistoricalPresence;
  await expectStale(evidence, advanced);
});

test('human decisions reject a matrix that stops being current while waiting for the execution lock', async () => {
  const staleMatrix = {
    ...status,
    finalization: { ...status.finalization, finalistMatrixPublished: false },
  } as ResearchStatusWithHistoricalPresence;
  await expectStale(evidence, staleMatrix);
});
