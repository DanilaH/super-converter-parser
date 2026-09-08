import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import type { PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import type { ExistingResearchExecutionPlan } from '../operatorConfig/planner.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { resolveOperatorContinuationInput } from './operatorInputs.js';
import {
  executeResearchDecisionSelection,
  inspectResearchDecisions,
  validateResearchDecisionSelection,
  type ResearchDecisionServiceDeps,
} from './researchDecisions.js';
import type { ResearchRunDeps, ResearchRunExecution } from './researchWorkflow.js';

const fingerprint = 'a'.repeat(64);
const status = {
  researchId: 'research-1',
  researchDirectory: '/output/research-1',
  legacy: false,
  discovery: { runId: 'run-1' },
  currentEnrichmentId: 'enrichment-1',
  finalization: {
    state: 'awaiting_decisions',
    finalistMatrixPublished: true,
    finalistCount: 2,
    currentDecisionCount: 1,
  },
} as unknown as ResearchStatusWithHistoricalPresence;
const provenance = {} as PersistedOperatorConfigV1;
const plan = { unresolvedHumanRequirements: ['human_decisions'] } as unknown as ExistingResearchExecutionPlan;
const evidence = {
  sourceRunId: 'run-1',
  enrichmentId: 'enrichment-1',
  representativeRevision: 3,
  entrantFingerprint: fingerprint,
  decisionStateUpdatedAt: '2026-09-08T18:00:00.000Z',
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
        updatedAt: '2026-09-08T18:00:00.000Z',
      },
    },
    {
      clusterId: 'cluster-2',
      canonicalKeyword: 'speaker test',
      representativeKeywordIds: [2],
      evidence: {},
      auditFlags: ['HUMAN_DECISION_UNRECORDED'],
      currentDecision: null,
    },
  ],
} as unknown as Awaited<ReturnType<ResearchDecisionServiceDeps['loadDecisionEvidence']>>;

const awaitingExecution: ResearchRunExecution = {
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
};

function deps(overrides: Partial<ResearchDecisionServiceDeps> = {}): ResearchDecisionServiceDeps {
  return {
    buildStatus: async () => status,
    loadProvenance: async () => provenance,
    buildPlan: () => plan,
    loadDecisionEvidence: async () => evidence,
    resolveContinuation: resolveOperatorContinuationInput,
    executeExistingResearch: async () => awaitingExecution,
    ...overrides,
  };
}

function selection(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    discoveryRunId: 'run-1',
    enrichmentId: 'enrichment-1',
    representativeRevision: 3,
    entrantFingerprint: fingerprint,
    decisionStateUpdatedAt: '2026-09-08T18:00:00.000Z',
    decisions: [
      { clusterId: 'cluster-1', buildDecision: 'build', seoProductRole: 'acquisition_anchor' },
      { clusterId: 'cluster-2', buildDecision: null, seoProductRole: null },
    ],
    ...overrides,
  };
}

test('decision inspection exposes exact canonical vocabulary and current persisted values only at human_decisions', async () => {
  const gate = await inspectResearchDecisions(' research-1 ', {
    outputRoot: '/tmp/decision-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    serviceDeps: deps(),
  });
  assert.equal(gate.researchId, 'research-1');
  assert.equal(gate.discoveryRunId, 'run-1');
  assert.equal(gate.representativeRevision, 3);
  assert.equal(gate.entrantFingerprint, fingerprint);
  assert.deepEqual(gate.buildDecisionValues, ['build', 'watch', 'reject', 'unknown']);
  assert.deepEqual(gate.seoProductRoleValues, [
    'acquisition_anchor',
    'strong_supporting_tool',
    'completeness_tool',
    'experimental',
    'not_applicable',
  ]);
  assert.equal(gate.currentDecisionCount, 1);
  assert.equal(gate.finalists[0]?.currentDecision?.buildDecision, 'build');
  assert.equal(gate.finalists[1]?.currentDecision, null);
});

test('decision inspection fails closed outside the canonical human_decisions gate', async () => {
  await assert.rejects(
    () => inspectResearchDecisions('research-1', {
      outputRoot: '/tmp/decision-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      serviceDeps: deps({ buildPlan: () => ({ unresolvedHumanRequirements: [] }) as unknown as ExistingResearchExecutionPlan }),
    }),
    /not currently awaiting explicit human decisions/,
  );
});

