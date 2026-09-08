import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import type { ExistingResearchExecutionPlan } from '../operatorConfig/planner.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import type { ResearchRunDeps, ResearchRunExecution } from './researchWorkflow.js';
import {
  inspectResearchShortlist,
  executeResearchShortlistSelection,
  validateResearchShortlistSelection,
  type ResearchShortlistCandidateV1,
  type ResearchShortlistServiceDeps,
} from './researchShortlist.js';
import { resolveOperatorContinuationInput } from './operatorInputs.js';

const status = {
  researchId: 'research-1',
  researchDirectory: '/output/research-1',
  legacy: false,
  discovery: { runId: 'run-1' },
} as unknown as ResearchStatusWithHistoricalPresence;

const provenance = {} as PersistedOperatorConfigV1;
const plan = {
  unresolvedHumanRequirements: ['shortlist'],
} as unknown as ExistingResearchExecutionPlan;

const candidates: ResearchShortlistCandidateV1[] = Array.from({ length: 6 }, (_, index) => ({
  keyword: `Keyword ${index + 1}`,
  normalizedKeyword: `keyword ${index + 1}`,
  status: 'completed',
  surferVolume: 1000 - index,
  surferCpc: null,
  score: 70 - index,
  tier: 'B',
  organicResultCount: 10,
  medianDr: 20,
  weakDomainsCount: 3,
  scoringCompleteness: 'complete',
  serpStatus: 'observed',
}));

function serviceDeps(overrides: Partial<ResearchShortlistServiceDeps> = {}): ResearchShortlistServiceDeps {
  return {
    buildStatus: async () => status,
    loadProvenance: async () => provenance,
    buildPlan: () => plan,
    loadCandidates: async () => candidates,
    resolveContinuation: resolveOperatorContinuationInput,
    executeExistingResearch: async () => execution,
    ...overrides,
  };
}

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
    finalizationState: null,
    publicationId: null,
    workflowTarget: 'enrichment',
    workflowState: 'completed',
    stopPoint: 'complete',
    unresolvedHumanRequirements: [],
    effectiveConfigFingerprint: 'config',
    stageFingerprints: {
      discoverySemanticFingerprint: 'discovery',
      enrichmentSemanticFingerprint: 'enrichment',
      finalizationPolicyFingerprint: 'finalization',
    },
    operatorConfigPath: '/output/research-1/operator-config.json',
  },
};

test('shortlist inspection is read-only and exposes current discovery evidence only at the canonical human gate', async () => {
  const gate = await inspectResearchShortlist(' research-1 ', {
    outputRoot: '/tmp/shortlist-output',
    env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
    serviceDeps: serviceDeps(),
  });
  assert.equal(gate.researchId, 'research-1');
  assert.equal(gate.discoveryRunId, 'run-1');
  assert.equal(gate.minSelection, 5);
  assert.equal(gate.maxSelection, 200);
  assert.equal(gate.candidateCount, 6);
  assert.deepEqual(gate.candidates, candidates);
});

test('shortlist inspection fails closed when the canonical plan is not awaiting shortlist input', async () => {
  await assert.rejects(
    () => inspectResearchShortlist('research-1', {
      outputRoot: '/tmp/shortlist-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      serviceDeps: serviceDeps({
        buildPlan: () => ({ unresolvedHumanRequirements: [] }) as unknown as ExistingResearchExecutionPlan,
      }),
    }),
    /not currently awaiting an explicit shortlist/,
  );
});

test('shortlist execution materializes the existing keyword CSV continuation and removes the temporary workspace', async () => {
  let shortlistPath: string | null = null;
  const deps = serviceDeps({
    executeExistingResearch: async (researchId, continuation, options) => {
      assert.equal(researchId, 'research-1');
      assert.equal(continuation?.continuation.action.type, 'shortlist');
      shortlistPath = continuation?.declaredFilePath?.resolvedPath ?? null;
      assert.ok(shortlistPath);
      assert.equal(
        await readFile(shortlistPath, 'utf8'),
        'keyword\n"keyword 1"\n"keyword 2"\n"keyword 3"\n"keyword 4"\n"keyword 5"\n',
      );
      assert.ok(options);
      assert.equal(options.manageProcessSignals, false);
      return execution;
    },
  });

  const result = await executeResearchShortlistSelection(
    'research-1',
    {
      version: 1,
      discoveryRunId: 'run-1',
      normalizedKeywords: ['keyword 1', 'keyword 2', 'keyword 3', 'keyword 4', 'keyword 5'],
    },
    {
      outputRoot: '/tmp/shortlist-output',
      env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
      serviceDeps: deps,
    },
  );
  assert.equal(result.result.enrichmentId, 'enrichment-1');
  assert.ok(shortlistPath);
  await assert.rejects(() => readFile(shortlistPath as string, 'utf8'), /ENOENT/);
});

test('shortlist execution rejects a stale discovery generation through the workflow status guard', async () => {
  const staleStatus = {
    ...status,
    discovery: { ...status.discovery, runId: 'run-2' },
  } as ResearchStatusWithHistoricalPresence;
  const workflowDeps = {
    buildStatus: async () => staleStatus,
  } as unknown as ResearchRunDeps;
  const deps = serviceDeps({
    executeExistingResearch: async (_researchId, _continuation, options) => {
      assert.ok(options?.deps);
      await options.deps.buildStatus({ outputRoot: '/tmp/shortlist-output', targetRunId: 'research-1' });
      return execution;
    },
  });

  await assert.rejects(
    () => executeResearchShortlistSelection(
      'research-1',
      {
        version: 1,
        discoveryRunId: 'run-1',
        normalizedKeywords: ['keyword 1', 'keyword 2', 'keyword 3', 'keyword 4', 'keyword 5'],
      },
      {
        outputRoot: '/tmp/shortlist-output',
        env: { RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true' },
        serviceDeps: deps,
        workflowDeps,
      },
    ),
    /Shortlist selection is stale/,
  );
});

test('shortlist selection normalizes/deduplicates exactly like the existing enrichment contract and enforces 5-200 unique keywords', () => {
  const parsed = validateResearchShortlistSelection({
    version: 1,
    discoveryRunId: 'run-1',
    normalizedKeywords: [' Alpha ', 'alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'],
  });
  assert.deepEqual(parsed.normalizedKeywords, ['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
  assert.throws(
    () => validateResearchShortlistSelection({
      version: 1,
      discoveryRunId: 'run-1',
      normalizedKeywords: ['one', 'two', 'three', 'four'],
    }),
    /5-200 unique keywords/,
  );
});
