import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import type { ExistingResearchExecutionPlan } from '../operatorConfig/planner.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  runResearchFromExisting,
  type ResearchRunDeps,
} from './researchRun.js';

function status(currentEnrichmentId: string | null): ResearchStatusWithHistoricalPresence {
  return {
    researchId: 'research-1',
    researchDirectory: '/tmp/research-1',
    currentEnrichmentId,
    enrichments: currentEnrichmentId === null
      ? []
      : [{
          enrichmentId: currentEnrichmentId,
          state: 'completed',
          isForCurrentDiscovery: true,
        }],
    discovery: {
      runId: 'discovery-1',
      state: 'completed',
    },
    finalization: {
      state: 'not_started',
    },
    library: {
      publicationId: null,
    },
  } as unknown as ResearchStatusWithHistoricalPresence;
}

const provenance = {
  effectiveConfigFingerprint: 'config-fingerprint',
  stageFingerprints: {
    discovery: 'discovery-fingerprint',
    enrichment: 'enrichment-fingerprint',
    finalization: 'finalization-fingerprint',
  },
  semantics: {
    workflow: { target: 'finalization' },
  },
} as unknown as PersistedOperatorConfigV1;

function plan(enrichmentState: 'ready' | 'already_satisfied'): ExistingResearchExecutionPlan {
  return {
    stages: [
      { id: 'discovery', state: 'already_satisfied' },
      { id: 'enrichment', state: enrichmentState },
      { id: 'finalization', state: enrichmentState === 'ready' ? 'blocked' : 'ready' },
    ],
    expectedStopPoint: enrichmentState === 'ready' ? 'enrichment' : 'finalization',
    unresolvedHumanRequirements: [],
  } as unknown as ExistingResearchExecutionPlan;
}

test('completed enrichment honors a late cancellation before finalization starts', async () => {
  const before = status(null);
  const after = status('enrichment-1');
  let statusReads = 0;
  let finalizationCalls = 0;

  const deps: ResearchRunDeps = {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    buildStatus: async () => {
      statusReads += 1;
      return statusReads < 3 ? before : after;
    },
    loadProvenance: async () => provenance,
    buildExistingPlan: (currentStatus) => plan(currentStatus.currentEnrichmentId === null ? 'ready' : 'already_satisfied'),
    acquireExecutionLock: async () => async () => undefined,
    runDiscovery: async () => {
      throw new Error('discovery should not run');
    },
    runConfiguredEnrichment: async (request) => {
      request.signal.cancelled = true;
      return {
        outcome: {
          kind: 'completed',
          enrichmentId: 'enrichment-1',
          state: 'completed',
          result: {},
        },
        enrichmentId: 'enrichment-1',
        enrichmentDirectory: '/tmp/research-1/enrichment-1',
        resumed: false,
        archivePath: null,
      };
    },
    runConfiguredFinalization: async () => {
      finalizationCalls += 1;
      throw new Error('finalization should not run after cancellation');
    },
  };

  const signal = { cancelled: false };
  const execution = await runResearchFromExisting(
    'research-1',
    null,
    '/tmp/output',
    deps,
    {} as NodeJS.ProcessEnv,
    signal,
  );

  assert.equal(signal.cancelled, true);
  assert.equal(finalizationCalls, 0);
  assert.equal(execution.exitCode, 130);
  assert.equal(execution.result.exitCode, 130);
  assert.equal(execution.result.enrichmentId, 'enrichment-1');
  assert.equal(execution.result.enrichmentState, 'completed');
  assert.equal(execution.result.workflowState, 'awaiting_finalization');
  assert.equal(execution.result.stopPoint, 'finalization');
});