test('decision validation accepts only the exact persisted vocabulary and rejects invented values', () => {
  const parsed = validateResearchDecisionSelection(selection());
  assert.equal(parsed.decisions[0]?.buildDecision, 'build');
  assert.equal(parsed.decisions[1]?.buildDecision, null);
  assert.throws(
    () => validateResearchDecisionSelection(selection({
      decisions: [
        { clusterId: 'cluster-1', buildDecision: 'keep', seoProductRole: null },
        { clusterId: 'cluster-2', buildDecision: null, seoProductRole: null },
      ],
    })),
    /buildDecision must be build, watch, reject, unknown, or null/,
  );
  assert.throws(
    () => validateResearchDecisionSelection(selection({
      decisions: [
        { clusterId: 'cluster-1', buildDecision: 'build', seoProductRole: 'primary' },
        { clusterId: 'cluster-2', buildDecision: null, seoProductRole: null },
      ],
    })),
    /seoProductRole must be acquisition_anchor/,
  );
});

test('decision submission requires a full current finalist snapshot but permits undecided null rows', async () => {
  let written: unknown = null;
  const service = deps({
    executeExistingResearch: async (_researchId, continuation) => {
      const path = continuation?.declaredFilePath?.resolvedPath;
      assert.ok(path);
      written = JSON.parse(await readFile(path, 'utf8')) as unknown;
      return awaitingExecution;
    },
  });
  const result = await executeResearchDecisionSelection('research-1', selection(), {
    outputRoot: '/tmp/decision-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    serviceDeps: service,
  });
  assert.equal(result.result.workflowState, 'awaiting_decisions');
  assert.deepEqual(written, selection().decisions);

  await assert.rejects(
    () => executeResearchDecisionSelection('research-1', selection({
      decisions: [{ clusterId: 'cluster-2', buildDecision: 'watch', seoProductRole: null }],
    }), {
      outputRoot: '/tmp/decision-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      serviceDeps: deps(),
    }),
    /exactly one row for every current finalist/,
  );
});

test('decision temp file remains alive through workflow completion and is removed afterwards', async () => {
  let decisionPath = '';
  let release!: () => void;
  const blocked = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const service = deps({
    executeExistingResearch: async (_researchId, continuation) => {
      decisionPath = continuation?.declaredFilePath?.resolvedPath ?? '';
      assert.notEqual(decisionPath, '');
      await assert.doesNotReject(() => access(decisionPath));
      await blocked;
      await assert.doesNotReject(() => access(decisionPath));
      return awaitingExecution;
    },
  });
  const promise = executeResearchDecisionSelection('research-1', selection(), {
    outputRoot: '/tmp/decision-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    serviceDeps: service,
  });
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  await assert.doesNotReject(() => access(decisionPath));
  release();
  await promise;
  await assert.rejects(() => access(decisionPath));
});

test('decision execution rejects representative revision drift under the workflow lock', async () => {
  const driftedEvidence = {
    ...evidence,
    representativeRevision: 4,
  } as Awaited<ReturnType<ResearchDecisionServiceDeps['loadDecisionEvidence']>>;
  let evidenceReads = 0;
  const service = deps({
    loadDecisionEvidence: async () => (++evidenceReads === 1 ? evidence : driftedEvidence),
    executeExistingResearch: async (_researchId, _continuation, options) => {
      assert.ok(options?.deps);
      await options.deps.buildStatus({ outputRoot: '/tmp/decision-output', targetRunId: 'research-1' });
      return awaitingExecution;
    },
  });
  const workflowDeps = { buildStatus: async () => status } as unknown as ResearchRunDeps;
  await assert.rejects(
    () => executeResearchDecisionSelection('research-1', selection(), {
      outputRoot: '/tmp/decision-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      serviceDeps: service,
      workflowDeps,
    }),
    /stale relative to current finalist evidence/,
  );
});

test('all-current decisions may flow through the existing workflow into Library publication', async () => {
  const published = {
    ...awaitingExecution,
    result: {
      ...awaitingExecution.result,
      workflowState: 'completed' as const,
      stopPoint: 'complete' as const,
      finalizationState: 'published' as const,
      publicationId: 'publication-1',
      unresolvedHumanRequirements: [],
    },
  };
  const service = deps({ executeExistingResearch: async () => published });
  const result = await executeResearchDecisionSelection('research-1', selection({
    decisions: [
      { clusterId: 'cluster-1', buildDecision: 'build', seoProductRole: 'acquisition_anchor' },
      { clusterId: 'cluster-2', buildDecision: 'reject', seoProductRole: 'not_applicable' },
    ],
  }), {
    outputRoot: '/tmp/decision-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    serviceDeps: service,
  });
  assert.equal(result.result.workflowState, 'completed');
  assert.equal(result.result.finalizationState, 'published');
  assert.equal(result.result.publicationId, 'publication-1');
});
