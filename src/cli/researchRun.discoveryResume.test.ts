import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { buildPersistedOperatorConfig } from '../operatorConfig/provenance.js';
import { buildNewResearchPlan, type LoadedOperatorResearchConfig } from '../operatorConfig/resolve.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  runResearchFromExisting,
  type ResearchRunDeps,
} from './researchRun.js';

function configured() {
  const config = {
    version: 1 as const,
    research: { label: 'resume-configured', input: { type: 'seeds' as const, path: 'seeds.csv' } },
    workflow: { target: 'enrichment' as const },
    enrichment: { modules: ['clusters' as const] },
  };
  const loaded = { config, plan: buildNewResearchPlan(config, '/tmp/research.config.json') } as LoadedOperatorResearchConfig;
  return buildPersistedOperatorConfig(loaded);
}

function status(state: 'paused' | 'completed'): ResearchStatusWithHistoricalPresence {
  const complete = state === 'completed';
  return {
    version: '1.2.0',
    researchId: 'research-stable',
    label: 'resume-configured',
    researchDirectory: '/tmp/research-stable',
    legacy: false,
    discovery: {
      generation: 2,
      runId: 'run-current-generated',
      state,
      createdAt: 'x',
      updatedAt: complete ? 'z' : 'y',
      pauseReason: complete ? null : 'external interruption',
      keywordCounts: complete
        ? { total: 2, pending: 0, running: 0, completed: 2, partial: 0, failed: 0, repairable: 0 }
        : { total: 2, pending: 1, running: 0, completed: 1, partial: 0, failed: 0, repairable: 0 },
      qualityWarnings: [],
    },
    enrichments: [],
    currentEnrichmentId: null,
    finalization: {
      state: 'not_started',
      enrichmentId: null,
      finalistCount: 0,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: null,
    },
    library: { published: false, publicationId: null, publishedAt: null, reason: 'no_current_enrichment', lookupError: null },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: { code: complete ? 'run_enrichment' : 'resume_discovery', message: 'fixture', command: null },
  };
}

test('existing config-first research resumes paused discovery by stable research id, replans, then continues downstream', async () => {
  const provenance = configured();
  const statusReads: Array<'paused' | 'completed'> = ['paused', 'paused', 'completed'];
  let discoveryCalls = 0;
  let enrichmentCalls = 0;
  let lockResearchId: string | null = null;

  const deps: ResearchRunDeps = {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    loadProvenance: async () => provenance,
    buildStatus: async () => status(statusReads.shift() ?? 'completed'),
    acquireExecutionLock: async (_outputRoot, researchId) => {
      lockResearchId = researchId;
      return async () => undefined;
    },
    runDiscovery: async (request) => {
      discoveryCalls += 1;
      assert.deepEqual(request.input, { kind: 'resume', runId: 'run-current-generated' });
      return {
        exitCode: 0,
        researchId: 'run-current-generated',
        runId: 'run-current-generated',
        researchDirectory: '/tmp/research-stable',
        discoveryDirectory: '/tmp/research-stable/discovery-02',
        state: 'completed',
      };
    },
    runConfiguredEnrichment: async (request) => {
      enrichmentCalls += 1;
      assert.equal(request.researchId, 'research-stable');
      assert.equal(request.sourceRunId, 'run-current-generated');
      assert.equal(request.currentEnrichmentId, null);
      return {
        outcome: { kind: 'completed', enrichmentId: 'enrich-after-resume', state: 'completed', result: {} },
        enrichmentId: 'enrich-after-resume',
        enrichmentDirectory: join(request.researchDirectory, 'enrichment'),
        resumed: false,
        archivePath: null,
      };
    },
  };

  const execution = await runResearchFromExisting(
    'research-stable',
    null,
    '/tmp/output',
    deps,
    {} as NodeJS.ProcessEnv,
  );

  assert.equal(lockResearchId, 'research-stable');
  assert.equal(discoveryCalls, 1);
  assert.equal(enrichmentCalls, 1);
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.researchId, 'research-stable');
  assert.equal(execution.result.discoveryRunId, 'run-current-generated');
  assert.equal(execution.result.discoveryState, 'completed');
  assert.equal(execution.result.enrichmentId, 'enrich-after-resume');
  assert.equal(execution.result.workflowState, 'completed');
  assert.equal(execution.result.stopPoint, 'complete');
});

test('paused discovery result keeps stable research identity and does not start downstream work', async () => {
  const provenance = configured();
  let enrichmentCalls = 0;
  const deps: ResearchRunDeps = {
    ...DEFAULT_RESEARCH_RUN_DEPS,
    loadProvenance: async () => provenance,
    buildStatus: async () => status('paused'),
    acquireExecutionLock: async () => async () => undefined,
    runDiscovery: async () => ({
      exitCode: 130,
      researchId: 'run-current-generated',
      runId: 'run-current-generated',
      researchDirectory: '/tmp/research-stable',
      discoveryDirectory: '/tmp/research-stable/discovery-02',
      state: 'paused',
    }),
    runConfiguredEnrichment: async () => {
      enrichmentCalls += 1;
      throw new Error('must not run');
    },
  };

  const execution = await runResearchFromExisting(
    'research-stable',
    null,
    '/tmp/output',
    deps,
    {} as NodeJS.ProcessEnv,
  );

  assert.equal(execution.exitCode, 130);
  assert.equal(execution.result.researchId, 'research-stable');
  assert.equal(execution.result.discoveryRunId, 'run-current-generated');
  assert.equal(execution.result.discoveryState, 'paused');
  assert.equal(execution.result.workflowState, 'blocked');
  assert.equal(execution.result.stopPoint, 'discovery');
  assert.equal(enrichmentCalls, 0);
});
