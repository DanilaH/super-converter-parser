import assert from 'node:assert/strict';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import type { CliDeps } from '../discovery/runDiscovery.js';
import type { ConfiguredFinalizationResult } from '../finalization/configuredRun.js';
import type { OperatorResearchConfigV1 } from '../operatorConfig/contracts.js';
import { buildPersistedOperatorConfig, type PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan } from '../operatorConfig/resolve.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  runResearchFromExisting,
  type ResearchRunDeps,
} from './researchRun.js';

function provenance(): PersistedOperatorConfigV1 {
  const config: OperatorResearchConfigV1 = {
    version: 1,
    research: { label: 'finalization-handoff', input: { type: 'seeds', path: 'seeds.csv' } },
    workflow: { target: 'finalization' },
    enrichment: { modules: ['clusters'] },
    finalization: {
      representativeCount: 5,
      historyPolicy: {
        youngDomainMaxAgeDays: 730,
        recentWebPresenceMaxAgeDays: 730,
        repurposeGapMinDays: 365,
      },
    },
  };
  return buildPersistedOperatorConfig({
    config,
    plan: buildNewResearchPlan(config, '/tmp/finalization-handoff/research.config.json'),
  });
}

function status(input: {
  enrichment: 'none' | 'completed';
  finalization: ResearchStatusWithHistoricalPresence['finalization']['state'];
  finalistCount?: number;
  currentDecisionCount?: number;
  matrix?: boolean;
}): ResearchStatusWithHistoricalPresence {
  const finalistCount = input.finalistCount ?? 0;
  const currentDecisionCount = input.currentDecisionCount ?? 0;
  const hasEnrichment = input.enrichment === 'completed';
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'finalization-handoff',
    researchDirectory: '/tmp/output/research-1',
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
      pauseReason: null,
      keywordCounts: {
        total: 3,
        pending: 0,
        running: 0,
        completed: 3,
        partial: 0,
        failed: 0,
        repairable: 0,
      },
      qualityWarnings: [],
    },
    enrichments: hasEnrichment ? [{
      enrichmentId: 'enrichment-1',
      generation: 1,
      directoryName: 'enrichment',
      sourceRunId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-01T00:00:02.000Z',
      updatedAt: '2026-09-01T00:00:03.000Z',
      modules: ['clusters'],
      itemCounts: {},
      error: null,
      isForCurrentDiscovery: true,
      isLatestForCurrentDiscovery: true,
    }] : [],
    currentEnrichmentId: hasEnrichment ? 'enrichment-1' : null,
    finalization: {
      state: input.finalization,
      enrichmentId: hasEnrichment ? 'enrichment-1' : null,
      finalistCount,
      currentDecisionCount,
      allFinalistsHaveCurrentDecisions: finalistCount > 0 && currentDecisionCount === finalistCount,
      finalistMatrixPublished: input.matrix ?? false,
      artifactWarning: null,
    },
    library: {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: null,
      lookupError: null,
    },
    evidenceCoverage: null,
    nextAction: { code: 'run_finalization', message: 'continue workflow', command: null },
    sampledHistoricalPresence: null,
  };
}

const cliDeps: CliDeps = {
  connect: async () => ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser,
  preflight: async () => undefined,
  collect: async () => { throw new Error('browser collection is not expected'); },
};

function baseDeps(overrides: Partial<ResearchRunDeps>): ResearchRunDeps {
  return {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    cliDeps,
    loadProvenance: async () => provenance(),
    acquireExecutionLock: async () => async () => undefined,
    ...overrides,
  };
}

test('completed enrichment is followed by a fresh durable status read before finalization planning', async () => {
  const before = status({ enrichment: 'none', finalization: 'not_started' });
  const after = status({ enrichment: 'completed', finalization: 'not_started' });
  const observedStatuses: ResearchStatusWithHistoricalPresence[] = [];
  let finalizationRuns = 0;

  const execution = await runResearchFromExisting(
    'research-1',
    null,
    '/tmp/output',
    baseDeps({
      buildStatus: async () => {
        const next = observedStatuses.length < 2 ? before : after;
        observedStatuses.push(next);
        return next;
      },
      runConfiguredEnrichment: async () => ({
        outcome: {
          kind: 'completed',
          enrichmentId: 'enrichment-1',
          state: 'completed',
          result: {},
        },
        enrichmentId: 'enrichment-1',
        enrichmentDirectory: '/tmp/output/research-1/enrichment',
        resumed: false,
        archivePath: null,
      }),
      runConfiguredFinalization: async () => {
        finalizationRuns += 1;
        throw new Error('finalization must not run without explicit finalist scope');
      },
    }),
    {} as NodeJS.ProcessEnv,
  );

  assert.equal(observedStatuses.length, 3);
  assert.equal(observedStatuses[2]?.currentEnrichmentId, 'enrichment-1');
  assert.equal(finalizationRuns, 0);
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.enrichmentId, 'enrichment-1');
  assert.equal(execution.result.workflowState, 'awaiting_finalist_scope');
  assert.equal(execution.result.finalizationState, 'not_started');
  assert.deepEqual(execution.result.unresolvedHumanRequirements, ['finalist_scope']);
});

test('configured finalization outcome is projected into machine-readable awaiting-decisions state', async () => {
  const current = status({
    enrichment: 'completed',
    finalization: 'not_started',
  });
  const result: ConfiguredFinalizationResult = {
    outcome: {
      kind: 'awaiting_decisions',
      state: 'awaiting_decisions',
      finalistCount: 2,
      currentDecisionCount: 0,
    },
    fullRun: null,
    traffic: null,
    finalistEvidence: null,
    publication: null,
  };

  const execution = await runResearchFromExisting(
    'research-1',
    '/tmp/finalists-continuation.json',
    '/tmp/output',
    baseDeps({
      buildStatus: async () => current,
      loadContinuation: async () => ({
        continuation: {
          version: 1,
          researchId: 'research-1',
          action: { type: 'finalists', clusters: ['cluster-1', 'cluster-2'] },
        },
        continuationPath: '/tmp/finalists-continuation.json',
        declaredFilePath: null,
      }),
      runConfiguredEnrichment: async () => { throw new Error('enrichment is already complete'); },
      runConfiguredFinalization: async (request) => {
        assert.equal(request.enrichmentId, 'enrichment-1');
        assert.equal(request.continuation?.continuation.action.type, 'finalists');
        return result;
      },
    }),
    {} as NodeJS.ProcessEnv,
  );

  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.workflowState, 'awaiting_decisions');
  assert.equal(execution.result.stopPoint, 'finalization');
  assert.equal(execution.result.finalizationState, 'awaiting_decisions');
  assert.equal(execution.result.publicationId, null);
  assert.deepEqual(execution.result.unresolvedHumanRequirements, ['human_decisions']);
});
