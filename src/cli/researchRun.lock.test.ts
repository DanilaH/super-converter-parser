import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan } from '../operatorConfig/resolve.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { DEFAULT_RESEARCH_RUN_DEPS, runResearchFromExisting } from './researchRun.js';

function persistedConfig() {
  const config = {
    version: 1 as const,
    research: { label: 'lock-replan', input: { type: 'seeds' as const, path: 'seeds.csv' } },
    workflow: { target: 'enrichment' as const },
    enrichment: { modules: ['clusters' as const] },
  };
  return buildPersistedOperatorConfig({
    config,
    plan: buildNewResearchPlan(config, '/tmp/research.config.json'),
  });
}

function status(enrichmentState: null | 'completed'): ResearchStatusWithHistoricalPresence {
  const enrichment = enrichmentState === null ? [] : [{
    enrichmentId: 'enrich-1',
    generation: 1,
    directoryName: 'enrichment',
    sourceRunId: 'research-1',
    state: enrichmentState,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    modules: ['clusters'],
    itemCounts: {},
    error: null,
    isForCurrentDiscovery: true,
    isLatestForCurrentDiscovery: true,
  }];
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'lock-replan',
    researchDirectory: '/tmp/research-1',
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      pauseReason: null,
      keywordCounts: { total: 1, pending: 0, running: 0, completed: 1, partial: 0, failed: 0, repairable: 0 },
      qualityWarnings: [],
    },
    enrichments: enrichment,
    currentEnrichmentId: enrichmentState === null ? null : 'enrich-1',
    finalization: {
      state: 'not_started',
      enrichmentId: enrichmentState === null ? null : 'enrich-1',
      finalistCount: 0,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: null,
    },
    library: { published: false, publicationId: null, publishedAt: null, reason: 'not_published', lookupError: null },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: enrichmentState === null
      ? { code: 'run_enrichment', message: 'Run enrichment.', command: null }
      : { code: 'run_finalization', message: 'Run finalization.', command: null },
  };
}

test('config-driven continuation replans from post-lock durable state instead of executing a stale pre-lock plan', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-run-replan-lock-'));
  const statuses = [status(null), status('completed')];
  let statusReads = 0;
  let enrichmentCalls = 0;
  let lockAcquired = 0;
  let lockReleased = 0;

  const execution = await runResearchFromExisting(
    'research-1',
    null,
    outputRoot,
    {
      ...DEFAULT_RESEARCH_RUN_DEPS,
      buildStatus: async () => statuses[Math.min(statusReads++, statuses.length - 1)] as ResearchStatusWithHistoricalPresence,
      loadProvenance: async () => persistedConfig(),
      acquireExecutionLock: async () => {
        lockAcquired += 1;
        return async () => { lockReleased += 1; };
      },
      runConfiguredEnrichment: async () => {
        enrichmentCalls += 1;
        throw new Error('stale pre-lock plan must not execute enrichment');
      },
    },
    {} as NodeJS.ProcessEnv,
  );

  assert.equal(statusReads, 2);
  assert.equal(lockAcquired, 1);
  assert.equal(lockReleased, 1);
  assert.equal(enrichmentCalls, 0);
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.enrichmentId, 'enrich-1');
  assert.equal(execution.result.enrichmentState, 'completed');
  assert.equal(execution.result.workflowState, 'completed');
  assert.equal(execution.result.stopPoint, 'complete');
});
